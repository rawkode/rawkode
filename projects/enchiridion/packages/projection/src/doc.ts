// @enchiridion/projection — Loro doc opening + the page-document container
// shape.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan
// §Backend architecture ("Projection tables") and §Phasing P1. This file is
// this package's one point of contact with `loro-crdt` — mirrors
// `workers/vault/src/loro-storage.ts`'s verified API choices (same package,
// same subpath import, same `configTextStyle` call before any read/write)
// rather than reinventing doc-opening, per the task brief. It is
// deliberately NOT an import of that file: `workers/vault` depends on this
// package (`workspace:*"` in its package.json), so the reverse dependency
// would be circular, and the task's constraints keep `workers/vault`
// untouched. What's reused is the verified *pattern* (exact package
// subpath, exact mark-style config, exact `fromSnapshot`/`getShallowValue`/
// `toDelta` calls — all cited against the same installed `loro-crdt@1.13.7`
// this file was checked against), not the file itself.
//
// CONTAINER SHAPE — mirrors `apps/swift/Sources/EnchiridionSync/
// PageDocument.swift` (the Swift-side equivalent this task names as the
// reference), NOT `workers/vault/src/projection.ts`'s P0 placeholder
// convention (a `system` map holding `modifiedAt`/`isPinned`). That P0
// convention was a stand-in written before any real page-document shape
// existed; `PageDocument.swift` is the actual, documented, tested doc shape
// a real client writes (five root containers — `root`, `objectMetadata`,
// `tags`, `values`, `edges` — plus `title`/`body` text), so this package
// targets that shape as the real cross-language contract. Reconciling
// `workers/vault`'s P0 placeholder with this shape is explicitly this
// task's follow-up wiring work, not done here (constraints: `workers/vault`
// is untouched).
//
//   - `root` (map): pageID, isPinned, deletedAt (ISO-8601 string, absent
//     when not deleted). `kind`/`createdAt` are intentionally NOT read from
//     here — mirrors the established VaultDO convention
//     (`workers/vault/src/projection.ts`'s `extractNodeFields` doc
//     comment: "NOT read from the doc itself — they come from the
//     vault-meta catalog entry ... duplicating that as an
//     independently-editable field inside every page's own doc would just
//     create a second place for it to drift from the catalog"). `kind` and
//     `catalogCreatedAt` are `projectPage()` parameters instead.
//   - `objectMetadata` (map): present for parity with `PageDocument.swift`.
//     Originally not read by this package (P1); now read for exactly two
//     keys, `personVisibility`/`personOrigin` (`index.ts`'s `projectPage()`
//     — the P4 adversarial-review privacy-gate fix: see `GraphNodeRow`'s
//     doc comment there and `workers/gatekeeper-google/src/
//     materialized-doc.ts`'s header for the writer side). Every other key
//     this container might ever hold is still unread by this package.
//   - `tags` (map): `supertagID -> true` for every supertag this page
//     carries directly (not the inherited closure — that's computed
//     separately, see `tags.ts`).
//   - `values` (map): `"property:<tagID>:<fieldID>" -> JSON string of a
//     `SupertagValue[]` array — the exact storage-key format
//     `@enchiridion/graph-core`'s `predicateId()` already produces, see
//     `values.ts`.
//   - `edges` (map): `edgeID -> JSON string of a KnowledgeEdge` — one
//     entry per canonical forward edge this page owns, matching
//     `PageDocument.swift`'s `edges` container and `decodedEdges` reader.
//   - `title` / `body` (text): rich-text containers, matching both
//     `PageDocument.swift` and `workers/vault/src/projection.ts`'s
//     agreeing convention (the one place the two references agree).
//
// `SupertagValue`/`KnowledgeEdge` ON-WIRE JSON SHAPE: `KnowledgeEdge` is a
// Swift struct with named fields, so its `Codable` synthesis is
// unambiguous (`{"id":...,"relationID":...,"sourceNodeID":...,
// "targetNodeID":...,"origin":...,"createdAt":...}`) and this package
// matches it exactly (see `edges.ts`). `SupertagValue` is a Swift *enum*
// with associated values — its synthesized single-key-per-case JSON shape
// (`{"text":"hello"}` vs. some other encoding) was not independently
// re-verified against the actual compiled Swift binary as part of this
// task (no golden-fixture requirement was given for property values here,
// unlike `graph-core`'s PageID digests), so this package defines its own
// explicit `{"type":"text","value":"hello"}` shape instead of guessing
// Swift's synthesis (see `values.ts`'s header). Reconciling the two is
// flagged as follow-up work, not done here.

import { LoroDoc, type LoroMap, type LoroText } from "loro-crdt/bundler";

export type { LoroDoc, LoroMap, LoroText } from "loro-crdt/bundler";

/** Root-container names this package reads, matching `PageDocument.swift`'s
 *  `Container` enum (`root`/`objectMetadata`/`tags`/`values`/`edges`) plus
 *  the `title`/`body` text containers both references agree on. */
export const PageContainer = {
  root: "root",
  objectMetadata: "objectMetadata",
  tags: "tags",
  values: "values",
  edges: "edges",
  title: "title",
  body: "body",
} as const;

/** Mirrors `loro-storage.ts`'s `MARK_STYLES` / `LoroEngine.MarkStyle`
 *  (LoroEngine.swift:53-69): the fixed rich-text mark vocabulary every page
 *  document is configured for. Needed before any `toDelta()` read that
 *  expects marks to resolve to attributes rather than being silently
 *  dropped (`configTextStyle` documented at loro_wasm.d.ts ~line 2065 as a
 *  prerequisite for both `mark`/`unmark` AND for `toDelta()` to report
 *  those marks back). */
const MARK_STYLES: Record<string, "before" | "after" | "none" | "both"> = {
  bold: "after",
  italic: "after",
  underline: "after",
  strikethrough: "after",
  code: "none",
  pageReference: "none",
};

function configureTextStyles(doc: LoroDoc): void {
  const styles: Record<string, { expand: "before" | "after" | "none" | "both" }> = {};
  for (const [key, expand] of Object.entries(MARK_STYLES)) {
    styles[key] = { expand };
  }
  doc.configTextStyle(styles);
}

/** Opens a page's raw Loro snapshot bytes for read-only projection.
 *  `LoroDoc.fromSnapshot` (loro_wasm.d.ts ~line 1966, documented example:
 *  "const loro = LoroDoc.fromSnapshot(bytes);") mirrors
 *  `loro-storage.ts`'s `LoroPageDoc.fromSnapshot` exactly. */
export function openProjectionDoc(bytes: Uint8Array): LoroDoc {
  const doc = LoroDoc.fromSnapshot(bytes);
  configureTextStyles(doc);
  return doc;
}

/** The shallow (no recursion into nested containers) contents of a root map
 *  as plain values — every container this package addresses holds only
 *  scalars, so `LoroMap.getShallowValue()` is exactly the one-call read
 *  needed, matching `PageDocument.swift`'s `scalarMap` helper and its
 *  rationale (LoroFFI's shallow form "will not convert the state of
 *  sub-containers, but represent them as [LoroValue::Container]" — no
 *  per-key round trips). */
export function shallowMap(map: LoroMap): Record<string, unknown> {
  return map.getShallowValue();
}

export function stringField(map: Record<string, unknown>, key: string): string | undefined {
  const value = map[key];
  return typeof value === "string" ? value : undefined;
}

export function booleanField(map: Record<string, unknown>, key: string): boolean | undefined {
  const value = map[key];
  return typeof value === "boolean" ? value : undefined;
}
