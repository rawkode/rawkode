import CryptoKit
import Foundation
import Loro

enum VersionVectorIdentityError: Error, Equatable {
    case negativeCounter
}

/// The backend's receipt witness is an identity over decoded Loro semantics, not the opaque
/// VersionVector wire encoding. Keep this Core-only so RPC remains independent of Loro.
enum VersionVectorIdentity {
    static func digest(encodedVersionVector: Data) throws -> String {
        let vector = try VersionVector.decode(bytes: encodedVersionVector)
        let entries = try vector.toHashmap().map { entry in
            guard let counter = Int32(exactly: entry.value) else {
                throw VersionVectorIdentityError.negativeCounter
            }
            return (peer: entry.key, counter: counter)
        }
        return try digest(entries: entries)
    }

    static func canonicalPreimageBytes(entries: [(peer: UInt64, counter: Int32)]) throws -> Data {
        let sorted = try entries.sorted { $0.peer < $1.peer }.map { entry -> String in
            guard entry.counter >= 0 else { throw VersionVectorIdentityError.negativeCounter }
            return "{\"counter\":" + String(entry.counter, radix: 10) + ",\"peer\":\"" + String(entry.peer, radix: 10) + "\"}"
        }
        return Data(("[" + sorted.joined(separator: ",") + "]").utf8)
    }

    static func digest(entries: [(peer: UInt64, counter: Int32)]) throws -> String {
        let preimage = try canonicalPreimageBytes(entries: entries)
        return SHA256.hash(data: preimage).map { String(format: "%02x", $0) }.joined()
    }
}
