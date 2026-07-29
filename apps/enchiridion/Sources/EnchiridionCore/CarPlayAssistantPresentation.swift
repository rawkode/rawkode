import Foundation

/// The five CarPlay voice states allowed by `CPVoiceControlTemplate`.
///
/// Keeping the copy and symbols outside the CarPlay view controller makes the
/// driver's interaction contract testable without a connected vehicle.
public enum CarPlayAssistantPhase: String, CaseIterable, Equatable, Sendable {
  case ready
  case starting
  case listening
  case responding
  case setup

  public var titleVariants: [String] {
    switch self {
    case .ready:
      [
        "Ask Enchiridion. Tap Start to begin.",
        "Ask Enchiridion",
      ]
    case .starting:
      ["Starting conversation", "Starting"]
    case .listening:
      ["Listening now. Speak your request.", "Listening"]
    case .responding:
      ["Preparing or speaking your private answer", "Answering"]
    case .setup:
      ["Finish voice setup in Enchiridion on iPhone", "Finish setup on iPhone"]
    }
  }

  public var systemImageName: String {
    switch self {
    case .ready: "mic.circle"
    case .starting: "ellipsis.circle"
    case .listening: "waveform"
    case .responding: "bubble.left.and.text.bubble.right.fill"
    case .setup: "iphone.badge.exclamationmark"
    }
  }

  public var actionTitle: String {
    switch self {
    case .ready: "Start"
    case .starting, .listening, .responding: "Stop"
    case .setup: ""
    }
  }
}
