import type { DomainError } from "@athenaeum/domain"

// Web-stage fix (found via this stage's own real two-browser verification, not hypothetical):
// several `DomainError` tags — `NodeNotFound`, `PageNotFound`, `TagNotFound`, `FactNotFound`,
// `EdgeNotFound`, `RelationDefinitionNotFound`, `GraphIssueNotFound`, `ChatNotFound`,
// `WorkspaceNotFound`, `WorkspaceAccessDenied`, `GatekeeperNotConnected` — do NOT carry a
// `message` field (errors.ts: they carry only an id, by design — "the denial exposes no
// workspace name, owner, or content", a discipline the Phase 5 domain-extension task's own
// `GatekeeperNotConnected` follows for the identical reason).
// `Data.TaggedError` instances still structurally satisfy `{ message: string }` at the TYPE level
// (they extend `Error`, which always has a `message` property), so `error.message` type-checks
// even for these tags — but at RUNTIME it's `Error.prototype`'s default `""` (empty string).
// `GraphView.tsx`'s pre-existing `{state.error.message}` (and this stage's own first draft of
// `SharePanel.tsx`'s `formatDomainError`) silently rendered nothing at all for exactly these
// tags — invisible in the DOM, easy to mistake for "still loading" — reproduced live when a
// revoked collaborator's `runView`/`listCollaborators`/`listShareLinks` calls correctly failed
// with `WorkspaceAccessDenied` but the UI showed a blank section instead of an error. This module
// is the fix: one exhaustive switch, reused by every component that renders a `DomainError`,
// so a human-readable message exists for every tag regardless of whether it carries `.message`.

export const formatDomainError = (error: DomainError): string => {
  switch (error._tag) {
    case "NodeNotFound":
      return `Node not found: ${error.nodeId}`
    case "PageNotFound":
      return `Page not found for node: ${error.nodeId}`
    case "TagNotFound":
      return `Tag not found: ${error.tagId}`
    case "FactNotFound":
      return `Fact not found: ${error.factId}`
    case "EdgeNotFound":
      return `Edge not found: ${error.edgeId}`
    case "RelationDefinitionNotFound":
      return `Relation definition not found: ${error.relationDefinitionId}`
    case "GraphIssueNotFound":
      return `Graph issue not found: ${error.graphIssueId}`
    case "ChatNotFound":
      return `Chat not found: ${error.chatId}`
    case "ChatBindingNotFound":
      return `No binding named "${error.name}" in this chat`
    case "PendingNameConflict":
      return `Name "${error.name}" is already pending in another chat`
    case "CardinalityViolation":
      return error.message
    case "GraphIssueDetected":
      return `Conflicting edges detected on node ${error.nodeId} for relation ${error.relationDefinitionId}`
    case "ToolNotImplemented":
      return error.message
    case "Unauthorized":
      return error.message
    case "WorkspaceNotFound":
      return "This workspace doesn't exist (or was deleted)."
    case "WorkspaceAccessDenied":
      return "You don't have access to this workspace. If you were removed as a collaborator, ask the owner to re-add you."
    case "ValidationError":
      return error.message
    case "UnexpectedError":
      return error.message
    case "GatekeeperNotConnected":
      return `No "${error.gatekeeperKind}" gatekeeper is connected for this workspace.`
    case "OAuthExchangeFailed":
      return error.message
    case "ObserverVerificationFailed":
      return error.message
    // Phase 6 domain-extension task's additions (meeting-rpc.ts/voice-session-rpc.ts) — same
    // "carries only an id, by design" shape as `NodeNotFound`/`ChatNotFound` above, per
    // `MeetingNotFound`/`VoiceSessionNotFound`'s own doc comments in errors.ts.
    case "MeetingNotFound":
      return `Meeting not found: ${error.meetingId}`
    case "VoiceSessionNotFound":
      return `Voice session not found: ${error.voiceSessionId}`
    // Phase 7 domain-extension task's additions (workout-rpc.ts) — same "carries only an id, by
    // design" shape as `MeetingNotFound` above (`WorkoutNotFound`), plus `WorkoutImportConflict`,
    // which does carry a message (see this stage's own `errors.ts` doc comments).
    case "WorkoutNotFound":
      return `Workout not found: ${error.nodeId}`
    case "WorkoutImportConflict":
      return error.message
    // App Library domain-extension task's additions (app-rpc.ts) — `AppNotFound` carries only an
    // id, by design, same as `NodeNotFound`/`MeetingNotFound` above; `AppCodeVersionNotFound` and
    // `AppCodeTooLarge` both carry enough structured context to compose a specific message
    // without needing a separate `.message` field (see errors.ts's own doc comments on both).
    case "AppNotFound":
      return `App not found: ${error.appId}`
    case "AppCodeVersionNotFound":
      return `No ${error.kind} code version ${error.version} found for app ${error.appId}`
    case "AppCodeTooLarge":
      return `App code is ${error.sizeBytes} bytes, which exceeds the ${error.maxBytes}-byte limit`
    // Supertag-centering pass's addition (tag-field-definition.ts) — carries only an id, by
    // design, same shape as `NodeNotFound`/`AppNotFound` above. Adversarial-review fix: this tag
    // was added to `DomainError` by an earlier pass but never added here, which made this
    // module's own exhaustiveness check (the `default` branch below) fail `tsc` — found via this
    // stage's own `tsc --noEmit` pass, not hypothetical.
    case "TagFieldDefinitionNotFound":
      return `Field not found: ${error.fieldId}`
    default:
      // Exhaustiveness check: if `DomainError` grows a new tag, this line fails to compile.
      return ((_: never) => "An unexpected error occurred.")(error)
  }
}
