import { describe, expect, test } from "bun:test";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";
import { listAttachmentsByMessageIDs, recordAttachment } from "./gmail-attachment-store";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

describe("recordAttachment / listAttachmentsByMessageIDs", () => {
  test("batches attachment lookup across multiple message ids", () => {
    const sql = makeSql();
    recordAttachment(sql, { messageID: "m1", blobID: "blob_" + "a".repeat(64), filename: "a.pdf", mimeType: "application/pdf", size: 100 }, 1000);
    recordAttachment(sql, { messageID: "m1", blobID: "blob_" + "b".repeat(64), filename: "b.png", mimeType: "image/png", size: 200 }, 1001);
    recordAttachment(sql, { messageID: "m2", blobID: "blob_" + "c".repeat(64), filename: "c.txt", mimeType: "text/plain", size: 300 }, 1002);

    const result = listAttachmentsByMessageIDs(sql, ["m1", "m2", "m3-absent"]);
    expect(result.get("m1")?.map((a) => a.filename)).toEqual(["a.pdf", "b.png"]);
    expect(result.get("m2")?.map((a) => a.filename)).toEqual(["c.txt"]);
    expect(result.has("m3-absent")).toBe(false);
  });

  test("returns an empty map for an empty messageIDs array", () => {
    const sql = makeSql();
    expect(listAttachmentsByMessageIDs(sql, [])).toEqual(new Map());
  });

  test("filename/mimeType are optional — nullable columns round-trip as undefined", () => {
    const sql = makeSql();
    recordAttachment(sql, { messageID: "m1", blobID: "blob_" + "d".repeat(64), size: 42 }, 1000);
    const attachments = listAttachmentsByMessageIDs(sql, ["m1"]).get("m1");
    expect(attachments?.[0]).toEqual({ messageID: "m1", blobID: "blob_" + "d".repeat(64), filename: undefined, mimeType: undefined, size: 42 });
  });
});
