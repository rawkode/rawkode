import { describe, expect, test } from "bun:test";
import { deriveBlobId } from "@enchiridion/graph-core";
import { initializeSchema } from "./schema";
import { recordThreadMessages } from "./gmail-body-store";
import { getMessageBody } from "./gmail-body-store";
import { listAttachmentsByMessageIDs } from "./gmail-attachment-store";
import { readGmailBodyIngestFailures } from "./gmail-body-ingest-failures-store";
import { runGmailBodyIngest } from "./gmail-body-ingest";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";
import { InMemoryR2Bucket } from "./test-helpers/in-memory-r2-bucket";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

function encodeBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface FakeRoutes {
  messages?: Record<string, unknown>;
  attachments?: Record<string, { size: number; data: string }>;
}

function fakeFetch(routes: FakeRoutes): typeof fetch {
  return (async (input: string) => {
    const url = new URL(input);
    const attachmentMatch = /\/messages\/([^/]+)\/attachments\/([^/?]+)/.exec(url.pathname);
    if (attachmentMatch) {
      const [, , attachmentId] = attachmentMatch as unknown as [string, string, string];
      const fixture = routes.attachments?.[attachmentId];
      if (!fixture) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(fixture), { status: 200 });
    }
    const messageMatch = /\/messages\/([^/?]+)$/.exec(url.pathname);
    if (messageMatch) {
      const [, messageId] = messageMatch as unknown as [string, string];
      const fixture = routes.messages?.[messageId];
      if (!fixture) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(fixture), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url.pathname}`);
  }) as unknown as typeof fetch;
}

function fullMessageFixture(id: string, threadId: string, parts: unknown): unknown {
  return { id, threadId, labelIds: ["INBOX"], internalDate: "1754470800000", payload: parts };
}

describe("runGmailBodyIngest", () => {
  test("fetches format=full, parses, stores the body, and uploads an attachment content-addressed by deriveBlobId", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    recordThreadMessages(sql, "email_thread_aaa", "18abc0001", ["m1"]);

    const attachmentBytes = new TextEncoder().encode("PDF-ish bytes for the agenda");
    const fetchImpl = fakeFetch({
      messages: {
        m1: fullMessageFixture("m1", "18abc0001", {
          headers: [
            { name: "Subject", value: "Kickoff" },
            { name: "From", value: "alex@example.com" },
          ],
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: encodeBase64Url("Hey there") } },
            {
              mimeType: "application/pdf",
              filename: "agenda.pdf",
              body: { attachmentId: "att-1", size: attachmentBytes.byteLength },
            },
          ],
        }),
      },
      attachments: {
        "att-1": { size: attachmentBytes.byteLength, data: encodeBase64Url(attachmentBytes) },
      },
    });

    const result = await runGmailBodyIngest({ sql, r2, accessToken: "tok", now: new Date("2026-08-06T10:00:00Z"), fetchImpl });

    expect(result.consideredCount).toBe(1);
    expect(result.bodiesFetchedCount).toBe(1);
    expect(result.attachmentsUploadedCount).toBe(1);
    expect(result.failedCount).toBe(0);

    const body = getMessageBody(sql, "m1");
    expect(body?.pageID).toBe("email_thread_aaa");
    expect(body?.threadID).toBe("18abc0001");
    expect(body?.headers).toEqual({ Subject: "Kickoff", From: "alex@example.com" });
    expect(body?.bodyText).toBe("Hey there");
    expect(body?.receivedAt).toBe(1754470800000);

    const attachments = listAttachmentsByMessageIDs(sql, ["m1"]).get("m1");
    expect(attachments).toHaveLength(1);
    const expectedBlobId = await deriveBlobId(attachmentBytes);
    expect(attachments?.[0]?.blobID).toBe(expectedBlobId);
    expect(attachments?.[0]?.filename).toBe("agenda.pdf");
    expect(attachments?.[0]?.mimeType).toBe("application/pdf");
    expect(attachments?.[0]?.size).toBe(attachmentBytes.byteLength);

    // Real bytes actually landed in R2 under the content-addressed key.
    expect(r2.getStoredBytes(expectedBlobId)).toEqual(attachmentBytes);
    expect(r2.getStoredContentType(expectedBlobId)).toBe("application/pdf");
  });

  test("resolves an INLINE-DATA attachment without a separate attachments.get call", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    recordThreadMessages(sql, "email_thread_bbb", "18abc0002", ["m2"]);

    const inlineBytes = new TextEncoder().encode("small inline attachment");
    const fetchImpl = fakeFetch({
      messages: {
        m2: fullMessageFixture("m2", "18abc0002", {
          headers: [{ name: "Subject", value: "Small file" }],
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: encodeBase64Url("see attached") } },
            { mimeType: "text/plain", filename: "notes.txt", body: { data: encodeBase64Url(inlineBytes) } },
          ],
        }),
      },
      // Deliberately NO attachments fixture — if the ingest code
      // incorrectly tried attachments.get for this inline part, the fake
      // fetch router would throw "unexpected fetch" and this test would
      // fail, proving inline data is used directly.
      attachments: {},
    });

    const result = await runGmailBodyIngest({ sql, r2, accessToken: "tok", now: new Date(), fetchImpl });
    expect(result.attachmentsUploadedCount).toBe(1);

    const expectedBlobId = await deriveBlobId(inlineBytes);
    expect(r2.getStoredBytes(expectedBlobId)).toEqual(inlineBytes);
  });

  test("dedupes an attachment already present in R2 (head() hit) — no redundant put()", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const sharedBytes = new TextEncoder().encode("identical content across two messages");
    const sharedBlobId = await deriveBlobId(sharedBytes);
    await r2.put(sharedBlobId, sharedBytes); // pre-seed, as if another message already uploaded it
    r2.putCalls.length = 0; // reset the call log after the seed write

    recordThreadMessages(sql, "email_thread_ccc", "18abc0003", ["m3"]);
    const fetchImpl = fakeFetch({
      messages: {
        m3: fullMessageFixture("m3", "18abc0003", {
          headers: [],
          mimeType: "multipart/mixed",
          parts: [{ mimeType: "application/octet-stream", filename: "dup.bin", body: { attachmentId: "att-dup", size: sharedBytes.byteLength } }],
        }),
      },
      attachments: { "att-dup": { size: sharedBytes.byteLength, data: encodeBase64Url(sharedBytes) } },
    });

    await runGmailBodyIngest({ sql, r2, accessToken: "tok", now: new Date(), fetchImpl });

    expect(r2.putCalls).toEqual([]); // head() found it — put() never called again
    // The reference row is still recorded even though the R2 write was skipped.
    expect(listAttachmentsByMessageIDs(sql, ["m3"]).get("m3")).toHaveLength(1);
  });

  test("skips a message that already has a stored body — no fetch attempted, no re-ingest", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    recordThreadMessages(sql, "email_thread_ddd", "18abc0004", ["m4"]);

    // First cycle: ingest succeeds.
    const fetchImpl1 = fakeFetch({
      messages: { m4: fullMessageFixture("m4", "18abc0004", { headers: [], mimeType: "text/plain", body: { data: encodeBase64Url("hi") } }) },
    });
    const first = await runGmailBodyIngest({ sql, r2, accessToken: "tok", now: new Date(), fetchImpl: fetchImpl1 });
    expect(first.bodiesFetchedCount).toBe(1);

    // Second cycle: listMessagesMissingBodies should find nothing left —
    // if it incorrectly re-fetched, the fetchImpl below (which returns 404
    // for every message) would surface a failure instead of a clean no-op.
    const fetchImpl2 = fakeFetch({});
    const second = await runGmailBodyIngest({ sql, r2, accessToken: "tok", now: new Date(), fetchImpl: fetchImpl2 });
    expect(second.consideredCount).toBe(0);
    expect(second.bodiesFetchedCount).toBe(0);
    expect(second.failedCount).toBe(0);
  });

  test("poison-pill isolation: one message's fetch failure doesn't abort the rest of the batch", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    recordThreadMessages(sql, "email_thread_eee", "18abc0005", ["good1", "bad", "good2"]);

    const fetchImpl = fakeFetch({
      messages: {
        good1: fullMessageFixture("good1", "18abc0005", { headers: [], mimeType: "text/plain", body: { data: encodeBase64Url("ok 1") } }),
        good2: fullMessageFixture("good2", "18abc0005", { headers: [], mimeType: "text/plain", body: { data: encodeBase64Url("ok 2") } }),
        // "bad" deliberately omitted — fakeFetch returns 404 for it, and
        // getMessage() (gmail-api.ts) throws GmailApiError on a non-ok
        // response, exercising the real failure path, not a synthetic one.
      },
    });

    const result = await runGmailBodyIngest({ sql, r2, accessToken: "tok", now: new Date("2026-08-06T10:00:00Z"), fetchImpl });

    expect(result.consideredCount).toBe(3);
    expect(result.bodiesFetchedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(getMessageBody(sql, "good1")).toBeDefined();
    expect(getMessageBody(sql, "good2")).toBeDefined();
    expect(getMessageBody(sql, "bad")).toBeUndefined();

    const failures = readGmailBodyIngestFailures(sql);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.messageID).toBe("bad");
    expect(failures[0]?.errorMessage).toContain("404");
  });

  test("respects BODY_INGEST_BATCH_SIZE — a huge backlog only advances one bounded batch per call", async () => {
    const sql = makeSql();
    const r2 = new InMemoryR2Bucket();
    const messageIDs = Array.from({ length: 40 }, (_, i) => `m${i}`);
    recordThreadMessages(sql, "email_thread_fff", "18abc0006", messageIDs);

    const messages: Record<string, unknown> = {};
    for (const id of messageIDs) {
      messages[id] = fullMessageFixture(id, "18abc0006", { headers: [], mimeType: "text/plain", body: { data: encodeBase64Url("x") } });
    }
    const fetchImpl = fakeFetch({ messages });

    const result = await runGmailBodyIngest({ sql, r2, accessToken: "tok", now: new Date(), fetchImpl });
    expect(result.consideredCount).toBe(25); // BODY_INGEST_BATCH_SIZE
    expect(result.bodiesFetchedCount).toBe(25);
  });
});
