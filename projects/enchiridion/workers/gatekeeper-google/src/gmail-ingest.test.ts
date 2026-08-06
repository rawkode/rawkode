import { describe, expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt/bundler";
import { PageContainer } from "@enchiridion/projection";
import { deriveEmailThreadPageId } from "@enchiridion/graph-core";
import { initializeSchema } from "./schema";
import { getSyncCursor } from "./token-store";
import { getGmailBackfillState } from "./gmail-backfill-store";
import { readGmailIngestFailures, BACKFILL_PAGE_TOKEN_RESET_MARKER } from "./gmail-ingest-failures-store";
import { runGmailIngest, BACKFILL_BATCH_SIZE, BACKFILL_QUERY } from "./gmail-ingest";
import type { GmailMessage, GmailThread } from "./gmail-api";
import { createFakeVaultEnv } from "./test-helpers/fake-vault-env";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

const SELF = "david@rawkode.academy";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string) => handler(new URL(input))) as unknown as typeof fetch;
}

function profileResponse(historyId = "1000"): Response {
  return new Response(JSON.stringify({ emailAddress: SELF, historyId, messagesTotal: 100, threadsTotal: 50 }), { status: 200 });
}

function threadsListResponse(threads: { id: string }[], nextPageToken?: string): Response {
  return new Response(JSON.stringify({ threads, nextPageToken, resultSizeEstimate: threads.length }), { status: 200 });
}

function message(overrides: Partial<GmailMessage> & { headers?: { name: string; value: string }[] } = {}): GmailMessage {
  const { headers, ...rest } = overrides;
  return {
    id: overrides.id ?? "m1",
    threadId: overrides.threadId ?? "t1",
    labelIds: ["INBOX"],
    snippet: "Hey there",
    internalDate: "1754470800000",
    payload: {
      headers: headers ?? [
        { name: "Subject", value: "Kickoff" },
        { name: "From", value: "Alex Guest <alex@example.com>" },
        { name: "To", value: SELF },
      ],
    },
    ...rest,
  };
}

function threadGetResponse(thread: GmailThread): Response {
  return new Response(JSON.stringify(thread), { status: 200 });
}

/** Routes a fake fetch across the four endpoints this worker calls,
 *  dispatching by pathname — used by every test below so each test only
 *  needs to describe WHAT each endpoint should return, not how routing
 *  works. */
function router(handlers: {
  profile?: (url: URL) => Response;
  threadsList?: (url: URL) => Response;
  threadsGet?: (url: URL, threadId: string) => Response;
  history?: (url: URL) => Response;
}): typeof fetch {
  return fakeFetch((url) => {
    if (url.pathname === "/gmail/v1/users/me/profile") {
      return (handlers.profile ?? (() => profileResponse()))(url);
    }
    if (url.pathname === "/gmail/v1/users/me/threads") {
      return (handlers.threadsList ?? (() => threadsListResponse([])))(url);
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/threads/")) {
      const threadId = decodeURIComponent(url.pathname.split("/").pop()!);
      return (handlers.threadsGet ?? (() => new Response("not found", { status: 404 })))(url, threadId);
    }
    if (url.pathname === "/gmail/v1/users/me/history") {
      return (handlers.history ?? (() => new Response(JSON.stringify({ history: [] }), { status: 200 })))(url);
    }
    throw new Error(`unexpected fetch: ${url.pathname}`);
  });
}

describe("runGmailIngest — backfill resumability across multiple simulated cron ticks", () => {
  test("BACKFILL_BATCH_SIZE is documented as 50 and BACKFILL_QUERY scopes to the last 12 months", () => {
    expect(BACKFILL_BATCH_SIZE).toBe(50);
    expect(BACKFILL_QUERY).toBe("newer_than:365d");
  });

  test("tick 1: fetches page 1 (bounded by BACKFILL_BATCH_SIZE), materializes each thread, persists the returned pageToken, does NOT complete", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    const threads: Record<string, GmailThread> = {
      t1: { id: "t1", snippet: "s1", messages: [message({ id: "m1", threadId: "t1" })] },
      t2: { id: "t2", snippet: "s2", messages: [message({ id: "m2", threadId: "t2" })] },
    };

    const captured: { maxResults: string | null; query: string | null } = { maxResults: null, query: null };
    const fetchImpl = router({
      threadsList: (url) => {
        captured.maxResults = url.searchParams.get("maxResults");
        captured.query = url.searchParams.get("q");
        return threadsListResponse([{ id: "t1" }, { id: "t2" }], "page-2-token");
      },
      threadsGet: (_url, threadId) => threadGetResponse(threads[threadId]!),
    });

    const result = await runGmailIngest({ sql, env: vault.env, accessToken: "tok", now: new Date("2026-08-06T09:00:00Z"), fetchImpl });

    expect(captured.maxResults).toBe("50");
    expect(captured.query).toBe("newer_than:365d");
    expect(result.mode).toBe("backfill");
    expect(result.backfillCompleted).toBe(false);
    expect(result.threadCount).toBe(2);

    const state = getGmailBackfillState(sql);
    expect(state?.pageToken).toBe("page-2-token");
    expect(state?.completed).toBe(false);

    // No historyId cursor yet — backfill hasn't completed.
    expect(getSyncCursor(sql, "gmail")).toBeUndefined();
  });

  test("tick 2: resumes from the persisted pageToken rather than restarting from page 1", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    const threads: Record<string, GmailThread> = {
      t1: { id: "t1", messages: [message({ id: "m1", threadId: "t1" })] },
      t2: { id: "t2", messages: [message({ id: "m2", threadId: "t2" })] },
      t3: { id: "t3", messages: [message({ id: "m3", threadId: "t3" })] },
    };

    // Tick 1.
    await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: router({
        threadsList: () => threadsListResponse([{ id: "t1" }], "page-2-token"),
        threadsGet: (_url, threadId) => threadGetResponse(threads[threadId]!),
      }),
    });

    // Tick 2 — asserts the pageToken sent is EXACTLY what tick 1 persisted.
    const captured: { pageToken: string | null } = { pageToken: null };
    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:05:00Z"),
      fetchImpl: router({
        threadsList: (url) => {
          captured.pageToken = url.searchParams.get("pageToken");
          return threadsListResponse([{ id: "t2" }, { id: "t3" }]); // no nextPageToken — this is the LAST page
        },
        threadsGet: (_url, threadId) => threadGetResponse(threads[threadId]!),
      }),
    });

    expect(captured.pageToken).toBe("page-2-token");
    expect(result.backfillCompleted).toBe(true);
    expect(getGmailBackfillState(sql)?.completed).toBe(true);
    // The final tick seeded the historyId baseline for incremental sync.
    expect(getSyncCursor(sql, "gmail")).toBe("1000");
  });

  test("once completed, a THIRD tick switches to incremental (history.list) mode, not another backfill page", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: router({
        threadsList: () => threadsListResponse([]), // empty + no nextPageToken: completes immediately
      }),
    });
    expect(getGmailBackfillState(sql)?.completed).toBe(true);

    let historyListCalled = false;
    let threadsListCalled = false;
    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:10:00Z"),
      fetchImpl: router({
        threadsList: () => {
          threadsListCalled = true;
          return threadsListResponse([]);
        },
        history: () => {
          historyListCalled = true;
          return new Response(JSON.stringify({ history: [], historyId: "1000" }), { status: 200 });
        },
      }),
    });

    expect(result.mode).toBe("incremental");
    expect(historyListCalled).toBe(true);
    expect(threadsListCalled).toBe(false);
  });
});

describe("runGmailIngest — backfill pageToken failure recovery (MAJOR fix: a stale/expired threads.list pageToken must not wedge backfill forever)", () => {
  test("a stale pageToken mid-backfill (simulated across 2+ ticks) resets gmail_backfill_state, retries page 1 WITHIN THE SAME cycle, records a distinguishable self-heal failure, and leaves state able to make real forward progress afterward", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    // Tick 1: an ordinary first backfill page — persists "page-2-token" as
    // the resume point, same as the plain resumability tests above.
    const t1: GmailThread = { id: "t1", messages: [message({ id: "m1", threadId: "t1" })] };
    await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-01T09:00:00Z"),
      fetchImpl: router({
        threadsList: () => threadsListResponse([{ id: "t1" }], "page-2-token"),
        threadsGet: () => threadGetResponse(t1),
      }),
    });
    expect(getGmailBackfillState(sql)?.pageToken).toBe("page-2-token");

    // Tick 2 (simulating a later cron tick, days into a multi-day
    // backfill): Google now rejects the previously-persisted pageToken
    // with a plain 400 (its real wire shape for an invalid/expired page
    // token — see `isInvalidPageTokenError`'s doc comment in
    // gmail-ingest.ts) — but a FRESH page 1 (no pageToken) succeeds.
    const t2: GmailThread = { id: "t2", messages: [message({ id: "m2", threadId: "t2" })] };
    const t3: GmailThread = { id: "t3", messages: [message({ id: "m3", threadId: "t3" })] };
    const pageTokensSeen: (string | null)[] = [];
    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-01T09:05:00Z"),
      fetchImpl: router({
        threadsList: (url) => {
          const pageToken = url.searchParams.get("pageToken");
          pageTokensSeen.push(pageToken);
          if (pageToken === "page-2-token") {
            return new Response(JSON.stringify({ error: { message: "Invalid page token" } }), { status: 400 });
          }
          // The retried page 1 — a real, successful batch (and the last
          // page: no nextPageToken).
          return threadsListResponse([{ id: "t2" }, { id: "t3" }]);
        },
        threadsGet: (_url, threadId) => threadGetResponse(threadId === "t2" ? t2 : t3),
      }),
    });

    // The dead token was tried exactly once, then discarded — the retry
    // used a genuinely fresh page 1, never the same dead token again (the
    // pre-fix bug: every subsequent tick re-read the IDENTICAL stale
    // token and failed identically, forever).
    expect(pageTokensSeen).toEqual(["page-2-token", null]);

    // Actual forward progress happened in THIS cycle, not just "didn't
    // crash": the retried page 1 batch was really fetched and
    // materialized.
    expect(result.backfillPageTokenReset).toBe(true);
    expect(result.mode).toBe("backfill");
    expect(result.threadCount).toBe(2);
    expect(result.materializedCount).toBe(2);
    expect(result.backfillCompleted).toBe(true);

    // gmail_backfill_state was genuinely reset (not left pointing at the
    // dead token) — and, since the retry's own page happened to be the
    // last page, it has already advanced to "completed" by the end of
    // this same cycle.
    const state = getGmailBackfillState(sql);
    expect(state?.completed).toBe(true);
    expect(state?.pageToken).toBeUndefined();

    // The self-heal is recorded and DISTINGUISHABLE from an ordinary
    // per-thread materialization failure (which always carries a real
    // Gmail thread id here, never this marker).
    const failures = readGmailIngestFailures(sql);
    const resetFailures = failures.filter((f) => f.threadId === BACKFILL_PAGE_TOKEN_RESET_MARKER);
    expect(resetFailures.length).toBe(1);
    expect(resetFailures[0]?.errorMessage).toContain("pageToken");
    // No ordinary per-thread failure was recorded — t2/t3 both succeeded.
    expect(failures.filter((f) => f.threadId === "t2" || f.threadId === "t3").length).toBe(0);

    // Forward progress is possible AFTERWARDS too, from the now-clean
    // state — the next tick switches straight to incremental sync, proof
    // this isn't merely "recovered once" but genuinely unstuck rather
    // than silently re-wedging.
    let historyListCalled = false;
    const nextTick = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-01T09:10:00Z"),
      fetchImpl: router({
        history: () => {
          historyListCalled = true;
          return new Response(JSON.stringify({ history: [], historyId: "9999" }), { status: 200 });
        },
      }),
    });
    expect(nextTick.mode).toBe("incremental");
    expect(historyListCalled).toBe(true);
  });

  test("a 400 on the very FIRST page (no stored pageToken to discard) is a different bug — it propagates normally instead of looping, and no self-heal failure is (mis)recorded", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    await expect(
      runGmailIngest({
        sql,
        env: vault.env,
        accessToken: "tok",
        now: new Date("2026-08-01T09:00:00Z"),
        fetchImpl: router({
          threadsList: () => new Response(JSON.stringify({ error: { message: "bad query syntax" } }), { status: 400 }),
        }),
      }),
    ).rejects.toThrow();

    // This is a real-bug case (e.g. malformed query), not a stale-token
    // case — nothing in gmail_backfill_state changes, and no self-heal
    // marker is recorded for it (that marker means "recovered", which
    // didn't happen here).
    expect(getGmailBackfillState(sql)).toBeUndefined();
    const failures = readGmailIngestFailures(sql);
    expect(failures.filter((f) => f.threadId === BACKFILL_PAGE_TOKEN_RESET_MARKER).length).toBe(0);
  });

  test("a 500 (transient server error) on a resumed page does NOT reset backfill state — the stored pageToken is still likely valid, so it propagates for the next tick to just retry the SAME token", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    const t1: GmailThread = { id: "t1", messages: [message({ id: "m1", threadId: "t1" })] };
    await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-01T09:00:00Z"),
      fetchImpl: router({
        threadsList: () => threadsListResponse([{ id: "t1" }], "page-2-token"),
        threadsGet: () => threadGetResponse(t1),
      }),
    });

    await expect(
      runGmailIngest({
        sql,
        env: vault.env,
        accessToken: "tok",
        now: new Date("2026-08-01T09:05:00Z"),
        fetchImpl: router({
          threadsList: () => new Response(JSON.stringify({ error: { message: "backend hiccup" } }), { status: 500 }),
        }),
      }),
    ).rejects.toThrow();

    // The stored pageToken is untouched — a transient 500 isn't a
    // "discard the token" signal, unlike a 400.
    expect(getGmailBackfillState(sql)?.pageToken).toBe("page-2-token");
    expect(getGmailBackfillState(sql)?.completed).toBe(false);
  });
});

describe("runGmailIngest — historyId incremental sync", () => {
  async function completeBackfill(sql: SqliteStorageAdapter, vault: ReturnType<typeof createFakeVaultEnv>): Promise<void> {
    await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: router({ threadsList: () => threadsListResponse([]) }),
    });
  }

  test("uses the persisted historyId as startHistoryId, discovers affected threads via messagesAdded, materializes them, and advances the cursor to the final page's historyId", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    await completeBackfill(sql, vault);
    expect(getSyncCursor(sql, "gmail")).toBe("1000");

    const captured: { startHistoryId: string | null } = { startHistoryId: null };
    const affectedThread: GmailThread = { id: "t42", messages: [message({ id: "m42", threadId: "t42" })] };

    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:10:00Z"),
      fetchImpl: router({
        history: (url) => {
          captured.startHistoryId = url.searchParams.get("startHistoryId");
          return new Response(
            JSON.stringify({
              history: [{ id: "1001", messagesAdded: [{ message: { id: "m42", threadId: "t42" } }] }],
              historyId: "1050",
            }),
            { status: 200 },
          );
        },
        threadsGet: () => threadGetResponse(affectedThread),
      }),
    });

    expect(captured.startHistoryId).toBe("1000");
    expect(result.mode).toBe("incremental");
    expect(result.threadCount).toBe(1);
    expect(result.materializedCount).toBe(1);
    expect(getSyncCursor(sql, "gmail")).toBe("1050");

    const threadPush = vault.createOrUpdateCalls.find((c) => c.docType === "emailThread");
    expect(threadPush).toBeDefined();
  });

  test("multiple history pages: threadIds are deduped, and the cursor advances to the LAST page's historyId only after the whole batch is attempted", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    await completeBackfill(sql, vault);

    const thread: GmailThread = { id: "t1", messages: [message({ id: "m1", threadId: "t1" })] };
    let calls = 0;
    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:10:00Z"),
      fetchImpl: router({
        history: () => {
          calls += 1;
          if (calls === 1) {
            return new Response(
              JSON.stringify({
                history: [
                  { id: "1001", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] },
                  { id: "1002", messagesAdded: [{ message: { id: "m1b", threadId: "t1" } }] }, // same thread again
                ],
                nextPageToken: "hp-2",
              }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ history: [], historyId: "2000" }), { status: 200 });
        },
        threadsGet: () => threadGetResponse(thread),
      }),
    });

    expect(calls).toBe(2);
    expect(result.threadCount).toBe(1); // deduped: only ONE distinct threadId
    expect(getSyncCursor(sql, "gmail")).toBe("2000");
  });
});

describe("runGmailIngest — 404 (expired historyId) triggers a fresh-backfill fallback", () => {
  test("a 404 from history.list resets backfill state and runs one backfill batch WITHIN THE SAME cycle, flagging historyIdExpired", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: router({ threadsList: () => threadsListResponse([]) }),
    });
    expect(getGmailBackfillState(sql)?.completed).toBe(true);

    let threadsListCalled = false;
    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:10:00Z"),
      fetchImpl: router({
        history: () => new Response(JSON.stringify({ error: { message: "startHistoryId too old" } }), { status: 404 }),
        threadsList: () => {
          threadsListCalled = true;
          return threadsListResponse([]); // the re-baseline backfill batch itself, run in THIS same call
        },
      }),
    });

    expect(result.mode).toBe("backfill");
    expect(result.historyIdExpired).toBe(true);
    expect(threadsListCalled).toBe(true); // proves the fallback ran within this SAME cycle, not deferred
    // Since the fallback batch's threads.list itself returned no
    // nextPageToken, it re-completes backfill and re-seeds a fresh
    // historyId in the SAME call.
    expect(getGmailBackfillState(sql)?.completed).toBe(true);
  });
});

describe("runGmailIngest — per-thread failure isolation (poison-pill)", () => {
  test("one thread's threads.get call failing does not abort the rest of the backfill batch", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    const threads: Record<string, GmailThread> = {
      t1: { id: "t1", messages: [message({ id: "m1", threadId: "t1" })] },
      t3: { id: "t3", messages: [message({ id: "m3", threadId: "t3" })] },
    };

    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: router({
        threadsList: () => threadsListResponse([{ id: "t1" }, { id: "t2" }, { id: "t3" }]),
        threadsGet: (_url, threadId) => {
          if (threadId === "t2") return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
          return threadGetResponse(threads[threadId]!);
        },
      }),
    });

    expect(result.materializedCount).toBe(2); // t1 and t3
    expect(result.failedCount).toBe(1); // t2
    const failures = readGmailIngestFailures(sql);
    expect(failures.length).toBe(1);
    expect(failures[0]?.threadId).toBe("t2");
    // Backfill still completes (no nextPageToken) — one bad thread didn't
    // block the cursor from advancing for the threads that DID succeed.
    expect(result.backfillCompleted).toBe(true);
    expect(getGmailBackfillState(sql)?.completed).toBe(true);
  });

  test("one thread's MATERIALIZATION (VaultDO push) throwing mid-batch does not abort the rest, and the cursor still advances after the whole batch", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv({ failEmailThreadPushIndex: 2 });
    const threads: Record<string, GmailThread> = {
      t1: { id: "t1", messages: [message({ id: "m1", threadId: "t1", headers: [{ name: "Subject", value: "One" }] })] },
      t2: { id: "t2", messages: [message({ id: "m2", threadId: "t2", headers: [{ name: "Subject", value: "Two" }] })] },
      t3: { id: "t3", messages: [message({ id: "m3", threadId: "t3", headers: [{ name: "Subject", value: "Three" }] })] },
    };

    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: router({
        threadsList: () => threadsListResponse([{ id: "t1" }, { id: "t2" }, { id: "t3" }]),
        threadsGet: (_url, threadId) => threadGetResponse(threads[threadId]!),
      }),
    });

    expect(result.materializedCount).toBe(2); // t1 and t3 — t2's push threw
    expect(result.failedCount).toBe(1);
    const failures = readGmailIngestFailures(sql);
    expect(failures.length).toBe(1);
    expect(failures[0]?.threadId).toBe("t2");
    expect(failures[0]?.errorMessage).toContain("simulated VaultDO failure");
    // The cursor (completed flag) still advances — the failure of ONE
    // thread's push must not block the cursor for everything that DID
    // succeed.
    expect(result.backfillCompleted).toBe(true);
  });
});

describe("runGmailIngest — the participant quality gate", () => {
  test("a correspondent with genuine back-and-forth (the user has sent TO them) gets a Person page and a from/to edge", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    // Thread 1: the user SENDS to friend@example.com (SENT label) — this
    // is what makes them qualify.
    const sentThread: GmailThread = {
      id: "t-sent",
      messages: [
        message({
          id: "m-sent",
          threadId: "t-sent",
          labelIds: ["SENT"],
          headers: [
            { name: "Subject", value: "Let's sync" },
            { name: "From", value: SELF },
            { name: "To", value: "Friend Person <friend@example.com>" },
          ],
        }),
      ],
    };
    // Thread 2: friend@example.com writes back — a normal received thread
    // whose "from" edge should now include a Person page since they
    // qualify (from thread 1's ledger update, applied within the SAME
    // batch thanks to the two-pass design).
    const replyThread: GmailThread = {
      id: "t-reply",
      messages: [
        message({
          id: "m-reply",
          threadId: "t-reply",
          labelIds: ["INBOX"],
          headers: [
            { name: "Subject", value: "Re: Let's sync" },
            { name: "From", value: "Friend Person <friend@example.com>" },
            { name: "To", value: SELF },
          ],
        }),
      ],
    };

    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: router({
        threadsList: () => threadsListResponse([{ id: "t-sent" }, { id: "t-reply" }]),
        threadsGet: (_url, threadId) => threadGetResponse(threadId === "t-sent" ? sentThread : replyThread),
      }),
    });

    expect(result.materializedCount).toBe(2);
    const personPushes = vault.createOrUpdateCalls.filter((c) => c.docType === "person");
    expect(personPushes.length).toBe(1); // friend@example.com's Person page
  });

  test("a one-way newsletter sender (the user never sends TO them) does NOT get a Person page", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    const newsletterThread: GmailThread = {
      id: "t-news",
      messages: [
        message({
          id: "m-news",
          threadId: "t-news",
          labelIds: ["INBOX"],
          headers: [
            { name: "Subject", value: "Weekly digest" },
            { name: "From", value: "Newsletter <noreply@newsletter.example.com>" },
            { name: "To", value: SELF },
          ],
        }),
      ],
    };

    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: router({
        threadsList: () => threadsListResponse([{ id: "t-news" }]),
        threadsGet: () => threadGetResponse(newsletterThread),
      }),
    });

    expect(result.materializedCount).toBe(1); // the thread itself IS materialized
    const personPushes = vault.createOrUpdateCalls.filter((c) => c.docType === "person");
    expect(personPushes.length).toBe(0); // but no Person page for the newsletter sender

    const threadPush = vault.createOrUpdateCalls.find((c) => c.docType === "emailThread")!;
    // Import & inspect: no "from" edge to any Person page either.
    const doc = new LoroDoc();
    const binary = atob(threadPush.updateBytesBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    doc.import(bytes);
    const edges = doc.getMap(PageContainer.edges).getShallowValue();
    expect(Object.keys(edges).length).toBe(0);
  });
});

describe("runGmailIngest — the participant quality gate is order-independent within a batch (adversarial order)", () => {
  test("ADVERSARIAL ORDER — threads.list returns the thread that BENEFITS from a participant's qualification (t-reply) BEFORE the thread that CAUSES it (t-sent): the reply thread's participant edge still gets created correctly, because Pass 2 never starts until the WHOLE batch's Pass 1 has completed. This should currently PASS against the existing correct two-pass implementation — its value is guarding against a future refactor silently reintroducing order-dependence, not fixing a live bug (the easy 'qualifying thread first' direction is covered by the test above; this is the harder direction that was NOT previously tested).", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();

    // Thread that CAUSES the qualification: the user SENDS to
    // friend@example.com (SENT label).
    const sentThread: GmailThread = {
      id: "t-sent",
      messages: [
        message({
          id: "m-sent",
          threadId: "t-sent",
          labelIds: ["SENT"],
          headers: [
            { name: "Subject", value: "Let's sync" },
            { name: "From", value: SELF },
            { name: "To", value: "Friend Person <friend@example.com>" },
          ],
        }),
      ],
    };
    // Thread that BENEFITS from the qualification: friend@example.com's
    // reply — its "from" edge should still resolve to a Person page even
    // though `threadsList` (below) hands this thread to `processBatch`
    // BEFORE the thread that makes friend@example.com qualify.
    const replyThread: GmailThread = {
      id: "t-reply",
      messages: [
        message({
          id: "m-reply",
          threadId: "t-reply",
          labelIds: ["INBOX"],
          headers: [
            { name: "Subject", value: "Re: Let's sync" },
            { name: "From", value: "Friend Person <friend@example.com>" },
            { name: "To", value: SELF },
          ],
        }),
      ],
    };

    const result = await runGmailIngest({
      sql,
      env: vault.env,
      accessToken: "tok",
      now: new Date("2026-08-06T09:00:00Z"),
      fetchImpl: router({
        // The adversarial order itself: t-reply (benefits) BEFORE t-sent
        // (qualifies) — the opposite of the existing regression-guard
        // test's `[{id: "t-sent"}, {id: "t-reply"}]` ordering.
        threadsList: () => threadsListResponse([{ id: "t-reply" }, { id: "t-sent" }]),
        threadsGet: (_url, threadId) => threadGetResponse(threadId === "t-sent" ? sentThread : replyThread),
      }),
    });

    expect(result.materializedCount).toBe(2);
    const personPushes = vault.createOrUpdateCalls.filter((c) => c.docType === "person");
    expect(personPushes.length).toBe(1); // friend@example.com still qualifies, order notwithstanding

    // Not just "a Person page exists somewhere" — specifically the REPLY
    // thread's own page must carry the edge, since that's the thread whose
    // qualification depended on a batch-sibling processed later in
    // Pass 1's iteration order.
    const replyPageID = await deriveEmailThreadPageId("t-reply");
    const replyThreadPush = vault.createOrUpdateCalls.find((c) => c.docType === "emailThread" && c.pageID === replyPageID);
    expect(replyThreadPush).toBeDefined();

    const doc = new LoroDoc();
    const binary = atob(replyThreadPush!.updateBytesBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    doc.import(bytes);
    const edges = doc.getMap(PageContainer.edges).getShallowValue();
    expect(Object.keys(edges).length).toBeGreaterThan(0); // the "from" edge to friend@example.com's Person page
  });
});
