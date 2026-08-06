// @enchiridion/projection — test-only page-document builder.
//
// NOT exported from `index.ts` (this package's public surface is the
// reader/projector, not a doc-authoring API — see `edges.ts`'s header for
// why `buildEdgeEntry` is the one write-time exception, needed by this
// file). Builds a page document directly against `loro-crdt`, matching the
// exact container shape `doc.ts` documents (`root`/`objectMetadata`/
// `tags`/`values`/`edges`/`title`/`body`), so tests exercise the SAME doc
// shape `projectPage()` reads — no separate "mock projection input" shape
// that could silently drift from what a real doc looks like.

import { LoroDoc } from "loro-crdt/bundler";
import type { SupertagPropertyKey, SupertagRegistry } from "@enchiridion/schema";
import { PageContainer } from "./doc";
import { buildEdgeEntry, type GraphEdgeOrigin } from "./edges";
import { encodePageReferencePayload } from "./text";
import { encodePropertyValues, propertyStorageKey, type SupertagValue } from "./values";

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
  for (const [key, expand] of Object.entries(MARK_STYLES)) styles[key] = { expand };
  doc.configTextStyle(styles);
}

/** A fresh, correctly-configured page document — the test-only equivalent
 *  of `PageDocument.create` (PageDocument.swift:266-296), minus the
 *  size-limit enforcement `mutate()` does there (irrelevant for fixtures). */
export function createFixtureDoc(pageID: string): LoroDoc {
  const doc = new LoroDoc();
  configureTextStyles(doc);
  doc.getMap(PageContainer.root).set("pageID", pageID);
  doc.getMap(PageContainer.root).set("isPinned", false);
  doc.commit();
  return doc;
}

/** Reopens a document from previously-exported snapshot bytes, configured
 *  identically to `createFixtureDoc` — mirrors `openProjectionDoc`
 *  (`doc.ts`) but returns the mutable `LoroDoc`, for tests that need to
 *  keep writing (e.g. simulating a second replica starting from a shared
 *  base state). */
export function reopenFixtureDoc(bytes: Uint8Array): LoroDoc {
  const doc = LoroDoc.fromSnapshot(bytes);
  configureTextStyles(doc);
  return doc;
}

export function setTitle(doc: LoroDoc, title: string): void {
  doc.getText(PageContainer.title).insert(0, title);
  doc.commit();
}

export function setBody(doc: LoroDoc, body: string): void {
  doc.getText(PageContainer.body).insert(0, body);
  doc.commit();
}

/** Applies a bold/italic/underline/strikethrough/code mark over
 *  `[start,end)` (unicode-scalar == UTF-16 offsets for the ASCII-only
 *  fixture text this package's tests use). */
export function markBody(doc: LoroDoc, start: number, end: number, style: string): void {
  doc.getText(PageContainer.body).mark({ start, end }, style, true);
  doc.commit();
}

/** Applies a page-reference mark over `[start,end)` pointing at
 *  `targetPageID`, matching `PageDocument.addPageReferenceMark`'s payload
 *  shape (`text.ts`'s `encodePageReferencePayload`). */
export function markPageReference(
  doc: LoroDoc,
  start: number,
  end: number,
  targetPageID: string,
  label: string,
): void {
  doc
    .getText(PageContainer.body)
    .mark({ start, end }, "pageReference", encodePageReferencePayload(targetPageID, label));
  doc.commit();
}

export function addTag(doc: LoroDoc, tagID: string): void {
  doc.getMap(PageContainer.tags).set(tagID, true);
  doc.commit();
}

/** Sets a scalar (non-entityReference) property's values — mirrors
 *  `PageDocument.setProperty`'s non-relationship branch
 *  (PageDocument.swift:451-464). */
export function setPropertyValues(doc: LoroDoc, key: SupertagPropertyKey, values: SupertagValue[]): void {
  doc.getMap(PageContainer.values).set(propertyStorageKey(key), encodePropertyValues(values));
  doc.commit();
}

/** Adds one canonical edge entry to the `edges` container, resolving its
 *  relation id via `registry.relationIDForProperty()` — mirrors
 *  `PageDocument.replaceRelationshipEdges`'s per-target edge construction
 *  (PageDocument.swift:614-623). Each call adds one edge (fixtures that
 *  need to construct a max-one-relation cardinality conflict call this
 *  twice, once per simulated replica — see
 *  `index.test.ts`'s conflict test). */
export function addEdge(
  doc: LoroDoc,
  registry: SupertagRegistry,
  input: {
    edgeID: string;
    key: SupertagPropertyKey;
    sourceNodeID: string;
    targetNodeID: string;
    origin?: GraphEdgeOrigin;
    createdAt?: Date;
  },
): void {
  const entry = buildEdgeEntry(registry, input);
  doc.getMap(PageContainer.edges).set(input.edgeID, entry);
  doc.commit();
}

export function setPinned(doc: LoroDoc, pinned: boolean): void {
  doc.getMap(PageContainer.root).set("isPinned", pinned);
  doc.commit();
}

export function setDeletedAt(doc: LoroDoc, deletedAt: Date): void {
  doc.getMap(PageContainer.root).set("deletedAt", deletedAt.toISOString());
  doc.commit();
}

/** Sets the `objectMetadata.personVisibility`/`.personOrigin` privacy-gate
 *  keys directly — mirrors `workers/gatekeeper-google/src/
 *  materialized-doc.ts`'s `setPersonClassificationIfMissing` write shape
 *  (same two keys, same root container), for tests exercising `index.ts`'s
 *  `projectPage()` extraction of them (see `GraphNodeRow`'s doc comment). */
export function setPersonClassification(doc: LoroDoc, personVisibility: string, personOrigin: string): void {
  doc.getMap(PageContainer.objectMetadata).set("personVisibility", personVisibility);
  doc.getMap(PageContainer.objectMetadata).set("personOrigin", personOrigin);
  doc.commit();
}

export function exportSnapshot(doc: LoroDoc): Uint8Array {
  return doc.export({ mode: "snapshot" });
}
