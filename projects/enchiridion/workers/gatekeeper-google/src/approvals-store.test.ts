import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, TestClock, TestContext } from "effect";
import { initializeSchema } from "./schema";
import {
  getApproval,
  listPendingApprovals,
  markExecuted,
  markFailed,
  proposeApproval,
  reconcileStuckConfirmedApprovals,
  tryConfirmApproval,
} from "./approvals-store";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

interface ActionLogRow {
  id: string;
  approval_id: string | null;
  action_type: string;
  outcome: string;
  created_at: number;
  [key: string]: unknown;
}

function readActionLog(sql: SqliteStorageAdapter): ActionLogRow[] {
  return sql.exec<ActionLogRow>("SELECT * FROM action_log ORDER BY created_at ASC, id ASC").toArray();
}

describe("proposeApproval", () => {
  test("creates a pending approval with a fresh version token, and logs it", () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "createEvent", payload: { summary: "Standup" } }, 1000);

    expect(approval.status).toBe("pending");
    expect(approval.actionType).toBe("createEvent");
    expect(approval.payload).toEqual({ summary: "Standup" });
    expect(approval.versionToken.length).toBeGreaterThan(0);
    expect(approval.id.startsWith("approval_")).toBe(true);

    expect(getApproval(sql, approval.id)).toEqual(approval);
    expect(listPendingApprovals(sql)).toEqual([approval]);

    const log = readActionLog(sql);
    expect(log).toHaveLength(1);
    expect(log[0]?.outcome).toBe("proposed");
    expect(log[0]?.approval_id).toBe(approval.id);
  });

  test("two proposals get distinct ids and version tokens", () => {
    const sql = makeSql();
    const a = proposeApproval(sql, { actionType: "createEvent", payload: {} }, 1000);
    const b = proposeApproval(sql, { actionType: "createEvent", payload: {} }, 1000);
    expect(a.id).not.toBe(b.id);
    expect(a.versionToken).not.toBe(b.versionToken);
  });

  test("the 'sendEmail' action kind (added by a follow-up task, see this file's updated ApprovalActionType doc comment) works identically — this module is action-kind-agnostic", () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "sendEmail", payload: { to: ["guest@example.com"], subject: "Hi" } }, 1000);

    expect(approval.actionType).toBe("sendEmail");
    expect(approval.status).toBe("pending");
    expect(getApproval(sql, approval.id)).toEqual(approval);

    const confirmed = tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    expect(confirmed.status).toBe("confirmed");
    markExecuted(sql, approval.id, { id: "sent-1" }, 3000);
    expect(getApproval(sql, approval.id)?.status).toBe("executed");

    const log = readActionLog(sql).filter((e) => e.approval_id === approval.id);
    expect(log.map((e) => e.action_type)).toEqual(["sendEmail", "sendEmail", "sendEmail"]);
  });
});

describe("tryConfirmApproval — first-writer-wins CAS", () => {
  test("happy path: matching version token on a pending approval confirms it", () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "rsvp", payload: { eventId: "e1" } }, 1000);

    const outcome = tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    expect(outcome.status).toBe("confirmed");
    if (outcome.status === "confirmed") {
      expect(outcome.approval.status).toBe("confirmed");
    }
    expect(getApproval(sql, approval.id)?.status).toBe("confirmed");
    expect(listPendingApprovals(sql)).toEqual([]); // no longer pending
  });

  test("a wrong version token is rejected with conflict, and the approval stays pending", () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "rsvp", payload: { eventId: "e1" } }, 1000);

    const outcome = tryConfirmApproval(sql, approval.id, "wrong-token", 2000);
    expect(outcome).toEqual({ status: "conflict", reason: expect.stringContaining("version token") });
    expect(getApproval(sql, approval.id)?.status).toBe("pending");
  });

  test("an unknown approval id is rejected with conflict", () => {
    const sql = makeSql();
    const outcome = tryConfirmApproval(sql, "approval_does_not_exist", "any-token", 2000);
    expect(outcome.status).toBe("conflict");
  });

  test("FIRST-WRITER-WINS: two racing confirmations for the same approval — the second gets conflict", () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "createEvent", payload: { summary: "Standup" } }, 1000);

    const first = tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    const second = tryConfirmApproval(sql, approval.id, approval.versionToken, 2001);

    expect(first.status).toBe("confirmed");
    expect(second.status).toBe("conflict");
    if (second.status === "conflict") {
      expect(second.reason).toContain("already");
    }

    // Only ONE "confirmed" transition ever happened — the log shows both
    // attempts, but the approval's terminal state is unambiguous.
    const log = readActionLog(sql);
    expect(log.filter((e) => e.outcome === "confirmed")).toHaveLength(1);
    expect(log.some((e) => e.outcome.startsWith("conflict"))).toBe(true);
  });

  test("confirming an already-executed approval is a conflict, not a re-execution", () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "createEvent", payload: {} }, 1000);
    tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    markExecuted(sql, approval.id, { id: "google-event-1" }, 3000);

    const outcome = tryConfirmApproval(sql, approval.id, approval.versionToken, 4000);
    expect(outcome.status).toBe("conflict");
    expect(getApproval(sql, approval.id)?.status).toBe("executed");
  });
});

describe("markExecuted / markFailed", () => {
  test("markExecuted stores the result and logs 'executed'", () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "createEvent", payload: {} }, 1000);
    tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    markExecuted(sql, approval.id, { id: "google-event-42" }, 3000);

    const stored = getApproval(sql, approval.id);
    expect(stored?.status).toBe("executed");
    expect(stored?.result).toEqual({ id: "google-event-42" });
    expect(readActionLog(sql).some((e) => e.outcome === "executed")).toBe(true);
  });

  test("markFailed stores the error and logs 'failed' — does NOT revert to pending", () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "createEvent", payload: {} }, 1000);
    tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    markFailed(sql, approval.id, "Google API rejected the request", 3000);

    const stored = getApproval(sql, approval.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.result).toEqual({ error: "Google API rejected the request" });

    // A later confirm attempt on a failed approval is a conflict, not a retry.
    const outcome = tryConfirmApproval(sql, approval.id, approval.versionToken, 4000);
    expect(outcome.status).toBe("conflict");
  });

  // Adversarial-review finding: a slow in-flight `confirmApproval` call must
  // not silently clobber a row the reconciliation sweep already flipped to
  // a terminal status while it was in flight. `markExecuted`/`markFailed`
  // now guard on `AND status = 'confirmed'`, matching
  // `reconcileStuckConfirmedApprovals`'s own guarded UPDATE.
  test("markExecuted arriving AFTER the sweep already reconciled the row to 'failed' does NOT overwrite that terminal status", () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "createEvent", payload: { summary: "Standup" } }, 1000);
    tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);

    // Simulate the cron sweep reconciling this row to "failed" while the
    // original confirmApproval call is still awaiting the real Calendar API.
    const reconciled = reconcileStuckConfirmedApprovals(sql, /* timeoutMs */ 1000, /* now */ 5000);
    expect(reconciled).toEqual([approval.id]);
    expect(getApproval(sql, approval.id)?.status).toBe("failed");

    // The original, slow in-flight call's eventual markExecuted must not
    // clobber the sweep's terminal status.
    markExecuted(sql, approval.id, { id: "google-event-late" }, 6000);

    const stored = getApproval(sql, approval.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.result).toEqual({
      error: expect.stringContaining("confirmation timed out"),
    });
  });

  test("markFailed arriving AFTER the sweep already reconciled a sendEmail row to 'unknown' does NOT overwrite that terminal status", () => {
    const sql = makeSql();
    const approval = proposeApproval(
      sql,
      { actionType: "sendEmail", payload: { to: ["guest@example.com"], subject: "Hi" }, providerMessageId: "abc123@mail.gmail.com" },
      1000,
    );
    tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);

    const reconciled = reconcileStuckConfirmedApprovals(sql, /* timeoutMs */ 1000, /* now */ 5000);
    expect(reconciled).toEqual([approval.id]);
    expect(getApproval(sql, approval.id)?.status).toBe("unknown");

    // The original, slow in-flight call's eventual markFailed (e.g. the
    // token refresh or send request itself errored out late) must not
    // downgrade the "unknown" safety signal to a plain "failed".
    markFailed(sql, approval.id, "network error contacting Gmail", 6000);

    const stored = getApproval(sql, approval.id);
    expect(stored?.status).toBe("unknown");
    expect(stored?.result).toEqual({
      error: expect.stringContaining("confirmation timed out"),
    });
  });
});

// ── Effect migration (plan §Effect-TS Application-Code Migration, P9,
// Step 4): `tryConfirmApproval`/`markExecuted`/`markFailed`/
// `reconcileStuckConfirmedApprovals` are now built from Effect programs
// internally (`approvals-store.ts`'s file header) but MUST remain
// genuinely synchronous — see `effect-runtime.ts`'s `runEffectSync` doc
// comment for why turning this async would silently reopen the exact
// race this file's CAS/guard exists to close.
describe("Effect migration — synchronicity is the safety property, not incidental", () => {
  test("REGRESSION GUARD: the migrated CAS/guard functions return plain values synchronously, never a Promise", () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "createEvent", payload: {} }, 1000);

    const confirmResult = tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    expect(confirmResult).not.toBeInstanceOf(Promise);
    expect(confirmResult.status).toBe("confirmed"); // only reachable synchronously — a Promise has no `.status`

    const markExecutedResult = markExecuted(sql, approval.id, { id: "e1" }, 3000);
    expect(markExecutedResult).not.toBeInstanceOf(Promise);

    const secondApproval = proposeApproval(sql, { actionType: "rsvp", payload: {} }, 1000);
    tryConfirmApproval(sql, secondApproval.id, secondApproval.versionToken, 2000);
    const reconcileResult = reconcileStuckConfirmedApprovals(sql, 100, 5000);
    expect(reconcileResult).not.toBeInstanceOf(Promise);
    expect(Array.isArray(reconcileResult)).toBe(true); // only reachable synchronously

    // Same-tick, back-to-back CAS calls with genuinely ZERO event-loop
    // turn between them — only possible because these functions are
    // truly synchronous. If any had silently become `async`, this
    // sequence would observe a still-`pending` second read instead of
    // the immediate `conflict`.
    const thirdApproval = proposeApproval(sql, { actionType: "createEvent", payload: {} }, 1000);
    const firstCall = tryConfirmApproval(sql, thirdApproval.id, thirdApproval.versionToken, 2000);
    const secondCall = tryConfirmApproval(sql, thirdApproval.id, thirdApproval.versionToken, 2001);
    expect(firstCall.status).toBe("confirmed");
    expect(secondCall.status).toBe("conflict");
  });

  test("TestClock + Fiber: a slow in-flight confirmation racing the cron sweep, interleaved by DETERMINISTIC virtual scheduling — the sweep's terminal status is never clobbered by the late call", async () => {
    const sql = makeSql();
    const approval = proposeApproval(sql, { actionType: "createEvent", payload: { summary: "Standup" } }, 1000);

    // Mirrors write-model.ts's REAL sequencing exactly: the CAS transition
    // (`tryConfirmApproval`) commits synchronously, fully BEFORE any
    // network `await` — done here, outside the Effect race below, exactly
    // as it happens in production (see approvals-store.ts's file header
    // "SEQUENCING MATTERS" argument, restated in write-model.ts).
    const confirmed = tryConfirmApproval(sql, approval.id, approval.versionToken, 2000);
    expect(confirmed.status).toBe("confirmed");

    const TIMEOUT_MS = 5 * 60_000; // same order of magnitude as write-model.ts's real APPROVAL_CONFIRMATION_TIMEOUT_MS
    const SWEEP_DELAY_MIN = 6; // cron sweep fires after the row has been stuck long enough
    const REMAINING_NETWORK_DELAY_MIN = 4; // slow caller's Google API round-trip resolves 4 minutes AFTER the sweep already fired

    const program = Effect.gen(function* () {
      // Fiber A: the slow in-flight caller — everything AFTER the CAS
      // commit above, modeled as a real forked fiber sleeping through the
      // "awaiting Google's API" gap before reaching `markExecuted`.
      const slowCaller = yield* Effect.fork(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.minutes(SWEEP_DELAY_MIN + REMAINING_NETWORK_DELAY_MIN));
          const nowMs = yield* TestClock.currentTimeMillis;
          markExecuted(sql, approval.id, { id: "google-event-late" }, nowMs);
          return "slow-caller-done" as const;
        }),
      );

      // Fiber B: the cron sweep, firing once after SWEEP_DELAY_MIN.
      const sweep = yield* Effect.fork(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.minutes(SWEEP_DELAY_MIN));
          const nowMs = yield* TestClock.currentTimeMillis;
          return reconcileStuckConfirmedApprovals(sql, TIMEOUT_MS, nowMs);
        }),
      );

      // Advance virtual time deterministically, in two steps, so the
      // sweep's sleep resolves and RUNS TO COMPLETION strictly before the
      // slow caller's sleep does — proving the interleaving order via
      // real Fiber scheduling + TestClock, not by hand-picking call order.
      yield* TestClock.adjust(Duration.minutes(SWEEP_DELAY_MIN));
      const reconciledIds = yield* Fiber.join(sweep);

      yield* TestClock.adjust(Duration.minutes(REMAINING_NETWORK_DELAY_MIN));
      const slowCallerOutcome = yield* Fiber.join(slowCaller);

      return { reconciledIds, slowCallerOutcome };
    }).pipe(Effect.provide(TestContext.TestContext));

    const { reconciledIds, slowCallerOutcome } = await Effect.runPromise(program);

    // The sweep genuinely ran and reconciled this exact approval.
    expect(reconciledIds).toEqual([approval.id]);
    // The slow caller's markExecuted DID run afterward (proving this is a
    // real race, not one side never executing) but its write was rejected
    // by the `AND status = 'confirmed'` guard — deterministically proven,
    // not just plausible.
    expect(slowCallerOutcome).toBe("slow-caller-done");

    const stored = getApproval(sql, approval.id);
    expect(stored?.status).toBe("failed"); // the sweep's outcome — NOT "executed"
    expect(stored?.result).toEqual({ error: expect.stringContaining("confirmation timed out") });
  });
});
