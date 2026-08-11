import { describe, expect, test } from "bun:test";
import {
  backupObjectKey,
  readBackupCheckpoint,
  restoreVaultFromBackup,
  runBackupBatch,
  startBackup,
} from "./backup";
import { readCatalogFromSql, VAULT_META_PAGE_ID } from "./catalog";
import { listStoredPageIds, openDoc } from "./doc-store";
import { LoroPageDoc } from "./loro-storage";
import { initializeSchema } from "./schema";
import { InMemoryR2Bucket } from "./test-helpers/in-memory-r2-bucket";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";
import { createOrUpdatePage } from "./vault-write-model";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

function listPageIDs(sql: SqliteStorageAdapter) {
  return (afterPageID: string | undefined, limit: number) => listStoredPageIds(sql, afterPageID, limit);
}

interface NodeRow {
  node_id: string;
  title: string;
  plain_text: string;
  kind: string;
  [key: string]: unknown;
}

function graphNodesSnapshot(sql: SqliteStorageAdapter): NodeRow[] {
  return sql
    .exec<NodeRow>("SELECT node_id, title, plain_text, kind FROM graph_nodes ORDER BY node_id")
    .toArray();
}

describe("backup — backupObjectKey", () => {
  test("formats backups/<timestamp>/<pageID>.loro-snapshot", () => {
    expect(backupObjectKey("2026-08-06T03-00-00", "page_1")).toBe(
      "backups/2026-08-06T03-00-00/page_1.loro-snapshot",
    );
  });
});

describe("backup — checkpoint lifecycle", () => {
  test("no checkpoint before startBackup", () => {
    const sql = makeSql();
    expect(readBackupCheckpoint(sql)).toBeUndefined();
  });

  test("startBackup creates a running checkpoint under the given timestamp", () => {
    const sql = makeSql();
    startBackup(sql, "2026-08-06T03-00-00", 1000);
    expect(readBackupCheckpoint(sql)).toEqual({
      status: "running",
      timestamp: "2026-08-06T03-00-00",
      afterPageID: null,
      processedCount: 0,
      startedAt: 1000,
      updatedAt: 1000,
    });
  });
});

describe("backup — runBackupBatch", () => {
  test("no-ops when no backup is running", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const result = await runBackupBatch(sql, r2, listPageIDs(sql), 1000, 50);
    expect(result).toEqual({ processedPageIDs: [], hasMore: false });
  });

  test("exports every stored page (including vault-meta) to R2 under the run's timestamp", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const seedDoc = LoroPageDoc.create();
    seedDoc.text("title").insert(0, "Hello");
    seedDoc.commit();
    createOrUpdatePage(sql, "page_1", "free", seedDoc.exportAllUpdates(), 1000);

    startBackup(sql, "run-1", 2000);
    const result = await runBackupBatch(sql, r2, listPageIDs(sql), 2000, 50);

    expect(result.hasMore).toBe(false);
    expect(result.processedPageIDs.sort()).toEqual(["page_1", VAULT_META_PAGE_ID].sort());

    const pageObject = await r2.get(backupObjectKey("run-1", "page_1"));
    expect(pageObject).not.toBeNull();
    const metaObject = await r2.get(backupObjectKey("run-1", VAULT_META_PAGE_ID));
    expect(metaObject).not.toBeNull();
  });

  test("resumable across multiple batches", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    for (let i = 0; i < 7; i++) {
      const doc = LoroPageDoc.create();
      doc.text("title").insert(0, `p${i}`);
      doc.commit();
      createOrUpdatePage(sql, `page_${String(i).padStart(2, "0")}`, "free", doc.exportAllUpdates(), 1000);
    }

    startBackup(sql, "run-2", 1000);
    let hasMore = true;
    let processedTotal = 0;
    let iterations = 0;
    while (hasMore) {
      const result = await runBackupBatch(sql, r2, listPageIDs(sql), 1000, 3);
      processedTotal += result.processedPageIDs.length;
      hasMore = result.hasMore;
      iterations += 1;
      if (iterations > 10) throw new Error("runaway loop");
    }

    // 7 pages + vault-meta = 8 total.
    expect(processedTotal).toBe(8);
    expect(readBackupCheckpoint(sql)?.status).toBe("completed");
    for (let i = 0; i < 7; i++) {
      const key = backupObjectKey("run-2", `page_${String(i).padStart(2, "0")}`);
      expect(await r2.get(key)).not.toBeNull();
    }
  });
});

describe("backup — restore drill (P0 §Verification: 'restore a vault from the nightly R2 snapshots into a fresh VaultDO and diff projections')", () => {
  test("a full backup export, then restore into a wiped vault, reproduces doc content and projections", async () => {
    const sourceSql = makeSql();
    const r2 = new InMemoryR2Bucket();

    // Build a small vault: three pages with real content.
    const seed: Array<{ id: string; title: string; body: string }> = [
      { id: "page_alpha", title: "Alpha", body: "First page body" },
      { id: "page_beta", title: "Beta", body: "Second page body" },
      { id: "page_gamma", title: "Gamma", body: "Third page body" },
    ];
    for (const page of seed) {
      const doc = LoroPageDoc.create();
      doc.text("title").insert(0, page.title);
      doc.text("body").insert(0, page.body);
      doc.commit();
      createOrUpdatePage(sourceSql, page.id, "free", doc.exportAllUpdates(), 1000);
    }

    const beforeNodes = graphNodesSnapshot(sourceSql);
    const beforeCatalog = readCatalogFromSql(sourceSql).sort((a, b) => (a.pageID < b.pageID ? -1 : 1));
    expect(beforeNodes).toHaveLength(3);

    // Run the full (checkpointed) backup export.
    const timestamp = "2026-08-06T03-00-00.000Z";
    startBackup(sourceSql, timestamp, 5000);
    let hasMore = true;
    let guard = 0;
    while (hasMore) {
      const result = await runBackupBatch(sourceSql, r2, listPageIDs(sourceSql), 5000, 10);
      hasMore = result.hasMore;
      guard += 1;
      if (guard > 10) throw new Error("runaway loop");
    }
    expect(readBackupCheckpoint(sourceSql)?.status).toBe("completed");

    // "Wipe the vault": a brand-new, empty SQLite database — the fresh
    // VaultDO storage this drill restores into.
    const freshSql = makeSql();
    expect(listStoredPageIds(freshSql)).toEqual([]);

    const restoreResult = await restoreVaultFromBackup(freshSql, r2, timestamp, 9000);

    expect(restoreResult.restoredPageIDs.sort()).toEqual(
      [...seed.map((p) => p.id), VAULT_META_PAGE_ID].sort(),
    );

    // Doc content round-trips exactly.
    for (const page of seed) {
      const doc = openDoc(freshSql, page.id);
      expect(doc.textContent("title")).toBe(page.title);
      expect(doc.textContent("body")).toBe(page.body);
    }

    // Projections rebuilt from the restored docs match the originals.
    const afterNodes = graphNodesSnapshot(freshSql);
    expect(afterNodes).toEqual(beforeNodes);

    const afterCatalog = readCatalogFromSql(freshSql).sort((a, b) => (a.pageID < b.pageID ? -1 : 1));
    expect(afterCatalog).toEqual(beforeCatalog);
  });

  test("restoring an unknown timestamp restores nothing (empty prefix, no error)", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const result = await restoreVaultFromBackup(sql, r2, "never-ran", 1000);
    expect(result.restoredPageIDs).toEqual([]);
  });
});
