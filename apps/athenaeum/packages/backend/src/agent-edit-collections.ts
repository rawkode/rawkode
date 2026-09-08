// Storage collections for `AgentEditService` (plan §"Agent-native editing & gatekeeper
// integrations"; §"Storage & domain model": "chats, changes — agent-edit provisional-change
// stream"). Same "adapt typed-storage-effect to the domain schema" pattern as every other
// `*-repository-live.ts`/`*-collections.ts` module (`facts-repository-live.ts`,
// `tag-closure.ts`) — collections/indexes live here, orchestration lives in
// `agent-edit-service-live.ts`.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { Chat, ChangesMessage, ChatMessageRecord, UnexpectedError, type EntityId } from "@athenaeum/domain"
import type { ChatBindingName, ChatBindingTarget } from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"

const chatsCollectionSchema = collection<Chat>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (chat: Chat) => chat.workspaceId
  }
})

const chatMessagesCollectionSchema = collection<ChatMessageRecord>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byChatId: (message: ChatMessageRecord) => message.chatId
  }
})

/** Zero-padded `${chatId}:${sequence}` primary key — same "pad so lexicographic key order
 *  matches numeric order" technique `sync-feed-service-live.ts`'s `syncFeedEntries` collection
 *  already uses, needed here for the same reason: `AgentEditService` lists a chat's
 *  `ChangesMessage`s and relies on getting them back in `sequence` order. */
const changesMessageKey = (message: ChangesMessage): string =>
  `${message.chatId}:${message.sequence.toString().padStart(12, "0")}`

const changesMessagesCollectionSchema = collection<ChangesMessage>()({
  primaryKey: changesMessageKey,
  nonUniqueIndexes: {
    byChatId: (message: ChangesMessage) => message.chatId
  }
})

/** One entry of a chat's binding map (chat-binding.ts's `ChatBinding`, storage-scoped by
 *  `chatId` — `ChatBinding` itself carries no `chatId` field, see that file's own doc comment on
 *  why a flat `{name, target}` row is the domain shape). Backend-internal, like
 *  `pages-repository-live.ts`'s `PageDocRow` — never itself a wire schema (the RPC layer
 *  translates to/from `ChatBinding` where a binding map needs to cross the wire at all, which no
 *  Phase 3 RPC method currently does — bindings are resolved server-side only). */
export interface ChatBindingRecord {
  readonly chatId: EntityId
  readonly name: ChatBindingName
  readonly target: ChatBindingTarget
}

const chatBindingKey = (record: ChatBindingRecord): string => `${record.chatId}:${record.name}`

const chatBindingsCollectionSchema = collection<ChatBindingRecord>()({
  primaryKey: chatBindingKey,
  nonUniqueIndexes: {
    byChatId: (record: ChatBindingRecord) => record.chatId
  }
})

export interface AgentEditCollections {
  readonly chats: Collection<Chat, EntityId> & { readonly byWorkspaceId: NonUniqueIndex<Chat, EntityId> }
  readonly chatMessages: Collection<ChatMessageRecord, EntityId> & {
    readonly byChatId: NonUniqueIndex<ChatMessageRecord, EntityId>
  }
  readonly changesMessages: Collection<ChangesMessage, string> & {
    readonly byChatId: NonUniqueIndex<ChangesMessage, EntityId>
  }
  readonly chatBindings: Collection<ChatBindingRecord, string> & {
    readonly byChatId: NonUniqueIndex<ChatBindingRecord, EntityId>
  }
}

export const makeAgentEditCollections = (storage: DurableObjectStorage): AgentEditCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: {
      chats: chatsCollectionSchema,
      chatMessages: chatMessagesCollectionSchema,
      changesMessages: changesMessagesCollectionSchema,
      chatBindings: chatBindingsCollectionSchema
    }
  })
  return {
    chats: typedStorage.chats,
    chatMessages: typedStorage.chatMessages,
    changesMessages: typedStorage.changesMessages,
    chatBindings: typedStorage.chatBindings
  }
}

export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/** Same "revive a schema-validated instance from a structurally-cloned plain object" need as
 *  every other repository's `reviveX` (see `nodes-repository-live.ts`'s `reviveNode` doc
 *  comment). */
export const reviveChat = (raw: unknown): Effect.Effect<Chat, UnexpectedError> =>
  Schema.decodeUnknown(Chat)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored chat: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

export const reviveChatMessage = (raw: unknown): Effect.Effect<ChatMessageRecord, UnexpectedError> =>
  Schema.decodeUnknown(ChatMessageRecord)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored chat message: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

export const reviveChangesMessage = (raw: unknown): Effect.Effect<ChangesMessage, UnexpectedError> =>
  Schema.decodeUnknown(ChangesMessage)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored changes message: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )
