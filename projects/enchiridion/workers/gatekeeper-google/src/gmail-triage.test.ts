import { describe, expect, test } from "bun:test";
import { GmailApiError } from "./gmail-api";
import {
  applyGmailLabel,
  archiveGmailThread,
  markGmailThreadRead,
  markGmailThreadUnread,
  removeGmailLabel,
} from "./gmail-triage";

function fakeFetch(handler: (url: URL, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string, init?: RequestInit) => handler(new URL(input), init)) as unknown as typeof fetch;
}

describe("archiveGmailThread — removeLabelIds: [\"INBOX\"]", () => {
  test("POSTs to threads/{id}/modify with exactly removeLabelIds: [\"INBOX\"]", async () => {
    let seenUrl: URL | undefined;
    let seenInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify({ id: "18abc0001", labelIds: [] }), { status: 200 });
    });

    const result = await archiveGmailThread("access-token-1", { threadPageID: "email_thread_aaa", threadId: "18abc0001" }, fetchImpl);

    expect(result.id).toBe("18abc0001");
    expect(seenUrl?.pathname).toBe("/gmail/v1/users/me/threads/18abc0001/modify");
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(seenInit!.body as string)).toEqual({ removeLabelIds: ["INBOX"] });
  });

  test("a missing resolved threadId throws (defense-in-depth — this file must never trust an unresolved payload)", async () => {
    let fetchCalled = false;
    const fetchImpl = fakeFetch(() => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    await expect(archiveGmailThread("tok", { threadPageID: "email_thread_aaa" }, fetchImpl)).rejects.toThrow(/missing resolved Gmail threadId/);
    expect(fetchCalled).toBe(false);
  });

  test("a non-2xx response throws GmailApiError, not a crash", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), { status: 403 }));
    const rejection = archiveGmailThread("tok", { threadPageID: "email_thread_aaa", threadId: "18abc0001" }, fetchImpl);
    await expect(rejection).rejects.toBeInstanceOf(GmailApiError);
    try {
      await rejection;
    } catch (error) {
      expect((error as GmailApiError).status).toBe(403);
    }
  });
});

describe("markGmailThreadRead / markGmailThreadUnread — the UNREAD label toggle", () => {
  test("markGmailThreadRead sends exactly removeLabelIds: [\"UNREAD\"]", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });
    await markGmailThreadRead("tok", { threadPageID: "email_thread_aaa", threadId: "18abc0001" }, fetchImpl);
    expect(JSON.parse(seenInit!.body as string)).toEqual({ removeLabelIds: ["UNREAD"] });
  });

  test("markGmailThreadUnread sends exactly addLabelIds: [\"UNREAD\"]", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });
    await markGmailThreadUnread("tok", { threadPageID: "email_thread_aaa", threadId: "18abc0001" }, fetchImpl);
    expect(JSON.parse(seenInit!.body as string)).toEqual({ addLabelIds: ["UNREAD"] });
  });
});

describe("applyGmailLabel / removeGmailLabel — opaque Gmail label id add/remove", () => {
  test("applyGmailLabel sends exactly addLabelIds: [label]", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });
    await applyGmailLabel("tok", { threadPageID: "email_thread_aaa", threadId: "18abc0001", label: "Label_1" }, fetchImpl);
    expect(JSON.parse(seenInit!.body as string)).toEqual({ addLabelIds: ["Label_1"] });
  });

  test("removeGmailLabel sends exactly removeLabelIds: [label]", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    });
    await removeGmailLabel("tok", { threadPageID: "email_thread_aaa", threadId: "18abc0001", label: "IMPORTANT" }, fetchImpl);
    expect(JSON.parse(seenInit!.body as string)).toEqual({ removeLabelIds: ["IMPORTANT"] });
  });

  test("a missing resolved threadId throws for applyGmailLabel/removeGmailLabel too — the check is shared, not archive-specific", async () => {
    const fetchImpl = fakeFetch(() => new Response("{}", { status: 200 }));
    await expect(applyGmailLabel("tok", { threadPageID: "p", label: "IMPORTANT" }, fetchImpl)).rejects.toThrow(/missing resolved Gmail threadId/);
    await expect(removeGmailLabel("tok", { threadPageID: "p", label: "IMPORTANT" }, fetchImpl)).rejects.toThrow(/missing resolved Gmail threadId/);
  });
});
