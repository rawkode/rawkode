// `typed-storage-effect` collections backing `VoiceSessionService` (`voice-session-service-live.ts`)
// — same one-small-collections-module-per-service convention as `meeting-collections.ts`/
// `calendar-collections.ts`. One collection: `voiceSessions`, one row per `VoiceSession`
// (voice-session.ts), keyed by `id`, with a `byWorkspaceId` index (a future `listVoiceSessions`, not
// part of this stage's RPC surface — `startVoiceSession`/`endVoiceSession` only — but kept for the
// same "index what a workspace-scoped collection is naturally queried by" discipline every other
// collection module in this package follows) and a `byChatId` index (`startVoiceSession` never
// needs "does this chat already have a voice session," but a future `VoiceSessionNotFound`-safe
// lookup by chat is a natural query this collection should support without a second migration).

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { UnexpectedError, VoiceSession, type EntityId } from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"

const voiceSessionsCollectionSchema = collection<VoiceSession>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (session: VoiceSession) => session.workspaceId,
    byChatId: (session: VoiceSession) => session.chatId
  }
})

export interface VoiceSessionCollections {
  readonly voiceSessions: Collection<VoiceSession, EntityId> & {
    readonly byWorkspaceId: NonUniqueIndex<VoiceSession, EntityId>
    readonly byChatId: NonUniqueIndex<VoiceSession, EntityId>
  }
}

export const makeVoiceSessionCollections = (storage: DurableObjectStorage): VoiceSessionCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: {
      voiceSessions: voiceSessionsCollectionSchema
    }
  })
  return { voiceSessions: typedStorage.voiceSessions }
}

export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

export const reviveVoiceSession = (raw: unknown): Effect.Effect<VoiceSession, UnexpectedError> =>
  Schema.decodeUnknown(VoiceSession)(raw).pipe(
    Effect.mapError(
      (parseError) => new UnexpectedError({ message: `corrupt stored voice session: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )
