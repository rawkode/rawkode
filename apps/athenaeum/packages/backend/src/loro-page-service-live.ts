import * as Automerge from "@automerge/automerge"
import { LoroDoc, LoroList, LoroMap, LoroText, VersionVector } from "loro-crdt/bundler"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  AutomergePageDocumentDescriptor,
  canonicalAutomergeHeadsHash,
  EntityId,
  LegacyPageDocumentDescriptor,
  LoroPageDocumentDescriptor,
  MigratedLoroPageDocumentDescriptor,
  NativeLoroPageDocumentDescriptor,
  NodeNotFound,
  PageDocumentDescriptor,
  PageFormatMismatch,
  PageNotFound,
  PagesRepository,
  LORO_PAGE_META_CONTAINER,
  LORO_PROSEMIRROR_CONTAINER,
  LORO_PAGE_SCHEMA_VERSION,
  canonicalJsonBytes,
  LoroContentConflict,
  sha256HexSync,
  UnexpectedError,
  ValidationError,
  type PageDocumentFormat as PageDocumentFormatType
} from "@athenaeum/domain"
import { indexNodeText } from "./read-model.js"
import { NodesRepository } from "@athenaeum/domain"
import { SyncFeedService } from "./sync-feed-service-live.js"
import type {
  LoroPageDocRow,
  PageAutomergeSnapshotRow,
  PageDocumentFormatRow,
  PagesCollections
} from "./pages-repository-live.js"
import { decodePageDocumentFormatRow, toUnexpectedError } from "./pages-repository-live.js"
import type { PageProposalCollections } from "./page-proposal-collections.js"
import { validateLoroProseMirrorV1Tree } from "./loro-prosemirror-v1-contract.js"

/** Named root containers are part of the Loro document contract. Keeping metadata and the
 * ProseMirror tree separate means backend indexing never has to treat arbitrary map values as
 * note prose. */
export interface LoroPageSyncResult {
  readonly update: Uint8Array | null
  readonly serverVersion: Uint8Array
  readonly converged: boolean
  readonly reset: boolean
}

/** Wire encodings can differ while representing the same frontier. Fingerprints use this
 * sorted semantic identity, never the caller's raw vector bytes. */
export const loroVersionVectorIdentity = (vector: VersionVector): string => sha256HexSync(canonicalJsonBytes(
  [...vector.toJSON()].map(([peer, counter]) => ({ peer: String(peer), counter })).sort((a, b) =>
    BigInt(a.peer) < BigInt(b.peer) ? -1 : BigInt(a.peer) > BigInt(b.peer) ? 1 : 0
  )
))

/** These values cross only the internal Durable Object/service boundary.  Keeping the candidate
 * document out of RPC output makes cache publication an explicit post-commit operation. */
interface PreparedLoroActivation {
  readonly descriptor: PageDocumentDescriptor
  readonly candidate: LoroDoc | undefined
}

export const LEGACY_PROJECTION_MAX_UTF8_BYTES = 1024 * 1024
export const LEGACY_MIGRATION_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
export const LEGACY_PAGE_MIGRATION_ENGINE_VERSION = "automerge-flat-text-to-loro-v1" as const

export type LegacyPageContent =
  | { readonly kind: "plainText"; readonly text: string }
  | { readonly kind: "richTextUnsupported" }
  | { readonly kind: "tooLarge" }

interface PreparedLegacyMigration {
  readonly descriptor: PageDocumentDescriptor
  readonly candidate: LoroDoc | undefined
  readonly resultSnapshotSha256: string
  readonly resultSnapshotLength: number
}

export interface PreparedLoroContentCommit {
  readonly descriptor: PageDocumentDescriptor
  readonly candidate: LoroDoc
  readonly baseVersionVectorSha256: string
  readonly resultVersionVectorSha256: string
  readonly updateSha256: string
}

/** A durable Loro snapshot loaded without mutating the service cache. Internal authorities use
 * this as the replay candidate so later user edits are never replaced by the original report. */
export interface PreparedCurrentLoroPage {
  readonly descriptor: PageDocumentDescriptor
  readonly candidate: LoroDoc
  readonly text: string
}

/** A server-derived semantic text splice and the exact CAS evidence required to commit it.
 * This never crosses an RPC boundary: callers hand the update straight to `commitContent` in
 * the same Durable Object transaction. */
export interface PreparedLoroTextSplice {
  readonly text: string
  readonly expectedStorageVersion: number
  readonly expectedSnapshotSha256: string
  readonly expectedVersionVector: Uint8Array
  readonly update: Uint8Array
}

/** A server-derived meeting-preparation update. This is deliberately not persisted here: the
 * Workspace DO commits it through the semantic Loro ledger route in its transaction. */
export interface PreparedMeetingPreparation {
  readonly status: "created" | "alreadyPrepared"
  readonly expectedStorageVersion: number
  readonly expectedSnapshotSha256: string
  readonly expectedVersionVector: Uint8Array
  readonly update?: Uint8Array
}

interface PreparedLoroPageSync {
  readonly result: LoroPageSyncResult
  /** Publishes the candidate document and advances/deletes the protocol session together after
   * the enclosing storage transaction has committed. */
  readonly commit: () => void
}

interface LoroSessionState {
  readonly expectedOrdinal: number
}

export const loroPageServiceSessionCapTestHook: { maxSessions: number } = { maxSessions: 2048 }

/** Test-only observer for the legacy projection's single authoritative service read. */
export const legacyPageProjectionTestHook: { onRead?: () => void } = {}
/** Test-only post-commit seam. Production leaves this unset; tests can force a cache publication
 * failure after durable storage commits, then prove an exact replay repairs the cache from disk. */
export const loroPageServicePostCommitTestHook: {
  beforePublish?: (nodeId: EntityId) => void
} = {}

const storageFailure = (error: unknown): UnexpectedError =>
  error instanceof UnexpectedError
    ? error
    : new UnexpectedError({ message: `Loro page storage failure: ${error instanceof Error ? error.message : String(error)}` })

const timestamp = (): string => new Date().toISOString()

const activeFormatFromRow = (row: PageDocumentFormatRow | undefined): PageDocumentFormatType =>
  row?.activeFormat ?? "automerge-v1"

const readPageDocumentFormatRow = (
  collections: PagesCollections,
  nodeId: EntityId
): Effect.Effect<PageDocumentFormatRow | undefined, UnexpectedError> =>
  collections.pageDocumentFormats.get(nodeId).pipe(
    Effect.mapError(toUnexpectedError),
    Effect.flatMap(decodePageDocumentFormatRow)
  )

/** Shared guard for the legacy Automerge service. Missing format rows intentionally resolve to the
 * legacy format so every page created before this migration remains readable. */
export const requireAutomergePage = (
  collections: PagesCollections,
  nodeId: EntityId
): Effect.Effect<void, PageFormatMismatch | UnexpectedError> =>
  readPageDocumentFormatRow(collections, nodeId).pipe(
    Effect.flatMap((row) => {
      const actual = activeFormatFromRow(row)
      return actual === "automerge-v1"
        ? Effect.void
        : Effect.fail(new PageFormatMismatch({ nodeId, expected: "automerge-v1", actual }))
    })
  )

const descriptorFromRow = (row: PageDocumentFormatRow): PageDocumentDescriptor => {
  if (row.activeFormat === "automerge-v1") {
    return new LegacyPageDocumentDescriptor({
      nodeId: row.nodeId,
      activeFormat: row.activeFormat,
      storageVersion: row.storageVersion,
      automerge: new AutomergePageDocumentDescriptor({ ...row.automerge })
    })
  }
  const loro = new LoroPageDocumentDescriptor({ ...row.loro })
  return row.automerge === undefined
    ? new NativeLoroPageDocumentDescriptor({
        nodeId: row.nodeId,
        activeFormat: row.activeFormat,
        storageVersion: row.storageVersion,
        loro
      })
    : new MigratedLoroPageDocumentDescriptor({
        nodeId: row.nodeId,
        activeFormat: row.activeFormat,
        storageVersion: row.storageVersion,
        automerge: new AutomergePageDocumentDescriptor({ ...row.automerge }),
        loro
      })
}

type PagesRepositoryService = Context.Tag.Service<typeof PagesRepository>

interface AutomergeSource {
  readonly page: import("@athenaeum/domain").Page
  /** The one authoritative Automerge document decoded from `bytes`.  Legacy projections derive
   * both their text and their witness from this value so the two cannot observe different page
   * revisions. */
  readonly doc: Automerge.Doc<{ text: string; schemaVersion?: unknown }>
  readonly bytes: Uint8Array
  readonly bytesSha256: string
}

const loadAutomergeSource = (
  collections: PagesCollections,
  pagesRepository: PagesRepositoryService,
  nodeId: EntityId
): Effect.Effect<AutomergeSource, PageNotFound | UnexpectedError> =>
  Effect.gen(function* () {
    const page = yield* pagesRepository.get(nodeId)
    const row = yield* collections.pageDocs.get(nodeId).pipe(Effect.mapError(toUnexpectedError))
    if (row === undefined) {
      return yield* Effect.fail(
        new UnexpectedError({ message: `page ${nodeId} exists but its Automerge doc blob is missing` })
      )
    }
    const bytes = new Uint8Array(row.bytes)
    const doc = yield* Effect.try({
      try: () => Automerge.load<{ text: string; schemaVersion?: unknown }>(bytes),
      catch: (error) =>
        new UnexpectedError({ message: `page ${nodeId} has invalid stored Automerge bytes: ${String(error)}` })
    })
    const actualHeadsHash = canonicalAutomergeHeadsHash(Automerge.getHeads(doc))
    if (actualHeadsHash !== page.headsHash) {
      return yield* Effect.fail(
        new UnexpectedError({ message: `page ${nodeId} has stored Automerge bytes whose heads do not match its Page row` })
      )
    }
    return {
      page,
      doc,
      bytes,
      bytesSha256: sha256HexSync(bytes)
    }
  })

const validateAutomergeSnapshot = (
  collections: PagesCollections,
  nodeId: EntityId,
  source: AutomergeSource
): Effect.Effect<void, UnexpectedError> =>
  Effect.gen(function* () {
    const existingSnapshot = yield* collections.pageAutomergeSnapshots.get(nodeId).pipe(Effect.mapError(toUnexpectedError))
    if (existingSnapshot === undefined) return
    const existingSnapshotSha256 = sha256HexSync(existingSnapshot.bytes)
    if (
      existingSnapshotSha256 !== existingSnapshot.sha256 ||
      existingSnapshotSha256 !== source.bytesSha256
    ) {
      return yield* Effect.fail(
        new UnexpectedError({ message: `immutable Automerge snapshot integrity failure for ${nodeId}` })
      )
    }
  })

/** A deliberately narrow, lossless eligibility classifier shared by projection and migration.
 * It accepts only the pre-rich-text root shape whose *entire* text sequence is unmarked text;
 * any block, embed, mark, replacement glyph or unrecognised schema is withheld rather than
 * flattened into a misleading native/UI representation. */
const classifyLegacyPage = (doc: Automerge.Doc<{ text: string; schemaVersion?: unknown }>): LegacyPageContent => {
  const root = doc as unknown as Record<string, unknown>
  const keys = Object.keys(root)
  if (!keys.every((key) => key === "text" || key === "schemaVersion")) return { kind: "richTextUnsupported" }
  if (typeof root.text !== "string") return { kind: "richTextUnsupported" }
  if ("schemaVersion" in root && (typeof root.schemaVersion !== "number" || !Number.isInteger(root.schemaVersion) || root.schemaVersion < 1 || root.schemaVersion >= 2)) {
    return { kind: "richTextUnsupported" }
  }
  const text = root.text
  if (text.includes("\uFFFC") || new TextEncoder().encode(text).length > LEGACY_PROJECTION_MAX_UTF8_BYTES) {
    return new TextEncoder().encode(text).length > LEGACY_PROJECTION_MAX_UTF8_BYTES ? { kind: "tooLarge" } : { kind: "richTextUnsupported" }
  }
  try {
    const spans = Automerge.spans(doc, ["text"])
    if (!spans.every((span) => {
      if (span.type !== "text") return false
      // Automerge represents marks as a map-like object (not an array).  An empty
      // marks object is the only marked-text shape that is equivalent to plain
      // text; any non-empty mark map must remain an explicit rich-text case.
      if (!("marks" in span) || span.marks === undefined || span.marks === null) return true
      return typeof span.marks === "object" && Object.keys(span.marks).length === 0
    })) {
      return { kind: "richTextUnsupported" }
    }
  } catch {
    return { kind: "richTextUnsupported" }
  }
  return { kind: "plainText", text }
}

const createLoroPageWithText = (text: string): LoroDoc => {
  const doc = createEmptyLoroPage()
  const root = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
  const children = root.get("children")
  if (!(children instanceof LoroList)) throw new Error("Loro page root has no children")
  const paragraph = children.get(0)
  if (!(paragraph instanceof LoroMap)) throw new Error("Loro page has no paragraph")
  const paragraphChildren = paragraph.get("children")
  if (!(paragraphChildren instanceof LoroList)) throw new Error("Loro page paragraph has no children")
  const target = paragraphChildren.get(0)
  if (!(target instanceof LoroText)) throw new Error("Loro page paragraph has no text leaf")
  if (text.length > 0) target.insert(0, text)
  doc.commit()
  return doc
}

const derivePlainTextLoroPage = (text: string): LoroDoc => createLoroPageWithText(text)

/** A migrated Loro page keeps its Automerge source as an immutable witness. Validate that witness
 * on every migrated read/replay before trusting the Loro snapshot: the source row, exact bytes,
 * and descriptor hashes must still describe the same legacy document that was activated. Native
 * Loro pages intentionally skip this check because they have no legacy source. */
const validateMigratedAutomergeWitness = (
  collections: PagesCollections,
  pagesRepository: PagesRepositoryService,
  nodeId: EntityId,
  format: PageDocumentFormatRow
): Effect.Effect<void, PageNotFound | UnexpectedError> =>
  Effect.gen(function* () {
    if (format.activeFormat !== "loro-v1" || format.automerge === undefined) return
    const source = yield* loadAutomergeSource(collections, pagesRepository, nodeId)
    yield* validateAutomergeSnapshot(collections, nodeId, source)
    if (
      format.automerge.docId !== source.page.automergeDocId ||
      format.automerge.headsHash !== source.page.headsHash ||
      format.automerge.bytesSha256 !== source.bytesSha256
    ) {
      return yield* Effect.fail(
        new UnexpectedError({ message: `migrated Loro page ${nodeId} has an inconsistent Automerge witness` })
      )
    }
  })

const readChildren = (map: LoroMap): LoroList | undefined => {
  const children = map.get("children")
  return children instanceof LoroList ? children : undefined
}

const collectProseText = (value: unknown): string => {
  if (value instanceof LoroText) return value.toString()
  if (value instanceof LoroList) {
    let result = ""
    for (let index = 0; index < value.length; index++) result += collectProseText(value.get(index))
    return result
  }
  if (value instanceof LoroMap) {
    const children = readChildren(value)
    return children === undefined ? "" : collectProseText(children)
  }
  return ""
}

const pageText = (doc: LoroDoc): string => collectProseText(doc.getMap(LORO_PROSEMIRROR_CONTAINER))

/** Returns the text containers in the same depth-first order as `pageText`. Agent edits address
 * the stable flattened projection while preserving the surrounding ProseMirror/Loro structure. */
const proseTextLeaves = (value: unknown, leaves: Array<LoroText>): void => {
  if (value instanceof LoroText) {
    leaves.push(value)
    return
  }
  if (value instanceof LoroList) {
    for (let index = 0; index < value.length; index++) proseTextLeaves(value.get(index), leaves)
    return
  }
  if (value instanceof LoroMap) {
    const children = readChildren(value)
    if (children !== undefined) proseTextLeaves(children, leaves)
  }
}

const splicePageText = (
  doc: LoroDoc,
  index: number,
  deleteCount: number,
  insertText: string
): Effect.Effect<string, ValidationError> =>
  Effect.try({
    try: () => {
      const leaves: Array<LoroText> = []
      proseTextLeaves(doc.getMap(LORO_PROSEMIRROR_CONTAINER), leaves)
      const length = leaves.reduce((total, leaf) => total + leaf.length, 0)
      if (index > length || deleteCount > length - index) {
        throw new Error(`text splice ${index}:${deleteCount} is outside page length ${length}`)
      }

      let target: { readonly leaf: LoroText; readonly offset: number } | undefined
      let targetCursor = 0
      for (const leaf of leaves) {
        if (index >= targetCursor && index <= targetCursor + leaf.length) {
          target = { leaf, offset: index - targetCursor }
          break
        }
        targetCursor += leaf.length
      }
      if (target === undefined) throw new Error("Loro page has no editable text leaf")

      // Delete against the original flattened coordinate space. `cursor` advances by the
      // pre-edit leaf length, so a splice spanning multiple blocks cannot skip or double-delete
      // text after an earlier leaf shrinks.
      let cursor = 0
      let remaining = deleteCount
      for (const leaf of leaves) {
        const leafLength = leaf.length
        const start = Math.max(0, index - cursor)
        const count = Math.min(Math.max(0, leafLength - start), remaining)
        if (count > 0) {
          leaf.delete(start, count)
          remaining -= count
        }
        cursor += leafLength
      }
      if (insertText.length > 0) target.leaf.insert(target.offset, insertText)
      doc.commit()
      return pageText(doc)
    },
    catch: (error) => new ValidationError({ message: `invalid Loro text splice: ${String(error)}` })
  })

const importLoroSnapshot = (snapshot: Uint8Array): Effect.Effect<LoroDoc, ValidationError> =>
  Effect.try({
    try: () => {
      const doc = new LoroDoc()
      doc.import(snapshot)
      return doc
    },
    catch: (error) => new ValidationError({ message: `invalid Loro snapshot: ${String(error)}` })
  })

const validatePageDocument = (doc: LoroDoc, schemaVersion: number): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    if (schemaVersion !== LORO_PAGE_SCHEMA_VERSION) {
      return yield* Effect.fail(
        new ValidationError({ message: `unsupported Loro page schema version ${schemaVersion}` })
      )
    }
    const roots = doc.getShallowValue()
    const metadataId = roots[LORO_PAGE_META_CONTAINER]
    const rootId = roots[LORO_PROSEMIRROR_CONTAINER]
    const metadata = typeof metadataId === "string" ? doc.getContainerById(metadataId) : undefined
    const root = typeof rootId === "string" ? doc.getContainerById(rootId) : undefined
    if (!(metadata instanceof LoroMap) || !(root instanceof LoroMap)) {
      return yield* Effect.fail(
        new ValidationError({ message: "Loro page is missing required metadata or ProseMirror root maps" })
      )
    }
    const storedSchemaVersion = metadata.get("schemaVersion")
    if (storedSchemaVersion !== schemaVersion) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Loro page schema version ${String(storedSchemaVersion)} does not match ${schemaVersion}`
        })
      )
    }
    if (root.get("nodeName") !== "doc") {
      return yield* Effect.fail(
        new ValidationError({ message: `Loro page is missing the ${LORO_PROSEMIRROR_CONTAINER} document root` })
      )
    }
    yield* validateLoroProseMirrorV1Tree(root)
  })

const loadPersistedLoroPage = (
  collections: PagesCollections,
  nodeId: EntityId,
  format: PageDocumentFormatRow
): Effect.Effect<LoroDoc, ValidationError | UnexpectedError> =>
  Effect.gen(function* () {
    if (format.activeFormat !== "loro-v1" || format.loro === undefined) {
      return yield* Effect.fail(new ValidationError({ message: `page ${nodeId} has an incomplete Loro format descriptor` }))
    }
    if (format.loro.schemaVersion !== LORO_PAGE_SCHEMA_VERSION) {
      return yield* Effect.fail(
        new ValidationError({ message: `page ${nodeId} has unsupported Loro descriptor schema version ${format.loro.schemaVersion}` })
      )
    }
    const row = yield* collections.loroPageDocs.get(nodeId).pipe(Effect.mapError(toUnexpectedError))
    if (row === undefined) {
      return yield* Effect.fail(new UnexpectedError({ message: `Loro document for page ${nodeId} is missing` }))
    }
    if (row.schemaVersion !== format.loro.schemaVersion || row.schemaVersion !== LORO_PAGE_SCHEMA_VERSION) {
      return yield* Effect.fail(new ValidationError({ message: `page ${nodeId} has inconsistent Loro schema versions` }))
    }
    const snapshotSha256 = sha256HexSync(row.snapshot)
    if (row.snapshotSha256 !== snapshotSha256 || format.loro.snapshotSha256 !== snapshotSha256) {
      return yield* Effect.fail(new ValidationError({ message: `page ${nodeId} has an inconsistent Loro snapshot hash` }))
    }
    const doc = yield* importLoroSnapshot(row.snapshot)
    yield* validatePageDocument(doc, row.schemaVersion)
    return doc
  })

/** Canonical valid empty ProseMirror/Loro genesis. The backend validator intentionally requires
 * a document root to contain at least one block, so an empty note is represented by one empty
 * paragraph rather than a bare root list. Keep this shape in lockstep with the web helper in
 * `loro-page.ts`; both are the same official loro-prosemirror container contract. */
const createEmptyLoroPage = (): LoroDoc => {
  const doc = new LoroDoc()
  const metadata = doc.getMap(LORO_PAGE_META_CONTAINER)
  metadata.set("schemaVersion", LORO_PAGE_SCHEMA_VERSION)
  const root = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
  root.set("nodeName", "doc")
  const rootAttributes = root.getOrCreateContainer("attributes", new LoroMap())
  if (!(rootAttributes instanceof LoroMap)) throw new Error("failed to create Loro root attributes")
  rootAttributes.set("isAmgBlock", false)
  const rootChildren = root.getOrCreateContainer("children", new LoroList())
  if (!(rootChildren instanceof LoroList)) throw new Error("failed to create Loro root children")
  const paragraph = rootChildren.insertContainer(0, new LoroMap()).getAttached()
  if (!(paragraph instanceof LoroMap)) throw new Error("failed to create Loro paragraph")
  paragraph.set("nodeName", "paragraph")
  const paragraphAttributes = paragraph.getOrCreateContainer("attributes", new LoroMap())
  if (!(paragraphAttributes instanceof LoroMap)) throw new Error("failed to create Loro paragraph attributes")
  paragraphAttributes.set("isAmgBlock", false)
  const paragraphChildren = paragraph.getOrCreateContainer("children", new LoroList())
  if (!(paragraphChildren instanceof LoroList)) throw new Error("failed to create Loro paragraph children")
  paragraphChildren.insertContainer(0, new LoroText())
  doc.commit()
  return doc
}

const hasMeetingPreparation = (value: unknown, localDate: string, occurrenceKey: string): boolean => {
  if (value instanceof LoroMap) {
    const attributes = value.get("attributes")
    const marker = attributes instanceof LoroMap ? attributes.get("unknownBlock") : undefined
    if (marker instanceof LoroMap) {
      const attrs = marker.get("attrs")
      if (marker.get("type") === "athenaeum-meeting-prep" && attrs instanceof LoroMap &&
        attrs.get("schemaVersion") === 1 && attrs.get("localDate") === localDate && attrs.get("occurrenceKey") === occurrenceKey) return true
    }
    return hasMeetingPreparation(value.get("children"), localDate, occurrenceKey)
  }
  if (value instanceof LoroList) {
    for (let index = 0; index < value.length; index += 1) if (hasMeetingPreparation(value.get(index), localDate, occurrenceKey)) return true
  }
  return false
}

const appendMeetingPreparation = (doc: LoroDoc, localDate: string, occurrenceKey: string, attendeeNames: ReadonlyArray<string>): void => {
  const root = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
  const children = root.get("children")
  if (!(children instanceof LoroList)) throw new Error("Loro page root has no children")
  const block = children.insertContainer(children.length, new LoroMap()).getAttached()
  if (!(block instanceof LoroMap)) throw new Error("failed to create meeting preparation block")
  block.set("nodeName", "unknownBlock")
  const attributes = block.getOrCreateContainer("attributes", new LoroMap())
  if (!(attributes instanceof LoroMap)) throw new Error("meeting preparation block has no attributes")
  attributes.set("isAmgBlock", false)
  const marker = attributes.getOrCreateContainer("unknownBlock", new LoroMap())
  if (!(marker instanceof LoroMap)) throw new Error("meeting preparation marker has no map")
  marker.set("type", "athenaeum-meeting-prep")
  marker.set("parents", [])
  const markerAttrs = marker.getOrCreateContainer("attrs", new LoroMap())
  if (!(markerAttrs instanceof LoroMap)) throw new Error("meeting preparation marker has no attrs")
  markerAttrs.set("schemaVersion", 1)
  markerAttrs.set("localDate", localDate)
  markerAttrs.set("occurrenceKey", occurrenceKey)
  marker.set("isEmbed", false)
  const blockChildren = block.getOrCreateContainer("children", new LoroList())
  if (!(blockChildren instanceof LoroList)) throw new Error("meeting preparation block has no children")
  for (const text of ["Meeting preparation", ...(attendeeNames.length === 0 ? [] : [`People: ${attendeeNames.join(", ")}`]), "Context:", "Questions:", "Notes:"]) {
    const paragraph = blockChildren.insertContainer(blockChildren.length, new LoroMap()).getAttached()
    if (!(paragraph instanceof LoroMap)) throw new Error("failed to create meeting preparation paragraph")
    paragraph.set("nodeName", "paragraph")
    const paragraphAttributes = paragraph.getOrCreateContainer("attributes", new LoroMap())
    if (!(paragraphAttributes instanceof LoroMap)) throw new Error("meeting preparation paragraph has no attributes")
    paragraphAttributes.set("isAmgBlock", false)
    const paragraphChildren = paragraph.getOrCreateContainer("children", new LoroList())
    if (!(paragraphChildren instanceof LoroList)) throw new Error("meeting preparation paragraph has no children")
    const leaf = paragraphChildren.insertContainer(0, new LoroText()).getAttached()
    if (!(leaf instanceof LoroText)) throw new Error("meeting preparation paragraph has no text")
    leaf.insert(0, text)
  }
  doc.commit()
}

export class LoroPageService extends Context.Tag("@athenaeum/backend/LoroPageService")<
  LoroPageService,
  {
    /** Prepare a brand-new native Loro page. The caller owns the surrounding transaction and must
     * publish the returned candidate only after that transaction commits. */
    readonly create: (nodeId: EntityId) => Effect.Effect<
      PreparedLoroActivation,
      NodeNotFound | PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError
    >
    /** Creates a native page with its initial report text in one persistence operation. */
    readonly createWithText: (nodeId: EntityId, text: string) => Effect.Effect<
      PreparedLoroActivation,
      NodeNotFound | PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError
    >
    /** Loads the current durable page without changing the cache. */
    readonly prepareCurrent: (nodeId: EntityId) => Effect.Effect<
      PreparedCurrentLoroPage,
      NodeNotFound | PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError
    >
    readonly getDescriptor: (
      nodeId: EntityId
    ) => Effect.Effect<PageDocumentDescriptor, PageNotFound | ValidationError | UnexpectedError>
    /** Returns a safe legacy content projection and its complete Automerge witness from one decoded,
     * validated storage snapshot. This is intentionally separate from `getDescriptor`/`getText`:
     * callers that need both must not compose those two independently. */
    readonly getLegacyProjection: (
      nodeId: EntityId
    ) => Effect.Effect<{
      readonly content: LegacyPageContent
      readonly descriptor: LegacyPageDocumentDescriptor
    }, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError>
    /** Derives the only supported migration shape from the authoritative legacy document. */
    readonly migrateLegacy: (input: {
      readonly nodeId: EntityId
      readonly expectedStorageVersion: number
      readonly expectedAutomerge: AutomergePageDocumentDescriptor
    }) => Effect.Effect<PreparedLegacyMigration, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError>
    /** Reads the same flattened text projection addressed by semantic agent splices. */
    readonly getText: (nodeId: EntityId) => Effect.Effect<string, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError>
    /** Applies an already-bounded semantic update to a clone. The caller owns the ledger
     * transaction and must publish the candidate only after it commits. */
    readonly commitContent: (input: {
      readonly nodeId: EntityId
      readonly expectedStorageVersion: number
      readonly expectedSnapshotSha256: string
      readonly expectedVersionVector: Uint8Array
      readonly update: Uint8Array
    }) => Effect.Effect<PreparedLoroContentCommit, PageNotFound | PageFormatMismatch | LoroContentConflict | ValidationError | UnexpectedError>
    /** Builds a bounded flattened-text splice against the current authoritative Loro snapshot.
     * The returned update and CAS witnesses must be committed through `commitContent`; this
     * method itself never persists or mutates the document cache. */
    readonly prepareTextSplice: (input: {
      readonly nodeId: EntityId
      readonly index: number
      readonly deleteCount: number
      readonly insertText: string
    }) => Effect.Effect<PreparedLoroTextSplice, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError>
    readonly prepareMeeting: (input: { readonly nodeId: EntityId; readonly localDate: string; readonly occurrenceKey: string; readonly attendeeNames: ReadonlyArray<string> }) => Effect.Effect<PreparedMeetingPreparation, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError>
    readonly startSync: (
      nodeId: EntityId,
      sessionId: string
    ) => Effect.Effect<{ readonly message: Uint8Array; readonly serverVersion: Uint8Array }, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError>
    readonly receiveSyncMessage: (
      nodeId: EntityId,
      sessionId: string,
      ordinal: number,
      update: Uint8Array,
      clientVersion: Uint8Array
    ) => Effect.Effect<PreparedLoroPageSync, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError>
    /** Must run after the enclosing storage.transactionSync has returned successfully. */
    readonly publishCommittedDocument: (nodeId: EntityId, candidate: LoroDoc | undefined) => void
    /** Post-commit cache recovery for a ledger replay or an already-existing durable page. */
    readonly reloadCommittedDocument: (nodeId: EntityId) => Effect.Effect<void, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError>
  }
>() {}

export const makeLoroPageServiceLive = (
  collections: PagesCollections,
  proposalCollections: PageProposalCollections,
  sql: SqlStorage
): Layer.Layer<LoroPageService, never, PagesRepository | NodesRepository | SyncFeedService> =>
  Layer.effect(
    LoroPageService,
    Effect.gen(function* () {
      const pagesRepository = yield* PagesRepository
      const nodesRepository = yield* NodesRepository
      const syncFeed = yield* SyncFeedService
      const docCache = new Map<EntityId, LoroDoc>()
      const sessions = new Map<string, LoroSessionState>()

      const touchSession = (key: string, state: LoroSessionState): void => {
        sessions.delete(key)
        sessions.set(key, state)
        while (sessions.size > loroPageServiceSessionCapTestHook.maxSessions) {
          const oldest = sessions.keys().next().value
          if (oldest === undefined) break
          sessions.delete(oldest)
        }
      }

      const loadDoc = (
        nodeId: EntityId,
        options: { readonly forceReload?: boolean } = {}
      ): Effect.Effect<LoroDoc, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError> =>
        Effect.gen(function* () {
          const formatRow = yield* readPageDocumentFormatRow(collections, nodeId)
          if (formatRow?.activeFormat !== "loro-v1") {
            // Preserve the legacy not-found contract for a node that has never had a page. A
            // missing routing row alone means "pre-migration Automerge" only when the legacy
            // page/blob actually exists; do not turn a typoed node id into a format mismatch.
            if (formatRow === undefined) yield* pagesRepository.get(nodeId).pipe(Effect.asVoid)
            return yield* Effect.fail(new PageFormatMismatch({ nodeId, expected: "loro-v1", actual: "automerge-v1" }))
          }
          yield* validateMigratedAutomergeWitness(collections, pagesRepository, nodeId, formatRow)
          const cached = docCache.get(nodeId)
          if (!options.forceReload && cached !== undefined) return cached
          const doc = yield* loadPersistedLoroPage(collections, nodeId, formatRow)
          docCache.set(nodeId, doc)
          return doc
        })

      const reindex = (nodeId: EntityId, body: string): Effect.Effect<void, UnexpectedError> =>
        Effect.gen(function* () {
          const node = yield* nodesRepository.get(nodeId)
          yield* indexNodeText(sql, nodeId, node.title, body)
        }).pipe(
          Effect.catchTag("NodeNotFound", (error) =>
            Effect.fail(new UnexpectedError({ message: `graph_text_search reindex: missing node ${error.nodeId}` }))
          )
        )

      /** Persists and indexes a candidate inside the caller's storage transaction. Cache mutation
       * is deliberately excluded: the caller publishes only after the transaction commits. */
      const saveDoc = (nodeId: EntityId, doc: LoroDoc): Effect.Effect<void, UnexpectedError> =>
        Effect.gen(function* () {
          const snapshot = doc.export({ mode: "snapshot" })
          const snapshotSha256 = sha256HexSync(snapshot)
          const existingFormat = yield* readPageDocumentFormatRow(collections, nodeId)
          if (existingFormat?.activeFormat !== "loro-v1" || existingFormat.loro === undefined) {
            return yield* Effect.fail(new UnexpectedError({ message: `page ${nodeId} has no active Loro format descriptor` }))
          }
          const format: PageDocumentFormatRow = {
            ...existingFormat,
            storageVersion: existingFormat.storageVersion + 1,
            loro: { schemaVersion: LORO_PAGE_SCHEMA_VERSION, snapshotSha256 }
          }
          yield* collections.loroPageDocs.put({
            nodeId,
            snapshot,
            snapshotSha256,
            schemaVersion: LORO_PAGE_SCHEMA_VERSION,
            updatedAt: timestamp()
          } satisfies LoroPageDocRow).pipe(Effect.mapError(toUnexpectedError))
          yield* collections.pageDocumentFormats.put(format).pipe(Effect.mapError(toUnexpectedError))
          yield* reindex(nodeId, pageText(doc))
          yield* syncFeed.append("page", nodeId, "put", {
            nodeId,
            format: "loro-v1",
            snapshotSha256
          })
        }).pipe(Effect.mapError(storageFailure))

      const publishCommittedDocument = (nodeId: EntityId, candidate: LoroDoc | undefined): void => {
        if (candidate !== undefined) {
          loroPageServicePostCommitTestHook.beforePublish?.(nodeId)
          docCache.set(nodeId, candidate)
        }
      }

      const getDescriptor = (nodeId: EntityId): Effect.Effect<PageDocumentDescriptor, PageNotFound | ValidationError | UnexpectedError> =>
        Effect.gen(function* () {
          const stored = yield* readPageDocumentFormatRow(collections, nodeId)
          // Inspect the routing row first. Native Loro pages intentionally have no legacy `Page`
          // row or Automerge blob, so attempting `loadAutomergeSource` before this branch would
          // turn a valid Loro page into a false PageNotFound/corrupt-doc failure.
          if (stored?.activeFormat === "loro-v1") {
            yield* validateMigratedAutomergeWitness(collections, pagesRepository, nodeId, stored)
            yield* loadPersistedLoroPage(collections, nodeId, stored)
            return descriptorFromRow(stored)
          }

          const source = yield* loadAutomergeSource(collections, pagesRepository, nodeId)
          yield* validateAutomergeSnapshot(collections, nodeId, source)
          if (stored !== undefined) return descriptorFromRow(stored)
          return new LegacyPageDocumentDescriptor({
            nodeId,
            activeFormat: "automerge-v1",
            storageVersion: 1,
            automerge: new AutomergePageDocumentDescriptor({
              docId: source.page.automergeDocId,
              headsHash: source.page.headsHash,
              bytesSha256: source.bytesSha256
            })
          })
        })

      const getLegacyProjection = (nodeId: EntityId): Effect.Effect<{
        readonly content: LegacyPageContent
        readonly descriptor: LegacyPageDocumentDescriptor
      }, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError> =>
        Effect.gen(function* () {
          legacyPageProjectionTestHook.onRead?.()
          const stored = yield* readPageDocumentFormatRow(collections, nodeId)
          const actual = activeFormatFromRow(stored)
          if (actual !== "automerge-v1") {
            return yield* Effect.fail(new PageFormatMismatch({
              nodeId,
              expected: "automerge-v1",
              actual
            }))
          }
          const source = yield* loadAutomergeSource(collections, pagesRepository, nodeId)
          yield* validateAutomergeSnapshot(collections, nodeId, source)
          return {
            content: classifyLegacyPage(source.doc),
            descriptor: new LegacyPageDocumentDescriptor({
              nodeId,
              activeFormat: "automerge-v1",
              storageVersion: stored?.storageVersion ?? 1,
              automerge: new AutomergePageDocumentDescriptor({
                docId: source.page.automergeDocId,
                headsHash: source.page.headsHash,
                bytesSha256: source.bytesSha256
              })
            })
          }
        })

      const migrateLegacy = (input: {
        readonly nodeId: EntityId
        readonly expectedStorageVersion: number
        readonly expectedAutomerge: AutomergePageDocumentDescriptor
      }): Effect.Effect<PreparedLegacyMigration, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError> =>
        Effect.gen(function* () {
          const stored = yield* readPageDocumentFormatRow(collections, input.nodeId)
          const actual = activeFormatFromRow(stored)
          if (actual !== "automerge-v1") {
            return yield* Effect.fail(new PageFormatMismatch({ nodeId: input.nodeId, expected: "automerge-v1", actual }))
          }
          const storageVersion = stored?.storageVersion ?? 1
          const source = yield* loadAutomergeSource(collections, pagesRepository, input.nodeId)
          yield* validateAutomergeSnapshot(collections, input.nodeId, source)
          const actualWitness = new AutomergePageDocumentDescriptor({
            docId: source.page.automergeDocId, headsHash: source.page.headsHash, bytesSha256: source.bytesSha256
          })
          if (storageVersion !== input.expectedStorageVersion || actualWitness.docId !== input.expectedAutomerge.docId || actualWitness.headsHash !== input.expectedAutomerge.headsHash || actualWitness.bytesSha256 !== input.expectedAutomerge.bytesSha256) {
            return yield* Effect.fail(new ValidationError({ message: `page ${input.nodeId} changed; refresh the full Automerge witness before migration` }))
          }
          const proposals = yield* proposalCollections.proposals.byNode.get(input.nodeId).pipe(Effect.mapError(storageFailure))
          if (proposals.some(({ proposal }) => proposal.status !== "reverted")) {
            return yield* Effect.fail(new ValidationError({ message: `page ${input.nodeId} has non-reverted Automerge proposal history` }))
          }
          const content = classifyLegacyPage(source.doc)
          if (content.kind !== "plainText") {
            return yield* Effect.fail(new ValidationError({ message: content.kind === "tooLarge" ? `page ${input.nodeId} exceeds the plain-text migration limit` : `page ${input.nodeId} requires rich-text migration` }))
          }
          const candidate = yield* Effect.try({
            try: () => derivePlainTextLoroPage(content.text),
            catch: (error) => new ValidationError({ message: `failed to derive Loro page: ${String(error)}` })
          })
          yield* validatePageDocument(candidate, LORO_PAGE_SCHEMA_VERSION)
          if (pageText(candidate) !== content.text) {
            return yield* Effect.fail(new ValidationError({ message: `derived Loro text does not exactly match the legacy source` }))
          }
          const snapshot = candidate.export({ mode: "snapshot" })
          if (snapshot.length === 0 || snapshot.length > LEGACY_MIGRATION_MAX_SNAPSHOT_BYTES) {
            return yield* Effect.fail(new ValidationError({ message: `derived Loro snapshot exceeds migration size limit` }))
          }
          const snapshotSha256 = sha256HexSync(snapshot)
          const immutable: PageAutomergeSnapshotRow = { nodeId: input.nodeId, bytes: new Uint8Array(source.bytes), sha256: source.bytesSha256, capturedAt: timestamp() }
          const existingSnapshot = yield* collections.pageAutomergeSnapshots.get(input.nodeId).pipe(Effect.mapError(toUnexpectedError))
          if (existingSnapshot === undefined) yield* collections.pageAutomergeSnapshots.put(immutable).pipe(Effect.mapError(toUnexpectedError))
          const row: PageDocumentFormatRow = {
            nodeId: input.nodeId, activeFormat: "loro-v1", storageVersion: storageVersion + 1,
            automerge: { docId: actualWitness.docId, headsHash: actualWitness.headsHash, bytesSha256: actualWitness.bytesSha256 },
            loro: { schemaVersion: LORO_PAGE_SCHEMA_VERSION, snapshotSha256 }
          }
          yield* collections.loroPageDocs.put({ nodeId: input.nodeId, snapshot, snapshotSha256, schemaVersion: LORO_PAGE_SCHEMA_VERSION, updatedAt: timestamp() } satisfies LoroPageDocRow).pipe(Effect.mapError(toUnexpectedError))
          yield* collections.pageDocumentFormats.put(row).pipe(Effect.mapError(toUnexpectedError))
          yield* reindex(input.nodeId, pageText(candidate))
          yield* syncFeed.append("page", input.nodeId, "put", { nodeId: input.nodeId, format: "loro-v1", snapshotSha256 })
          return { descriptor: descriptorFromRow(row), candidate, resultSnapshotSha256: snapshotSha256, resultSnapshotLength: snapshot.length }
        })

      const getText = (nodeId: EntityId): Effect.Effect<string, PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError> =>
        loadDoc(nodeId).pipe(Effect.map(pageText))

      const createPage = (nodeId: EntityId, initialText: string): Effect.Effect<PreparedLoroActivation, NodeNotFound | PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError> =>
        Effect.gen(function* () {
          // Resolve the node before any page-format or document writes. A missing node is a
          // caller error, not a reindex/storage defect, and must remain typed at the boundary.
          yield* nodesRepository.get(nodeId)

          const existingFormat = yield* readPageDocumentFormatRow(collections, nodeId)
          if (existingFormat !== undefined) {
            if (existingFormat.activeFormat === "loro-v1") {
              yield* validateMigratedAutomergeWitness(collections, pagesRepository, nodeId, existingFormat)
              yield* loadPersistedLoroPage(collections, nodeId, existingFormat)
              return { descriptor: descriptorFromRow(existingFormat), candidate: undefined }
            }
            return yield* Effect.fail(new PageFormatMismatch({ nodeId, expected: "loro-v1", actual: "automerge-v1" }))
          }

          // A legacy page created before the format row existed must not be shadowed by a native
          // Loro document. Reject before touching any Loro rows.
          const existingLegacyPage = yield* collections.pages.get(nodeId).pipe(Effect.mapError(toUnexpectedError))
          if (existingLegacyPage !== undefined) {
            return yield* Effect.fail(new PageFormatMismatch({ nodeId, expected: "loro-v1", actual: "automerge-v1" }))
          }

          const doc = createLoroPageWithText(initialText)
          yield* validatePageDocument(doc, LORO_PAGE_SCHEMA_VERSION)
          const snapshot = doc.export({ mode: "snapshot" })
          const snapshotSha256 = sha256HexSync(snapshot)
          const row: PageDocumentFormatRow = {
            nodeId,
            activeFormat: "loro-v1",
            storageVersion: 1,
            loro: { schemaVersion: LORO_PAGE_SCHEMA_VERSION, snapshotSha256 }
          }
          yield* collections.loroPageDocs.put({
            nodeId,
            snapshot,
            snapshotSha256,
            schemaVersion: LORO_PAGE_SCHEMA_VERSION,
            updatedAt: timestamp()
          } satisfies LoroPageDocRow).pipe(Effect.mapError(toUnexpectedError))
          yield* collections.pageDocumentFormats.put(row).pipe(Effect.mapError(toUnexpectedError))
          yield* reindex(nodeId, pageText(doc))
          yield* syncFeed.append("page", nodeId, "put", { nodeId, format: "loro-v1", snapshotSha256 })
          return {
            descriptor: new NativeLoroPageDocumentDescriptor({
              nodeId,
              activeFormat: "loro-v1",
              storageVersion: 1,
              loro: new LoroPageDocumentDescriptor({
                schemaVersion: LORO_PAGE_SCHEMA_VERSION,
                snapshotSha256
              })
            }),
            candidate: doc
          }
        })

      const prepareCurrent = (nodeId: EntityId): Effect.Effect<PreparedCurrentLoroPage, NodeNotFound | PageNotFound | PageFormatMismatch | ValidationError | UnexpectedError> =>
        Effect.gen(function* () {
          yield* nodesRepository.get(nodeId)
          const stored = yield* readPageDocumentFormatRow(collections, nodeId)
          if (stored?.activeFormat !== "loro-v1" || stored.loro === undefined) {
            if (stored === undefined) yield* pagesRepository.get(nodeId).pipe(Effect.asVoid)
            return yield* Effect.fail(new PageFormatMismatch({ nodeId, expected: "loro-v1", actual: "automerge-v1" }))
          }
          const candidate = yield* loadPersistedLoroPage(collections, nodeId, stored)
          return { descriptor: descriptorFromRow(stored), candidate, text: pageText(candidate) }
        })

      return {
        create: (nodeId) => createPage(nodeId, ""),
        createWithText: (nodeId, text) => createPage(nodeId, text),
        prepareCurrent,
        getText,
        // Ledger replay has no candidate to publish. It must replace a potentially stale cache
        // with the durable snapshot, rather than treating the normal hot-path cache as authority.
        reloadCommittedDocument: (nodeId) => loadDoc(nodeId, { forceReload: true }).pipe(Effect.asVoid),
        getDescriptor,
        getLegacyProjection,
        migrateLegacy,
        commitContent: (input) =>
          Effect.gen(function* () {
            const format = yield* readPageDocumentFormatRow(collections, input.nodeId)
            if (format?.activeFormat !== "loro-v1" || format.loro === undefined) {
              return yield* Effect.fail(new PageFormatMismatch({ nodeId: input.nodeId, expected: "loro-v1", actual: "automerge-v1" }))
            }
            if (format.storageVersion !== input.expectedStorageVersion || format.loro.snapshotSha256 !== input.expectedSnapshotSha256) {
              const current = yield* loadPersistedLoroPage(collections, input.nodeId, format)
              let expected: VersionVector
              try { expected = VersionVector.decode(input.expectedVersionVector) } catch (error) {
                return yield* Effect.fail(new ValidationError({ message: `invalid expected Loro version vector: ${String(error)}` }))
              }
              return yield* Effect.fail(new LoroContentConflict({ nodeId: input.nodeId, expectedStorageVersion: input.expectedStorageVersion, currentStorageVersion: format.storageVersion, expectedSnapshotSha256: input.expectedSnapshotSha256, currentSnapshotSha256: format.loro.snapshotSha256, expectedVersionVectorSha256: loroVersionVectorIdentity(expected), currentVersionVectorSha256: loroVersionVectorIdentity(current.version()), message: `Loro page ${input.nodeId} changed; refresh before committing content` }))
            }
            const base = yield* loadPersistedLoroPage(collections, input.nodeId, format)
            let expected: VersionVector
            try { expected = VersionVector.decode(input.expectedVersionVector) } catch (error) {
              return yield* Effect.fail(new ValidationError({ message: `invalid expected Loro version vector: ${String(error)}` }))
            }
            const baseVector = base.version()
            if (expected.compare(baseVector) !== 0) {
              return yield* Effect.fail(new LoroContentConflict({ nodeId: input.nodeId, expectedStorageVersion: input.expectedStorageVersion, currentStorageVersion: format.storageVersion, expectedSnapshotSha256: input.expectedSnapshotSha256, currentSnapshotSha256: format.loro.snapshotSha256, expectedVersionVectorSha256: loroVersionVectorIdentity(expected), currentVersionVectorSha256: loroVersionVectorIdentity(baseVector), message: `Loro page ${input.nodeId} has a conflicting version vector` }))
            }
            const candidate = yield* importLoroSnapshot(base.export({ mode: "snapshot" }))
            try { candidate.import(input.update) } catch (error) {
              return yield* Effect.fail(new ValidationError({ message: `invalid Loro update: ${String(error)}` }))
            }
            yield* validatePageDocument(candidate, LORO_PAGE_SCHEMA_VERSION)
            const resultVector = candidate.version().encode()
            if (candidate.version().compare(baseVector) !== 1) {
              return yield* Effect.fail(new ValidationError({ message: "Loro update did not advance the document version" }))
            }
            yield* saveDoc(input.nodeId, candidate)
            const persisted = yield* readPageDocumentFormatRow(collections, input.nodeId)
            if (persisted === undefined) return yield* Effect.fail(new UnexpectedError({ message: "Loro commit lost its format descriptor" }))
            return {
              descriptor: descriptorFromRow(persisted), candidate,
              baseVersionVectorSha256: loroVersionVectorIdentity(baseVector),
              resultVersionVectorSha256: loroVersionVectorIdentity(candidate.version()),
              updateSha256: sha256HexSync(input.update)
            }
          }),
        prepareTextSplice: (input) =>
          Effect.gen(function* () {
            const format = yield* readPageDocumentFormatRow(collections, input.nodeId)
            if (format?.activeFormat !== "loro-v1" || format.loro === undefined) {
              return yield* Effect.fail(new PageFormatMismatch({ nodeId: input.nodeId, expected: "loro-v1", actual: "automerge-v1" }))
            }
            const base = yield* loadPersistedLoroPage(collections, input.nodeId, format)
            const expectedVersionVector = base.version().encode()
            const candidate = yield* importLoroSnapshot(base.export({ mode: "snapshot" }))
            const text = yield* splicePageText(candidate, input.index, input.deleteCount, input.insertText)
            const update = candidate.export({ mode: "update", from: VersionVector.decode(expectedVersionVector) })
            if (update.length === 0) {
              return yield* Effect.fail(new ValidationError({ message: "Loro text splice did not produce an update" }))
            }
            return {
              text,
              expectedStorageVersion: format.storageVersion,
              expectedSnapshotSha256: format.loro.snapshotSha256,
              expectedVersionVector,
              update
            }
          }),
        prepareMeeting: (input) =>
          Effect.gen(function* () {
            const format = yield* readPageDocumentFormatRow(collections, input.nodeId)
            if (format?.activeFormat !== "loro-v1" || format.loro === undefined) {
              return yield* Effect.fail(new PageFormatMismatch({ nodeId: input.nodeId, expected: "loro-v1", actual: "automerge-v1" }))
            }
            const base = yield* loadPersistedLoroPage(collections, input.nodeId, format)
            const expectedVersionVector = base.version().encode()
            if (hasMeetingPreparation(base.getMap(LORO_PROSEMIRROR_CONTAINER), input.localDate, input.occurrenceKey)) {
              return { status: "alreadyPrepared" as const, expectedStorageVersion: format.storageVersion, expectedSnapshotSha256: format.loro.snapshotSha256, expectedVersionVector }
            }
            const candidate = yield* importLoroSnapshot(base.export({ mode: "snapshot" }))
            appendMeetingPreparation(candidate, input.localDate, input.occurrenceKey, input.attendeeNames)
            yield* validatePageDocument(candidate, LORO_PAGE_SCHEMA_VERSION)
            const update = candidate.export({ mode: "update", from: VersionVector.decode(expectedVersionVector) })
            if (update.length === 0) return yield* Effect.fail(new ValidationError({ message: "meeting preparation did not produce a Loro update" }))
            return { status: "created" as const, expectedStorageVersion: format.storageVersion, expectedSnapshotSha256: format.loro.snapshotSha256, expectedVersionVector, update }
          }),
        startSync: (nodeId, sessionId) =>
          Effect.gen(function* () {
            const doc = yield* loadDoc(nodeId)
            const key = `${nodeId}:${sessionId}`
            touchSession(key, { expectedOrdinal: 0 })
            return { message: doc.export({ mode: "snapshot" }), serverVersion: doc.version().encode() }
          }),
        receiveSyncMessage: (nodeId, sessionId, ordinal, update, clientVersion) =>
          Effect.gen(function* () {
            const doc = yield* loadDoc(nodeId)
            const key = `${nodeId}:${sessionId}`
            const session = sessions.get(key)
            if (session === undefined || session.expectedOrdinal !== ordinal) {
              return {
                result: { update: null, serverVersion: doc.version().encode(), converged: false, reset: true },
                // A reset is a prepared session deletion. Keeping it deferred means a transaction
                // failpoint does not discard the caller's still-retryable session.
                commit: () => { sessions.delete(key) }
              }
            }

            let candidate = doc
            let changed = false
            try {
              if (update.length > 0) {
                candidate = yield* importLoroSnapshot(doc.export({ mode: "snapshot" }))
                candidate.import(update)
                yield* validatePageDocument(candidate, LORO_PAGE_SCHEMA_VERSION)
                changed = true
              }
              const clientVector = VersionVector.decode(clientVersion)
              const response = candidate.export({ mode: "update", from: clientVector })
              const converged = candidate.version().compare(clientVector) === 0
              if (changed) yield* saveDoc(nodeId, candidate)
              return {
                result: {
                  update: converged ? null : response.length === 0 ? null : response,
                  serverVersion: candidate.version().encode(),
                  converged,
                  reset: false
                },
                commit: () => {
                  if (changed) docCache.set(nodeId, candidate)
                  // Even a no-content-change message advances the session ordinal. This is
                  // protocol state, so publish it alongside the candidate cache update.
                  touchSession(key, { expectedOrdinal: ordinal + 1 })
                }
              }
            } catch (error) {
              if (error instanceof ValidationError) return yield* Effect.fail(error)
              return yield* Effect.fail(new UnexpectedError({ message: `Loro sync failed: ${String(error)}` }))
            }
          }),
        publishCommittedDocument
      }
    })
  )
