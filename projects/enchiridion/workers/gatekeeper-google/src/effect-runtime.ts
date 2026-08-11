// @enchiridion/worker-gatekeeper-google — shared Effect conventions.
//
// This is the FIRST Effect (https://effect.website) code in this codebase
// (plan §Effect-TS Application-Code Migration, P9) — everything in this
// file is the convention every later migrated module (calendar-ingest-
// cycle.ts, approvals-store.ts, and whatever comes after) reuses, so it's
// documented here once rather than re-derived per module.
//
// ── Why gatekeeper-google, why now ─────────────────────────────────────
// This worker holds every one of this project's real, documented
// concurrency/reentrancy bugs (cron reentrancy, OAuth token-refresh races,
// calendar-sync cursor-ordering data loss, Gmail backoff/dead-letter gaps,
// approval-reconciliation status-guard races). Effect's structured
// concurrency (Fiber-based, typed cancellation, `Semaphore`/`Ref`/`race`
// as composable primitives) is the specific, earned tool for closing that
// class of bug — not a generic "modern stack" argument. See the plan's P9
// section for the full rationale.
//
// ── Version ─────────────────────────────────────────────────────────────
// `effect@3.22.1` (latest stable at time of writing). Alchemy v2 was
// searched for across this entire repo (workspace `package.json`s,
// `bun.lock`) and is NOT installed anywhere yet — P8's deploy work hasn't
// landed Alchemy's own dependencies, so there is no peer-declared `effect`
// version to pin against. This version choice should be RECONCILED once
// Alchemy v2 is actually installed, in case its peer dependency differs.
//
// ── The boundary pattern (decide once, reuse everywhere) ────────────────
// Every Cloudflare Workers entry point — `fetch(request, env, ctx)`, a
// Durable Object's own RPC methods (e.g. `GoogleAccountDO.getValidAccessToken()`),
// `scheduled(event, env, ctx)` — MUST stay a plain `async` function
// returning a plain `Promise`/`Response`; the Workers runtime requires
// this shape and nothing here fights it. A migrated module internally
// models its logic as `Effect.Effect<A, E>` programs, and converts to a
// `Promise<A>` at its own edge using `runEffectAsPromise` below — so any
// caller elsewhere in this worker (or a cross-worker RPC caller) never
// needs to know or care whether the callee is implemented with Effect.
//
// ── How bindings/DO state thread into Effect programs ────────────────────
// No Effect `Layer`/`Context.Tag` dependency-injection is used for
// Workers bindings (`SqlExecutor`, `fetch`, `Env`, etc.) in this pass —
// that machinery earns its keep once there are several independently
// testable *services* to compose, and right now every migrated module
// already has a plain-object `Deps` interface (the pre-existing
// convention: `TokenRefreshDeps`, `CalendarIngestCycleDeps`, ...) that
// works fine as an ordinary closed-over value passed into a function that
// RETURNS an `Effect` program. This keeps each Effect program's `R`
// (environment) type at `never` — nothing to `Effect.provide` at the
// boundary except `TestContext.TestContext` in tests that need
// `TestClock`. Revisit `Context.Tag`/`Layer` if/when a THIRD or later
// migrated module needs to share a service across programs in a way a
// plain closure can't express cleanly.
//
// ── How errors are typed ─────────────────────────────────────────────────
// Every DOMAIN error the original plain-`async` implementation could throw
// (e.g. `GoogleAccountNotConnectedError`, `GoogleOAuthError`) stays exactly
// the same `Error` subclass it already was — Effect's typed error channel
// (`Effect.Effect<A, E>`'s `E`) is just those same classes recorded in the
// TYPE SIGNATURE, not a new wrapper/tagged-union scheme. This is
// deliberate: every existing call site across this worker does
// `error instanceof GoogleOAuthError` (`calendar-ingest-cycle.ts`,
// `gmail-ingest-cycle.ts`, `gmail-body-ingest-cycle.ts`, `write-model.ts`)
// and every existing test does `expect(caught).toBeInstanceOf(...)` — the
// Promise boundary (`runEffectAsPromise`) exists specifically to preserve
// that `instanceof` contract untouched (see below). Truly unexpected
// failures (a network-level `fetch` rejection, a malformed-JSON parse
// throw) are left as plain `Error` and threaded through the SAME `E`
// channel (not `Effect.die`) — that keeps `Cause.squash` (below) a total,
// simple unwrap rather than something that has to special-case defects.
//
// ── The Promise boundary itself ───────────────────────────────────────
// `Effect.runPromise` on a *failed* Effect does NOT reject with the raw
// `E` value — it wraps it in a `FiberFailure`, which breaks every
// `instanceof GoogleOAuthError` check above (empirically verified while
// building this module: `e instanceof MyError` is `false` after a bare
// `Effect.runPromise` rejection, `true` after unwrapping via
// `Cause.squash`). `runEffectAsPromise` below is `Effect.runPromiseExit` +
// `Cause.squash` specifically to undo that wrapping, so a migrated
// module's external behavior — the exact error object a caller catches —
// is byte-identical to the pre-migration implementation.
import { Cause, Effect, Exit } from "effect";

/** The ONE way every migrated module in this worker converts an Effect
 *  program to the plain `Promise` its exported function signature (and
 *  the Workers-runtime boundary) requires. See this file's header for why
 *  this is `runPromiseExit` + `Cause.squash`, not a bare `Effect.runPromise`.
 *
 *  Preserves, for both `Effect.fail` (typed `E`) and unexpected defects
 *  (`Effect.die`, or a raw `throw` inside `Effect.sync`/`Effect.gen`):
 *   - object identity of the original error (`instanceof` checks against
 *     `GoogleOAuthError`/`GoogleAccountNotConnectedError`/etc. keep working
 *     unmodified in every existing call site and test)
 *   - the original error's `message`/`stack`/custom fields untouched. */
export async function runEffectAsPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  // Cause.squash collapses Fail/Die/Interrupt into the single underlying
  // error value (for Interrupt, a synthesized error) — a total function,
  // safe to throw whatever it returns.
  throw Cause.squash(exit.cause);
}

// ── The SYNCHRONOUS boundary — `approvals-store.ts`'s special case ──────
// `runEffectAsPromise` is the right choice whenever the ORIGINAL function
// was already `async`/`Promise`-returning (token refresh, an ingest
// cycle — genuine I/O). `approvals-store.ts`'s CAS core
// (`tryConfirmApproval`/`markExecuted`/`markFailed`/
// `reconcileStuckConfirmedApprovals`) is different in a way that matters a
// lot: those functions are, and MUST REMAIN, plain SYNCHRONOUS functions
// (no `await`, no returned `Promise`) — `write-model.ts`'s
// `confirmApproval` depends on `tryConfirmApproval` committing its CAS
// transition fully synchronously, with no `await` before it returns (see
// that function's own doc comment: "the CAS transition happens FIRST and
// fully synchronously ... so a racing second call already sees `status
// !== 'pending'` in its own read"). Converting that CAS to `async` — even
// just by routing it through `runEffectAsPromise` and awaiting it — would
// insert exactly the `await` point this codebase's whole first-writer-wins
// argument depends on NOT existing, silently REOPENING the race this
// module exists to close. `runEffectSync` below is what keeps a migrated
// module's Effect-modeled logic genuinely synchronous end to end.
//
// This is a real trap worth flagging explicitly for future Effect work in
// this repo: `Effect.gen`/`Effect.sync` compose freely with async
// operations (`Effect.tryPromise`, `Effect.sleep`, ...), so nothing about
// writing an Effect program stops you from accidentally adding one. The
// enforcement here isn't just documentation, either — `Effect.runSyncExit`
// (which `runEffectSync` uses) resolves to a `Failure` Exit carrying an
// `AsyncFiberException` defect if the effect it's running ever actually
// suspends (i.e. contains a genuinely asynchronous step) — empirically
// verified while building this module — which `runEffectSync` then throws
// via the same `Cause.squash` path as any other failure. So a future edit
// that accidentally introduces an `await`-shaped operation into one of
// these functions fails loudly at the boundary, immediately, rather than
// silently turning a synchronous CAS into an async one.
export function runEffectSync<A, E>(effect: Effect.Effect<A, E>): A {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
}

// Re-export `Effect` itself so modules that only need `runEffectAsPromise`/
// `runEffectSync` alongside `Effect` can import both from one place — pure
// convenience, not load-bearing.
export { Effect };
