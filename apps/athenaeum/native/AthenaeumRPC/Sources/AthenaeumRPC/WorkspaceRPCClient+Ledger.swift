import AthenaeumDomain
import Foundation

/// The native standup mirrors the public ledger projection rather than the private command
/// tables. Request ids, fingerprints, payloads, and policy details never cross this boundary.
public enum LedgerActivityRPCError: Error, Sendable, Equatable, LocalizedError {
    case malformedResponse

    public var errorDescription: String? {
        "Unable to load the daily standup. Please try again."
    }
}

public enum RPCLedgerActivityType: String, Sendable, Equatable {
    case createNode
    case createNodeWithIntent
    case acceptChatFork
    case acceptPageProposal
    case agentChangeDecision
    case applySupertag
    case addFact
    case createEdge
    case createRelationDefinition
    case createBookmark
    case linkCalendarEventToNode
    case appendTranscriptSegment
    case startMeeting
    case prepareMeetingInDailyNote
    case migrateLegacyPage
    case createTag
    case defineTagField
    case assignTag
    case unassignTag
    case syncNoteReferences
    case commitLoroPageContent
    case ensureLoroPage

    public var displayName: String {
        switch self {
        case .createNode: return "Created a node"
        case .createNodeWithIntent: return "Created a node with provenance"
        case .acceptChatFork: return "Accepted a note edit"
        case .acceptPageProposal: return "Accepted a page proposal"
        case .agentChangeDecision: return "Decided an agent change"
        case .applySupertag: return "Applied a structured tag"
        case .addFact: return "Updated a workspace fact"
        case .createEdge: return "Created a relationship"
        case .createRelationDefinition: return "Created a relationship definition"
        case .createBookmark: return "Captured a bookmark"
        case .linkCalendarEventToNode: return "Linked a calendar event to a workspace node"
        case .appendTranscriptSegment: return "Captured a transcript segment"
        case .startMeeting: return "Started a meeting"
        case .prepareMeetingInDailyNote: return "Prepared a meeting in the daily note"
        case .migrateLegacyPage: return "Migrated a legacy note"
        case .createTag: return "Created a Supertag definition"
        case .defineTagField: return "Added a field to a Supertag definition"
        case .assignTag: return "Requested a Supertag membership"
        case .unassignTag: return "Requested removal of a Supertag membership"
        case .syncNoteReferences: return "Reconciled note mentions"
        case .commitLoroPageContent: return "Updated a note"
        case .ensureLoroPage: return "Prepared a note"
        }
    }

    public var systemImage: String {
        switch self {
        case .createNode: return "plus.circle"
        case .createNodeWithIntent: return "checkmark.seal"
        case .acceptChatFork: return "arrow.triangle.merge"
        case .acceptPageProposal: return "doc.badge.gearshape"
        case .agentChangeDecision: return "checkmark.seal"
        case .applySupertag: return "tag"
        case .addFact: return "list.bullet.rectangle"
        case .createEdge: return "link"
        case .createRelationDefinition: return "link.badge.plus"
        case .createBookmark: return "bookmark"
        case .linkCalendarEventToNode: return "calendar.badge.plus"
        case .appendTranscriptSegment: return "waveform"
        case .startMeeting: return "video"
        case .prepareMeetingInDailyNote: return "calendar.badge.clock"
        case .migrateLegacyPage: return "arrow.triangle.2.circlepath.doc.on.clipboard"
        case .createTag: return "tag"
        case .defineTagField: return "list.bullet.rectangle"
        case .assignTag: return "tag"
        case .unassignTag: return "tag.slash"
        case .syncNoteReferences: return "link"
        case .commitLoroPageContent: return "pencil"
        case .ensureLoroPage: return "doc.badge.plus"
        }
    }
}

public enum RPCLedgerActivityActor: String, Sendable, Equatable {
    case you
    case workspaceMember = "workspace-member"
    case anonymous

    public var displayName: String {
        switch self {
        case .you: return "You"
        case .workspaceMember: return "Workspace member"
        case .anonymous: return "Anonymous"
        }
    }
}

public struct RPCLedgerActivityActorDetail: Sendable, Equatable {
    public enum Kind: String, Sendable, Equatable { case user, employee, system }
    public let kind: Kind
    public let label: String

    public init(kind: Kind, label: String) {
        precondition(!label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        self.kind = kind
        self.label = label
    }

    init?(value: CapnWebValue) {
        guard let object = try? value.field("kind"),
              let kindValue = object.stringValue,
              let kind = Kind(rawValue: kindValue),
              let labelValue = try? value.field("label"),
              let label = labelValue.stringValue,
              !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        self.kind = kind
        self.label = label
    }
}

public struct RPCLedgerActivityTarget: Sendable, Equatable {
    public let kind: String
    public let id: EntityId

    init?(value: CapnWebValue) {
        guard let kindValue = (try? value.field("kind"))?.stringValue,
              kindValue == "node",
              let idValue = (try? value.field("id"))?.stringValue,
              let id = try? EntityId(validating: idValue) else { return nil }
        self.kind = kindValue
        self.id = id
    }
}

public struct RPCLedgerActivityEntry: Sendable, Equatable {
    public let occurredAt: IsoDateTimeString
    public let type: RPCLedgerActivityType
    public let actor: RPCLedgerActivityActor
    public let actorDetail: RPCLedgerActivityActorDetail?
    public let message: String
    public let target: RPCLedgerActivityTarget?

    public init(
        occurredAt: IsoDateTimeString,
        type: RPCLedgerActivityType,
        actor: RPCLedgerActivityActor,
        message: String,
        actorDetail: RPCLedgerActivityActorDetail? = nil,
        target: RPCLedgerActivityTarget? = nil
    ) {
        precondition(!message.isEmpty, "Ledger activity messages must be nonempty")
        self.occurredAt = occurredAt
        self.type = type
        self.actor = actor
        self.message = message
        self.actorDetail = actorDetail
        self.target = target
    }

    init(_ value: CapnWebValue) throws {
        do {
            guard let occurredAt = try value.field("occurredAt").stringValue,
                  let typeValue = try value.field("type").stringValue,
                  let type = RPCLedgerActivityType(rawValue: typeValue),
                  let actorValue = try value.field("actor").stringValue,
                  let actor = RPCLedgerActivityActor(rawValue: actorValue),
                  let message = try value.field("message").stringValue,
                  !message.isEmpty else {
                throw LedgerActivityRPCError.malformedResponse
            }
            // Optional forward-compatible fields are deliberately best-effort. A malformed
            // detail or target must not erase an otherwise valid legacy activity row.
            let actorDetail = RPCLedgerActivityActorDetail(value: (try? value.field("actorDetail")) ?? .null)
            let target = RPCLedgerActivityTarget(value: (try? value.field("target")) ?? .null)
            self.init(
                occurredAt: try IsoDateTimeString(validating: occurredAt),
                type: type,
                actor: actor,
                message: message,
                actorDetail: actorDetail,
                target: target
            )
        } catch {
            throw LedgerActivityRPCError.malformedResponse
        }
    }
}

extension WorkspaceRPCClient {
    /// Fetches the privacy-safe activity projection used by the daily standup subdocument. When
    /// supplied, `from`/`to` bound the result to the half-open `[from, to)` instant window; omitting
    /// both retains the compatibility latest-N feed used by non-standup callers.
    public func listRecentLedgerActivity(
        limit: Int = 8,
        from: String? = nil,
        to: String? = nil
    ) async throws -> [RPCLedgerActivityEntry] {
        guard limit > 0 else { throw LedgerActivityRPCError.malformedResponse }
        do {
            var args: [String: CapnWebValue] = ["limit": .int(limit)]
            args["from"] = from.map(CapnWebValue.string) ?? .undefined
            args["to"] = to.map(CapnWebValue.string) ?? .undefined
            let result = try await rpc("listRecentLedgerActivity", args)
            guard let entries = try result.field("entries").arrayValue else {
                throw LedgerActivityRPCError.malformedResponse
            }
            return try entries.map(RPCLedgerActivityEntry.init)
        } catch is LedgerActivityRPCError {
            throw LedgerActivityRPCError.malformedResponse
        } catch {
            throw error
        }
    }
}
