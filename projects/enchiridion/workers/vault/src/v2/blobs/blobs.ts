/** @enchiridion/effect-module */
import { Clock, Context, Data, Effect, Ref } from "effect";
import {
  type OwnerID,
  type RequestID,
  type VaultID,
  isOwnerID,
  isRequestID,
  isVaultID,
} from "../foundation/schemas";

export interface BlobScope {
  readonly ownerID: OwnerID;
  readonly vaultID: VaultID;
  readonly generationEpoch: number;
}

export interface BlobLimits {
  readonly maximumBlobBytes: number;
  readonly maximumVaultBytes: number;
  /** Caps physically retained, unreferenced immutable finals so failed work cannot accumulate. */
  readonly maximumOrphanBytes: number;
  readonly maximumOrphanCount: number;
  /** Bounds request-owned stage reservations for one owner/vault across generations. */
  readonly maximumActiveLeasesPerVault: number;
  /** Bounds concurrent request leases targeting one immutable final key. */
  readonly maximumActiveLeasesPerFinal: number;
  readonly stageTTLSeconds: number;
}

export interface BlobStageCommand {
  readonly scope: BlobScope;
  readonly requestID: RequestID;
  /** Signed caller operation identity; it fixes the otherwise-private staging namespace. */
  readonly operationID: RequestID;
  /** Canonical base64url random value supplied with the signed operation. */
  readonly stageRandom: string;
  readonly deviceID: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly body: Uint8Array;
  readonly nowSeconds: number;
}

export interface BlobReceipt {
  readonly requestID: string;
  readonly operationID: string;
  readonly stageKey: string;
  readonly canonicalFingerprint: string;
  readonly deviceID: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
  readonly response: BlobStageExecution;
}

export interface BlobAuthorization extends BlobScope {
  readonly deviceID: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
}

export interface BlobMetadata {
  readonly requestID: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly objectKey: string;
  readonly generationEpoch: number;
}

export interface BlobStageExecution {
  readonly metadata: BlobMetadata;
  /** A receipt is immutable: exact retry returns the original applied response. */
  readonly status: "APPLIED";
}

export class BlobOperationError extends Data.TaggedError("BlobOperationError")<{
  readonly reason:
    | "generation_stale"
    | "hash_failed"
    | "hash_mismatch"
    | "invalid_blob"
    | "final_verification_failed"
    | "publish_failed"
    | "quota_exceeded"
    | "replay_conflict"
    | "stage_conflict";
}> {}

/** Production SHA-256 belongs at the later audited runtime/platform adapter seam. */
export interface BlobContentHasher {
  readonly hash: (body: Uint8Array) => Effect.Effect<string, BlobOperationError>;
}
export const BlobContentHasher = Context.GenericTag<BlobContentHasher>(
  "@enchiridion/worker-vault/v2/BlobContentHasher",
);

export interface BlobStagingRepository {
  /**
   * Atomically revalidates the current device/generation policy and resolves an immutable ACK
   * before any quota, stage, or publish side effect. The caller has already verified the signed
   * request and its time validity before entering this blob boundary.
   */
  readonly preflightReceipt: (
    command: BlobStageCommand,
    canonicalFingerprint: string,
  ) => Effect.Effect<BlobStageExecution | undefined, BlobOperationError>;
  /** Reserves physical final-object capacity before any stage or publish write. */
  readonly reserveStage: (
    command: BlobStageCommand,
    stageKey: string,
    finalKey: string,
    nowSeconds: number,
  ) => Effect.Effect<void, BlobOperationError>;
  /** Writes an immutable private stage object. The interface deliberately exposes no staged read. */
  readonly stageImmutable: (
    stageKey: string,
    body: Uint8Array,
    nowSeconds: number,
  ) => Effect.Effect<void, BlobOperationError>;
  /** Copies a private stage to an immutable content-addressed final object. */
  readonly publishImmutable: (
    stageKey: string,
    finalKey: string,
    expectedHash: string,
    size: number,
    nowSeconds: number,
  ) => Effect.Effect<void, BlobOperationError>;
  /** Must succeed before metadata/ref/receipt mutation; final object is never exposed by this API. */
  readonly verifyFinal: (
    stageKey: string,
    finalKey: string,
    expectedHash: string,
    size: number,
    nowSeconds: number,
  ) => Effect.Effect<void, BlobOperationError>;
  /** Removes an uncommitted stage after a failed commit so failure cannot consume unbounded storage. */
  readonly discardStage: (stageKey: string) => Effect.Effect<void, BlobOperationError>;
  /** Releases only this request's lease; any published, unreferenced final becomes reclaimable. */
  readonly releaseReservation: (
    stageKey: string,
    nowSeconds: number,
  ) => Effect.Effect<void, BlobOperationError>;
  /** Atomically revalidates generation, quota, metadata/ref, and request receipt. */
  readonly commitStaged: (
    command: BlobStageCommand,
    stageKey: string,
    objectKey: string,
    nowSeconds: number,
  ) => Effect.Effect<BlobStageExecution, BlobOperationError>;
  readonly reconcileOrphans: (nowSeconds: number) => Effect.Effect<number, BlobOperationError>;
}
export const BlobStagingRepository = Context.GenericTag<BlobStagingRepository>(
  "@enchiridion/worker-vault/v2/BlobStagingRepository",
);

export interface BlobStagingService {
  readonly stage: (
    command: BlobStageCommand,
  ) => Effect.Effect<BlobStageExecution, BlobOperationError>;
  readonly reconcileOrphans: (nowSeconds: number) => Effect.Effect<number, BlobOperationError>;
}
export const BlobStagingService = Context.GenericTag<BlobStagingService>(
  "@enchiridion/worker-vault/v2/BlobStagingService",
);

const hashPattern = /^[a-f0-9]{64}$/u;
const pathSegment = /^[A-Za-z0-9._~-]{1,128}$/u;
const stageRandomPattern = /^[A-Za-z0-9_-]{22,128}$/u;
const deviceIdentifier = /^[A-Za-z0-9._~-]{1,128}$/u;
const validInteger = (value: number, minimum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum;
const validScope = (scope: BlobScope): boolean =>
  isOwnerID(scope.ownerID) && isVaultID(scope.vaultID) && validInteger(scope.generationEpoch, 0);

export const validBlobPath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.length >= 1 &&
  path.length <= 512 &&
  path
    .split("/")
    .every((segment) => pathSegment.test(segment) && segment !== "." && segment !== "..");

const scopePrefix = (scope: BlobScope): string =>
  `v2/${scope.ownerID.value}/${scope.vaultID.value}/g${scope.generationEpoch}`;

/** Namespace builders prevent a blob stage/object from crossing owner, vault, or generation. */
export const blobStageKey = (
  scope: BlobScope,
  sha256: string,
  operationID: RequestID,
  stageRandom: string,
): string | undefined =>
  validScope(scope) &&
  hashPattern.test(sha256) &&
  isRequestID(operationID) &&
  stageRandomPattern.test(stageRandom)
    ? `${scopePrefix(scope)}/stage/${sha256}/${operationID.value}/${stageRandom}`
    : undefined;
export const blobObjectKey = (scope: BlobScope, sha256: string): string | undefined =>
  validScope(scope) && hashPattern.test(sha256)
    ? `${scopePrefix(scope)}/blob/${sha256}`
    : undefined;

const failure = <A>(reason: BlobOperationError["reason"]): Effect.Effect<A, BlobOperationError> =>
  Effect.fail(new BlobOperationError({ reason }));

const validLimits = (limits: BlobLimits): boolean =>
  validInteger(limits.maximumBlobBytes, 1) &&
  validInteger(limits.maximumVaultBytes, limits.maximumBlobBytes) &&
  validInteger(limits.maximumOrphanBytes, 0) &&
  limits.maximumOrphanBytes <= limits.maximumVaultBytes &&
  validInteger(limits.maximumOrphanCount, 0) &&
  validInteger(limits.maximumActiveLeasesPerVault, 1) &&
  validInteger(limits.maximumActiveLeasesPerFinal, 1) &&
  validInteger(limits.stageTTLSeconds, 1);

const validAuthorization = (value: {
  readonly deviceID: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
}): boolean =>
  deviceIdentifier.test(value.deviceID) &&
  validInteger(value.authEpoch, 1) &&
  validInteger(value.credentialEpoch, 1);

const currentSeconds = Clock.currentTimeMillis.pipe(
  Effect.map((milliseconds) => Math.floor(milliseconds / 1_000)),
);

export const makeBlobStagingService = (limits: BlobLimits) =>
  Effect.gen(function* () {
    const repository = yield* BlobStagingRepository;
    const hasher = yield* BlobContentHasher;
    const stage = (
      command: BlobStageCommand,
    ): Effect.Effect<BlobStageExecution, BlobOperationError> => {
      if (
        !validLimits(limits) ||
        !validScope(command.scope) ||
        !isRequestID(command.requestID) ||
        !isRequestID(command.operationID) ||
        !stageRandomPattern.test(command.stageRandom) ||
        !validAuthorization(command) ||
        !validBlobPath(command.path) ||
        !hashPattern.test(command.sha256) ||
        !validInteger(command.size, 0) ||
        command.size > limits.maximumBlobBytes ||
        command.body.byteLength !== command.size ||
        !validInteger(command.nowSeconds, 0)
      )
        return failure("invalid_blob");
      const stageKey = blobStageKey(
        command.scope,
        command.sha256,
        command.operationID,
        command.stageRandom,
      );
      const objectKey = blobObjectKey(command.scope, command.sha256);
      if (stageKey === undefined || objectKey === undefined) return failure("invalid_blob");
      return Effect.flatMap(
        hasher
          .hash(command.body)
          .pipe(Effect.mapError(() => new BlobOperationError({ reason: "hash_failed" }))),
        (calculated) => {
          if (calculated !== command.sha256) return failure("hash_mismatch");
          return Effect.gen(function* () {
            const receipt = yield* repository.preflightReceipt(
              command,
              canonicalReceiptFingerprint(command),
            );
            if (receipt !== undefined) return receipt;
            // `command.nowSeconds` is signed request metadata. Each storage transition reads
            // the service clock anew so a request cannot keep a lease alive after it has elapsed.
            const reservedAtSeconds = yield* currentSeconds;
            yield* repository.reserveStage(command, stageKey, objectKey, reservedAtSeconds);
            const stagedAtSeconds = yield* currentSeconds;
            yield* repository.stageImmutable(stageKey, command.body, stagedAtSeconds);
            const publishedAtSeconds = yield* currentSeconds;
            yield* repository.publishImmutable(
              stageKey,
              objectKey,
              command.sha256,
              command.size,
              publishedAtSeconds,
            );
            const verifiedAtSeconds = yield* currentSeconds;
            yield* repository.verifyFinal(
              stageKey,
              objectKey,
              command.sha256,
              command.size,
              verifiedAtSeconds,
            );
            const committedAtSeconds = yield* currentSeconds;
            return yield* repository.commitStaged(command, stageKey, objectKey, committedAtSeconds);
          }).pipe(
            // Both cleanup actions are scoped to this request and cannot obscure the original error.
            Effect.tapError(() =>
              Effect.gen(function* () {
                const nowSeconds = yield* currentSeconds;
                yield* repository.discardStage(stageKey).pipe(Effect.catchAll(() => Effect.void));
                yield* repository
                  .releaseReservation(stageKey, nowSeconds)
                  .pipe(Effect.catchAll(() => Effect.void));
              }),
            ),
          );
        },
      );
    };
    return {
      stage,
      reconcileOrphans: repository.reconcileOrphans,
    } satisfies BlobStagingService;
  });

interface StagedObject {
  readonly body: Uint8Array;
  readonly createdAtSeconds: number;
  readonly scopeID: string;
}
interface FinalObject {
  readonly body: Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly scopeID: string;
  /** Undefined only while a valid request lease still protects this final. */
  readonly reclaimableAtSeconds: number | undefined;
}
interface BlobReservation {
  readonly finalKey: string;
  readonly scopeID: string;
  readonly ownerVaultID: string;
  readonly sha256: string;
  readonly size: number;
  readonly requestID: string;
  readonly operationID: string;
  readonly expiresAtSeconds: number;
  readonly state: "reserved" | "published" | "cleanup_pending";
}
interface BlobState {
  readonly activeGenerations: Readonly<Record<string, number>>;
  readonly activeAuthorizations: Readonly<Record<string, BlobAuthorization>>;
  readonly blobs: Readonly<Record<string, BlobMetadata>>;
  readonly receipts: Readonly<Record<string, BlobReceipt>>;
  readonly references: Readonly<Record<string, number>>;
  readonly staged: Readonly<Record<string, StagedObject>>;
  readonly reservations: Readonly<Record<string, BlobReservation>>;
  /** Private immutable final objects; unreachable finals are safe orphans, never deleted here. */
  readonly finals: Readonly<Record<string, FinalObject>>;
  /** Actual private staged + final object bytes; admission is calculated from reservations. */
  readonly physicalBytes: Readonly<Record<string, number>>;
}

const ownerVaultKey = (scope: BlobScope): string =>
  `${scope.ownerID.value}\u0000${scope.vaultID.value}`;
const currentGeneration = (state: BlobState, scope: BlobScope): number | undefined =>
  state.activeGenerations[ownerVaultKey(scope)];
const metadataKey = (scope: BlobScope, path: string): string =>
  `${scopePrefix(scope)}\u0000${path}`;
const receiptKey = (scope: BlobScope, requestID: RequestID): string =>
  `${scopePrefix(scope)}\u0000${requestID.value}`;
const authorizationKey = (scope: BlobScope, deviceID: string): string =>
  `${scopePrefix(scope)}\u0000${deviceID}`;

const canonicalReceiptFingerprint = (command: BlobStageCommand): string =>
  [
    command.operationID.value,
    command.requestID.value,
    command.stageRandom,
    command.path,
    command.sha256,
    String(command.size),
    command.deviceID,
    String(command.authEpoch),
    String(command.credentialEpoch),
  ].join("\u0000");

const authorizationIsCurrent = (state: BlobState, command: BlobStageCommand): boolean => {
  if (currentGeneration(state, command.scope) !== command.scope.generationEpoch) return false;
  const authorization =
    state.activeAuthorizations[authorizationKey(command.scope, command.deviceID)];
  return (
    authorization !== undefined &&
    authorization.generationEpoch === command.scope.generationEpoch &&
    authorization.authEpoch === command.authEpoch &&
    authorization.credentialEpoch === command.credentialEpoch
  );
};
const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
};

const hasCommittedFinal = (state: BlobState, finalKey: string): boolean =>
  (state.references[finalKey] ?? 0) > 0 ||
  Object.values(state.blobs).some((metadata) => metadata.objectKey === finalKey) ||
  Object.values(state.receipts).some((receipt) => receipt.response.metadata.objectKey === finalKey);

const reservationsForFinal = (
  reservations: Readonly<Record<string, BlobReservation>>,
  finalKey: string,
): readonly [string, BlobReservation][] =>
  Object.entries(reservations).filter(([, reservation]) => reservation.finalKey === finalKey);

interface FinalFamilyReservation {
  readonly finalKey: string;
  readonly size: number;
}

/**
 * Admission is intentionally more conservative than observed storage: every request lease
 * reserves a private stage, and every uncommitted hash family reserves a prospective final.
 * This remains true before publish, so concurrent uploads cannot race quota checks.
 */
const uncommittedFinalFamilies = (
  state: BlobState,
  scopeID: string,
): readonly FinalFamilyReservation[] => {
  const families = new Map<string, FinalFamilyReservation>();
  for (const [finalKey, final] of Object.entries(state.finals)) {
    if (final.scopeID === scopeID && !hasCommittedFinal(state, finalKey))
      families.set(finalKey, { finalKey, size: final.size });
  }
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.scopeID === scopeID && !hasCommittedFinal(state, reservation.finalKey))
      families.set(reservation.finalKey, {
        finalKey: reservation.finalKey,
        size: reservation.size,
      });
  }
  return [...families.values()];
};

const quotaUsage = (state: BlobState, scopeID: string) => {
  const referencedBytes = Object.entries(state.finals)
    .filter(([finalKey, final]) => final.scopeID === scopeID && hasCommittedFinal(state, finalKey))
    .reduce((total, [, final]) => total + final.size, 0);
  const stageReservedBytes = Object.values(state.reservations)
    .filter((reservation) => reservation.scopeID === scopeID)
    .reduce((total, reservation) => total + reservation.size, 0);
  const danglingStageBytes = Object.entries(state.staged)
    .filter(
      ([stageKey, stage]) =>
        stage.scopeID === scopeID && state.reservations[stageKey] === undefined,
    )
    .reduce((total, [, stage]) => total + stage.body.byteLength, 0);
  const uncommittedFamilies = uncommittedFinalFamilies(state, scopeID);
  const finalReservedBytes = uncommittedFamilies.reduce((total, family) => total + family.size, 0);
  return {
    referencedBytes,
    stageReservedBytes: stageReservedBytes + danglingStageBytes,
    finalReservedBytes,
    orphanCount: uncommittedFamilies.length,
    totalBytes: referencedBytes + stageReservedBytes + danglingStageBytes + finalReservedBytes,
  };
};

const activeLeasesForVault = (state: BlobState, ownerVaultID: string): number =>
  Object.values(state.reservations).filter(
    (reservation) => reservation.ownerVaultID === ownerVaultID,
  ).length;

/** Deterministic test repository; stage bytes remain private implementation state and are never returned by the service. */
export const makeInMemoryBlobStagingRepository = (
  limits: BlobLimits,
  activeScopes: readonly BlobScope[],
  activeAuthorizations: readonly BlobAuthorization[],
  faults: Readonly<{
    publish?: boolean;
    commit?: boolean;
    discard?: boolean;
    discardFailures?: number;
  }> = {},
) =>
  Effect.gen(function* () {
    const initialGenerations: Record<string, number> = {};
    for (const scope of activeScopes) {
      if (validScope(scope)) initialGenerations[ownerVaultKey(scope)] = scope.generationEpoch;
    }
    const initialAuthorizations: Record<string, BlobAuthorization> = {};
    for (const authorization of activeAuthorizations) {
      if (validScope(authorization) && validAuthorization(authorization))
        initialAuthorizations[authorizationKey(authorization, authorization.deviceID)] =
          authorization;
    }
    const state = yield* Ref.make<BlobState>({
      activeGenerations: initialGenerations,
      activeAuthorizations: initialAuthorizations,
      blobs: {},
      receipts: {},
      references: {},
      staged: {},
      reservations: {},
      finals: {},
      physicalBytes: {},
    });
    const semaphore = yield* Effect.makeSemaphore(1);
    let remainingDiscardFailures = faults.discardFailures ?? 0;
    const discardFails = (): boolean => {
      if (faults.discard) return true;
      if (remainingDiscardFailures < 1) return false;
      remainingDiscardFailures -= 1;
      return true;
    };
    const repository: BlobStagingRepository = {
      preflightReceipt: (command, fingerprint) =>
        semaphore.withPermits(1)(
          Effect.flatMap(Ref.get(state), (current) => {
            if (!authorizationIsCurrent(current, command)) return failure("generation_stale");
            const receipt = current.receipts[receiptKey(command.scope, command.requestID)];
            if (receipt === undefined) return Effect.succeed(undefined);
            return receipt.canonicalFingerprint === fingerprint &&
              receipt.deviceID === command.deviceID &&
              receipt.authEpoch === command.authEpoch &&
              receipt.credentialEpoch === command.credentialEpoch
              ? Effect.succeed(receipt.response)
              : failure("replay_conflict");
          }),
        ),
      reserveStage: (command, stageKey, finalKey, nowSeconds) =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            if (!validInteger(nowSeconds, 0)) return yield* failure("invalid_blob");
            const current = yield* Ref.get(state);
            const existing = current.reservations[stageKey];
            if (existing !== undefined) {
              if (
                existing.finalKey === finalKey &&
                existing.sha256 === command.sha256 &&
                existing.size === command.size &&
                existing.requestID === command.requestID.value &&
                existing.operationID === command.operationID.value &&
                existing.expiresAtSeconds > nowSeconds
              )
                return;
              return yield* failure("stage_conflict");
            }
            const scopeID = scopePrefix(command.scope);
            const final = current.finals[finalKey];
            const relatedReservations = reservationsForFinal(current.reservations, finalKey);
            if (
              (final !== undefined &&
                (final.sha256 !== command.sha256 ||
                  final.size !== command.size ||
                  final.scopeID !== scopeID)) ||
              relatedReservations.some(
                ([, reservation]) =>
                  reservation.sha256 !== command.sha256 ||
                  reservation.size !== command.size ||
                  reservation.scopeID !== scopeID,
              )
            )
              return yield* failure("stage_conflict");
            const ownerVaultID = ownerVaultKey(command.scope);
            const usage = quotaUsage(current, scopeID);
            const familyReserved = uncommittedFinalFamilies(current, scopeID).some(
              (family) => family.finalKey === finalKey,
            );
            const finalCharge =
              final !== undefined && hasCommittedFinal(current, finalKey)
                ? 0
                : familyReserved
                  ? 0
                  : command.size;
            if (
              activeLeasesForVault(current, ownerVaultID) >= limits.maximumActiveLeasesPerVault ||
              relatedReservations.length >= limits.maximumActiveLeasesPerFinal ||
              usage.totalBytes + command.size + finalCharge > limits.maximumVaultBytes ||
              usage.finalReservedBytes + finalCharge > limits.maximumOrphanBytes ||
              usage.orphanCount + (finalCharge > 0 ? 1 : 0) > limits.maximumOrphanCount
            )
              return yield* failure("quota_exceeded");
            const reservation: BlobReservation = {
              finalKey,
              scopeID,
              ownerVaultID,
              sha256: command.sha256,
              size: command.size,
              requestID: command.requestID.value,
              operationID: command.operationID.value,
              expiresAtSeconds: nowSeconds + limits.stageTTLSeconds,
              state: "reserved",
            };
            yield* Ref.set(state, {
              ...current,
              reservations: { ...current.reservations, [stageKey]: reservation },
              finals:
                final !== undefined && !hasCommittedFinal(current, finalKey)
                  ? {
                      ...current.finals,
                      [finalKey]: { ...final, reclaimableAtSeconds: undefined },
                    }
                  : current.finals,
            });
          }),
        ),
      stageImmutable: (stageKey, body, nowSeconds): Effect.Effect<void, BlobOperationError> =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            if (!validInteger(nowSeconds, 0)) return yield* failure("invalid_blob");
            const existing = yield* Ref.get(state);
            const reservation = existing.reservations[stageKey];
            if (reservation === undefined || reservation.expiresAtSeconds <= nowSeconds)
              return yield* failure("stage_conflict");
            const staged = existing.staged[stageKey];
            if (staged !== undefined) {
              if (!bytesEqual(staged.body, body)) return yield* failure("stage_conflict");
              return;
            }
            yield* Ref.update(state, (current) => ({
              ...current,
              staged: {
                ...current.staged,
                [stageKey]: {
                  body: new Uint8Array(body),
                  createdAtSeconds: nowSeconds,
                  scopeID: reservation.scopeID,
                },
              },
              physicalBytes: {
                ...current.physicalBytes,
                [reservation.scopeID]:
                  (current.physicalBytes[reservation.scopeID] ?? 0) + body.byteLength,
              },
            }));
          }),
        ),
      discardStage: (stageKey) =>
        semaphore.withPermits(1)(
          discardFails()
            ? failure("stage_conflict")
            : Ref.update(state, (current) => {
                const staged = current.staged[stageKey];
                const reservation = current.reservations[stageKey];
                return {
                  ...current,
                  staged: Object.fromEntries(
                    Object.entries(current.staged).filter(([key]) => key !== stageKey),
                  ),
                  physicalBytes:
                    staged !== undefined && reservation !== undefined
                      ? {
                          ...current.physicalBytes,
                          [reservation.scopeID]: Math.max(
                            0,
                            (current.physicalBytes[reservation.scopeID] ?? 0) -
                              staged.body.byteLength,
                          ),
                        }
                      : current.physicalBytes,
                };
              }),
        ),
      releaseReservation: (stageKey, nowSeconds) =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const reservation = current.reservations[stageKey];
            if (reservation === undefined) return;
            if (current.staged[stageKey] !== undefined) {
              yield* Ref.set(state, {
                ...current,
                reservations: {
                  ...current.reservations,
                  [stageKey]: { ...reservation, state: "cleanup_pending" as const },
                },
              });
              return;
            }
            const final = current.finals[reservation.finalKey];
            const reservations = Object.fromEntries(
              Object.entries(current.reservations).filter(([key]) => key !== stageKey),
            );
            const nextFinals =
              final !== undefined &&
              !hasCommittedFinal(current, reservation.finalKey) &&
              reservationsForFinal(reservations, reservation.finalKey).length === 0
                ? {
                    ...current.finals,
                    [reservation.finalKey]: { ...final, reclaimableAtSeconds: nowSeconds },
                  }
                : current.finals;
            yield* Ref.set(state, {
              ...current,
              reservations,
              finals: nextFinals,
            });
          }),
        ),
      publishImmutable: (stageKey, finalKey, expectedHash, size, nowSeconds) =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            if (!validInteger(nowSeconds, 0)) return yield* failure("invalid_blob");
            if (faults.publish) return yield* failure("publish_failed");
            const current = yield* Ref.get(state);
            const reservation = current.reservations[stageKey];
            if (
              reservation === undefined ||
              reservation.finalKey !== finalKey ||
              reservation.sha256 !== expectedHash ||
              reservation.size !== size ||
              reservation.state !== "reserved" ||
              reservation.expiresAtSeconds <= nowSeconds
            )
              return yield* failure("stage_conflict");
            const staged = current.staged[stageKey];
            if (staged === undefined || staged.body.byteLength !== size)
              return yield* failure("stage_conflict");
            const existing = current.finals[finalKey];
            if (existing !== undefined) {
              if (
                existing.sha256 !== expectedHash ||
                existing.size !== size ||
                !bytesEqual(existing.body, staged.body)
              )
                return yield* failure("stage_conflict");
              yield* Ref.set(state, {
                ...current,
                reservations: {
                  ...current.reservations,
                  [stageKey]: { ...reservation, state: "published" as const },
                },
              });
              return;
            }
            yield* Ref.update(state, (value) => ({
              ...value,
              reservations: {
                ...value.reservations,
                [stageKey]: { ...reservation, state: "published" as const },
              },
              finals: {
                ...value.finals,
                [finalKey]: {
                  body: new Uint8Array(staged.body),
                  sha256: expectedHash,
                  size,
                  scopeID: reservation.scopeID,
                  reclaimableAtSeconds: undefined,
                },
              },
              physicalBytes: {
                ...value.physicalBytes,
                [reservation.scopeID]: (value.physicalBytes[reservation.scopeID] ?? 0) + size,
              },
            }));
          }),
        ),
      verifyFinal: (stageKey, finalKey, expectedHash, size, nowSeconds) =>
        semaphore.withPermits(1)(
          Effect.flatMap(Ref.get(state), (current) => {
            if (!validInteger(nowSeconds, 0)) return failure("invalid_blob");
            const reservation = current.reservations[stageKey];
            const final = current.finals[finalKey];
            return reservation !== undefined &&
              reservation.state === "published" &&
              reservation.finalKey === finalKey &&
              reservation.sha256 === expectedHash &&
              reservation.size === size &&
              reservation.expiresAtSeconds > nowSeconds &&
              final !== undefined &&
              final.sha256 === expectedHash &&
              final.size === size
              ? Effect.void
              : failure("final_verification_failed");
          }),
        ),
      commitStaged: (
        command,
        stageKey,
        objectKey,
        nowSeconds,
      ): Effect.Effect<BlobStageExecution, BlobOperationError> =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            if (!validInteger(nowSeconds, 0))
              return yield* failure<BlobStageExecution>("invalid_blob");
            const current = yield* Ref.get(state);
            if (
              current.activeGenerations[ownerVaultKey(command.scope)] !==
              command.scope.generationEpoch
            )
              return yield* failure<BlobStageExecution>("generation_stale");
            const authorization =
              current.activeAuthorizations[authorizationKey(command.scope, command.deviceID)];
            if (
              authorization === undefined ||
              authorization.generationEpoch !== command.scope.generationEpoch ||
              authorization.authEpoch !== command.authEpoch ||
              authorization.credentialEpoch !== command.credentialEpoch
            )
              return yield* failure<BlobStageExecution>("generation_stale");
            const staged = current.staged[stageKey];
            if (staged === undefined || !bytesEqual(staged.body, command.body))
              return yield* failure<BlobStageExecution>("stage_conflict");
            const final = current.finals[objectKey];
            if (
              final === undefined ||
              final.sha256 !== command.sha256 ||
              final.size !== command.size ||
              !bytesEqual(final.body, command.body)
            )
              return yield* failure<BlobStageExecution>("final_verification_failed");
            const reservation = current.reservations[stageKey];
            if (
              reservation === undefined ||
              reservation.state !== "published" ||
              reservation.expiresAtSeconds <= nowSeconds ||
              reservation.finalKey !== objectKey ||
              reservation.requestID !== command.requestID.value ||
              reservation.operationID !== command.operationID.value
            )
              return yield* failure<BlobStageExecution>("stage_conflict");
            const receiptID = receiptKey(command.scope, command.requestID);
            const existingReceipt = current.receipts[receiptID];
            if (existingReceipt !== undefined) {
              if (
                existingReceipt.canonicalFingerprint === canonicalReceiptFingerprint(command) &&
                existingReceipt.deviceID === command.deviceID &&
                existingReceipt.authEpoch === command.authEpoch &&
                existingReceipt.credentialEpoch === command.credentialEpoch &&
                existingReceipt.stageKey === stageKey &&
                existingReceipt.operationID === command.operationID.value
              ) {
                yield* Ref.update(state, (value) => ({
                  ...value,
                  reservations: Object.fromEntries(
                    Object.entries(value.reservations).filter(([key]) => key !== stageKey),
                  ),
                  staged: Object.fromEntries(
                    Object.entries(value.staged).filter(([key]) => key !== stageKey),
                  ),
                  physicalBytes: {
                    ...value.physicalBytes,
                    [reservation.scopeID]: Math.max(
                      0,
                      (value.physicalBytes[reservation.scopeID] ?? 0) - staged.body.byteLength,
                    ),
                  },
                }));
                return existingReceipt.response;
              }
              return yield* failure<BlobStageExecution>("replay_conflict");
            }
            const blobID = metadataKey(command.scope, command.path);
            const prior = current.blobs[blobID];
            if (faults.commit) return yield* failure<BlobStageExecution>("stage_conflict");
            const metadata: BlobMetadata = {
              requestID: command.requestID.value,
              path: command.path,
              sha256: command.sha256,
              size: command.size,
              objectKey,
              generationEpoch: command.scope.generationEpoch,
            };
            const response: BlobStageExecution = { metadata, status: "APPLIED" };
            const receipt: BlobReceipt = {
              requestID: command.requestID.value,
              operationID: command.operationID.value,
              stageKey,
              canonicalFingerprint: canonicalReceiptFingerprint(command),
              deviceID: command.deviceID,
              authEpoch: command.authEpoch,
              credentialEpoch: command.credentialEpoch,
              response,
            };
            const nextReferences = {
              ...current.references,
              [objectKey]: (current.references[objectKey] ?? 0) + 1,
            };
            if (prior !== undefined) {
              const priorCount = nextReferences[prior.objectKey] ?? 0;
              nextReferences[prior.objectKey] = Math.max(0, priorCount - 1);
            }
            const nextFinals =
              prior !== undefined && (nextReferences[prior.objectKey] ?? 0) === 0
                ? {
                    ...current.finals,
                    [prior.objectKey]: {
                      ...(current.finals[prior.objectKey] ?? final),
                      reclaimableAtSeconds: nowSeconds,
                    },
                  }
                : current.finals;
            yield* Ref.set(state, {
              ...current,
              blobs: { ...current.blobs, [blobID]: metadata },
              receipts: { ...current.receipts, [receiptID]: receipt },
              references: nextReferences,
              reservations: Object.fromEntries(
                Object.entries(current.reservations).filter(([key]) => key !== stageKey),
              ),
              finals: nextFinals,
              staged: Object.fromEntries(
                Object.entries(current.staged).filter(([key]) => key !== stageKey),
              ),
              physicalBytes: {
                ...current.physicalBytes,
                [reservation.scopeID]: Math.max(
                  0,
                  (current.physicalBytes[reservation.scopeID] ?? 0) - staged.body.byteLength,
                ),
              },
            });
            return response;
          }),
        ),
      reconcileOrphans: (nowSeconds): Effect.Effect<number, BlobOperationError> =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            if (!validInteger(nowSeconds, 0)) return yield* failure<number>("invalid_blob");
            const current = yield* Ref.get(state);
            const physicalBytes = { ...current.physicalBytes };
            let reservations: Record<string, BlobReservation> = { ...current.reservations };
            let staged: Record<string, StagedObject> = { ...current.staged };
            let finals: Readonly<Record<string, FinalObject>> = { ...current.finals };
            const releasedFinalKeys = new Set<string>();
            let releasedLeases = 0;
            let deletedStages = 0;
            for (const [stageKey, reservation] of Object.entries(current.reservations)) {
              if (
                reservation.state !== "cleanup_pending" &&
                reservation.expiresAtSeconds > nowSeconds
              )
                continue;
              const stage = staged[stageKey];
              if (stage !== undefined && discardFails()) {
                reservations[stageKey] = { ...reservation, state: "cleanup_pending" };
                continue;
              }
              if (stage !== undefined) {
                const { [stageKey]: _deleted, ...remainingStages } = staged;
                staged = remainingStages;
                physicalBytes[stage.scopeID] = Math.max(
                  0,
                  (physicalBytes[stage.scopeID] ?? 0) - stage.body.byteLength,
                );
                deletedStages += 1;
              }
              const { [stageKey]: _released, ...remainingReservations } = reservations;
              reservations = remainingReservations;
              releasedFinalKeys.add(reservation.finalKey);
              releasedLeases += 1;
            }
            for (const finalKey of releasedFinalKeys) {
              const final = finals[finalKey];
              if (
                final !== undefined &&
                !hasCommittedFinal(current, finalKey) &&
                reservationsForFinal(reservations, finalKey).length === 0
              )
                finals = {
                  ...finals,
                  [finalKey]: { ...final, reclaimableAtSeconds: nowSeconds },
                };
            }
            const candidate: BlobState = {
              ...current,
              reservations,
              staged,
              finals,
              physicalBytes,
            };
            const reclaim = Object.entries(finals).filter(
              ([key, final]) =>
                final.reclaimableAtSeconds !== undefined &&
                final.reclaimableAtSeconds <= nowSeconds &&
                !hasCommittedFinal(candidate, key) &&
                reservationsForFinal(candidate.reservations, key).length === 0,
            );
            for (const [key, final] of reclaim) {
              const { [key]: _removed, ...remaining } = finals;
              finals = remaining;
              physicalBytes[final.scopeID] = Math.max(
                0,
                (physicalBytes[final.scopeID] ?? 0) - final.size,
              );
            }
            yield* Ref.set(state, { ...candidate, finals, physicalBytes });
            return releasedLeases + deletedStages + reclaim.length;
          }),
        ),
    };
    return { layer: Context.make(BlobStagingRepository, repository), repository, state };
  });
