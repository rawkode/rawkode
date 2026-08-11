import { describe, expect, test } from "bun:test";
import {
  appendPendingUpdate,
  compactDoc,
  docExists,
  listStoredPageIds,
  openDoc,
} from "./doc-store";
import { LoroPageDoc } from "./loro-storage";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

describe("doc-store — openDoc", () => {
  test("a page with no storage yet opens as an empty doc", () => {
    const sql = makeSql();
    const doc = openDoc(sql, "page_new");
    expect(doc.textContent("body")).toBe("");
  });

  test("docExists is false before any write, true after", () => {
    const sql = makeSql();
    expect(docExists(sql, "p1")).toBe(false);

    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "hi");
    writer.commit();
    appendPendingUpdate(sql, "p1", writer.exportAllUpdates(), 100);

    expect(docExists(sql, "p1")).toBe(true);
  });
});

describe("doc-store — appendPendingUpdate + openDoc replay", () => {
  test("a single pending update round trips through openDoc", () => {
    const sql = makeSql();
    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "Hello");
    writer.commit();
    appendPendingUpdate(sql, "p1", writer.exportAllUpdates(), 100);

    const reopened = openDoc(sql, "p1");
    expect(reopened.textContent("body")).toBe("Hello");
  });

  test("multiple pending updates applied across separate writes replay in order", () => {
    const sql = makeSql();

    // Write 1: create the doc with "A".
    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "A");
    writer.commit();
    appendPendingUpdate(sql, "p1", writer.exportAllUpdates(), 100);
    const vvAfterFirst = writer.versionVector();

    // Write 2: append "B", ship only the incremental update.
    writer.text("body").insert(1, "B");
    writer.commit();
    const update2 = writer.exportUpdatesSince(vvAfterFirst);
    appendPendingUpdate(sql, "p1", update2, 200);

    const reopened = openDoc(sql, "p1");
    expect(reopened.textContent("body")).toBe("AB");
  });

  test("appendPendingUpdate on a brand-new page creates an implicit empty snapshot row first", () => {
    const sql = makeSql();
    expect(docExists(sql, "p1")).toBe(false);

    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "x");
    writer.commit();
    appendPendingUpdate(sql, "p1", writer.exportAllUpdates(), 100);

    expect(docExists(sql, "p1")).toBe(true);
    const row = sql
      .exec<{ snapshot: ArrayBuffer }>("SELECT snapshot FROM doc_snapshots WHERE page_id = 'p1'")
      .one();
    expect(row.snapshot.byteLength).toBeGreaterThan(0);
  });
});

describe("doc-store — compactDoc", () => {
  test("compaction folds pending updates into a fresh snapshot and clears the log", () => {
    const sql = makeSql();
    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "Hello");
    writer.commit();
    appendPendingUpdate(sql, "p1", writer.exportAllUpdates(), 100);

    const pendingBefore = sql
      .exec<{ n: number }>("SELECT count(*) as n FROM doc_pending_updates WHERE page_id = 'p1'")
      .one().n;
    expect(pendingBefore).toBe(1);

    const doc = openDoc(sql, "p1");
    compactDoc(sql, "p1", doc, 500);

    const pendingAfter = sql
      .exec<{ n: number }>("SELECT count(*) as n FROM doc_pending_updates WHERE page_id = 'p1'")
      .one().n;
    expect(pendingAfter).toBe(0);

    // State survives compaction and re-opening from the fresh snapshot.
    const reopened = openDoc(sql, "p1");
    expect(reopened.textContent("body")).toBe("Hello");
  });

  test("compaction is idempotent and updates the stored version vector", () => {
    const sql = makeSql();
    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "x");
    writer.commit();
    appendPendingUpdate(sql, "p1", writer.exportAllUpdates(), 100);

    const doc1 = openDoc(sql, "p1");
    compactDoc(sql, "p1", doc1, 200);
    const vv1 = sql
      .exec<{ version_vector: ArrayBuffer }>("SELECT version_vector FROM doc_snapshots WHERE page_id = 'p1'")
      .one().version_vector;

    const doc2 = openDoc(sql, "p1");
    doc2.text("body").insert(1, "y");
    doc2.commit();
    compactDoc(sql, "p1", doc2, 300);
    const vv2 = sql
      .exec<{ version_vector: ArrayBuffer }>("SELECT version_vector FROM doc_snapshots WHERE page_id = 'p1'")
      .one().version_vector;

    expect(new Uint8Array(vv2)).not.toEqual(new Uint8Array(vv1));
    expect(openDoc(sql, "p1").textContent("body")).toBe("xy");
  });
});

describe("doc-store — listStoredPageIds", () => {
  test("lists and paginates stored page ids in lexicographic order", () => {
    const sql = makeSql();
    for (const id of ["c", "a", "b"]) {
      const writer = LoroPageDoc.create();
      writer.text("body").insert(0, id);
      writer.commit();
      appendPendingUpdate(sql, id, writer.exportAllUpdates(), 1);
    }

    expect(listStoredPageIds(sql)).toEqual(["a", "b", "c"]);
    expect(listStoredPageIds(sql, undefined, 2)).toEqual(["a", "b"]);
    expect(listStoredPageIds(sql, "a", 10)).toEqual(["b", "c"]);
    expect(listStoredPageIds(sql, "c", 10)).toEqual([]);
  });
});
