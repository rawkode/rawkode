import Foundation

enum CarPlayAssistantPrivacySettings {
  static let isEnabledKey = "carPlayAssistantEnabled"

  static func isEnabled(in defaults: UserDefaults = .standard) -> Bool {
    guard defaults.object(forKey: isEnabledKey) != nil else { return true }
    return defaults.bool(forKey: isEnabledKey)
  }
}
