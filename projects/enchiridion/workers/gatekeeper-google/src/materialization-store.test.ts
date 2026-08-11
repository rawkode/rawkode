import { describe, expect, test } from "bun:test";
import { initializeSchema } from "./schema";
import { deleteMaterializationState, getMaterializationState, setMaterializationState } from "./materialization-store";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

describe("materialization-store", () => {
  test("getMaterializationState returns undefined for an unknown page", () => {
    const sql = makeSql();
    expect(getMaterializationState(sql, "calendar_event_deadbeef")).toBeUndefined();
  });

  test("setMaterializationState then getMaterializationState round-trips, including doc bytes and per-field hashes", () => {
    const sql = makeSql();
    const docSnapshot = new Uint8Array([1, 2, 3, 4, 250, 251, 252]);
    setMaterializationState(sql, {
      pageID: "calendar_event_deadbeef",
      fieldHashes: { title: "hash-title-1", location: "hash-location-1" },
      docSnapshot,
      lastSyncedAt: 1000,
    });

    const state = getMaterializationState(sql, "calendar_event_deadbeef");
    expect(state?.fieldHashes).toEqual({ title: "hash-title-1", location: "hash-location-1" });
    expect(state?.lastSyncedAt).toBe(1000);
    expect(Array.from(state!.docSnapshot)).toEqual(Array.from(docSnapshot));
  });

  test("setMaterializationState upserts — a later call for the same pageID overwrites, not duplicates", () => {
    const sql = makeSql();
    setMaterializationState(sql, {
      pageID: "p1",
      fieldHashes: { title: "h1" },
      docSnapshot: new Uint8Array([1]),
      lastSyncedAt: 1000,
    });
    setMaterializationState(sql, {
      pageID: "p1",
      fieldHashes: { title: "h2", location: "h3" },
      docSnapshot: new Uint8Array([2, 2]),
      lastSyncedAt: 2000,
    });

    const state = getMaterializationState(sql, "p1");
    expect(state?.fieldHashes).toEqual({ title: "h2", location: "h3" });
    expect(state?.lastSyncedAt).toBe(2000);
    expect(Array.from(state!.docSnapshot)).toEqual([2, 2]);
  });

  test("deleteMaterializationState removes the row", () => {
    const sql = makeSql();
    setMaterializationState(sql, { pageID: "p1", fieldHashes: { title: "h1" }, docSnapshot: new Uint8Array([1]), lastSyncedAt: 1000 });
    deleteMaterializationState(sql, "p1");
    expect(getMaterializationState(sql, "p1")).toBeUndefined();
  });

  test("different pages are independent", () => {
    const sql = makeSql();
    setMaterializationState(sql, { pageID: "p1", fieldHashes: { title: "h1" }, docSnapshot: new Uint8Array([1]), lastSyncedAt: 1000 });
    setMaterializationState(sql, { pageID: "p2", fieldHashes: { title: "h2" }, docSnapshot: new Uint8Array([2]), lastSyncedAt: 2000 });

    expect(getMaterializationState(sql, "p1")?.fieldHashes).toEqual({ title: "h1" });
    expect(getMaterializationState(sql, "p2")?.fieldHashes).toEqual({ title: "h2" });
  });
});
