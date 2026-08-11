import { describe, expect, test } from "bun:test";
import { initializeSchema } from "./schema";
import { storeInitialTokens } from "./token-store";
import { getSyncCursor } from "./token-store";
import { createCalendarIngestCycleRunner } from "./calendar-ingest-cycle";
import type { GoogleOAuthConfig } from "./oauth-client";
import type { GoogleCalendarEvent, GoogleCalendarEventsListResponse } from "./calendar-api";
import { createFakeVaultEnv } from "./test-helpers/fake-vault-env";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

const CONFIG: GoogleOAuthConfig = { clientId: "id", clientSecret: "secret", redirectUri: "https://gatekeeper.example/callback" };

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string) => handler(new URL(input))) as unknown as typeof fetch;
}

function page(items: GoogleCalendarEvent[], nextSyncToken?: string): GoogleCalendarEventsListResponse {
  return {
    kind: "calendar#events",
    etag: '"etag"',
    summary: "david@rawkode.academy",
    updated: "2026-08-06T09:00:00.000Z",
    timeZone: "Europe/London",
    accessRole: "owner",
    nextSyncToken,
    items,
  };
}

function standupEvent(): GoogleCalendarEvent {
  return {
    kind: "calendar#event",
    etag: '"e1"',
    id: "standup-1",
    status: "confirmed",
    summary: "Daily standup",
    iCalUID: "standup-1@google.com",
    start: { dateTime: "2026-08-10T09:00:00+01:00", timeZone: "Europe/London" },
    end: { dateTime: "2026-08-10T09:15:00+01:00", timeZone: "Europe/London" },
  };
}

const TEST_NOW = new Date("2026-08-06T09:00:00Z");

/** Stores a token whose expiry is computed relative to `nowMs` — MUST be
 *  the same clock value the runner's `now` will report (both
 *  `resolveValidAccessToken`'s freshness check and `runCalendarIngest`'s
 *  own `now` come from the ONE `deps.now()` call inside
 *  `calendar-ingest-cycle.ts`, see that file's "ONE `now` for the whole
 *  cycle attempt" comment) — otherwise the token looks expired relative
 *  to the runner's clock and these tests would exercise a REAL token
 *  refresh (hitting `oauth-client.ts`'s `requestToken`) instead of the
 *  reentrancy guard this file is actually testing. */
function withValidStoredToken(sql: SqliteStorageAdapter, nowMs: number): void {
  storeInitialTokens(sql, { accessToken: "valid-access-token", refreshToken: "rt-1", expiresIn: 3600 }, nowMs);
}

describe("createCalendarIngestCycleRunner — reentrancy guard", () => {
  test("TWO CONCURRENT CALLS: the second is cleanly skipped ('ingest already in progress'), not racing on the sync cursor", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime());
    const vault = createFakeVaultEnv();

    let fetchCalls = 0;
    const runner = createCalendarIngestCycleRunner({
      sql,
      env: vault.env,
      loadConfig: () => CONFIG,
      now: () => TEST_NOW,
      fetchImpl: fakeFetch(() => {
        fetchCalls += 1;
        return new Response(JSON.stringify(page([standupEvent()], "sync-token-v1")), { status: 200 });
      }),
    });

    const [first, second] = await Promise.all([runner(), runner()]);

    const results = [first, second];
    const skipped = results.filter((r): r is { skipped: true; reason: string } => "skipped" in r && r.skipped === true);
    const completed = results.filter((r) => !("skipped" in r));

    // Exactly one call ran the real cycle; the other was skipped by the
    // guard, not raced against it.
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.reason).toBe("ingest already in progress");
    expect(completed.length).toBe(1);

    // The skipped call never touched the Calendar API at all — proof it
    // didn't race the winner for the syncToken read/write, it just bailed
    // out before doing any work.
    expect(fetchCalls).toBe(1);
    expect(getSyncCursor(sql, "calendar")).toBe("sync-token-v1");
  });

  test("REGRESSION GUARD: without the guard, both calls would have fetched independently — asserting fetchCalls === 1 (not 2) is what the fix guarantees", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime());
    const vault = createFakeVaultEnv();

    let fetchCalls = 0;
    const runner = createCalendarIngestCycleRunner({
      sql,
      env: vault.env,
      loadConfig: () => CONFIG,
      now: () => TEST_NOW,
      fetchImpl: fakeFetch(() => {
        fetchCalls += 1;
        return new Response(JSON.stringify(page([], `token-${fetchCalls}`)), { status: 200 });
      }),
    });

    await Promise.all([runner(), runner(), runner()]);
    // Three concurrent firings, exactly one real cycle ran.
    expect(fetchCalls).toBe(1);
  });

  test("after the in-progress call finishes, a later call is NOT permanently blocked (the flag is cleared in a finally)", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime());
    const vault = createFakeVaultEnv();

    let fetchCalls = 0;
    const runner = createCalendarIngestCycleRunner({
      sql,
      env: vault.env,
      loadConfig: () => CONFIG,
      now: () => TEST_NOW,
      fetchImpl: fakeFetch(() => {
        fetchCalls += 1;
        return new Response(JSON.stringify(page([], `token-${fetchCalls}`)), { status: 200 });
      }),
    });

    const first = await runner();
    expect("skipped" in first).toBe(false);

    const second = await runner();
    expect("skipped" in second).toBe(false); // NOT stuck skipped forever
    expect(fetchCalls).toBe(2);
  });

  test("not-connected (no stored tokens) still returns a clean {skipped} rather than throwing, exactly like before the fix", async () => {
    const sql = makeSql(); // no stored tokens
    const vault = createFakeVaultEnv();
    const runner = createCalendarIngestCycleRunner({ sql, env: vault.env, loadConfig: () => CONFIG });

    const result = await runner();
    expect(result).toMatchObject({ skipped: true });
  });

  // ── Effect migration (plan §Effect-TS Application-Code Migration, P9,
  // Step 3): the guard is now `Effect.Semaphore.withPermitsIfAvailable`
  // rather than a hand-rolled boolean flag — these tests specifically
  // exercise properties that primitive must uphold BY CONSTRUCTION, not
  // just "the code compiles and looks Effect-y".
  test("FIVE-WAY real concurrent race: exactly one cycle runs, the other four are skipped — not just a two-caller coincidence", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime());
    const vault = createFakeVaultEnv();

    let fetchCalls = 0;
    const runner = createCalendarIngestCycleRunner({
      sql,
      env: vault.env,
      loadConfig: () => CONFIG,
      now: () => TEST_NOW,
      fetchImpl: fakeFetch(() => {
        fetchCalls += 1;
        return new Response(JSON.stringify(page([], `token-${fetchCalls}`)), { status: 200 });
      }),
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => runner()));
    const skipped = results.filter((r) => "skipped" in r && r.skipped === true);
    const completed = results.filter((r) => !("skipped" in r));

    expect(fetchCalls).toBe(1);
    expect(completed.length).toBe(1);
    expect(skipped.length).toBe(4);
  });

  test("a failure INSIDE the guarded critical section still propagates as a real rejection (not silently reported as skipped), and releases the guard for the next call", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime());
    const vault = createFakeVaultEnv();

    let attempt = 0;
    const runner = createCalendarIngestCycleRunner({
      sql,
      env: vault.env,
      loadConfig: () => CONFIG,
      now: () => TEST_NOW,
      fetchImpl: fakeFetch(() => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("simulated Calendar API network failure");
        }
        return new Response(JSON.stringify(page([], "token-recovered")), { status: 200 });
      }),
    });

    await expect(runner()).rejects.toThrow("simulated Calendar API network failure");

    // The guard must NOT be permanently stuck holding a permit that was
    // never released because the critical section threw — a later call
    // must be able to proceed normally.
    const second = await runner();
    expect("skipped" in second).toBe(false);
    expect(getSyncCursor(sql, "calendar")).toBe("token-recovered");
  });
});
