import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { ownerID, vaultID } from "../foundation/schemas";
import { beginBackupPromotion, resumeBackupPromotion } from "./promotion";
import {
  BackupError,
  BackupPromotionCallbacks,
  BackupPromotionRepository,
  type BackupPromotionRun,
  type BackupScope,
  type BackupPromotionCallbacks as PromotionCallbacks,
  type BackupPromotionRepository as PromotionRepository,
} from "./types";

const owner = ownerID("owner-1");
const vault = vaultID("vault-1");
if (owner === undefined || vault === undefined) throw new Error("test identity invalid");
const source: BackupScope = { ownerID: owner, vaultID: vault, generationEpoch: 3 };
const target: BackupScope = { ownerID: owner, vaultID: vault, generationEpoch: 4 };
const run = {
  runID: "AAAAAAAAAAAAAAAA",
  backupID: "BBBBBBBBBBBBBBBB",
  source,
  target,
  expectedRoutingEpoch: 7,
  expectedSourceGenerationEpoch: source.generationEpoch,
  controlEpoch: 9,
};

const memoryRepository = (): {
  readonly repository: PromotionRepository;
  readonly runs: Map<string, BackupPromotionRun>;
} => {
  const runs = new Map<string, BackupPromotionRun>();
  return {
    runs,
    repository: {
      read: (runID) => Effect.succeed(runs.get(runID)),
      createIfSourceUnfenced: (next) => {
        const hasLiveSource = [...runs.values()].some(
          (candidate) =>
            candidate.source.ownerID.value === next.source.ownerID.value &&
            candidate.source.vaultID.value === next.source.vaultID.value &&
            candidate.source.generationEpoch === next.source.generationEpoch &&
            candidate.expectedRoutingEpoch === next.expectedRoutingEpoch &&
            candidate.status !== "PROMOTED",
        );
        if (runs.has(next.runID) || hasLiveSource) return Effect.succeed(false);
        runs.set(next.runID, next);
        return Effect.succeed(true);
      },
      compareAndSet: (expected, next) => {
        const current = runs.get(next.runID);
        const matched =
          (expected === undefined && current === undefined) ||
          (expected !== undefined &&
            current !== undefined &&
            current.revision === expected.revision);
        if (!matched || (current !== undefined && next.controlEpoch < current.controlEpoch))
          return Effect.succeed(false);
        runs.set(next.runID, next);
        return Effect.succeed(true);
      },
    },
  };
};

const callbacks = (
  events: string[],
  failure: "freeze" | "restore" | "validate" | "activate" | undefined = undefined,
): PromotionCallbacks => ({
  freezeSource: (_source: BackupScope, _epoch: number, runID: string) =>
    failure === "freeze"
      ? Effect.fail(new BackupError({ reason: "recovery_conflict" }))
      : Effect.sync(() => {
          events.push(`freeze:${runID}`);
          return "AAAAAAAAAAAAAAAA";
        }),
  restorePrivate: (_target: BackupScope, _highWater: string, runID: string) =>
    failure === "restore"
      ? Effect.fail(new BackupError({ reason: "integrity_failed" }))
      : Effect.sync(() => events.push(`restore:${runID}`)),
  validatePrivate: (_target: BackupScope, runID: string) =>
    failure === "validate"
      ? Effect.fail(new BackupError({ reason: "integrity_failed" }))
      : Effect.sync(() => {
          events.push(`validate:${runID}`);
          return "BBBBBBBBBBBBBBBB";
        }),
  activateTarget: (
    _source: BackupScope,
    _target: BackupScope,
    _routing: number,
    _epoch: number,
    runID: string,
  ) =>
    failure === "activate"
      ? Effect.fail(new BackupError({ reason: "promotion_rejected" }))
      : Effect.sync(() => events.push(`activate:${runID}`)),
});

const provide = <A>(
  effect: Effect.Effect<A, BackupError, PromotionRepository | PromotionCallbacks>,
  repository: PromotionRepository,
  callbackValues: PromotionCallbacks,
) =>
  Effect.provideService(
    Effect.provideService(effect, BackupPromotionRepository, repository),
    BackupPromotionCallbacks,
    callbackValues,
  );

describe("restartable v2 backup promotion", () => {
  test("freezes, restores privately, validates, CAS-promotes, and never reverses its pointer", async () => {
    const memory = memoryRepository();
    const events: string[] = [];
    const callbackValues = callbacks(events);
    await Effect.runPromise(provide(beginBackupPromotion(run), memory.repository, callbackValues));
    for (const status of [
      "FROZEN",
      "RESTORING",
      "READY_PRIVATE",
      "PROMOTING",
      "PROMOTED",
    ] as const) {
      const advanced = await Effect.runPromise(
        provide(resumeBackupPromotion(run.runID), memory.repository, callbackValues),
      );
      expect(advanced.status).toBe(status);
    }
    await Effect.runPromise(
      provide(resumeBackupPromotion(run.runID), memory.repository, callbackValues),
    );
    expect(events).toEqual([
      `freeze:${run.runID}`,
      `restore:${run.runID}`,
      `validate:${run.runID}`,
      `activate:${run.runID}`,
    ]);
  });

  test("fences concurrent writers, preserves a frozen source across crashes, and rejects lower control epochs", async () => {
    const memory = memoryRepository();
    const events: string[] = [];
    const failing = callbacks(events, "restore");
    await Effect.runPromise(provide(beginBackupPromotion(run), memory.repository, failing));
    const competing = await Effect.runPromiseExit(
      provide(beginBackupPromotion(run), memory.repository, failing),
    );
    expect(Exit.isFailure(competing)).toBe(true);
    const differentRun = await Effect.runPromiseExit(
      provide(
        beginBackupPromotion({ ...run, runID: "DDDDDDDDDDDDDDDD" }),
        memory.repository,
        failing,
      ),
    );
    expect(Exit.isFailure(differentRun)).toBe(true);
    await Effect.runPromise(provide(resumeBackupPromotion(run.runID), memory.repository, failing));
    const failedRestore = await Effect.runPromiseExit(
      provide(resumeBackupPromotion(run.runID), memory.repository, failing),
    );
    expect(Exit.isFailure(failedRestore)).toBe(true);
    expect(memory.runs.get(run.runID)?.status).toBe("FAILED");
    const current = memory.runs.get(run.runID);
    if (current === undefined) throw new Error("expected run");
    const lower = await Effect.runPromise(
      memory.repository.compareAndSet(current, {
        ...current,
        controlEpoch: current.controlEpoch - 1,
      }),
    );
    expect(lower).toBe(false);
  });

  test("records pre-routing callback failures as terminal but leaves a post-CAS retry forward-only", async () => {
    for (const failure of ["freeze", "restore", "validate"] as const) {
      const memory = memoryRepository();
      const events: string[] = [];
      const failureCallbacks = callbacks(events, failure);
      await Effect.runPromise(
        provide(beginBackupPromotion(run), memory.repository, failureCallbacks),
      );
      if (failure !== "freeze")
        await Effect.runPromise(
          provide(resumeBackupPromotion(run.runID), memory.repository, failureCallbacks),
        );
      if (failure === "validate")
        await Effect.runPromise(
          provide(resumeBackupPromotion(run.runID), memory.repository, failureCallbacks),
        );
      const exit = await Effect.runPromiseExit(
        provide(resumeBackupPromotion(run.runID), memory.repository, failureCallbacks),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(memory.runs.get(run.runID)?.status).toBe("FAILED");
    }

    const memory = memoryRepository();
    const events: string[] = [];
    const failingActivation = callbacks(events, "activate");
    await Effect.runPromise(
      provide(beginBackupPromotion(run), memory.repository, failingActivation),
    );
    for (let index = 0; index < 4; index += 1)
      await Effect.runPromise(
        provide(resumeBackupPromotion(run.runID), memory.repository, failingActivation),
      );
    const exit = await Effect.runPromiseExit(
      provide(resumeBackupPromotion(run.runID), memory.repository, failingActivation),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(memory.runs.get(run.runID)?.status).toBe("PROMOTING");
  });

  test("requires a fresh target and refuses a decreasing control overlay before any source action", async () => {
    const memory = memoryRepository();
    const events: string[] = [];
    const callbackValues = callbacks(events);
    const staleTarget = {
      ...run,
      runID: "CCCCCCCCCCCCCCCC",
      target: { ...source, generationEpoch: source.generationEpoch - 1 },
    };
    const rejected = await Effect.runPromiseExit(
      provide(beginBackupPromotion(staleTarget), memory.repository, callbackValues),
    );
    expect(Exit.isFailure(rejected)).toBe(true);
    expect(events).toEqual([]);

    await Effect.runPromise(provide(beginBackupPromotion(run), memory.repository, callbackValues));
    const current = memory.runs.get(run.runID);
    if (current === undefined) throw new Error("expected run");
    const lowerOverlay = await Effect.runPromise(
      memory.repository.compareAndSet(current, {
        ...current,
        controlEpoch: current.controlEpoch - 1,
      }),
    );
    expect(lowerOverlay).toBe(false);
    expect(events).toEqual([]);
  });

  test("rejects a cross-tenant target or mismatched expected source generation before fencing", async () => {
    const memory = memoryRepository();
    const events: string[] = [];
    const callbackValues = callbacks(events);
    const anotherOwner = ownerID("owner-2");
    if (anotherOwner === undefined) throw new Error("expected owner");
    const crossTenant = await Effect.runPromiseExit(
      provide(
        beginBackupPromotion({
          ...run,
          runID: "EEEEEEEEEEEEEEEE",
          target: { ...target, ownerID: anotherOwner },
        }),
        memory.repository,
        callbackValues,
      ),
    );
    expect(Exit.isFailure(crossTenant)).toBe(true);
    const wrongSourceGeneration = await Effect.runPromiseExit(
      provide(
        beginBackupPromotion({
          ...run,
          runID: "FFFFFFFFFFFFFFFF",
          expectedSourceGenerationEpoch: source.generationEpoch + 1,
        }),
        memory.repository,
        callbackValues,
      ),
    );
    expect(Exit.isFailure(wrongSourceGeneration)).toBe(true);
    expect(events).toEqual([]);
  });

  test("exact-decodes every persisted phase and never invokes callbacks for forged promotion evidence", async () => {
    const highWater = "AAAAAAAAAAAAAAAA";
    const validation = "BBBBBBBBBBBBBBBB";
    const frozenEvidence = {
      source,
      target,
      expectedRoutingEpoch: run.expectedRoutingEpoch,
      expectedSourceGenerationEpoch: run.expectedSourceGenerationEpoch,
      controlEpoch: run.controlEpoch,
      snapshotHighWater: highWater,
    };
    const readyPrivateEvidence = { ...frozenEvidence, validationDigest: validation };
    const malformed: readonly BackupPromotionRun[] = [
      {
        ...run,
        revision: 0,
        status: "FREEZE_REQUESTED",
        snapshotHighWater: highWater,
        frozenEvidence,
      },
      { ...run, revision: 1, status: "FROZEN", snapshotHighWater: highWater },
      { ...run, revision: 2, status: "RESTORING", snapshotHighWater: highWater },
      {
        ...run,
        revision: 3,
        status: "READY_PRIVATE",
        snapshotHighWater: highWater,
        frozenEvidence,
      },
      {
        ...run,
        revision: 4,
        status: "PROMOTING",
        snapshotHighWater: highWater,
        validationDigest: validation,
        frozenEvidence,
      },
      {
        ...run,
        revision: 5,
        status: "PROMOTED",
        snapshotHighWater: highWater,
        validationDigest: validation,
        frozenEvidence,
      },
      { ...run, revision: 3, status: "FAILED", validationDigest: validation },
      {
        ...run,
        revision: 4,
        status: "PROMOTING",
        snapshotHighWater: highWater,
        validationDigest: validation,
        frozenEvidence,
        readyPrivateEvidence: {
          ...readyPrivateEvidence,
          target: { ...target, generationEpoch: target.generationEpoch + 1 },
        },
      },
    ];
    for (const [index, forged] of malformed.entries()) {
      const memory = memoryRepository();
      const events: string[] = [];
      memory.runs.set(`${run.runID.slice(0, -1)}${index}`, {
        ...forged,
        runID: `${run.runID.slice(0, -1)}${index}`,
      });
      const exit = await Effect.runPromiseExit(
        provide(
          resumeBackupPromotion(`${run.runID.slice(0, -1)}${index}`),
          memory.repository,
          callbacks(events),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(events).toEqual([]);
    }
  });
});
