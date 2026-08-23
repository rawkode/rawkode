import Foundation

// Mirrors `packages/domain/src/errors.ts`'s `DomainError` union and
// `packages/domain/src/rpc-error.ts`'s `RpcErrorEnvelope` + `encodeRpcError`/`decodeRpcError` —
// risk #3's mitigation (plan §"Top risks": "a {tag, message, data} thrown-error envelope
// convention to preserve typed-error info across the Cap'n Web throw boundary"). This is the
// domain-owned, transport-agnostic half of that convention; `AthenaeumRPC`'s own
// `AthenaeumDomainError.swift` (built in the earlier Decisions stage, before this package
// existed) is a narrower, RPC-transport-local stand-in for the same idea — see this package's
// top-level doc comment / the native README for the note that a future stage should have
// `AthenaeumRPC` depend on this package's `DomainError` instead of maintaining its own copy,
// which is out of this stage's scope (only asked to build `AthenaeumDomain` itself, not touch
// `AthenaeumRPC`).

/// Mirrors `errors.ts`'s `DomainError` union — the full closed set of `Data.TaggedError` tags
/// this package's RPC error envelope can carry. Modeled as a Swift enum with associated values
/// (one case per TS class), rather than separate structs conforming to a common protocol, since
/// every use site (both `encode`/`decode` below) needs to exhaustively switch over the closed set
/// — the same discipline `RelationCardinality`/`GraphIssueKind`/`SyncOperation` already follow in
/// this package. Widened by the `AgentEditService` stage with the four Phase 3 agent-editing
/// error tags (`chatNotFound`/`chatBindingNotFound`/`pendingNameConflict`/`toolNotImplemented`),
/// matching `errors.ts`'s own widening. Widened again by the Phase 5 native stage with the three
/// gatekeeper error tags (`gatekeeperNotConnected`/`oauthExchangeFailed`/
/// `observerVerificationFailed`), matching `errors.ts`'s own "New Data.TaggedErrors" widening.
public enum DomainError: Error, Hashable, Sendable {
    case nodeNotFound(nodeId: String)
    case validationError(message: String, cause: String?)
    case unexpectedError(message: String)
    case pageNotFound(nodeId: String)
    case tagNotFound(tagId: String)
    case factNotFound(factId: String)
    case edgeNotFound(edgeId: String)
    case relationDefinitionNotFound(relationDefinitionId: String)
    case graphIssueNotFound(graphIssueId: String)
    case cardinalityViolation(relationDefinitionId: String, message: String)
    case graphIssueDetected(relationDefinitionId: String, nodeId: String, conflictingEdgeIds: [String])
    case chatNotFound(chatId: String)
    case chatBindingNotFound(chatId: String, name: String)
    case pendingNameConflict(name: String, claimedByChatId: String)
    case toolNotImplemented(toolName: String, message: String)
    case gatekeeperNotConnected(workspaceId: String, gatekeeperKind: String)
    case oauthExchangeFailed(message: String)
    case observerVerificationFailed(observerId: String, message: String)
}

/// Mirrors `rpc-error.ts`'s `knownTags` — the closed set of tags `RpcErrorEnvelope.tag` accepts.
public enum DomainErrorTag: String, Codable, Hashable, Sendable {
    case nodeNotFound = "NodeNotFound"
    case validationError = "ValidationError"
    case unexpectedError = "UnexpectedError"
    case pageNotFound = "PageNotFound"
    case tagNotFound = "TagNotFound"
    case factNotFound = "FactNotFound"
    case edgeNotFound = "EdgeNotFound"
    case relationDefinitionNotFound = "RelationDefinitionNotFound"
    case graphIssueNotFound = "GraphIssueNotFound"
    case cardinalityViolation = "CardinalityViolation"
    case graphIssueDetected = "GraphIssueDetected"
    case chatNotFound = "ChatNotFound"
    case chatBindingNotFound = "ChatBindingNotFound"
    case pendingNameConflict = "PendingNameConflict"
    case toolNotImplemented = "ToolNotImplemented"
    case gatekeeperNotConnected = "GatekeeperNotConnected"
    case oauthExchangeFailed = "OAuthExchangeFailed"
    case observerVerificationFailed = "ObserverVerificationFailed"
}

/// Mirrors `rpc-error.ts`'s `RpcErrorEnvelope` — the JSON-safe shape a `DomainError` is flattened
/// to before crossing the RPC throw boundary. `data` is a JSON object of arbitrary shape (mirrors
/// `Schema.Record({key: Schema.String, value: Schema.Unknown})`), modeled as `[String: JSONValue]`
/// for the same reasons as `SyncFeedEntry.payload`/`RunViewOutput.rows`.
public struct RpcErrorEnvelope: Codable, Hashable, Sendable {
    public let tag: DomainErrorTag
    public let message: String
    public let data: [String: JSONValue]

    public init(tag: DomainErrorTag, message: String, data: [String: JSONValue]) {
        self.tag = tag
        self.message = message
        self.data = data
    }
}

private func jsonString(_ value: JSONValue?) -> String {
    if case .string(let s) = value { return s }
    return ""
}

private func jsonStringArray(_ value: JSONValue?) -> [String] {
    guard case .array(let items) = value else { return [] }
    return items.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
}

/// Mirrors `rpc-error.ts`'s `encodeRpcError` — flatten a `DomainError` into the wire envelope.
/// Pure, no I/O, no throwing (same contract as the TS function).
public func encodeRpcError(_ error: DomainError) -> RpcErrorEnvelope {
    switch error {
    case .nodeNotFound(let nodeId):
        return RpcErrorEnvelope(
            tag: .nodeNotFound,
            message: "Node not found: \(nodeId)",
            data: ["nodeId": .string(nodeId)]
        )
    case .validationError(let message, let cause):
        return RpcErrorEnvelope(
            tag: .validationError,
            message: message,
            data: cause.map { ["cause": .string($0)] } ?? [:]
        )
    case .unexpectedError(let message):
        return RpcErrorEnvelope(tag: .unexpectedError, message: message, data: [:])
    case .pageNotFound(let nodeId):
        return RpcErrorEnvelope(
            tag: .pageNotFound,
            message: "Page not found: \(nodeId)",
            data: ["nodeId": .string(nodeId)]
        )
    case .tagNotFound(let tagId):
        return RpcErrorEnvelope(
            tag: .tagNotFound,
            message: "Tag not found: \(tagId)",
            data: ["tagId": .string(tagId)]
        )
    case .factNotFound(let factId):
        return RpcErrorEnvelope(
            tag: .factNotFound,
            message: "Fact not found: \(factId)",
            data: ["factId": .string(factId)]
        )
    case .edgeNotFound(let edgeId):
        return RpcErrorEnvelope(
            tag: .edgeNotFound,
            message: "Edge not found: \(edgeId)",
            data: ["edgeId": .string(edgeId)]
        )
    case .relationDefinitionNotFound(let relationDefinitionId):
        return RpcErrorEnvelope(
            tag: .relationDefinitionNotFound,
            message: "RelationDefinition not found: \(relationDefinitionId)",
            data: ["relationDefinitionId": .string(relationDefinitionId)]
        )
    case .graphIssueNotFound(let graphIssueId):
        return RpcErrorEnvelope(
            tag: .graphIssueNotFound,
            message: "GraphIssue not found: \(graphIssueId)",
            data: ["graphIssueId": .string(graphIssueId)]
        )
    case .cardinalityViolation(let relationDefinitionId, let message):
        return RpcErrorEnvelope(
            tag: .cardinalityViolation,
            message: message,
            data: ["relationDefinitionId": .string(relationDefinitionId), "message": .string(message)]
        )
    case .graphIssueDetected(let relationDefinitionId, let nodeId, let conflictingEdgeIds):
        return RpcErrorEnvelope(
            tag: .graphIssueDetected,
            message: "Concurrent max-one-cardinality edge conflict on relationDefinition "
                + "\(relationDefinitionId) for node \(nodeId)",
            data: [
                "relationDefinitionId": .string(relationDefinitionId),
                "nodeId": .string(nodeId),
                "conflictingEdgeIds": .array(conflictingEdgeIds.map(JSONValue.string))
            ]
        )
    case .chatNotFound(let chatId):
        return RpcErrorEnvelope(
            tag: .chatNotFound,
            message: "Chat not found: \(chatId)",
            data: ["chatId": .string(chatId)]
        )
    case .chatBindingNotFound(let chatId, let name):
        return RpcErrorEnvelope(
            tag: .chatBindingNotFound,
            message: "No binding named \"\(name)\" in chat \(chatId)",
            data: ["chatId": .string(chatId), "name": .string(name)]
        )
    case .pendingNameConflict(let name, let claimedByChatId):
        return RpcErrorEnvelope(
            tag: .pendingNameConflict,
            message: "Name \"\(name)\" is pending in another chat (\(claimedByChatId))",
            data: ["name": .string(name), "claimedByChatId": .string(claimedByChatId)]
        )
    case .toolNotImplemented(let toolName, let message):
        return RpcErrorEnvelope(
            tag: .toolNotImplemented,
            message: message,
            data: ["toolName": .string(toolName), "message": .string(message)]
        )
    case .gatekeeperNotConnected(let workspaceId, let gatekeeperKind):
        return RpcErrorEnvelope(
            tag: .gatekeeperNotConnected,
            message: "No \(gatekeeperKind) gatekeeper connected for workspace \(workspaceId)",
            data: ["workspaceId": .string(workspaceId), "gatekeeperKind": .string(gatekeeperKind)]
        )
    case .oauthExchangeFailed(let message):
        return RpcErrorEnvelope(tag: .oauthExchangeFailed, message: message, data: [:])
    case .observerVerificationFailed(let observerId, let message):
        return RpcErrorEnvelope(
            tag: .observerVerificationFailed,
            message: message,
            data: ["observerId": .string(observerId), "message": .string(message)]
        )
    }
}

/// Mirrors `rpc-error.ts`'s `decodeRpcError` — recover a typed `DomainError` from an envelope
/// received across the RPC throw boundary. Accepts an already-decoded `RpcErrorEnvelope` (the
/// Swift-side analog of `Schema.decodeUnknown(RpcErrorEnvelope)` having already succeeded); a
/// caller working from a raw JSON payload decodes it as `RpcErrorEnvelope` first via
/// `JSONDecoder`, which is where a malformed/unrecognized envelope fails closed as a
/// `DecodingError`, matching `decodeRpcError`'s own fail-closed intent.
public func decodeRpcError(_ envelope: RpcErrorEnvelope) -> DomainError {
    switch envelope.tag {
    case .nodeNotFound:
        return .nodeNotFound(nodeId: jsonString(envelope.data["nodeId"]))
    case .validationError:
        return .validationError(message: envelope.message, cause: envelope.data["cause"].flatMap {
            if case .string(let s) = $0 { return s } else { return nil }
        })
    case .unexpectedError:
        return .unexpectedError(message: envelope.message)
    case .pageNotFound:
        return .pageNotFound(nodeId: jsonString(envelope.data["nodeId"]))
    case .tagNotFound:
        return .tagNotFound(tagId: jsonString(envelope.data["tagId"]))
    case .factNotFound:
        return .factNotFound(factId: jsonString(envelope.data["factId"]))
    case .edgeNotFound:
        return .edgeNotFound(edgeId: jsonString(envelope.data["edgeId"]))
    case .relationDefinitionNotFound:
        return .relationDefinitionNotFound(
            relationDefinitionId: jsonString(envelope.data["relationDefinitionId"])
        )
    case .graphIssueNotFound:
        return .graphIssueNotFound(graphIssueId: jsonString(envelope.data["graphIssueId"]))
    case .cardinalityViolation:
        return .cardinalityViolation(
            relationDefinitionId: jsonString(envelope.data["relationDefinitionId"]),
            message: jsonString(envelope.data["message"])
        )
    case .graphIssueDetected:
        return .graphIssueDetected(
            relationDefinitionId: jsonString(envelope.data["relationDefinitionId"]),
            nodeId: jsonString(envelope.data["nodeId"]),
            conflictingEdgeIds: jsonStringArray(envelope.data["conflictingEdgeIds"])
        )
    case .chatNotFound:
        return .chatNotFound(chatId: jsonString(envelope.data["chatId"]))
    case .chatBindingNotFound:
        return .chatBindingNotFound(
            chatId: jsonString(envelope.data["chatId"]),
            name: jsonString(envelope.data["name"])
        )
    case .pendingNameConflict:
        return .pendingNameConflict(
            name: jsonString(envelope.data["name"]),
            claimedByChatId: jsonString(envelope.data["claimedByChatId"])
        )
    case .toolNotImplemented:
        return .toolNotImplemented(
            toolName: jsonString(envelope.data["toolName"]),
            message: envelope.message
        )
    case .gatekeeperNotConnected:
        return .gatekeeperNotConnected(
            workspaceId: jsonString(envelope.data["workspaceId"]),
            gatekeeperKind: jsonString(envelope.data["gatekeeperKind"])
        )
    case .oauthExchangeFailed:
        return .oauthExchangeFailed(message: envelope.message)
    case .observerVerificationFailed:
        return .observerVerificationFailed(
            observerId: jsonString(envelope.data["observerId"]),
            message: envelope.message
        )
    }
}

/// Convenience overload mirroring `decodeRpcError`'s actual TS entry point, which accepts
/// `unknown` (e.g. `JSON.parse`'d straight off a caught `Error#message`): decodes `data` as a
/// `RpcErrorEnvelope` via `JSONDecoder` first, then recovers the typed `DomainError` — a
/// malformed payload throws the `DecodingError` instead of silently misdecoding, same fail-closed
/// contract.
public func decodeRpcError(from data: Data) throws -> DomainError {
    let envelope = try JSONDecoder().decode(RpcErrorEnvelope.self, from: data)
    return decodeRpcError(envelope)
}
