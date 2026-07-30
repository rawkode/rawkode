import CryptoKit
import Foundation
import Security

public enum OpenAICredentialPlatform: Equatable, Sendable {
  case iOS
  case macOS

  public static var current: OpenAICredentialPlatform {
    #if os(iOS)
      .iOS
    #else
      .macOS
    #endif
  }

  fileprivate var accessibility: CFString {
    switch self {
    case .iOS: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
    case .macOS: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    }
  }
}

public enum OpenAICredentialStoreError: Error, Equatable, Sendable {
  case passcodeRequired
  case unavailable
  case invalidStoredValue
}

public enum OpenAICredentialMutationOutcome: Equatable, Sendable {
  case inserted(binding: OpenAICredentialBinding)
  case replaced(binding: OpenAICredentialBinding)
  case deleted
  case superseded
}

public struct OpenAICredentialBinding: Codable, Equatable, Sendable {
  public let revision: String
  public let fingerprint: String

  public init(revision: String, fingerprint: String) {
    self.revision = revision
    self.fingerprint = fingerprint
  }
}

public enum OpenAICredentialReadOutcome: Equatable, Sendable {
  case available(binding: OpenAICredentialBinding)
  case missing
  case invalid
  case superseded
}

struct OpenAIKeychainCredentialPayload: Codable, Equatable, Sendable {
  static let currentVersion = 1

  let version: Int
  let credential: String
  let revision: String

  init(
    version: Int = currentVersion,
    credential: String,
    revision: String
  ) {
    self.version = version
    self.credential = credential
    self.revision = revision
  }
}

enum OpenAIKeychainQuery {
  static let service = "dev.rawkode.enchiridion.openai.api-key"
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

  static func add(credentialData: Data, platform: OpenAICredentialPlatform) -> [String: Any] {
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

  static func contains() -> [String: Any] {
    var query = match()
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    return query
  }

  static func update(credentialData: Data, platform: OpenAICredentialPlatform) -> [String: Any] {
    [
      kSecValueData as String: credentialData,
      kSecAttrAccessible as String: platform.accessibility,
    ]
  }
}

protocol KeychainClient: Sendable {
  func add(_ attributes: CFDictionary) -> OSStatus
  func copyMatching(_ query: CFDictionary, result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
  func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus
  func delete(_ query: CFDictionary) -> OSStatus
}

struct SystemKeychainClient: KeychainClient {
  func add(_ attributes: CFDictionary) -> OSStatus {
    SecItemAdd(attributes, nil)
  }

  func copyMatching(
    _ query: CFDictionary,
    result: UnsafeMutablePointer<CFTypeRef?>?
  ) -> OSStatus {
    SecItemCopyMatching(query, result)
  }

  func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus {
    SecItemUpdate(query, attributes)
  }

  func delete(_ query: CFDictionary) -> OSStatus {
    SecItemDelete(query)
  }
}

public actor OpenAICredentialStore {
  private let client: any KeychainClient
  private let platform: OpenAICredentialPlatform
  private let revisionGenerator: @Sendable () -> String
  private var latestAuthorityGeneration: UInt64 = 0

  public init(platform: OpenAICredentialPlatform = .current) {
    client = SystemKeychainClient()
    self.platform = platform
    revisionGenerator = { UUID().uuidString.lowercased() }
  }

  init(
    client: any KeychainClient,
    platform: OpenAICredentialPlatform,
    revisionGenerator: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
  ) {
    self.client = client
    self.platform = platform
    self.revisionGenerator = revisionGenerator
  }

  public func readBinding(generation: UInt64) throws -> OpenAICredentialReadOutcome {
    guard generation > latestAuthorityGeneration else { return .superseded }
    latestAuthorityGeneration = generation

    var result: CFTypeRef?
    let status = client.copyMatching(
      OpenAIKeychainQuery.read() as CFDictionary,
      result: &result
    )
    if status == errSecItemNotFound { return .missing }
    guard status == errSecSuccess else { throw map(status) }
    guard
      let data = result as? Data,
      let payload = try? JSONDecoder().decode(OpenAIKeychainCredentialPayload.self, from: data),
      payload.version == OpenAIKeychainCredentialPayload.currentVersion,
      !payload.credential.isEmpty,
      !payload.revision.isEmpty
    else {
      return .invalid
    }
    return .available(binding: binding(for: payload))
  }

  public func replace(
    with credential: String,
    generation: UInt64
  ) throws -> OpenAICredentialMutationOutcome {
    guard generation > latestAuthorityGeneration else { return .superseded }
    latestAuthorityGeneration = generation
    let payload = OpenAIKeychainCredentialPayload(
      credential: credential,
      revision: revisionGenerator()
    )
    guard let data = try? JSONEncoder().encode(payload) else {
      throw OpenAICredentialStoreError.invalidStoredValue
    }
    let binding = binding(for: payload)
    let status = client.update(
      OpenAIKeychainQuery.match() as CFDictionary,
      attributes: OpenAIKeychainQuery.update(
        credentialData: data,
        platform: platform
      ) as CFDictionary
    )

    switch status {
    case errSecSuccess:
      return .replaced(binding: binding)
    case errSecItemNotFound:
      let addStatus = client.add(
        OpenAIKeychainQuery.add(credentialData: data, platform: platform) as CFDictionary
      )
      guard addStatus == errSecSuccess else { throw map(addStatus) }
      return .inserted(binding: binding)
    default:
      throw map(status)
    }
  }

  public func deleteCredential(
    generation: UInt64
  ) throws -> OpenAICredentialMutationOutcome {
    guard generation > latestAuthorityGeneration else { return .superseded }
    latestAuthorityGeneration = generation
    let status = client.delete(OpenAIKeychainQuery.match() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw map(status)
    }
    return .deleted
  }

  private func binding(for payload: OpenAIKeychainCredentialPayload) -> OpenAICredentialBinding {
    OpenAICredentialBinding(
      revision: payload.revision,
      fingerprint: SHA256.hash(data: Data(payload.credential.utf8))
        .map { String(format: "%02x", $0) }
        .joined()
    )
  }

  private func map(_ status: OSStatus) -> OpenAICredentialStoreError {
    if platform == .iOS && status == errSecAuthFailed { return .passcodeRequired }
    return .unavailable
  }
}
