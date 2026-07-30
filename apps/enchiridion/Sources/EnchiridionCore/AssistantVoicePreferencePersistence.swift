import Foundation

public struct AssistantVoicePreferencePayload: Codable, Equatable, Sendable {
  public static let currentVersion = 1

  public enum Mode: String, Codable, Sendable {
    case automatic
    case specific
  }

  public var version: Int
  public var mode: Mode
  public var identifier: String?

  public init(
    version: Int = currentVersion,
    preference: AssistantVoicePreference
  ) {
    self.version = version
    switch preference {
    case .automatic:
      mode = .automatic
      identifier = nil
    case .specific(let identifier):
      mode = .specific
      self.identifier = identifier
    }
  }

  public var preference: AssistantVoicePreference? {
    guard version == Self.currentVersion else { return nil }
    switch mode {
    case .automatic:
      return .automatic
    case .specific:
      guard let identifier, !identifier.isEmpty else { return nil }
      return .specific(identifier: identifier)
    }
  }
}

@MainActor
public final class AssistantVoicePreferenceDefaultsStore {
  public static let defaultKey = "assistant.voice.preference.payload"

  private let defaults: UserDefaults
  private let key: String
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(
    defaults: UserDefaults = .standard,
    key: String = defaultKey
  ) {
    self.defaults = defaults
    self.key = key
  }

  public func load() -> AssistantVoicePreference {
    guard
      let data = defaults.data(forKey: key),
      let payload = try? decoder.decode(AssistantVoicePreferencePayload.self, from: data),
      let preference = payload.preference
    else {
      return .automatic
    }
    return preference
  }

  public func save(_ preference: AssistantVoicePreference) {
    let payload = AssistantVoicePreferencePayload(preference: preference)
    guard let data = try? encoder.encode(payload) else { return }
    defaults.set(data, forKey: key)
  }
}
