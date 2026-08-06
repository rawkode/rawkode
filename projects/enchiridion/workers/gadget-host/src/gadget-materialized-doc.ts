// @enchiridion/worker-gadget-host — Loro doc construction for
// `graph.propose()`'s EXECUTION step (once an approval is confirmed).
//
// Own, independent point of contact with `loro-crdt` — same "don't share a
// mutation entry point across workers/packages" convention
// `workers/gatekeeper-google/src/materialized-doc.ts`'s header establishes
// (see that file for the full reasoning; not repeated here) and the same
// underlying LWW-causal-history requirement: this worker treats itself as a
// persistent, synthetic "device" per page it has ever proposed a write to,
// reopening its OWN last-known snapshot (`gadget-doc-state-store.ts`)
// before mutating, so its ops stay causally descended from its own prior
// history and don't lose LWW races against VaultDO's already-more-advanced
// copy the way a fresh `LoroDoc()` per call would (see
// `materialized-doc.ts`'s header for the full lamport-timestamp argument —
// identical mechanism, different worker).
//
// NARROW MUTATION VOCABULARY, ON PURPOSE — plan §Gadgets' v1 use case is
// "one headless cron automation (morning brief written to the daily page
// via proposals)": appending a line of text to an existing (or brand-new)
// page's body. `appendBodyText` below is the ONLY mutation this pass
// implements — not a generic field-setter/CRDT-mutation DSL. This matches
// the capability system's own "pre-defined, narrow, not generic" posture
// (`graph-query-views.ts`'s header makes the identical argument for
// `graph.query`) and keeps `graph.propose()`'s payload shape small enough
// to review/approve at a glance in a future in-app approval UI. Extending
// this to more mutation kinds (e.g. `setFact`) is a real, bounded follow-up
// — add a new `GraphProposalMutation` variant here and a matching branch in
// `applyMutation`, not a redesign.

import { LoroDoc } from "loro-crdt/bundler";
import { PageContainer } from "@enchiridion/projection";

export type GraphProposalMutation = { kind: "appendBodyText"; text: string };

export interface GraphProposalPayload {
  pageID: string;
  docType: string;
  mutation: GraphProposalMutation;
}

function configureTextStyles(doc: LoroDoc): void {
  // Mirrors `materialized-doc.ts`'s `configureTextStyles` — only matters
  // for round-tripping rich-text marks a real device later applies; this
  // worker itself never applies marks (plain `appendBodyText` only).
  doc.configTextStyle({
    bold: { expand: "after" },
    italic: { expand: "after" },
    underline: { expand: "after" },
    strikethrough: { expand: "after" },
    code: { expand: "none" },
    pageReference: { expand: "none" },
  });
}

export function openOrCreate(existingSnapshot?: Uint8Array): LoroDoc {
  const doc = existingSnapshot ? LoroDoc.fromSnapshot(existingSnapshot) : new LoroDoc();
  configureTextStyles(doc);
  return doc;
}

function setRootIfMissing(doc: LoroDoc, pageID: string): void {
  const root = doc.getMap(PageContainer.root);
  if (root.get("pageID") !== pageID) root.set("pageID", pageID);
  if (root.get("isPinned") === undefined) root.set("isPinned", false);
}

/** Appends `text` to the page's body, preceded by a newline when the body
 *  is already non-empty (so successive gadget-authored lines land as
 *  separate paragraphs rather than one run-on string) — matches how a
 *  "morning brief" accumulates multiple lines across a day's separate
 *  cron-tick proposals. */
function appendBodyText(doc: LoroDoc, text: string): void {
  const body = doc.getText(PageContainer.body);
  const current = body.toString();
  const insertAt = current.length;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  body.insert(insertAt, prefix + text);
}

export function applyMutation(doc: LoroDoc, pageID: string, mutation: GraphProposalMutation): void {
  setRootIfMissing(doc, pageID);
  switch (mutation.kind) {
    case "appendBodyText":
      appendBodyText(doc, mutation.text);
      return;
    default: {
      const _exhaustive: never = mutation.kind;
      throw new Error(`unknown graph proposal mutation kind: ${_exhaustive}`);
    }
  }
}

export interface BuiltDocUpdate {
  /** Net-new ops since `existingSnapshot` — pushed to VaultDO via
   *  `vault-accessor-client.ts`'s `createOrUpdatePage`. Empty when nothing
   *  changed (defensive — `appendBodyText` above always changes something
   *  for a non-empty `text`, but `finish` stays honest about it rather than
   *  assuming). */
  updateBytes: Uint8Array;
  /** The doc's full new state — persisted via
   *  `gadget-doc-state-store.ts`'s `setDocState` as this worker's own
   *  durable synthetic-device copy. */
  snapshotBytes: Uint8Array;
  changed: boolean;
}

/** Mirrors `materialized-doc.ts`'s `finish` — same `VersionVector.compare`
 *  no-op check (an export from the doc's own current version is NOT a
 *  reliable "did anything change" signal by itself; see that file's header
 *  for the empirical verification this repeats), same reasoning. */
export function finish(doc: LoroDoc, beforeVersion: ReturnType<LoroDoc["oplogVersion"]>): BuiltDocUpdate {
  doc.commit();
  const afterVersion = doc.oplogVersion();
  const snapshotBytes = doc.export({ mode: "snapshot" });

  if (beforeVersion.compare(afterVersion) === 0) {
    return { updateBytes: new Uint8Array(0), snapshotBytes, changed: false };
  }

  const updateBytes = doc.export({ mode: "update", from: beforeVersion });
  return { updateBytes, snapshotBytes, changed: true };
}

/** Convenience: open-or-create, apply one mutation, and finish — the whole
 *  lifecycle `graph-propose-capability.ts`'s execution step needs. */
export function buildProposalDocUpdate(payload: GraphProposalPayload, existingSnapshot?: Uint8Array): BuiltDocUpdate {
  const doc = openOrCreate(existingSnapshot);
  const beforeVersion = doc.oplogVersion();
  applyMutation(doc, payload.pageID, payload.mutation);
  return finish(doc, beforeVersion);
}
