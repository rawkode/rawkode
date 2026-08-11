// @enchiridion/worker-gatekeeper-google — materialization orchestration:
// combines identity/baseline (`calendar-materialization.ts`), doc
// construction (`materialized-doc.ts`), local change-detection state
// (`materialization-store.ts`), and the VaultDO push (`vault-client.ts`)
// into the two operations `calendar-ingest.ts` calls per fetched event:
// "materialize this event occurrence" (which itself materializes its
// organizer + attendees as Person pages first, since the event doc's
// edges need their page ids) and "retract a cancelled event".
//
// BASELINE-HASH SKIP — the P2 SIMPLIFICATION vs. the old Swift app,
// stated plainly (per the task brief's requirement to document this):
// the old app additionally tracked a "detached" state
// (`CalendarEventMaterializationBaseline.matches(_:)` comparing the
// CURRENT page snapshot, not just the last-known baseline, to decide
// whether a user had diverged the page from what materialization last
// wrote) — see CalendarEventMaterialization.swift. This port does NOT
// carry that forward. Instead: this worker only ever re-touches a page
// when its OWN computed provider field hash differs from what it last
// wrote for THAT field (`materialization-store.ts`), and even then only
// ever mutates the specific fields/edges whose OWN hash changed
// (`materialized-doc.ts`'s `setValueIfChanged`/`reconcileOwnedEdges`
// helpers never touch any other map key or edge, and are now only even
// CALLED for fields in `changedFields`). Net effect: a user's edits to any
// field/edge this worker doesn't own are never touched, matching the
// invariant the task requires ("never clobber a user's own edits to the
// materialized page"), AND a user's edit to a field this worker DOES own
// is only overwritten when THAT SPECIFIC field's own value actually
// changed at the provider — not merely because some other owned field
// changed in the same sync pass.
//
// PER-FIELD BASELINE HASHING (fixes the original bundle-granular P2 gap
// flagged by adversarial review, see the plan's "Google gatekeeper"
// section): `materialization-store.ts` persists a per-field hash map
// (`calendar-materialization.ts`'s `eventFieldBaselineHashes`/
// `personFieldBaselineHashes`), not one combined hash. Every
// materialize* call below:
//   1. computes the fresh per-field hash map for the current
//      provider-reported occurrence/attendee,
//   2. diffs it against the PREVIOUSLY stored map via
//      `diffChangedFields` (previous `undefined` -> every field counts as
//      changed, i.e. first materialization writes everything, matching
//      the original behavior for a brand-new page),
//   3. skips the whole call (no VaultDO round trip) when NOTHING changed,
//      exactly like the old combined-hash skip,
//   4. otherwise passes the narrowed `changedFields` set into
//      `buildEventDocUpdate`/`buildPersonDocUpdate`, which only attempts
//      `setXIfChanged` for fields in that set — see `materialized-doc.ts`'s
//      header and `materialized-doc.test.ts`'s "changedFields" tests for
//      the exact silent-overwrite scenario this closes (an unrelated
//      owned-field change no longer causes an overwrite ATTEMPT on a
//      field that didn't itself change at the source).
//
// CALENDAR-ATTENDEE PRIVACY GATE: `materializePersonForEvent` always
// creates/updates Person pages via `buildPersonDocUpdate`, which applies
// the `personVisibility: "other"` / `personOrigin: "calendarAttendee"`
// default the FIRST time a page is materialized (never overwritten after
// — see `materialized-doc.ts`'s header). This worker has no promotion
// code path; promoting a Person to broadly-visible is a user-initiated
// native-app action, out of this task's scope.

import { derivePersonPageId } from "@enchiridion/graph-core";
import type { SqlExecutor } from "./schema";
import {
  diffChangedFields,
  eventFieldBaselineHashes,
  personFieldBaselineHashes,
  type NormalizedEventOccurrence,
} from "./calendar-materialization";
import { buildEventDocUpdate, buildPersonDocUpdate, PERSON_ORIGIN_CALENDAR_ATTENDEE } from "./materialized-doc";
import { deleteMaterializationState, getMaterializationState, setMaterializationState } from "./materialization-store";
import { pushPageUpdate, tombstoneMaterializedPage, type VaultClientEnv } from "./vault-client";

export interface MaterializePersonResult {
  pageID: string;
  applied: boolean;
}

/** Materializes one correspondent (Calendar attendee/organizer, or —
 *  "P3: Gmail" — a Gmail correspondent past the participant quality gate)
 *  as a Person page. Generalized out of what was originally
 *  `materializePersonForEvent`'s own body so BOTH Calendar's and Gmail's
 *  ingest paths share the exact same LWW-safe read-diff-build-push-persist
 *  sequence — the part of this worker that is genuinely easy to get subtly
 *  wrong (see `materialized-doc.ts`'s file header on why a fresh `LoroDoc`
 *  per call would silently lose future LWW races) — rather than each
 *  provider re-deriving it. The only thing that varies between callers is
 *  `origin` (`materialized-doc.ts`'s `PERSON_ORIGIN_*` constants), which
 *  only affects a BRAND-NEW page's one-time classification default (see
 *  `buildPersonDocUpdate`'s doc comment) — every other behavior (per-field
 *  hashing, never-clobber-a-user-edit, blind-write causal-history
 *  handling) is identical regardless of provider. `materializePersonForEvent`
 *  below is now a thin, behavior-preserving wrapper (default origin
 *  unchanged) so Calendar's own call sites/tests need no changes. */
export async function materializePersonPage(
  sql: SqlExecutor,
  env: VaultClientEnv,
  input: { email: string; displayName: string | undefined; origin: string },
  now: Date,
): Promise<MaterializePersonResult> {
  const pageID = await derivePersonPageId(input.email);
  const fieldHashes = await personFieldBaselineHashes(input.displayName, input.email);
  const state = getMaterializationState(sql, pageID);
  const changedFields = diffChangedFields(state?.fieldHashes, fieldHashes);

  if (state && changedFields.size === 0) {
    return { pageID, applied: false };
  }

  const built = await buildPersonDocUpdate({
    pageID,
    email: input.email,
    displayName: input.displayName,
    // `diffChangedFields` already returns every field when `state` is
    // undefined (first materialization — see this file's header), so
    // there's no need for a separate "all fields" branch here.
    changedFields,
    existingSnapshot: state?.docSnapshot,
    origin: input.origin,
  });

  if (built.changed) {
    await pushPageUpdate(env, pageID, "person", built.updateBytes);
  }

  setMaterializationState(sql, {
    pageID,
    fieldHashes,
    docSnapshot: built.snapshotBytes,
    lastSyncedAt: now.getTime(),
  });

  return { pageID, applied: built.changed };
}

/** Materializes one attendee/organizer as a Person page. Returns the
 *  deterministic page id regardless of whether a write actually happened
 *  (callers need the id either way, to build the event's edges).
 *  Behavior-preserving thin wrapper over `materializePersonPage` — see
 *  that function's doc comment. */
export async function materializePersonForEvent(
  sql: SqlExecutor,
  env: VaultClientEnv,
  email: string,
  displayName: string | undefined,
  now: Date,
): Promise<MaterializePersonResult> {
  return materializePersonPage(sql, env, { email, displayName, origin: PERSON_ORIGIN_CALENDAR_ATTENDEE }, now);
}

export interface MaterializeEventResult {
  pageID: string;
  applied: boolean;
  personPageIDs: string[];
}

/** Materializes one calendar OCCURRENCE: its organizer/attendees first
 *  (`materializePersonForEvent`, needed for the event doc's edges), then
 *  the event page itself, skipping the VaultDO push entirely when NONE of
 *  the event's owned fields' hashes differ from what this worker last
 *  wrote (see this file's header), and otherwise only re-touching the
 *  fields that actually changed. */
export async function materializeEventOccurrence(
  sql: SqlExecutor,
  env: VaultClientEnv,
  occurrence: NormalizedEventOccurrence,
  now: Date,
): Promise<MaterializeEventResult> {
  const personPageIDs: string[] = [];

  let organizerPageID: string | undefined;
  if (occurrence.organizer) {
    const result = await materializePersonForEvent(sql, env, occurrence.organizer.email, occurrence.organizer.displayName, now);
    organizerPageID = result.pageID;
    personPageIDs.push(result.pageID);
  }

  const attendeePageIDs: string[] = [];
  for (const attendee of occurrence.attendees) {
    const result = await materializePersonForEvent(sql, env, attendee.email, attendee.displayName, now);
    attendeePageIDs.push(result.pageID);
    if (!personPageIDs.includes(result.pageID)) personPageIDs.push(result.pageID);
  }

  const fieldHashes = await eventFieldBaselineHashes(occurrence);
  const state = getMaterializationState(sql, occurrence.pageID);
  const changedFields = diffChangedFields(state?.fieldHashes, fieldHashes);

  if (state && changedFields.size === 0) {
    return { pageID: occurrence.pageID, applied: false, personPageIDs };
  }

  const built = await buildEventDocUpdate({
    pageID: occurrence.pageID,
    occurrence,
    organizerPageID,
    attendeePageIDs,
    // `diffChangedFields` already returns every field when `state` is
    // undefined (first materialization — see this file's header).
    changedFields,
    existingSnapshot: state?.docSnapshot,
    now,
  });

  if (built.changed) {
    await pushPageUpdate(env, occurrence.pageID, "calendarMaterializedEvent", built.updateBytes);
  }

  setMaterializationState(sql, {
    pageID: occurrence.pageID,
    fieldHashes,
    docSnapshot: built.snapshotBytes,
    lastSyncedAt: now.getTime(),
  });

  return { pageID: occurrence.pageID, applied: built.changed, personPageIDs };
}

/** Retracts a previously-materialized event that the provider now reports
 *  as `cancelled` (a real, deleted-at-the-source occurrence — Google
 *  Calendar's incremental sync returns cancelled events explicitly rather
 *  than omitting them, so this worker CAN and does react to it, unlike a
 *  full resync which wouldn't see cancelled events at all). No-ops
 *  (doesn't call VaultDO) if this worker never materialized the page in
 *  the first place — nothing to retract. Clears local state either way so
 *  a later un-cancellation starts fresh rather than resuming from stale
 *  doc bytes for a page VaultDO no longer has live. */
export async function retractCancelledEvent(sql: SqlExecutor, env: VaultClientEnv, pageID: string): Promise<{ tombstoned: boolean }> {
  const state = getMaterializationState(sql, pageID);
  deleteMaterializationState(sql, pageID);
  if (!state) return { tombstoned: false };
  const result = await tombstoneMaterializedPage(env, pageID);
  return result;
}
