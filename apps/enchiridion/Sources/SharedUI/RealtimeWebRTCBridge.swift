import EnchiridionCore
import Foundation
import OSLog
@preconcurrency import WebKit

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@MainActor
protocol RealtimeWebRTCBridgeDelegate: AnyObject {
  func realtimeBridgeDidBecomeReady(_ bridge: RealtimeWebRTCBridge)
  func realtimeBridge(_ bridge: RealtimeWebRTCBridge, didReceive message: RealtimeWebRTCBridge.Message)
}

@MainActor
final class RealtimeWebRTCBridge: NSObject {
  static let ownedOrigin = RealtimeWebRTCBridgeSecurityPolicy.ownedOrigin
  private static let maximumInputEpoch: UInt64 = 9_007_199_254_740_991

  enum Message: Equatable, Sendable {
    case offer(generation: UInt64, sdp: String)
    case connectionState(generation: UInt64, state: String)
    case dataChannelState(generation: UInt64, state: String)
    case serverEvent(generation: UInt64, json: String)
    case audioActivity(generation: UInt64, inputLevel: Double, outputLevel: Double)
    case inputCaptureState(generation: UInt64, state: RealtimeWebRTCInputCaptureState)
    case answerApplied(generation: UInt64)
    #if DEBUG
      case probeResult(
        generation: UInt64,
        peerConnection: Bool,
        userMedia: Bool,
        error: String?
      )
    #endif
    case error(generation: UInt64, code: String)
  }

  enum BridgeError: Error, Equatable {
    case resourceUnavailable
    case resourceTooLarge
    case invalidCommand
    case unavailable
    case operationTimedOut
    #if DEBUG
      case probeTimedOut
    #endif
  }

  private enum Limit {
    static let resource = 64 * 1024
    static let sdp = 128 * 1024
    static let event = 64 * 1024
    static let error = 512
    static let audioLevel = 1.0
  }

  private static let javaScriptControlDeadline: Duration = .seconds(8)

  /// A timeout must not wait for a wedged WebKit promise to cooperate with
  /// cancellation. The losing task is cancelled and the caller can immediately
  /// tear down the owning bridge.
  @MainActor
  private final class DeadlineRace<Value: Sendable> {
    private var continuation: CheckedContinuation<Value, Error>?
    private var operationTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var isResolved = false

    func begin(
      continuation: CheckedContinuation<Value, Error>,
      duration: Duration,
      timeoutError: BridgeError,
      operation: @escaping @MainActor () async throws -> Value
    ) {
      self.continuation = continuation
      operationTask = Task { @MainActor [weak self] in
        do {
          let value = try await operation()
          self?.resolve(.success(value))
        } catch {
          self?.resolve(.failure(error))
        }
      }
      timeoutTask = Task { @MainActor [weak self] in
        do {
          try await Task.sleep(for: duration)
        } catch {
          return
        }
        self?.resolve(.failure(timeoutError))
      }
    }

    func cancel() {
      resolve(.failure(CancellationError()))
    }

    private func resolve(_ result: Result<Value, Error>) {
      guard !isResolved else { return }
      isResolved = true
      operationTask?.cancel()
      timeoutTask?.cancel()
      operationTask = nil
      timeoutTask = nil
      let continuation = continuation
      self.continuation = nil
      continuation?.resume(with: result)
    }
  }

  weak var delegate: RealtimeWebRTCBridgeDelegate?

  private let contentController: WKUserContentController
  private var webView: WKWebView?
  private var authorizationState = RealtimeWebRTCBridgeAuthorizationState()
  private var lifecycle = RealtimeWebRTCBridgeLifecycleState()
  #if DEBUG
    private static let debugProbeDeliveryTimeout: Duration = .seconds(5)
    private var debugProbeGeneration: UInt64?
    private var debugProbeDeliveredGeneration: UInt64?
    private var debugProbeCompletion: CheckedContinuation<Void, Error>?
    private var debugProbeTimeoutTask: Task<Void, Never>?
  #endif
  private var isReady = false
  private var stopped = false
  /// Native-issued monotonic lease. It is set before any JavaScript await so a
  /// late control completion can never regain microphone authority.
  private var newestInputLease: RealtimeVoiceInputLease?
  private var eventContinuations: [UUID: AsyncStream<RealtimeWebRTCBridgeEvent>.Continuation] = [:]

  override init() {
    let contentController = WKUserContentController()
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController = contentController
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.mediaTypesRequiringUserActionForPlayback = []
    #if os(iOS)
    configuration.allowsInlineMediaPlayback = true
    #endif

    self.contentController = contentController
    let webView = WKWebView(frame: .zero, configuration: configuration)
    self.webView = webView
    super.init()

    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.isInspectable = false
    #if os(iOS)
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.scrollView.isScrollEnabled = false
    #endif
    contentController.add(WeakScriptMessageHandler(target: self), name: "realtime")
  }

  func load() throws {
    guard !stopped, lifecycle.currentEpoch != nil, let webView else {
      throw BridgeError.unavailable
    }
    guard
      let resourceURL = Bundle.main.url(
        forResource: "index",
        withExtension: "html",
        subdirectory: "RealtimeBridge"
      ),
      let data = try? Data(contentsOf: resourceURL),
      data.count <= Limit.resource,
      let html = String(data: data, encoding: .utf8)
    else {
      throw BridgeError.resourceUnavailable
    }
    attachNonvisibleWebViewIfNeeded()
    webView.loadHTMLString(html, baseURL: Self.ownedOrigin)
  }

  func authorize(
    _ capability: RealtimeWebRTCBridgeAuthorization,
    generation: UInt64
  ) async throws {
    guard
      !stopped,
      capability.authorizes(generation: generation),
      let operationEpoch = lifecycle.beginAuthorization(),
      let webView
    else { throw BridgeError.unavailable }
    let oldGeneration = authorizationState.activeGeneration
    authorizationState.revoke()
    newestInputLease = nil
    #if DEBUG
      resolveDebugProbeDelivery(throwing: BridgeError.unavailable)
      debugProbeGeneration = nil
    #endif
    do {
      if let oldGeneration {
        try await call(
          function: "stop",
          argument: ["generation": oldGeneration],
          epoch: operationEpoch,
          webView: webView
        )
        guard lifecycle.isCurrent(operationEpoch), self.webView === webView else {
          throw BridgeError.unavailable
        }
      }
      try await call(
        function: "authorize",
        argument: ["generation": generation],
        epoch: operationEpoch,
        webView: webView
      )
      guard lifecycle.isCurrent(operationEpoch), self.webView === webView else {
        throw BridgeError.unavailable
      }
      try authorizationState.activate(capability, generation: generation)
    } catch {
      if lifecycle.isCurrent(operationEpoch) {
        await stop()
        guard lifecycle.isStopped else { throw BridgeError.unavailable }
      }
      throw BridgeError.unavailable
    }
  }

  #if DEBUG
  func runProbe(generation: UInt64) async throws {
    guard
      !stopped,
      isReady,
      generation > 0,
      let operationEpoch = lifecycle.beginAuthorization(),
      let webView
    else { throw BridgeError.unavailable }
    authorizationState.revoke()
    resolveDebugProbeDelivery(throwing: BridgeError.unavailable)
    debugProbeGeneration = generation
    debugProbeDeliveredGeneration = nil
    let script = """
      const generation = nativeGeneration;
      let peer = null;
      let stream = null;
      try {
        peer = new RTCPeerConnection({ iceServers: [] });
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        window.webkit.messageHandlers.realtime.postMessage({
          version: 1,
          generation,
          type: "probeResult",
          payload: {
            peerConnection: peer instanceof RTCPeerConnection,
            userMedia: audioTracks.length === 1 && audioTracks[0].kind === "audio" && videoTracks.length === 0
          }
        });
      } catch (error) {
        window.webkit.messageHandlers.realtime.postMessage({
          version: 1,
          generation,
          type: "probeResult",
          payload: {
            peerConnection: Boolean(peer),
            userMedia: false,
            error: String(error && error.name || "mediaFailure").slice(0, 512)
          }
        });
      } finally {
        if (stream) for (const track of stream.getTracks()) track.stop();
        if (peer) peer.close();
      }
      return true;
      """
    do {
      try await executeJavaScriptControl(
        script,
        arguments: ["nativeGeneration": generation],
        webView: webView
      )
      guard lifecycle.isCurrent(operationEpoch), self.webView === webView else {
        throw BridgeError.unavailable
      }
      try await awaitProbeDelivery(
        generation: generation,
        epoch: operationEpoch,
        webView: webView
      )
      guard lifecycle.isCurrent(operationEpoch), self.webView === webView else {
        throw BridgeError.unavailable
      }
    } catch {
      if lifecycle.isCurrent(operationEpoch) {
        debugProbeGeneration = nil
        debugProbeDeliveredGeneration = nil
        await stop()
      }
      throw error
    }
  }

  private func awaitProbeDelivery(
    generation: UInt64,
    epoch: UInt64,
    webView: WKWebView
  ) async throws {
    try Task.checkCancellation()
    guard lifecycle.isCurrent(epoch), self.webView === webView else {
      throw BridgeError.unavailable
    }
    if debugProbeDeliveredGeneration == generation { return }
    try await withTaskCancellationHandler(
      operation: {
        try await withCheckedThrowingContinuation {
          (continuation: CheckedContinuation<Void, Error>) in
        guard lifecycle.isCurrent(epoch), self.webView === webView else {
          continuation.resume(throwing: BridgeError.unavailable)
          return
        }
        if debugProbeDeliveredGeneration == generation {
          continuation.resume()
          return
        }
        debugProbeCompletion = continuation
        debugProbeTimeoutTask?.cancel()
        debugProbeTimeoutTask = Task { @MainActor [weak self] in
          do {
            try await Task.sleep(for: Self.debugProbeDeliveryTimeout)
          } catch {
            return
          }
          guard
            let self,
            self.debugProbeGeneration == generation,
            self.lifecycle.isCurrent(epoch)
          else { return }
          self.resolveDebugProbeDelivery(throwing: BridgeError.probeTimedOut)
          self.debugProbeGeneration = nil
          self.debugProbeDeliveredGeneration = nil
        }
        }
      },
      onCancel: {
        Task { @MainActor [weak self] in
          guard self?.debugProbeGeneration == generation else { return }
          self?.resolveDebugProbeDelivery(throwing: CancellationError())
          self?.debugProbeGeneration = nil
          self?.debugProbeDeliveredGeneration = nil
        }
      }
    )
  }

  private func resolveDebugProbeDelivery(throwing error: Error? = nil) {
    debugProbeTimeoutTask?.cancel()
    debugProbeTimeoutTask = nil
    let completion = debugProbeCompletion
    debugProbeCompletion = nil
    if let error {
      completion?.resume(throwing: error)
    } else {
      completion?.resume()
    }
  }
  #endif

  func start(generation: UInt64) async throws {
    guard
      !stopped,
      isReady,
      authorizationState.authorizes(generation: generation),
      let operationEpoch = lifecycle.currentEpoch,
      let webView
    else {
      throw BridgeError.unavailable
    }
    try await call(
      function: "start",
      argument: ["generation": generation],
      epoch: operationEpoch,
      webView: webView
    )
    guard lifecycle.isCurrent(operationEpoch), self.webView === webView else {
      throw BridgeError.unavailable
    }
  }

  func applyAnswer(_ sdp: String, generation: UInt64) async throws {
    guard
      !stopped,
      authorizationState.authorizes(generation: generation),
      sdp.utf8.count <= Limit.sdp,
      let operationEpoch = lifecycle.currentEpoch,
      let webView
    else {
      throw BridgeError.invalidCommand
    }
    try await call(
      function: "setAnswer",
      argument: ["generation": generation, "sdp": sdp],
      epoch: operationEpoch,
      webView: webView
    )
    guard lifecycle.isCurrent(operationEpoch), self.webView === webView else {
      throw BridgeError.unavailable
    }
  }

  func sendEvent(_ json: String, generation: UInt64) async throws {
    guard
      !stopped,
      authorizationState.authorizes(generation: generation),
      json.utf8.count <= Limit.event,
      let operationEpoch = lifecycle.currentEpoch,
      let webView
    else {
      throw BridgeError.invalidCommand
    }
    try await call(
      function: "sendEvent",
      argument: ["generation": generation, "json": json],
      epoch: operationEpoch,
      webView: webView
    )
    guard lifecycle.isCurrent(operationEpoch), self.webView === webView else {
      throw BridgeError.unavailable
    }
  }

  func setInputEnabled(_ enabled: Bool, lease: RealtimeVoiceInputLease) async throws {
    let isTerminalLease = !enabled && lease.inputEpoch == Self.maximumInputEpoch
    guard
      !stopped,
      lease.transportGeneration > 0,
      lease.inputEpoch > 0,
      (lease.inputEpoch < Self.maximumInputEpoch || isTerminalLease),
      authorizationState.authorizes(generation: lease.transportGeneration),
      newestInputLease.map({ lease.inputEpoch > $0.inputEpoch }) ?? true,
      let operationEpoch = lifecycle.currentEpoch,
      let webView
    else {
      throw BridgeError.invalidCommand
    }
    newestInputLease = lease
    try await call(
      function: "setInputEnabled",
      argument: [
        "generation": lease.transportGeneration,
        "inputEpoch": lease.inputEpoch,
        "enabled": enabled,
      ],
      epoch: operationEpoch,
      webView: webView
    )
    guard lifecycle.isCurrent(operationEpoch), self.webView === webView, newestInputLease == lease else {
      throw BridgeError.unavailable
    }
  }

  func stop() async {
    guard !stopped, lifecycle.stop() != nil else { return }
    stopped = true
    let activeGeneration = authorizationState.activeGeneration
    if let activeGeneration {
      newestInputLease = RealtimeVoiceInputLease(
        transportGeneration: activeGeneration,
        inputEpoch: Self.maximumInputEpoch
      )
    }
    authorizationState.revoke()
    #if DEBUG
      resolveDebugProbeDelivery(throwing: BridgeError.unavailable)
      debugProbeGeneration = nil
      debugProbeDeliveredGeneration = nil
    #endif
    isReady = false
    delegate = nil
    finishEvents()
    contentController.removeScriptMessageHandler(forName: "realtime")

    guard let capturedWebView = webView else { return }
    let dataStore = capturedWebView.configuration.websiteDataStore
    destroyWebView(capturedWebView, activeGeneration: activeGeneration)
    webView = nil
    Task { @MainActor in
      await Self.clearNonpersistentData(in: dataStore)
    }
  }

  func events() -> AsyncStream<RealtimeWebRTCBridgeEvent> {
    let identifier = UUID()
    return AsyncStream { continuation in
      eventContinuations[identifier] = continuation
      continuation.onTermination = { [weak self] _ in
        Task { @MainActor in
          self?.eventContinuations.removeValue(forKey: identifier)
        }
      }
    }
  }

  private func yield(_ event: RealtimeWebRTCBridgeEvent) {
    for continuation in eventContinuations.values {
      continuation.yield(event)
    }
  }

  private func finishEvents() {
    let continuations = eventContinuations.values
    eventContinuations.removeAll()
    for continuation in continuations {
      continuation.finish()
    }
  }

  private func destroyWebView(_ webView: WKWebView, activeGeneration: UInt64?) {
    if let activeGeneration {
      webView.evaluateJavaScript(
        "window.EnchiridionRealtimeBridge?.stop({generation: \(activeGeneration)});"
      ) { _, _ in }
    }
    webView.stopLoading()
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
    webView.removeFromSuperview()
    webView.loadHTMLString("<!doctype html><html><body></body></html>", baseURL: nil)
  }

  private func call(
    function: String,
    argument: [String: Any],
    epoch: UInt64,
    webView: WKWebView
  ) async throws {
    guard !stopped, lifecycle.isCurrent(epoch), self.webView === webView else {
      throw BridgeError.unavailable
    }
    let data = try JSONSerialization.data(withJSONObject: argument)
    guard data.count <= Limit.sdp else {
      throw BridgeError.invalidCommand
    }
    let allowed = ["authorize", "start", "setAnswer", "sendEvent", "setInputEnabled", "stop"]
    guard allowed.contains(function) else { throw BridgeError.invalidCommand }
    do {
      try await executeJavaScriptControl(
        """
        await window.EnchiridionRealtimeBridge[operation](argument);
        return true;
        """,
        arguments: ["operation": function, "argument": argument],
        webView: webView
      )
    } catch {
      if lifecycle.isCurrent(epoch) {
        await stop()
      }
      throw BridgeError.unavailable
    }
    guard !stopped, lifecycle.isCurrent(epoch), self.webView === webView else {
      throw BridgeError.unavailable
    }
  }

  private func executeJavaScriptControl(
    _ script: String,
    arguments: [String: Any],
    webView: WKWebView
  ) async throws {
    try await withDeadline(
      Self.javaScriptControlDeadline,
      timeoutError: .operationTimedOut
    ) {
      _ = try await webView.callAsyncJavaScript(
        script,
        arguments: arguments,
        in: nil,
        contentWorld: .page
      )
    }
  }

  private func withDeadline<Value: Sendable>(
    _ duration: Duration,
    timeoutError: BridgeError,
    operation: @escaping @MainActor () async throws -> Value
  ) async throws -> Value {
    let race = DeadlineRace<Value>()
    return try await withTaskCancellationHandler(
      operation: {
        try await withCheckedThrowingContinuation { continuation in
          race.begin(
            continuation: continuation,
            duration: duration,
            timeoutError: timeoutError,
            operation: operation
          )
        }
      },
      onCancel: {
        Task { @MainActor in race.cancel() }
      }
    )
  }

  private func attachNonvisibleWebViewIfNeeded() {
    guard !stopped, let webView, webView.superview == nil else { return }
    #if os(iOS)
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return }
    webView.frame = CGRect(x: -2, y: -2, width: 1, height: 1)
    webView.alpha = 0.01
    webView.isUserInteractionEnabled = false
    window.addSubview(webView)
    #elseif os(macOS)
    guard let contentView = NSApplication.shared.keyWindow?.contentView else { return }
    webView.frame = NSRect(x: -2, y: -2, width: 1, height: 1)
    webView.alphaValue = 0.01
    contentView.addSubview(webView)
    #endif
  }

  private static func clearNonpersistentData(in store: WKWebsiteDataStore) async {
    let types = WKWebsiteDataStore.allWebsiteDataTypes()
    await withCheckedContinuation { continuation in
      store.fetchDataRecords(ofTypes: types) { records in
        store.removeData(ofTypes: types, for: records) {
          continuation.resume()
        }
      }
    }
  }

  private func originIsOwned(_ origin: WKSecurityOrigin) -> Bool {
    RealtimeWebRTCBridgeSecurityPolicy.isOwnedOrigin(
      scheme: origin.protocol,
      host: origin.host,
      port: origin.port
    )
  }

  fileprivate func receive(_ message: WKScriptMessage) {
    guard
      !stopped,
      let body = message.body as? [String: Any],
      let type = body["type"] as? String,
      let version = RealtimeWebRTCBridgeMessageGenerationParser.parse(
        body["version"],
        allowsZero: false
      ),
      version == 1,
      let generation = RealtimeWebRTCBridgeMessageGenerationParser.parse(
        body["generation"],
        allowsZero: type == "ready"
      ),
      let payload = body["payload"] as? [String: Any],
      let payloadData = try? JSONSerialization.data(withJSONObject: payload),
      RealtimeWebRTCBridgeSecurityPolicy.acceptsMessageEnvelope(
        fieldCount: body.count,
        version: Int(version),
        generation: generation,
        type: type,
        isMainFrame: message.frameInfo.isMainFrame,
        isOwnedOrigin: originIsOwned(message.frameInfo.securityOrigin),
        payloadIsDictionary: true,
        payloadByteCount: payloadData.count
      ),
      RealtimeWebRTCBridgeSecurityPolicy.acceptsPayload(
        type: type,
        keys: Set(payload.keys)
      )
    else { return }

    if type == "ready", generation == 0, payload.isEmpty {
      isReady = true
      delegate?.realtimeBridgeDidBecomeReady(self)
      yield(.ready)
      return
    }
    #if DEBUG
      if type == "probeResult", debugProbeGeneration == generation {
        guard
          let peer = payload["peerConnection"] as? Bool,
          let media = payload["userMedia"] as? Bool
        else { return }
        debugProbeGeneration = nil
        debugProbeDeliveredGeneration = generation
        delegate?.realtimeBridge(
          self,
          didReceive: .probeResult(
            generation: generation,
            peerConnection: peer,
            userMedia: media,
            error: boundedString(payload["error"], maximum: Limit.error)
          )
        )
        resolveDebugProbeDelivery()
        return
      }
    #endif
    guard generation > 0, authorizationState.authorizes(generation: generation) else { return }

    let parsed: Message?
    switch type {
    case "offer":
      parsed = boundedString(payload["sdp"], maximum: Limit.sdp).map { .offer(generation: generation, sdp: $0) }
    case "connectionState":
      parsed = boundedString(payload["state"], maximum: 32).map { .connectionState(generation: generation, state: $0) }
    case "dataChannelState":
      parsed = boundedString(payload["state"], maximum: 16).map { .dataChannelState(generation: generation, state: $0) }
    case "serverEvent":
      parsed = boundedString(payload["json"], maximum: Limit.event).map { .serverEvent(generation: generation, json: $0) }
    case "audioActivity":
      if let inputLevel = boundedAudioLevel(payload["inputLevel"]),
        let outputLevel = boundedAudioLevel(payload["outputLevel"])
      {
        parsed = .audioActivity(
          generation: generation,
          inputLevel: inputLevel,
          outputLevel: outputLevel
        )
      } else {
        parsed = nil
      }
    case "inputCaptureState":
      guard let rawState = boundedString(payload["state"], maximum: 16),
        let state = RealtimeWebRTCInputCaptureState(rawValue: rawState)
      else {
        parsed = nil
        break
      }
      parsed = .inputCaptureState(generation: generation, state: state)
    case "answerApplied":
      parsed = payload.isEmpty ? .answerApplied(generation: generation) : nil
    case "error":
      parsed = boundedString(payload["code"], maximum: Limit.error).map { .error(generation: generation, code: $0) }
    default:
      parsed = nil
    }
    if let parsed {
      delegate?.realtimeBridge(self, didReceive: parsed)
      switch parsed {
      case let .offer(generation, sdp):
        yield(.offer(generation: generation, sdp: sdp))
      case let .connectionState(generation, state):
        yield(.connectionState(generation: generation, state: state))
      case let .dataChannelState(generation, state):
        yield(.dataChannelState(generation: generation, state: state))
      case let .serverEvent(generation, json):
        yield(.serverEvent(generation: generation, json: json))
      case let .audioActivity(generation, inputLevel, outputLevel):
        yield(.audioActivity(
          generation: generation,
          inputLevel: inputLevel,
          outputLevel: outputLevel
        ))
      case let .inputCaptureState(generation, state):
        yield(.inputCaptureState(generation: generation, state: state))
      case let .answerApplied(generation):
        yield(.answerApplied(generation: generation))
      case let .error(generation, code):
        yield(.failure(generation: generation, code: code))
      #if DEBUG
      case .probeResult:
        break
      #endif
      }
    }
  }

  private func boundedString(_ value: Any?, maximum: Int) -> String? {
    guard let value = value as? String, value.utf8.count <= maximum else { return nil }
    return value
  }

  private func boundedAudioLevel(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return nil
    }
    let level = number.doubleValue
    guard level.isFinite, (0 ... Limit.audioLevel).contains(level) else { return nil }
    return level
  }
}

extension RealtimeWebRTCBridge: RealtimeWebRTCBridging {}

extension RealtimeWebRTCBridge: WKNavigationDelegate {
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // `stop()` intentionally destroys the view. Only an active, owned view
    // represents an unexpected process loss, and the typed failure must reach
    // the transport before the stream is closed.
    guard !stopped, self.webView === webView,
          let generation = authorizationState.activeGeneration else { return }
    yield(.failure(generation: generation, code: "web_content_process_terminated"))
    finishEvents()
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    guard !stopped, self.webView === webView else {
      decisionHandler(.cancel)
      return
    }
    let allowed = RealtimeWebRTCBridgeSecurityPolicy.allowsMainFrameNavigation(
      to: navigationAction.request.url,
      isMainFrame: navigationAction.targetFrame?.isMainFrame == true
    )
    decisionHandler(allowed ? .allow : .cancel)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
  ) {
    guard !stopped, self.webView === webView else {
      decisionHandler(.cancel)
      return
    }
    let allowed = navigationResponse.isForMainFrame
      && navigationResponse.canShowMIMEType
      && RealtimeWebRTCBridgeSecurityPolicy.allowsMainFrameNavigation(
        to: navigationResponse.response.url,
        isMainFrame: true
      )
    decisionHandler(allowed ? .allow : .cancel)
  }
}

extension RealtimeWebRTCBridge: WKUIDelegate {
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    guard !stopped, self.webView === webView else { return nil }
    assert(!RealtimeWebRTCBridgeSecurityPolicy.allowsPopup())
    return nil
  }

  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void
  ) {
    guard !stopped, self.webView === webView else {
      decisionHandler(.deny)
      return
    }
    let productionAuthorized = authorizationState.activeGeneration.map {
      authorizationState.authorizes(generation: $0)
    } == true
    #if DEBUG
      let debugProbeAuthorized = debugProbeGeneration != nil
    #else
      let debugProbeAuthorized = false
    #endif
    let allowed = RealtimeWebRTCBridgeSecurityPolicy.allowsMediaCapture(
      isMicrophoneOnly: type == .microphone,
      isMainFrame: frame.isMainFrame,
      isOwnedOrigin: originIsOwned(origin),
      isProductionAuthorized: productionAuthorized,
      isDebugProbeAuthorized: debugProbeAuthorized
    )
    decisionHandler(allowed ? .grant : .deny)
  }
}

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: RealtimeWebRTCBridge?

  init(target: RealtimeWebRTCBridge) {
    self.target = target
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated {
      target?.receive(message)
    }
  }
}

#if DEBUG && os(iOS)
@MainActor
@objc(RealtimeBridgeGateProbe)
final class RealtimeBridgeGateProbe: NSObject, RealtimeWebRTCBridgeDelegate {
  private static var retainedProbe: RealtimeBridgeGateProbe?
  private let bridge = RealtimeWebRTCBridge()
  private let logger = Logger(subsystem: "dev.rawkode.enchiridion", category: "RealtimeBridgeGate")

  @objc static func run() {
    let probe = RealtimeBridgeGateProbe()
    retainedProbe = probe
    probe.bridge.delegate = probe
    do {
      try probe.bridge.load()
      probe.logger.notice("gate bridge bundle loaded")
    } catch {
      probe.logger.error("gate bridge bundle failed")
    }
  }

  func realtimeBridgeDidBecomeReady(_ bridge: RealtimeWebRTCBridge) {
    logger.notice("gate bridge ready")
    Task { @MainActor in
      do {
        try await bridge.runProbe(generation: 1)
        await bridge.stop()
      } catch {
        logger.error("gate probe invocation failed")
      }
    }
  }

  func realtimeBridge(_ bridge: RealtimeWebRTCBridge, didReceive message: RealtimeWebRTCBridge.Message) {
    guard case let .probeResult(_, peerConnection, userMedia, error) = message else { return }
    logger.notice("gate result peer_connection=\(peerConnection) user_media=\(userMedia) error=\(error ?? "none", privacy: .public)")
  }
}
#endif
