import { describe, expect, test } from "bun:test";
import {
  getThread,
  getUserProfile,
  listHistoryPage,
  listThreadsPage,
  modifyThreadLabels,
  GmailApiError,
  GmailHistoryIdExpiredError,
} from "./gmail-api";

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string) => handler(new URL(input))) as unknown as typeof fetch;
}

describe("listThreadsPage", () => {
  test("sends q/pageToken/maxResults and parses a real-shaped response", async () => {
    let sawUrl: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      sawUrl = url;
      return new Response(
        JSON.stringify({
          threads: [
            { id: "18abc0001", snippet: "Hey, following up on...", historyId: "1001" },
            { id: "18abc0002", snippet: "Thanks for the update", historyId: "1002" },
          ],
          nextPageToken: "page-2",
          resultSizeEstimate: 2,
        }),
        { status: 200 },
      );
    });

    const result = await listThreadsPage({ accessToken: "tok", q: "newer_than:365d", maxResults: 50, fetchImpl });

    expect(sawUrl?.pathname).toBe("/gmail/v1/users/me/threads");
    expect(sawUrl?.searchParams.get("q")).toBe("newer_than:365d");
    expect(sawUrl?.searchParams.get("maxResults")).toBe("50");
    expect(result.threads?.length).toBe(2);
    expect(result.nextPageToken).toBe("page-2");
  });

  test("a non-ok response throws GmailApiError with the status and Google's error detail", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 }),
    );
    await expect(listThreadsPage({ accessToken: "bad", fetchImpl })).rejects.toThrow(GmailApiError);
    await expect(listThreadsPage({ accessToken: "bad", fetchImpl })).rejects.toThrow(/Invalid Credentials/);
  });
});

describe("getThread", () => {
  test("requests format=metadata with the Subject/From/To/Cc header allowlist", async () => {
    let sawUrl: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      sawUrl = url;
      return new Response(
        JSON.stringify({
          id: "18abc0001",
          historyId: "1001",
          snippet: "Hey, following up on...",
          messages: [
            {
              id: "18abc0001",
              threadId: "18abc0001",
              labelIds: ["INBOX", "IMPORTANT"],
              snippet: "Hey, following up on...",
              internalDate: "1754470800000",
              payload: {
                headers: [
                  { name: "Subject", value: "Re: Project kickoff" },
                  { name: "From", value: "Alex Guest <alex@example.com>" },
                  { name: "To", value: "David Flanagan <david@rawkode.academy>" },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const thread = await getThread({ accessToken: "tok", threadId: "18abc0001", fetchImpl });

    expect(sawUrl?.pathname).toBe("/gmail/v1/users/me/threads/18abc0001");
    expect(sawUrl?.searchParams.get("format")).toBe("metadata");
    expect(sawUrl?.searchParams.getAll("metadataHeaders")).toEqual(["Subject", "From", "To", "Cc"]);
    expect(thread.messages?.length).toBe(1);
    expect(thread.messages?.[0]?.payload?.headers?.[0]).toEqual({ name: "Subject", value: "Re: Project kickoff" });
  });

  test("URL-encodes the thread id", async () => {
    let sawUrl: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      sawUrl = url;
      return new Response(JSON.stringify({ id: "a/b", messages: [] }), { status: 200 });
    });
    await getThread({ accessToken: "tok", threadId: "a/b", fetchImpl });
    expect(sawUrl?.pathname).toBe("/gmail/v1/users/me/threads/a%2Fb");
  });
});

describe("listHistoryPage", () => {
  test("sends startHistoryId + historyTypes=messageAdded and parses a real-shaped response", async () => {
    let sawUrl: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      sawUrl = url;
      return new Response(
        JSON.stringify({
          history: [
            {
              id: "1050",
              messagesAdded: [{ message: { id: "18abc0003", threadId: "18abc0001", labelIds: ["INBOX"] } }],
            },
          ],
          historyId: "1050",
        }),
        { status: 200 },
      );
    });

    const result = await listHistoryPage({ accessToken: "tok", startHistoryId: "1001", fetchImpl });

    expect(sawUrl?.pathname).toBe("/gmail/v1/users/me/history");
    expect(sawUrl?.searchParams.get("startHistoryId")).toBe("1001");
    expect(sawUrl?.searchParams.get("historyTypes")).toBe("messageAdded");
    expect(result.history?.[0]?.messagesAdded?.[0]?.message.threadId).toBe("18abc0001");
    expect(result.historyId).toBe("1050");
  });

  test("a 404 throws GmailHistoryIdExpiredError, not a generic GmailApiError", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: "Invalid startHistoryId" } }), { status: 404 }),
    );
    await expect(listHistoryPage({ accessToken: "tok", startHistoryId: "too-old", fetchImpl })).rejects.toThrow(
      GmailHistoryIdExpiredError,
    );
  });

  test("a non-404 non-ok response still throws the generic GmailApiError", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }));
    await expect(listHistoryPage({ accessToken: "tok", startHistoryId: "1001", fetchImpl })).rejects.toThrow(
      GmailApiError,
    );
  });
});

describe("modifyThreadLabels — the real threads.modify MUTATION call", () => {
  test("POSTs to threads/{id}/modify with addLabelIds/removeLabelIds and returns the updated thread", async () => {
    let sawUrl: URL | undefined;
    let sawInit: RequestInit | undefined;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      sawUrl = new URL(input);
      sawInit = init;
      return new Response(JSON.stringify({ id: "18abc0001", historyId: "1050", snippet: "Hey, following up on..." }), { status: 200 });
    }) as unknown as typeof fetch;

    const thread = await modifyThreadLabels({
      accessToken: "tok",
      threadId: "18abc0001",
      addLabelIds: ["IMPORTANT"],
      removeLabelIds: ["INBOX", "UNREAD"],
      fetchImpl,
    });

    expect(sawUrl?.pathname).toBe("/gmail/v1/users/me/threads/18abc0001/modify");
    expect(sawInit?.method).toBe("POST");
    expect((sawInit?.headers as Record<string, string>)?.authorization).toBe("Bearer tok");
    expect((sawInit?.headers as Record<string, string>)?.["content-type"]).toBe("application/json");
    const sentBody = JSON.parse(sawInit!.body as string);
    expect(sentBody).toEqual({ addLabelIds: ["IMPORTANT"], removeLabelIds: ["INBOX", "UNREAD"] });
    expect(thread.id).toBe("18abc0001");
    expect(thread.historyId).toBe("1050");
  });

  test("omitting addLabelIds/removeLabelIds sends them as undefined (JSON drops them), not empty arrays", async () => {
    let sawInit: RequestInit | undefined;
    const fetchImpl = (async (_input: string, init?: RequestInit) => {
      sawInit = init;
      return new Response(JSON.stringify({ id: "18abc0001" }), { status: 200 });
    }) as unknown as typeof fetch;

    await modifyThreadLabels({ accessToken: "tok", threadId: "18abc0001", removeLabelIds: ["INBOX"], fetchImpl });

    const sentBody = JSON.parse(sawInit!.body as string);
    expect(sentBody).toEqual({ removeLabelIds: ["INBOX"] });
    expect("addLabelIds" in sentBody).toBe(false);
  });

  test("URL-encodes the thread id", async () => {
    let sawUrl: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      sawUrl = url;
      return new Response(JSON.stringify({ id: "a/b" }), { status: 200 });
    });
    await modifyThreadLabels({ accessToken: "tok", threadId: "a/b", removeLabelIds: ["INBOX"], fetchImpl });
    expect(sawUrl?.pathname).toBe("/gmail/v1/users/me/threads/a%2Fb/modify");
  });

  test("a non-ok response throws GmailApiError with the status and Google's error detail", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), { status: 404 }),
    );
    const rejection = modifyThreadLabels({ accessToken: "tok", threadId: "missing", removeLabelIds: ["INBOX"], fetchImpl });
    await expect(rejection).rejects.toBeInstanceOf(GmailApiError);
    await expect(rejection).rejects.toThrow(/threads\.modify failed/);
    await expect(rejection).rejects.toThrow(/Requested entity was not found/);
    try {
      await rejection;
    } catch (error) {
      expect((error as GmailApiError).status).toBe(404);
    }
  });
});

describe("getUserProfile", () => {
  test("parses a real-shaped users.getProfile response", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ emailAddress: "david@rawkode.academy", messagesTotal: 4213, threadsTotal: 1876, historyId: "1050" }),
          { status: 200 },
        ),
    );
    const profile = await getUserProfile({ accessToken: "tok", fetchImpl });
    expect(profile.emailAddress).toBe("david@rawkode.academy");
    expect(profile.historyId).toBe("1050");
  });
});
