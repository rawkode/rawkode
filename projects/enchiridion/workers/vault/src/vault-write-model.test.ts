import { describe, expect, test } from "bun:test";
import { readCatalogEntryFromSql, VAULT_META_PAGE_ID } from "./catalog";
import {
  appendPendingUpdate,
  compactDoc,
  COMPACTION_PENDING_UPDATE_THRESHOLD,
  countPendingUpdates,
  docExists,
  openDoc,
} from "./doc-store";
import { emptyVersionVector, encodeVersionVector, LoroPageDoc } from "./loro-storage";
import { readProjectedVersionVector } from "./projection";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";
import {
  applyInboundCatalogEntries,
  applyInboundDocBytes,
  catalogSnapshotForWire,
  computeDocSyncResponse,
  createOrUpdatePage,
  healPageDriftIfNeeded,
  tombstonePage,
  undeletePage,
} from "./vault-write-model";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

/** Builds standalone update bytes for a page as if a client had created
 *  one locally and never talked to the server — the shape
 *  `createOrUpdatePage` expects for `updateBytes`. */
function clientUpdateBytes(mutate: (doc: LoroPageDoc) => void): Uint8Array {
  const doc = LoroPageDoc.create();
  mutate(doc);
  doc.commit();
  return doc.exportAllUpdates();
}

describe("createOrUpdatePage — write-model RPC", () => {
  test("first write creates a catalog entry, persists the doc, and reprojects graph_nodes", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => {
      doc.text("title").insert(0, "My Page");
      doc.text("body").insert(0, "Hello");
    });

    const result = createOrUpdatePage(sql, "page_1", "free", bytes, 1000);

    expect(result.applied).toBe(true);
    expect(result.catalogEntry).toEqual({
      pageID: "page_1",
      docType: "free",
      createdAt: 1000,
      tombstoned: false,
      updatedAt: 1000,
    });

    expect(docExists(sql, "page_1")).toBe(true);
    const row = sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_1'").one() as Record<
      string,
      unknown
    >;
    expect(row.title).toBe("My Page");
    expect(row.plain_text).toBe("Hello");
    expect(row.kind).toBe("free");

    // modifiedAt was set as a real doc edit by the write path.
    expect(row.modified_at).toBe(1000);
  });

  test("second write to the same page does not create a second catalog entry", () => {
    const sql = makeSql();
    const bytes1 = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "page_1", "free", bytes1, 1000);

    const bytes2 = clientUpdateBytes((doc) => doc.text("title").insert(0, "B"));
    const result = createOrUpdatePage(sql, "page_1", "event", bytes2, 2000);

    // docType from the SECOND call is ignored — the catalog entry from the
    // first write wins, matching the documented "docType only consulted
    // the first time" contract.
    expect(result.catalogEntry.docType).toBe("free");
    expect(result.catalogEntry.createdAt).toBe(1000);

    const count = sql
      .exec<{ n: number }>("SELECT count(*) as n FROM vault_catalog WHERE page_id = 'page_1'")
      .one().n;
    expect(count).toBe(1);
  });

  test("a no-op merge (bytes the doc already has) reports applied: false and touches nothing new", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "page_1", "free", bytes, 1000);
    const before = sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_1'").one();

    const result = createOrUpdatePage(sql, "page_1", "free", bytes, 2000);
    expect(result.applied).toBe(false);

    const after = sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_1'").one();
    expect(after).toEqual(before);
  });

  test("modifiedAt updates on a genuinely new write to an existing page", () => {
    const sql = makeSql();
    const bytes1 = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "page_1", "free", bytes1, 1000);

    const writer = openDoc(sql, "page_1");
    const beforeVV = writer.versionVector();
    writer.text("title").insert(1, "B");
    writer.commit();
    const bytes2 = writer.exportUpdatesSince(beforeVV);

    createOrUpdatePage(sql, "page_1", "free", bytes2, 5000);
    const row = sql.exec("SELECT modified_at, title FROM graph_nodes WHERE node_id = 'page_1'").one() as Record<
      string,
      unknown
    >;
    expect(row.modified_at).toBe(5000);
    expect(row.title).toBe("AB");
  });

  test("records lastProjectedVersion matching the doc's version vector after the write", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "page_1", "free", bytes, 1000);

    const doc = openDoc(sql, "page_1");
    const currentVV = doc.versionVector();
    expect(readProjectedVersionVector(sql, "page_1")).toEqual(encodeVersionVector(currentVV));
  });
});

describe("tombstonePage / undeletePage", () => {
  function seedPage(sql: SqliteStorageAdapter, pageID: string): void {
    const bytes = clientUpdateBytes((doc) => {
      doc.text("title").insert(0, "Doomed");
      doc.text("body").insert(0, "Content");
    });
    createOrUpdatePage(sql, pageID, "free", bytes, 1000);
  }

  test("tombstonePage marks the catalog entry deleted and purges graph_nodes", () => {
    const sql = makeSql();
    seedPage(sql, "page_1");
    expect(sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_1'").toArray()).toHaveLength(1);

    const result = tombstonePage(sql, "page_1", 5000);
    expect(result?.tombstoned).toBe(true);
    expect(sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_1'").toArray()).toHaveLength(0);

    const catalogEntry = readCatalogEntryFromSql(sql, "page_1");
    expect(catalogEntry?.tombstoned).toBe(true);
    expect(catalogEntry?.updatedAt).toBe(5000);
  });

  test("tombstoning an unknown page returns undefined and changes nothing", () => {
    const sql = makeSql();
    expect(tombstonePage(sql, "ghost", 1000)).toBeUndefined();
    expect(readCatalogEntryFromSql(sql, "ghost")).toBeUndefined();
  });

  test("undeletePage clears the tombstone and re-derives graph_nodes from the never-deleted doc", () => {
    const sql = makeSql();
    seedPage(sql, "page_1");
    tombstonePage(sql, "page_1", 5000);
    expect(sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_1'").toArray()).toHaveLength(0);

    const result = undeletePage(sql, "page_1", 9000);
    expect(result?.tombstoned).toBe(false);

    const row = sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_1'").one() as Record<
      string,
      unknown
    >;
    expect(row.title).toBe("Doomed");
    expect(row.plain_text).toBe("Content");
  });
});

describe("applyInboundDocBytes — sync frames arriving from a peer", () => {
  test("persists and reprojects when a catalog entry already exists", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "page_1", "free", bytes, 1000);

    const writer = openDoc(sql, "page_1");
    const beforeVV = writer.versionVector();
    writer.text("title").insert(1, "B");
    writer.commit();
    const incoming = writer.exportUpdatesSince(beforeVV);

    const result = applyInboundDocBytes(sql, "page_1", incoming, 2000);
    expect(result.applied).toBe(true);
    expect((sql.exec("SELECT title FROM graph_nodes WHERE node_id = 'page_1'").one() as { title: string }).title).toBe(
      "AB",
    );
  });

  test("persists bytes but skips reprojection when no catalog entry exists yet (self-heals later)", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "Orphan"));

    const result = applyInboundDocBytes(sql, "page_orphan", bytes, 1000);
    expect(result.applied).toBe(true);
    expect(docExists(sql, "page_orphan")).toBe(true);
    expect(sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_orphan'").toArray()).toHaveLength(0);

    // Once a catalog entry shows up (e.g. via a later catalogDiff), the
    // boot-time drift heal picks this page up.
    applyInboundCatalogEntries(
      sql,
      [{ pageID: "page_orphan", docType: "free", createdAt: 1000, tombstoned: false, updatedAt: 1000 }],
      1500,
    );
    const healed = healPageDriftIfNeeded(sql, "page_orphan", 2000);
    expect(healed).toBe(true);
    expect(
      (sql.exec("SELECT title FROM graph_nodes WHERE node_id = 'page_orphan'").one() as { title: string }).title,
    ).toBe("Orphan");
  });

  test("a no-op inbound merge reports applied: false", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "page_1", "free", bytes, 1000);

    // Re-send the exact same original creation bytes as an "inbound" frame.
    const originalDoc = openDoc(sql, "page_1");
    const snapshot = originalDoc.exportSnapshot();
    const result = applyInboundDocBytes(sql, "page_1", snapshot, 2000);
    expect(result.applied).toBe(false);
  });

  test("modifiedAt updates on the WebSocket sync path, not just direct RPC writes", () => {
    const sql = makeSql();
    // Catalog entry created directly via an inbound `catalogDiff`-shaped
    // call — NOT via `createOrUpdatePage` — so this page's own doc never
    // goes through the RPC write path at all; `system.modifiedAt` starts
    // genuinely unset inside it, matching "a page edited purely via WS
    // sync" (the exact scenario the bug this test guards against covers).
    applyInboundCatalogEntries(
      sql,
      [{ pageID: "page_ws", docType: "free", createdAt: 1000, tombstoned: false, updatedAt: 1000 }],
      1000,
    );

    const inbound = clientUpdateBytes((doc) => doc.text("title").insert(0, "Synced"));
    const result = applyInboundDocBytes(sql, "page_ws", inbound, 9000);
    expect(result.applied).toBe(true);

    const row = sql.exec("SELECT modified_at, title FROM graph_nodes WHERE node_id = 'page_ws'").one() as Record<
      string,
      unknown
    >;
    expect(row.title).toBe("Synced");
    // Before the fix, `applyInboundDocBytes` never wrote `system.modifiedAt`
    // at all, so `projection.ts`'s `extractNodeFields` fell back to the
    // catalog's `createdAt` (1000) forever, for any page only ever touched
    // via WS sync — this assertion is exactly what that gap would fail
    // (it would see 1000, not 9000).
    expect(row.modified_at).toBe(9000);
  });
});

describe("applyInboundCatalogEntries — last-write-wins", () => {
  test("applies a genuinely new entry", () => {
    const sql = makeSql();
    const applied = applyInboundCatalogEntries(
      sql,
      [{ pageID: "p1", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 1 }],
      100,
    );
    expect(applied).toHaveLength(1);
    expect(readCatalogEntryFromSql(sql, "p1")?.docType).toBe("free");
  });

  test("ignores a stale entry (local is already newer)", () => {
    const sql = makeSql();
    applyInboundCatalogEntries(
      sql,
      [{ pageID: "p1", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 10 }],
      100,
    );
    const applied = applyInboundCatalogEntries(
      sql,
      [{ pageID: "p1", docType: "STALE", createdAt: 1, tombstoned: true, updatedAt: 2 }],
      200,
    );
    expect(applied).toHaveLength(0);
    expect(readCatalogEntryFromSql(sql, "p1")?.docType).toBe("free");
  });

  test("a newer tombstoning entry purges graph_nodes rows", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "p1", "free", bytes, 100);
    expect(sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'p1'").toArray()).toHaveLength(1);

    applyInboundCatalogEntries(
      sql,
      [{ pageID: "p1", docType: "free", createdAt: 100, tombstoned: true, updatedAt: 999 }],
      1000,
    );
    expect(sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'p1'").toArray()).toHaveLength(0);
  });

  test("empty entries array is a no-op", () => {
    const sql = makeSql();
    expect(applyInboundCatalogEntries(sql, [], 100)).toEqual([]);
  });

  test("an exactly-equal updatedAt applies the incoming entry (tie-break matches catalog.ts's reprojectCatalog >= guard)", () => {
    const sql = makeSql();
    applyInboundCatalogEntries(
      sql,
      [{ pageID: "p1", docType: "free", createdAt: 1, tombstoned: false, updatedAt: 5000 }],
      100,
    );

    const applied = applyInboundCatalogEntries(
      sql,
      [{ pageID: "p1", docType: "updated", createdAt: 1, tombstoned: true, updatedAt: 5000 }],
      200,
    );
    expect(applied).toHaveLength(1);
    expect(readCatalogEntryFromSql(sql, "p1")?.docType).toBe("updated");
    expect(readCatalogEntryFromSql(sql, "p1")?.tombstoned).toBe(true);
  });
});

describe("catalogSnapshotForWire", () => {
  test("returns the full current catalog", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "p1", "free", bytes, 100);
    createOrUpdatePage(sql, "p2", "daily", clientUpdateBytes((d) => d.text("title").insert(0, "B")), 200);

    const snapshot = catalogSnapshotForWire(sql).sort((a, b) => a.pageID.localeCompare(b.pageID));
    expect(snapshot.map((e) => e.pageID)).toEqual(["p1", "p2"]);
  });
});

describe("computeDocSyncResponse", () => {
  test("returns an update when the peer's VV is caught up to a non-shallow doc", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "p1", "free", bytes, 100);

    const response = computeDocSyncResponse(sql, "p1", encodeVersionVector(emptyVersionVector()));
    expect(response.kind).toBe("update");
    expect(response.bytes.length).toBeGreaterThan(0);
  });

  test("returns a fullSnapshot for a peer that predates the compaction horizon (device-in-a-drawer case)", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "p1", "free", bytes, 100);

    // Edit and compact — this is what establishes a compaction horizon
    // past the doc's original creation history (createOrUpdatePage's own
    // "A" import plus its `system.modifiedAt` local edit both get baked
    // into the shallow snapshot's baseline state and are no longer
    // available as replayable ops afterwards).
    const doc = openDoc(sql, "p1");
    doc.text("title").insert(1, "B");
    doc.commit();
    compactDoc(sql, "p1", doc, 500);

    // A peer with an EMPTY version vector — the "never seen this page at
    // all" / device-in-a-drawer case — can never dominate a non-trivial
    // compaction horizon, so it reliably needs the full-snapshot fallback
    // (see `loro-storage.test.ts`'s `needsFullSnapshotFor` suite for the
    // more granular, directly-unit-tested version of this same check —
    // this test exercises it through the write-model's actual call path).
    const response = computeDocSyncResponse(sql, "p1", encodeVersionVector(emptyVersionVector()));
    expect(response.kind).toBe("fullSnapshot");
  });
});

describe("healPageDriftIfNeeded", () => {
  test("returns false and does nothing when projection is already up to date", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "p1", "free", bytes, 100);
    expect(healPageDriftIfNeeded(sql, "p1", 200)).toBe(false);
  });

  test("skips the vault-meta page itself", () => {
    const sql = makeSql();
    expect(healPageDriftIfNeeded(sql, VAULT_META_PAGE_ID, 100)).toBe(false);
  });

  test("skips a page with doc storage but no catalog entry", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "Orphan"));
    applyInboundDocBytes(sql, "page_orphan", bytes, 100);
    expect(healPageDriftIfNeeded(sql, "page_orphan", 200)).toBe(false);
  });

  test("reprojects a page whose doc state has drifted past what was last projected", () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => doc.text("title").insert(0, "A"));
    createOrUpdatePage(sql, "p1", "free", bytes, 100);

    // Simulate drift: directly append more doc-storage updates without
    // going through the write-model (as if the DO crashed mid-debounce
    // right after persisting bytes but before reprojecting).
    const doc = openDoc(sql, "p1");
    const beforeVV = doc.versionVector();
    doc.text("title").insert(1, "B");
    doc.commit();
    appendPendingUpdate(sql, "p1", doc.exportUpdatesSince(beforeVV), 300);

    expect((sql.exec("SELECT title FROM graph_nodes WHERE node_id = 'p1'").one() as { title: string }).title).toBe(
      "A",
    );

    const healed = healPageDriftIfNeeded(sql, "p1", 400);
    expect(healed).toBe(true);
    expect((sql.exec("SELECT title FROM graph_nodes WHERE node_id = 'p1'").one() as { title: string }).title).toBe(
      "AB",
    );
  });
});

describe("compaction on the live write path (not just backup restore)", () => {
  function isShallowFlag(sql: SqliteStorageAdapter, pageID: string): number {
    return sql
      .exec<{ is_shallow: number }>("SELECT is_shallow FROM doc_snapshots WHERE page_id = ?", pageID)
      .one().is_shallow;
  }

  // Each iteration re-opens the page's CURRENT server-side state and
  // exports an incremental delta since its own version vector — the same
  // "genuinely new write to an existing page" shape the file's other
  // multi-write tests already use (see "modifiedAt updates on a genuinely
  // new write to an existing page" above). This matters: unlike
  // `clientUpdateBytes` (a brand-new, causally-disconnected doc each call),
  // these deltas carry real causal dependencies on the page's actual
  // lineage, which is what any real client's outbox produces — a
  // disconnected from-genesis blob can't merge into an already-compacted
  // (shallow) doc at all (Loro rejects it: "dependencies of the importing
  // updates are not included in the shallow history of the doc"), which is
  // exactly why the sync protocol's full-snapshot fallback exists for a
  // truly out-of-sync peer instead.
  function incrementalEdit(sql: SqliteStorageAdapter, pageID: string, char: string): Uint8Array {
    const writer = openDoc(sql, pageID);
    const beforeVV = writer.versionVector();
    writer.text("body").insert(0, char);
    writer.commit();
    return writer.exportUpdatesSince(beforeVV);
  }

  test("createOrUpdatePage compacts once its page's pending-update log crosses the threshold", () => {
    const sql = makeSql();
    createOrUpdatePage(
      sql,
      "page_1",
      "free",
      clientUpdateBytes((doc) => doc.text("body").insert(0, "seed")),
      0,
    );
    // A LIVE doc (never restored from backup) starts non-shallow — before
    // this fix, it would STAY non-shallow forever, since `compactDoc` was
    // only ever called from `backup.ts`'s restore path.
    expect(isShallowFlag(sql, "page_1")).toBe(0);

    for (let i = 0; i < COMPACTION_PENDING_UPDATE_THRESHOLD; i++) {
      createOrUpdatePage(sql, "page_1", "free", incrementalEdit(sql, "page_1", "x"), 1000 + i);
    }

    // Real compaction ran: the stored snapshot is now shallow (this is
    // exactly the flag `doc-store.ts`'s `compactDoc` sets) ...
    expect(isShallowFlag(sql, "page_1")).toBe(1);
    // ... and the pending-updates log was folded back into it rather than
    // growing by one row per write for the page's entire lifetime.
    expect(countPendingUpdates(sql, "page_1")).toBeLessThan(COMPACTION_PENDING_UPDATE_THRESHOLD);
  });

  test("applyInboundDocBytes (the WebSocket sync path) compacts too", () => {
    const sql = makeSql();
    applyInboundDocBytes(sql, "page_ws", clientUpdateBytes((doc) => doc.text("body").insert(0, "seed")), 0);
    expect(isShallowFlag(sql, "page_ws")).toBe(0);

    for (let i = 0; i < COMPACTION_PENDING_UPDATE_THRESHOLD; i++) {
      applyInboundDocBytes(sql, "page_ws", incrementalEdit(sql, "page_ws", "x"), 1000 + i);
    }

    expect(isShallowFlag(sql, "page_ws")).toBe(1);
    expect(countPendingUpdates(sql, "page_ws")).toBeLessThan(COMPACTION_PENDING_UPDATE_THRESHOLD);
  });
});
