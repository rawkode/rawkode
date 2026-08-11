import { describe, expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt/bundler";
import { decodeEdgeEntry, decodePropertyValues, PageContainer } from "@enchiridion/projection";
import { CoreSupertagIDs } from "./supertag-registry";
import { buildEventDocUpdate, buildPersonDocUpdate } from "./materialized-doc";
import type { EventOwnedField, NormalizedEventOccurrence } from "./calendar-materialization";

const BASE_OCCURRENCE: NormalizedEventOccurrence = {
  pageID: "calendar_event_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  status: "confirmed",
  title: "Team sync",
  start: new Date("2026-08-10T09:00:00.000Z").toISOString(),
  end: new Date("2026-08-10T09:30:00.000Z").toISOString(),
  isAllDay: false,
  calendarTitle: "david@rawkode.academy",
  location: "Meeting Room 1",
  organizer: { email: "david@rawkode.academy", displayName: "David Flanagan" },
  attendees: [{ email: "guest@example.com", displayName: "Guest Person" }],
};

/** Opens a raw snapshot for assertions — deliberately using `loro-crdt`
 *  directly (not `@enchiridion/projection`'s `openProjectionDoc`, which
 *  this test also uses for map-shallow-value reads) so both this worker's
 *  own construction code AND the read side agree independently on the
 *  resulting bytes' meaning. */
function reopen(snapshot: Uint8Array): LoroDoc {
  return LoroDoc.fromSnapshot(snapshot);
}

describe("buildEventDocUpdate", () => {
  test("first materialization produces a real, non-empty update and a valid snapshot", async () => {
    const result = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      organizerPageID: "person_organizer",
      attendeePageIDs: ["person_guest"],
      now: new Date("2026-08-06T09:00:00.000Z"),
    });

    expect(result.changed).toBe(true);
    expect(result.updateBytes.length).toBeGreaterThan(0);

    const doc = reopen(result.snapshotBytes);
    expect(doc.getText(PageContainer.title).toString()).toBe("Team sync");
    expect(doc.getMap(PageContainer.tags).getShallowValue()[CoreSupertagIDs.event]).toBe(true);
    expect(doc.getMap(PageContainer.root).getShallowValue().pageID).toBe(BASE_OCCURRENCE.pageID);

    const values = doc.getMap(PageContainer.values).getShallowValue();
    const startValue = decodePropertyValues(values[`property:${CoreSupertagIDs.event}:start`] as string);
    expect(startValue).toEqual([{ type: "dateTime", value: BASE_OCCURRENCE.start }]);
    const locationValue = decodePropertyValues(values[`property:${CoreSupertagIDs.event}:location`] as string);
    expect(locationValue).toEqual([{ type: "text", value: "Meeting Room 1" }]);

    const edges = doc.getMap(PageContainer.edges).getShallowValue();
    const decoded = Object.values(edges).map((json) => decodeEdgeEntry(json as string, BASE_OCCURRENCE.pageID)!);
    const targets = decoded.map((e) => e.targetNodeID).sort();
    expect(targets).toEqual(["person_guest", "person_organizer"]);
    expect(decoded.every((e) => e.origin === "provider")).toBe(true);
  });

  test("re-materializing the SAME occurrence from the persisted snapshot is a true no-op", async () => {
    const first = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      organizerPageID: "person_organizer",
      attendeePageIDs: ["person_guest"],
      now: new Date("2026-08-06T09:00:00.000Z"),
    });

    const second = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      organizerPageID: "person_organizer",
      attendeePageIDs: ["person_guest"],
      existingSnapshot: first.snapshotBytes,
      now: new Date("2026-08-06T09:05:00.000Z"),
    });

    expect(second.changed).toBe(false);
    expect(second.updateBytes.length).toBe(0);
  });

  test("a changed field (location) re-materializes and overwrites just that field", async () => {
    const first = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      attendeePageIDs: [],
      now: new Date("2026-08-06T09:00:00.000Z"),
    });

    const changedOccurrence: NormalizedEventOccurrence = { ...BASE_OCCURRENCE, location: "Meeting Room 2 (moved)" };
    const second = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: changedOccurrence,
      attendeePageIDs: [],
      existingSnapshot: first.snapshotBytes,
      now: new Date("2026-08-06T10:00:00.000Z"),
    });

    expect(second.changed).toBe(true);
    const doc = reopen(second.snapshotBytes);
    const values = doc.getMap(PageContainer.values).getShallowValue();
    const location = decodePropertyValues(values[`property:${CoreSupertagIDs.event}:location`] as string);
    expect(location).toEqual([{ type: "text", value: "Meeting Room 2 (moved)" }]);
    // Title, untouched by this change, still holds its prior value —
    // proves the "only overwrite fields materialization owns, and only
    // when they change" rule, not a blanket rewrite.
    expect(doc.getText(PageContainer.title).toString()).toBe("Team sync");
  });

  test("an organizer change removes the stale organizer edge and adds the new one", async () => {
    const first = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      organizerPageID: "person_old_organizer",
      attendeePageIDs: [],
      now: new Date("2026-08-06T09:00:00.000Z"),
    });

    const second = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      organizerPageID: "person_new_organizer",
      attendeePageIDs: [],
      existingSnapshot: first.snapshotBytes,
      now: new Date("2026-08-06T10:00:00.000Z"),
    });

    const doc = reopen(second.snapshotBytes);
    const edges = doc.getMap(PageContainer.edges).getShallowValue();
    const decoded = Object.values(edges).map((json) => decodeEdgeEntry(json as string, BASE_OCCURRENCE.pageID)!);
    const targets = decoded.map((e) => e.targetNodeID);
    expect(targets).toEqual(["person_new_organizer"]);
    expect(targets).not.toContain("person_old_organizer");
  });

  test("an attendee list change adds/removes only the affected attendee edges", async () => {
    const first = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      attendeePageIDs: ["person_a", "person_b"],
      now: new Date("2026-08-06T09:00:00.000Z"),
    });

    const second = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      attendeePageIDs: ["person_a", "person_c"],
      existingSnapshot: first.snapshotBytes,
      now: new Date("2026-08-06T10:00:00.000Z"),
    });

    const doc = reopen(second.snapshotBytes);
    const edges = doc.getMap(PageContainer.edges).getShallowValue();
    const decoded = Object.values(edges).map((json) => decodeEdgeEntry(json as string, BASE_OCCURRENCE.pageID)!);
    const targets = decoded.map((e) => e.targetNodeID).sort();
    expect(targets).toEqual(["person_a", "person_c"]);
  });

  test("a user-authored edge (origin !== 'provider') on the same page is never touched", async () => {
    const first = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      attendeePageIDs: ["person_a"],
      now: new Date("2026-08-06T09:00:00.000Z"),
    });

    // Simulate a real device having since added its own, unrelated edge to
    // this same page (e.g. a manual `mentions` link) directly on top of
    // this worker's snapshot — reconciliation must leave it alone.
    const doc = reopen(first.snapshotBytes);
    doc.getMap(PageContainer.edges).set(
      "edge_user_1",
      JSON.stringify({
        id: "edge_user_1",
        relationID: "dev.rawkode.enchiridion.core.mentions",
        sourceNodeID: BASE_OCCURRENCE.pageID,
        targetNodeID: "page_some_note",
        origin: "user",
        createdAt: new Date().toISOString(),
      }),
    );
    doc.commit();
    const withUserEdge = doc.export({ mode: "snapshot" });

    const second = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      attendeePageIDs: ["person_b"], // attendee changed, forcing reconciliation to run
      existingSnapshot: withUserEdge,
      now: new Date("2026-08-06T11:00:00.000Z"),
    });

    const finalDoc = reopen(second.snapshotBytes);
    const edges = finalDoc.getMap(PageContainer.edges).getShallowValue();
    expect(edges["edge_user_1"]).toBeDefined();
    const decoded = decodeEdgeEntry(edges["edge_user_1"] as string, BASE_OCCURRENCE.pageID);
    expect(decoded?.targetNodeID).toBe("page_some_note");
  });

  test("materialized Event pages never carry personVisibility/personOrigin — those belong only to Person pages", async () => {
    const result = await buildEventDocUpdate({
      pageID: BASE_OCCURRENCE.pageID,
      occurrence: BASE_OCCURRENCE,
      attendeePageIDs: [],
      now: new Date("2026-08-06T09:00:00.000Z"),
    });
    const doc = reopen(result.snapshotBytes);
    const metadata = doc.getMap(PageContainer.objectMetadata).getShallowValue() as Record<string, unknown>;
    expect(metadata["personVisibility"]).toBeUndefined();
    expect(metadata["personOrigin"]).toBeUndefined();
  });

  describe("changedFields gating — per-field baseline hashing (Fix 2)", () => {
    // THE REGRESSION TEST: reproduces the exact silent-overwrite bug the
    // task brief describes — "provider changes location, worker also
    // rewrites title back to the provider's stale-relative-to-user value"
    // — by constructing a doc whose LOCALLY-LOADED title has diverged from
    // what a naive (bundle-hash, always-attempt-every-field) rewrite would
    // produce, then re-materializing with ONLY `location` in
    // `changedFields`.
    function docWithDivergedTitle(snapshot: Uint8Array, divergedTitle: string): Uint8Array {
      const doc = reopen(snapshot);
      const text = doc.getText(PageContainer.title);
      const current = text.toString();
      if (current.length > 0) text.delete(0, current.length);
      text.insert(0, divergedTitle);
      doc.commit();
      return doc.export({ mode: "snapshot" });
    }

    test("with a narrowed changedFields (only 'location'), a diverged title is left completely untouched", async () => {
      const first = await buildEventDocUpdate({
        pageID: BASE_OCCURRENCE.pageID,
        occurrence: BASE_OCCURRENCE,
        attendeePageIDs: [],
        now: new Date("2026-08-06T09:00:00.000Z"),
      });

      // Simulate the doc's locally-loaded title having diverged from what
      // this worker would naively rewrite it to (e.g. representing drift
      // this worker's own reopened copy shouldn't clobber).
      const diverged = docWithDivergedTitle(first.snapshotBytes, "Diverged Title (do not touch)");

      const changedOccurrence: NormalizedEventOccurrence = { ...BASE_OCCURRENCE, location: "Moved Room" };
      const onlyLocationChanged: ReadonlySet<EventOwnedField> = new Set(["location"]);
      const second = await buildEventDocUpdate({
        pageID: BASE_OCCURRENCE.pageID,
        occurrence: changedOccurrence,
        attendeePageIDs: [],
        changedFields: onlyLocationChanged,
        existingSnapshot: diverged,
        now: new Date("2026-08-06T10:00:00.000Z"),
      });

      expect(second.changed).toBe(true);
      const doc = reopen(second.snapshotBytes);
      // Title was NEVER attempted — it keeps the diverged value, not the
      // provider's "Team sync" and not anything materialization computed.
      expect(doc.getText(PageContainer.title).toString()).toBe("Diverged Title (do not touch)");
      const values = doc.getMap(PageContainer.values).getShallowValue();
      const location = decodePropertyValues(values[`property:${CoreSupertagIDs.event}:location`] as string);
      expect(location).toEqual([{ type: "text", value: "Moved Room" }]);
    });

    test("CONTRAST — omitting changedFields (the old bundle-granular behavior) DOES clobber the same diverged title", async () => {
      const first = await buildEventDocUpdate({
        pageID: BASE_OCCURRENCE.pageID,
        occurrence: BASE_OCCURRENCE,
        attendeePageIDs: [],
        now: new Date("2026-08-06T09:00:00.000Z"),
      });
      const diverged = docWithDivergedTitle(first.snapshotBytes, "Diverged Title (do not touch)");

      const changedOccurrence: NormalizedEventOccurrence = { ...BASE_OCCURRENCE, location: "Moved Room" };
      const second = await buildEventDocUpdate({
        pageID: BASE_OCCURRENCE.pageID,
        occurrence: changedOccurrence,
        attendeePageIDs: [],
        // No changedFields — every owned field is attempted, exactly the
        // pre-fix, bundle-granular behavior.
        existingSnapshot: diverged,
        now: new Date("2026-08-06T10:00:00.000Z"),
      });

      const doc = reopen(second.snapshotBytes);
      // Title gets forced back to the provider's value, silently
      // discarding whatever it had diverged to — this is the bug Fix 2
      // closes when `materialization.ts` passes a real `changedFields`.
      expect(doc.getText(PageContainer.title).toString()).toBe("Team sync");
    });

    test("organizer edges are only reconciled when 'organizer' is in changedFields", async () => {
      const first = await buildEventDocUpdate({
        pageID: BASE_OCCURRENCE.pageID,
        occurrence: BASE_OCCURRENCE,
        organizerPageID: "person_old_organizer",
        attendeePageIDs: [],
        now: new Date("2026-08-06T09:00:00.000Z"),
      });

      const onlyLocationChanged: ReadonlySet<EventOwnedField> = new Set(["location"]);
      const second = await buildEventDocUpdate({
        pageID: BASE_OCCURRENCE.pageID,
        occurrence: { ...BASE_OCCURRENCE, location: "Moved Room" },
        // A different organizer is passed, but "organizer" isn't in
        // changedFields — the stale edge must survive untouched.
        organizerPageID: "person_new_organizer",
        attendeePageIDs: [],
        changedFields: onlyLocationChanged,
        existingSnapshot: first.snapshotBytes,
        now: new Date("2026-08-06T10:00:00.000Z"),
      });

      const doc = reopen(second.snapshotBytes);
      const edges = doc.getMap(PageContainer.edges).getShallowValue();
      const decoded = Object.values(edges).map((json) => decodeEdgeEntry(json as string, BASE_OCCURRENCE.pageID)!);
      expect(decoded.map((e) => e.targetNodeID)).toEqual(["person_old_organizer"]);
    });
  });
});

describe("buildPersonDocUpdate", () => {
  test("first materialization sets title (from displayName) + email", async () => {
    const result = await buildPersonDocUpdate({ pageID: "person_abc", email: "guest@example.com", displayName: "Guest Person" });
    expect(result.changed).toBe(true);

    const doc = reopen(result.snapshotBytes);
    expect(doc.getText(PageContainer.title).toString()).toBe("Guest Person");
    expect(doc.getMap(PageContainer.tags).getShallowValue()[CoreSupertagIDs.person]).toBe(true);
    const values = doc.getMap(PageContainer.values).getShallowValue();
    const email = decodePropertyValues(values[`property:${CoreSupertagIDs.person}:email`] as string);
    expect(email).toEqual([{ type: "email", value: "guest@example.com" }]);
  });

  test("falls back to the email as the title when there is no displayName", async () => {
    const result = await buildPersonDocUpdate({ pageID: "person_abc", email: "no-name@example.com" });
    const doc = reopen(result.snapshotBytes);
    expect(doc.getText(PageContainer.title).toString()).toBe("no-name@example.com");
  });

  test("re-materializing with unchanged input is a no-op", async () => {
    const first = await buildPersonDocUpdate({ pageID: "person_abc", email: "guest@example.com", displayName: "Guest Person" });
    const second = await buildPersonDocUpdate({
      pageID: "person_abc",
      email: "guest@example.com",
      displayName: "Guest Person",
      existingSnapshot: first.snapshotBytes,
    });
    expect(second.changed).toBe(false);
  });

  describe("privacy gate — calendar-attendee Person visibility/origin (Fix 1)", () => {
    test("a brand-new attendee-derived Person page is born personVisibility='other', personOrigin='calendarAttendee'", async () => {
      const result = await buildPersonDocUpdate({ pageID: "person_abc", email: "guest@example.com", displayName: "Guest Person" });
      expect(result.changed).toBe(true);

      const doc = reopen(result.snapshotBytes);
      const metadata = doc.getMap(PageContainer.objectMetadata).getShallowValue() as Record<string, unknown>;
      expect(metadata["personVisibility"]).toBe("other");
      expect(metadata["personOrigin"]).toBe("calendarAttendee");
    });

    test("re-materializing an already-classified page never overwrites its classification (never auto-promoted, never auto-demoted)", async () => {
      const first = await buildPersonDocUpdate({ pageID: "person_abc", email: "guest@example.com", displayName: "Guest Person" });

      // Simulate a user having since promoted this Person via some future
      // in-app action (out of this task's scope) — directly setting
      // objectMetadata the way that action would.
      const doc = reopen(first.snapshotBytes);
      const metadata = doc.getMap(PageContainer.objectMetadata);
      metadata.set("personVisibility", "promoted");
      metadata.set("personOrigin", "manual");
      doc.commit();
      const promoted = doc.export({ mode: "snapshot" });

      // A later cron tick re-materializes the same attendee with a changed
      // display name (a real field change, forcing a real write).
      const second = await buildPersonDocUpdate({
        pageID: "person_abc",
        email: "guest@example.com",
        displayName: "Guest P. Renamed",
        existingSnapshot: promoted,
      });

      expect(second.changed).toBe(true);
      const finalDoc = reopen(second.snapshotBytes);
      expect(finalDoc.getText(PageContainer.title).toString()).toBe("Guest P. Renamed");
      const finalMetadata = finalDoc.getMap(PageContainer.objectMetadata).getShallowValue() as Record<string, unknown>;
      // Classification survives completely untouched — this worker has no
      // code path that ever writes "promoted"/"manual", but it must also
      // never revert a value it didn't write itself.
      expect(finalMetadata["personVisibility"]).toBe("promoted");
      expect(finalMetadata["personOrigin"]).toBe("manual");
    });
  });
});
