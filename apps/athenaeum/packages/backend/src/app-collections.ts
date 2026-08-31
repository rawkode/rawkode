// Storage collections for the App Library (app.ts's `App`/`AppCodeVersion`) — same
// "adapt typed-storage-effect to the domain schema" pattern as every other `*-repository-live.ts`/
// `*-collections.ts` module (`nodes-repository-live.ts`, `agent-edit-collections.ts`).
//
// Two collections, mirroring `App`'s own doc comment on the versioning model:
// - `apps`: one row per `App`, keyed by `id`, with a `byWorkspaceId` index (mainline `listApps`)
//   and a `byPendingChatId` index (mirrors `nodes-repository-live.ts`'s own — backs
//   `AgentEditService`'s `mergeChanges`/`revertChanges`/`reconcilePendingChanges` for Apps, exactly
//   the same "every pending row this chat produced, without a full-workspace scan" need).
// - `appCodeVersions`: one row per `(appId, kind, version)` — a versioned content blob, never
//   itself carrying a `pending` marker (see `AppCodeVersion`'s own doc comment for why: whether a
//   given row is "the accepted one" or "a pending proposal" is derived by comparing its `version`
//   against the parent `App`'s pointer, not stored redundantly here). `byAppIdKind` (composite
//   `${appId}:${kind}` key) finds every version of one code kind for one App — the query
//   `AppsService.updateAppCode`/`AgentEditService`'s `promoteApp`/`revertApp` need to find the
//   current max version (mainline write) or every ahead-of-pointer row (accept/revert). `byAppId`
//   finds every row regardless of kind — the query `deleteApp`/reconcile's reap path need to
//   cascade-delete an App's entire code history.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { App, AppCodeVersion, UnexpectedError, type EntityId } from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"

const appsCollectionSchema = collection<App>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (app: App) => app.workspaceId,
    // Mirrors `nodes-repository-live.ts`'s `byPendingChatId` doc comment exactly, substituting
    // App for Node: `null` (not the string `"undefined"`) for a mainline App with no outstanding
    // pending change, so such Apps are simply absent from this index.
    byPendingChatId: (app: App) => app.pending?.chatId ?? null
  }
})

/** Zero-padded `${appId}:${kind}:${version}` primary key — same "pad so lexicographic key order
 *  matches numeric order" technique `agent-edit-collections.ts`'s `changesMessageKey` and
 *  `sync-feed-service-live.ts`'s own key use, needed here so `byAppIdKind.get(...)` naturally
 *  yields versions in ascending order (useful for debugging/inspection; correctness here doesn't
 *  depend on ordering since callers reduce for the max version explicitly). Takes the minimal
 *  `{appId, kind, version}` shape (not a full `AppCodeVersion`) so a caller that only knows WHICH
 *  version it wants to address (e.g. `getAppCode`'s explicit-`version` lookup, `revertApp`'s
 *  ahead-of-pointer row deletion) never needs to construct/round-trip a throwaway full row just to
 *  compute a key (`Collection.get`/`.delete` both take a primary key, not a predicate). */
export const appCodeVersionKeyOf = (version: Pick<AppCodeVersion, "appId" | "kind" | "version">): string =>
  `${version.appId}:${version.kind}:${version.version.toString().padStart(12, "0")}`

/** Convenience overload of `appCodeVersionKeyOf` for the common case of already holding a full
 *  `AppCodeVersion` row (e.g. iterating rows just read back from `byAppIdKind`/`byAppId`). */
export const appCodeVersionKey = (version: AppCodeVersion): string => appCodeVersionKeyOf(version)

const appCodeVersionByAppIdKind = (version: AppCodeVersion): string => `${version.appId}:${version.kind}`

const appCodeVersionsCollectionSchema = collection<AppCodeVersion>()({
  primaryKey: appCodeVersionKey,
  nonUniqueIndexes: {
    byAppIdKind: appCodeVersionByAppIdKind,
    byAppId: (version: AppCodeVersion) => version.appId
  }
})

/** Every collection the App Library's backend stage needs, kept as its own type so
 *  `workspace-durable-object.ts` can build the storage handle once and hand it to both
 *  `AppsService` (mainline CRUD) and `AgentEditService` (agent-tool pending path + crash-safety
 *  reconciliation) without either re-deriving the schema — same "one `*Collections` interface,
 *  multiple consumers" shape as `WorkspaceCollections`/`FactsCollections`/`EdgesCollections`. */
export interface AppCollections {
  readonly apps: Collection<App, EntityId> & {
    readonly byWorkspaceId: NonUniqueIndex<App, EntityId>
    readonly byPendingChatId: NonUniqueIndex<App, EntityId>
  }
  readonly appCodeVersions: Collection<AppCodeVersion, string> & {
    readonly byAppIdKind: NonUniqueIndex<AppCodeVersion, string>
    readonly byAppId: NonUniqueIndex<AppCodeVersion, EntityId>
  }
}

/** Builds this DO instance's App Library storage handle once (called from the constructor, per
 *  the plan's "DO class boundary" pattern) against the same real `DurableObjectStorage` every
 *  other `make*Collections` call is given. */
export const makeAppCollections = (storage: DurableObjectStorage): AppCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: { apps: appsCollectionSchema, appCodeVersions: appCodeVersionsCollectionSchema }
  })
  return { apps: typedStorage.apps, appCodeVersions: typedStorage.appCodeVersions }
}

export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/**
 * App lifecycle revisions were added after the first App rows shipped.  A row without either
 * field is therefore a legacy row, not evidence that the App has never been accepted.  The
 * compatibility migration is deliberately conservative: it seeds both counters at revision 1.
 * This preserves an unknown historical App as accepted lineage, so a later revert can never
 * delete it merely because an old row lacked lifecycle metadata.  Future writes persist the
 * explicit counters; old in-flight proposals are reconciled by the decision path's equivalent
 * snapshot migration (see `agent-edit-service-live.ts`).
 */
export const migrateLegacyAppRecord = (raw: unknown): {
  readonly value: unknown
  readonly legacy: boolean
} => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { value: raw, legacy: false }
  const record = raw as Record<string, unknown>
  const missingRevision = typeof record.revision !== "number"
  const missingAcceptedRevision = typeof record.acceptedRevision !== "number"
  if (!missingRevision && !missingAcceptedRevision) return { value: raw, legacy: false }
  return {
    value: {
      ...record,
      revision: missingRevision ? 1 : record.revision,
      acceptedRevision: missingAcceptedRevision ? 1 : record.acceptedRevision
    },
    legacy: true
  }
}

/** Same "revive a schema-validated instance from a structurally-cloned plain object" need as
 *  every other repository's `reviveX` (see `nodes-repository-live.ts`'s `reviveNode` doc
 *  comment). */
export const reviveApp = (raw: unknown): Effect.Effect<App, UnexpectedError> => {
  const migrated = migrateLegacyAppRecord(raw).value
  return Schema.decodeUnknown(App)(migrated).pipe(
    Effect.mapError(
      (parseError) => new UnexpectedError({ message: `corrupt stored app: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )
}

export const reviveAppCodeVersion = (raw: unknown): Effect.Effect<AppCodeVersion, UnexpectedError> =>
  Schema.decodeUnknown(AppCodeVersion)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored app code version: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )
