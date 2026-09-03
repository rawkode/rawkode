import Foundation

/// The replication protocol selected for a page document. This is intentionally a closed
/// vocabulary: callers must never attempt to decode one CRDT's bytes as another's protocol.
public enum PageDocumentFormat: String, Codable, Hashable, Sendable {
    case automergeV1 = "automerge-v1"
    case loroV1 = "loro-v1"
}

public struct AutomergePageDocumentDescriptor: Codable, Hashable, Sendable {
    public let docId: String
    public let headsHash: String
    public let bytesSha256: String

    public init(docId: String, headsHash: String, bytesSha256: String) {
        self.docId = docId
        self.headsHash = headsHash
        self.bytesSha256 = bytesSha256
    }
}

public struct LoroPageDocumentDescriptor: Codable, Hashable, Sendable {
    public let schemaVersion: Int
    public let snapshotSha256: String

    public init(schemaVersion: Int, snapshotSha256: String) {
        self.schemaVersion = schemaVersion
        self.snapshotSha256 = snapshotSha256
    }
}

/// Exact native mirror of the strict TypeScript descriptor union. This is deliberately not an
/// optional-field bag: missing and present are semantically distinct for the Automerge witness.
public enum PageDocumentDescriptor: Codable, Hashable, Sendable {
    case legacy(nodeId: EntityId, storageVersion: Int, automerge: AutomergePageDocumentDescriptor)
    case migratedLoro(nodeId: EntityId, storageVersion: Int, automerge: AutomergePageDocumentDescriptor, loro: LoroPageDocumentDescriptor)
    case nativeLoro(nodeId: EntityId, storageVersion: Int, loro: LoroPageDocumentDescriptor)

    fileprivate enum CodingKeys: String, CodingKey {
        case nodeId, storageVersion, activeFormat, automerge, loro
    }

    public var nodeId: EntityId {
        switch self {
        case .legacy(let nodeId, _, _), .migratedLoro(let nodeId, _, _, _), .nativeLoro(let nodeId, _, _): return nodeId
        }
    }

    public var storageVersion: Int {
        switch self {
        case .legacy(_, let value, _), .migratedLoro(_, let value, _, _), .nativeLoro(_, let value, _): return value
        }
    }

    public var activeFormat: PageDocumentFormat {
        switch self { case .legacy: return .automergeV1; case .migratedLoro, .nativeLoro: return .loroV1 }
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let nodeId = try values.decode(EntityId.self, forKey: .nodeId)
        let storageVersion = try values.decode(Int.self, forKey: .storageVersion)
        guard storageVersion > 0 else { throw descriptorError(.storageVersion, "must be positive") }
        let format = try values.decode(PageDocumentFormat.self, forKey: .activeFormat)

        switch format {
        case .automergeV1:
            guard !values.contains(.loro) else { throw descriptorError(.loro, "is forbidden for automerge-v1") }
            let automerge = try values.decode(AutomergePageDocumentDescriptor.self, forKey: .automerge)
            try validate(automerge)
            self = .legacy(nodeId: nodeId, storageVersion: storageVersion, automerge: automerge)
        case .loroV1:
            let loro = try values.decode(LoroPageDocumentDescriptor.self, forKey: .loro)
            try validate(loro)
            if values.contains(.automerge) {
                let automerge = try values.decode(AutomergePageDocumentDescriptor.self, forKey: .automerge)
                try validate(automerge)
                self = .migratedLoro(nodeId: nodeId, storageVersion: storageVersion, automerge: automerge, loro: loro)
            } else {
                self = .nativeLoro(nodeId: nodeId, storageVersion: storageVersion, loro: loro)
            }
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(nodeId, forKey: .nodeId)
        try values.encode(storageVersion, forKey: .storageVersion)
        try values.encode(activeFormat, forKey: .activeFormat)
        switch self {
        case .legacy(_, _, let automerge):
            try values.encode(automerge, forKey: .automerge)
        case .migratedLoro(_, _, let automerge, let loro):
            try values.encode(automerge, forKey: .automerge)
            try values.encode(loro, forKey: .loro)
        case .nativeLoro(_, _, let loro):
            try values.encode(loro, forKey: .loro)
        }
    }
}

private func descriptorError(_ key: PageDocumentDescriptor.CodingKeys, _ message: String) -> DecodingError {
    .dataCorrupted(.init(codingPath: [key], debugDescription: "PageDocumentDescriptor \(key.stringValue) \(message)"))
}

private func validate(_ descriptor: AutomergePageDocumentDescriptor) throws {
    guard !descriptor.docId.isEmpty else { throw descriptorError(.automerge, "docId must not be empty") }
    guard !descriptor.headsHash.isEmpty else { throw descriptorError(.automerge, "headsHash must not be empty") }
    guard !descriptor.bytesSha256.isEmpty else { throw descriptorError(.automerge, "bytesSha256 must not be empty") }
}

private func validate(_ descriptor: LoroPageDocumentDescriptor) throws {
    guard descriptor.schemaVersion > 0 else { throw descriptorError(.loro, "schemaVersion must be positive") }
    guard !descriptor.snapshotSha256.isEmpty else { throw descriptorError(.loro, "snapshotSha256 must not be empty") }
}
