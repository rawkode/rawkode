import { describe, expect, test } from "bun:test";
import { GMAIL_SCOPE_NOT_GRANTED_MESSAGE } from "@enchiridion/gatekeeper-google-rpc-contract";
import type { EmailMessageDTO } from "@enchiridion/gatekeeper-google-rpc-contract";
import { gmailNotFoundResponse, getMessagesForThreads, searchEmailMessages, type GmailRpcStub } from "./gmail-read-model";

function fakeStub(overrides: Partial<GmailRpcStub> & { scopeGranted?: boolean } = {}): GmailRpcStub {
  const scopeGranted = overrides.scopeGranted ?? true;
  return {
    hasScope: overrides.hasScope ?? (async () => scopeGranted),
    getMessagesForThreads: overrides.getMessagesForThreads ?? (async () => ({})),
    searchEmailMessages: overrides.searchEmailMessages ?? (async () => []),
  };
}

const SAMPLE_MESSAGE: EmailMessageDTO = {
  id: "m1",
  threadPageID: "email_thread_aaa",
  subject: "Kickoff",
  bodyText: "Hey there",
  receivedAt: 1754470800000,
  attachments: [],
};

describe("getMessagesForThreads", () => {
  test("rejects with GMAIL_SCOPE_NOT_GRANTED_MESSAGE when the scope isn't granted, and never calls the DO", async () => {
    let called = false;
    const stub = fakeStub({
      scopeGranted: false,
      getMessagesForThreads: async () => {
        called = true;
        return {};
      },
    });
    await expect(getMessagesForThreads(stub, ["email_thread_aaa"])).rejects.toThrow(GMAIL_SCOPE_NOT_GRANTED_MESSAGE);
    expect(called).toBe(false);
  });

  test("resolves with the batched threads record on success", async () => {
    const stub = fakeStub({
      getMessagesForThreads: async (pageIDs) => {
        expect(pageIDs).toEqual(["email_thread_aaa"]);
        return { email_thread_aaa: [SAMPLE_MESSAGE] };
      },
    });
    const result = await getMessagesForThreads(stub, ["email_thread_aaa"]);
    expect(result).toEqual({ email_thread_aaa: [SAMPLE_MESSAGE] });
  });

  test("rejects when threadPageIDs is not an array", async () => {
    const stub = fakeStub();
    // @ts-expect-error — deliberately passing a non-array to prove the runtime guard.
    await expect(getMessagesForThreads(stub, "not-an-array")).rejects.toThrow(TypeError);
  });
});

describe("searchEmailMessages", () => {
  test("rejects with GMAIL_SCOPE_NOT_GRANTED_MESSAGE when the scope isn't granted", async () => {
    const stub = fakeStub({ scopeGranted: false });
    await expect(searchEmailMessages(stub, "budget")).rejects.toThrow(GMAIL_SCOPE_NOT_GRANTED_MESSAGE);
  });

  test("rejects when query is empty", async () => {
    const stub = fakeStub();
    await expect(searchEmailMessages(stub, "")).rejects.toThrow(TypeError);
    await expect(searchEmailMessages(stub, "   ")).rejects.toThrow(TypeError);
  });

  test("resolves with search results, passing DEFAULT_EMAIL_SEARCH_LIMIT when limit is omitted", async () => {
    let receivedLimit: number | undefined;
    const stub = fakeStub({
      searchEmailMessages: async (query, limit) => {
        expect(query).toBe("budget");
        receivedLimit = limit;
        return [SAMPLE_MESSAGE];
      },
    });
    const result = await searchEmailMessages(stub, "budget");
    expect(receivedLimit).toBe(25);
    expect(result).toEqual([SAMPLE_MESSAGE]);
  });

  test("clamps an oversized limit to MAX_EMAIL_SEARCH_LIMIT", async () => {
    let receivedLimit: number | undefined;
    const stub = fakeStub({
      searchEmailMessages: async (_query, limit) => {
        receivedLimit = limit;
        return [];
      },
    });
    await searchEmailMessages(stub, "x", 99999);
    expect(receivedLimit).toBe(100);
  });

  test("ignores a non-finite/zero/negative limit, falling back to the default", async () => {
    let receivedLimit: number | undefined;
    const stub = fakeStub({
      searchEmailMessages: async (_query, limit) => {
        receivedLimit = limit;
        return [];
      },
    });
    await searchEmailMessages(stub, "x", Number.NaN);
    expect(receivedLimit).toBe(25);
    await searchEmailMessages(stub, "x", 0);
    expect(receivedLimit).toBe(25);
    await searchEmailMessages(stub, "x", -5);
    expect(receivedLimit).toBe(25);
  });
});

// ---------------------------------------------------------------------
// Proof that the BLOCKER is actually closed: no `fetch()`-routed path to
// Gmail data survives this fix. `./index.ts` itself can't be imported by
// `bun test` (it pulls in `cloudflare:workers` — see this file's own
// module header and `oauth-http.ts`'s file header for the established
// reason), so this exercises the exact pure pathname-matching logic
// `index.ts`'s `fetch()` handler delegates to, plus confirms the two
// real data-access functions above have no `Request`/`Response`-shaped
// call surface at all (every test above calls them with plain values).
// ---------------------------------------------------------------------
describe("gmailNotFoundResponse — no HTTP route surface for Gmail reads (adversarial-review BLOCKER fix)", () => {
  test("POST /gmail/messages 404s — the route this BLOCKER was filed against no longer exists", () => {
    const response = gmailNotFoundResponse("/gmail/messages");
    expect(response?.status).toBe(404);
  });

  test("GET /gmail/search 404s — the other route this BLOCKER was filed against no longer exists", () => {
    const response = gmailNotFoundResponse("/gmail/search");
    expect(response?.status).toBe(404);
  });

  test("any other /gmail/* path also 404s (e.g. a guess at some other Gmail route)", () => {
    expect(gmailNotFoundResponse("/gmail/send")?.status).toBe(404);
    expect(gmailNotFoundResponse("/gmail/")?.status).toBe(404);
  });

  test("a non-/gmail/ path is left alone (undefined) — this function only ever narrows Gmail's own surface to 404", () => {
    expect(gmailNotFoundResponse("/oauth/google/authorize")).toBeUndefined();
    expect(gmailNotFoundResponse("/calendar/foo")).toBeUndefined();
  });
});
