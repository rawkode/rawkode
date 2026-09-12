import Foundation
import CryptoKit

/// Authenticated claims contain no secret. Network metadata and slot claims are not encrypted.
enum WireProtocol {
    static let version = 1
    static let maximumFrame = 4096

    struct Claim: Codable {
        let version: Int
        let challenge: String
        let senderID: UUID
        let slot: Int
    }
    struct SignedClaim: Codable {
        let claim: Claim
        let signature: Data
    }
    struct Challenge: Codable { let version: Int; let challenge: String }

    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }

    static func sign(senderID: UUID, slot: Int, challenge: String, secret: Data) throws -> Data {
        let claim = Claim(version: version, challenge: challenge, senderID: senderID, slot: slot)
        let signature = Data(HMAC<SHA256>.authenticationCode(for: try encode(claim), using: SymmetricKey(data: secret)))
        return try encode(SignedClaim(claim: claim, signature: signature))
    }

    /// A verifier belongs to exactly one connection; even failed attempts consume it.
    struct Verifier {
        let challenge: String
        private var consumed = false
        init(challenge: String) { self.challenge = challenge }

        mutating func verify(_ data: Data, secret: Data) -> Claim? {
            guard !consumed else { return nil }
            consumed = true
            guard secret.count == 32, data.count <= maximumFrame,
                  let signed = try? JSONDecoder().decode(SignedClaim.self, from: data),
                  signed.claim.version == version,
                  signed.claim.challenge == challenge,
                  (1...3).contains(signed.claim.slot),
                  let canonical = try? encode(signed.claim),
                  HMAC<SHA256>.isValidAuthenticationCode(signed.signature, authenticating: canonical, using: SymmetricKey(data: secret))
            else { return nil }
            return signed.claim
        }
    }
}
