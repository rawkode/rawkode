// Adapts `typed-storage-effect` to `@athenaeum/domain`'s `PagesRepository` — same pattern as
// `nodes-repository-live.ts`, keyed by `nodeId` (per `Page`'s own shape: a 1:0-or-1 companion to
// `Node`, not a row with its own `id`). Also declares `pageDocs`, the raw Automerge binary blob
// collection (plan §"Storage & domain model": "store each Page's Automerge document as a binary
// blob (in DO SQLite directly for Phase 1..., keyed by nodeId)") — deliberately *not* part of the
// `PagesRepository` `Context.Tag` interface (domain has no schema for "opaque CRDT bytes", by
// design — see page.ts's own doc comment: "document bytes... handled by the backend/storage
// layer... never schema-validated JSON here"), so it's exposed only via `PagesCollections` for
// `NotesServiceLive` to use directly, the same "raw collection, not a domain repository" pattern
// `tag-closure.ts`/`edges-repository-live.ts`'s indexes already establish.

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { Page, PageNotFound, PagesRepository, UnexpectedError, type EntityId } from "@athenaeum/domain"
import { collection, createEffectTypedStorage, type Collection, type TypedStorageError } from "@athenaeum/typed-storage-effect"

const pagesCollectionSchema = collection<Page>()({
  primaryKey: "nodeId"
})

/** One row of the raw Automerge document blob collection — `bytes` is the output of
 *  `Automerge.save(doc)`, the CRDT's own binary save format, opaque to everything except
 *  `notes-service-live.ts`'s `Automerge.load`/`Automerge.save` calls. */
export interface PageDocRow {
  readonly nodeId: EntityId
  readonly bytes: Uint8Array
}

const pageDocsCollectionSchema = collection<PageDocRow>()({
  primaryKey: "nodeId"
})

export interface PagesCollections {
  readonly pages: Collection<Page, EntityId>
  readonly pageDocs: Collection<PageDocRow, EntityId>
}

export const makePagesCollections = (storage: DurableObjectStorage): PagesCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: { pages: pagesCollectionSchema, pageDocs: pageDocsCollectionSchema }
  })
  return { pages: typedStorage.pages, pageDocs: typedStorage.pageDocs }
}

export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

export const revivePage = (raw: unknown): Effect.Effect<Page, UnexpectedError> =>
  Schema.decodeUnknown(Page)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored page: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

export const makePagesRepositoryLive = (collections: PagesCollections): Layer.Layer<PagesRepository> =>
  Layer.succeed(PagesRepository, {
    get: (nodeId) =>
      collections.pages.get(nodeId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap(
          (maybe): Effect.Effect<Page, PageNotFound | UnexpectedError> =>
            maybe === undefined ? Effect.fail(new PageNotFound({ nodeId })) : revivePage(maybe)
        )
      ),
    put: (page) => collections.pages.put(page).pipe(Effect.mapError(toUnexpectedError), Effect.as(page)),
    delete: (nodeId) =>
      collections.pages.delete(nodeId).pipe(Effect.mapError(toUnexpectedError), Effect.asVoid)
  })
