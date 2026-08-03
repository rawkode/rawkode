import Foundation
import Observation

@MainActor
@Observable
public final class QwenProviderSettingsController {
  public private(set) var workspaceID: String?
  public private(set) var model: QwenRealtimeModel
  public private(set) var voice: QwenRealtimeVoice
  public private(set) var credentialBinding: QwenCredentialBinding?
  public private(set) var isValidating = false
  public private(set) var error: QwenWorkspaceValidationError?

  private let defaults: UserDefaults
  private let key: String
  private let credentialStore: QwenCredentialStore
  private let validator: any QwenWorkspaceValidating

  public init(
    defaults: UserDefaults = .standard,
    key: String = "assistant.provider.qwen.realtime.v1",
    credentialStore: QwenCredentialStore = QwenCredentialStore(),
    validator: any QwenWorkspaceValidating = QwenWorkspaceValidator()
  ) {
    self.defaults = defaults; self.key = key; self.credentialStore = credentialStore; self.validator = validator
    workspaceID = defaults.string(forKey: "\(key).workspace").flatMap(QwenWorkspace.canonicalID)
    model = defaults.string(forKey: "\(key).model").flatMap(QwenRealtimeModel.init(rawValue:)) ?? .flash
    voice = defaults.string(forKey: "\(key).voice").flatMap(QwenRealtimeVoice.init(rawValue:)) ?? .longanqian
  }

  public var isConfigured: Bool { credentialBinding != nil && workspaceID != nil }

  public func refresh() async {
    do { credentialBinding = try await credentialStore.binding() }
    catch { credentialBinding = nil; self.error = .unavailable }
  }

  /// Saving a token after the canonical workspace handshake is the one, durable
  /// user opt-in to Qwen and Beijing processing. There is no second consent.
  @discardableResult public func verifyAndSave(token: String, workspaceID: String) async -> Bool {
    let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let workspaceID = QwenWorkspace.canonicalID(workspaceID), !token.isEmpty else { error = .invalidWorkspace; return false }
    isValidating = true; error = nil
    do {
      try await validator.validate(token: token, workspaceID: workspaceID, model: model)
      let binding = try await credentialStore.replace(token)
      self.workspaceID = workspaceID; credentialBinding = binding
      defaults.set(workspaceID, forKey: "\(key).workspace"); defaults.set(model.rawValue, forKey: "\(key).model"); defaults.set(voice.rawValue, forKey: "\(key).voice")
      isValidating = false; return true
    } catch let error as QwenWorkspaceValidationError { self.error = error }
    catch { self.error = .unavailable }
    isValidating = false; return false
  }

  public func select(model: QwenRealtimeModel) {
    self.model = model; defaults.set(model.rawValue, forKey: "\(key).model")
  }
  public func select(voice: QwenRealtimeVoice) {
    self.voice = voice; defaults.set(voice.rawValue, forKey: "\(key).voice")
  }
  @discardableResult public func deleteToken() async -> Bool {
    do { try await credentialStore.delete(); credentialBinding = nil; workspaceID = nil; defaults.removeObject(forKey: "\(key).workspace"); return true }
    catch { self.error = .unavailable; return false }
  }
  public func voiceRouteSnapshot() -> QwenVoiceRouteSnapshot {
    QwenVoiceRouteSnapshot(workspaceID: workspaceID, model: model, voice: voice, credentialBinding: credentialBinding)
  }
}
