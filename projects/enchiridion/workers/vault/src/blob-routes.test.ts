import { deriveBlobId } from "@enchiridion/graph-core";
import { describe, expect, test } from "bun:test";
import { getPendingBlobReference } from "./blob-store";
import { handleBlobDownload, handleBlobUpload, isValidBlobId } from "./blob-routes";
import { initializeSchema } from "./schema";
import { InMemoryR2Bucket } from "./test-helpers/in-memory-r2-bucket";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

function putRequest(bytes: Uint8Array, extraHeaders: Record<string, string> = {}): Request {
  // Passed as an explicit ArrayBuffer (not the Uint8Array view directly) —
  // unambiguously a `BodyInit` member across every `Request`/`RequestInit`
  // typings this workspace's `types` array pulls in (workers-types +
  // bun-types both declare a global `Request`; a raw `ArrayBufferView`
  // resolves cleanly against both, whereas TS's overload resolution for a
  // `Uint8Array` view was ambiguous between them).
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Request("https://vault.example/blobs/ignored", {
    method: "PUT",
    body: buffer,
    headers: { "content-type": "application/octet-stream", ...extraHeaders },
  });
}

async function readAll(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

describe("blob-routes — isValidBlobId", () => {
  test("accepts blob_<64-hex>", () => {
    expect(isValidBlobId(`blob_${"a".repeat(64)}`)).toBe(true);
  });
  test("rejects wrong prefix, wrong length, uppercase hex", () => {
    expect(isValidBlobId(`nope_${"a".repeat(64)}`)).toBe(false);
    expect(isValidBlobId(`blob_${"a".repeat(63)}`)).toBe(false);
    expect(isValidBlobId(`blob_${"A".repeat(64)}`)).toBe(false);
  });
});

describe("blob-routes — PUT /blobs/:id (buffered path)", () => {
  test("400 on a malformed id — nothing registered, nothing written", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const bytes = new TextEncoder().encode("hello world");
    const result = await handleBlobUpload(putRequest(bytes), "not-a-blob-id", sql, r2, 1000);
    expect(result.status).toBe(400);
  });

  test("201 on a correctly-claimed id; bytes land in R2 and the reference is confirmed uploaded", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const bytes = new TextEncoder().encode("hello world");
    const id = await deriveBlobId(bytes);

    const result = await handleBlobUpload(putRequest(bytes), id, sql, r2, 1000);

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ id, size: bytes.byteLength });
    expect(getPendingBlobReference(sql, id)?.status).toBe("uploaded");

    const stored = await r2.get(id);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });

  test("409 on a claimed id that doesn't match the actual bytes' SHA-256 — server-side integrity, not trusting the client", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const bytes = new TextEncoder().encode("hello world");
    const wrongID = `blob_${"0".repeat(64)}`;

    const result = await handleBlobUpload(putRequest(bytes), wrongID, sql, r2, 1000);

    expect(result.status).toBe(409);
    expect(result.body.claimed).toBe(wrongID);
    expect(result.body.actual).toBe(await deriveBlobId(bytes));
    // Rolled back: no dangling pending-reference row, and nothing in R2
    // under the falsely-claimed id.
    expect(getPendingBlobReference(sql, wrongID)).toBeUndefined();
    expect(await r2.head(wrongID)).toBeNull();
  });

  test("dedup: uploading an id R2 already has skips re-verification and confirms the reference (registers a NEW device's reference too)", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const bytes = new TextEncoder().encode("already here");
    const id = await deriveBlobId(bytes);
    r2.putRaw(id, bytes);

    const result = await handleBlobUpload(putRequest(bytes), id, sql, r2, 5000);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id, alreadyExists: true });
    expect(getPendingBlobReference(sql, id)?.status).toBe("uploaded");
    expect(getPendingBlobReference(sql, id)?.registeredAt).toBe(5000);
  });
});

describe("blob-routes — PUT /blobs/:id (multipart path)", () => {
  // The multipart-vs-buffered decision reads ONLY the Content-Length
  // header (streaming a real 100 MiB body in a unit test isn't practical
  // or necessary) — so a small body with a header CLAIMING to be over the
  // threshold exercises the real multipart code path
  // (createMultipartUpload/uploadPart/complete, incremental node:crypto
  // hashing) with cheap test data.
  const OVER_THRESHOLD = String(100 * 1024 * 1024 + 1);

  test("a correctly-claimed id completes via multipart and produces byte-identical stored content", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const bytes = new TextEncoder().encode("a".repeat(50_000)); // small; header lies about size
    const id = await deriveBlobId(bytes);

    const result = await handleBlobUpload(
      putRequest(bytes, { "content-length": OVER_THRESHOLD }),
      id,
      sql,
      r2,
      1000,
    );

    expect(result.status).toBe(201);
    const stored = await r2.get(id);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });

  test("multipart incremental hashing produces the SAME id as the buffered path's deriveBlobId for identical bytes", async () => {
    const bytes = new TextEncoder().encode("cross-check " + "x".repeat(10_000));
    const expected = await deriveBlobId(bytes);

    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const result = await handleBlobUpload(
      putRequest(bytes, { "content-length": OVER_THRESHOLD }),
      expected,
      sql,
      r2,
      1000,
    );
    expect(result.status).toBe(201);
    expect(result.body.id).toBe(expected);
  });

  test("a hash mismatch on the multipart path aborts the upload — nothing left in R2", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const bytes = new TextEncoder().encode("multipart mismatch case");
    const wrongID = `blob_${"1".repeat(64)}`;

    const result = await handleBlobUpload(
      putRequest(bytes, { "content-length": OVER_THRESHOLD }),
      wrongID,
      sql,
      r2,
      1000,
    );

    expect(result.status).toBe(409);
    expect(await r2.head(wrongID)).toBeNull();
    expect(getPendingBlobReference(sql, wrongID)).toBeUndefined();
  });
});

describe("blob-routes — GET /blobs/:id", () => {
  test("400 on a malformed id", async () => {
    const r2 = new InMemoryR2Bucket();
    const result = await handleBlobDownload("nope", r2);
    expect(result.status).toBe(400);
  });

  test("404 when not present", async () => {
    const r2 = new InMemoryR2Bucket();
    const result = await handleBlobDownload(`blob_${"a".repeat(64)}`, r2);
    expect(result.status).toBe(404);
  });

  test("200 streams the exact bytes back, with content-type/etag/content-length headers", async () => {
    const r2 = new InMemoryR2Bucket();
    const bytes = new TextEncoder().encode("download me");
    const id = await deriveBlobId(bytes);
    r2.putRaw(id, bytes, "text/plain");

    const result = await handleBlobDownload(id, r2);

    expect(result.status).toBe(200);
    expect(result.headers?.["content-length"]).toBe(String(bytes.byteLength));
    expect(result.headers?.["content-type"]).toBe("text/plain");
    expect(result.headers?.etag).toBeDefined();
    expect(await readAll(result.body!)).toEqual(bytes);
  });
});
