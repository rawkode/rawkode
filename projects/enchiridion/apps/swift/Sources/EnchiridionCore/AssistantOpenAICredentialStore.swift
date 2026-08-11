// AssistantOpenAICredentialStore.swift
// EnchiridionCore
//
// Task #68. Keychain-backed storage for the user's OpenAI API key — ported
// PATTERN (not the full mechanism) from the old app's
// `apps/enchiridion/Sources/EnchiridionCore/OpenAICredentialStore.swift`:
// the same `KeychainClient` protocol (so tests inject a fake instead of
// touching the real Keychain), the same `SystemKeychainClient` ->
// `SecItemAdd`/`SecItemCopyMatching`/`SecItemUpdate`/`SecItemDelete`
// mapping, and the same per-platform accessibility choice
// (`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` on iOS,
// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` on macOS — verified
// against that file directly, not re-derived).
//
// DELIBERATE SIMPLIFICATION FROM THE OLD APP: `OpenAICredentialStore` there
// also tracked a monotonic "authority generation" counter and a
// revision/fingerprint `OpenAICredentialBinding`, so a settings UI could
// revalidate a saved key against OpenAI's API without ever reading the
// secret itself back out of this module, and so a runtime inference call
// could assert "the key I'm about to use is still the exact one the UI
// most recently verified," rejecting a stale one. That whole mechanism
// exists to serve the old app's `AssistantProviderSettingsController.swift`
// (revalidation flows, concurrent-settings-screen races) — none of which
// task #68 is building (this task's minimal conversation UI has no
// provider-settings verification screen; see the task brief: "Keep this
// UI genuinely minimal"). Carrying that whole binding/generation apparatus
// here with no caller that actually exercises it would be dead
// complexity, not safety. What's kept is the part that IS still a real
// security property regardless of UI complexity: the secret is stored
// Keychain-only, with real device-only accessibility, and it is never
// returned through any type that could accidentally get logged/rendered —
// callers get an explicit `String?`/`throws`, not a debug-printable
// struct.
//
// If a future task adds a real settings/verification screen for this
// package's assistant, porting the old app's generation/binding scheme
// onto this store (rather than reinventing something looser) would be the
// right move — the pattern is proven, just not yet needed here.

import Foundation
import Security

public enum AssistantOpenAICredentialPlatform: Equatable, Sendable {
  case iOS
  case macOS

  public static var current: AssistantOpenAICredentialPlatform {
    #if os(iOS)
      .iOS
    #else
      .macOS
    #endif
  }

  // Widened from `fileprivate` to `internal` (task #95, device enrollment)
  // so `DeviceAccessCredentialStore.swift` — a second Keychain-backed
  // credential store that deliberately reuses this exact accessibility
  // mapping rather than redefining it — can read it too. No behavior
  // change: still invisible outside `EnchiridionCore`.
  var accessibility: CFString {
    switch self {
    case .iOS: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
    case .macOS: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    }
  }
}

public enum AssistantOpenAICredentialStoreError: Error, Equatable, Sendable {
  case passcodeRequired
  case unavailable
  case invalidStoredValue
}

enum AssistantOpenAIKeychainQuery {
  static let service = "dev.rawkode.enchiridion2.openai.api-key"
  static let account = "runtime-byok-v1"

  static func match() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false,
      kSecUseDataProtectionKeychain as String: true,
    ]
  }

  static func add(credentialData: Data, platform: AssistantOpenAICredentialPlatform) -> [String: Any] {
    var query = match()
    query[kSecAttrAccessible as String] = platform.accessibility
    query[kSecValueData as String] = credentialData
    return query
  }

  static func read() -> [String: Any] {
    var query = match()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    return query
  }

  static func update(credentialData: Data, platform: AssistantOpenAICredentialPlatform) -> [String: Any] {
    [kSecValueData as String: credentialData, kSecAttrAccessible as String: platform.accessibility]
  }
}

protocol AssistantKeychainClient: Sendable {
  func add(_ attributes: CFDictionary) -> OSStatus
  func copyMatching(_ query: CFDictionary, result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
  func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus
  func delete(_ query: CFDictionary) -> OSStatus
}

struct AssistantSystemKeychainClient: AssistantKeychainClient {
  func add(_ attributes: CFDictionary) -> OSStatus { SecItemAdd(attributes, nil) }

  func copyMatching(_ query: CFDictionary, result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    SecItemCopyMatching(query, result)
  }

  func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus {
    SecItemUpdate(query, attributes)
  }

  func delete(_ query: CFDictionary) -> OSStatus { SecItemDelete(query) }
}

/// Keychain-backed storage for the user's OpenAI API key. One credential
/// per device — matches the plan's "Native apps" per-device storage
/// posture, applied here to a provider key rather than an Access service
/// token.
public actor AssistantOpenAICredentialStore {
  private let client: any AssistantKeychainClient
  private let platform: AssistantOpenAICredentialPlatform

  public init(platform: AssistantOpenAICredentialPlatform = .current) {
    client = AssistantSystemKeychainClient()
    self.platform = platform
  }

  init(client: any AssistantKeychainClient, platform: AssistantOpenAICredentialPlatform) {
    self.client = client
    self.platform = platform
  }

  /// Reads the stored API key, or `nil` if none is stored. Throws only on
  /// a genuine Keychain-layer failure (locked device, corrupted item) —
  /// "no key stored yet" is `nil`, not an error.
  public func readAPIKey() throws -> String? {
    var result: CFTypeRef?
    let status = client.copyMatching(AssistantOpenAIKeychainQuery.read() as CFDictionary, result: &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw map(status) }
    guard let data = result as? Data, let value = String(data: data, encoding: .utf8), !value.isEmpty
    else { throw AssistantOpenAICredentialStoreError.invalidStoredValue }
    return value
  }

  /// Stores `apiKey`, replacing any previously stored value. A
  /// caller-supplied empty string is rejected up front — never stored — so
  /// `readAPIKey()` never has to distinguish "empty" from "absent."
  public func save(apiKey: String) throws {
    guard !apiKey.isEmpty else { throw AssistantOpenAICredentialStoreError.invalidStoredValue }
    let data = Data(apiKey.utf8)
    let status = client.update(
      AssistantOpenAIKeychainQuery.match() as CFDictionary,
      attributes: AssistantOpenAIKeychainQuery.update(credentialData: data, platform: platform) as CFDictionary
    )
    switch status {
    case errSecSuccess:
      return
    case errSecItemNotFound:
      let addStatus = client.add(
        AssistantOpenAIKeychainQuery.add(credentialData: data, platform: platform) as CFDictionary)
      guard addStatus == errSecSuccess else { throw map(addStatus) }
    default:
      throw map(status)
    }
  }

  /// Removes any stored API key. A no-op (not an error) if none is stored.
  public func delete() throws {
    let status = client.delete(AssistantOpenAIKeychainQuery.match() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw map(status) }
  }

  private func map(_ status: OSStatus) -> AssistantOpenAICredentialStoreError {
    if platform == .iOS && status == errSecAuthFailed { return .passcodeRequired }
    return .unavailable
  }
}
