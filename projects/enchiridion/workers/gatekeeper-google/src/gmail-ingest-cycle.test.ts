import { describe, expect, test } from "bun:test";
import { initializeSchema } from "./schema";
import { storeInitialTokens } from "./token-store";
import { createGmailIngestCycleRunner } from "./gmail-ingest-cycle";
import { CALENDAR_EVENTS_SCOPE, GMAIL_READONLY_SCOPE, type GoogleOAuthConfig } from "./oauth-client";
import { createFakeVaultEnv } from "./test-helpers/fake-vault-env";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

const CONFIG: GoogleOAuthConfig = { clientId: "id", clientSecret: "secret", redirectUri: "https://gatekeeper.example/callback" };
const TEST_NOW = new Date("2026-08-06T09:00:00Z");

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string) => handler(new URL(input))) as unknown as typeof fetch;
}

/** Handles all four endpoints a full cycle might touch (profile, threads
 *  list/get, history) with empty/trivial responses — a real cycle against
 *  an "empty mailbox" completes backfill immediately (no threads at all),
 *  so a LATER cycle in the same test can legitimately land in incremental
 *  mode and call `history.list`, which this fake must also answer. */
function fullCycleFetch(counters: { profile: number; threadsList: number; history: number } = { profile: 0, threadsList: 0, history: 0 }): typeof fetch {
  return fakeFetch((url) => {
    if (url.pathname === "/gmail/v1/users/me/profile") {
      counters.profile += 1;
      return new Response(JSON.stringify({ emailAddress: "david@rawkode.academy", historyId: "1000" }), { status: 200 });
    }
    if (url.pathname === "/gmail/v1/users/me/threads") {
      counters.threadsList += 1;
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    }
    if (url.pathname === "/gmail/v1/users/me/history") {
      counters.history += 1;
      return new Response(JSON.stringify({ history: [], historyId: "1000" }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url.pathname}`);
  });
}

/** Same "stored token expiry relative to the SAME clock the runner uses"
 *  contract `calendar-ingest-cycle.test.ts` documents — see that file's
 *  `withValidStoredToken` comment for why this matters (otherwise these
 *  tests would exercise a REAL token refresh instead of the guard/gate
 *  under test). */
function withValidStoredToken(sql: SqliteStorageAdapter, nowMs: number, grantedScopes?: string): void {
  storeInitialTokens(sql, { accessToken: "valid-access-token", refreshToken: "rt-1", expiresIn: 3600, grantedScopes }, nowMs);
}

describe("createGmailIngestCycleRunner — scope gate", () => {
  test("Gmail scope ungranted (never requested): cleanly skips, does not error, does not touch the Gmail API at all", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime(), CALENDAR_EVENTS_SCOPE); // calendar only, no gmail_readonly
    const vault = createFakeVaultEnv();

    let fetchCalls = 0;
    const runner = createGmailIngestCycleRunner({
      sql,
      env: vault.env,
      loadConfig: () => CONFIG,
      now: () => TEST_NOW,
      fetchImpl: fakeFetch(() => {
        fetchCalls += 1;
        throw new Error("should never be called — the scope gate must short-circuit before any Gmail API call");
      }),
    });

    const result = await runner();
    expect(result).toMatchObject({ skipped: true });
    expect((result as { reason: string }).reason).toContain("Gmail not connected");
    expect(fetchCalls).toBe(0);
  });

  test("a legacy connection with NO recorded granted_scopes at all also cleanly skips (falls back to calendar-only per hasGrantedScope's documented fallback)", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime(), undefined); // no granted_scopes recorded
    const vault = createFakeVaultEnv();

    const runner = createGmailIngestCycleRunner({ sql, env: vault.env, loadConfig: () => CONFIG, now: () => TEST_NOW });
    const result = await runner();
    expect(result).toMatchObject({ skipped: true });
  });

  test("Gmail scope GRANTED: runs the real ingest cycle, not a skip", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime(), `${CALENDAR_EVENTS_SCOPE} ${GMAIL_READONLY_SCOPE}`);
    const vault = createFakeVaultEnv();

    const runner = createGmailIngestCycleRunner({
      sql,
      env: vault.env,
      loadConfig: () => CONFIG,
      now: () => TEST_NOW,
      fetchImpl: fullCycleFetch(),
    });

    const result = await runner();
    expect("skipped" in result).toBe(false);
    expect((result as { mode: string }).mode).toBe("backfill");
  });

  test("not connected at all (no stored tokens): cleanly skips before the scope check is even reached", async () => {
    const sql = makeSql();
    const vault = createFakeVaultEnv();
    const runner = createGmailIngestCycleRunner({ sql, env: vault.env, loadConfig: () => CONFIG, now: () => TEST_NOW });
    const result = await runner();
    expect(result).toMatchObject({ skipped: true });
  });
});

describe("createGmailIngestCycleRunner — reentrancy guard", () => {
  test("TWO CONCURRENT CALLS: the second is cleanly skipped ('gmail ingest already in progress'), not racing on the cursor", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime(), `${CALENDAR_EVENTS_SCOPE} ${GMAIL_READONLY_SCOPE}`);
    const vault = createFakeVaultEnv();

    const counters = { profile: 0, threadsList: 0, history: 0 };
    const runner = createGmailIngestCycleRunner({
      sql,
      env: vault.env,
      loadConfig: () => CONFIG,
      now: () => TEST_NOW,
      fetchImpl: fullCycleFetch(counters),
    });

    const [first, second] = await Promise.all([runner(), runner()]);
    const results = [first, second];
    const skipped = results.filter((r): r is { skipped: true; reason: string } => "skipped" in r && r.skipped === true);
    const completed = results.filter((r) => !("skipped" in r));

    expect(skipped.length).toBe(1);
    expect(skipped[0]?.reason).toBe("gmail ingest already in progress");
    expect(completed.length).toBe(1);
    // The skipped call never touched the Gmail API at all — proof it
    // bailed out before doing any work, not after racing the winner.
    // `threadsList` is called EXACTLY once per real backfill cycle
    // (unlike `profile`, which a single winning cycle can legitimately
    // call twice — self-email discovery + historyId seeding on this
    // empty-mailbox backfill-completes-immediately scenario), so it's the
    // reliable "exactly one real cycle ran" signal here.
    expect(counters.threadsList).toBe(1);
  });

  test("REGRESSION GUARD: three concurrent firings still result in exactly ONE real cycle running", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime(), `${CALENDAR_EVENTS_SCOPE} ${GMAIL_READONLY_SCOPE}`);
    const vault = createFakeVaultEnv();

    const counters = { profile: 0, threadsList: 0, history: 0 };
    const runner = createGmailIngestCycleRunner({
      sql,
      env: vault.env,
      loadConfig: () => CONFIG,
      now: () => TEST_NOW,
      fetchImpl: fullCycleFetch(counters),
    });

    await Promise.all([runner(), runner(), runner()]);
    expect(counters.threadsList).toBe(1);
  });

  test("after the in-progress call finishes, a later call is NOT permanently blocked (the flag is cleared in a finally)", async () => {
    const sql = makeSql();
    withValidStoredToken(sql, TEST_NOW.getTime(), `${CALENDAR_EVENTS_SCOPE} ${GMAIL_READONLY_SCOPE}`);
    const vault = createFakeVaultEnv();

    const runner = createGmailIngestCycleRunner({
      sql,
      env: vault.env,
      loadConfig: () => CONFIG,
      now: () => TEST_NOW,
      fetchImpl: fullCycleFetch(),
    });

    const first = await runner();
    expect("skipped" in first).toBe(false);
    const second = await runner();
    expect("skipped" in second).toBe(false); // not stuck skipped forever
  });
});
