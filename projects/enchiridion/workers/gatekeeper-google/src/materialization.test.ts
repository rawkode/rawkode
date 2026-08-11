// @enchiridion/worker-gatekeeper-google — orchestration-level tests for
// `materialization.ts`. `materialized-doc.test.ts` already covers the doc-
// construction layer's `changedFields` gating directly (synthetic
// `changedFields` sets); this file exercises the REAL orchestration path
// end to end: computed per-field hashes -> `diffChangedFields` -> the
// actual bytes this worker would push to VaultDO — including a full
// simulated VaultDO merge (via real `loro-crdt`, not a mock) to prove the
// pushed update genuinely doesn't clobber a diverged field once merged
// into the receiving doc, not just that the constructed doc "looks right"
// in isolation. See materialized-doc.ts's file header and this file's
// sibling calendar-materialization.ts for the underlying per-field hash
// mechanism (Fix 2) and calendar-attendee privacy gate (Fix 1) this file
// verifies orchestrated together.

import { describe, expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt/bundler";
import { decodeEdgeEntry, decodePropertyValues, PageContainer } from "@enchiridion/projection";
import { initializeSchema } from "./schema";
import { getMaterializationState } from "./materialization-store";
import { CoreSupertagIDs } from "./supertag-registry";
import { materializeEventOccurrence, materializePersonForEvent, retractCancelledEvent } from "./materialization";
import type { NormalizedEventOccurrence } from "./calendar-materialization";
import { createFakeVaultEnv, type CreateOrUpdateCall } from "./test-helpers/fake-vault-env";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Imports a pushed update's bytes into a plain `LoroDoc`, simulating what
 *  VaultDO would do with `createOrUpdatePage`'s `updateBytesBase64` — used
 *  to assert on what a REAL receiving doc ends up looking like after
 *  merging this worker's push, not just what this worker computed
 *  in-process. */
function applyPush(doc: LoroDoc, call: CreateOrUpdateCall): void {
  doc.import(base64ToBytes(call.updateBytesBase64));
}

function setTitle(doc: LoroDoc, title: string): void {
  const text = doc.getText(PageContainer.title);
  const current = text.toString();
  if (current.length > 0) text.delete(0, current.length);
  text.insert(0, title);
  doc.commit();
}

const BASE_OCCURRENCE: NormalizedEventOccurrence = {
  pageID: "calendar_event_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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

describe("materializeEventOccurrence — per-field baseline hashing (Fix 2)", () => {
  test("an unchanged occurrence on a second run is a true skip (no VaultDO push at all)", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    await materializeEventOccurrence(sql, vault.env, BASE_OCCURRENCE, new Date("2026-08-06T09:00:00Z"));
    const pushesAfterFirst = vault.createOrUpdateCalls.length;

    const second = await materializeEventOccurrence(sql, vault.env, BASE_OCCURRENCE, new Date("2026-08-06T10:00:00Z"));

    expect(second.applied).toBe(false);
    expect(vault.createOrUpdateCalls.length).toBe(pushesAfterFirst);
  });

  test("REGRESSION GUARD: changing ONLY the provider's location does not overwrite a title that has since diverged in the real vault doc", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    const first = await materializeEventOccurrence(sql, vault.env, BASE_OCCURRENCE, new Date("2026-08-06T09:00:00Z"));
    expect(first.applied).toBe(true);

    // Reconstruct what VaultDO now holds: import this worker's first push,
    // then simulate a REAL device renaming the title directly on the vault
    // page — this worker never learns about this edit (it only ever
    // re-reads its OWN persisted snapshot, never vault's live state, see
    // materialized-doc.ts's header).
    const firstEventPush = vault.createOrUpdateCalls.find((c) => c.docType === "calendarMaterializedEvent" && c.pageID === BASE_OCCURRENCE.pageID)!;
    const vaultDoc = new LoroDoc();
    applyPush(vaultDoc, firstEventPush);
    expect(vaultDoc.getText(PageContainer.title).toString()).toBe("Team sync");
    setTitle(vaultDoc, "User Renamed Title");

    // The provider now reports a location change only — title is
    // identical to what it was at first materialization.
    const changedOccurrence: NormalizedEventOccurrence = { ...BASE_OCCURRENCE, location: "Meeting Room 2 (moved)" };
    const second = await materializeEventOccurrence(sql, vault.env, changedOccurrence, new Date("2026-08-06T10:00:00Z"));
    expect(second.applied).toBe(true);

    const pushesAfterSecond = vault.createOrUpdateCalls.filter(
      (c) => c.docType === "calendarMaterializedEvent" && c.pageID === BASE_OCCURRENCE.pageID,
    );
    expect(pushesAfterSecond.length).toBe(2);
    applyPush(vaultDoc, pushesAfterSecond[1]!);

    // The user's rename survives the merge — THIS is the exact regression
    // the original bundle-granular baseline hash would have failed: a
    // naive full-field rewrite would have re-attempted `setTitleIfChanged`
    // with the provider's "Team sync" against whatever this worker's OWN
    // local snapshot held (also "Team sync", since title never changed at
    // the source) — a no-op on THIS worker's own doc, but the real risk
    // this test guards is `changedFields` staying narrow enough that
    // title is never even attempted, independent of what this worker's
    // own copy happens to hold.
    expect(vaultDoc.getText(PageContainer.title).toString()).toBe("User Renamed Title");

    const values = vaultDoc.getMap(PageContainer.values).getShallowValue();
    const location = decodePropertyValues(values[`property:${CoreSupertagIDs.event}:location`] as string);
    expect(location).toEqual([{ type: "text", value: "Meeting Room 2 (moved)" }]);
  });

  test("the persisted per-field hash map only updates the fields that actually changed", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    await materializeEventOccurrence(sql, vault.env, BASE_OCCURRENCE, new Date("2026-08-06T09:00:00Z"));
    const firstHashes = getMaterializationState(sql, BASE_OCCURRENCE.pageID)!.fieldHashes;

    const changedOccurrence: NormalizedEventOccurrence = { ...BASE_OCCURRENCE, location: "Meeting Room 2 (moved)" };
    await materializeEventOccurrence(sql, vault.env, changedOccurrence, new Date("2026-08-06T10:00:00Z"));
    const secondHashes = getMaterializationState(sql, BASE_OCCURRENCE.pageID)!.fieldHashes;

    expect(secondHashes["location"]).not.toBe(firstHashes["location"]);
    expect(secondHashes["title"]).toBe(firstHashes["title"]);
    expect(secondHashes["start"]).toBe(firstHashes["start"]);
    expect(secondHashes["organizer"]).toBe(firstHashes["organizer"]);
    expect(secondHashes["attendees"]).toBe(firstHashes["attendees"]);
  });
});

describe("materializePersonForEvent — privacy gate (Fix 1) orchestrated end to end", () => {
  test("the pushed bytes for a brand-new attendee set personVisibility='other'/personOrigin='calendarAttendee'", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    const result = await materializePersonForEvent(sql, vault.env, "guest@example.com", "Guest Person", new Date("2026-08-06T09:00:00Z"));
    expect(result.applied).toBe(true);

    const push = vault.createOrUpdateCalls.find((c) => c.docType === "person" && c.pageID === result.pageID)!;
    const doc = new LoroDoc();
    applyPush(doc, push);
    const metadata = doc.getMap(PageContainer.objectMetadata).getShallowValue() as Record<string, unknown>;
    expect(metadata["personVisibility"]).toBe("other");
    expect(metadata["personOrigin"]).toBe("calendarAttendee");
  });

  test("materializing the SAME attendee again (no field change) is a skip — no second push", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    await materializePersonForEvent(sql, vault.env, "guest@example.com", "Guest Person", new Date("2026-08-06T09:00:00Z"));
    const pushCountAfterFirst = vault.createOrUpdateCalls.length;

    const second = await materializePersonForEvent(sql, vault.env, "guest@example.com", "Guest Person", new Date("2026-08-06T10:00:00Z"));

    expect(second.applied).toBe(false);
    expect(vault.createOrUpdateCalls.length).toBe(pushCountAfterFirst);
  });

  test("a changed display name re-materializes but never re-touches an already-promoted classification merged into vault", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    const first = await materializePersonForEvent(sql, vault.env, "guest@example.com", "Guest Person", new Date("2026-08-06T09:00:00Z"));
    const firstPush = vault.createOrUpdateCalls.find((c) => c.docType === "person" && c.pageID === first.pageID)!;
    const vaultDoc = new LoroDoc();
    applyPush(vaultDoc, firstPush);

    // A user promotes this Person via some future in-app action (out of
    // this task's scope) directly on the real vault doc.
    const metadata = vaultDoc.getMap(PageContainer.objectMetadata);
    metadata.set("personVisibility", "promoted");
    metadata.set("personOrigin", "manual");
    vaultDoc.commit();

    // A later cron tick sees a real display-name change at the provider.
    const second = await materializePersonForEvent(
      sql,
      vault.env,
      "guest@example.com",
      "Guest P. Renamed",
      new Date("2026-08-06T10:00:00Z"),
    );
    expect(second.applied).toBe(true);

    const secondPush = vault.createOrUpdateCalls.filter((c) => c.docType === "person" && c.pageID === first.pageID)[1]!;
    applyPush(vaultDoc, secondPush);

    expect(vaultDoc.getText(PageContainer.title).toString()).toBe("Guest P. Renamed");
    const finalMetadata = vaultDoc.getMap(PageContainer.objectMetadata).getShallowValue() as Record<string, unknown>;
    expect(finalMetadata["personVisibility"]).toBe("promoted");
    expect(finalMetadata["personOrigin"]).toBe("manual");
  });
});

describe("retractCancelledEvent", () => {
  test("tombstones a previously-materialized page and clears its local state", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    await materializeEventOccurrence(sql, vault.env, BASE_OCCURRENCE, new Date("2026-08-06T09:00:00Z"));

    const result = await retractCancelledEvent(sql, vault.env, BASE_OCCURRENCE.pageID);

    expect(result.tombstoned).toBe(true);
    expect(vault.tombstoneCalls).toContain(BASE_OCCURRENCE.pageID);
    expect(getMaterializationState(sql, BASE_OCCURRENCE.pageID)).toBeUndefined();
  });

  test("is a no-op for a page this worker never materialized", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    const result = await retractCancelledEvent(sql, vault.env, "calendar_event_never_seen");

    expect(result.tombstoned).toBe(false);
    expect(vault.tombstoneCalls).toEqual([]);
  });
});

describe("materializeEventOccurrence — edges reference deterministic Person pages", () => {
  test("organizer and attendee edges point at the SAME pageIDs materializePersonForEvent produced", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    const result = await materializeEventOccurrence(sql, vault.env, BASE_OCCURRENCE, new Date("2026-08-06T09:00:00Z"));
    expect(result.personPageIDs.length).toBe(2); // organizer + one attendee

    const push = vault.createOrUpdateCalls.find((c) => c.docType === "calendarMaterializedEvent")!;
    const doc = new LoroDoc();
    applyPush(doc, push);
    const edges = doc.getMap(PageContainer.edges).getShallowValue();
    const decoded = Object.values(edges).map((json) => decodeEdgeEntry(json as string, BASE_OCCURRENCE.pageID)!);
    const targets = decoded.map((e) => e.targetNodeID).sort();
    expect(targets).toEqual([...result.personPageIDs].sort());
  });
});
