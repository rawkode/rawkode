import Foundation

/// A hand-mirrored Swift equivalent of `@athenaeum/domain`'s `DomainError` union
/// (`packages/domain/src/errors.ts`) and its `RpcErrorEnvelope` wire encoding
/// (`packages/domain/src/rpc-error.ts`'s `encodeRpcError`/`decodeRpcError`). This is a stand-in
/// for that decode logic until a future `AthenaeumDomain` Swift package exists to generate/mirror
/// it properly (see plan §"Repo/package layout": `native/AthenaeumDomain/` — out of this stage's
/// scope, which is only the RPC *transport* decision) — kept intentionally small (the exact tag
/// set `rpc-error.ts`'s `knownTags` declares today) rather than speculatively modeling errors no
/// current RPC method can actually throw.
public enum AthenaeumDomainError: Error, Sendable, Equatable {
    case nodeNotFound(nodeId: String)
    case validationError(message: String)
    case unexpectedError(message: String)
    case pageNotFound(nodeId: String)
    case tagNotFound(tagId: String)
    case factNotFound(factId: String)
    case edgeNotFound(edgeId: String)
    case relationDefinitionNotFound(relationDefinitionId: String)
    case graphIssueNotFound(graphIssueId: String)
    case cardinalityViolation(relationDefinitionId: String, message: String)
    case graphIssueDetected(relationDefinitionId: String, nodeId: String, conflictingEdgeIds: [String])
    /// Phase 3 (`AgentEditService`) error tags — see `packages/domain/src/errors.ts`'s
    /// "Phase 3 agent-editing errors" section for the full rationale of each.
    case chatNotFound(chatId: String)
    case chatBindingNotFound(chatId: String, name: String)
    case pendingNameConflict(name: String, claimedByChatId: String)
    case toolNotImplemented(toolName: String, message: String)
    /// Phase 4 (`auth.ts`/`dev-auth.ts`): "no valid caller identity is available... a missing,
    /// malformed, tampered, or expired Bearer credential." See `errors.ts`'s own doc comment.
    case unauthorized(message: String)
    /// Phase 4 (`sharing.ts`/docs/sharing.md §Authorization model): the referenced workspace does not
    /// exist (or was deleted) — never raised for a workspace that exists but is merely unreachable by
    /// this caller (see `.workspaceAccessDenied`).
    case workspaceNotFound(workspaceId: String)
    /// Phase 4: the workspace exists, but the caller has no effective role in its permission graph —
    /// distinct from `.unauthorized` (no verified identity at all). See `errors.ts`'s own doc
    /// comment for the exact distinction docs/sharing.md draws between the two.
    case workspaceAccessDenied(workspaceId: String)
    /// Phase 5 (`gatekeeper-rpc.ts`): a method requiring an active `GatekeeperBinding` (e.g.
    /// `syncGoogleCalendar`, `listCalendarEvents`, `disconnectGoogleCalendar`) was called against a
    /// workspace/kind with none connected.
    case gatekeeperNotConnected(workspaceId: String, gatekeeperKind: String)
    /// Phase 5: the OAuth authorization-code exchange (`googleCalendarOAuthCallback`) failed.
    case oauthExchangeFailed(message: String)
    /// Phase 5: a gatekeeper's observer-verification check denied an observer.
    case observerVerificationFailed(observerId: String, message: String)
    /// The RPC boundary rejected with a `["error", name, message]` whose `message` wasn't
    /// parseable as one of `@athenaeum/domain`'s `RpcErrorEnvelope`s — either a capnweb/framework-
    /// level throw unrelated to a domain `Data.TaggedError`, or an envelope tag this client's
    /// intentionally-narrow mirror doesn't (yet) know about. Carries the raw `name`/`message` so
    /// callers can still log/display something useful rather than losing the failure entirely.
    case unrecognizedRemoteError(name: String, message: String)

    /// Decodes a capnweb `["error", name, message]` rejection into a typed `AthenaeumDomainError`,
    /// mirroring `@athenaeum/domain`'s `decodeRpcError`: `message` is expected to itself be a
    /// JSON-encoded `RpcErrorEnvelope` (`{tag, message, data}`) — see `rpc-boundary.ts`'s
    /// `throwRpcError` for where the backend produces that shape. A `message` that isn't valid
    /// JSON, or whose `tag` isn't one of the known cases, decodes to `.unrecognizedRemoteError`
    /// rather than throwing — matching `decodeRpcError`'s own fail-closed intent (surface *some*
    /// typed value, never silently misdecode) without requiring this client to model Effect's
    /// `ParseError` type for what is, on this side, just a best-effort fallback.
    public static func decode(name: String, message: String) -> AthenaeumDomainError {
        guard
            let data = message.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let tag = json["tag"] as? String,
            let data0 = json["data"] as? [String: Any]
        else {
            return .unrecognizedRemoteError(name: name, message: message)
        }
        let envelopeMessage = json["message"] as? String ?? message

        func str(_ key: String) -> String { (data0[key] as? String) ?? "" }
        func strArray(_ key: String) -> [String] {
            (data0[key] as? [Any])?.compactMap { $0 as? String } ?? []
        }

        switch tag {
        case "NodeNotFound": return .nodeNotFound(nodeId: str("nodeId"))
        case "ValidationError": return .validationError(message: envelopeMessage)
        case "UnexpectedError": return .unexpectedError(message: envelopeMessage)
        case "PageNotFound": return .pageNotFound(nodeId: str("nodeId"))
        case "TagNotFound": return .tagNotFound(tagId: str("tagId"))
        case "FactNotFound": return .factNotFound(factId: str("factId"))
        case "EdgeNotFound": return .edgeNotFound(edgeId: str("edgeId"))
        case "RelationDefinitionNotFound":
            return .relationDefinitionNotFound(relationDefinitionId: str("relationDefinitionId"))
        case "GraphIssueNotFound": return .graphIssueNotFound(graphIssueId: str("graphIssueId"))
        case "CardinalityViolation":
            return .cardinalityViolation(relationDefinitionId: str("relationDefinitionId"), message: str("message"))
        case "GraphIssueDetected":
            return .graphIssueDetected(
                relationDefinitionId: str("relationDefinitionId"),
                nodeId: str("nodeId"),
                conflictingEdgeIds: strArray("conflictingEdgeIds")
            )
        case "ChatNotFound": return .chatNotFound(chatId: str("chatId"))
        case "ChatBindingNotFound": return .chatBindingNotFound(chatId: str("chatId"), name: str("name"))
        case "PendingNameConflict":
            return .pendingNameConflict(name: str("name"), claimedByChatId: str("claimedByChatId"))
        case "ToolNotImplemented": return .toolNotImplemented(toolName: str("toolName"), message: envelopeMessage)
        case "Unauthorized": return .unauthorized(message: envelopeMessage)
        case "WorkspaceNotFound": return .workspaceNotFound(workspaceId: str("workspaceId"))
        case "WorkspaceAccessDenied": return .workspaceAccessDenied(workspaceId: str("workspaceId"))
        case "GatekeeperNotConnected":
            return .gatekeeperNotConnected(workspaceId: str("workspaceId"), gatekeeperKind: str("gatekeeperKind"))
        case "OAuthExchangeFailed": return .oauthExchangeFailed(message: envelopeMessage)
        case "ObserverVerificationFailed":
            return .observerVerificationFailed(observerId: str("observerId"), message: envelopeMessage)
        default:
            return .unrecognizedRemoteError(name: name, message: message)
        }
    }
}

extension CapnWebError {
    /// Converts a `.remoteError` into the typed `AthenaeumDomainError` mirror above; any other
    /// `CapnWebError` case (a transport/protocol-level failure, not an RPC-level rejection) is
    /// returned unchanged, since it has no `DomainError` equivalent to decode into.
    public func asDomainError() -> Error {
        if case let .remoteError(name, message) = self {
            return AthenaeumDomainError.decode(name: name, message: message)
        }
        return self
    }
}
