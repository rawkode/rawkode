// @enchiridion/worker-gatekeeper-google — token-refresh orchestration.
//
// This is the real logic behind `GoogleAccountDO.getValidAccessToken()` —
// the "clean interface" the task brief says a follow-up task (calendar
// ingest) calls. Plain function taking an injected `SqlExecutor` + `now` +
// `fetchImpl`, no DO/Workers-runtime dependency, so it's directly
// unit-testable (`token-refresh.test.ts`) with a real `bun:sqlite`-backed
// `SqlExecutor` and a hand-written `fetchImpl` that returns real-shaped
// Google token-endpoint JSON — never an "always succeeds" stub.
//
// IMPORTANT — no retry loop: if Google's token endpoint rejects a refresh
// attempt (e.g. `invalid_grant` for a revoked/expired refresh token, which
// is exactly what happens when the user revokes this app's access in their
// Google Account settings), `refreshAccessToken` throws `GoogleOAuthError`
// and this function lets it propagate as-is. Silently retrying here would
// hide a condition that fundamentally cannot be fixed by trying again — the
// user must re-run `/oauth/google/authorize` to grant a fresh credential.
// A caller (the calendar/Gmail ingest cycles, `write-model.ts`'s
// `confirmApproval`) is expected to catch `GoogleOAuthError`, stop
// attempting sync, and surface the need to re-authorize.
//
// ── MIGRATED TO EFFECT (plan §Effect-TS Application-Code Migration, P9,
// Step 2 — the FIRST real Effect module in this codebase; see
// `effect-runtime.ts`'s header for the shared conventions this reuses) ──
//
// Plan Risk #15: `gatekeeper-google`'s three independently reentrancy-
// guarded cron cycles (calendar ingest, Gmail thread ingest, Gmail body
// ingest) each call `getValidAccessToken` with their OWN fresh `deps`
// object, with nothing coordinating between them. Two (or three) of these
// can fire "concurrently" on the SAME `GoogleAccountDO` instance (e.g. a
// slow calendar cycle still running when the 5-minute Gmail-cycle tick
// fires) and, previously, each would independently read the stored token
// as expired/near-expiry and independently call Google's token endpoint
// with the SAME refresh token — racing Google's API. Previously
// "benign" only because Google's client here happens not to rotate
// refresh tokens on every use (an EXTERNAL, unenforced assumption); if
// rotation were ever enabled, the loser of that race would persist an
// already-spent (invalid) refresh token, breaking the connection.
//
// FIX — a single-flight critical section, genuinely closing the race
// (not just relocating it): the ENTIRE "read stored token -> decide
// whether to refresh -> call Google -> persist" sequence is now wrapped in
// an `Effect.Semaphore` with exactly 1 permit, one semaphore PER
// underlying `SqlExecutor` (== per `GoogleAccountDO` instance's storage —
// see `sessionSemaphores` below). Concurrent callers sharing that
// `SqlExecutor` serialize through the same critical section rather than
// each independently deciding to refresh:
//   - Caller A acquires the permit, sees the token is stale, starts the
//     real network refresh.
//   - Caller B (racing concurrently) blocks on the SAME semaphore — at
//     the Effect/Fiber level, not a real thread block — until A finishes.
//   - Once A releases (having persisted the refreshed token), B's
//     critical section runs and RE-READS storage from scratch. B almost
//     always finds the token A just refreshed is now fresh enough for
//     B's own `now`, and returns it WITHOUT a second network call — B
//     never sends A's now-superseded refresh token to Google at all.
// This means at most ONE refresh call ever reaches Google per genuine
// staleness event, however many callers raced in — proven with a REAL
// concurrent race (`Promise.all` of overlapping calls sharing one `sql`,
// asserting the fetch call count) in `token-refresh.test.ts`, not just
// sequential calls. `Effect.unsafeMakeSemaphore` (a synchronous
// constructor) is used for the lazy per-session creation specifically so
// that the WeakMap lookup-then-create in `semaphoreFor` has no `await`
// between "not found" and "store a new one" — same "one synchronous span
// can't be interleaved" reasoning `calendar-ingest-cycle.ts`'s own
// in-memory `inProgress` flag already documents, applied here to lazily
// creating the lock itself rather than to guarding a whole cycle.
import { Effect } from "effect";
import { refreshAccessToken as requestRefresh } from "./oauth-client";
import type { FetchLike, GoogleOAuthConfig } from "./oauth-client";
import { runEffectAsPromise } from "./effect-runtime";
import type { SqlExecutor } from "./schema";
import { getStoredTokens, updateAccessToken } from "./token-store";

/** How far ahead of actual expiry a stored access token is treated as
 *  "near expiry" and proactively refreshed, rather than waiting for it to
 *  actually fail on Google's API. Mirrors the OLD app's client-side
 *  equivalent check
 *  (apps/enchiridion/Sources/EnchiridionCore/GoogleCalendarProvider.swift:178,
 *  `accessTokenExpiry.timeIntervalSinceNow > 60` — i.e. that code treats a
 *  token as still good only with more than 60s of headroom left) — same
 *  60-second skew, ported to milliseconds. */
export const REFRESH_SKEW_MS = 60_000;

/** Thrown when there is no stored credential to refresh AT ALL — distinct
 *  from `GoogleOAuthError` (Google explicitly rejecting an existing
 *  credential): this means OAuth was simply never completed. Callers
 *  should treat this as "prompt the user through
 *  /oauth/google/authorize", not as an error condition to retry or alert
 *  on. */
export class GoogleAccountNotConnectedError extends Error {
  constructor() {
    super("Google account is not connected — no stored OAuth tokens. Complete /oauth/google/authorize first.");
    this.name = "GoogleAccountNotConnectedError";
  }
}

export interface TokenRefreshDeps {
  sql: SqlExecutor;
  config: GoogleOAuthConfig;
  now: number;
  fetchImpl?: FetchLike;
}

/** One single-flight lock per underlying `SqlExecutor` OBJECT IDENTITY —
 *  in production that's one lock per `GoogleAccountDO` instance, matching
 *  exactly the scope Risk #15's race needs closed: concurrent cron cycles
 *  on the SAME DO instance. This depends on `GoogleAccountDO` handing
 *  every call into this file the SAME `SqlExecutor` object for its whole
 *  lifetime — adversarial-review finding: that was, at first, an
 *  UNVERIFIED assumption about whether Cloudflare's own
 *  `ctx.storage.sql` getter returns a referentially-stable object across
 *  repeated accesses. `google-account-do.ts` now closes that loop
 *  explicitly: `this.sql` there is a `readonly` field read from
 *  `ctx.storage.sql` exactly ONCE in the constructor (not a getter
 *  re-evaluated per access), so this file's identity assumption holds by
 *  construction regardless of the host runtime's own getter semantics —
 *  see that field's doc comment for the full reasoning. A `WeakMap` (not
 *  a plain `Map`) so a `SqlExecutor`/DO instance that goes away doesn't
 *  pin its semaphore in memory forever, and so each independent
 *  `bun test` test using its own fresh `SqliteStorageAdapter` gets its
 *  own independent lock (proven by `token-refresh.test.ts`'s race tests
 *  never interfering with each other). */
const sessionSemaphores = new WeakMap<SqlExecutor, Effect.Semaphore>();

function semaphoreFor(sql: SqlExecutor): Effect.Semaphore {
  // Synchronous get-or-create, deliberately with NO `await` between the
  // `.get` and the `.set` — see this file's header on why that's what
  // makes this race-free without any lock protecting the lock itself.
  const existing = sessionSemaphores.get(sql);
  if (existing) return existing;
  const created = Effect.unsafeMakeSemaphore(1);
  sessionSemaphores.set(sql, created);
  return created;
}

/** The single-flight-guarded critical section: reads the stored token,
 *  decides whether a refresh is needed, and if so performs it and
 *  persists the result — all while holding this session's semaphore (see
 *  `getValidAccessTokenEffect` below, which acquires the permit around
 *  this). Deliberately re-reads storage from scratch every time it runs
 *  (never trusts a value read before the permit was acquired) — that's
 *  what lets a caller that lost the race to a concurrent refresh observe
 *  the WINNER's freshly-persisted token instead of triggering a redundant
 *  second network call. */
function criticalSection(
  deps: TokenRefreshDeps,
): Effect.Effect<string, GoogleAccountNotConnectedError | GoogleOAuthErrorLike> {
  return Effect.gen(function* () {
    const stored = yield* Effect.sync(() => getStoredTokens(deps.sql));
    if (!stored) {
      return yield* Effect.fail(new GoogleAccountNotConnectedError());
    }

    if (stored.expiresAt - deps.now > REFRESH_SKEW_MS) {
      return stored.accessToken;
    }

    // Expired or near-expiry: refresh now. See this file's header on why
    // a GoogleOAuthError here propagates unmodified rather than being
    // caught and retried — `catch` below preserves whatever `requestRefresh`
    // threw (a `GoogleOAuthError` for a real Google-side rejection, or a
    // plain `Error` for a network-level failure) with its identity intact,
    // it does not translate or wrap it.
    const refreshed = yield* Effect.tryPromise({
      try: () => requestRefresh(deps.config, stored.refreshToken, deps.fetchImpl),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
    yield* Effect.sync(() => updateAccessToken(deps.sql, refreshed, deps.now));
    return refreshed.accessToken;
  });
}

// `GoogleOAuthError` and a plain `Error` (network/parse failure) are both
// valid failures of `requestRefresh` — named here rather than imported
// from oauth-client.ts's `GoogleOAuthError` alone, since the `catch`
// handler above can legitimately produce either. Both are real `Error`
// subclasses/instances; this is a type-level alias only.
type GoogleOAuthErrorLike = Error;

/** Effect-program form of `getValidAccessToken`, for a future caller that
 *  wants to compose this into a larger Effect program instead of
 *  round-tripping through a `Promise` (e.g. a later-migrated
 *  `calendar-ingest-cycle.ts`). Exported alongside the `Promise`-returning
 *  form per this file's boundary-pattern convention — see
 *  `effect-runtime.ts`. */
export function getValidAccessTokenEffect(
  deps: TokenRefreshDeps,
): Effect.Effect<string, GoogleAccountNotConnectedError | GoogleOAuthErrorLike> {
  return semaphoreFor(deps.sql).withPermits(1)(criticalSection(deps));
}

/** Returns a currently-valid Google access token, refreshing it first if
 *  the stored one is expired or within `REFRESH_SKEW_MS` of expiring.
 *  Makes ZERO network calls when the stored token still has more than
 *  `REFRESH_SKEW_MS` of life left — see `token-refresh.test.ts` for the
 *  test asserting exactly that (no gratuitous refresh-on-every-call).
 *
 *  Promise-returning boundary function — same exported name/signature as
 *  before this module's Effect migration, so every existing caller
 *  (`calendar-ingest-cycle.ts`, `gmail-ingest-cycle.ts`,
 *  `gmail-body-ingest-cycle.ts`, `write-model.ts`, `google-account-do.ts`)
 *  needs zero changes. See `effect-runtime.ts`'s header for why
 *  `runEffectAsPromise` (not a bare `Effect.runPromise`) is what makes
 *  `error instanceof GoogleOAuthError`/`GoogleAccountNotConnectedError`
 *  keep working unmodified at every one of those call sites. */
export async function getValidAccessToken(deps: TokenRefreshDeps): Promise<string> {
  return runEffectAsPromise(getValidAccessTokenEffect(deps));
}
