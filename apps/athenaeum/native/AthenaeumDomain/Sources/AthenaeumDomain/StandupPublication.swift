import Foundation

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

    public init(id: EntityId, civilDate: String, microEmployeeLabel: String, jobLabel: String, workflowLabel: String, scheduleLabel: String, microEmployee: StandupPublicationReference, job: StandupPublicationReference, workflow: StandupPublicationReference, schedule: StandupPublicationReference, councilRefs: [StandupPublicationReference], originalText: String, publishedAt: IsoDateTimeString, childNodeId: EntityId, companionStatus: StandupPublicationCompanionStatus, resultKind: StandupPublicationResultKind? = nil) {
        precondition(!civilDate.isEmpty && !microEmployeeLabel.isEmpty && !jobLabel.isEmpty && !workflowLabel.isEmpty && !scheduleLabel.isEmpty && !originalText.isEmpty, "StandupPublication required text fields must be nonempty")
        self.id = id; self.civilDate = civilDate; self.microEmployeeLabel = microEmployeeLabel; self.jobLabel = jobLabel; self.workflowLabel = workflowLabel; self.scheduleLabel = scheduleLabel
        self.microEmployee = microEmployee; self.job = job; self.workflow = workflow; self.schedule = schedule; self.councilRefs = councilRefs; self.originalText = originalText; self.publishedAt = publishedAt; self.childNodeId = childNodeId; self.companionStatus = companionStatus; self.resultKind = resultKind
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
