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
import { Page, PageDocumentDescriptor, PageNotFound, PagesRepository, UnexpectedError, type EntityId } from "@athenaeum/domain"
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

interface PageDocumentFormatBase {
  readonly nodeId: EntityId
  readonly storageVersion: number
}

interface AutomergeFormatWitness {
  readonly docId: string
  readonly headsHash: string
  readonly bytesSha256: string
}

interface LoroFormatWitness {
  readonly schemaVersion: number
  readonly snapshotSha256: string
}

/** The format-routing record is separate from `Page` so a native Loro page does not need a
 * legacy `Page` row or Automerge blob. Missing rows mean the pre-migration default:
 * `automerge-v1`. Keep this as a strict storage union so malformed combinations fail closed at
 * the service boundary instead of being treated as a valid page format. */
export type PageDocumentFormatRow =
  | (PageDocumentFormatBase & {
      readonly activeFormat: "automerge-v1"
      readonly automerge: AutomergeFormatWitness
      readonly loro?: undefined
    })
  | (PageDocumentFormatBase & {
      readonly activeFormat: "loro-v1"
      readonly automerge: AutomergeFormatWitness
      readonly loro: LoroFormatWitness
    })
  | (PageDocumentFormatBase & {
      readonly activeFormat: "loro-v1"
      readonly automerge?: undefined
      readonly loro: LoroFormatWitness
    })

/** Immutable copy of the exact legacy Automerge bytes captured at Loro activation. */
export interface PageAutomergeSnapshotRow {
  readonly nodeId: EntityId
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly capturedAt: string
}

/** Current durable Loro state. Snapshots are used for persistence; version-vector updates stay on
 * the sync RPC wire. */
export interface LoroPageDocRow {
  readonly nodeId: EntityId
  readonly snapshot: Uint8Array
  readonly snapshotSha256: string
  readonly schemaVersion: number
  readonly updatedAt: string
}

const pageDocsCollectionSchema = collection<PageDocRow>()({
  primaryKey: "nodeId"
})

const pageDocumentFormatsCollectionSchema = collection<PageDocumentFormatRow>()({
  primaryKey: "nodeId"
})

const pageAutomergeSnapshotsCollectionSchema = collection<PageAutomergeSnapshotRow>()({
  primaryKey: "nodeId"
})

const loroPageDocsCollectionSchema = collection<LoroPageDocRow>()({
  primaryKey: "nodeId"
})

export interface PagesCollections {
  readonly pages: Collection<Page, EntityId>
  readonly pageDocs: Collection<PageDocRow, EntityId>
  readonly pageDocumentFormats: Collection<PageDocumentFormatRow, EntityId>
  readonly pageAutomergeSnapshots: Collection<PageAutomergeSnapshotRow, EntityId>
  readonly loroPageDocs: Collection<LoroPageDocRow, EntityId>
}

export const makePagesCollections = (storage: DurableObjectStorage): PagesCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: {
      pages: pagesCollectionSchema,
      pageDocs: pageDocsCollectionSchema,
      pageDocumentFormats: pageDocumentFormatsCollectionSchema,
      pageAutomergeSnapshots: pageAutomergeSnapshotsCollectionSchema,
      loroPageDocs: loroPageDocsCollectionSchema
    }
  })
  return {
    pages: typedStorage.pages,
    pageDocs: typedStorage.pageDocs,
    pageDocumentFormats: typedStorage.pageDocumentFormats,
    pageAutomergeSnapshots: typedStorage.pageAutomergeSnapshots,
    loroPageDocs: typedStorage.loroPageDocs
  }
}

export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
      : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/** Decode format-routing rows at the storage boundary as well as at the RPC boundary. The
 * collection is intentionally structural (typed-storage does not own Effect Schemas), so a bad
 * row must be rejected before service code branches on `activeFormat` or spreads witness fields.
 */
export const decodePageDocumentFormatRow = (
  raw: unknown
): Effect.Effect<PageDocumentFormatRow | undefined, UnexpectedError> =>
  raw === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknown(PageDocumentDescriptor)(raw).pipe(
        Effect.map((decoded) => decoded as PageDocumentFormatRow),
        Effect.mapError(
          (parseError) =>
            new UnexpectedError({
              message: `corrupt stored page document format: ${TreeFormatter.formatErrorSync(parseError)}`
            })
        )
      )

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
