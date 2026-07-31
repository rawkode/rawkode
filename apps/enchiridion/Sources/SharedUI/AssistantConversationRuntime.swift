import EnchiridionCore
import Foundation

#if os(iOS)
  import AVFoundation

  @MainActor
  protocol HandheldConversationAudioSessionBacking: AnyObject {
    func setCategory(
      _ category: AVAudioSession.Category,
      mode: AVAudioSession.Mode,
      options: AVAudioSession.CategoryOptions
    ) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
  }

  @MainActor
  private final class SystemHandheldConversationAudioSessionBackend:
    HandheldConversationAudioSessionBacking
  {
    private let audioSession: AVAudioSession

    init(audioSession: AVAudioSession = .sharedInstance()) {
      self.audioSession = audioSession
    }

    func setCategory(
      _ category: AVAudioSession.Category,
      mode: AVAudioSession.Mode,
      options: AVAudioSession.CategoryOptions
    ) throws {
      try audioSession.setCategory(category, mode: mode, options: options)
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
      try audioSession.setActive(active, options: options)
    }
  }

  @MainActor
  final class HandheldConversationAudioSessionController:
    AssistantConversationAudioSessionControlling, RealtimeAudioSessionControlling
  {
    private let backend: any HandheldConversationAudioSessionBacking
    private var lifecycle = AssistantAudioSessionLifecycleState()

    init(
      backend: any HandheldConversationAudioSessionBacking =
        SystemHandheldConversationAudioSessionBackend()
    ) {
      self.backend = backend
    }

    func activate() async throws {
      guard !lifecycle.isActive else { return }
      if !lifecycle.isConfigured {
        try backend.setCategory(
          .playAndRecord,
          mode: .voiceChat,
          options: [.allowBluetoothHFP]
        )
        lifecycle.didConfigure()
      }
      try backend.setActive(true, options: [])
      lifecycle.didActivate()
    }

    func deactivate() async {
      guard lifecycle.isActive else { return }
      lifecycle.didDeactivate()
      try? backend.setActive(false, options: .notifyOthersOnDeactivation)
    }

    func resetAfterMediaServicesReset() async {
      lifecycle.resetAfterMediaServicesReset()
    }
  }

  private final class NotificationObserverLifetime: @unchecked Sendable {
    private let notificationCenter: NotificationCenter
    private let lock = NSLock()
    private var observers: [NSObjectProtocol] = []

    init(notificationCenter: NotificationCenter) {
      self.notificationCenter = notificationCenter
    }

    func append(_ observer: NSObjectProtocol) {
      lock.withLock { observers.append(observer) }
    }

    func cancel() {
      let removed = lock.withLock {
        let removed = observers
        observers.removeAll()
        return removed
      }
      for observer in removed {
        notificationCenter.removeObserver(observer)
      }
    }

    deinit {
      cancel()
    }
  }

  final class HandheldConversationAudioEventSource:
    AssistantVoiceSafetyEventSource, @unchecked Sendable
  {
    private let notificationCenter: NotificationCenter
    private let audioSession: AVAudioSession

    init(
      notificationCenter: NotificationCenter = .default,
      audioSession: AVAudioSession = .sharedInstance()
    ) {
      self.notificationCenter = notificationCenter
      self.audioSession = audioSession
    }

    func events() -> AsyncStream<AssistantVoiceSafetyEvent> {
      AsyncStream { continuation in
        let lifetime = NotificationObserverLifetime(notificationCenter: notificationCenter)
        observe(AVAudioSession.interruptionNotification, lifetime: lifetime) { notification in
          guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let event = AssistantVoiceSafetyNotificationParser.interruption(rawType: rawType)
          else { return }
          continuation.yield(event)
        }
        observe(AVAudioSession.routeChangeNotification, lifetime: lifetime) {
          [weak self] notification in
          guard let self,
            let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
          else { return }
          let previous =
            (notification.userInfo?[AVAudioSessionRouteChangePreviousRouteKey]
            as? AVAudioSessionRouteDescription).map(Self.snapshot)
          let current = Self.snapshot(audioSession.currentRoute)
          if let event = AssistantVoiceSafetyNotificationParser.routeChange(
            rawReason: rawReason,
            previous: previous,
            current: current
          ) {
            continuation.yield(event)
          }
        }
        observe(AVAudioSession.mediaServicesWereLostNotification, lifetime: lifetime) { _ in
          continuation.yield(.mediaServicesLost)
        }
        observe(AVAudioSession.mediaServicesWereResetNotification, lifetime: lifetime) { _ in
          continuation.yield(.mediaServicesReset)
        }
        continuation.onTermination = { _ in lifetime.cancel() }
      }
    }

    private func observe(
      _ name: Notification.Name,
      lifetime: NotificationObserverLifetime,
      using block: @escaping @Sendable (Notification) -> Void
    ) {
      lifetime.append(
        notificationCenter.addObserver(
          forName: name, object: audioSession, queue: nil, using: block)
      )
    }

    private static func snapshot(
      _ route: AVAudioSessionRouteDescription
    ) -> AssistantAudioRouteSnapshot {
      AssistantAudioRouteSnapshot(
        inputs: route.inputs.map { port($0.portType) },
        outputs: route.outputs.map { port($0.portType) }
      )
    }

    private static func port(_ type: AVAudioSession.Port) -> AssistantAudioPort {
      switch type {
      case .builtInMic: .builtInMic
      case .builtInReceiver: .builtInReceiver
      case .builtInSpeaker: .builtInSpeaker
      case .headphones: .headphones
      case .headsetMic: .headsetMic
      case .bluetoothA2DP: .bluetoothA2DP
      case .bluetoothHFP: .bluetoothHFP
      case .bluetoothLE: .bluetoothLE
      case .usbAudio: .usbAudio
      case .airPlay: .airPlay
      case .carAudio: .carAudio
      case .HDMI: .hdmi
      case .lineIn: .lineIn
      case .lineOut: .lineOut
      default: .other
      }
    }
  }
#elseif os(macOS)
  import AVFoundation

  private final class MacNotificationObserverLifetime: @unchecked Sendable {
    private let notificationCenter: NotificationCenter
    private let lock = NSLock()
    private var observer: NSObjectProtocol?

    init(notificationCenter: NotificationCenter) {
      self.notificationCenter = notificationCenter
    }

    func store(_ observer: NSObjectProtocol) {
      lock.withLock { self.observer = observer }
    }

    func cancel() {
      let removed = lock.withLock {
        defer { observer = nil }
        return observer
      }
      if let removed {
        notificationCenter.removeObserver(removed)
      }
    }

    deinit {
      cancel()
    }
  }

  final class MacVoiceDeviceChangeEventSource:
    AssistantVoiceSafetyEventSource, @unchecked Sendable
  {
    private let notificationCenter: NotificationCenter

    init(notificationCenter: NotificationCenter = .default) {
      self.notificationCenter = notificationCenter
    }

    func events() -> AsyncStream<AssistantVoiceSafetyEvent> {
      AsyncStream { continuation in
        let lifetime = MacNotificationObserverLifetime(notificationCenter: notificationCenter)
        lifetime.store(
          notificationCenter.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: nil,
            queue: nil
          ) { _ in
            continuation.yield(.mediaServicesReset)
          }
        )
        continuation.onTermination = { _ in lifetime.cancel() }
      }
    }
  }
#endif

enum AssistantConversationSurface: Equatable {
  case app
  case carPlay
}

#if DEBUG
  private actor DelayedOptimisticChatFixtureAnswerer: AssistantConversationAnswering {
    func respond(to request: AssistantConversationRequest) async -> GroundedAssistantResponse {
      let route = request.routeOverride ?? .appleOnDevice
      let routeLabel: String
      if route.provider == .openAI {
        routeLabel = route.modelID.map { "OpenAI · \($0)" } ?? "OpenAI"
      } else {
        routeLabel = "Apple On Device"
      }
      do {
        try await Task.sleep(for: .seconds(30))
      } catch {
        return GroundedAssistantResponse(
          answer: "Response stopped",
          status: .unavailable,
          metadata: AssistantResponseMetadata(
            requestedProvider: route.provider,
            requestedModelID: route.modelID,
            routeLabel: routeLabel,
            requestIDs: ["debug_delayed_cancelled"],
            completion: .incomplete,
            recoveryAction: .retry
          )
        )
      }
      return GroundedAssistantResponse(
        answer: "This delayed response replaced the pending bubble without adding another turn.",
        status: .answered,
        metadata: AssistantResponseMetadata(
          requestedProvider: route.provider,
          requestedModelID: route.modelID,
          actualModelID: route.modelID,
          routeLabel: routeLabel,
          requestIDs: ["debug_delayed_completed"]
        )
      )
    }

    func resetConversation() async {}
  }
#endif

@MainActor
func makeAssistantConversationSession(
  assistant: (any AssistantConversationAnswering)?,
  voicePreferences: AssistantVoicePreferences,
  surface: AssistantConversationSurface = .app
) -> AssistantConversationSession? {
  #if DEBUG
    if surface == .app,
      ProcessInfo.processInfo.arguments.contains("-AssistantOptimisticChatFixture")
    {
      return AssistantConversationSession(answerer: DelayedOptimisticChatFixtureAnswerer())
    }
  #endif
  guard let assistant else { return nil }
  if #available(iOS 26.0, macOS 26.0, *) {
    #if os(iOS)
      let audioSessionController: (any AssistantConversationAudioSessionControlling)? =
        surface == .app ? HandheldConversationAudioSessionController() : nil
      let voiceSafetyEventSource: (any AssistantVoiceSafetyEventSource)? =
        surface == .app ? HandheldConversationAudioEventSource() : nil
    #else
      let audioSessionController: (any AssistantConversationAudioSessionControlling)? = nil
      let voiceSafetyEventSource: (any AssistantVoiceSafetyEventSource)? =
        surface == .app ? MacVoiceDeviceChangeEventSource() : nil
    #endif
    return AssistantConversationSession(
      transcriber: OnDeviceSpeechTranscriber(),
      answerer: assistant,
      speaker: AppleSystemSpeechOutput(
        voicePreferences: voicePreferences,
        speechOwner: surface == .carPlay ? .carPlay : .assistant
      ),
      audioSessionController: audioSessionController,
      voiceSafetyEventSource: voiceSafetyEventSource,
      speaksResponses: true
    )
  }
  return AssistantConversationSession(answerer: assistant)
}

func assistantUnavailabilityMessage(
  assistant: FoundationModelAssistant?,
  repositoryError: String?
) -> String? {
  if let repositoryError { return "Your local library could not be opened: \(repositoryError)" }
  guard assistant != nil else { return "Your local library is unavailable." }
  let availability = FoundationModelAssistant.availability()
  return availability == .available ? nil : availability.message
}
