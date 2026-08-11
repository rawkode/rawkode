import { describe, expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt/bundler";
import { decodeEdgeEntry, decodePropertyValues, PageContainer } from "@enchiridion/projection";
import { buildEmailThreadDocUpdate } from "./gmail-materialized-doc";
import { EmailSupertagIDs } from "./supertag-registry";
import type { NormalizedThread } from "./gmail-materialization";

const EMAIL_THREAD = EmailSupertagIDs.emailThread;

const BASE_THREAD: NormalizedThread = {
  pageID: "email_thread_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  threadID: "18abc0001",
  subject: "Project kickoff",
  labels: ["IMPORTANT", "INBOX"],
  snippet: "Hey, following up on this...",
  lastMessageAt: new Date("2026-08-06T09:00:00.000Z").toISOString(),
  messageCount: 2,
  fromParticipants: [{ email: "alex@example.com", displayName: "Alex Guest" }],
  toParticipants: [],
  ccParticipants: [],
  sentToAddresses: [],
  messageIds: ["m1", "m2"],
};

function buildDoc(updateBytes: Uint8Array): LoroDoc {
  const doc = new LoroDoc();
  doc.import(updateBytes);
  return doc;
}

function values(doc: LoroDoc): Record<string, unknown> {
  return doc.getMap(PageContainer.values).getShallowValue() as Record<string, unknown>;
}

describe("buildEmailThreadDocUpdate", () => {
  test("writes subject as BOTH the page title and the 'subject' values field", async () => {
    const result = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: BASE_THREAD,
      fromPageIDs: [],
      toPageIDs: [],
      ccPageIDs: [],
      now: new Date("2026-08-06T09:00:00Z"),
    });
    expect(result.changed).toBe(true);
    const doc = buildDoc(result.updateBytes);
    expect(doc.getText(PageContainer.title).toString()).toBe("Project kickoff");
    const decoded = decodePropertyValues(values(doc)[`property:${EMAIL_THREAD}:subject`] as string);
    expect(decoded).toEqual([{ type: "text", value: "Project kickoff" }]);
  });

  test("writes labels as multiple text values", async () => {
    const result = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: BASE_THREAD,
      fromPageIDs: [],
      toPageIDs: [],
      ccPageIDs: [],
      now: new Date("2026-08-06T09:00:00Z"),
    });
    const doc = buildDoc(result.updateBytes);
    const decoded = decodePropertyValues(values(doc)[`property:${EMAIL_THREAD}:labels`] as string);
    expect(decoded).toEqual([
      { type: "text", value: "IMPORTANT" },
      { type: "text", value: "INBOX" },
    ]);
  });

  test("an empty labels array DELETES any previously-stored labels value rather than writing an empty array", async () => {
    const first = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: BASE_THREAD,
      fromPageIDs: [],
      toPageIDs: [],
      ccPageIDs: [],
      now: new Date("2026-08-06T09:00:00Z"),
    });
    const second = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: { ...BASE_THREAD, labels: [] },
      fromPageIDs: [],
      toPageIDs: [],
      ccPageIDs: [],
      existingSnapshot: first.snapshotBytes,
      now: new Date("2026-08-06T10:00:00Z"),
    });
    expect(second.changed).toBe(true);
    const doc = buildDoc(first.updateBytes);
    doc.import(second.updateBytes);
    expect(values(doc)[`property:${EMAIL_THREAD}:labels`]).toBeUndefined();
  });

  test("writes snippet/lastMessageAt/messageCount", async () => {
    const result = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: BASE_THREAD,
      fromPageIDs: [],
      toPageIDs: [],
      ccPageIDs: [],
      now: new Date("2026-08-06T09:00:00Z"),
    });
    const doc = buildDoc(result.updateBytes);
    const v = values(doc);
    expect(decodePropertyValues(v[`property:${EMAIL_THREAD}:snippet`] as string)).toEqual([
      { type: "text", value: BASE_THREAD.snippet },
    ]);
    expect(decodePropertyValues(v[`property:${EMAIL_THREAD}:lastMessageAt`] as string)).toEqual([
      { type: "dateTime", value: BASE_THREAD.lastMessageAt },
    ]);
    expect(decodePropertyValues(v[`property:${EMAIL_THREAD}:messageCount`] as string)).toEqual([
      { type: "number", value: 2 },
    ]);
  });

  test("writes from/to/cc edges pointing at the given page ids", async () => {
    const result = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: BASE_THREAD,
      fromPageIDs: ["person_from1"],
      toPageIDs: ["person_to1", "person_to2"],
      ccPageIDs: [],
      now: new Date("2026-08-06T09:00:00Z"),
    });
    const doc = buildDoc(result.updateBytes);
    const edges = doc.getMap(PageContainer.edges).getShallowValue();
    const decoded = Object.values(edges).map((json) => decodeEdgeEntry(json as string, BASE_THREAD.pageID)!);
    const targets = decoded.map((e) => e.targetNodeID).sort();
    expect(targets).toEqual(["person_from1", "person_to1", "person_to2"]);
  });

  test("changedFields gating: only touches the fields listed, exactly like buildEventDocUpdate's contract", async () => {
    const first = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: BASE_THREAD,
      fromPageIDs: [],
      toPageIDs: [],
      ccPageIDs: [],
      now: new Date("2026-08-06T09:00:00Z"),
    });

    // Second call: only "snippet" is in changedFields, even though the
    // input thread ALSO has a different subject — subject must NOT be
    // touched.
    const changed = { ...BASE_THREAD, subject: "A totally different subject", snippet: "Updated snippet" };
    const second = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: changed,
      fromPageIDs: [],
      toPageIDs: [],
      ccPageIDs: [],
      changedFields: new Set(["snippet"]),
      existingSnapshot: first.snapshotBytes,
      now: new Date("2026-08-06T10:00:00Z"),
    });
    expect(second.changed).toBe(true);

    const doc = buildDoc(first.updateBytes);
    doc.import(second.updateBytes);
    expect(doc.getText(PageContainer.title).toString()).toBe("Project kickoff"); // unchanged
    const v = values(doc);
    expect(decodePropertyValues(v[`property:${EMAIL_THREAD}:subject`] as string)).toEqual([
      { type: "text", value: "Project kickoff" },
    ]); // unchanged
    expect(decodePropertyValues(v[`property:${EMAIL_THREAD}:snippet`] as string)).toEqual([
      { type: "text", value: "Updated snippet" },
    ]);
  });

  test("removing a participant from the desired set retracts their edge on the next build (reconcileOwnedEdges)", async () => {
    const first = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: BASE_THREAD,
      fromPageIDs: ["person_from1", "person_from2"],
      toPageIDs: [],
      ccPageIDs: [],
      now: new Date("2026-08-06T09:00:00Z"),
    });
    const second = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: BASE_THREAD,
      fromPageIDs: ["person_from1"], // person_from2 dropped
      toPageIDs: [],
      ccPageIDs: [],
      existingSnapshot: first.snapshotBytes,
      now: new Date("2026-08-06T10:00:00Z"),
    });
    expect(second.changed).toBe(true);

    const doc = buildDoc(first.updateBytes);
    doc.import(second.updateBytes);
    const edges = doc.getMap(PageContainer.edges).getShallowValue();
    const decoded = Object.values(edges).map((json) => decodeEdgeEntry(json as string, BASE_THREAD.pageID)!);
    expect(decoded.map((e) => e.targetNodeID)).toEqual(["person_from1"]);
  });

  test("no changed fields at all produces a no-op (changed: false)", async () => {
    const first = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: BASE_THREAD,
      fromPageIDs: [],
      toPageIDs: [],
      ccPageIDs: [],
      now: new Date("2026-08-06T09:00:00Z"),
    });
    const second = await buildEmailThreadDocUpdate({
      pageID: BASE_THREAD.pageID,
      thread: { ...BASE_THREAD, subject: "Would be different but not in changedFields" },
      fromPageIDs: [],
      toPageIDs: [],
      ccPageIDs: [],
      changedFields: new Set(),
      existingSnapshot: first.snapshotBytes,
      now: new Date("2026-08-06T10:00:00Z"),
    });
    expect(second.changed).toBe(false);
  });
});
