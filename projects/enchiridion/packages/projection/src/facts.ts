// @enchiridion/projection — typed property-value ("fact") projection.
//
// Port of `GraphProjectionStore.fact`/`.insert(fact:...)`
// (apps/enchiridion/Sources/EnchiridionCore/GraphDatabase.swift:677-750) and
// the `graph_facts` view (GraphDatabase.swift:50-66, 201-207).
//
// EFFECTIVE-FIELD RESOLUTION: a page's `values` container is keyed
// `"property:<tagID>:<fieldID>"` directly (see `values.ts`) — the schema
// that DECLARED a field, which per `effectiveFields`'s doc comment
// (packages/schema/src/inheritance.ts) stays the same across inheritance
// (`company.registration-number` is company's own; `organization.website`
// is stored under organization's key even when set from a company page,
// since Organization declared it). So, unlike Swift's `GraphDatabase`
// (which has no registry to consult and just trusts whatever keys exist),
// this projector uses `registry.effectiveFields()` for every one of the
// page's DIRECT tags as a validating whitelist: a `values` entry whose
// storage key isn't in the union of the page's direct tags' effective
// fields is dropped rather than faceted into a `graph_facts` row — a
// defensive gate against stray/foreign-written keys (a hostile or
// out-of-date doc), and the mechanism that proves inherited fields
// (Organization's fields on a Company page) really do surface as facts,
// per this task's test brief.
//
// SYNCHRONOUS BY DESIGN: fact ids here are plain deterministic strings
// (`fact_<nodeID>:<predicateID>:<valueIndex>`), NOT a SHA-256 digest like
// Swift's `fact_\(digest(...))` (GraphDatabase.swift:699). `graph-core`'s
// digest primitives are all `async` (WebCrypto `crypto.subtle.digest`,
// per that package's header) — pulling one into a per-value id here would
// force `projectPage()` to become async for no semantic gain: reprojection
// always DELETEs a page's facts before reinserting (matching Swift's
// `DELETE FROM _graph_facts WHERE node_id = ?` in
// `GraphProjectionStore.replacePage`, not an upsert-by-content-hash), so
// nothing depends on the id being content-addressed, only on it being
// unique within one page's row set — which
// `<nodeID>:<predicateID>:<valueIndex>` already guarantees. Staying
// synchronous matters concretely: the plan requires reprojection to run
// "synchronously, in the same DO SQLite transaction as the doc-storage
// write" (§Backend architecture) — `SqlStorage.exec()` itself is
// synchronous (`workers/vault/src/schema.ts`'s header), so an async
// projector would be the one thing forcing that transaction to span an
// await point.

import type { SupertagRegistry } from "@enchiridion/schema";
import { predicateId } from "@enchiridion/graph-core";
import { decodePropertyValues, parsePropertyStorageKey, type SupertagValue } from "./values";

export type GraphValueType =
  | "text"
  | "number"
  | "boolean"
  | "localDate"
  | "dateTime"
  | "select"
  | "url"
  | "email"
  | "phone";

export type GraphFactOrigin = "user" | "provider" | "system";

/** `graph_facts` row — matches the old app's public view column-for-column
 *  (GraphDatabase.swift:50-66, 201-207). */
export interface GraphFactRow {
  factID: string;
  nodeID: string;
  predicateID: string;
  tagID: string;
  fieldID: string;
  valueIndex: number;
  valueType: GraphValueType;
  textValue?: string;
  numberValue?: number;
  booleanValue?: boolean;
  localDateValue?: string;
  dateTimeValue?: number;
  origin: GraphFactOrigin;
  createdAt: number;
}

function valueTypeFor(value: SupertagValue): GraphValueType | undefined {
  switch (value.type) {
    case "text":
    case "select":
    case "url":
    case "email":
    case "phone":
    case "number":
    case "boolean":
    case "dateTime":
      return value.type;
    case "date":
      // Swift: `.date(let value): graphValue = .localDate(.init(date: value))`
      // (GraphProjectionStore.fact, GraphDatabase.swift:689) — the field
      // TYPE is `date`, but the FACT value kind is `localDate`.
      return "localDate";
    case "page":
      // References are projected as edges, never facts — matches Swift's
      // `case .page: preconditionFailure("References are projected as
      // edges")` (GraphDatabase.swift:695), except dropped rather than
      // fatal: a `values`-container `.page` entry is a doc-authoring
      // inconsistency (see `values.ts`'s header), and reprojection must
      // stay resilient to a malformed/foreign-written doc rather than
      // crash the whole batch (plan §Backend architecture:
      // `rebuild-projections` "isolates per-page failures").
      return undefined;
  }
}

function fillValueColumns(row: GraphFactRow, value: SupertagValue): void {
  switch (value.type) {
    case "text":
    case "select":
    case "url":
    case "email":
    case "phone":
      row.textValue = value.value;
      return;
    case "number":
      row.numberValue = value.value;
      return;
    case "boolean":
      row.booleanValue = value.value;
      return;
    case "date":
      row.localDateValue = value.value;
      return;
    case "dateTime": {
      const parsed = Date.parse(value.value);
      if (Number.isFinite(parsed)) row.dateTimeValue = parsed;
      return;
    }
    case "page":
      return;
  }
}

/** Projects one page's `graph_facts` rows from its raw `values`-container
 *  entries — see this file's header for the effective-field whitelist and
 *  why fact ids are plain deterministic strings, not digests.
 *
 *  `rawValues`: the page's `values` container, shallow-read as
 *  `storageKey -> JSON string` (i.e. `doc.ts`'s `shallowMap()` output on
 *  the `values` map, with non-string entries already excluded by the
 *  caller — `index.ts`'s `projectPage` does this).
 *  `directTagIDs`: the page's OWN (non-inherited) supertag ids, from its
 *  `tags` container. */
export function projectFacts(
  nodeID: string,
  directTagIDs: readonly string[],
  rawValues: Record<string, string>,
  registry: SupertagRegistry,
  createdAt: number,
): GraphFactRow[] {
  const allowedKeys = new Set<string>();
  for (const tagID of directTagIDs) {
    for (const field of registry.effectiveFields(tagID)) {
      allowedKeys.add(predicateId(field.propertyKey.supertagID, field.propertyKey.fieldID));
    }
  }

  const rows: GraphFactRow[] = [];
  for (const [storageKey, json] of Object.entries(rawValues)) {
    if (!allowedKeys.has(storageKey)) continue;
    const propertyKey = parsePropertyStorageKey(storageKey);
    if (!propertyKey) continue;
    const values = decodePropertyValues(json);
    values.forEach((value, valueIndex) => {
      const valueType = valueTypeFor(value);
      if (!valueType) return;
      const row: GraphFactRow = {
        factID: `fact_${nodeID}:${storageKey}:${valueIndex}`,
        nodeID,
        predicateID: storageKey,
        tagID: propertyKey.supertagID,
        fieldID: propertyKey.fieldID,
        valueIndex,
        valueType,
        origin: "user",
        createdAt,
      };
      fillValueColumns(row, value);
      rows.push(row);
    });
  }
  rows.sort((a, b) => a.factID.localeCompare(b.factID));
  return rows;
}
