// `VoiceSessionService` — the Effect Service behind `voice-session-rpc.ts`'s two methods
// (startVoiceSession/endVoiceSession). Same `WorkspaceDurableObject`-composed-from-Effect-Services
// convention as `MeetingsService`/`CalendarService`.
//
// **Deliberately does NOT depend on `AgentEditService`.** Per `voice-session-rpc.ts`'s own header
// comment, `startVoiceSession` takes an already-existing `chatId` rather than creating one — the
// "does this chat exist, and does it belong to this workspace" check is `workspace-durable-object.ts`'s
// own job (`WorkspaceRpcApi#startVoiceSession` calls `AgentEditService#getChat` + `requireOwnWorkspace`
// itself, the exact same pattern `sendChatMessage`/`mergeChanges`/etc. already use for chat
// ownership), not this service's — keeping this service a plain CRUD layer over the
// `voiceSessions` collection, with no cross-service dependency of its own.
//
// **Does NOT itself open/close a live `RealtimeVoiceSession`** (realtime-voice.ts) — per
// `voice-session-rpc.ts`'s own header comment, this service only brackets that stream's
// PERSISTED lifecycle record; the live duplex session itself is a `Scope`d resource a caller
// (`voice-chat-bridge.ts#runVoiceChatTurns`) manages independently, over the `RealtimeVoiceClient`
// Context.Tag `workspace-durable-object.ts` wires into the instance Layer directly (task item 2).

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  EntityId,
  IsoDateTimeString,
  VoiceSession,
  VoiceSessionNotFound,
  type DomainError
} from "@athenaeum/domain"
import {
  makeVoiceSessionCollections,
  reviveVoiceSession,
  toUnexpectedError,
  type VoiceSessionCollections
} from "./voice-session-collections.js"
import { SyncFeedService } from "./sync-feed-service-live.js"

const now = (): IsoDateTimeString => IsoDateTimeString.make(new Date().toISOString())

export interface VoiceSessionServiceApi {
  readonly startVoiceSession: (workspaceId: EntityId, chatId: EntityId) => Effect.Effect<VoiceSession, DomainError>
  readonly endVoiceSession: (
    workspaceId: EntityId,
    voiceSessionId: EntityId,
    endedAt: IsoDateTimeString
  ) => Effect.Effect<VoiceSession, DomainError>
}

export class VoiceSessionService extends Context.Tag("@athenaeum/backend/VoiceSessionService")<
  VoiceSessionService,
  VoiceSessionServiceApi
>() {}

export const makeVoiceSessionServiceLive = (
  collections: VoiceSessionCollections
): Layer.Layer<VoiceSessionService, never, SyncFeedService> =>
  Layer.effect(
    VoiceSessionService,
    Effect.gen(function* () {
      const syncFeed = yield* SyncFeedService

      const findSession = (
        workspaceId: EntityId,
        voiceSessionId: EntityId
      ): Effect.Effect<VoiceSession, DomainError> =>
        Effect.gen(function* () {
          const raw = yield* collections.voiceSessions.get(voiceSessionId).pipe(Effect.mapError(toUnexpectedError))
          if (raw === undefined) return yield* Effect.fail(new VoiceSessionNotFound({ voiceSessionId }))
          const session = yield* reviveVoiceSession(raw)
          if (session.workspaceId !== workspaceId) return yield* Effect.fail(new VoiceSessionNotFound({ voiceSessionId }))
          return session
        })

      const startVoiceSession: VoiceSessionServiceApi["startVoiceSession"] = (workspaceId, chatId) =>
        Effect.gen(function* () {
          const session = new VoiceSession({
            id: crypto.randomUUID() as EntityId,
            workspaceId,
            chatId,
            startedAt: now(),
            status: "active"
          })
          yield* collections.voiceSessions.put(session).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("voiceSession", session.id, "put", session)
          return session
        })

      const endVoiceSession: VoiceSessionServiceApi["endVoiceSession"] = (workspaceId, voiceSessionId, endedAt) =>
        Effect.gen(function* () {
          const existing = yield* findSession(workspaceId, voiceSessionId)
          const updated = new VoiceSession({ ...existing, endedAt, status: "ended" })
          yield* collections.voiceSessions.put(updated).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("voiceSession", updated.id, "put", updated)
          return updated
        })

      return { startVoiceSession, endVoiceSession } satisfies VoiceSessionServiceApi
    })
  )
