import Foundation

private struct StandupAnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// Workspace-readable companion state. This is intentionally not a verification receipt.
public enum StandupPublicationCompanionStatus: String, Codable, Hashable, Sendable {
    case verifiedOriginal = "verified-original"
    case modified
    case missing
    case unavailable
}

/// The optional, workspace-readable outcome of the work represented by a publication.
///
/// This is intentionally closed: decoding a value added by a newer server fails the
/// projection instead of silently assigning it a misleading meaning.
public enum StandupPublicationResultKind: String, Codable, Hashable, Sendable {
    case completed
    case blocked
    case failed
    case skipped
}

/// A closed, privacy-safe summary of the second-brain mutations made by one workforce run.
/// Identifiers and authority material deliberately stay on the server; this projection carries
/// only operation labels, authored rationale, and an optional current title for orientation.
public enum StandupRecordedWorkOperation: String, Codable, Hashable, Sendable {
    case createdNode
    case recordedFact
    case assignedSupertag
    case updatedSupertag
    case createdDocument
    case updatedDocument
    case preparedMeeting
}

public struct StandupRecordedWorkTarget: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Hashable, Sendable {
        case note
        case supertag
    }

    public let kind: Kind
    public let label: String

    private enum CodingKeys: String, CodingKey { case kind, label }

    public init(kind: Kind, label: String) throws {
        guard Self.isBounded(label, scalars: 200, bytes: 800) else { throw StandupRecordedWorkError.malformed }
        self.kind = kind
        self.label = label
    }

    public init(from decoder: Decoder) throws {
        let rawContainer = try decoder.container(keyedBy: StandupAnyCodingKey.self)
        guard Set(rawContainer.allKeys.map(\.stringValue)) == Set(["kind", "label"]) else { throw StandupRecordedWorkError.malformed }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard
              let rawKind = try container.decodeIfPresent(String.self, forKey: .kind),
              let kind = Kind(rawValue: rawKind),
              let label = try container.decodeIfPresent(String.self, forKey: .label),
              Self.isBounded(label, scalars: 200, bytes: 800) else { throw StandupRecordedWorkError.malformed }
        self.kind = kind
        self.label = label
    }

    public func encode(to encoder: Encoder) throws {
        guard Self.isBounded(label, scalars: 200, bytes: 800) else { throw StandupRecordedWorkError.malformed }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind.rawValue, forKey: .kind)
        try container.encode(label, forKey: .label)
    }

    fileprivate static func isBounded(_ value: String, scalars: Int, bytes: Int) -> Bool {
        !value.isEmpty && value.unicodeScalars.count <= scalars && (value.data(using: .utf8)?.count ?? .max) <= bytes
    }
}

public struct StandupRecordedWorkItem: Codable, Hashable, Sendable {
    public let operation: StandupRecordedWorkOperation
    public let commitMessage: String
    public let target: StandupRecordedWorkTarget?

    private enum CodingKeys: String, CodingKey { case operation, commitMessage, target }

    public init(operation: StandupRecordedWorkOperation, commitMessage: String, target: StandupRecordedWorkTarget? = nil) throws {
        guard StandupRecordedWorkTarget.isBounded(commitMessage, scalars: 500, bytes: 2_000) else { throw StandupRecordedWorkError.malformed }
        self.operation = operation
        self.commitMessage = commitMessage
        self.target = target
    }

    public init(from decoder: Decoder) throws {
        let rawContainer = try decoder.container(keyedBy: StandupAnyCodingKey.self)
        guard Set(rawContainer.allKeys.map(\.stringValue)).isSubset(of: Set(["operation", "commitMessage", "target"])),
              Set(rawContainer.allKeys.map(\.stringValue)).contains("operation"),
              Set(rawContainer.allKeys.map(\.stringValue)).contains("commitMessage") else { throw StandupRecordedWorkError.malformed }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard
              let rawOperation = try container.decodeIfPresent(String.self, forKey: .operation),
              let operation = StandupRecordedWorkOperation(rawValue: rawOperation),
              let commitMessage = try container.decodeIfPresent(String.self, forKey: .commitMessage),
              StandupRecordedWorkTarget.isBounded(commitMessage, scalars: 500, bytes: 2_000) else { throw StandupRecordedWorkError.malformed }
        self.operation = operation
        self.commitMessage = commitMessage
        self.target = try container.decodeIfPresent(StandupRecordedWorkTarget.self, forKey: .target)
    }

    public func encode(to encoder: Encoder) throws {
        guard StandupRecordedWorkTarget.isBounded(commitMessage, scalars: 500, bytes: 2_000) else { throw StandupRecordedWorkError.malformed }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(operation.rawValue, forKey: .operation)
        try container.encode(commitMessage, forKey: .commitMessage)
        try container.encodeIfPresent(target, forKey: .target)
    }
}

public enum StandupRecordedWorkError: Error, Hashable, Sendable {
    case malformed
}

/// `state` and `version` are decoded explicitly so a future server value cannot be silently
/// interpreted as a current receipt.
public enum StandupRecordedWork: Codable, Hashable, Sendable {
    public static let version = "athenaeum.standup-recorded-work.v1"
    case available(items: [StandupRecordedWorkItem], remainingCount: Int)
    case unavailable

    private enum CodingKeys: String, CodingKey { case version, state, items, remainingCount }

    public init(from decoder: Decoder) throws {
        let rawContainer = try decoder.container(keyedBy: StandupAnyCodingKey.self)
        let rawKeys = Set(rawContainer.allKeys.map(\.stringValue))
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard rawKeys.contains("version"), rawKeys.contains("state"),
              let version = try container.decodeIfPresent(String.self, forKey: .version), version == Self.version,
              let state = try container.decodeIfPresent(String.self, forKey: .state) else { throw StandupRecordedWorkError.malformed }
        switch state {
        case "unavailable":
            guard rawKeys == Set(["version", "state"]) else { throw StandupRecordedWorkError.malformed }
            self = .unavailable
        case "available":
            guard rawKeys == Set(["version", "state", "items", "remainingCount"]),
                  let items = try container.decodeIfPresent([StandupRecordedWorkItem].self, forKey: .items),
                  let remainingCount = try container.decodeIfPresent(Int.self, forKey: .remainingCount),
                  items.count <= 8, (0...9_999).contains(remainingCount) else { throw StandupRecordedWorkError.malformed }
            self = .available(items: items, remainingCount: remainingCount)
        default:
            throw StandupRecordedWorkError.malformed
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.version, forKey: .version)
        switch self {
        case .unavailable:
            try container.encode("unavailable", forKey: .state)
        case .available(let items, let remainingCount):
            guard items.count <= 8, (0...9_999).contains(remainingCount) else { throw StandupRecordedWorkError.malformed }
            try container.encode("available", forKey: .state)
            try container.encode(items, forKey: .items)
            try container.encode(remainingCount, forKey: .remainingCount)
        }
    }
}

/// A version-qualified workforce definition reference safe for the standup read projection.
public struct StandupPublicationReference: Codable, Hashable, Sendable {
    public let kind: String
    public let id: String
    public let version: String

    public init(kind: String, id: String, version: String) {
        precondition(!kind.isEmpty && !id.isEmpty && !version.isEmpty, "StandupPublicationReference fields must be nonempty")
        self.kind = kind
        self.id = id
        self.version = version
    }
}

/// The deliberately small, workspace-readable standup report projection. It contains no run
/// provenance, authority material, commands, receipts, policy state, or internal diagnostics.
public struct StandupPublication: Codable, Hashable, Sendable {
    public let id: EntityId
    public let civilDate: String
    public let microEmployeeLabel: String
    public let jobLabel: String
    public let workflowLabel: String
    public let scheduleLabel: String
    public let microEmployee: StandupPublicationReference
    public let job: StandupPublicationReference
    public let workflow: StandupPublicationReference
    public let schedule: StandupPublicationReference
    public let councilRefs: [StandupPublicationReference]
    public let originalText: String
    public let publishedAt: IsoDateTimeString
    public let childNodeId: EntityId
    public let companionStatus: StandupPublicationCompanionStatus
    public let resultKind: StandupPublicationResultKind?
    public let recordedWork: StandupRecordedWork?

    public init(id: EntityId, civilDate: String, microEmployeeLabel: String, jobLabel: String, workflowLabel: String, scheduleLabel: String, microEmployee: StandupPublicationReference, job: StandupPublicationReference, workflow: StandupPublicationReference, schedule: StandupPublicationReference, councilRefs: [StandupPublicationReference], originalText: String, publishedAt: IsoDateTimeString, childNodeId: EntityId, companionStatus: StandupPublicationCompanionStatus, resultKind: StandupPublicationResultKind? = nil, recordedWork: StandupRecordedWork? = nil) {
        precondition(!civilDate.isEmpty && !microEmployeeLabel.isEmpty && !jobLabel.isEmpty && !workflowLabel.isEmpty && !scheduleLabel.isEmpty && !originalText.isEmpty, "StandupPublication required text fields must be nonempty")
        self.id = id; self.civilDate = civilDate; self.microEmployeeLabel = microEmployeeLabel; self.jobLabel = jobLabel; self.workflowLabel = workflowLabel; self.scheduleLabel = scheduleLabel
        self.microEmployee = microEmployee; self.job = job; self.workflow = workflow; self.schedule = schedule; self.councilRefs = councilRefs; self.originalText = originalText; self.publishedAt = publishedAt; self.childNodeId = childNodeId; self.companionStatus = companionStatus; self.resultKind = resultKind; self.recordedWork = recordedWork
    }
}

public struct ListStandupPublicationsInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let dailyNoteId: EntityId
    public init(workspaceId: EntityId, dailyNoteId: EntityId) { self.workspaceId = workspaceId; self.dailyNoteId = dailyNoteId }
}

public struct ListStandupPublicationsOutput: Codable, Hashable, Sendable {
    public let publications: [StandupPublication]
    public init(publications: [StandupPublication]) { self.publications = publications }
}
