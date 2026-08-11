import { describe, expect, test } from "bun:test";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";
import {
  getMessageBody,
  hasMessageBody,
  listMessageBodiesByPageIDs,
  listMessagesMissingBodies,
  recordThreadMessages,
  resolveThreadIdForPageID,
  searchMessageBodies,
  setMessageBody,
  type StoredMessageBody,
} from "./gmail-body-store";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

function body(overrides: Partial<StoredMessageBody> & { messageID: string; pageID: string }): StoredMessageBody {
  return {
    threadID: "18abc0001",
    headers: { Subject: "Kickoff" },
    bodyText: undefined,
    bodyHtml: undefined,
    receivedAt: 1000,
    ...overrides,
  };
}

describe("setMessageBody / getMessageBody / hasMessageBody", () => {
  test("round-trips a full body including headers and both body variants", () => {
    const sql = makeSql();
    setMessageBody(
      sql,
      body({
        messageID: "m1",
        pageID: "email_thread_aaa",
        headers: { Subject: "Kickoff", From: "alex@example.com" },
        bodyText: "plain",
        bodyHtml: "<p>html</p>",
        receivedAt: 12345,
      }),
    );

    expect(hasMessageBody(sql, "m1")).toBe(true);
    expect(hasMessageBody(sql, "does-not-exist")).toBe(false);

    const stored = getMessageBody(sql, "m1");
    expect(stored).toEqual(
      body({
        messageID: "m1",
        pageID: "email_thread_aaa",
        headers: { Subject: "Kickoff", From: "alex@example.com" },
        bodyText: "plain",
        bodyHtml: "<p>html</p>",
        receivedAt: 12345,
      }),
    );
  });

  test("upserts by messageID — a second write with the same id overwrites, not duplicates", () => {
    const sql = makeSql();
    setMessageBody(sql, body({ messageID: "m1", pageID: "email_thread_aaa", bodyText: "first" }));
    setMessageBody(sql, body({ messageID: "m1", pageID: "email_thread_aaa", bodyText: "second" }));
    expect(getMessageBody(sql, "m1")?.bodyText).toBe("second");
    expect(listMessageBodiesByPageIDs(sql, ["email_thread_aaa"]).get("email_thread_aaa")).toHaveLength(1);
  });
});

describe("listMessageBodiesByPageIDs", () => {
  test("batches across multiple page ids in one call, ordered oldest-first within each", () => {
    const sql = makeSql();
    setMessageBody(sql, body({ messageID: "a2", pageID: "thread_a", receivedAt: 200 }));
    setMessageBody(sql, body({ messageID: "a1", pageID: "thread_a", receivedAt: 100 }));
    setMessageBody(sql, body({ messageID: "b1", pageID: "thread_b", receivedAt: 50 }));

    const result = listMessageBodiesByPageIDs(sql, ["thread_a", "thread_b", "thread_c_absent"]);
    expect(result.get("thread_a")?.map((m) => m.messageID)).toEqual(["a1", "a2"]);
    expect(result.get("thread_b")?.map((m) => m.messageID)).toEqual(["b1"]);
    expect(result.has("thread_c_absent")).toBe(false);
  });

  test("returns an empty map for an empty pageIDs array, without querying", () => {
    const sql = makeSql();
    expect(listMessageBodiesByPageIDs(sql, [])).toEqual(new Map());
  });
});

describe("searchMessageBodies", () => {
  test("finds a message by body text content", () => {
    const sql = makeSql();
    setMessageBody(sql, body({ messageID: "m1", pageID: "thread_a", bodyText: "Please review the Q1 budget spreadsheet." }));
    setMessageBody(sql, body({ messageID: "m2", pageID: "thread_a", bodyText: "Unrelated newsletter content." }));

    const results = searchMessageBodies(sql, "budget", 10);
    expect(results.map((m) => m.messageID)).toEqual(["m1"]);
  });

  test("finds a message by subject (headers are searched too)", () => {
    const sql = makeSql();
    setMessageBody(sql, body({ messageID: "m1", pageID: "thread_a", headers: { Subject: "Budget review" }, bodyText: "no keyword here" }));

    const results = searchMessageBodies(sql, "Budget", 10);
    expect(results.map((m) => m.messageID)).toEqual(["m1"]);
  });

  test("finds a message by html body content", () => {
    const sql = makeSql();
    setMessageBody(sql, body({ messageID: "m1", pageID: "thread_a", bodyHtml: "<p>the launch checklist</p>" }));
    const results = searchMessageBodies(sql, "checklist", 10);
    expect(results.map((m) => m.messageID)).toEqual(["m1"]);
  });

  test("returns [] when nothing matches", () => {
    const sql = makeSql();
    setMessageBody(sql, body({ messageID: "m1", pageID: "thread_a", bodyText: "hello" }));
    expect(searchMessageBodies(sql, "nonexistent-term", 10)).toEqual([]);
  });

  test("respects the limit and orders most-recent-first", () => {
    const sql = makeSql();
    setMessageBody(sql, body({ messageID: "m1", pageID: "thread_a", bodyText: "budget one", receivedAt: 100 }));
    setMessageBody(sql, body({ messageID: "m2", pageID: "thread_a", bodyText: "budget two", receivedAt: 300 }));
    setMessageBody(sql, body({ messageID: "m3", pageID: "thread_a", bodyText: "budget three", receivedAt: 200 }));

    const results = searchMessageBodies(sql, "budget", 2);
    expect(results.map((m) => m.messageID)).toEqual(["m2", "m3"]);
  });
});

describe("recordThreadMessages / listMessagesMissingBodies", () => {
  test("a freshly recorded message with no body is reported missing", () => {
    const sql = makeSql();
    recordThreadMessages(sql, "thread_a", "18abc0001", ["m1", "m2"]);
    const missing = listMessagesMissingBodies(sql, 10);
    expect(missing.map((m) => m.messageID).sort()).toEqual(["m1", "m2"]);
    expect(missing[0]?.pageID).toBe("thread_a");
    expect(missing[0]?.threadID).toBe("18abc0001");
  });

  test("a message with a stored body is excluded from the missing list", () => {
    const sql = makeSql();
    recordThreadMessages(sql, "thread_a", "18abc0001", ["m1", "m2"]);
    setMessageBody(sql, body({ messageID: "m1", pageID: "thread_a" }));

    const missing = listMessagesMissingBodies(sql, 10);
    expect(missing.map((m) => m.messageID)).toEqual(["m2"]);
  });

  test("re-recording an already-known (page, message) pair is a harmless no-op — INSERT OR IGNORE", () => {
    const sql = makeSql();
    recordThreadMessages(sql, "thread_a", "18abc0001", ["m1"]);
    recordThreadMessages(sql, "thread_a", "18abc0001", ["m1"]); // duplicate call
    const missing = listMessagesMissingBodies(sql, 10);
    expect(missing.filter((m) => m.messageID === "m1")).toHaveLength(1);
  });

  test("the SAME message id under two different page ids is tracked independently (primary key is the pair)", () => {
    const sql = makeSql();
    recordThreadMessages(sql, "thread_a", "18abc0001", ["shared-id"]);
    recordThreadMessages(sql, "thread_b", "18abc0002", ["shared-id"]);
    const missing = listMessagesMissingBodies(sql, 10);
    expect(missing.map((m) => m.pageID).sort()).toEqual(["thread_a", "thread_b"]);
  });

  test("respects the limit parameter", () => {
    const sql = makeSql();
    recordThreadMessages(sql, "thread_a", "18abc0001", ["m1", "m2", "m3"]);
    expect(listMessagesMissingBodies(sql, 2)).toHaveLength(2);
  });
});

describe("resolveThreadIdForPageID — vault threadPageID -> raw Gmail thread id lookup (triage write-model)", () => {
  test("resolves a page id that has a gmail_thread_messages row to its raw Gmail thread id", () => {
    const sql = makeSql();
    recordThreadMessages(sql, "email_thread_aaa", "18abc0001", ["m1", "m2"]);
    expect(resolveThreadIdForPageID(sql, "email_thread_aaa")).toBe("18abc0001");
  });

  test("an unknown page id resolves to undefined, not an error", () => {
    const sql = makeSql();
    expect(resolveThreadIdForPageID(sql, "email_thread_never_seen")).toBeUndefined();
  });

  test("multiple message rows for the same page id still resolve unambiguously (LIMIT 1, all rows share the same thread_id)", () => {
    const sql = makeSql();
    recordThreadMessages(sql, "email_thread_bbb", "18abc0002", ["m1"]);
    recordThreadMessages(sql, "email_thread_bbb", "18abc0002", ["m2", "m3"]);
    expect(resolveThreadIdForPageID(sql, "email_thread_bbb")).toBe("18abc0002");
  });

  test("does not confuse two different page ids with different thread ids", () => {
    const sql = makeSql();
    recordThreadMessages(sql, "email_thread_aaa", "18abc0001", ["m1"]);
    recordThreadMessages(sql, "email_thread_bbb", "18abc0002", ["m2"]);
    expect(resolveThreadIdForPageID(sql, "email_thread_aaa")).toBe("18abc0001");
    expect(resolveThreadIdForPageID(sql, "email_thread_bbb")).toBe("18abc0002");
  });
});
