import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString } from "./node.js"

// Phase 6 domain-extension task (plan §"Meetings & voice"), item 3: `VoiceSession`. Per the
// task's own `{id, workspaceId, chatId, startedAt, endedAt?, status}` shape. This is the *persisted*
// workspace-storage record of a realtime-voice conversation — the `voiceSessions` collection named in
// the plan's §"Storage & domain model" — as distinct from `realtime-voice.ts`'s
// `RealtimeVoiceSession` interface, which is the live, in-memory, scoped duplex-stream handle a
// backend `RealtimeVoiceClient.openSession` call hands back for exactly the duration one
// connection is open (see that file's own doc comment). The same "persisted row vs. ephemeral
// live handle" split chat.ts draws between `Chat`/`ChatMessageRecord` and model-client.ts's
// `ChatThread`/`ChatMessage` — no naming collision here (`RealtimeVoiceSession` and `VoiceSession`
// are already distinct identifiers), but the same underlying design point: a `VoiceSession` row
// is what survives a connection dropping and reconnecting, or a client querying "what voice
// sessions has this workspace had" after the fact; `RealtimeVoiceSession` is not itself persisted
// anywhere, and does not outlive its own `Scope`.
//
// `chatId` ties a voice session to the workspace-scoped `Chat` (chat.ts) whose `AgentEditService
// .sendChatMessage` a completed voice turn's transcript is fed into unchanged (plan hard
// constraint: "reuse Phase 3's AgentEditService/ModelClient pattern unchanged for voice's
// agent-tool-calling — do not build a parallel agent mechanism"; the actual bridge —
// `voice-chat-bridge.ts`'s `runVoiceChatTurns`, per the Decisions stage — lives in `backend`, not
// here). A `VoiceSession` therefore always references a real, already-existing `Chat` row rather
// than owning its own independent message log; every turn's `ChatMessageRecord`s land in that
// `Chat`'s own log exactly as a text-only turn's would, which is what "unchanged" means concretely.

/** A voice session's lifecycle state. Two values only, mirroring `Meeting`'s own
 *  `endedAt`-presence lifecycle (meeting.ts) but modeled as an explicit literal here rather than
 *  inferred from `endedAt`'s presence/absence: unlike a `Meeting` (which has no other state a
 *  client needs to distinguish while in progress), a `VoiceSession`'s "in progress" state is
 *  itself meaningful to show in a UI ("call in progress" vs. silently absent `endedAt`), so it
 *  gets its own named field rather than requiring every reader to re-derive it from a timestamp's
 *  presence. `"active"` is set by `startVoiceSession` (voice-session-rpc.ts); `"ended"` is the
 *  only value `endVoiceSession` ever transitions a row to — there is no `"failed"`/`"error"`
 *  variant in this stage, since a live session's own error handling is
 *  `RealtimeVoiceClient`/`RealtimeVoiceSession`'s closed `RealtimeVoiceError` channel
 *  (realtime-voice.ts), not something this persisted row's lifecycle needs to separately encode —
 *  a session that fails still transitions to `"ended"` once the caller (backend) observes the
 *  failure and calls `endVoiceSession`, same as a session that ends normally. */
export const VoiceSessionStatus = Schema.Literal("active", "ended")
export type VoiceSessionStatus = typeof VoiceSessionStatus.Type

/**
 * A persisted realtime-voice conversation record, per the task's own `{id, workspaceId, chatId,
 * startedAt, endedAt?, status}` shape. See this file's header comment for the full design
 * rationale, especially the split from `realtime-voice.ts`'s `RealtimeVoiceSession`.
 */
export class VoiceSession extends Schema.Class<VoiceSession>("VoiceSession")({
  id: EntityId,
  workspaceId: EntityId,
  chatId: EntityId,
  startedAt: IsoDateTimeString,
  endedAt: Schema.optional(IsoDateTimeString),
  status: VoiceSessionStatus
}) {}
