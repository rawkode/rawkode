// @enchiridion/worker-gatekeeper-google — reentrancy-guarded calendar
// ingest cycle runner.
//
// Plan §Google gatekeeper / adversarial-review finding: nothing previously
// prevented two overlapping `scheduled()` firings (e.g. a slow first-run
// full resync outliving the 5-minute cron interval) from both calling
// `GoogleAccountDO.runCalendarIngestCycle()` concurrently on the SAME DO
// instance. Two concurrent cycles would both read the same starting
// `syncToken`, both fetch, and race on which `setSyncCursor` write wins —
// silently stranding whichever cycle's progress didn't "win" (its
// materialization writes still happened, but its cursor advance got
// overwritten by the other cycle's, so the next incremental sync starts
// from the wrong point).
//
// ── MIGRATED TO EFFECT (plan §Effect-TS Application-Code Migration, P9,
// Step 3 — reuses the conventions `token-refresh.ts`/`effect-runtime.ts`
// established in Step 2) ──
//
// Fix, now expressed with Effect's own concurrency primitive rather than a
// hand-rolled boolean flag: one `Effect.Semaphore` (1 permit) PER RUNNER
// INSTANCE — same scope the old `inProgress` flag had (closed over per
// `createCalendarIngestCycleRunner` call, i.e. per `GoogleAccountDO`
// instance's lifetime — see `google-account-do.ts`'s constructor, which
// still constructs exactly one runner instance and holds it for the DO's
// whole life). `guard.withPermitsIfAvailable(1)(effect)` is a TRY-acquire:
// if the permit is free it runs `effect` while holding it (guaranteeing
// release on completion OR failure — no manual `try/finally` needed,
// unlike the old flag) and returns `Some(result)`; if the permit is
// already held it returns `None` IMMEDIATELY, without ever starting
// `effect` — no queuing, no blocking, exactly the old flag's
// "second overlapping call bails out right away" behavior. This is
// `token-refresh.ts`'s `withPermits` primitive's sibling, deliberately the
// OPPOSITE choice: token-refresh WANTS concurrent callers to wait for and
// share one outcome (closing a data-corruption race); this guard WANTS a
// second overlapping cycle to bail out immediately rather than wait its
// turn (closing a cursor-clobber race by simply never letting two cycles
// run at once, not by making them cooperate).
//
// Empirically verified (see this task's write-up) that
// `withPermitsIfAvailable` grants the permit to AT MOST ONE of several
// truly concurrent (`Promise.all`-raced) callers, that a failure inside
// the guarded region still propagates as a real failure (not silently
// swallowed into `None`), and that the permit is released even after such
// a failure — i.e. this primitive gives the same guarantees the old
// `if (inProgress) {...} inProgress = true ... finally { inProgress =
// false }` pattern did, by construction, rather than by convention.
//
// Kept as a plain, DO-runtime-independent factory (same split as every
// other real-logic module in this worker — see `calendar-ingest.ts`'s
// file header) SPECIFICALLY so this guard is unit-testable via `bun test`
// without a live DO runtime: `google-account-do.ts`'s
// `runCalendarIngestCycle()` RPC method holds exactly one instance of the
// runner this factory returns (created once, in the constructor, so the
// semaphore is scoped to the DO instance's lifetime) and delegates to it.
import { Effect, Option } from "effect";
import { GoogleOAuthError, type GoogleOAuthConfig } from "./oauth-client";
import { getValidAccessTokenEffect, GoogleAccountNotConnectedError } from "./token-refresh";
import { runCalendarIngest, type CalendarIngestResult } from "./calendar-ingest";
import type { FetchLike } from "./calendar-api";
import type { SqlExecutor } from "./schema";
import type { VaultClientEnv } from "./vault-client";
import { runEffectAsPromise } from "./effect-runtime";

export type CalendarIngestCycleResult = CalendarIngestResult | { skipped: true; reason: string };

export interface CalendarIngestCycleDeps {
  sql: SqlExecutor;
  env: VaultClientEnv;
  /** Called fresh on every cycle attempt (not memoized here) — matches
   *  the original `runCalendarIngestCycle`'s behavior of calling
   *  `loadOAuthConfig(this.env)` on every invocation, so a
   *  `GoogleOAuthConfigError` (env misconfigured) is caught at call time,
   *  not construction time. */
  loadConfig: () => GoogleOAuthConfig;
  /** Defaults to the real clock — overridable for tests. */
  now?: () => Date;
  fetchImpl?: FetchLike;
}

type TokenResolutionOutcome =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly skip: { skipped: true; reason: string } };

/** Resolves an access token for this cycle attempt, converting exactly the
 *  two "not usable right now, but not a hard failure" error types
 *  (`GoogleAccountNotConnectedError`/`GoogleOAuthError`) into a `{skip}`
 *  outcome — mirrors the ORIGINAL narrow `try { ... } catch { if
 *  (instanceof ...) return skip; throw }` scoping exactly: this recovery
 *  is attached ONLY to the token-resolution effect, not to
 *  `runCalendarIngest` below, so an unexpected error from either step
 *  still propagates as a genuine failure rather than being misreported as
 *  a clean skip. */
function resolveAccessTokenOrSkip(deps: CalendarIngestCycleDeps, config: GoogleOAuthConfig, now: Date) {
  return getValidAccessTokenEffect({
    sql: deps.sql,
    config,
    now: now.getTime(),
    fetchImpl: deps.fetchImpl,
  }).pipe(
    Effect.map((accessToken): TokenResolutionOutcome => ({ ok: true, accessToken })),
    Effect.catchAll((error) => {
      if (error instanceof GoogleAccountNotConnectedError || error instanceof GoogleOAuthError) {
        const outcome: TokenResolutionOutcome = { ok: false, skip: { skipped: true, reason: error.message } };
        return Effect.succeed(outcome);
      }
      return Effect.fail(error);
    }),
  );
}

/** The guarded critical section itself — token resolution (or skip) then
 *  the real ingest cycle. `now`/`config` are computed HERE (inside the
 *  generator, i.e. only once this Effect actually starts running), not at
 *  Effect-construction time, so a race LOSER (which never gets to run
 *  this at all — see `createCalendarIngestCycleRunner` below) never calls
 *  `deps.now()`/`deps.loadConfig()`, matching the original's exact
 *  ordering. */
function cycleBody(deps: CalendarIngestCycleDeps): Effect.Effect<CalendarIngestCycleResult, unknown> {
  return Effect.gen(function* () {
    // ONE `now` for the whole cycle attempt — used for BOTH the token-
    // freshness check and `runCalendarIngest`'s own `now` (cursor
    // timestamps, ingest-failure timestamps). Deliberately NOT two
    // separate `Date.now()`/`new Date()` calls: this is what makes the
    // whole cycle deterministic under an injected `deps.now` in tests
    // (real deployments just get `deps.now` defaulting to the real
    // clock, so this changes nothing in production).
    const now = (deps.now ?? (() => new Date()))();
    const config = deps.loadConfig();

    const tokenOutcome = yield* resolveAccessTokenOrSkip(deps, config, now);
    if (!tokenOutcome.ok) {
      return tokenOutcome.skip;
    }

    return yield* Effect.tryPromise({
      try: () =>
        runCalendarIngest({
          sql: deps.sql,
          env: deps.env,
          accessToken: tokenOutcome.accessToken,
          now,
          fetchImpl: deps.fetchImpl,
        }),
      // Pass unexpected failures through unmodified — same as the
      // original's un-caught `await runCalendarIngest(...)`.
      catch: (error) => error,
    });
  });
}

/** Creates a reentrancy-guarded ingest-cycle runner bound to one set of
 *  deps (in production, one `GoogleAccountDO` instance's storage/env — see
 *  this file's header). Call the returned function from
 *  `GoogleAccountDO.runCalendarIngestCycle()`; hold exactly one instance
 *  of it per DO (constructed once, not per call), so the semaphore
 *  actually guards across calls rather than resetting every time. */
export function createCalendarIngestCycleRunner(
  deps: CalendarIngestCycleDeps,
): () => Promise<CalendarIngestCycleResult> {
  // Scoped to this runner instance — same lifetime the old `let inProgress
  // = false` closure variable had. See this file's header for why
  // `withPermitsIfAvailable` (try-acquire) rather than `withPermits`
  // (queue-and-wait, `token-refresh.ts`'s choice) is correct here.
  const guard = Effect.unsafeMakeSemaphore(1);

  return async function runCalendarIngestCycle(): Promise<CalendarIngestCycleResult> {
    const program = guard.withPermitsIfAvailable(1)(cycleBody(deps)).pipe(
      Effect.map(
        Option.match({
          onNone: (): CalendarIngestCycleResult => ({ skipped: true, reason: "ingest already in progress" }),
          onSome: (result) => result,
        }),
      ),
    );
    return runEffectAsPromise(program);
  };
}
