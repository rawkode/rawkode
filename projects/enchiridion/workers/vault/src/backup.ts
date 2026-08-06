// @enchiridion/worker-vault — nightly backup export + restore.
//
// Plan §Backend architecture, "Backup / disaster recovery (P0 requirement,
// before any real data)": "nightly export of every doc's full Loro
// snapshot + vault-meta to a versioned R2 bucket, plus a written and
// *tested* restore runbook. One Durable Object holding a personal life
// graph without cold backups is not acceptable."
//
// Export: reuses `doc-store.ts`'s `listStoredPageIds` (the SAME function
// `rebuild-projections.ts` paginates with) to enumerate every page —
// `vault-meta` needs NO special-casing, because it is stored through the
// exact same `doc-store.ts` machinery as any other page (see `catalog.ts`'s
// file header: "`pageID` is just another page ID ... stored through the
// exact same `doc-store.ts` machinery"), so it appears in
// `listStoredPageIds`'s results automatically and gets backed up like any
// page. Each page's bytes come from `loro-storage.ts`'s `exportSnapshot()`
// — a FULL-HISTORY snapshot (not the shallow one `doc-store.ts`'s
// `compactDoc` uses for routine storage compaction), reused as-is per that
// function's own doc comment ("Used for ... the plan's nightly R2 backup
// export").
//
// Resumability: checkpointed batches over an alarm loop, same pattern as
// `rebuild-projections.ts` (see that file's header) — `backup_checkpoint`
// (schema.ts) is `rebuild_checkpoint`'s sibling, with one extra `timestamp`
// column identifying which backup run a batch belongs to. Unlike
// `runRebuildBatch`, `runBackupBatch` is `async` (R2 `put()` is
// network I/O) and therefore is NOT wrapped in
// `ctx.storage.transactionSync` by its caller (`vault-do.ts`'s `alarm()`)
// — `transactionSync`'s callback must be synchronous. This means each
// page's SQL checkpoint update commits independently rather than as one
// atomic unit spanning the whole batch; acceptable because a checkpoint
// row is idempotently overwritten on every batch and re-derivable from
// `doc_snapshots` state regardless (the same "safe to reproject/re-export
// too eagerly, never too rarely" posture `projection.ts`'s
// `needsReprojection` documents).
//
// Restore: reads every object back under `backups/<timestamp>/` and
// reconstructs doc storage via `LoroPageDoc.fromSnapshot` +
// `doc-store.ts`'s existing `compactDoc` (not a bespoke SQL write — reuses
// the exact function normal compaction uses), then reprojects the catalog
// mirror and every page's `graph_nodes` row via the SAME functions the
// live write-model path uses (`catalog.ts`'s `readAllCatalogEntries`/
// `reprojectCatalog`, `vault-write-model.ts`'s `healPageDriftIfNeeded`) —
// restore does not reimplement reprojection, it just re-triggers the
// existing drift-heal path against freshly-restored doc storage.

import { readAllCatalogEntries, reprojectCatalog, VAULT_META_PAGE_ID } from "./catalog";
import { compactDoc, openDoc } from "./doc-store";
import { LoroPageDoc } from "./loro-storage";
import type { R2BucketLike } from "./r2-types";
import type { SqlExecutor } from "./schema";
import { healPageDriftIfNeeded } from "./vault-write-model";

/** R2 key scheme: `backups/<timestamp>/<pageID>.loro-snapshot`, per the
 *  task brief's example. `timestamp` is caller-chosen (an ISO-8601 string
 *  by convention — see `vault-do.ts`'s `runBackupExport`) and is opaque to
 *  this module: it's just the directory segment that groups one backup
 *  run's objects together and later identifies that run to
 *  `restoreVaultFromBackup`. */
export function backupObjectKey(timestamp: string, pageID: string): string {
  return `backups/${timestamp}/${pageID}.loro-snapshot`;
}

const BACKUP_KEY_SUFFIX = ".loro-snapshot";

function pageIdFromBackupKey(key: string, timestamp: string): string | undefined {
  const prefix = `backups/${timestamp}/`;
  if (!key.startsWith(prefix) || !key.endsWith(BACKUP_KEY_SUFFIX)) return undefined;
  return key.slice(prefix.length, key.length - BACKUP_KEY_SUFFIX.length);
}

// --- checkpoint bookkeeping (mirrors rebuild-projections.ts) -------------

export type BackupStatus = "idle" | "running" | "completed";

export interface BackupCheckpoint {
  status: BackupStatus;
  timestamp: string;
  afterPageID: string | null;
  processedCount: number;
  startedAt: number;
  updatedAt: number;
}

interface BackupCheckpointRow {
  status: string;
  timestamp: string;
  after_page_id: string | null;
  processed_count: number;
  started_at: number;
  updated_at: number;
  [key: string]: unknown;
}

function fromRow(row: BackupCheckpointRow): BackupCheckpoint {
  return {
    status: row.status as BackupStatus,
    timestamp: row.timestamp,
    afterPageID: row.after_page_id,
    processedCount: row.processed_count,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

export function readBackupCheckpoint(sql: SqlExecutor): BackupCheckpoint | undefined {
  const row = sql
    .exec<BackupCheckpointRow>(
      "SELECT status, timestamp, after_page_id, processed_count, started_at, updated_at FROM backup_checkpoint WHERE id = 1",
    )
    .toArray()[0];
  return row ? fromRow(row) : undefined;
}

function writeBackupCheckpoint(sql: SqlExecutor, checkpoint: BackupCheckpoint): void {
  sql.exec(
    `INSERT INTO backup_checkpoint (id, status, timestamp, after_page_id, processed_count, started_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status,
       timestamp = excluded.timestamp,
       after_page_id = excluded.after_page_id,
       processed_count = excluded.processed_count,
       started_at = excluded.started_at,
       updated_at = excluded.updated_at`,
    checkpoint.status,
    checkpoint.timestamp,
    checkpoint.afterPageID,
    checkpoint.processedCount,
    checkpoint.startedAt,
    checkpoint.updatedAt,
  );
}

/** Starts (or restarts) a backup run under a fresh `timestamp` — mirrors
 *  `rebuild-projections.ts`'s `startRebuild`: restarts the cursor at the
 *  top rather than layering a second concurrent pass. */
export function startBackup(sql: SqlExecutor, timestamp: string, now: number): void {
  writeBackupCheckpoint(sql, {
    status: "running",
    timestamp,
    afterPageID: null,
    processedCount: 0,
    startedAt: now,
    updatedAt: now,
  });
}

export interface BackupBatchResult {
  processedPageIDs: string[];
  hasMore: boolean;
}

/** Processes up to `batchSize` pages starting after the checkpoint's
 *  cursor, exporting each one's full Loro snapshot to
 *  `backups/<timestamp>/<pageID>.loro-snapshot`, then advances (or
 *  completes) the checkpoint — mirrors `rebuild-projections.ts`'s
 *  `runRebuildBatch`, `async` because R2 `put()` is. No-ops (returns
 *  `hasMore: false`) if no backup is currently `running` — the caller
 *  (`vault-do.ts`'s `alarm()`) should not re-arm its alarm in that case. */
export async function runBackupBatch(
  sql: SqlExecutor,
  r2: R2BucketLike,
  listPageIDs: (afterPageID: string | undefined, limit: number) => string[],
  now: number,
  batchSize = 50,
): Promise<BackupBatchResult> {
  const checkpoint = readBackupCheckpoint(sql);
  if (!checkpoint || checkpoint.status !== "running") {
    return { processedPageIDs: [], hasMore: false };
  }

  const afterPageID = checkpoint.afterPageID ?? undefined;
  const batch = listPageIDs(afterPageID, batchSize);

  for (const pageID of batch) {
    const doc = openDoc(sql, pageID);
    const snapshot = doc.exportSnapshot();
    await r2.put(backupObjectKey(checkpoint.timestamp, pageID), snapshot);
  }

  const hasMore = batch.length === batchSize;
  const newAfterPageID = batch.length > 0 ? batch[batch.length - 1]! : (afterPageID ?? null);

  writeBackupCheckpoint(sql, {
    status: hasMore ? "running" : "completed",
    timestamp: checkpoint.timestamp,
    afterPageID: newAfterPageID,
    processedCount: checkpoint.processedCount + batch.length,
    startedAt: checkpoint.startedAt,
    updatedAt: now,
  });

  return { processedPageIDs: batch, hasMore };
}

// --- restore ---------------------------------------------------------

export interface RestoreResult {
  timestamp: string;
  restoredPageIDs: string[];
}

/** Reconstructs a vault's doc storage + catalog projection from a prior
 *  backup run's R2 objects — the P0 "backup restore drill" (plan
 *  §Verification). Reads every `backups/<timestamp>/*.loro-snapshot`
 *  object, re-hydrates each as a `LoroPageDoc`
 *  (`LoroPageDoc.fromSnapshot`), and persists it via `doc-store.ts`'s
 *  existing `compactDoc` (page-by-page; each page's SQL write is its own
 *  implicit transaction, same reasoning as `runBackupBatch` above), then
 *  reprojects the catalog mirror and every restored page's `graph_nodes`
 *  row via the existing write-model reprojection path.
 *
 *  Callable directly as a plain async function (tests do this against
 *  `SqliteStorageAdapter` + `InMemoryR2Bucket`) or via `VaultDO`'s
 *  `restoreFromBackup` RPC method — see `RESTORE_RUNBOOK.md`. */
export async function restoreVaultFromBackup(
  sql: SqlExecutor,
  r2: R2BucketLike,
  timestamp: string,
  now: number,
): Promise<RestoreResult> {
  const prefix = `backups/${timestamp}/`;
  const restoredPageIDs: string[] = [];

  let cursor: string | undefined;
  for (;;) {
    const page = await r2.list({ prefix, cursor });
    for (const object of page.objects) {
      const pageID = pageIdFromBackupKey(object.key, timestamp);
      if (!pageID) continue; // not a page-snapshot object under this prefix — ignore.
      const body = await r2.get(object.key);
      if (!body) continue; // listed but vanished before the read — skip, don't fail the whole restore.
      const bytes = new Uint8Array(await body.arrayBuffer());
      const doc = LoroPageDoc.fromSnapshot(bytes);
      compactDoc(sql, pageID, doc, now);
      restoredPageIDs.push(pageID);
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }

  // The catalog mirror must be rebuilt from the restored vault-meta doc
  // BEFORE reprojecting other pages — `healPageDriftIfNeeded` skips any
  // page with no catalog entry yet (see that function's doc comment).
  if (restoredPageIDs.includes(VAULT_META_PAGE_ID)) {
    const metaDoc = openDoc(sql, VAULT_META_PAGE_ID);
    reprojectCatalog(sql, readAllCatalogEntries(metaDoc));
  }

  for (const pageID of restoredPageIDs) {
    if (pageID === VAULT_META_PAGE_ID) continue;
    healPageDriftIfNeeded(sql, pageID, now);
  }

  return { timestamp, restoredPageIDs };
}
