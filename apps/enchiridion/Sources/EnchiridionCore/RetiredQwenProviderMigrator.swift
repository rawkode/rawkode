import Foundation
import Security

/// Removes the retired Qwen provider's credential and its three non-secret
/// selections. It is deliberately independent of provider settings so it can
/// run before those types disappear. Failure is retryable: the completion
/// marker is written only after both stores have been purged.
public protocol RetiredProviderKeychainPurging: Sendable {
  func purge(service: String, account: String) throws
}

public struct SystemRetiredProviderKeychainPurger: RetiredProviderKeychainPurging {
  public init() {}

  public func purge(service: String, account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false,
      kSecUseDataProtectionKeychain as String: true,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw RetiredProviderMigrationError.keychainUnavailable
    }
  }
}

public enum RetiredProviderMigrationError: Error, Equatable, Sendable {
  case keychainUnavailable
}

@MainActor
public final class RetiredQwenProviderMigrator {
  public static let keychainService = "dev.rawkode.enchiridion.qwen.api-key"
  public static let keychainAccount = "realtime-byok-v1"
  public static let defaultsKeys = [
    "assistant.provider.qwen.realtime.v1.workspace",
    "assistant.provider.qwen.realtime.v1.model",
    "assistant.provider.qwen.realtime.v1.voice",
  ]
  public static let completionKey = "assistant.provider.retired-qwen-purge.v1"

  private let defaults: UserDefaults
  private let purger: any RetiredProviderKeychainPurging
  private var isRunning = false

  public init(
    defaults: UserDefaults = .standard,
    purger: any RetiredProviderKeychainPurging = SystemRetiredProviderKeychainPurger()
  ) {
    self.defaults = defaults
    self.purger = purger
  }

  /// Returns `true` only when this call completed the purge. Concurrent/early
  /// callers are coalesced; a failed keychain deletion leaves the migration
  /// unmarked for a foreground retry.
  @discardableResult
  public func migrateIfNeeded() -> Bool {
    guard !defaults.bool(forKey: Self.completionKey), !isRunning else { return false }
    isRunning = true
    defer { isRunning = false }
    do {
      try purger.purge(service: Self.keychainService, account: Self.keychainAccount)
      for key in Self.defaultsKeys { defaults.removeObject(forKey: key) }
      defaults.set(true, forKey: Self.completionKey)
      return true
    } catch {
      return false
    }
  }
}
