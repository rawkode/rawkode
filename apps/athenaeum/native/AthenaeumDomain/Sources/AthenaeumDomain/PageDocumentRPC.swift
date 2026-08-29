import CryptoKit
import Foundation

public struct GetPageDocumentDescriptorInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public init(workspaceId: EntityId, nodeId: EntityId) { self.workspaceId = workspaceId; self.nodeId = nodeId }
}
public struct GetPageDocumentDescriptorOutput: Codable, Hashable, Sendable {
    public let descriptor: PageDocumentDescriptor
    public init(descriptor: PageDocumentDescriptor) { self.descriptor = descriptor }
}

/// A server-owned compatibility projection for an Automerge-era page. The server only releases
/// text when it can prove that the old document is losslessly representable as a plain string.
/// Rich or oversized legacy documents deliberately carry no raw text to native clients.
public struct GetLegacyPageProjectionInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public init(workspaceId: EntityId, nodeId: EntityId) { self.workspaceId = workspaceId; self.nodeId = nodeId }
}

public enum LegacyPageProjectionContent: Hashable, Sendable {
    case plainText(String)
    case richTextUnsupported
    case tooLarge

    public static let maximumPlainTextUTF8Bytes = 1024 * 1024

    public var plainText: String? {
        guard case .plainText(let text) = self else { return nil }
        return text
    }
}

extension LegacyPageProjectionContent: Codable {
    private enum CodingKeys: String, CodingKey { case kind, text }
    private enum Kind: String, Codable { case plainText, richTextUnsupported, tooLarge }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try values.decode(Kind.self, forKey: .kind)
        switch kind {
        case .plainText:
            let text = try values.decode(String.self, forKey: .text)
            guard text.utf8.count <= Self.maximumPlainTextUTF8Bytes else {
                throw DecodingError.dataCorruptedError(
                    forKey: .text,
                    in: values,
                    debugDescription: "legacy projection plain text exceeds 1 MiB UTF-8"
                )
            }
            self = .plainText(text)
        case .richTextUnsupported:
            guard !values.contains(.text) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .text,
                    in: values,
                    debugDescription: "richTextUnsupported projections must not include raw text"
                )
            }
            self = .richTextUnsupported
        case .tooLarge:
            guard !values.contains(.text) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .text,
                    in: values,
                    debugDescription: "tooLarge projections must not include raw text"
                )
            }
            self = .tooLarge
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .plainText(let text):
            guard text.utf8.count <= Self.maximumPlainTextUTF8Bytes else {
                throw LegacyPageProjectionWireError.plainTextTooLarge
            }
            try values.encode(Kind.plainText, forKey: .kind)
            try values.encode(text, forKey: .text)
        case .richTextUnsupported:
            try values.encode(Kind.richTextUnsupported, forKey: .kind)
        case .tooLarge:
            try values.encode(Kind.tooLarge, forKey: .kind)
        }
    }
}

public struct GetLegacyPageProjectionOutput: Codable, Hashable, Sendable {
    public let content: LegacyPageProjectionContent
    public let descriptor: PageDocumentDescriptor
    public let readOnly: Bool
    public let migrationRequired: Bool

    public init(content: LegacyPageProjectionContent, descriptor: PageDocumentDescriptor, readOnly: Bool, migrationRequired: Bool) throws {
        guard case .legacy = descriptor, readOnly, migrationRequired else {
            throw LegacyPageProjectionWireError.invalidProjection
        }
        self.content = content
        self.descriptor = descriptor
        self.readOnly = readOnly
        self.migrationRequired = migrationRequired
    }

    private enum CodingKeys: String, CodingKey {
        case content, descriptor, readOnly, migrationRequired
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(
                content: values.decode(LegacyPageProjectionContent.self, forKey: .content),
                descriptor: values.decode(PageDocumentDescriptor.self, forKey: .descriptor),
                readOnly: values.decode(Bool.self, forKey: .readOnly),
                migrationRequired: values.decode(Bool.self, forKey: .migrationRequired)
            )
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .descriptor,
                in: values,
                debugDescription: "legacy projection must be read-only automerge-v1"
            )
        }
    }
}

public enum LegacyPageProjectionWireError: Error, Equatable, Sendable {
    case invalidProjection
    case plainTextTooLarge
}
public struct CreateLoroPageInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let creationIntent: CreationIntent
    public init(workspaceId: EntityId, nodeId: EntityId, creationIntent: CreationIntent) { self.workspaceId = workspaceId; self.nodeId = nodeId; self.creationIntent = creationIntent }
}
public struct CreationIntent: Codable, Hashable, Sendable {
    public let requestId: String
    public let commitMessage: String
    public let attribution: MutationAttribution
    public init(requestId: String, commitMessage: String, attribution: MutationAttribution) {
        // Keep native serialization aligned with the TypeScript public wire decoder: request ids
        // are canonical after trimming whitespace/newlines, while an empty result is rejected by
        // the authoritative RPC schema.
        self.requestId = trimECMAScriptWhitespace(requestId)
        self.commitMessage = commitMessage; self.attribution = attribution
    }
}
public struct CreateLoroPageOutput: Codable, Hashable, Sendable {
    public let descriptor: PageDocumentDescriptor
    public init(descriptor: PageDocumentDescriptor) { self.descriptor = descriptor }
}

/// Exact caller evidence for the semantic Loro command. This value is evidence only: the server
/// derives principal and policy, and native callers must supply rather than synthesize it.
public enum LoroMutationAttributionV1: Codable, Hashable, Sendable {
    case humanUi(surface: String)
    case agentJob(jobId: String, runId: String)
    case system(source: String)
}

/// Integer values sent through Cap'n Web become JavaScript `Number`s. Keeping semantic Loro
/// witnesses in this closed range prevents a native `Int` from silently changing identity when
/// it crosses the JSON/JavaScript boundary.
public enum LoroWireSafeInteger {
    public static let maximum = 9_007_199_254_740_991

    public static func contains(_ value: Int) -> Bool {
        (1...maximum).contains(value)
    }

    /// Loro sync ordinals are zero-based, unlike storage-version witnesses.
    public static func containsOrdinal(_ value: Int) -> Bool {
        (0...maximum).contains(value)
    }
}

public struct LoroMutationIntentV1: Hashable, Sendable {
    public let requestId: String
    public let commitMessage: String
    public let attribution: LoroMutationAttributionV1

    public init(requestId: String, commitMessage: String, attribution: LoroMutationAttributionV1) throws {
        let request = try canonicalLoroString(requestId, maximum: 200)
        let message = try LoroCommitMessageV1(commitMessage).value
        let canonicalAttribution: LoroMutationAttributionV1
        switch attribution {
        case .humanUi(let surface):
            guard LoroMutationWire.humanSurfaces.contains(surface) else {
                throw LoroMutationWireError.invalidIntent
            }
            canonicalAttribution = .humanUi(surface: surface)
        case .agentJob(let jobId, let runId):
            canonicalAttribution = .agentJob(
                jobId: try canonicalLoroString(jobId, maximum: 200),
                runId: try canonicalLoroString(runId, maximum: 200)
            )
        case .system(let source):
            canonicalAttribution = .system(source: try canonicalLoroString(source, maximum: 200))
        }
        self.requestId = request
        self.commitMessage = message
        self.attribution = canonicalAttribution
    }
}

/// Canonical, user-facing Loro commit message. It follows JavaScript `trim` semantics and uses
/// UTF-16 units (the JavaScript string-length measure) for its 500-unit boundary.
public struct LoroCommitMessageV1: Hashable, Sendable {
    public let value: String

    public init(_ raw: String) throws {
        guard raw.utf16.count <= 756 else { throw LoroMutationWireError.invalidIntent }
        let canonical = trimECMAScriptWhitespace(raw)
        guard !canonical.isEmpty, canonical.utf16.count <= 500 else { throw LoroMutationWireError.invalidIntent }
        value = canonical
    }
}

private func canonicalLoroString(_ raw: String, maximum: Int) throws -> String {
    // Effect's `canonicalLoroString` accepts a bounded pre-normalized string, then applies
    // JavaScript trim and validates the canonical value. Swift's UTF-16 length is the matching
    // measure for JavaScript string length, whereas `String.count` counts grapheme clusters.
    guard raw.utf16.count <= maximum + 256 else {
        throw LoroMutationWireError.invalidIntent
    }
    let canonical = trimECMAScriptWhitespace(raw)
    guard !canonical.isEmpty, canonical.utf16.count <= maximum else {
        throw LoroMutationWireError.invalidIntent
    }
    return canonical
}

public struct CommitLoroPageContentInput: Hashable, Sendable {
    public let workspaceId: EntityId; public let nodeId: EntityId; public let intent: LoroMutationIntentV1
    public let expectedStorageVersion: Int; public let expectedSnapshotSHA256: String
    public let expectedVersionVector: Data; public let expectedVersionVectorIdentitySHA256: String; public let update: Data
    /// The semantic VV identity is a local receipt-binding witness. It deliberately is not part
    /// of the Cap'n Web request: the server derives the same identity from raw vector bytes.
    public init(workspaceId: EntityId, nodeId: EntityId, intent: LoroMutationIntentV1, expectedStorageVersion: Int, expectedSnapshotSHA256: String, expectedVersionVector: Data, expectedVersionVectorIdentitySHA256: String, update: Data) throws {
        guard LoroWireSafeInteger.contains(expectedStorageVersion), LoroMutationWire.isDigest(expectedSnapshotSHA256), LoroMutationWire.isDigest(expectedVersionVectorIdentitySHA256), !expectedVersionVector.isEmpty, expectedVersionVector.count <= 4096, !update.isEmpty, update.count <= 2 * 1024 * 1024 else { throw LoroMutationWireError.invalidCommitInput }
        self.workspaceId = workspaceId; self.nodeId = nodeId; self.intent = intent; self.expectedStorageVersion = expectedStorageVersion; self.expectedSnapshotSHA256 = expectedSnapshotSHA256; self.expectedVersionVector = expectedVersionVector; self.expectedVersionVectorIdentitySHA256 = expectedVersionVectorIdentitySHA256; self.update = update
    }
}

public struct CommitLoroPageContentOutput: Hashable, Sendable {
    public let descriptor: PageDocumentDescriptor; public let storageVersion: Int
    public let resultSnapshotSHA256: String; public let baseVersionVectorSHA256: String; public let resultVersionVectorSHA256: String; public let updateSHA256: String
    public init(descriptor: PageDocumentDescriptor, storageVersion: Int, resultSnapshotSHA256: String, baseVersionVectorSHA256: String, resultVersionVectorSHA256: String, updateSHA256: String) throws {
        guard LoroWireSafeInteger.contains(storageVersion), [resultSnapshotSHA256, baseVersionVectorSHA256, resultVersionVectorSHA256, updateSHA256].allSatisfy(LoroMutationWire.isDigest) else { throw LoroMutationWireError.invalidCommitOutput }
        self.descriptor = descriptor; self.storageVersion = storageVersion; self.resultSnapshotSHA256 = resultSnapshotSHA256; self.baseVersionVectorSHA256 = baseVersionVectorSHA256; self.resultVersionVectorSHA256 = resultVersionVectorSHA256; self.updateSHA256 = updateSHA256
    }
}

public enum LoroMutationWireError: Error, Equatable, Sendable {
    case invalidIntent
    case invalidCommitInput
    case invalidCommitOutput
    case invalidMigrationInput
    case workspaceMismatch
}
public enum LoroMutationWire {
    public static let humanSurfaces: Set<String> = ["rich-text-editor", "web-supertag-field-editor", "web-supertags-manager", "web-graph-view", "web-backlinks", "web-bookmarks", "ios-supertags", "macos", "watch-quick-capture"]
    public static func isDigest(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) } }

    /// Byte-for-byte SHA-256 witness compatible with the backend's `sha256HexSync(bytes)`.
    /// It deliberately digests `Data` directly; no string or lossy text conversion is involved.
    public static func sha256Hex(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}
/// Server-derived migration input. Native supplies only the complete immutable Automerge witness
/// and mutation intent; it can never upload a target Loro snapshot or select a target schema.
public struct MigrateLegacyPageInput: Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let expectedStorageVersion: Int
    public let expectedAutomerge: AutomergePageDocumentDescriptor
    public let intent: LoroMutationIntentV1

    public init(
        workspaceId: EntityId,
        nodeId: EntityId,
        expectedStorageVersion: Int,
        expectedAutomerge: AutomergePageDocumentDescriptor,
        intent: LoroMutationIntentV1
    ) throws {
        guard LoroWireSafeInteger.contains(expectedStorageVersion),
              !expectedAutomerge.docId.isEmpty,
              !expectedAutomerge.headsHash.isEmpty,
              !expectedAutomerge.bytesSha256.isEmpty
        else {
            throw LoroMutationWireError.invalidMigrationInput
        }
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.expectedStorageVersion = expectedStorageVersion
        self.expectedAutomerge = expectedAutomerge
        self.intent = intent
    }
}
public struct MigrateLegacyPageOutput: Codable, Hashable, Sendable {
    public let descriptor: PageDocumentDescriptor
    public init(descriptor: PageDocumentDescriptor) { self.descriptor = descriptor }
}
public struct StartLoroPageSyncInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let sessionId: String
    public init(workspaceId: EntityId, nodeId: EntityId, sessionId: String) { self.workspaceId = workspaceId; self.nodeId = nodeId; self.sessionId = sessionId }
}
public struct StartLoroPageSyncOutput: Codable, Hashable, Sendable {
    public let sessionId: String
    public let message: Data
    public let serverVersion: Data
    public init(sessionId: String, message: Data, serverVersion: Data) { self.sessionId = sessionId; self.message = message; self.serverVersion = serverVersion }
}
public struct LoroPageSyncMessageInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let sessionId: String
    public let ordinal: Int
    public let update: Data
    public let clientVersion: Data
    public init(workspaceId: EntityId, nodeId: EntityId, sessionId: String, ordinal: Int, update: Data, clientVersion: Data) { self.workspaceId = workspaceId; self.nodeId = nodeId; self.sessionId = sessionId; self.ordinal = ordinal; self.update = update; self.clientVersion = clientVersion }
}
public struct LoroPageSyncMessageOutput: Codable, Hashable, Sendable {
    public let sessionId: String
    public let ordinal: Int
    public let update: Data?
    public let serverVersion: Data
    public let converged: Bool
    public let reset: Bool
    public init(sessionId: String, ordinal: Int, update: Data?, serverVersion: Data, converged: Bool, reset: Bool) { self.sessionId = sessionId; self.ordinal = ordinal; self.update = update; self.serverVersion = serverVersion; self.converged = converged; self.reset = reset }
}
