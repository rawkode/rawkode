import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import {
  AppCodeTooLarge,
  AppCodeVersionNotFound,
  AppNotFound,
  CardinalityViolation,
  ChatBindingNotFound,
  ChatNotFound,
  EdgeNotFound,
  FactNotFound,
  GatekeeperNotConnected,
  GraphIssueDetected,
  GraphIssueNotFound,
  MeetingNotFound,
  NodeNotFound,
  OAuthExchangeFailed,
  ObserverVerificationFailed,
  PageNotFound,
  PendingNameConflict,
  RelationDefinitionNotFound,
  TagFieldDefinitionNotFound,
  TagNotFound,
  ToolNotImplemented,
  Unauthorized,
  UnexpectedError,
  ValidationError,
  VoiceSessionNotFound,
  WorkoutImportConflict,
  WorkoutNotFound,
  WorkspaceAccessDenied,
  WorkspaceNotFound,
  type DomainError
} from "./errors.js"

// Risk #3 mitigation, verbatim from the plan (§"Top risks, explicitly flagged"): "a `{tag,
// message, data}` thrown-error envelope convention to preserve typed-error info across the
// Cap'n Web throw boundary." Cap'n Web's throw boundary carries a plain `Error` across the
// wire; it does not know about `Data.TaggedError` subclasses. The convention is: the DO/Worker
// RPC shim (backend's `toThrownRpcError`, per plan §"Effect-TS integration" — not implemented
// here, this package has zero Cloudflare deps) catches a `DomainError`, runs it through
// `encodeRpcError` to get a JSON-safe envelope, and throws a real `Error` carrying that
// envelope as its serialized `message`. The client-side stub catches the rethrown `Error`,
// `JSON.parse`s its `message`, and runs it through `decodeRpcError` to recover a typed
// `DomainError` — schema-validated, so a malformed or unrecognized envelope (e.g. from a
// backend version the client's domain package predates) fails closed as a `ParseError` rather
// than silently misdecoding.
//
// Widened by the Storage/Views stage (plan task item 10's deferred wiring) from the original
// Phase 0 three-tag set to the full `DomainError` union in errors.ts — `GraphServiceLive`/
// `NotesServiceLive` (backend) now really throw `TagNotFound`/`FactNotFound`/`EdgeNotFound`/
// `RelationDefinitionNotFound`/`GraphIssueNotFound`/`CardinalityViolation`/`GraphIssueDetected`/
// `PageNotFound` across this same boundary, so they need the same envelope treatment. Widened
// again by the `AgentEditService` stage with the four Phase 3 agent-editing errors
// (`ChatNotFound`/`ChatBindingNotFound`/`PendingNameConflict`/`ToolNotImplemented`), which that
// service's real RPC methods (`sendChatMessage`, the agent tool dispatch, `mergeChanges`/
// `revertChanges`) now really throw. Widened again by the Phase 5 domain-extension task with the
// three gatekeeper/observer errors (`GatekeeperNotConnected`/`OAuthExchangeFailed`/
// `ObserverVerificationFailed`) -- schema-only in this stage (see errors.ts's own header comment
// on this addition), wired into the envelope now so the backend stage that actually throws them
// has nothing left to add here, following every prior stage's identical practice.

const knownTags = [
  "NodeNotFound",
  "ValidationError",
  "UnexpectedError",
  "PageNotFound",
  "TagNotFound",
  "FactNotFound",
  "EdgeNotFound",
  "RelationDefinitionNotFound",
  "GraphIssueNotFound",
  "CardinalityViolation",
  "GraphIssueDetected",
  "ChatNotFound",
  "ChatBindingNotFound",
  "PendingNameConflict",
  "ToolNotImplemented",
  "Unauthorized",
  "WorkspaceAccessDenied",
  "WorkspaceNotFound",
  "GatekeeperNotConnected",
  "OAuthExchangeFailed",
  "ObserverVerificationFailed",
  "MeetingNotFound",
  "VoiceSessionNotFound",
  "WorkoutNotFound",
  "WorkoutImportConflict",
  "AppNotFound",
  "AppCodeVersionNotFound",
  "AppCodeTooLarge",
  "TagFieldDefinitionNotFound"
] as const

/** The JSON-safe shape a `DomainError` is flattened to before crossing the RPC throw boundary. */
export class RpcErrorEnvelope extends Schema.Class<RpcErrorEnvelope>("RpcErrorEnvelope")({
  tag: Schema.Literal(...knownTags),
  message: Schema.String,
  data: Schema.Record({ key: Schema.String, value: Schema.Unknown })
}) {}

/** Flatten a `DomainError` into the wire envelope. Pure — no I/O, no throwing. */
export const encodeRpcError = (error: DomainError): RpcErrorEnvelope => {
  switch (error._tag) {
    case "NodeNotFound":
      return new RpcErrorEnvelope({
        tag: "NodeNotFound",
        message: `Node not found: ${error.nodeId}`,
        data: { nodeId: error.nodeId }
      })
    case "ValidationError":
      return new RpcErrorEnvelope({
        tag: "ValidationError",
        message: error.message,
        data: "cause" in error && error.cause !== undefined ? { cause: String(error.cause) } : {}
      })
    case "UnexpectedError":
      return new RpcErrorEnvelope({
        tag: "UnexpectedError",
        message: error.message,
        data: {}
      })
    case "PageNotFound":
      return new RpcErrorEnvelope({
        tag: "PageNotFound",
        message: `Page not found: ${error.nodeId}`,
        data: { nodeId: error.nodeId }
      })
    case "TagNotFound":
      return new RpcErrorEnvelope({
        tag: "TagNotFound",
        message: `Tag not found: ${error.tagId}`,
        data: { tagId: error.tagId }
      })
    case "FactNotFound":
      return new RpcErrorEnvelope({
        tag: "FactNotFound",
        message: `Fact not found: ${error.factId}`,
        data: { factId: error.factId }
      })
    case "EdgeNotFound":
      return new RpcErrorEnvelope({
        tag: "EdgeNotFound",
        message: `Edge not found: ${error.edgeId}`,
        data: { edgeId: error.edgeId }
      })
    case "RelationDefinitionNotFound":
      return new RpcErrorEnvelope({
        tag: "RelationDefinitionNotFound",
        message: `RelationDefinition not found: ${error.relationDefinitionId}`,
        data: { relationDefinitionId: error.relationDefinitionId }
      })
    case "GraphIssueNotFound":
      return new RpcErrorEnvelope({
        tag: "GraphIssueNotFound",
        message: `GraphIssue not found: ${error.graphIssueId}`,
        data: { graphIssueId: error.graphIssueId }
      })
    case "CardinalityViolation":
      return new RpcErrorEnvelope({
        tag: "CardinalityViolation",
        message: error.message,
        data: { relationDefinitionId: error.relationDefinitionId, message: error.message }
      })
    case "GraphIssueDetected":
      return new RpcErrorEnvelope({
        tag: "GraphIssueDetected",
        message:
          `Concurrent max-one-cardinality edge conflict on relationDefinition ` +
          `${error.relationDefinitionId} for node ${error.nodeId}`,
        data: {
          relationDefinitionId: error.relationDefinitionId,
          nodeId: error.nodeId,
          conflictingEdgeIds: error.conflictingEdgeIds
        }
      })
    case "ChatNotFound":
      return new RpcErrorEnvelope({
        tag: "ChatNotFound",
        message: `Chat not found: ${error.chatId}`,
        data: { chatId: error.chatId }
      })
    case "ChatBindingNotFound":
      return new RpcErrorEnvelope({
        tag: "ChatBindingNotFound",
        message: `No binding named "${error.name}" in chat ${error.chatId}`,
        data: { chatId: error.chatId, name: error.name }
      })
    case "PendingNameConflict":
      return new RpcErrorEnvelope({
        tag: "PendingNameConflict",
        message: `Name "${error.name}" is pending in another chat (${error.claimedByChatId})`,
        data: { name: error.name, claimedByChatId: error.claimedByChatId }
      })
    case "ToolNotImplemented":
      return new RpcErrorEnvelope({
        tag: "ToolNotImplemented",
        message: error.message,
        data: { toolName: error.toolName, message: error.message }
      })
    case "Unauthorized":
      return new RpcErrorEnvelope({
        tag: "Unauthorized",
        message: error.message,
        data: {}
      })
    case "WorkspaceAccessDenied":
      return new RpcErrorEnvelope({
        tag: "WorkspaceAccessDenied",
        message: `You do not have access to this workspace: ${error.workspaceId}`,
        data: { workspaceId: error.workspaceId }
      })
    case "WorkspaceNotFound":
      return new RpcErrorEnvelope({
        tag: "WorkspaceNotFound",
        message: `Workspace not found: ${error.workspaceId}`,
        data: { workspaceId: error.workspaceId }
      })
    case "GatekeeperNotConnected":
      return new RpcErrorEnvelope({
        tag: "GatekeeperNotConnected",
        message: `No "${error.gatekeeperKind}" gatekeeper connected for workspace ${error.workspaceId}`,
        data: { workspaceId: error.workspaceId, gatekeeperKind: error.gatekeeperKind }
      })
    case "OAuthExchangeFailed":
      return new RpcErrorEnvelope({
        tag: "OAuthExchangeFailed",
        message: error.message,
        data: {}
      })
    case "ObserverVerificationFailed":
      return new RpcErrorEnvelope({
        tag: "ObserverVerificationFailed",
        message: error.message,
        data: { observerId: error.observerId, message: error.message }
      })
    case "MeetingNotFound":
      return new RpcErrorEnvelope({
        tag: "MeetingNotFound",
        message: `Meeting not found: ${error.meetingId}`,
        data: { meetingId: error.meetingId }
      })
    case "VoiceSessionNotFound":
      return new RpcErrorEnvelope({
        tag: "VoiceSessionNotFound",
        message: `VoiceSession not found: ${error.voiceSessionId}`,
        data: { voiceSessionId: error.voiceSessionId }
      })
    case "WorkoutNotFound":
      return new RpcErrorEnvelope({
        tag: "WorkoutNotFound",
        message: `Workout not found: ${error.nodeId}`,
        data: { nodeId: error.nodeId }
      })
    case "WorkoutImportConflict":
      return new RpcErrorEnvelope({
        tag: "WorkoutImportConflict",
        message: error.message,
        data: { sourceWorkoutId: error.sourceWorkoutId, message: error.message }
      })
    case "AppNotFound":
      return new RpcErrorEnvelope({
        tag: "AppNotFound",
        message: `App not found: ${error.appId}`,
        data: { appId: error.appId }
      })
    case "AppCodeVersionNotFound":
      return new RpcErrorEnvelope({
        tag: "AppCodeVersionNotFound",
        message: `App code version not found: app ${error.appId}, kind ${error.kind}, version ${error.version}`,
        data: { appId: error.appId, kind: error.kind, version: error.version }
      })
    case "AppCodeTooLarge":
      return new RpcErrorEnvelope({
        tag: "AppCodeTooLarge",
        message:
          `App ${error.appId} ${error.kind} code is ${error.sizeBytes} bytes, ` +
          `which exceeds the ${error.maxBytes}-byte limit`,
        data: {
          appId: error.appId,
          kind: error.kind,
          sizeBytes: error.sizeBytes,
          maxBytes: error.maxBytes
        }
      })
    case "TagFieldDefinitionNotFound":
      return new RpcErrorEnvelope({
        tag: "TagFieldDefinitionNotFound",
        message: `TagFieldDefinition not found: ${error.fieldId}`,
        data: { fieldId: error.fieldId }
      })
  }
}

const stringField = (data: Record<string, unknown>, key: string): string =>
  typeof data[key] === "string" ? data[key] : ""

const stringArrayField = (data: Record<string, unknown>, key: string): ReadonlyArray<string> =>
  Array.isArray(data[key]) ? data[key].filter((v): v is string => typeof v === "string") : []

const numberField = (data: Record<string, unknown>, key: string): number =>
  typeof data[key] === "number" ? data[key] : 0

/**
 * Recover a typed `DomainError` from an envelope received across the RPC throw boundary.
 * Accepts `unknown` (e.g. `JSON.parse`d straight off a caught `Error#message`) and validates
 * it against `RpcErrorEnvelope` first, so a malformed payload surfaces as a `ParseError`
 * instead of a bad reconstruction.
 */
export const decodeRpcError = (
  input: unknown
): Effect.Effect<DomainError, ParseResult.ParseError> =>
  Schema.decodeUnknown(RpcErrorEnvelope)(input).pipe(
    Effect.map((envelope): DomainError => {
      switch (envelope.tag) {
        case "NodeNotFound":
          return new NodeNotFound({ nodeId: stringField(envelope.data, "nodeId") })
        case "ValidationError":
          return new ValidationError({
            message: envelope.message,
            cause: envelope.data["cause"]
          })
        case "UnexpectedError":
          return new UnexpectedError({ message: envelope.message })
        case "PageNotFound":
          return new PageNotFound({ nodeId: stringField(envelope.data, "nodeId") })
        case "TagNotFound":
          return new TagNotFound({ tagId: stringField(envelope.data, "tagId") })
        case "FactNotFound":
          return new FactNotFound({ factId: stringField(envelope.data, "factId") })
        case "EdgeNotFound":
          return new EdgeNotFound({ edgeId: stringField(envelope.data, "edgeId") })
        case "RelationDefinitionNotFound":
          return new RelationDefinitionNotFound({
            relationDefinitionId: stringField(envelope.data, "relationDefinitionId")
          })
        case "GraphIssueNotFound":
          return new GraphIssueNotFound({
            graphIssueId: stringField(envelope.data, "graphIssueId")
          })
        case "CardinalityViolation":
          return new CardinalityViolation({
            relationDefinitionId: stringField(envelope.data, "relationDefinitionId"),
            message: stringField(envelope.data, "message")
          })
        case "GraphIssueDetected":
          return new GraphIssueDetected({
            relationDefinitionId: stringField(envelope.data, "relationDefinitionId"),
            nodeId: stringField(envelope.data, "nodeId"),
            conflictingEdgeIds: stringArrayField(envelope.data, "conflictingEdgeIds")
          })
        case "ChatNotFound":
          return new ChatNotFound({ chatId: stringField(envelope.data, "chatId") })
        case "ChatBindingNotFound":
          return new ChatBindingNotFound({
            chatId: stringField(envelope.data, "chatId"),
            name: stringField(envelope.data, "name")
          })
        case "PendingNameConflict":
          return new PendingNameConflict({
            name: stringField(envelope.data, "name"),
            claimedByChatId: stringField(envelope.data, "claimedByChatId")
          })
        case "ToolNotImplemented":
          return new ToolNotImplemented({
            toolName: stringField(envelope.data, "toolName"),
            message: envelope.message
          })
        case "Unauthorized":
          return new Unauthorized({ message: envelope.message })
        case "WorkspaceAccessDenied":
          return new WorkspaceAccessDenied({ workspaceId: stringField(envelope.data, "workspaceId") })
        case "WorkspaceNotFound":
          return new WorkspaceNotFound({ workspaceId: stringField(envelope.data, "workspaceId") })
        case "GatekeeperNotConnected":
          return new GatekeeperNotConnected({
            workspaceId: stringField(envelope.data, "workspaceId"),
            gatekeeperKind: stringField(envelope.data, "gatekeeperKind")
          })
        case "OAuthExchangeFailed":
          return new OAuthExchangeFailed({ message: envelope.message })
        case "ObserverVerificationFailed":
          return new ObserverVerificationFailed({
            observerId: stringField(envelope.data, "observerId"),
            message: envelope.message
          })
        case "MeetingNotFound":
          return new MeetingNotFound({ meetingId: stringField(envelope.data, "meetingId") })
        case "VoiceSessionNotFound":
          return new VoiceSessionNotFound({
            voiceSessionId: stringField(envelope.data, "voiceSessionId")
          })
        case "WorkoutNotFound":
          return new WorkoutNotFound({ nodeId: stringField(envelope.data, "nodeId") })
        case "WorkoutImportConflict":
          return new WorkoutImportConflict({
            sourceWorkoutId: stringField(envelope.data, "sourceWorkoutId"),
            message: envelope.message
          })
        case "AppNotFound":
          return new AppNotFound({ appId: stringField(envelope.data, "appId") })
        case "AppCodeVersionNotFound":
          return new AppCodeVersionNotFound({
            appId: stringField(envelope.data, "appId"),
            kind: stringField(envelope.data, "kind"),
            version: numberField(envelope.data, "version")
          })
        case "AppCodeTooLarge":
          return new AppCodeTooLarge({
            appId: stringField(envelope.data, "appId"),
            kind: stringField(envelope.data, "kind"),
            sizeBytes: numberField(envelope.data, "sizeBytes"),
            maxBytes: numberField(envelope.data, "maxBytes")
          })
        case "TagFieldDefinitionNotFound":
          return new TagFieldDefinitionNotFound({
            fieldId: stringField(envelope.data, "fieldId")
          })
      }
    })
  )
