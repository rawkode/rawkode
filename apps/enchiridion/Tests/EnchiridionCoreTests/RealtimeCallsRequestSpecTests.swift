import CryptoKit
import Foundation
import Testing
@testable import EnchiridionCore

@MainActor
struct RealtimeCallsRequestSpecTests {
  private let boundary = "enchiridion-fixture-123"

  @Test
  func exactEndpointPartsAndSessionContract() throws {
    let fixture = try makeFixture()
    let spec = try RealtimeCallsRequestSpecBuilder.buildForTesting(
      offerSDP: "v=0\r\na=fixture-offer\r\n",
      route: fixture.route,
      configuration: fixture.configuration,
      boundary: boundary
    )

    #expect(spec.endpoint.absoluteString == "https://api.openai.com/v1/realtime/calls")
    #expect(spec.method == "POST")
    #expect(spec.cacheControl == "no-store")
    #expect(spec.contentType == "multipart/form-data; boundary=\(boundary)")

    let body = try #require(String(data: spec.body, encoding: .utf8))
    #expect(body.components(separatedBy: "name=\"sdp\"").count == 2)
    #expect(body.components(separatedBy: "name=\"session\"").count == 2)
    #expect(!body.contains("filename="))
    #expect(body.contains("Content-Type: application/sdp\r\n\r\nv=0"))
    #expect(body.contains("Content-Type: application/json"))

    let object = try #require(
      JSONSerialization.jsonObject(
        with: RealtimeCallsRequestSpecBuilder.sessionJSON(fixture.configuration)
      ) as? [String: Any]
    )
    #expect(object["type"] as? String == "realtime")
    #expect(object["model"] as? String == fixture.configuration.modelID)
    #expect(object["output_modalities"] as? [String] == ["audio"])
    #expect(object["max_output_tokens"] as? Int == 1_024)
    #expect(object["tracing"] is NSNull)
    #expect((object["tools"] as? [Any])?.isEmpty == true)
    #expect(object["tool_choice"] as? String == "none")
    let audio = try #require(object["audio"] as? [String: Any])
    let input = try #require(audio["input"] as? [String: Any])
    #expect(input["transcription"] == nil)
    let detection = try #require(input["turn_detection"] as? [String: Any])
    #expect(detection["type"] as? String == "semantic_vad")
    #expect(detection["eagerness"] as? String == "auto")
    #expect(detection["create_response"] as? Bool == true)
    #expect(detection["interrupt_response"] as? Bool == true)
    let output = try #require(audio["output"] as? [String: Any])
    #expect(output["voice"] as? String == fixture.configuration.voiceID)
  }

  @Test
  func realtime21IsSerializedUnchangedAndRequiresAnExactEstablishedModel() throws {
    let route = try makeAuthorizedRealtimeVoiceRoute(
      modelID: "gpt-realtime-2.1",
      voiceID: OpenAIRealtimeVoiceCatalog.preferredDefault.id,
      binding: OpenAICredentialBinding(revision: "fixture-revision", fingerprint: "fixture")
    )
    let configuration = try RealtimeVoiceConfiguration(route: route)
    let spec = try RealtimeCallsRequestSpecBuilder.buildForTesting(
      offerSDP: "v=0\r\na=realtime-2.1\r\n",
      route: route,
      configuration: configuration,
      boundary: boundary
    )

    let session = try #require(
      JSONSerialization.jsonObject(
        with: RealtimeCallsRequestSpecBuilder.sessionJSON(configuration)
      ) as? [String: Any]
    )
    #expect(session["model"] as? String == "gpt-realtime-2.1")
    let body = try #require(String(data: spec.body, encoding: .utf8))
    #expect(body.contains("\"model\":\"gpt-realtime-2.1\""))
    try configuration.validateActual(
      modelID: "gpt-realtime-2.1",
      voiceID: OpenAIRealtimeVoiceCatalog.preferredDefault.id
    )
    #expect(throws: RealtimeVoiceContractError.modelMismatch(
      expected: "gpt-realtime-2.1", actual: "gpt-realtime-mini"
    )) {
      try configuration.validateActual(
        modelID: "gpt-realtime-mini",
        voiceID: OpenAIRealtimeVoiceCatalog.preferredDefault.id
      )
    }
  }

  @Test
  func endpointRedirectAndPersistencePoliciesAreClosed() {
    #expect(RealtimeCallsRequestSpecBuilder.acceptsEndpoint(RealtimeCallsRequestSpecBuilder.endpoint))
    #expect(!RealtimeCallsRequestSpecBuilder.acceptsEndpoint(URL(string: "http://api.openai.com/v1/realtime/calls")!))
    #expect(!RealtimeCallsRequestSpecBuilder.acceptsEndpoint(URL(string: "https://api.openai.com/v1/realtime/calls/extra")!))
    #expect(!RealtimeCallsRequestSpecBuilder.acceptsEndpoint(URL(string: "https://example.com/v1/realtime/calls")!))
    #expect(!RealtimeCallsRequestSpecBuilder.acceptsRedirect(
      from: RealtimeCallsRequestSpecBuilder.endpoint,
      to: RealtimeCallsRequestSpecBuilder.endpoint
    ))

    let configuration = RealtimeCallsRequestSpecBuilder.ephemeralConfiguration()
    #expect(configuration.requestCachePolicy == .reloadIgnoringLocalCacheData)
    #expect(configuration.urlCache == nil)
    #expect(configuration.httpCookieStorage == nil)
    #expect(configuration.httpShouldSetCookies == false)
    #expect(configuration.httpCookieAcceptPolicy == .never)
    #expect(configuration.urlCredentialStorage == nil)
    #expect(configuration.waitsForConnectivity == false)
  }

  @Test
  func boundsRejectOversizedOrMalformedValues() throws {
    let fixture = try makeFixture()
    #expect(throws: RealtimeCallsRequestSpecError.invalidOffer) {
      try RealtimeCallsRequestSpecBuilder.build(
        offerSDP: String(repeating: "x", count: RealtimeCallsRequestSpecBuilder.maximumOfferBytes + 1),
        route: fixture.route,
        configuration: fixture.configuration
      )
    }
    #expect(throws: RealtimeCallsRequestSpecError.invalidBoundary) {
      try RealtimeCallsRequestSpecBuilder.buildForTesting(
        offerSDP: "v=0",
        route: fixture.route,
        configuration: fixture.configuration,
        boundary: "bad boundary"
      )
    }
    #expect(throws: RealtimeCallsRequestSpecError.invalidAnswer) {
      try RealtimeCallsRequestSpecBuilder.validateAnswer(Data())
    }
  }

  @Test
  func generatedBoundaryIsAsciiAndCallerCannotControlIt() throws {
    let fixture = try makeFixture()
    let first = try RealtimeCallsRequestSpecBuilder.build(
      offerSDP: "v=0\r\na=first\r\n",
      route: fixture.route,
      configuration: fixture.configuration
    )
    let second = try RealtimeCallsRequestSpecBuilder.build(
      offerSDP: "v=0\r\na=second\r\n",
      route: fixture.route,
      configuration: fixture.configuration
    )
    let prefix = "multipart/form-data; boundary="
    let firstBoundary = String(first.contentType.dropFirst(prefix.count))
    let secondBoundary = String(second.contentType.dropFirst(prefix.count))

    #expect(first.contentType.hasPrefix(prefix))
    #expect(firstBoundary != secondBoundary)
    #expect(!firstBoundary.isEmpty && firstBoundary.utf8.count <= 70)
    #expect(firstBoundary.unicodeScalars.allSatisfy {
      (65...90).contains($0.value)
        || (97...122).contains($0.value)
        || (48...57).contains($0.value)
        || $0.value == 45
    })
  }

  @Test
  func boundaryRejectsUnicodeAndDelimiterCollision() throws {
    let fixture = try makeFixture()
    #expect(throws: RealtimeCallsRequestSpecError.invalidBoundary) {
      try RealtimeCallsRequestSpecBuilder.buildForTesting(
        offerSDP: "v=0",
        route: fixture.route,
        configuration: fixture.configuration,
        boundary: "unicode-é"
      )
    }
    #expect(throws: RealtimeCallsRequestSpecError.invalidBoundary) {
      try RealtimeCallsRequestSpecBuilder.buildForTesting(
        offerSDP: "v=0\r\n--\(boundary)\r\ninjected",
        route: fixture.route,
        configuration: fixture.configuration,
        boundary: boundary
      )
    }
  }

  @Test
  func bundledBridgeHasStrictCSPAndNoCredentialMaterial() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let appRoot = testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let htmlURL = appRoot
      .appendingPathComponent("Sources/SharedUI/Resources/RealtimeBridge/index.html")
    let html = try String(contentsOf: htmlURL, encoding: .utf8)

    #expect(html.contains("default-src 'none'"))
    #expect(html.contains("connect-src 'none'"))
    #expect(html.contains("object-src 'none'"))
    #expect(html.contains("frame-src 'none'"))
    #expect(html.contains("navigator.mediaDevices.getUserMedia"))
    #expect(html.contains("new RTCPeerConnection"))
    #expect(html.contains("createDataChannel(\"oai-events\""))
    #expect(html.contains("video: false"))
    #expect(html.contains("authorize: expose(authorize)"))
    #expect(html.contains("requireCurrentGeneration"))
    #expect(html.contains("let transportEpoch = 0"))
    #expect(html.contains("let sessionPeer = null"))
    #expect(html.contains("let sessionStream = null"))
    #expect(html.contains("requireAttemptCurrent(sessionGeneration, sessionEpoch)"))
    #expect(html.contains("isTransportCurrent(sessionGeneration, sessionEpoch"))
    #expect(html.contains("cleanupTransport(sessionPeer, sessionChannel, sessionStream"))
    #expect(!html.contains("peer = new RTCPeerConnection"))
    #expect(!html.contains("microphone = await navigator.mediaDevices.getUserMedia"))
    #expect(html.contains("generation = 0"))
    #expect(!html.contains("function probe"))
    #expect(!html.contains("probeResult"))

    let lower = html.lowercased()
    #expect(!lower.contains("authorization"))
    #expect(!lower.contains("bearer"))
    #expect(!lower.contains("api key"))
    #expect(!lower.contains("client_secret"))
    #expect(!lower.contains("api.openai.com"))
    #expect(!lower.contains("safety" + "_identifier"))

    let script = try #require(html.firstMatch(of: /(?s)<script>(.*?)<\/script>/)?.1)
    let digest = Data(SHA256.hash(data: Data(script.utf8))).base64EncodedString()
    #expect(html.contains("script-src 'sha256-\(digest)'"))

    // Capture recovery is deliberately an invariant-rich bridge operation.
    // Keep these seams static until a browser-level harness is available.
    #expect(html.contains("let inputQueue = Promise.resolve()"))
    #expect(html.contains("const operationEpoch = ++inputEpoch"))
    #expect(html.contains("inputQueue = operation.catch(() => {})"))
    #expect(html.contains("if (!message.enabled) {\n        track.enabled = false;\n        return;"))
    #expect(html.contains("await withInputDeadline(() => navigator.mediaDevices.getUserMedia"))
    #expect(html.contains("replacementTrack.enabled = false"))
    #expect(html.contains("senders.length !== 1"))
    #expect(html.contains("senders[0].replaceTrack(replacementTrack)"))
    #expect(html.contains("senders[0].track !== replacementTrack"))
    #expect(html.contains("for (const track of replacementStream.getTracks()) track.stop()"))
    #expect(html.contains("track.readyState === \"live\""))
    #expect(html.contains("audioContext.state === \"suspended\""))
    #expect(html.contains("remoteAudio.srcObject) attachRemoteMeter"))
    #expect(html.contains("inputCaptureState\", { state: \"recovering\""))
    #expect(html.contains("inputCaptureState\", { state: \"recovered\""))
    #expect(html.contains("inputCaptureState\", { state: \"unavailable\""))
  }

  @Test
  func bridgeCapabilityRequiresExactRouteLeaseAndGeneration() throws {
    let fixture = try makeFixture()
    let binding = try #require(fixture.route.credentialBinding)
    let lease = RealtimeCredentialLease(credential: "", binding: binding)
    let capability = try RealtimeWebRTCBridgeAuthorization.issue(
      generation: 7,
      route: fixture.route,
      credential: lease
    )

    #expect(capability.authorizes(generation: 7))
    #expect(!capability.authorizes(generation: 6))
    #expect(!capability.authorizes(generation: 0))
    #expect(throws: RealtimeWebRTCBridgeAuthorizationError.invalidGeneration) {
      try RealtimeWebRTCBridgeAuthorization.issue(
        generation: 0,
        route: fixture.route,
        credential: lease
      )
    }

    let wrongLease = RealtimeCredentialLease(
      credential: "",
      binding: OpenAICredentialBinding(revision: "other", fingerprint: "other")
    )
    #expect(throws: RealtimeWebRTCBridgeAuthorizationError.credentialBindingMismatch) {
      try RealtimeWebRTCBridgeAuthorization.issue(
        generation: 7,
        route: fixture.route,
        credential: wrongLease
      )
    }
  }

  @Test
  func bridgeAuthorizationStateRejectsStaleGenerationAndRevokesBeforeFailure() throws {
    let fixture = try makeFixture()
    let binding = try #require(fixture.route.credentialBinding)
    let lease = RealtimeCredentialLease(credential: "", binding: binding)
    let capability = try RealtimeWebRTCBridgeAuthorization.issue(
      generation: 7,
      route: fixture.route,
      credential: lease
    )
    var state = RealtimeWebRTCBridgeAuthorizationState()
    try state.activate(capability, generation: 7)
    #expect(state.authorizes(generation: 7))
    #expect(!state.authorizes(generation: 6))

    #expect(throws: RealtimeWebRTCBridgeAuthorizationError.invalidGeneration) {
      try state.activate(capability, generation: 8)
    }
    #expect(state.activeGeneration == nil)
    #expect(!state.authorizes(generation: 7))

    try state.activate(capability, generation: 7)
    state.revoke()
    #expect(state.activeGeneration == nil)
  }

  @Test
  func bridgeLifecycleInvalidatesSuspendedAuthorizationAndStopsOneWay() throws {
    var lifecycle = RealtimeWebRTCBridgeLifecycleState()
    #expect(lifecycle.currentEpoch == 0)
    let firstCandidate = lifecycle.beginAuthorization()
    let firstAuthorization = try #require(firstCandidate)
    #expect(firstAuthorization == 1)
    #expect(lifecycle.isCurrent(firstAuthorization))

    let replacementCandidate = lifecycle.beginAuthorization()
    let replacementAuthorization = try #require(replacementCandidate)
    #expect(replacementAuthorization == 2)
    #expect(!lifecycle.isCurrent(firstAuthorization))
    #expect(lifecycle.isCurrent(replacementAuthorization))

    let teardownCandidate = lifecycle.stop()
    let teardownEpoch = try #require(teardownCandidate)
    #expect(teardownEpoch == 3)
    #expect(lifecycle.isStopped)
    #expect(lifecycle.currentEpoch == nil)
    #expect(!lifecycle.isCurrent(replacementAuthorization))
    #expect(lifecycle.beginAuthorization() == nil)
    #expect(lifecycle.stop() == nil)
  }

  @Test
  func messageGenerationParserRejectsNonIntegerUnsafeAndBooleanValues() {
    let parser = RealtimeWebRTCBridgeMessageGenerationParser.self
    #expect(parser.parse(NSNumber(value: true), allowsZero: true) == nil)
    #expect(parser.parse(NSNumber(value: -1), allowsZero: true) == nil)
    #expect(parser.parse(NSNumber(value: 7.5), allowsZero: true) == nil)
    #expect(parser.parse(NSNumber(value: 9_007_199_254_740_992 as UInt64), allowsZero: true) == nil)
    #expect(parser.parse(NSNumber(value: 0), allowsZero: false) == nil)
    #expect(parser.parse(NSNumber(value: 0), allowsZero: true) == 0)
    #expect(parser.parse(NSNumber(value: 7), allowsZero: false) == 7)
  }

  @Test
  func bridgeVersionParserAcceptsOnlyExactOneAsAJSsafeInteger() {
    let parser = RealtimeWebRTCBridgeMessageGenerationParser.self
    #expect(parser.parse(NSNumber(value: 1), allowsZero: false) == 1)
    #expect(parser.parse(NSNumber(value: true), allowsZero: false) == nil)
    #expect(parser.parse(NSNumber(value: 1.5), allowsZero: false) == nil)
    #expect(
      parser.parse(
        NSNumber(value: 9_007_199_254_740_992 as UInt64),
        allowsZero: false
      ) == nil
    )
  }

  @Test
  func bridgePolicyClosesOriginFrameNavigationMediaPopupAndEnvelope() {
    let policy = RealtimeWebRTCBridgeSecurityPolicy.self
    #expect(
      policy.isOwnedOrigin(
        scheme: "https",
        host: "realtime.enchiridion.invalid",
        port: 443
      )
    )
    #expect(
      !policy.isOwnedOrigin(
        scheme: "http",
        host: "realtime.enchiridion.invalid",
        port: 0
      )
    )
    #expect(policy.allowsMainFrameNavigation(to: policy.ownedOrigin, isMainFrame: true))
    #expect(
      !policy.allowsMainFrameNavigation(
        to: URL(string: "https://realtime.enchiridion.invalid:8443/"),
        isMainFrame: true
      )
    )
    #expect(
      !policy.allowsMainFrameNavigation(
        to: URL(string: "https://realtime.enchiridion.invalid/?q=1"),
        isMainFrame: true
      )
    )
    #expect(!policy.allowsMainFrameNavigation(to: policy.ownedOrigin, isMainFrame: false))
    #expect(!policy.allowsPopup())
    #expect(
      policy.allowsMediaCapture(
        isMicrophoneOnly: true,
        isMainFrame: true,
        isOwnedOrigin: true,
        isProductionAuthorized: true,
        isDebugProbeAuthorized: false
      )
    )
    #expect(
      !policy.allowsMediaCapture(
        isMicrophoneOnly: false,
        isMainFrame: true,
        isOwnedOrigin: true,
        isProductionAuthorized: true,
        isDebugProbeAuthorized: false
      )
    )
    #expect(
      !policy.allowsMediaCapture(
        isMicrophoneOnly: true,
        isMainFrame: false,
        isOwnedOrigin: true,
        isProductionAuthorized: true,
        isDebugProbeAuthorized: false
      )
    )
    #expect(
      policy.acceptsMessageEnvelope(
        fieldCount: 4,
        version: 1,
        generation: 7,
        type: "offer",
        isMainFrame: true,
        isOwnedOrigin: true,
        payloadIsDictionary: true,
        payloadByteCount: 1_024
      )
    )
    #expect(
      !policy.acceptsMessageEnvelope(
        fieldCount: 5,
        version: 1,
        generation: 7,
        type: "offer",
        isMainFrame: true,
        isOwnedOrigin: true,
        payloadIsDictionary: true,
        payloadByteCount: 1_024
      )
    )
    #expect(policy.acceptsPayload(type: "offer", keys: ["sdp"]))
    #expect(!policy.acceptsPayload(type: "offer", keys: ["sdp", "extra"]))
    #expect(policy.acceptsPayload(type: "inputCaptureState", keys: ["state"]))
    #expect(!policy.acceptsPayload(type: "inputCaptureState", keys: []))
    #expect(!policy.acceptsPayload(type: "inputCaptureState", keys: ["state", "detail"]))
    #expect(RealtimeWebRTCInputCaptureState(rawValue: "recovering") == .recovering)
    #expect(RealtimeWebRTCInputCaptureState(rawValue: "recovered") == .recovered)
    #expect(RealtimeWebRTCInputCaptureState(rawValue: "unavailable") == .unavailable)
    #expect(RealtimeWebRTCInputCaptureState(rawValue: "arbitrary") == nil)
    #expect(!policy.acceptsPayload(type: "unknown", keys: []))
  }

  @Test
  func bridgeNativeSourceKeepsSecurityAndDebugProbeBoundaries() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let appRoot = testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let bridge = try String(
      contentsOf: appRoot.appendingPathComponent("Sources/SharedUI/RealtimeWebRTCBridge.swift"),
      encoding: .utf8
    )
    let requestSpec = try String(
      contentsOf: appRoot.appendingPathComponent(
        "Sources/EnchiridionCore/RealtimeCallsRequestSpec.swift"
      ),
      encoding: .utf8
    )

    #expect(bridge.contains("websiteDataStore = .nonPersistent()"))
    #expect(bridge.contains("weak var target"))
    #expect(bridge.contains("removeScriptMessageHandler"))
    #expect(bridge.contains("private var webView: WKWebView?"))
    #expect(bridge.contains("webView = nil"))
    #expect(bridge.contains("lifecycle.isCurrent(operationEpoch)"))
    #expect(bridge.contains("destroyWebView(capturedWebView"))
    #expect(bridge.contains("authorizationState.revoke()"))
    #expect(bridge.contains("let version = RealtimeWebRTCBridgeMessageGenerationParser.parse("))
    #expect(bridge.contains("version == 1"))
    #expect(!bridge.contains("version: body[\"version\"] as? Int"))
    #expect(bridge.contains("try await awaitProbeDelivery("))
    #expect(bridge.contains("debugProbeDeliveryTimeout"))
    #expect(bridge.contains("try await withTaskCancellationHandler"))
    #expect(bridge.contains("Task.sleep(for: Self.debugProbeDeliveryTimeout)"))
    #expect(bridge.contains("resolveDebugProbeDelivery(throwing: BridgeError.probeTimedOut)"))
    #expect(bridge.contains("resolveDebugProbeDelivery(throwing: BridgeError.unavailable)"))
    let probeAwait = try #require(bridge.range(of: "try await awaitProbeDelivery("))
    let gateStop = try #require(
      bridge.range(of: "await bridge.stop()", range: probeAwait.upperBound..<bridge.endIndex)
    )
    #expect(probeAwait.lowerBound < gateStop.lowerBound)
    #expect(bridge.contains("allowsMainFrameNavigation"))
    #expect(bridge.contains("allowsMediaCapture"))
    #expect(bridge.contains("#if DEBUG && os(iOS)"))
    #expect(bridge.contains("@objc(RealtimeBridgeGateProbe)"))
    #expect(requestSpec.contains("fileprivate init("))
    #expect(!requestSpec.contains("public init(endpoint:"))
  }

  private func makeFixture() throws -> (
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration
  ) {
    let route = try makeAuthorizedRealtimeVoiceRoute(
      modelID: OpenAIModelCatalog.realtimeOptions[0].id,
      voiceID: OpenAIRealtimeVoiceCatalog.preferredDefault.id,
      binding: OpenAICredentialBinding(revision: "fixture-revision", fingerprint: "fixture")
    )
    return (route, try RealtimeVoiceConfiguration(route: route))
  }
}
