// @enchiridion/worker-gatekeeper-google — Loro doc construction for
// materialized Event/Person pages.
//
// THIS IS THE GENUINELY NEW PIECE the task brief flags: "constructing a
// Loro doc from scratch in a Cloudflare Worker, not just reading one."
// `@enchiridion/projection` (`doc.ts`) is a READ-ONLY point of contact
// with `loro-crdt` (it opens snapshot bytes for extraction, never
// mutates), so this module is its own independent point of contact,
// following the same "own the loro-crdt import, don't share it" pattern
// `workers/vault/src/loro-storage.ts` and `packages/projection/src/doc.ts`
// each independently establish (see either file's header for why: no
// circular-dependency risk, and each caller's mutation/read needs differ).
// It DOES reuse `@enchiridion/projection`'s on-wire encoding helpers
// (`propertyStorageKey`, `encodePropertyValues`, `buildEdgeEntry`,
// `decodeEdgeEntry`, `PageContainer`) rather than re-deriving the exact
// same JSON shapes a second, possibly-drifting way — those are pure
// functions over plain data, not `loro-crdt` calls, so importing them
// carries no circularity risk.
//
// WHY THIS WORKER KEEPS A PERSISTED DOC SNAPSHOT PER PAGE (the
// `existingSnapshot` parameter below, backed by
// `materialization-store.ts`'s `calendar_materialization_state` table):
// VaultDO's RPC surface has no method to fetch a page's current raw Loro
// bytes back (`getPage`/`getNodeWithFacts`/etc. all return already-
// projected plain rows, not doc bytes — see `vault-do.ts`), and this
// task's constraints keep `workers/vault/src/` untouched, so adding one
// isn't an option. That means every write this worker makes is "blind" —
// it never reads vault's authoritative current doc state before writing.
//
// This matters because of how Loro resolves LAST-WRITE-WINS conflicts on a
// map key: by comparing each op's `(lamport, peer)` pair (see
// `PageModels.swift`'s header investigation, cited verbatim in
// `loro-storage.ts`). A op's lamport timestamp is `max(causal
// dependencies' lamport) + 1` — so a op created on a BRAND-NEW, empty
// `LoroDoc()` (no imported history) starts from a low lamport with no
// causal relationship to whatever's already in VaultDO's copy of the same
// page. If this worker recreated an empty `LoroDoc` on every cron tick,
// its second-and-later writes to the SAME map key would systematically
// LOSE the LWW race against the page's own already-more-advanced state
// (itself descended from this worker's FIRST write, once merged) — a
// silent no-op bug, not a crash, so it would be very easy to ship
// undetected.
//
// The fix: this worker treats itself as a persistent, synthetic "device"
// per materialized page. On every write it reopens the LoroDoc from the
// bytes it persisted after its OWN last write (`LoroDoc.fromSnapshot`,
// exactly how a real device reopens its local copy before an edit — see
// `PageDocument.swift`'s snapshot-in/snapshot-out pattern, cited in the
// plan's Risk #14), mutates on top of that causal history, and persists a
// fresh snapshot afterward. Every op this worker makes is then causally
// descended from its own prior ops, so its lamport timestamps keep
// advancing correctly and continue to win LWW races against stale values
// — the same guarantee a real device gets by always editing its own local
// copy rather than a freshly re-downloaded blank slate.
//
// KNOWN GAP (documented, not fixed here): if this worker's local
// `calendar_materialization_state` row for a page is ever lost (e.g. the
// GoogleAccountDO's storage is reset) while the corresponding VaultDO page
// still exists with history beyond this worker's last known snapshot, the
// next write starts a fresh, causally-disconnected `LoroDoc()` again and
// can lose LWW races until a subsequent write's higher lamport catches up.
// Low-probability (DO storage is durable) and self-healing (a later write
// eventually wins once the disconnected history's lamport values are
// naturally exceeded), so not solved in this pass.

import { LoroDoc, type VersionVector } from "loro-crdt/bundler";
import {
  buildEdgeEntry,
  decodeEdgeEntry,
  encodePropertyValues,
  PageContainer,
  propertyStorageKey,
  type SupertagValue,
} from "@enchiridion/projection";
import { CoreSupertagIDs, supertagRegistry } from "./supertag-registry";
import { sha256Hex } from "./hash";
import {
  EVENT_OWNED_FIELDS,
  PERSON_OWNED_FIELDS,
  type EventOwnedField,
  type NormalizedEventOccurrence,
  type PersonOwnedField,
} from "./calendar-materialization";

// PRIVACY GATE — attendee-derived Person visibility/origin (fixes the P2
// gap flagged by adversarial review, see the plan's "Google gatekeeper"
// section: every attendee on every ingested event was becoming a fully
// synced Person page with no visibility distinction).
//
// ARCHITECTURAL DECISION: doc-level metadata, in the SAME `objectMetadata`
// root container `PageDocument.swift` used
// (apps/enchiridion/Sources/EnchiridionCore/PageDocument.swift's
// `metadataObject`/`setPersonClassification`, storing `personVisibility`/
// `personOrigin` as plain string values on a `objectMetadata` map, NOT as
// a `person` supertag field), not supertag fields on `supertags/core`'s
// `person` definition. Two reasons this fits THIS codebase's actual
// architecture, not just a Swift-shaped habit:
//   1. `packages/projection/src/doc.ts`'s `PageContainer` ALREADY declares
//      an `objectMetadata` root container, byte-for-byte mirroring
//      `PageDocument.swift`'s five-container shape, with a doc comment
//      stating outright it is "present for parity with PageDocument.swift
//      but not read by this package yet — nothing in the P1 task's table
//      list needs personVisibility/personOrigin." That is precisely the
//      extension point this task's own citation (PeopleModels.swift /
//      PageDocument.swift's objectMetadata shape) predicted might be
//      needed — it already exists, unused, so this task fills it in
//      rather than inventing a parallel mechanism.
//   2. Visibility/origin is NOT a user-authored property of the person
//      (nothing an effective-schema-driven property UI should render next
//      to email/phone/organization) — it is bookkeeping ABOUT the page
//      itself (how it came to exist, whether it's broadly visible),
//      exactly the kind of thing `objectMetadata` already holds
//      (`version`) as opposed to `values` (the supertag property map).
//      Adding it as a `person` supertag field would also fail
//      `supertags/core`'s own additive-only-upgrade discipline weirdly —
//      it isn't a field every `person` page should show in its property
//      list, and unlike a real field it must be non-`entityReference`,
//      hidden from generic property UI, and exempt from the "every field
//      renders somewhere" assumption the manifest-driven UI makes.
// This worker only ever WRITES the default (`other`/`calendarAttendee`)
// the first time it creates a Person page, and only when neither key is
// already present — see `setPersonClassificationIfMissing` below. A page
// a user has since promoted (`personVisibility: "promoted"`, written by
// some future in-app action, out of this task's scope per the task brief)
// is NEVER touched again by this worker, matching the plan's "never
// auto-promoted" requirement.
export const PERSON_VISIBILITY_OTHER = "other";
export const PERSON_ORIGIN_CALENDAR_ATTENDEE = "calendarAttendee";
/** Second `personOrigin` value — "P3: Gmail" (plan §Google gatekeeper).
 *  Written by `gmail-materialized-doc.ts` for a Person page created from a
 *  Gmail correspondent who has passed the participant quality gate (see
 *  `gmail-materialization.ts`'s file header) — kept in THIS file (not
 *  duplicated into `gmail-materialized-doc.ts`) since it's the same
 *  `objectMetadata.personOrigin` vocabulary `setPersonClassificationIfMissing`
 *  already owns, just a second value in the same enum-shaped string field. */
export const PERSON_ORIGIN_GMAIL_CORRESPONDENT = "gmailCorrespondent";

// Mirrors `loro-storage.ts`/`packages/projection/src/doc.ts`'s
// `MARK_STYLES` — duplicated (not imported) for the same "own point of
// contact with loro-crdt" reasoning this file's header explains. Only
// matters for `title`'s rich-text container to round-trip correctly if a
// real client later edits it; this worker itself never applies marks.
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

/** Exported — see `gmail-materialized-doc.ts`'s file header for why the
 *  Gmail materialization path reuses these low-level doc-construction
 *  primitives directly rather than re-deriving the same LWW-causal-history
 *  logic (`openOrCreate`/`finish`) or the same field/edge write helpers a
 *  second, possibly-drifting way. */
export function openOrCreate(existingSnapshot?: Uint8Array): LoroDoc {
  const doc = existingSnapshot ? LoroDoc.fromSnapshot(existingSnapshot) : new LoroDoc();
  configureTextStyles(doc);
  return doc;
}

export function setTitleIfChanged(doc: LoroDoc, title: string): void {
  const text = doc.getText(PageContainer.title);
  const current = text.toString();
  if (current === title) return;
  if (current.length > 0) text.delete(0, current.length);
  text.insert(0, title);
}

export function setRoot(doc: LoroDoc, pageID: string): void {
  const root = doc.getMap(PageContainer.root);
  if (root.get("pageID") !== pageID) root.set("pageID", pageID);
  if (root.get("isPinned") === undefined) root.set("isPinned", false);
}

export function setTagIfMissing(doc: LoroDoc, tagID: string): void {
  const tags = doc.getMap(PageContainer.tags);
  if (tags.get(tagID) !== true) tags.set(tagID, true);
}

export function setValueIfChanged(doc: LoroDoc, tagID: string, fieldID: string, values: readonly SupertagValue[]): void {
  const key = propertyStorageKey({ supertagID: tagID, fieldID });
  const encoded = encodePropertyValues(values);
  const map = doc.getMap(PageContainer.values);
  if (map.get(key) !== encoded) map.set(key, encoded);
}

export function deleteValueIfPresent(doc: LoroDoc, tagID: string, fieldID: string): void {
  const key = propertyStorageKey({ supertagID: tagID, fieldID });
  const map = doc.getMap(PageContainer.values);
  if (map.get(key) !== undefined) map.delete(key);
}

/** Sets the calendar-attendee privacy-gate default (`other`/
 *  `calendarAttendee`, see this file's header) ONLY when neither key is
 *  already present in `objectMetadata` — i.e. only on a brand-new Person
 *  page. A page that already carries a classification (default-set by an
 *  earlier materialization run, or a user-initiated promotion written by
 *  some future in-app action) is left completely alone: this worker never
 *  overwrites `personVisibility`/`personOrigin` once set, matching the
 *  "never auto-promoted" requirement — there is no code path in this
 *  worker that ever writes `"promoted"`. */
function setPersonClassificationIfMissing(doc: LoroDoc, origin: string): void {
  const metadata = doc.getMap(PageContainer.objectMetadata);
  if (metadata.get("personVisibility") === undefined) {
    metadata.set("personVisibility", PERSON_VISIBILITY_OTHER);
  }
  if (metadata.get("personOrigin") === undefined) {
    metadata.set("personOrigin", origin);
  }
}

/** Deterministic (not random) edge id — required so re-materializing the
 *  SAME logical edge (same relation, same source, same target) across
 *  cron ticks always targets the same `edges`-map KEY, letting a plain
 *  CRDT `set` cleanly overwrite/no-op it instead of accumulating
 *  duplicate entries for one real-world relationship. Deliberately not
 *  `graph-core`'s PageID digest scheme (no cross-language parity need —
 *  same reasoning as `calendar-materialization.ts`'s baseline hash). */
export async function deterministicProviderEdgeId(relationID: string, sourceNodeID: string, targetNodeID: string): Promise<string> {
  const digest = await sha256Hex(`provider-edge ${relationID} ${sourceNodeID} ${targetNodeID}`);
  return `edge_provider_${digest.slice(0, 32)}`;
}

export interface DesiredEdge {
  edgeID: string;
  relationID: string;
  key: { supertagID: string; fieldID: string };
  targetNodeID: string;
}

/** Reconciles the `edges` map against a freshly computed desired set for
 *  the relations THIS worker owns (`ownedRelationIDs`) — adds/updates
 *  entries in `desired`, and removes any EXISTING provider-origin edge
 *  whose relation is owned but isn't in `desired` anymore (the organizer
 *  changed, or an attendee was removed). Edges for relations this worker
 *  doesn't own, or with `origin !== "provider"` (i.e. anything a real
 *  device/user wrote), are never touched — the "only overwrite fields
 *  materialization owns, never touch others" rule extended to edges (see
 *  this file's header and `calendar-ingest.ts`'s file header for the full
 *  P2-simplification writeup). */
export function reconcileOwnedEdges(
  doc: LoroDoc,
  sourcePageID: string,
  ownedRelationIDs: ReadonlySet<string>,
  desired: readonly DesiredEdge[],
  now: Date,
): void {
  const edgesMap = doc.getMap(PageContainer.edges);
  const shallow = edgesMap.getShallowValue() as Record<string, unknown>;
  const desiredByID = new Map(desired.map((d) => [d.edgeID, d]));

  for (const [edgeKey, rawValue] of Object.entries(shallow)) {
    if (typeof rawValue !== "string") continue;
    const decoded = decodeEdgeEntry(rawValue, sourcePageID);
    if (!decoded) continue;
    if (decoded.origin !== "provider") continue;
    if (!ownedRelationIDs.has(decoded.relationID)) continue;
    if (!desiredByID.has(edgeKey)) {
      edgesMap.delete(edgeKey);
    }
  }

  for (const edge of desired) {
    // Reuse the EXISTING edge's `createdAt` when this exact edge (same
    // deterministic id) is already present — otherwise every
    // re-materialization run would stamp a fresh `now` into the encoded
    // JSON and spuriously look "changed" (a non-empty update export) even
    // though nothing about the edge actually changed. Only a genuinely
    // NEW edge (not present before) gets `now` as its creation time.
    const existingRaw = shallow[edge.edgeID];
    const existingDecoded = typeof existingRaw === "string" ? decodeEdgeEntry(existingRaw, sourcePageID) : undefined;
    const createdAt = existingDecoded ? new Date(existingDecoded.createdAt) : now;

    const encoded = buildEdgeEntry(supertagRegistry, {
      edgeID: edge.edgeID,
      key: edge.key,
      sourceNodeID: sourcePageID,
      targetNodeID: edge.targetNodeID,
      origin: "provider",
      createdAt,
    });
    if (existingRaw !== encoded) {
      edgesMap.set(edge.edgeID, encoded);
    }
  }
}

export interface BuiltDocUpdate {
  /** Net-new ops since `existingSnapshot` (or the doc's full history, for
   *  a brand-new page) — what gets pushed to VaultDO via
   *  `vault-client.ts`'s `pushPageUpdate`. */
  updateBytes: Uint8Array;
  /** The doc's full new state — persisted via
   *  `materialization-store.ts`'s `setMaterializationState` as this
   *  worker's own durable "device copy" (see this file's header). */
  snapshotBytes: Uint8Array;
  /** `false` when nothing actually changed (every field/edge already
   *  matched) — callers should still persist `snapshotBytes`/hash
   *  bookkeeping, but can skip the VaultDO RPC round trip. */
  changed: boolean;
}

export function finish(doc: LoroDoc, beforeVersion: VersionVector): BuiltDocUpdate {
  doc.commit();
  const afterVersion = doc.oplogVersion();
  const snapshotBytes = doc.export({ mode: "snapshot" });

  // IMPORTANT: `doc.export({mode:"update", from: X})` is NOT a reliable
  // "did anything change" signal by itself — verified empirically (see
  // this task's test suite): even a genuine no-op export (from the doc's
  // OWN current version, nothing new) returns a small but NON-EMPTY byte
  // envelope (encoding overhead, not op content), so a naive
  // `updateBytes.length > 0` check is always true and would make
  // `changed` always true — silently defeating the entire baseline-hash
  // skip mechanism (`materialization.ts`) by pushing a VaultDO write on
  // every cron tick regardless of whether anything actually changed.
  // `VersionVector.compare()` (0 = identical, matching `loro-storage.ts`'s
  // own documented use of this method) is the correct check.
  if (beforeVersion.compare(afterVersion) === 0) {
    return { updateBytes: new Uint8Array(0), snapshotBytes, changed: false };
  }

  const updateBytes = doc.export({ mode: "update", from: beforeVersion });
  return { updateBytes, snapshotBytes, changed: true };
}

export interface BuildEventDocParams {
  pageID: string;
  occurrence: NormalizedEventOccurrence;
  organizerPageID?: string;
  attendeePageIDs: readonly string[];
  /** Which owned fields to actually attempt to write this call — see
   *  `calendar-materialization.ts`'s "PER-FIELD GRANULARITY" and this
   *  file's header. Omitted (or every field passed) reproduces this
   *  function's original always-attempt-every-field behavior, which is
   *  what a brand-new page (no prior baseline to diff against) needs —
   *  `materialization.ts` omits this for first materialization and passes
   *  a narrowed set (from `diffChangedFields`) on every subsequent call. A
   *  field NOT in this set is never even attempted, regardless of what
   *  the doc's own current value happens to be — this is what closes the
   *  silent-overwrite gap beyond `setXIfChanged`'s own current-vs-desired
   *  compare (see `materialized-doc.test.ts`'s "changedFields" tests for
   *  the exact scenario this protects against). */
  changedFields?: ReadonlySet<EventOwnedField>;
  existingSnapshot?: Uint8Array;
  now: Date;
}

const EVENT_ORGANIZER_KEY = { supertagID: CoreSupertagIDs.event, fieldID: "organizer" } as const;
const EVENT_ATTENDEES_KEY = { supertagID: CoreSupertagIDs.event, fieldID: "attendees" } as const;
const ALL_EVENT_FIELDS: ReadonlySet<EventOwnedField> = new Set(EVENT_OWNED_FIELDS);

/** Builds (or updates, if `existingSnapshot` is given) a materialized
 *  Event page's doc. Sets exactly the fields
 *  `calendar-materialization.ts`'s `providerEventProperties` /
 *  `eventFieldBaselineHashes` cover, and ONLY the ones in
 *  `params.changedFields` — see this module's header for the causal-
 *  history reasoning behind `existingSnapshot`. */
export async function buildEventDocUpdate(params: BuildEventDocParams): Promise<BuiltDocUpdate> {
  const doc = openOrCreate(params.existingSnapshot);
  const beforeVersion = doc.oplogVersion();
  const changedFields = params.changedFields ?? ALL_EVENT_FIELDS;

  setRoot(doc, params.pageID);
  if (changedFields.has("title")) setTitleIfChanged(doc, params.occurrence.title);
  setTagIfMissing(doc, CoreSupertagIDs.event);

  if (changedFields.has("start")) {
    setValueIfChanged(doc, CoreSupertagIDs.event, "start", [{ type: "dateTime", value: params.occurrence.start }]);
  }
  if (changedFields.has("end")) {
    setValueIfChanged(doc, CoreSupertagIDs.event, "end", [{ type: "dateTime", value: params.occurrence.end }]);
  }
  if (changedFields.has("isAllDay")) {
    setValueIfChanged(doc, CoreSupertagIDs.event, "all-day", [{ type: "boolean", value: params.occurrence.isAllDay }]);
  }
  if (changedFields.has("calendarTitle")) {
    setValueIfChanged(doc, CoreSupertagIDs.event, "calendar", [{ type: "text", value: params.occurrence.calendarTitle }]);
  }
  // "source" is a fixed constant ("Google Calendar"), not one of
  // `EventOwnedField` — it has no per-field hash to gate on, and
  // `setValueIfChanged`'s own compare already makes every call after the
  // first a true no-op, so it's always attempted (matches original
  // behavior; nothing to protect here since the desired value never
  // varies).
  setValueIfChanged(doc, CoreSupertagIDs.event, "source", [{ type: "text", value: "Google Calendar" }]);
  if (changedFields.has("location")) {
    if (params.occurrence.location) {
      setValueIfChanged(doc, CoreSupertagIDs.event, "location", [{ type: "text", value: params.occurrence.location }]);
    } else {
      deleteValueIfPresent(doc, CoreSupertagIDs.event, "location");
    }
  }

  const organizerRelationID = supertagRegistry.relationIDForProperty(EVENT_ORGANIZER_KEY);
  const attendeesRelationID = supertagRegistry.relationIDForProperty(EVENT_ATTENDEES_KEY);
  const ownedRelationIDs = new Set<string>();
  if (changedFields.has("organizer")) ownedRelationIDs.add(organizerRelationID);
  if (changedFields.has("attendees")) ownedRelationIDs.add(attendeesRelationID);

  const desired: DesiredEdge[] = [];
  if (changedFields.has("organizer") && params.organizerPageID) {
    desired.push({
      edgeID: await deterministicProviderEdgeId(organizerRelationID, params.pageID, params.organizerPageID),
      relationID: organizerRelationID,
      key: EVENT_ORGANIZER_KEY,
      targetNodeID: params.organizerPageID,
    });
  }
  if (changedFields.has("attendees")) {
    for (const attendeePageID of params.attendeePageIDs) {
      desired.push({
        edgeID: await deterministicProviderEdgeId(attendeesRelationID, params.pageID, attendeePageID),
        relationID: attendeesRelationID,
        key: EVENT_ATTENDEES_KEY,
        targetNodeID: attendeePageID,
      });
    }
  }

  reconcileOwnedEdges(doc, params.pageID, ownedRelationIDs, desired, params.now);

  return finish(doc, beforeVersion);
}

export interface BuildPersonDocParams {
  pageID: string;
  email: string;
  displayName?: string;
  /** Which owned fields to actually attempt to write this call — see
   *  `BuildEventDocParams.changedFields`'s doc comment; same contract,
   *  narrowed to Person's two owned fields (`title`, `email`). */
  changedFields?: ReadonlySet<PersonOwnedField>;
  existingSnapshot?: Uint8Array;
  /** `personOrigin` default to apply on a brand-new page (see
   *  `setPersonClassificationIfMissing`) — defaults to
   *  `PERSON_ORIGIN_CALENDAR_ATTENDEE` so every EXISTING call site
   *  (`materialization.ts`'s `materializePersonForEvent`) keeps its exact
   *  original behavior unchanged; `gmail-materialized-doc.ts` passes
   *  `PERSON_ORIGIN_GMAIL_CORRESPONDENT` explicitly. Ignored entirely on a
   *  page that already carries a classification (see that function's doc
   *  comment) — this only ever affects a page's FIRST materialization. */
  origin?: string;
}

const ALL_PERSON_FIELDS: ReadonlySet<PersonOwnedField> = new Set(PERSON_OWNED_FIELDS);

/** Builds (or updates) a materialized Person page's doc — title + email
 *  only (plan: "attendees -> deterministic Person pages"; no
 *  phone/organization/etc. — Calendar's attendee data doesn't carry
 *  those, and this worker never invents fields it has no provider data
 *  for). Also applies the privacy-gate default (see this file's header)
 *  via `setPersonClassificationIfMissing` — always attempted (it's a
 *  one-time "if absent" default, not a per-cron-cycle owned field with its
 *  own baseline hash, so it isn't gated by `changedFields`). */
export async function buildPersonDocUpdate(params: BuildPersonDocParams): Promise<BuiltDocUpdate> {
  const doc = openOrCreate(params.existingSnapshot);
  const beforeVersion = doc.oplogVersion();
  const changedFields = params.changedFields ?? ALL_PERSON_FIELDS;

  setRoot(doc, params.pageID);
  if (changedFields.has("title")) setTitleIfChanged(doc, params.displayName?.trim() || params.email);
  setTagIfMissing(doc, CoreSupertagIDs.person);
  if (changedFields.has("email")) {
    setValueIfChanged(doc, CoreSupertagIDs.person, "email", [{ type: "email", value: params.email }]);
  }
  setPersonClassificationIfMissing(doc, params.origin ?? PERSON_ORIGIN_CALENDAR_ATTENDEE);

  return finish(doc, beforeVersion);
}
