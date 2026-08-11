import { describe, expect, test } from "bun:test";
import { readCheckpoint, readRebuildFailures, runRebuildBatch, startRebuild } from "./rebuild-projections";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

/** A fake page store: `n` lexicographically-sortable page IDs, with the
 *  same pagination contract as `doc-store.ts`'s `listStoredPageIds`. */
function fakePageStore(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `page_${String(i).padStart(4, "0")}`);
  return (afterPageID: string | undefined, limit: number): string[] => {
    const startIndex = afterPageID ? ids.findIndex((id) => id > afterPageID) : 0;
    if (startIndex === -1) return [];
    return ids.slice(startIndex, startIndex + limit);
  };
}

describe("rebuild-projections — checkpoint lifecycle", () => {
  test("no checkpoint exists before startRebuild is ever called", () => {
    const sql = makeSql();
    expect(readCheckpoint(sql)).toBeUndefined();
  });

  test("startRebuild creates a running checkpoint at the beginning", () => {
    const sql = makeSql();
    startRebuild(sql, 1000);
    expect(readCheckpoint(sql)).toEqual({
      status: "running",
      afterPageID: null,
      processedCount: 0,
      startedAt: 1000,
      updatedAt: 1000,
    });
  });
});

describe("rebuild-projections — runRebuildBatch: resumable, checkpointed batching", () => {
  test("a single batch that covers everything completes in one call", () => {
    const sql = makeSql();
    startRebuild(sql, 1000);
    const listPageIDs = fakePageStore(5);
    const processed: string[] = [];

    const result = runRebuildBatch(sql, listPageIDs, (id) => processed.push(id), 2000, 50);

    expect(result.hasMore).toBe(false);
    expect(result.processedPageIDs).toHaveLength(5);
    expect(processed).toHaveLength(5);
    expect(readCheckpoint(sql)?.status).toBe("completed");
    expect(readCheckpoint(sql)?.processedCount).toBe(5);
  });

  test("a large store is processed across multiple batches, resuming from the checkpoint each time", () => {
    const sql = makeSql();
    startRebuild(sql, 1000);
    const listPageIDs = fakePageStore(11);
    const allProcessed: string[] = [];

    let now = 2000;
    let hasMore = true;
    let iterations = 0;
    while (hasMore) {
      const result = runRebuildBatch(sql, listPageIDs, (id) => allProcessed.push(id), now, 5);
      hasMore = result.hasMore;
      now += 100;
      iterations += 1;
      if (iterations > 20) throw new Error("runaway loop — resumability bug");
    }

    expect(iterations).toBe(3); // 5 + 5 + 1
    expect(allProcessed).toHaveLength(11);
    // No duplicates and no gaps — every page processed exactly once.
    expect(new Set(allProcessed).size).toBe(11);
    expect(readCheckpoint(sql)?.status).toBe("completed");
    expect(readCheckpoint(sql)?.processedCount).toBe(11);
  });

  test("each batch call only touches its own slice — proves the alarm-loop model (one batch per invocation)", () => {
    const sql = makeSql();
    startRebuild(sql, 1000);
    const listPageIDs = fakePageStore(10);
    let calls = 0;

    const first = runRebuildBatch(
      sql,
      listPageIDs,
      () => {
        calls += 1;
      },
      1000,
      4,
    );
    expect(calls).toBe(4);
    expect(first.hasMore).toBe(true);
    expect(readCheckpoint(sql)?.afterPageID).toBe("page_0003");

    const second = runRebuildBatch(
      sql,
      listPageIDs,
      () => {
        calls += 1;
      },
      1100,
      4,
    );
    expect(calls).toBe(8);
    expect(second.processedPageIDs[0]).toBe("page_0004");
    expect(readCheckpoint(sql)?.afterPageID).toBe("page_0007");
  });

  test("an empty page store completes immediately with zero processed", () => {
    const sql = makeSql();
    startRebuild(sql, 1000);
    const result = runRebuildBatch(sql, fakePageStore(0), () => {}, 1000, 50);
    expect(result.hasMore).toBe(false);
    expect(result.processedPageIDs).toEqual([]);
    expect(readCheckpoint(sql)?.status).toBe("completed");
  });

  test("calling runRebuildBatch with no prior startRebuild still works (treats it as starting fresh)", () => {
    const sql = makeSql();
    const result = runRebuildBatch(sql, fakePageStore(2), () => {}, 1000, 50);
    expect(result.processedPageIDs).toEqual(["page_0000", "page_0001"]);
    expect(readCheckpoint(sql)?.status).toBe("completed");
  });

  test("startRebuild after a completed run resets the cursor for a fresh full pass", () => {
    const sql = makeSql();
    startRebuild(sql, 1000);
    runRebuildBatch(sql, fakePageStore(3), () => {}, 1000, 50);
    expect(readCheckpoint(sql)?.status).toBe("completed");

    startRebuild(sql, 5000);
    const checkpoint = readCheckpoint(sql);
    expect(checkpoint?.status).toBe("running");
    expect(checkpoint?.afterPageID).toBeNull();
    expect(checkpoint?.processedCount).toBe(0);
  });
});

describe("rebuild-projections — poison-pill isolation (a throwing page must not wedge the batch)", () => {
  test("a page that throws during reprojection is recorded as a failure; every other page in the batch still completes", () => {
    const sql = makeSql();
    startRebuild(sql, 1000);
    const listPageIDs = fakePageStore(5); // page_0000..page_0004
    const poisonPageID = "page_0002";
    const processed: string[] = [];

    const result = runRebuildBatch(
      sql,
      listPageIDs,
      (id) => {
        if (id === poisonPageID) {
          throw new Error("boom: corrupted doc");
        }
        processed.push(id);
      },
      2000,
      50,
    );

    // Every OTHER page in the batch still got reprojected — the poison
    // pill cost exactly one page, not the whole batch.
    expect(processed).toEqual(["page_0000", "page_0001", "page_0003", "page_0004"]);

    // The batch as a whole still completes, and the checkpoint cursor
    // advances PAST the bad page (not stuck before it, which would make
    // every subsequent alarm retry hit the identical exception forever).
    expect(result.hasMore).toBe(false);
    expect(result.processedPageIDs).toHaveLength(5);
    expect(readCheckpoint(sql)?.status).toBe("completed");
    expect(readCheckpoint(sql)?.afterPageID).toBe("page_0004");

    // The failure is recorded and queryable.
    const failures = readRebuildFailures(sql);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pageID).toBe(poisonPageID);
    expect(failures[0]?.errorMessage).toContain("boom: corrupted doc");
    expect(failures[0]?.failedAt).toBe(2000);
  });

  test("a poison-pill page does not wedge subsequent alarm-loop retries — the checkpoint keeps moving across batches", () => {
    const sql = makeSql();
    startRebuild(sql, 1000);
    const listPageIDs = fakePageStore(10);
    const poisonPageID = "page_0003";
    const processed: string[] = [];

    let now = 2000;
    let hasMore = true;
    let iterations = 0;
    while (hasMore) {
      const result = runRebuildBatch(
        sql,
        listPageIDs,
        (id) => {
          if (id === poisonPageID) throw new Error("boom");
          processed.push(id);
        },
        now,
        4,
      );
      hasMore = result.hasMore;
      now += 100;
      iterations += 1;
      if (iterations > 20) throw new Error("runaway loop — poison pill wedged the batch");
    }

    // Same batching shape as the non-poison-pill 10-page test (4 + 4 + 2) —
    // the poison pill didn't change how the alarm loop paces itself.
    expect(iterations).toBe(3);
    expect(processed).toHaveLength(9); // every page except the poisoned one
    expect(new Set(processed).has(poisonPageID)).toBe(false);
    expect(readCheckpoint(sql)?.status).toBe("completed");
    expect(readCheckpoint(sql)?.processedCount).toBe(10);

    const failures = readRebuildFailures(sql);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pageID).toBe(poisonPageID);
  });

  test("readRebuildFailures returns an empty list when nothing has failed", () => {
    const sql = makeSql();
    expect(readRebuildFailures(sql)).toEqual([]);
  });
});
