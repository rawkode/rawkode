// DeviceAccessCredentialStore.swift
// EnchiridionCore
//
// Plan §Live Backend Connectivity (P8), "Device auth" paragraph + §Native
// apps: "Auth: per-device Access service tokens in Keychain, provisioned
// via an explicit device enrollment flow ... In-app expiry warning +
// re-enrollment UX before a token goes dark." This is the Keychain-backed
// storage half of that — the credential this device uses on every request
// to `vault` (`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers, per
// `workers/vault/src/access-auth.ts` and `../../workers/vault/
// ACCESS_SETUP.md`), whether it was minted by `workers/vault/src/
// enroll-routes.ts` via the pairing flow (see DeviceEnrollmentPairing.swift)
// or bootstrapped manually via `wrangler`/the dashboard for this device's
// FIRST-ever credential (ACCESS_SETUP.md's step (a).3 — no already-enrolled
// device exists yet on a fresh deployment to pair from).
//
// PATTERN REUSE, NOT REINVENTION: this is a deliberate structural copy of
// `AssistantOpenAICredentialStore.swift` (P5, task #68) — the SAME
// `AssistantKeychainClient` protocol seam (so tests inject a fake instead
// of touching the real Keychain), the SAME `SecItemAdd`/
// `SecItemCopyMatching`/`SecItemUpdate`/`SecItemDelete` mapping, and the
// SAME per-platform accessibility choice
// (`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` on iOS,
// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` on macOS). See that
// file's header for why those specific attributes were chosen — not
// re-derived here. The one structural difference: this credential is
// MULTI-FIELD (client id, client secret, device name, minted/expiry
// timestamps — needed for the expiry-warning UX this same plan paragraph
// calls for), so the Keychain item's `kSecValueData` holds a JSON-encoded
// `DeviceAccessCredential`, not a bare UTF-8 string.

import Foundation
import Security

/// The full record this device's own Access service token — everything
/// `workers/vault/src/enroll-routes.ts`'s `/enroll/provision` response
/// returns, persisted so the expiry-warning UX (`DeviceCredentialExpiry`)
/// has something to compare "now" against without another network round
/// trip. `clientId`/`clientSecret` are exactly the
/// `CF-Access-Client-Id`/`CF-Access-Client-Secret` header pair every
/// request to vault sends (see `EnchiridionAPI/EmailSearchClient.swift`,
/// `EnchiridionSync/VaultSyncClient.swift`, `EnchiridionBlobs/
/// BlobCache.swift` for the existing call sites this credential feeds).
public struct DeviceAccessCredential: Codable, Equatable, Sendable {
  public var clientId: String
  public var clientSecret: String
  public var deviceName: String
  public var mintedAt: Date
  public var expiresAt: Date

  public init(clientId: String, clientSecret: String, deviceName: String, mintedAt: Date, expiresAt: Date) {
    self.clientId = clientId
    self.clientSecret = clientSecret
    self.deviceName = deviceName
    self.mintedAt = mintedAt
    self.expiresAt = expiresAt
  }
}

public enum DeviceAccessCredentialStoreError: Error, Equatable, Sendable {
  case passcodeRequired
  case unavailable
  case invalidStoredValue
}

enum DeviceAccessKeychainQuery {
  // Distinct service/account strings from `AssistantOpenAIKeychainQuery`
  // (openai.api-key) — these are two independent Keychain items, never
  // meant to collide or be confused with one another.
  static let service = "dev.rawkode.enchiridion2.vault.access-service-token"
  static let account = "device-credential-v1"

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

/// Keychain-backed storage for THIS device's own Access service-token
/// credential. One credential per device, matching
/// `AssistantOpenAICredentialStore`'s identical per-device storage posture
/// and the plan's "per-device Access service tokens in Keychain" pin.
///
/// Reuses `AssistantKeychainClient`/`AssistantSystemKeychainClient`
/// (defined in AssistantOpenAICredentialStore.swift) rather than declaring
/// a second, identical Keychain-client protocol — there is exactly one
/// Keychain access seam in this package, shared by every credential store
/// that needs one.
public actor DeviceAccessCredentialStore {
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

  /// Reads the stored device credential, or `nil` if this device has never
  /// been enrolled (or was reset). Throws only on a genuine Keychain-layer
  /// failure or corrupted stored data — never for "nothing stored yet."
  public func readCredential() throws -> DeviceAccessCredential? {
    var result: CFTypeRef?
    let status = client.copyMatching(DeviceAccessKeychainQuery.read() as CFDictionary, result: &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw map(status) }
    guard let data = result as? Data else { throw DeviceAccessCredentialStoreError.invalidStoredValue }
    do {
      return try Self.decoder.decode(DeviceAccessCredential.self, from: data)
    } catch {
      throw DeviceAccessCredentialStoreError.invalidStoredValue
    }
  }

  /// Stores `credential`, replacing any previously stored one — the
  /// expected call after a successful `/enroll/provision` round trip
  /// (DeviceEnrollmentPairing.swift) or a manual first-device bootstrap
  /// entry.
  public func save(credential: DeviceAccessCredential) throws {
    guard !credential.clientId.isEmpty, !credential.clientSecret.isEmpty else {
      throw DeviceAccessCredentialStoreError.invalidStoredValue
    }
    let data = try Self.encoder.encode(credential)
    let status = client.update(
      DeviceAccessKeychainQuery.match() as CFDictionary,
      attributes: DeviceAccessKeychainQuery.update(credentialData: data, platform: platform) as CFDictionary
    )
    switch status {
    case errSecSuccess:
      return
    case errSecItemNotFound:
      let addStatus = client.add(
        DeviceAccessKeychainQuery.add(credentialData: data, platform: platform) as CFDictionary)
      guard addStatus == errSecSuccess else { throw map(addStatus) }
    default:
      throw map(status)
    }
  }

  /// Removes any stored device credential. A no-op (not an error) if none
  /// is stored — used by re-enrollment (replace) and an explicit
  /// "de-authorize this device" action, should one ever be added.
  public func delete() throws {
    let status = client.delete(DeviceAccessKeychainQuery.match() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw map(status) }
  }

  private func map(_ status: OSStatus) -> DeviceAccessCredentialStoreError {
    if platform == .iOS && status == errSecAuthFailed { return .passcodeRequired }
    return .unavailable
  }

  private static let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return encoder
  }()

  private static let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }()
}
