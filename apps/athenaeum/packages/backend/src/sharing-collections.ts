// `typed-storage-effect` collections backing `SharingService` (`sharing-service-live.ts`) — the
// real storage half of docs/sharing.md's `SharingStorage` interface (`workshop-backend/src/
// sharing.ts`), ported onto workspaces. Same "one small collections module per repository/service"
// convention as `edges-repository-live.ts`/`workspace-ownership.ts` (plan §"Storage & domain model",
// God-object mitigation).
//
// Three collections, one per docs/sharing.md storage concept:
//   - `collaborators` — one row per non-owner user with a permission-graph node (§Collaborators),
//     keyed by `profileId` alone (not `(workspaceId, profileId)`): every collection here lives inside
//     ONE `WorkspaceDurableObject` instance, whose `#workspaceId` is already fixed for the DO's lifetime
//     (see `workspace-durable-object.ts`'s `requireOwnWorkspace`), so `workspaceId` on the `Collaborator`
//     schema itself is redundant-but-harmless denormalization, not a second key component.
//   - `shareLinks` — one row per share link (docs/sharing.md's `ShareLinkRecord`), keyed by `id`
//     (== the link's first key's HMAC-SHA-256 hash, a `ShareKeyHash`). Carries the link's
//     metadata (`creatorId`, `role`, `revoked`, `createdAt`) — never duplicated onto key rows.
//   - `shareKeys` — one row per *key* (first key AND every later copy/"alias"), keyed by `hash`.
//     `byLinkId` is a non-unique index over ONLY the alias rows (`alias ? linkId : null` — a link's
//     own first-key row deliberately indexes to nothing here, since its `hash === linkId` already
//     makes it directly reachable via the primary key): this is what lets `revokeShareLink` delete
//     "the link's copies... outright, since no edge ever references an alias" (§Lazy revocation)
//     with one index-scoped `delete`, without touching the link's own first-key row.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import {
  Collaborator,
  ShareKeyRecord,
  ShareLink,
  UnexpectedError,
  type Email,
  type ShareKeyHash
} from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"

const collaboratorsCollectionSchema = collection<Collaborator>()({
  primaryKey: "profileId"
})

const shareLinksCollectionSchema = collection<ShareLink>()({
  primaryKey: "id"
})

const shareKeysCollectionSchema = collection<ShareKeyRecord>()({
  primaryKey: "hash",
  nonUniqueIndexes: {
    byLinkId: (record: ShareKeyRecord) => (record.alias ? record.linkId : null)
  }
})

export interface SharingCollections {
  readonly collaborators: Collection<Collaborator, Email>
  readonly shareLinks: Collection<ShareLink, ShareKeyHash>
  readonly shareKeys: Collection<ShareKeyRecord, ShareKeyHash> & {
    readonly byLinkId: NonUniqueIndex<ShareKeyRecord, ShareKeyHash>
  }
}

export const makeSharingCollections = (storage: DurableObjectStorage): SharingCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: {
      collaborators: collaboratorsCollectionSchema,
      shareLinks: shareLinksCollectionSchema,
      shareKeys: shareKeysCollectionSchema
    }
  })
  return {
    collaborators: typedStorage.collaborators,
    shareLinks: typedStorage.shareLinks,
    shareKeys: typedStorage.shareKeys
  }
}

/** Same `TypedStorageError` → `UnexpectedError` flattening every other `*-repository-live.ts`
 *  module defines locally (see `edges-repository-live.ts`'s identically-shaped helper). */
export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/** `DurableObjectStorage` round-trips values through structured clone — a record read back is a
 *  plain object, not the `Schema.Class` instance the sharing-service logic and the RPC output
 *  schemas need (same concern as `nodes-repository-live.ts`'s `reviveNode`/`user-durable-
 *  object.ts`'s `reviveWorkspaceCatalogEntry`). */
export const reviveCollaborator = (raw: unknown): Effect.Effect<Collaborator, UnexpectedError> =>
  Schema.decodeUnknown(Collaborator)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({
          message: `corrupt stored collaborator: ${TreeFormatter.formatErrorSync(parseError)}`
        })
    )
  )

export const reviveShareLink = (raw: unknown): Effect.Effect<ShareLink, UnexpectedError> =>
  Schema.decodeUnknown(ShareLink)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({
          message: `corrupt stored share link: ${TreeFormatter.formatErrorSync(parseError)}`
        })
    )
  )

export const reviveShareKeyRecord = (raw: unknown): Effect.Effect<ShareKeyRecord, UnexpectedError> =>
  Schema.decodeUnknown(ShareKeyRecord)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({
          message: `corrupt stored share key record: ${TreeFormatter.formatErrorSync(parseError)}`
        })
    )
  )
