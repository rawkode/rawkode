import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"

/**
 * The replication/persistence format currently active for a page body. Formats are explicit so
 * clients never decode one CRDT's bytes with another CRDT's protocol.
 */
export const PageDocumentFormat = Schema.Literal("automerge-v1", "loro-v1")

export type PageDocumentFormat = Schema.Schema.Type<typeof PageDocumentFormat>

/** Immutable identity and integrity data for the legacy Automerge source document. */
export class AutomergePageDocumentDescriptor extends Schema.Class<AutomergePageDocumentDescriptor>(
  "AutomergePageDocumentDescriptor"
)({
  docId: Schema.String.pipe(Schema.minLength(1)),
  headsHash: Schema.String.pipe(Schema.minLength(1)),
  bytesSha256: Schema.String.pipe(Schema.minLength(1))
}) {}

/** Integrity data for a Loro snapshot stored alongside a legacy Automerge source document. */
export class LoroPageDocumentDescriptor extends Schema.Class<LoroPageDocumentDescriptor>(
  "LoroPageDocumentDescriptor"
)({
  schemaVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  snapshotSha256: Schema.String.pipe(Schema.minLength(1))
}) {}

/** Common fields for the strict page-document descriptor union below. */
const pageDocumentDescriptorFields = {
  nodeId: EntityId,
  storageVersion: Schema.Number.pipe(Schema.int(), Schema.positive())
} as const

/** A page that still uses the legacy Automerge document as its authority. */
export class LegacyPageDocumentDescriptor extends Schema.Class<LegacyPageDocumentDescriptor>(
  "LegacyPageDocumentDescriptor"
)({
  ...pageDocumentDescriptorFields,
  activeFormat: Schema.Literal("automerge-v1"),
  automerge: AutomergePageDocumentDescriptor,
  // A legacy row cannot carry a Loro witness. Declaring the forbidden field explicitly prevents
  // Effect Schema's Struct decoder from silently stripping a malformed mixed-format record.
  loro: Schema.optional(Schema.Never)
}) {}

/** A Loro page migrated from an Automerge source. The immutable Automerge witness remains
 * present so activation can be audited and old clients can be kept out of the Loro path. */
export class MigratedLoroPageDocumentDescriptor extends Schema.Class<MigratedLoroPageDocumentDescriptor>(
  "MigratedLoroPageDocumentDescriptor"
)({
  ...pageDocumentDescriptorFields,
  activeFormat: Schema.Literal("loro-v1"),
  automerge: AutomergePageDocumentDescriptor,
  loro: LoroPageDocumentDescriptor
}) {}

/** A native Loro page created without an Automerge source. */
export class NativeLoroPageDocumentDescriptor extends Schema.Class<NativeLoroPageDocumentDescriptor>(
  "NativeLoroPageDocumentDescriptor"
)({
  ...pageDocumentDescriptorFields,
  activeFormat: Schema.Literal("loro-v1"),
  // Native Loro pages have no Automerge witness. Keep the forbidden field in the schema as an
  // optional Never so a stale/malicious Automerge payload is rejected instead of discarded.
  automerge: Schema.optional(Schema.Never),
  loro: LoroPageDocumentDescriptor
}) {}

/**
 * Format-routing record for one page body. This is intentionally a strict union rather than a
 * bag of optional fields: legacy Automerge pages require their Automerge witness, migrated Loro
 * pages retain that witness, and native Loro pages contain no Automerge metadata at all.
 *
 * `storageVersion` is the monotonic durable revision of this page-document record, not a format
 * or schema constant: activation/creation creates revision 1 and each persisted Loro snapshot
 * advances it atomically with the snapshot and its hashes.
 */
export const PageDocumentDescriptor = Schema.Union(
  LegacyPageDocumentDescriptor,
  MigratedLoroPageDocumentDescriptor,
  NativeLoroPageDocumentDescriptor
)

export type PageDocumentDescriptor = Schema.Schema.Type<typeof PageDocumentDescriptor>
