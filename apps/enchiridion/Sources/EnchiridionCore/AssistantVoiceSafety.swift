import Foundation

public enum AssistantVoicePauseReason: Equatable, Sendable {
  case interruption
  case routeChanged
  case noSuitableRoute
  case mediaServicesRestarted
  case appInactive

  public var message: String {
    switch self {
    case .interruption:
      "Voice paused for another audio activity. Tap the microphone to continue."
    case .routeChanged:
      "Voice paused because your audio route changed. Tap the microphone to continue."
    case .noSuitableRoute:
      "No audio route is available. Connect an audio device, then try again."
    case .mediaServicesRestarted:
      "System audio restarted. Tap the microphone to continue."
    case .appInactive:
      "Voice paused while Enchiridion was inactive. Tap the microphone to continue."
    }
  }
}

/// Primitive audio port values keep AVFoundation and private route identifiers
/// out of Core and out of conversation state.
public enum AssistantAudioPort: String, Equatable, Hashable, Sendable {
  case builtInMic
  case builtInReceiver
  case builtInSpeaker
  case headphones
  case headsetMic
  case bluetoothA2DP
  case bluetoothHFP
  case bluetoothLE
  case usbAudio
  case airPlay
  case carAudio
  case hdmi
  case lineIn
  case lineOut
  case other
}

public struct AssistantAudioRouteSnapshot: Equatable, Sendable {
  public var inputs: [AssistantAudioPort]
  public var outputs: [AssistantAudioPort]

  public init(inputs: [AssistantAudioPort], outputs: [AssistantAudioPort]) {
    self.inputs = inputs
    self.outputs = outputs
  }

  public var hasRequiredVoiceIO: Bool {
    !inputs.isEmpty && !outputs.isEmpty
  }
}

public enum AssistantAudioRouteChangeReason: Int, Equatable, Sendable {
  case unknown = 0
  case newDeviceAvailable = 1
  case oldDeviceUnavailable = 2
  case categoryChange = 3
  case override = 4
  case wakeFromSleep = 6
  case noSuitableRoute = 7
  case routeConfigurationChange = 8
}

public enum AssistantVoiceSafetyEvent: Equatable, Sendable {
  case interruptionBegan
  case interruptionEnded(shouldResume: Bool)
  case routeChanged(
    reason: AssistantAudioRouteChangeReason,
    previous: AssistantAudioRouteSnapshot?,
    current: AssistantAudioRouteSnapshot
  )
  case mediaServicesLost
  case mediaServicesReset
  case appInactive
}

public protocol AssistantVoiceSafetyEventSource: Sendable {
  func events() -> AsyncStream<AssistantVoiceSafetyEvent>
}

/// Pure state behind the handheld AVAudioSession adapter. Media-service resets
/// discard both flags so a later explicit microphone start must configure and
/// activate the replacement system audio service again.
public struct AssistantAudioSessionLifecycleState: Equatable, Sendable {
  public private(set) var isConfigured = false
  public private(set) var isActive = false

  public init() {}

  public mutating func didConfigure() {
    isConfigured = true
  }

  public mutating func didActivate() {
    isActive = true
  }

  public mutating func didDeactivate() {
    isActive = false
  }

  public mutating func resetAfterMediaServicesReset() {
    isConfigured = false
    isActive = false
  }
}

public enum AssistantAudioRouteSafetyClassifier {
  public static func pauseReason(
    reason: AssistantAudioRouteChangeReason,
    previous: AssistantAudioRouteSnapshot?,
    current: AssistantAudioRouteSnapshot
  ) -> AssistantVoicePauseReason? {
    guard current.hasRequiredVoiceIO, reason != .noSuitableRoute else {
      return .noSuitableRoute
    }

    if reason == .oldDeviceUnavailable {
      return .routeChanged
    }

    if let previous,
      previous.outputs.contains(where: isPrivateOrExternalOutput),
      current.outputs.allSatisfy(isBuiltInPublicOutput)
    {
      return .routeChanged
    }

    if let previous, !previous.outputs.isEmpty,
      previous.outputs.allSatisfy(isBuiltInPublicOutput),
      current.outputs.contains(where: isPrivateOrExternalOutput)
    {
      return nil
    }

    if previous?.outputs.contains(.bluetoothA2DP) == true,
      current.outputs.contains(.bluetoothHFP)
    {
      return nil
    }

    switch reason {
    case .newDeviceAvailable, .categoryChange, .override, .wakeFromSleep:
      return nil
    case .routeConfigurationChange, .unknown:
      return .routeChanged
    case .oldDeviceUnavailable, .noSuitableRoute:
      return nil
    }
  }

  private static func isBuiltInPublicOutput(_ port: AssistantAudioPort) -> Bool {
    port == .builtInReceiver || port == .builtInSpeaker
  }

  private static func isPrivateOrExternalOutput(_ port: AssistantAudioPort) -> Bool {
    !isBuiltInPublicOutput(port)
  }
}

/// Pure mapping used by the iOS notification adapter. AVFoundation raw values
/// are converted at the boundary and never enter the session.
public enum AssistantVoiceSafetyNotificationParser {
  public static func interruption(rawType: UInt, rawOptions: UInt = 0) -> AssistantVoiceSafetyEvent? {
    switch rawType {
    case 1: .interruptionBegan
    case 0: .interruptionEnded(shouldResume: rawOptions & 1 == 1)
    default: nil
    }
  }

  public static func routeChange(
    rawReason: UInt,
    previous: AssistantAudioRouteSnapshot?,
    current: AssistantAudioRouteSnapshot
  ) -> AssistantVoiceSafetyEvent? {
    guard let reason = AssistantAudioRouteChangeReason(rawValue: Int(rawReason)) else {
      return .routeChanged(reason: .unknown, previous: previous, current: current)
    }
    return .routeChanged(reason: reason, previous: previous, current: current)
  }
}
