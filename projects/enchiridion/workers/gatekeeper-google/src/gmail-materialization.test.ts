import { describe, expect, test } from "bun:test";
import { emailThreadFieldBaselineHashes, normalizeThread, type MaterializedThreadFields } from "./gmail-materialization";
import type { GmailMessage, GmailThread } from "./gmail-api";

const SELF = "david@rawkode.academy";

function message(overrides: Partial<GmailMessage> & { headers?: { name: string; value: string }[] } = {}): GmailMessage {
  const { headers, ...rest } = overrides;
  return {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    snippet: "Hey, following up on this...",
    internalDate: "1754470800000",
    payload: { headers: headers ?? [{ name: "Subject", value: "Project kickoff" }, { name: "From", value: "Alex Guest <alex@example.com>" }, { name: "To", value: SELF }] },
    ...rest,
  };
}

describe("normalizeThread", () => {
  test("undefined for a thread with no id", async () => {
    const thread = { id: "", messages: [message()] } as GmailThread;
    expect(await normalizeThread(thread, SELF)).toBeUndefined();
  });

  test("undefined for a thread with zero messages", async () => {
    const thread: GmailThread = { id: "t1", messages: [] };
    expect(await normalizeThread(thread, SELF)).toBeUndefined();
  });

  test("a real-shaped single-message thread normalizes subject/snippet/lastMessageAt/messageCount/participants", async () => {
    const thread: GmailThread = {
      id: "18abc0001",
      snippet: "Hey, following up on this...",
      messages: [
        message({
          labelIds: ["INBOX", "IMPORTANT"],
          headers: [
            { name: "Subject", value: "Project kickoff" },
            { name: "From", value: "Alex Guest <alex@example.com>" },
            { name: "To", value: `${SELF}` },
          ],
        }),
      ],
    };

    const normalized = await normalizeThread(thread, SELF);
    expect(normalized).toBeDefined();
    expect(normalized?.threadID).toBe("18abc0001");
    expect(normalized?.subject).toBe("Project kickoff");
    expect(normalized?.labels).toEqual(["IMPORTANT", "INBOX"]);
    expect(normalized?.messageCount).toBe(1);
    expect(normalized?.lastMessageAt).toBe(new Date(1754470800000).toISOString());
    expect(normalized?.fromParticipants).toEqual([{ email: "alex@example.com", displayName: "Alex Guest" }]);
    // SELF was the To recipient, but since this message isn't SENT-labeled
    // it should NOT appear in toParticipants (self is always excluded) —
    // and there are no other recipients, so toParticipants is empty.
    expect(normalized?.toParticipants).toEqual([]);
  });

  test("the account owner is excluded from every participant role even when they appear in headers", async () => {
    const thread: GmailThread = {
      id: "t1",
      messages: [
        message({
          headers: [
            { name: "Subject", value: "Re: kickoff" },
            { name: "From", value: SELF },
            { name: "To", value: "Alex Guest <alex@example.com>" },
            { name: "Cc", value: `${SELF}, other@example.com` },
          ],
          labelIds: ["SENT"],
        }),
      ],
    };
    const normalized = await normalizeThread(thread, SELF);
    expect(normalized?.fromParticipants).toEqual([]);
    expect(normalized?.ccParticipants).toEqual([{ email: "other@example.com" }]);
  });

  test("a SENT-labeled message's To/Cc recipients populate sentToAddresses (excluding self)", async () => {
    const thread: GmailThread = {
      id: "t1",
      messages: [
        message({
          labelIds: ["SENT"],
          headers: [
            { name: "Subject", value: "Kickoff" },
            { name: "From", value: SELF },
            { name: "To", value: "alex@example.com" },
            { name: "Cc", value: "colleague@example.com" },
          ],
        }),
      ],
    };
    const normalized = await normalizeThread(thread, SELF);
    expect(new Set(normalized?.sentToAddresses)).toEqual(new Set(["alex@example.com", "colleague@example.com"]));
  });

  test("a non-SENT (received) message's To/Cc do NOT populate sentToAddresses", async () => {
    const thread: GmailThread = {
      id: "t1",
      messages: [
        message({
          labelIds: ["INBOX"],
          headers: [
            { name: "Subject", value: "Newsletter" },
            { name: "From", value: "newsletter@example.com" },
            { name: "To", value: SELF },
          ],
        }),
      ],
    };
    const normalized = await normalizeThread(thread, SELF);
    expect(normalized?.sentToAddresses).toEqual([]);
    expect(normalized?.fromParticipants).toEqual([{ email: "newsletter@example.com" }]);
  });

  test("multiple messages: subject from the FIRST message, snippet/lastMessageAt from the LATEST, labels/participants unioned", async () => {
    const thread: GmailThread = {
      id: "t1",
      snippet: "old snippet",
      messages: [
        message({
          id: "m1",
          labelIds: ["SENT"],
          internalDate: "1000",
          snippet: "first message snippet",
          headers: [
            { name: "Subject", value: "Original subject" },
            { name: "From", value: SELF },
            { name: "To", value: "alex@example.com" },
          ],
        }),
        message({
          id: "m2",
          labelIds: ["INBOX"],
          internalDate: "2000",
          snippet: "reply snippet, most recent",
          headers: [
            { name: "Subject", value: "Re: Original subject" },
            { name: "From", value: "Alex Guest <alex@example.com>" },
            { name: "To", value: SELF },
          ],
        }),
      ],
    };
    const normalized = await normalizeThread(thread, SELF);
    expect(normalized?.subject).toBe("Original subject");
    expect(normalized?.snippet).toBe("reply snippet, most recent");
    expect(normalized?.lastMessageAt).toBe(new Date(2000).toISOString());
    expect(normalized?.messageCount).toBe(2);
    expect(normalized?.labels).toEqual(["INBOX", "SENT"]);
    // alex appears as both a "to" (message 1) and "from" (message 2)
    // participant — both roles should carry them, with the display name
    // filled in from whichever message supplied one.
    expect(normalized?.toParticipants).toEqual([{ email: "alex@example.com" }]);
    expect(normalized?.fromParticipants).toEqual([{ email: "alex@example.com", displayName: "Alex Guest" }]);
  });

  test("selfEmail undefined (not yet discovered) means no participant is excluded", async () => {
    const thread: GmailThread = {
      id: "t1",
      messages: [
        message({
          headers: [
            { name: "Subject", value: "Kickoff" },
            { name: "From", value: "alex@example.com" },
            { name: "To", value: SELF },
          ],
        }),
      ],
    };
    const normalized = await normalizeThread(thread, undefined);
    expect(normalized?.toParticipants).toEqual([{ email: SELF }]);
  });
});

describe("emailThreadFieldBaselineHashes", () => {
  const BASE: MaterializedThreadFields = {
    subject: "Project kickoff",
    labels: ["INBOX", "IMPORTANT"],
    snippet: "Hey, following up...",
    lastMessageAt: new Date(1000).toISOString(),
    messageCount: 1,
    fromPageIDs: ["person_aaa"],
    toPageIDs: [],
    ccPageIDs: [],
  };

  test("identical fields produce identical hashes", async () => {
    const a = await emailThreadFieldBaselineHashes(BASE);
    const b = await emailThreadFieldBaselineHashes({ ...BASE });
    expect(a).toEqual(b);
  });

  test("changing ONLY labels changes ONLY the labels hash — independent of subject/snippet/etc (the axis of change this task's per-field design exists for)", async () => {
    const a = await emailThreadFieldBaselineHashes(BASE);
    const b = await emailThreadFieldBaselineHashes({ ...BASE, labels: ["INBOX", "IMPORTANT", "STARRED"] });
    expect(b.labels).not.toBe(a.labels);
    expect(b.subject).toBe(a.subject);
    expect(b.snippet).toBe(a.snippet);
    expect(b.lastMessageAt).toBe(a.lastMessageAt);
    expect(b.messageCount).toBe(a.messageCount);
    expect(b.from).toBe(a.from);
  });

  test("label array order does not affect the hash (internally sorted)", async () => {
    const a = await emailThreadFieldBaselineHashes({ ...BASE, labels: ["INBOX", "IMPORTANT"] });
    const b = await emailThreadFieldBaselineHashes({ ...BASE, labels: ["IMPORTANT", "INBOX"] });
    expect(a.labels).toBe(b.labels);
  });

  test("changing fromPageIDs (a participant crossing the quality gate) changes ONLY the 'from' hash", async () => {
    const a = await emailThreadFieldBaselineHashes(BASE);
    const b = await emailThreadFieldBaselineHashes({ ...BASE, fromPageIDs: ["person_aaa", "person_bbb"] });
    expect(b.from).not.toBe(a.from);
    expect(b.to).toBe(a.to);
    expect(b.subject).toBe(a.subject);
  });

  test("fromPageIDs order does not affect the hash", async () => {
    const a = await emailThreadFieldBaselineHashes({ ...BASE, fromPageIDs: ["person_aaa", "person_bbb"] });
    const b = await emailThreadFieldBaselineHashes({ ...BASE, fromPageIDs: ["person_bbb", "person_aaa"] });
    expect(a.from).toBe(b.from);
  });
});
