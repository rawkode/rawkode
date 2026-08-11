// @enchiridion/projection — supertag property value decoding.
//
// Reads the page document's `values` container (see `doc.ts`'s header):
// `"property:<tagID>:<fieldID>" -> JSON string of a SupertagValue[] array`.
// The storage-key format is `@enchiridion/graph-core`'s `predicateId()`
// output verbatim — `PageDocument.swift`'s `SupertagPropertyKey.storageKey`
// is literally `PredicateID.property(tagID:fieldID:).rawValue`
// (PageModels.swift:453-455), and `graph-core`'s `predicateId()` is the TS
// port of that same `PredicateID.property` primitive — so this package
// reuses it for both the doc storage key AND the `graph_facts.predicate_id`
// column, rather than re-deriving the same string two different ways.
//
// ON-WIRE VALUE SHAPE: see `doc.ts`'s header for why this package defines
// its own `{"type": "...", "value": ...}` discriminated encoding rather
// than guessing Swift's `SupertagValue` enum Codable synthesis. `date`/
// `dateTime` values are ISO-8601 strings (`Date.prototype.toISOString()`
// on the write side, `new Date(...)` on read) — matches
// `JSONEncoder.enchiridion`'s `.iso8601` date strategy in spirit, even
// though the exact enum-case JSON framing differs (see `doc.ts`).

import { predicateId } from "@enchiridion/graph-core";
import type { SupertagPropertyKey } from "@enchiridion/schema";

export type SupertagValueType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "dateTime"
  | "select"
  | "url"
  | "email"
  | "phone"
  | "page";

/** One decoded entry from a `values` container JSON array. Mirrors Swift's
 *  `SupertagValue` cases (PageModels.swift:389-399) 1:1, including `.page`
 *  — a `values`-container `.page` entry is a doc-authoring inconsistency
 *  (per `PageDocument.setProperty`'s isRelationship detection rule,
 *  all-`.page` value sets are written as `edges` entries instead, never
 *  left in `values`), so `decodePropertyValues` below drops rather than
 *  facts-encodes a stray `.page` entry — matches
 *  `GraphProjectionStore.fact(...)`'s
 *  `case .page: preconditionFailure("References are projected as edges")`,
 *  except non-fatally (a hostile/corrupt doc must not crash projection). */
export type SupertagValue =
  | { type: "text"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "date"; value: string }
  | { type: "dateTime"; value: string }
  | { type: "select"; value: string }
  | { type: "url"; value: string }
  | { type: "email"; value: string }
  | { type: "phone"; value: string }
  | { type: "page"; value: string };

/** Matches `SupertagPropertyKey.storageKey` / `PredicateID.property`
 *  exactly — see this file's header. */
export function propertyStorageKey(key: SupertagPropertyKey): string {
  return predicateId(key.supertagID, key.fieldID);
}

const STORAGE_KEY_PREFIX = "property:";

/** Inverse of `propertyStorageKey` — parses a `values`-container map key
 *  back into its `(supertagID, fieldID)` parts. Mirrors
 *  `SupertagPropertyKey.init?(storageKey:)` (PageModels.swift:439-446).
 *  Returns `undefined` for anything not in `property:<tagID>:<fieldID>`
 *  shape, matching Swift's failable initializer. */
export function parsePropertyStorageKey(storageKey: string): SupertagPropertyKey | undefined {
  if (!storageKey.startsWith(STORAGE_KEY_PREFIX)) return undefined;
  const rest = storageKey.slice(STORAGE_KEY_PREFIX.length);
  const separatorIndex = rest.indexOf(":");
  if (separatorIndex === -1) return undefined;
  return {
    supertagID: rest.slice(0, separatorIndex),
    fieldID: rest.slice(separatorIndex + 1),
  };
}

/** Decodes one `values`-container JSON-string entry into a `SupertagValue`
 *  array. Returns `[]` (never throws) for malformed JSON/shape — a
 *  corrupt/foreign-written doc must not wedge reprojection, matching
 *  `PageDocument.swift`'s pattern of `compactMap`-dropping undecodable
 *  entries throughout `objectMetadataProjection`. */
export function decodePropertyValues(json: string): SupertagValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: SupertagValue[] = [];
  for (const entry of parsed) {
    const decoded = decodeOneValue(entry);
    if (decoded) result.push(decoded);
  }
  return result;
}

function decodeOneValue(entry: unknown): SupertagValue | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const type = record.type;
  const value = record.value;
  switch (type) {
    case "text":
    case "date":
    case "dateTime":
    case "select":
    case "url":
    case "email":
    case "phone":
    case "page":
      return typeof value === "string" ? { type, value } : undefined;
    case "number":
      return typeof value === "number" ? { type: "number", value } : undefined;
    case "boolean":
      return typeof value === "boolean" ? { type: "boolean", value } : undefined;
    default:
      return undefined;
  }
}

export function encodePropertyValues(values: readonly SupertagValue[]): string {
  return JSON.stringify(values);
}
