// @enchiridion/worker-gatekeeper-google — Loro doc construction for
// materialized EmailThread pages ("P3: Gmail", plan §Google gatekeeper).
//
// Mirrors `materialized-doc.ts`'s `buildEventDocUpdate` shape as closely as
// possible, and DELIBERATELY REUSES its exported low-level primitives
// (`openOrCreate`, `setRoot`, `setTagIfMissing`, `setTitleIfChanged`,
// `setValueIfChanged`, `deleteValueIfPresent`, `finish`,
// `reconcileOwnedEdges`, `deterministicProviderEdgeId`) rather than
// re-deriving them a second time. This is a deliberate DRY choice, not
// laziness: `materialized-doc.ts`'s file header documents in detail WHY
// this worker must reopen a persisted snapshot and mutate on top of its
// own prior causal history rather than ever constructing a fresh, empty
// `LoroDoc` per write (`openOrCreate`/`finish`'s "blind write" / Lamport
// timestamp argument) — that is exactly the kind of subtle-to-get-right,
// easy-to-silently-break-if-duplicated logic this task's brief says to
// MIRROR, not reinvent. Re-implementing it a second time for EmailThread
// would be new surface for the identical bug class (a fresh `LoroDoc`
// silently losing future LWW races) to creep back in, for zero benefit —
// `materialized-doc.ts` lives in this same worker (not vault or a
// read-only reference package), so exporting and reusing its primitives
// costs nothing and removes that risk entirely.
//
// Person-page construction for a Gmail correspondent reuses
// `materialized-doc.ts`'s `buildPersonDocUpdate` directly (via
// `materialization.ts`'s generalized `materializePersonPage`, see that
// file's header) — EmailThread materialization ITSELF only needs to build
// the thread page's own doc, which is what this file does.

import { LoroDoc } from "loro-crdt/bundler";
import { buildEdgeEntry, decodeEdgeEntry, encodePropertyValues, PageContainer, type SupertagValue } from "@enchiridion/projection";
import { EmailSupertagIDs, supertagRegistry } from "./supertag-registry";
import {
  deleteValueIfPresent,
  deterministicProviderEdgeId,
  finish,
  openOrCreate,
  reconcileOwnedEdges,
  setRoot,
  setTagIfMissing,
  setTitleIfChanged,
  setValueIfChanged,
  type BuiltDocUpdate,
  type DesiredEdge,
} from "./materialized-doc";
import { EMAIL_THREAD_OWNED_FIELDS, type EmailThreadOwnedField, type NormalizedThread } from "./gmail-materialization";

const EMAIL_THREAD = EmailSupertagIDs.emailThread;
const FROM_KEY = { supertagID: EMAIL_THREAD, fieldID: "from" } as const;
const TO_KEY = { supertagID: EMAIL_THREAD, fieldID: "to" } as const;
const CC_KEY = { supertagID: EMAIL_THREAD, fieldID: "cc" } as const;

const ALL_EMAIL_THREAD_FIELDS: ReadonlySet<EmailThreadOwnedField> = new Set(EMAIL_THREAD_OWNED_FIELDS);

export interface BuildEmailThreadDocParams {
  pageID: string;
  thread: NormalizedThread;
  /** Already quality-gated Person page ids for each role (see
   *  `gmail-materialization.ts`'s `MaterializedThreadFields` doc comment —
   *  these are exactly the sets that hash produces the `from`/`to`/`cc`
   *  baseline hashes from, so `gmail-ingest.ts` computes them once and
   *  passes the SAME sets to both). */
  fromPageIDs: readonly string[];
  toPageIDs: readonly string[];
  ccPageIDs: readonly string[];
  /** Which owned fields to actually attempt to write — see
   *  `materialized-doc.ts`'s `BuildEventDocParams.changedFields` doc
   *  comment; identical contract, applied to EmailThread's owned field
   *  set instead (`gmail-materialization.ts`'s `EMAIL_THREAD_OWNED_FIELDS`). */
  changedFields?: ReadonlySet<EmailThreadOwnedField>;
  existingSnapshot?: Uint8Array;
  now: Date;
}

/** Builds (or updates, if `existingSnapshot` is given) a materialized
 *  EmailThread page's doc. Deliberately writes ONLY the fields
 *  `supertags/email/src/index.ts` declares (subject/labels/snippet/
 *  lastMessageAt/messageCount + from/to/cc edges) — message bodies never
 *  reach this function at all (`gmail-materialization.ts`'s
 *  `NormalizedThread` never carries one), enforcing the plan's "Message
 *  bodies stay out of the CRDT graph" rule structurally, not just by
 *  convention. */
export async function buildEmailThreadDocUpdate(params: BuildEmailThreadDocParams): Promise<BuiltDocUpdate> {
  const doc = openOrCreate(params.existingSnapshot);
  const beforeVersion = doc.oplogVersion();
  const changedFields = params.changedFields ?? ALL_EMAIL_THREAD_FIELDS;
  const { thread } = params;

  setRoot(doc, params.pageID);
  if (changedFields.has("subject")) {
    // TWO writes for one owned field, deliberately: `supertags/email`
    // declares `subject` as a real `values`-container field (unlike
    // Calendar's `title`/Person's `title`, which are ONLY ever the page's
    // generic title text container — neither `core.event` nor
    // `core.person` declares an actual "title" field; see
    // `calendar-materialization.ts`'s `EVENT_OWNED_FIELDS`/
    // `PERSON_OWNED_FIELDS` for that precedent). EmailThread's subject
    // still ALSO becomes the page's title text container — every
    // materialized page in this codebase gets a sensible page title for
    // display (list views, search results, ...), and a thread's subject
    // is unambiguously the right value for that — so both writes happen
    // together, gated by the SAME `changedFields.has("subject")` check
    // (they're the same underlying data and always change together).
    setTitleIfChanged(doc, thread.subject);
    setValueIfChanged(doc, EMAIL_THREAD, "subject", [{ type: "text", value: thread.subject }]);
  }
  setTagIfMissing(doc, EMAIL_THREAD);

  if (changedFields.has("labels")) {
    if (thread.labels.length > 0) {
      const values: SupertagValue[] = thread.labels.map((label) => ({ type: "text", value: label }));
      setValueIfChanged(doc, EMAIL_THREAD, "labels", values);
    } else {
      deleteValueIfPresent(doc, EMAIL_THREAD, "labels");
    }
  }
  if (changedFields.has("snippet")) {
    setValueIfChanged(doc, EMAIL_THREAD, "snippet", [{ type: "text", value: thread.snippet }]);
  }
  if (changedFields.has("lastMessageAt")) {
    setValueIfChanged(doc, EMAIL_THREAD, "lastMessageAt", [{ type: "dateTime", value: thread.lastMessageAt }]);
  }
  if (changedFields.has("messageCount")) {
    setValueIfChanged(doc, EMAIL_THREAD, "messageCount", [{ type: "number", value: thread.messageCount }]);
  }

  const fromRelationID = supertagRegistry.relationIDForProperty(FROM_KEY);
  const toRelationID = supertagRegistry.relationIDForProperty(TO_KEY);
  const ccRelationID = supertagRegistry.relationIDForProperty(CC_KEY);

  const ownedRelationIDs = new Set<string>();
  if (changedFields.has("from")) ownedRelationIDs.add(fromRelationID);
  if (changedFields.has("to")) ownedRelationIDs.add(toRelationID);
  if (changedFields.has("cc")) ownedRelationIDs.add(ccRelationID);

  const desired: DesiredEdge[] = [];
  if (changedFields.has("from")) {
    for (const targetPageID of new Set(params.fromPageIDs)) {
      desired.push({
        edgeID: await deterministicProviderEdgeId(fromRelationID, params.pageID, targetPageID),
        relationID: fromRelationID,
        key: FROM_KEY,
        targetNodeID: targetPageID,
      });
    }
  }
  if (changedFields.has("to")) {
    for (const targetPageID of new Set(params.toPageIDs)) {
      desired.push({
        edgeID: await deterministicProviderEdgeId(toRelationID, params.pageID, targetPageID),
        relationID: toRelationID,
        key: TO_KEY,
        targetNodeID: targetPageID,
      });
    }
  }
  if (changedFields.has("cc")) {
    for (const targetPageID of new Set(params.ccPageIDs)) {
      desired.push({
        edgeID: await deterministicProviderEdgeId(ccRelationID, params.pageID, targetPageID),
        relationID: ccRelationID,
        key: CC_KEY,
        targetNodeID: targetPageID,
      });
    }
  }

  reconcileOwnedEdges(doc, params.pageID, ownedRelationIDs, desired, params.now);

  return finish(doc, beforeVersion);
}

// Re-exported for tests that want to decode a pushed EmailThread doc's
// edges/values without importing `@enchiridion/projection` a second time
// under a different name.
export { buildEdgeEntry, decodeEdgeEntry, encodePropertyValues, PageContainer };
export { LoroDoc };
