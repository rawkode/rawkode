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
    case createTag
    case defineTagField
    case assignTag
    case unassignTag
    case syncNoteReferences

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
        case .createTag: return "Created a Supertag definition"
        case .defineTagField: return "Added a field to a Supertag definition"
        case .assignTag: return "Requested a Supertag membership"
        case .unassignTag: return "Requested removal of a Supertag membership"
        case .syncNoteReferences: return "Reconciled note mentions"
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
        case .createTag: return "tag"
        case .defineTagField: return "list.bullet.rectangle"
        case .assignTag: return "tag"
        case .unassignTag: return "tag.slash"
        case .syncNoteReferences: return "link"
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

public struct RPCLedgerActivityEntry: Sendable, Equatable {
    public let occurredAt: IsoDateTimeString
    public let type: RPCLedgerActivityType
    public let actor: RPCLedgerActivityActor
    public let message: String

    public init(
        occurredAt: IsoDateTimeString,
        type: RPCLedgerActivityType,
        actor: RPCLedgerActivityActor,
        message: String
    ) {
        precondition(!message.isEmpty, "Ledger activity messages must be nonempty")
        self.occurredAt = occurredAt
        self.type = type
        self.actor = actor
        self.message = message
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
            self.init(
                occurredAt: try IsoDateTimeString(validating: occurredAt),
                type: type,
                actor: actor,
                message: message
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
