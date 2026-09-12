import Foundation
import Security

struct PairingStore {
    private let service = "dev.rawkode.multipass"
    private let account = "peer-secret-v1"

    func load() throws -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data, data.count == 32 else {
            throw PairingError.keychain(status)
        }
        return data
    }

    func save(_ secret: Data) throws {
        guard secret.count == 32 else { throw PairingError.invalidCode }
        let attributes = [kSecValueData as String: secret] as [String: Any]
        var status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var query = baseQuery
            query[kSecValueData as String] = secret
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(query as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PairingError.keychain(status) }
    }

    func generate() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw PairingError.keychain(status) }
        return Data(bytes)
    }

    func parse(_ code: String) throws -> Data {
        guard let data = Data(base64Encoded: code.trimmingCharacters(in: .whitespacesAndNewlines)),
              data.count == 32 else { throw PairingError.invalidCode }
        return data
    }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
}

enum PairingError: LocalizedError {
    case keychain(OSStatus)
    case invalidCode
    var errorDescription: String? {
        switch self {
        case .keychain(let status): return "Keychain: \(SecCopyErrorMessageString(status, nil) as String? ?? String(status))"
        case .invalidCode: return "Paste the complete pairing code created on the other Mac."
        }
    }
}
