import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString } from "./node.js"
import { VoiceSession } from "./voice-session.js"

// Phase 6 domain-extension task (plan §"Meetings & voice"), item 4: "RPC schemas: ...
// startVoiceSession, endVoiceSession." Same one-`Schema.Class`-input/output-pair-per-method
// convention as meeting-rpc.ts/gatekeeper-rpc.ts/agent-edit-rpc.ts. Schema-only — no `VoiceService`
// implementation lives here, and neither method is wired onto `WorkspaceDurableObject` yet.
//
// **Every method below is workspace-scoped**, and — per this task's own hard constraint, restated
// identically from meeting-rpc.ts's own note — **every one of these RPC methods, once a real
// `WorkspaceDurableObject` implementation exists, MUST call `requireRoleForGovernedWorkspace`; no
// exceptions.** Both methods here are mutations (a voice session's own audio/event stream is not
// itself an RPC method — it rides `RealtimeVoiceClient.openSession`'s live `Scope`d duplex stream,
// backend-side, per realtime-voice.ts's own doc comment; these two methods only bracket that
// stream's persisted lifecycle record) → both gate on `"build"`, mirroring `startMeeting`/
// `endMeeting`'s identical mutation classification in meeting-rpc.ts.
//
// **Relationship to `chatId`**: `startVoiceSession` takes an already-existing `chatId` (chat.ts)
// rather than creating one — per this task's plan hard constraint ("reuse Phase 3's
// AgentEditService/ModelClient pattern unchanged for voice's agent-tool-calling"), a voice
// conversation's turns are `AgentEditService.sendChatMessage` calls against a real `Chat` a caller
// creates via `createChat` (agent-edit-rpc.ts) first, exactly as a text-only conversation would —
// this schema does not special-case "a chat created for voice" as a different kind of chat.

/** Starts a new `VoiceSession` (voice-session.ts) against an already-existing `Chat` — creates the
 *  row with `status: "active"` and `startedAt` set, `endedAt` absent. Fails with `ChatNotFound`
 *  (errors.ts, chat.ts) if `chatId` does not reference a real chat in this workspace — this schema
 *  itself does not create one, per this file's header comment. `id` is server-assigned, matching
 *  `StartMeetingOutput`'s identical convention. */
export class StartVoiceSessionInput extends Schema.Class<StartVoiceSessionInput>(
  "StartVoiceSessionInput"
)({
  workspaceId: EntityId,
  chatId: EntityId
}) {}

export class StartVoiceSessionOutput extends Schema.Class<StartVoiceSessionOutput>(
  "StartVoiceSessionOutput"
)({
  voiceSession: VoiceSession
}) {}

/** Ends an active `VoiceSession`, setting `endedAt` and transitioning `status` to `"ended"`. Fails
 *  with `VoiceSessionNotFound` (errors.ts) if no voice session with this id exists in the workspace.
 *  Deliberately does not itself close the live `RealtimeVoiceSession`/WebSocket (realtime-voice.ts)
 *  — that is the caller's (backend's) own resource-lifecycle responsibility via the session's
 *  `Scope`/`close()`, per that file's own doc comment; this RPC method only updates the persisted
 *  lifecycle record, the same "schema fixes the shape, the service fixes the policy" split
 *  meeting-rpc.ts's `endMeeting` states for itself. */
export class EndVoiceSessionInput extends Schema.Class<EndVoiceSessionInput>(
  "EndVoiceSessionInput"
)({
  workspaceId: EntityId,
  voiceSessionId: EntityId,
  endedAt: IsoDateTimeString
}) {}

export class EndVoiceSessionOutput extends Schema.Class<EndVoiceSessionOutput>(
  "EndVoiceSessionOutput"
)({
  voiceSession: VoiceSession
}) {}
