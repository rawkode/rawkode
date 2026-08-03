import Foundation

public enum RealtimeWebRTCBridgeMessageGenerationParser {
  public static let maximumSafeInteger: UInt64 = 9_007_199_254_740_991

  public static func parse(_ value: Any?, allowsZero: Bool) -> UInt64? {
    guard let number = value as? NSNumber else { return nil }
    guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard
      double.isFinite,
      double >= (allowsZero ? 0 : 1),
      double <= Double(maximumSafeInteger),
      double.rounded(.towardZero) == double
    else { return nil }
    return UInt64(double)
  }
}

public enum RealtimeWebRTCBridgeAuthorizationError: Error, Equatable, Sendable {
  case invalidGeneration
  case unauthorizedRoute
  case credentialBindingMismatch
}

/// Opaque authority for one frozen, verified Realtime route. It contains no
/// credential material and cannot be constructed without an exact native
/// credential lease.
public struct RealtimeWebRTCBridgeAuthorization: Sendable {
  private let sessionGeneration: UInt64

  private init(sessionGeneration: UInt64) {
    self.sessionGeneration = sessionGeneration
  }

  public static func issue(
    generation: UInt64,
    route: RealtimeVoiceRouteSnapshot,
    credential: RealtimeCredentialLease
  ) throws -> Self {
    guard generation > 0 else {
      throw RealtimeWebRTCBridgeAuthorizationError.invalidGeneration
    }
    guard
      route.isAuthorizedOpenAIRealtime,
      route.modelCatalogVersion == OpenAIModelCatalog.version,
      route.voiceCatalogVersion == OpenAIRealtimeVoiceCatalog.version,
      route.modelID.map({ modelID in
        OpenAIModelCatalog.realtimeOptions.contains(where: { $0.id == modelID })
      }) == true,
      route.voiceID.map(OpenAIRealtimeVoiceCatalog.contains) == true
    else {
      throw RealtimeWebRTCBridgeAuthorizationError.unauthorizedRoute
    }
    guard
      let binding = route.credentialBinding,
      binding == credential.binding,
      credential.generation == binding.revision
    else {
      throw RealtimeWebRTCBridgeAuthorizationError.credentialBindingMismatch
    }
    return Self(sessionGeneration: generation)
  }

  public func authorizes(generation: UInt64) -> Bool {
    generation > 0 && generation == sessionGeneration
  }
}

public struct RealtimeWebRTCBridgeAuthorizationState: Sendable {
  private var capability: RealtimeWebRTCBridgeAuthorization?
  public private(set) var activeGeneration: UInt64?

  public init() {}

  public mutating func activate(
    _ candidate: RealtimeWebRTCBridgeAuthorization,
    generation: UInt64
  ) throws {
    revoke()
    guard candidate.authorizes(generation: generation) else {
      throw RealtimeWebRTCBridgeAuthorizationError.invalidGeneration
    }
    capability = candidate
    activeGeneration = generation
  }

  public mutating func revoke() {
    capability = nil
    activeGeneration = nil
  }

  public func authorizes(generation: UInt64) -> Bool {
    activeGeneration == generation
      && capability?.authorizes(generation: generation) == true
  }
}

/// Monotonic authority for one native bridge lifetime. Authorization changes
/// invalidate every suspended command, and terminal stop can never be undone.
public struct RealtimeWebRTCBridgeLifecycleState: Equatable, Sendable {
  public private(set) var epoch: UInt64 = 0
  public private(set) var isStopped = false

  public init() {}

  public var currentEpoch: UInt64? {
    isStopped ? nil : epoch
  }

  public mutating func beginAuthorization() -> UInt64? {
    guard !isStopped, epoch < UInt64.max else {
      isStopped = true
      return nil
    }
    epoch += 1
    return epoch
  }

  public mutating func stop() -> UInt64? {
    guard !isStopped else { return nil }
    isStopped = true
    if epoch < UInt64.max { epoch += 1 }
    return epoch
  }

  public func isCurrent(_ candidate: UInt64) -> Bool {
    !isStopped && candidate == epoch
  }
}

public enum RealtimeWebRTCBridgeSecurityPolicy {
  public static let ownedOrigin = URL(string: "https://realtime.enchiridion.invalid")!

  public static func isOwnedOrigin(scheme: String, host: String, port: Int) -> Bool {
    scheme == ownedOrigin.scheme
      && host == ownedOrigin.host
      && (port == 0 || port == 443)
  }

  public static func allowsMainFrameNavigation(to url: URL?, isMainFrame: Bool) -> Bool {
    guard isMainFrame, let url else { return false }
    if url.absoluteString == "about:blank" { return true }
    return url.scheme == ownedOrigin.scheme
      && url.host == ownedOrigin.host
      && url.port == nil
      && (url.path.isEmpty || url.path == "/")
      && url.query == nil
      && url.fragment == nil
      && url.user == nil
      && url.password == nil
  }

  public static func allowsMediaCapture(
    isMicrophoneOnly: Bool,
    isMainFrame: Bool,
    isOwnedOrigin: Bool,
    isProductionAuthorized: Bool,
    isDebugProbeAuthorized: Bool
  ) -> Bool {
    isMicrophoneOnly
      && isMainFrame
      && isOwnedOrigin
      && (isProductionAuthorized || isDebugProbeAuthorized)
  }

  public static func acceptsMessageEnvelope(
    fieldCount: Int,
    version: Int?,
    generation: UInt64?,
    type: String?,
    isMainFrame: Bool,
    isOwnedOrigin: Bool,
    payloadIsDictionary: Bool,
    payloadByteCount: Int
  ) -> Bool {
    fieldCount == 4
      && version == 1
      && generation != nil
      && type.map { !$0.isEmpty && $0.utf8.count <= 32 } == true
      && isMainFrame
      && isOwnedOrigin
      && payloadIsDictionary
      && payloadByteCount <= 128 * 1024
  }

  public static func acceptsPayload(type: String, keys: Set<String>) -> Bool {
    switch type {
    case "ready", "answerApplied":
      keys.isEmpty
    case "offer":
      keys == ["sdp"]
    case "connectionState", "dataChannelState":
      keys == ["state"]
    case "serverEvent":
      keys == ["json"]
    case "audioActivity":
      keys == ["inputLevel", "outputLevel"]
    case "error":
      keys == ["code"]
    #if DEBUG
      case "probeResult":
        keys == ["peerConnection", "userMedia"]
          || keys == ["peerConnection", "userMedia", "error"]
    #endif
    default:
      false
    }
  }

  public static func allowsPopup() -> Bool { false }
}
