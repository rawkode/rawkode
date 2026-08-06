import { describe, expect, test } from "bun:test";
import {
  diffCatalog,
  purgeProjectionRowsForPages,
  readAllCatalogEntries,
  readCatalogEntry,
  readCatalogFromSql,
  reprojectCatalog,
  setTombstone,
  upsertCatalogEntry,
  type CatalogEntry,
} from "./catalog";
import { LoroPageDoc } from "./loro-storage";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";
import { applyInboundCatalogEntries } from "./vault-write-model";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

describe("catalog — CRDT map operations (real loro-crdt LoroMap)", () => {
  test("upsert then read back a single entry", () => {
    const doc = LoroPageDoc.create();
    upsertCatalogEntry(doc, {
      pageID: "daily:2026-08-06",
      docType: "daily",
      createdAt: 1000,
      tombstoned: false,
      updatedAt: 1000,
    });
    doc.commit();

    const entry = readCatalogEntry(doc, "daily:2026-08-06");
    expect(entry).toEqual({
      pageID: "daily:2026-08-06",
      docType: "daily",
      createdAt: 1000,
      tombstoned: false,
      updatedAt: 1000,
    });
  });

  test("readCatalogEntry returns undefined for an unknown pageID", () => {
    const doc = LoroPageDoc.create();
    expect(readCatalogEntry(doc, "nope")).toBeUndefined();
  });

  test("readAllCatalogEntries returns every entry", () => {
    const doc = LoroPageDoc.create();
    upsertCatalogEntry(doc, { pageID: "a", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 1 });
    upsertCatalogEntry(doc, { pageID: "b", docType: "free", createdAt: 2, tombstoned: false, updatedAt: 2 });
    doc.commit();

    const entries = readAllCatalogEntries(doc).sort((a, b) => a.pageID.localeCompare(b.pageID));
    expect(entries.map((e) => e.pageID)).toEqual(["a", "b"]);
  });

  test("tombstone propagation: setTombstone marks an existing entry deleted", () => {
    const doc = LoroPageDoc.create();
    upsertCatalogEntry(doc, { pageID: "p1", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 1 });
    doc.commit();

    const updated = setTombstone(doc, "p1", true, 500);
    doc.commit();

    expect(updated?.tombstoned).toBe(true);
    expect(updated?.updatedAt).toBe(500);
    expect(readCatalogEntry(doc, "p1")?.tombstoned).toBe(true);
  });

  test("explicit undelete: setTombstone(false) after a tombstone", () => {
    const doc = LoroPageDoc.create();
    upsertCatalogEntry(doc, { pageID: "p1", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 1 });
    setTombstone(doc, "p1", true, 500);
    doc.commit();
    expect(readCatalogEntry(doc, "p1")?.tombstoned).toBe(true);

    const undeleted = setTombstone(doc, "p1", false, 900);
    doc.commit();
    expect(undeleted?.tombstoned).toBe(false);
    expect(readCatalogEntry(doc, "p1")?.tombstoned).toBe(false);
    expect(readCatalogEntry(doc, "p1")?.updatedAt).toBe(900);
  });

  test("tombstoning an unknown pageID is a no-op (returns undefined, creates nothing)", () => {
    const doc = LoroPageDoc.create();
    const result = setTombstone(doc, "ghost", true, 1);
    doc.commit();
    expect(result).toBeUndefined();
    expect(readCatalogEntry(doc, "ghost")).toBeUndefined();
  });

  test("last-write-wins at the whole-entry granularity: overwriting replaces the full record", () => {
    const doc = LoroPageDoc.create();
    upsertCatalogEntry(doc, { pageID: "p1", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 1 });
    upsertCatalogEntry(doc, { pageID: "p1", docType: "event", createdAt: 1, tombstoned: true, updatedAt: 2 });
    doc.commit();

    expect(readCatalogEntry(doc, "p1")).toEqual({
      pageID: "p1",
      docType: "event",
      createdAt: 1,
      tombstoned: true,
      updatedAt: 2,
    });
  });

  test("a malformed JSON value in the map is skipped, not thrown", () => {
    const doc = LoroPageDoc.create();
    doc.map("catalog").set("broken", "{not json");
    doc.commit();
    expect(readCatalogEntry(doc, "broken")).toBeUndefined();
    expect(readAllCatalogEntries(doc)).toEqual([]);
  });
});

describe("catalog — SQL mirror reprojection", () => {
  test("reprojectCatalog upserts entries into vault_catalog", () => {
    const sql = makeSql();
    const entries: CatalogEntry[] = [
      { pageID: "a", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 1 },
      { pageID: "b", docType: "daily", createdAt: 2, tombstoned: true, updatedAt: 5 },
    ];
    reprojectCatalog(sql, entries);

    const mirrored = readCatalogFromSql(sql).sort((a, b) => a.pageID.localeCompare(b.pageID));
    expect(mirrored).toEqual(entries);
  });

  test("reprojectCatalog does not let a stale write clobber a newer mirrored row", () => {
    const sql = makeSql();
    reprojectCatalog(sql, [{ pageID: "a", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 10 }]);
    // A stale re-projection (older updatedAt) must not overwrite the newer row.
    reprojectCatalog(sql, [{ pageID: "a", docType: "STALE", createdAt: 1, tombstoned: true, updatedAt: 3 }]);

    const row = readCatalogFromSql(sql).find((e) => e.pageID === "a");
    expect(row?.docType).toBe("free");
    expect(row?.tombstoned).toBe(false);
  });

  test("reprojectCatalog: an exactly-equal updatedAt overwrites — incoming wins the tie (>=, not >)", () => {
    const sql = makeSql();
    reprojectCatalog(sql, [{ pageID: "a", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 10 }]);
    reprojectCatalog(sql, [{ pageID: "a", docType: "updated", createdAt: 1, tombstoned: true, updatedAt: 10 }]);

    const row = readCatalogFromSql(sql).find((e) => e.pageID === "a");
    expect(row?.docType).toBe("updated");
    expect(row?.tombstoned).toBe(true);
  });

  test("purgeProjectionRowsForPages deletes graph_nodes rows for tombstoned pages", () => {
    const sql = makeSql();
    sql.exec(
      "INSERT INTO graph_nodes (node_id, title, kind, created_at, modified_at) VALUES (?, ?, ?, ?, ?)",
      "p1",
      "Deleted page",
      "free",
      1,
      1,
    );
    sql.exec(
      "INSERT INTO graph_nodes (node_id, title, kind, created_at, modified_at) VALUES (?, ?, ?, ?, ?)",
      "p2",
      "Kept page",
      "free",
      1,
      1,
    );
    sql.exec(
      "INSERT INTO projection_state (page_id, last_projected_version_vector, projected_at) VALUES (?, ?, ?)",
      "p1",
      new Uint8Array([]).buffer,
      1,
    );

    purgeProjectionRowsForPages(sql, ["p1"]);

    const remaining = sql.exec<{ node_id: string }>("SELECT node_id FROM graph_nodes").toArray();
    expect(remaining.map((r) => r.node_id)).toEqual(["p2"]);
    expect(sql.exec("SELECT * FROM projection_state WHERE page_id = 'p1'").toArray()).toEqual([]);
  });

  test("purgeProjectionRowsForPages is a no-op for an empty list", () => {
    const sql = makeSql();
    expect(() => purgeProjectionRowsForPages(sql, [])).not.toThrow();
  });
});

describe("catalog — diffCatalog", () => {
  test("finds entries missing from local", () => {
    const local: CatalogEntry[] = [];
    const remote: CatalogEntry[] = [
      { pageID: "a", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 1 },
    ];
    expect(diffCatalog(local, remote)).toEqual(remote);
  });

  test("finds entries that are stale in local", () => {
    const local: CatalogEntry[] = [
      { pageID: "a", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 1 },
    ];
    const remote: CatalogEntry[] = [
      { pageID: "a", docType: "free", createdAt: 1, tombstoned: true, updatedAt: 9 },
    ];
    expect(diffCatalog(local, remote)).toEqual(remote);
  });

  test("does not return entries local already has up to date", () => {
    const shared: CatalogEntry = { pageID: "a", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 5 };
    expect(diffCatalog([shared], [shared])).toEqual([]);
  });

  test("does not return entries where local is newer than remote", () => {
    const local: CatalogEntry[] = [
      { pageID: "a", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 9 },
    ];
    const remote: CatalogEntry[] = [
      { pageID: "a", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 1 },
    ];
    expect(diffCatalog(local, remote)).toEqual([]);
  });
});

// --- Two independent replicas ----------------------------------------------
//
// Every test above operates on a single LoroPageDoc instance, mutated
// sequentially. The tests below exercise the actual multi-device shape:
// two INDEPENDENT replicas concurrently editing the same pageID's catalog
// entry, then merging — same structural pattern as
// `loro-storage.test.ts`'s two-doc export/import tests, applied to catalog
// data specifically. See this file's "WALL-CLOCK LWW, NOT RAW CRDT MERGE"
// header note for why there are two DIFFERENT merge mechanisms tested
// below (raw Loro doc merge vs. `applyInboundCatalogEntries`'s
// `updatedAt` comparison) and why only the second one is guaranteed to
// implement "last-tombstone-wins" by wall clock.

describe("catalog — two independent replicas: raw Loro CRDT map merge (docUpdate-shaped)", () => {
  test("a tombstone on replica A and an undelete on replica B, applied concurrently and merged bidirectionally, converge to the SAME state on both replicas", () => {
    // Shared starting point: both replicas already know about this page.
    const origin = LoroPageDoc.create();
    upsertCatalogEntry(origin, {
      pageID: "p1",
      docType: "free",
      createdAt: 1,
      tombstoned: false,
      updatedAt: 1,
    });
    origin.commit();
    const snapshot = origin.exportSnapshot();

    const replicaA = LoroPageDoc.fromSnapshot(snapshot);
    const replicaB = LoroPageDoc.fromSnapshot(snapshot);
    const beforeA = replicaA.versionVector();
    const beforeB = replicaB.versionVector();

    // Genuinely concurrent: neither replica has seen the other's edit when
    // it makes its own — interleaved/skewed updatedAt on purpose (A's
    // wall-clock write is LATER than B's, deliberately not matching
    // whatever order Loro's internal merge happens to pick).
    setTombstone(replicaA, "p1", true, 9000);
    replicaA.commit();
    setTombstone(replicaB, "p1", false, 3000);
    replicaB.commit();

    const updateFromA = replicaA.exportUpdatesSince(beforeA);
    const updateFromB = replicaB.exportUpdatesSince(beforeB);
    replicaA.importBytes(updateFromB);
    replicaB.importBytes(updateFromA);

    // CRDT convergence is the real, unconditional guarantee here: both
    // replicas land on the IDENTICAL final entry after a bidirectional
    // merge, whichever one Loro's internal (Lamport timestamp, peer ID)
    // resolution happened to pick.
    const finalA = readCatalogEntry(replicaA, "p1");
    const finalB = readCatalogEntry(replicaB, "p1");
    expect(finalA).toEqual(finalB);
    expect(finalA).toBeDefined();

    // Deliberately NOT asserted: that the winner is A's entry (the one
    // with the larger `updatedAt`). Verified empirically (see the task
    // report / this file's header note) that raw Loro map merge does not
    // consult the JSON payload's `updatedAt` at all — this is exactly why
    // production catalog sync goes through `applyInboundCatalogEntries`
    // instead (next describe block), not this raw merge path.
  });
});

describe("catalog — two independent replicas: wall-clock LWW via applyInboundCatalogEntries (the actual `catalogDiff` wire mechanism)", () => {
  function replicaMirroring(entry: CatalogEntry): SqliteStorageAdapter {
    const sql = makeSql();
    reprojectCatalog(sql, [entry]);
    return sql;
  }

  test("a tombstone on replica A and an undelete on replica B converge deterministically to whichever has the larger updatedAt, in both merge directions — matches last-tombstone-wins regardless of skew", () => {
    const base = { pageID: "p1", docType: "free", createdAt: 1 } as const;
    // Skewed on purpose: A's tombstone has a much larger updatedAt than
    // B's undelete, unlike the disjoint-replica raw-merge test above where
    // the point was convergence regardless of winner — here the point is
    // that the winner is DETERMINISTIC and matches the documented rule.
    const tombstoneOnA: CatalogEntry = { ...base, tombstoned: true, updatedAt: 9000 };
    const undeleteOnB: CatalogEntry = { ...base, tombstoned: false, updatedAt: 3000 };

    const sqlA = replicaMirroring(tombstoneOnA);
    const sqlB = replicaMirroring(undeleteOnB);

    // Exchange catalogDiff frames in both directions — exactly what
    // vault-do.ts's `"catalogDiff"` handler does per connected peer.
    applyInboundCatalogEntries(sqlA, [undeleteOnB], 10_000);
    applyInboundCatalogEntries(sqlB, [tombstoneOnA], 10_000);

    const finalA = readCatalogFromSql(sqlA).find((e) => e.pageID === "p1");
    const finalB = readCatalogFromSql(sqlB).find((e) => e.pageID === "p1");
    // Last-tombstone-wins: the larger `updatedAt` (A's tombstone) wins on
    // BOTH replicas, deterministically.
    expect(finalA).toEqual(tombstoneOnA);
    expect(finalB).toEqual(tombstoneOnA);
  });

  test("equal-updatedAt tie-break: the incoming entry wins on both replicas — matches reprojectCatalog's >= guard", () => {
    const existing: CatalogEntry = {
      pageID: "p1",
      docType: "free",
      createdAt: 1,
      tombstoned: false,
      updatedAt: 5000,
    };
    const incoming: CatalogEntry = {
      pageID: "p1",
      docType: "free",
      createdAt: 1,
      tombstoned: true,
      updatedAt: 5000,
    };

    const sql = replicaMirroring(existing);
    const applied = applyInboundCatalogEntries(sql, [incoming], 10_000);

    expect(applied).toEqual([incoming]);
    expect(readCatalogFromSql(sql).find((e) => e.pageID === "p1")).toEqual(incoming);
  });
});
