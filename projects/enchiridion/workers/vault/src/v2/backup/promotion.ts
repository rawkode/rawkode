/** @enchiridion/effect-module */
import { Effect } from "effect";
import { isOwnerID, isVaultID, ownerID, vaultID } from "../foundation/schemas";
import { validBackupScope } from "./canonical";
import {
  BackupError,
  BackupPromotionCallbacks,
  BackupPromotionRepository,
  type BackupPromotionRun,
  type BackupScope,
  backupFailure,
} from "./types";

const identifier = /^[A-Za-z0-9_-]{16,128}$/u;
const digest = /^[A-Za-z0-9_-]{16,256}$/u;
const validEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const sameScope = (left: BackupScope, right: BackupScope): boolean =>
  left.ownerID.value === right.ownerID.value &&
  left.vaultID.value === right.vaultID.value &&
  left.generationEpoch === right.generationEpoch;
const sameTenant = (left: BackupScope, right: BackupScope): boolean =>
  left.ownerID.value === right.ownerID.value && left.vaultID.value === right.vaultID.value;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const decodeScope = (value: unknown): BackupScope | undefined => {
  if (
    !record(value) ||
    !exactKeys(value, ["ownerID", "vaultID", "generationEpoch"]) ||
    !validEpoch(value.generationEpoch)
  )
    return undefined;
  const parsedOwnerID = isOwnerID(value.ownerID) ? value.ownerID : ownerID(value.ownerID);
  const parsedVaultID = isVaultID(value.vaultID) ? value.vaultID : vaultID(value.vaultID);
  if (parsedOwnerID === undefined || parsedVaultID === undefined) return undefined;
  const scope = {
    ownerID: parsedOwnerID,
    vaultID: parsedVaultID,
    generationEpoch: value.generationEpoch,
  };
  return validBackupScope(scope) ? scope : undefined;
};

const validBase = (run: BackupPromotionRun): boolean =>
  identifier.test(run.runID) &&
  identifier.test(run.backupID) &&
  validBackupScope(run.source) &&
  validBackupScope(run.target) &&
  sameTenant(run.source, run.target) &&
  !sameScope(run.source, run.target) &&
  run.target.generationEpoch > run.source.generationEpoch &&
  validEpoch(run.expectedRoutingEpoch) &&
  run.expectedSourceGenerationEpoch === run.source.generationEpoch &&
  validEpoch(run.controlEpoch) &&
  validEpoch(run.revision);

const sameBinding = (
  run: BackupPromotionRun,
  evidence: {
    readonly source: BackupScope;
    readonly target: BackupScope;
    readonly expectedRoutingEpoch: number;
    readonly expectedSourceGenerationEpoch: number;
    readonly controlEpoch: number;
  },
): boolean =>
  sameScope(run.source, evidence.source) &&
  sameScope(run.target, evidence.target) &&
  run.expectedRoutingEpoch === evidence.expectedRoutingEpoch &&
  run.expectedSourceGenerationEpoch === evidence.expectedSourceGenerationEpoch &&
  run.controlEpoch === evidence.controlEpoch;

const frozenEvidence = (
  run: BackupPromotionRun,
  snapshotHighWater: string,
): NonNullable<BackupPromotionRun["frozenEvidence"]> => ({
  source: run.source,
  target: run.target,
  expectedRoutingEpoch: run.expectedRoutingEpoch,
  expectedSourceGenerationEpoch: run.expectedSourceGenerationEpoch,
  controlEpoch: run.controlEpoch,
  snapshotHighWater,
});

const readyPrivateEvidence = (
  frozen: NonNullable<BackupPromotionRun["frozenEvidence"]>,
  validationDigest: string,
): NonNullable<BackupPromotionRun["readyPrivateEvidence"]> => ({ ...frozen, validationDigest });

/**
 * Storage is untrusted across code revisions and operator recovery. Decode every
 * persisted member exactly before handing any state to a callback. In particular
 * PROMOTING requires the two prior durable proofs, both bound to this exact run.
 */
const decodeRun = (value: unknown): BackupPromotionRun | undefined => {
  if (!record(value)) return undefined;
  const statuses = [
    "FAILED",
    "FREEZE_REQUESTED",
    "FROZEN",
    "PROMOTED",
    "PROMOTING",
    "READY_PRIVATE",
    "RESTORING",
  ] as const;
  const status =
    typeof value.status === "string" ? statuses.find((entry) => entry === value.status) : undefined;
  const required = [
    "runID",
    "backupID",
    "source",
    "target",
    "expectedRoutingEpoch",
    "expectedSourceGenerationEpoch",
    "controlEpoch",
    "revision",
    "status",
  ] as const;
  const optional = [
    "snapshotHighWater",
    "validationDigest",
    "frozenEvidence",
    "readyPrivateEvidence",
  ] as const;
  const knownKeys: readonly string[] = [...required, ...optional];
  if (!Object.keys(value).every((key) => knownKeys.includes(key))) return undefined;
  if (!required.every((key) => Object.hasOwn(value, key))) return undefined;
  const source = decodeScope(value.source);
  const target = decodeScope(value.target);
  if (
    source === undefined ||
    target === undefined ||
    typeof value.runID !== "string" ||
    typeof value.backupID !== "string" ||
    !validEpoch(value.expectedRoutingEpoch) ||
    !validEpoch(value.expectedSourceGenerationEpoch) ||
    !validEpoch(value.controlEpoch) ||
    !validEpoch(value.revision) ||
    status === undefined
  )
    return undefined;
  const run: BackupPromotionRun = {
    runID: value.runID,
    backupID: value.backupID,
    source,
    target,
    expectedRoutingEpoch: value.expectedRoutingEpoch,
    expectedSourceGenerationEpoch: value.expectedSourceGenerationEpoch,
    controlEpoch: value.controlEpoch,
    revision: value.revision,
    status,
  };
  if (!validBase(run)) return undefined;

  const decodeFrozen = (input: unknown) => {
    if (
      !record(input) ||
      !exactKeys(input, [
        "source",
        "target",
        "expectedRoutingEpoch",
        "expectedSourceGenerationEpoch",
        "controlEpoch",
        "snapshotHighWater",
      ])
    )
      return undefined;
    const evidenceSource = decodeScope(input.source);
    const evidenceTarget = decodeScope(input.target);
    if (
      evidenceSource === undefined ||
      evidenceTarget === undefined ||
      !validEpoch(input.expectedRoutingEpoch) ||
      !validEpoch(input.expectedSourceGenerationEpoch) ||
      !validEpoch(input.controlEpoch) ||
      typeof input.snapshotHighWater !== "string" ||
      !digest.test(input.snapshotHighWater)
    )
      return undefined;
    return {
      source: evidenceSource,
      target: evidenceTarget,
      expectedRoutingEpoch: input.expectedRoutingEpoch,
      expectedSourceGenerationEpoch: input.expectedSourceGenerationEpoch,
      controlEpoch: input.controlEpoch,
      snapshotHighWater: input.snapshotHighWater,
    };
  };
  const decodedFrozen =
    value.frozenEvidence === undefined ? undefined : decodeFrozen(value.frozenEvidence);
  if (value.frozenEvidence !== undefined && decodedFrozen === undefined) return undefined;
  const decodeReady = (input: unknown) => {
    if (
      !record(input) ||
      !exactKeys(input, [
        "source",
        "target",
        "expectedRoutingEpoch",
        "expectedSourceGenerationEpoch",
        "controlEpoch",
        "snapshotHighWater",
        "validationDigest",
      ])
    )
      return undefined;
    const { validationDigest, ...frozenInput } = input;
    const frozen = decodeFrozen(frozenInput);
    if (
      frozen === undefined ||
      typeof input.validationDigest !== "string" ||
      !digest.test(input.validationDigest)
    )
      return undefined;
    return { ...frozen, validationDigest: input.validationDigest };
  };
  const decodedReady =
    value.readyPrivateEvidence === undefined ? undefined : decodeReady(value.readyPrivateEvidence);
  if (value.readyPrivateEvidence !== undefined && decodedReady === undefined) return undefined;
  const highWater = value.snapshotHighWater;
  const validation = value.validationDigest;
  if (
    (highWater !== undefined && (typeof highWater !== "string" || !digest.test(highWater))) ||
    (validation !== undefined && (typeof validation !== "string" || !digest.test(validation)))
  )
    return undefined;
  const frozenBound =
    decodedFrozen !== undefined &&
    sameBinding(run, decodedFrozen) &&
    highWater === decodedFrozen.snapshotHighWater;
  const readyBound =
    decodedReady !== undefined &&
    sameBinding(run, decodedReady) &&
    frozenBound &&
    decodedReady.snapshotHighWater === highWater &&
    validation === decodedReady.validationDigest;
  const noEvidence =
    highWater === undefined &&
    validation === undefined &&
    decodedFrozen === undefined &&
    decodedReady === undefined;
  const frozenOnly = frozenBound && validation === undefined && decodedReady === undefined;
  const ready = readyBound;
  const phaseValid =
    status === "FREEZE_REQUESTED"
      ? noEvidence
      : status === "FROZEN" || status === "RESTORING"
        ? frozenOnly
        : status === "READY_PRIVATE" || status === "PROMOTING" || status === "PROMOTED"
          ? ready
          : status === "FAILED"
            ? noEvidence || frozenOnly || ready
            : false;
  return phaseValid
    ? {
        ...run,
        ...(highWater === undefined ? {} : { snapshotHighWater: highWater }),
        ...(validation === undefined ? {} : { validationDigest: validation }),
        ...(decodedFrozen === undefined ? {} : { frozenEvidence: decodedFrozen }),
        ...(decodedReady === undefined ? {} : { readyPrivateEvidence: decodedReady }),
      }
    : undefined;
};

const next = (
  run: BackupPromotionRun,
  update: Omit<BackupPromotionRun, "revision">,
): BackupPromotionRun => ({
  ...update,
  revision: run.revision + 1,
});

const persist = (current: BackupPromotionRun, candidate: BackupPromotionRun) =>
  Effect.gen(function* () {
    const repository = yield* BackupPromotionRepository;
    if (decodeRun(candidate) === undefined || candidate.controlEpoch < current.controlEpoch)
      return yield* backupFailure<never>("recovery_conflict");
    const stored = yield* repository.compareAndSet(current, candidate);
    if (!stored) return yield* backupFailure<never>("recovery_conflict");
    return candidate;
  });

/** Before routing CAS, a callback failure is durably terminal and never
 * re-opens the source. `PROMOTING` deliberately does not use this path. */
const failBeforePromotion = (current: BackupPromotionRun, error: BackupError) =>
  persist(current, next(current, { ...current, status: "FAILED" })).pipe(
    Effect.flatMap(() => Effect.fail(error)),
  );

/** Creates exactly one independently fenced recovery run. */
export const beginBackupPromotion = (run: Omit<BackupPromotionRun, "revision" | "status">) =>
  Effect.gen(function* () {
    const repository = yield* BackupPromotionRepository;
    const initial: BackupPromotionRun = { ...run, revision: 0, status: "FREEZE_REQUESTED" };
    if (decodeRun(initial) === undefined) return yield* backupFailure<never>("recovery_conflict");
    const created = yield* repository.createIfSourceUnfenced(initial);
    if (!created) return yield* backupFailure<never>("recovery_conflict");
    return initial;
  });

/**
 * Executes one idempotent durable transition. A crash resumes from the last
 * CAS state. After `PROMOTING` no state can return to source ownership: a
 * callback fault leaves the run forward-only for retry/operational repair.
 */
export const resumeBackupPromotion = (runID: string) =>
  Effect.gen(function* () {
    const repository = yield* BackupPromotionRepository;
    const callbacks = yield* BackupPromotionCallbacks;
    if (!identifier.test(runID)) return yield* backupFailure<never>("recovery_conflict");
    const persisted = yield* repository.read(runID);
    const current = persisted === undefined ? undefined : decodeRun(persisted);
    if (current === undefined) return yield* backupFailure<never>("recovery_conflict");
    switch (current.status) {
      case "FAILED":
      case "PROMOTED":
        return current;
      case "FREEZE_REQUESTED": {
        const highWater = yield* callbacks
          .freezeSource(current.source, current.controlEpoch, current.runID)
          .pipe(Effect.catchAll((error) => failBeforePromotion(current, error)));
        if (!digest.test(highWater))
          return yield* failBeforePromotion(
            current,
            new BackupError({ reason: "recovery_conflict" }),
          );
        return yield* persist(
          current,
          next(current, {
            ...current,
            status: "FROZEN",
            snapshotHighWater: highWater,
            frozenEvidence: frozenEvidence(current, highWater),
          }),
        );
      }
      case "FROZEN": {
        if (current.snapshotHighWater === undefined)
          return yield* backupFailure<never>("recovery_conflict");
        yield* callbacks
          .restorePrivate(current.target, current.snapshotHighWater, current.runID)
          .pipe(Effect.catchAll((error) => failBeforePromotion(current, error)));
        return yield* persist(current, next(current, { ...current, status: "RESTORING" }));
      }
      case "RESTORING": {
        if (current.frozenEvidence === undefined)
          return yield* backupFailure<never>("recovery_conflict");
        const validationDigest = yield* callbacks
          .validatePrivate(current.target, current.runID)
          .pipe(Effect.catchAll((error) => failBeforePromotion(current, error)));
        if (!digest.test(validationDigest))
          return yield* failBeforePromotion(
            current,
            new BackupError({ reason: "integrity_failed" }),
          );
        return yield* persist(
          current,
          next(current, {
            ...current,
            status: "READY_PRIVATE",
            validationDigest,
            readyPrivateEvidence: readyPrivateEvidence(current.frozenEvidence, validationDigest),
          }),
        );
      }
      case "READY_PRIVATE":
        if (current.validationDigest === undefined || current.readyPrivateEvidence === undefined)
          return yield* backupFailure<never>("integrity_failed");
        return yield* persist(current, next(current, { ...current, status: "PROMOTING" }));
      case "PROMOTING":
        yield* callbacks
          .activateTarget(
            current.source,
            current.target,
            current.expectedRoutingEpoch,
            current.controlEpoch,
            current.runID,
          )
          .pipe(Effect.catchAll(() => backupFailure<void>("promotion_rejected")));
        return yield* persist(current, next(current, { ...current, status: "PROMOTED" }));
    }
  });
