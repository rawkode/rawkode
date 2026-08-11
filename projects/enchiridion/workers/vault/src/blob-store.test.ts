import { describe, expect, test } from "bun:test";
import {
  confirmBlobUploaded,
  DEFAULT_GRACE_WINDOW_MS,
  deletePendingBlobReference,
  getPendingBlobReference,
  isBlobReferencedByLivePage,
  listPendingBlobReferences,
  registerPendingBlobReference,
  sweepBlobGarbage,
} from "./blob-store";
import { initializeSchema } from "./schema";
import { InMemoryR2Bucket } from "./test-helpers/in-memory-r2-bucket";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

const BLOB_A = `blob_${"a".repeat(64)}`;
const BLOB_B = `blob_${"b".repeat(64)}`;

describe("blob-store — registration lifecycle", () => {
  test("registering a new blob id creates a pending row", () => {
    const sql = makeSql();
    registerPendingBlobReference(sql, BLOB_A, 1000);
    expect(getPendingBlobReference(sql, BLOB_A)).toEqual({
      blobID: BLOB_A,
      registeredAt: 1000,
      uploadedAt: null,
      status: "pending",
    });
  });

  test("confirming marks status uploaded and stamps uploadedAt", () => {
    const sql = makeSql();
    registerPendingBlobReference(sql, BLOB_A, 1000);
    confirmBlobUploaded(sql, BLOB_A, 2000);
    expect(getPendingBlobReference(sql, BLOB_A)).toEqual({
      blobID: BLOB_A,
      registeredAt: 1000,
      uploadedAt: 2000,
      status: "uploaded",
    });
  });

  test("re-registering an already-known id does not reset registeredAt", () => {
    const sql = makeSql();
    registerPendingBlobReference(sql, BLOB_A, 1000);
    confirmBlobUploaded(sql, BLOB_A, 1500);
    registerPendingBlobReference(sql, BLOB_A, 9000); // a second device re-uploading the same content
    expect(getPendingBlobReference(sql, BLOB_A)?.registeredAt).toBe(1000);
    expect(getPendingBlobReference(sql, BLOB_A)?.status).toBe("uploaded");
  });

  test("deletePendingBlobReference removes the row (hash-mismatch rollback path)", () => {
    const sql = makeSql();
    registerPendingBlobReference(sql, BLOB_A, 1000);
    deletePendingBlobReference(sql, BLOB_A);
    expect(getPendingBlobReference(sql, BLOB_A)).toBeUndefined();
  });

  test("listPendingBlobReferences returns every row, ordered", () => {
    const sql = makeSql();
    registerPendingBlobReference(sql, BLOB_B, 1000);
    registerPendingBlobReference(sql, BLOB_A, 1000);
    expect(listPendingBlobReferences(sql).map((r) => r.blobID)).toEqual([BLOB_A, BLOB_B]);
  });
});

describe("blob-store — isBlobReferencedByLivePage (P0 stub)", () => {
  test("always reports referenced — the deliberate conservative no-op until P1", () => {
    const sql = makeSql();
    expect(isBlobReferencedByLivePage(sql, BLOB_A)).toBe(true);
  });
});

describe("blob-store — sweepBlobGarbage", () => {
  test("dry run (default): reports grace-window-eligible candidates, deletes nothing", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    registerPendingBlobReference(sql, BLOB_A, 1000);
    confirmBlobUploaded(sql, BLOB_A, 1000);
    r2.putRaw(BLOB_A, new Uint8Array([1, 2, 3]));

    const now = 1000 + DEFAULT_GRACE_WINDOW_MS + 1;
    const result = await sweepBlobGarbage(sql, r2, { now });

    expect(result.dryRun).toBe(true);
    expect(result.graceWindowEligible).toEqual([BLOB_A]);
    expect(result.deleted).toEqual([]);
    expect(await r2.head(BLOB_A)).not.toBeNull(); // untouched
    expect(getPendingBlobReference(sql, BLOB_A)).toBeDefined(); // untouched
  });

  test("a blob still within the grace window is never a candidate, even in apply mode", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    registerPendingBlobReference(sql, BLOB_A, 1000);
    confirmBlobUploaded(sql, BLOB_A, 1000);
    r2.putRaw(BLOB_A, new Uint8Array([1]));

    const now = 1000 + DEFAULT_GRACE_WINDOW_MS - 1; // one ms short of the window
    const result = await sweepBlobGarbage(sql, r2, { now, dryRun: false });

    expect(result.graceWindowEligible).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  test("a `pending` (never-confirmed-uploaded) reference is never a GC candidate", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    registerPendingBlobReference(sql, BLOB_A, 1000); // never confirmed

    const now = 1000 + DEFAULT_GRACE_WINDOW_MS + 1;
    const result = await sweepBlobGarbage(sql, r2, { now, dryRun: false });

    expect(result.graceWindowEligible).toEqual([]);
  });

  test("apply mode with the default reference stub still deletes nothing — err toward don't-delete", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    registerPendingBlobReference(sql, BLOB_A, 1000);
    confirmBlobUploaded(sql, BLOB_A, 1000);
    r2.putRaw(BLOB_A, new Uint8Array([1]));

    const now = 1000 + DEFAULT_GRACE_WINDOW_MS + 1;
    const result = await sweepBlobGarbage(sql, r2, { now, dryRun: false });

    expect(result.deletionCandidates).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(await r2.head(BLOB_A)).not.toBeNull();
  });

  test("apply mode with an injected 'not referenced' check actually deletes past-grace-window blobs", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    registerPendingBlobReference(sql, BLOB_A, 1000);
    confirmBlobUploaded(sql, BLOB_A, 1000);
    r2.putRaw(BLOB_A, new Uint8Array([1]));
    registerPendingBlobReference(sql, BLOB_B, 1000);
    confirmBlobUploaded(sql, BLOB_B, 1000);
    r2.putRaw(BLOB_B, new Uint8Array([2]));

    const now = 1000 + DEFAULT_GRACE_WINDOW_MS + 1;
    const result = await sweepBlobGarbage(sql, r2, {
      now,
      dryRun: false,
      isReferenced: (_sql, blobID) => blobID === BLOB_B, // only B is "still referenced"
    });

    expect(result.deletionCandidates).toEqual([BLOB_A]);
    expect(result.deleted).toEqual([BLOB_A]);
    expect(await r2.head(BLOB_A)).toBeNull();
    expect(await r2.head(BLOB_B)).not.toBeNull();
    expect(getPendingBlobReference(sql, BLOB_A)).toBeUndefined();
    expect(getPendingBlobReference(sql, BLOB_B)).toBeDefined();
  });

  test("a custom grace window is honored", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    registerPendingBlobReference(sql, BLOB_A, 1000);
    confirmBlobUploaded(sql, BLOB_A, 1000);
    r2.putRaw(BLOB_A, new Uint8Array([1]));

    const shortWindow = 10;
    const result = await sweepBlobGarbage(sql, r2, { now: 1000 + shortWindow + 1, graceWindowMs: shortWindow });
    expect(result.graceWindowEligible).toEqual([BLOB_A]);
  });
});
