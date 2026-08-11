import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Ref, TestClock, TestContext } from "effect";
import { ownerID, requestID, vaultID } from "../foundation/schemas";
import {
  type BlobAuthorization,
  BlobContentHasher,
  type BlobContentHasher as BlobContentHasherService,
  type BlobLimits,
  type BlobOperationError,
  type BlobScope,
  type BlobStageCommand,
  BlobStagingRepository,
  blobObjectKey,
  blobStageKey,
  makeBlobStagingService,
  makeInMemoryBlobStagingRepository,
  validBlobPath,
} from "./blobs";

const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("invalid test setup");
  return value;
};

const limits = {
  maximumBlobBytes: 8,
  maximumVaultBytes: 10,
  maximumOrphanBytes: 8,
  maximumOrphanCount: 2,
  maximumActiveLeasesPerVault: 32,
  maximumActiveLeasesPerFinal: 32,
  stageTTLSeconds: 10,
};
const scope: BlobScope = {
  ownerID: required(ownerID("owner-1")),
  vaultID: required(vaultID("vault-1")),
  generationEpoch: 4,
};
const request = required(requestID("blob-request-00000001"));
const operation = required(requestID("blob-operation-00000001"));
const body = new Uint8Array([1, 2, 3]);
const hash = "a".repeat(64);
const command = (changes: Partial<BlobStageCommand> = {}): BlobStageCommand => ({
  scope,
  requestID: request,
  operationID: operation,
  stageRandom: "AQEBAQEBAQEBAQEBAQEBAQ",
  deviceID: "device-1",
  authEpoch: 1,
  credentialEpoch: 1,
  path: "notes/today",
  sha256: hash,
  size: body.byteLength,
  body,
  nowSeconds: 100,
  ...changes,
});

const service = async (
  hasher: BlobContentHasherService,
  activeScopes: readonly BlobScope[] = [scope],
  activeAuthorizations: readonly BlobAuthorization[] = [
    { ...scope, deviceID: "device-1", authEpoch: 1, credentialEpoch: 1 },
  ],
  faults: Readonly<{
    publish?: boolean;
    commit?: boolean;
    discard?: boolean;
    discardFailures?: number;
  }> = {},
  providedLimits: BlobLimits = limits,
) => {
  const repository = await Effect.runPromise(
    makeInMemoryBlobStagingRepository(providedLimits, activeScopes, activeAuthorizations, faults),
  );
  const blobService = await Effect.runPromise(
    makeBlobStagingService(providedLimits).pipe(
      Effect.provideService(BlobStagingRepository, repository.repository),
      Effect.provideService(BlobContentHasher, hasher),
    ),
  );
  return { ...repository, blobService };
};

const matchingHasher: BlobContentHasherService = {
  hash: (value) => Effect.succeed(value.byteLength === 8 ? "b".repeat(64) : hash),
};

describe("v2 blob staging", () => {
  test("builds owner/vault/generation-isolated keys and atomically commits a private stage", async () => {
    const differentOwner: BlobScope = { ...scope, ownerID: required(ownerID("owner-2")) };
    const differentVault: BlobScope = { ...scope, vaultID: required(vaultID("vault-2")) };
    const differentGeneration: BlobScope = { ...scope, generationEpoch: 5 };
    expect(blobStageKey(scope, hash, operation, "AQEBAQEBAQEBAQEBAQEBAQ")).not.toBe(
      blobStageKey(differentOwner, hash, operation, "AQEBAQEBAQEBAQEBAQEBAQ"),
    );
    expect(blobStageKey(scope, hash, operation, "AQEBAQEBAQEBAQEBAQEBAQ")).not.toBe(
      blobStageKey(differentVault, hash, operation, "AQEBAQEBAQEBAQEBAQEBAQ"),
    );
    expect(blobObjectKey(scope, hash)).not.toBe(blobObjectKey(differentGeneration, hash));

    const built = await service(matchingHasher);
    const first = await Effect.runPromise(built.blobService.stage(command()));
    const duplicate = await Effect.runPromise(built.blobService.stage(command()));
    const repeatedDuplicate = await Effect.runPromise(built.blobService.stage(command()));
    expect(first.status).toBe("APPLIED");
    expect(duplicate).toEqual(first);
    expect(repeatedDuplicate).toEqual(first);
    let state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.keys(state.staged)).toEqual([]);
    expect(Object.values(state.references)).toEqual([1]);
    expect(Object.values(state.physicalBytes)).toEqual([body.byteLength]);
    expect(
      await Effect.runPromise(built.blobService.reconcileOrphans(Number.MAX_SAFE_INTEGER)),
    ).toBe(0);
    state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.values(state.physicalBytes)).toEqual([body.byteLength]);
  });

  test("preflights an exact eight-byte receipt without reserving a replay stage", async () => {
    const replayLimits: BlobLimits = {
      ...limits,
      maximumVaultBytes: 16,
      maximumOrphanBytes: 8,
    };
    const built = await service(matchingHasher, undefined, undefined, {}, replayLimits);
    const eightByte = command({
      sha256: "b".repeat(64),
      size: 8,
      body: new Uint8Array(8),
      path: "notes/eight-replay",
    });
    const first = await Effect.runPromise(built.blobService.stage(eightByte));
    const replay = await Effect.runPromise(built.blobService.stage(eightByte));
    expect(replay).toEqual(first);
    let state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.keys(state.reservations)).toEqual([]);
    expect(Object.keys(state.staged)).toEqual([]);
    expect(Object.values(state.physicalBytes)).toEqual([8]);
    const changedOperation = await Effect.runPromiseExit(
      built.blobService.stage(
        command({
          ...eightByte,
          operationID: required(requestID("blob-operation-replay-02")),
        }),
      ),
    );
    const changedStageRandom = await Effect.runPromiseExit(
      built.blobService.stage({ ...eightByte, stageRandom: "CQkJCQkJCQkJCQkJCQkJCQ" }),
    );
    expect(JSON.stringify(changedOperation)).toContain("replay_conflict");
    expect(JSON.stringify(changedStageRandom)).toContain("replay_conflict");
    state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.keys(state.reservations)).toEqual([]);
    expect(Object.keys(state.staged)).toEqual([]);
    expect(Object.values(state.physicalBytes)).toEqual([8]);
    await Effect.runPromise(
      Ref.update(built.state, (current) => ({
        ...current,
        activeAuthorizations: {
          ...current.activeAuthorizations,
          [`v2/${scope.ownerID.value}/${scope.vaultID.value}/g${scope.generationEpoch}\u0000device-1`]:
            {
              ...scope,
              deviceID: "device-1",
              authEpoch: 2,
              credentialEpoch: 1,
            },
        },
      })),
    );
    const staleAuthorization = await Effect.runPromiseExit(built.blobService.stage(eightByte));
    expect(JSON.stringify(staleAuthorization)).toContain("generation_stale");
  });

  test("keeps cleanup-pending stage and quota on a failed discard until reconciliation deletes it", async () => {
    const selectiveHasher: BlobContentHasherService = {
      hash: (value) => Effect.succeed(value[0] === 2 ? "c".repeat(64) : hash),
    };
    const built = await service(selectiveHasher, undefined, undefined, {
      commit: true,
      discardFailures: 1,
    });
    const failed = await Effect.runPromiseExit(built.blobService.stage(command()));
    expect(JSON.stringify(failed)).toContain("stage_conflict");
    const stageKey = required(blobStageKey(scope, hash, operation, "AQEBAQEBAQEBAQEBAQEBAQ"));
    let state = await Effect.runPromise(Ref.get(built.state));
    expect(state.reservations[stageKey]?.state).toBe("cleanup_pending");
    expect(Object.values(state.physicalBytes)).toEqual([6]);

    const blocked = await Effect.runPromiseExit(
      built.blobService.stage(
        command({
          requestID: required(requestID("blob-request-cleanup-02")),
          operationID: required(requestID("blob-operation-cleanup-02")),
          stageRandom: "CAgICAgICAgICAgICAgICA",
          path: "notes/blocked",
          sha256: "c".repeat(64),
          body: new Uint8Array([2, 2, 2]),
          size: 3,
        }),
      ),
    );
    expect(JSON.stringify(blocked)).toContain("quota_exceeded");

    await Effect.runPromise(built.repository.releaseReservation(stageKey, 100));
    expect(await Effect.runPromise(built.blobService.reconcileOrphans(100))).toBe(3);
    await Effect.runPromise(built.repository.releaseReservation(stageKey, 100));
    expect(await Effect.runPromise(built.blobService.reconcileOrphans(100))).toBe(0);
    state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.keys(state.reservations)).toEqual([]);
    expect(Object.keys(state.staged)).toEqual([]);
    expect(Object.keys(state.finals)).toEqual([]);
    expect(Object.values(state.physicalBytes)).toEqual([0]);
  });

  test("rejects changed replay, body/hash mismatch, quota excess, and stale generation", async () => {
    const built = await service(matchingHasher);
    await Effect.runPromise(built.blobService.stage(command()));
    const replay = await Effect.runPromiseExit(
      built.blobService.stage(command({ path: "notes/tomorrow" })),
    );
    expect(JSON.stringify(replay)).toContain("replay_conflict");
    const mismatch = await Effect.runPromiseExit(
      built.blobService.stage(command({ sha256: "b".repeat(64) })),
    );
    expect(JSON.stringify(mismatch)).toContain("hash_mismatch");
    const quota = await Effect.runPromiseExit(
      built.blobService.stage(
        command({
          requestID: required(requestID("blob-request-00000002")),
          path: "notes/large",
          sha256: "b".repeat(64),
          body: new Uint8Array(8),
          size: 8,
        }),
      ),
    );
    expect(JSON.stringify(quota)).toContain("quota_exceeded");

    const staleScope: BlobScope = { ...scope, generationEpoch: 5 };
    const stale = await service(matchingHasher, [scope]);
    const staleExit = await Effect.runPromiseExit(
      stale.blobService.stage(
        command({ scope: staleScope, requestID: required(requestID("blob-request-00000003")) }),
      ),
    );
    expect(Exit.isFailure(staleExit)).toBe(true);
    expect(JSON.stringify(staleExit)).toContain("generation_stale");
    expect(Object.keys((await Effect.runPromise(Ref.get(built.state))).staged)).toEqual([]);
    expect(Object.keys((await Effect.runPromise(Ref.get(stale.state))).staged)).toEqual([]);
  });

  test("admits a stage only when its stage and prospective final are both quota-reserved", async () => {
    const built = await service(matchingHasher);
    const rejected = await Effect.runPromiseExit(
      built.blobService.stage(
        command({
          sha256: "b".repeat(64),
          body: new Uint8Array(8),
          size: 8,
          path: "notes/eight",
        }),
      ),
    );
    expect(JSON.stringify(rejected)).toContain("quota_exceeded");
    const state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.values(state.physicalBytes)).toEqual([]);
    expect(Object.keys(state.reservations)).toEqual([]);
  });

  test("bounds twenty concurrent same-hash ten-byte leases before any storage write", async () => {
    const probeLimits = {
      ...limits,
      maximumBlobBytes: 10,
      maximumVaultBytes: 230,
      maximumOrphanBytes: 20,
      maximumOrphanCount: 2,
      maximumActiveLeasesPerVault: 21,
      maximumActiveLeasesPerFinal: 20,
    };
    const built = await Effect.runPromise(
      makeInMemoryBlobStagingRepository(
        probeLimits,
        [scope],
        [{ ...scope, deviceID: "device-1", authEpoch: 1, credentialEpoch: 1 }],
      ),
    );
    const makeTenByteCommand = (index: number, value = "d") => {
      const requestIDValue = required(
        requestID(`blob-request-20-${index.toString().padStart(2, "0")}`),
      );
      const operationIDValue = required(
        requestID(`blob-operation-20-${index.toString().padStart(2, "0")}`),
      );
      const stageRandom = `${"A".repeat(20)}${index.toString().padStart(2, "0")}`;
      const next = command({
        requestID: requestIDValue,
        operationID: operationIDValue,
        stageRandom,
        sha256: value.repeat(64),
        size: 10,
        body: new Uint8Array(10),
        path: `notes/lease-${index}`,
      });
      return {
        command: next,
        stageKey: required(blobStageKey(scope, next.sha256, operationIDValue, stageRandom)),
        finalKey: required(blobObjectKey(scope, next.sha256)),
      };
    };
    const leases = Array.from({ length: 20 }, (_, index) => makeTenByteCommand(index));
    await Effect.runPromise(
      Effect.all(
        leases.map(({ command: next, stageKey, finalKey }) =>
          built.repository.reserveStage(next, stageKey, finalKey, 100),
        ),
        { concurrency: "unbounded" },
      ),
    );
    await Effect.runPromise(
      Effect.all(
        leases.map(({ command: next, stageKey }) =>
          built.repository.stageImmutable(stageKey, next.body, 100),
        ),
        { concurrency: "unbounded" },
      ),
    );
    const first = leases[0];
    if (first === undefined) throw new Error("missing lease probe");
    await Effect.runPromise(
      built.repository.publishImmutable(
        first.stageKey,
        first.finalKey,
        first.command.sha256,
        first.command.size,
        100,
      ),
    );
    let state = await Effect.runPromise(Ref.get(built.state));
    // 20 private stages (200) plus one shared prospective final (10) exactly consume the
    // 210-byte reservation charge; observed physical bytes cannot exceed that admission.
    expect(Object.values(state.physicalBytes).reduce((total, bytes) => total + bytes, 0)).toBe(210);
    const perFinalRejected = await Effect.runPromiseExit(
      (() => {
        const next = makeTenByteCommand(20);
        return built.repository.reserveStage(next.command, next.stageKey, next.finalKey, 100);
      })(),
    );
    expect(JSON.stringify(perFinalRejected)).toContain("quota_exceeded");

    const differentFinal = makeTenByteCommand(21, "e");
    await Effect.runPromise(
      built.repository.reserveStage(
        differentFinal.command,
        differentFinal.stageKey,
        differentFinal.finalKey,
        100,
      ),
    );
    const perVaultRejected = await Effect.runPromiseExit(
      (() => {
        const next = makeTenByteCommand(22, "f");
        return built.repository.reserveStage(next.command, next.stageKey, next.finalKey, 100);
      })(),
    );
    expect(JSON.stringify(perVaultRejected)).toContain("quota_exceeded");
    state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.keys(state.reservations)).toHaveLength(21);
    // Twenty staged leases/final (210 actual bytes) plus the second family (20 reserved bytes)
    // stays within the 230-byte admission bound before that second family is written.
    expect(
      Object.values(state.physicalBytes).reduce((total, bytes) => total + bytes, 0),
    ).toBeLessThanOrEqual(230);
  });

  test("rejects a third unique reservation before writes when orphan reservations are capped", async () => {
    const probeLimits = {
      ...limits,
      maximumBlobBytes: 4,
      maximumVaultBytes: 32,
      maximumOrphanBytes: 8,
      maximumOrphanCount: 2,
      maximumActiveLeasesPerVault: 8,
      maximumActiveLeasesPerFinal: 4,
    };
    const built = await Effect.runPromise(
      makeInMemoryBlobStagingRepository(
        probeLimits,
        [scope],
        [{ ...scope, deviceID: "device-1", authEpoch: 1, credentialEpoch: 1 }],
      ),
    );
    const effects = ["a", "b", "c"].map((value, index) => {
      const requestIDValue = required(requestID(`blob-request-u-${index}`));
      const operationIDValue = required(requestID(`blob-operation-u-${index}`));
      const stageRandom = `${"B".repeat(21)}${index}`;
      const next = command({
        requestID: requestIDValue,
        operationID: operationIDValue,
        stageRandom,
        sha256: value.repeat(64),
        size: 4,
        body: new Uint8Array(4),
        path: `notes/unique-${index}`,
      });
      return built.repository
        .reserveStage(
          next,
          required(blobStageKey(scope, next.sha256, operationIDValue, stageRandom)),
          required(blobObjectKey(scope, next.sha256)),
          100,
        )
        .pipe(Effect.exit);
    });
    const outcomes = await Effect.runPromise(Effect.all(effects, { concurrency: "unbounded" }));
    expect(outcomes.filter(Exit.isSuccess)).toHaveLength(2);
    expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);
    const state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.keys(state.reservations)).toHaveLength(2);
    expect(Object.values(state.physicalBytes)).toEqual([]);
  });

  test("uses request-owned stages, keeps same-hash finals immutable, and replays the exact receipt", async () => {
    const built = await service(matchingHasher);
    const [first, second] = await Effect.runPromise(
      Effect.all(
        [
          built.blobService.stage(command()),
          built.blobService.stage(
            command({
              requestID: required(requestID("blob-request-00000002")),
              operationID: required(requestID("blob-operation-00000002")),
              stageRandom: "AgICAgICAgICAgICAgICAg",
              path: "notes/tomorrow",
            }),
          ),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(first.metadata.objectKey).toBe(second.metadata.objectKey);
    expect(Object.values((await Effect.runPromise(Ref.get(built.state))).finals)).toHaveLength(1);
    expect(Object.values((await Effect.runPromise(Ref.get(built.state))).references)).toEqual([2]);
    expect(first.status).toBe("APPLIED");
  });

  test("shares one live final lease across interleaved requests and never reclaims it during peer cleanup", async () => {
    const built = await service(matchingHasher);
    const first = command();
    const second = command({
      requestID: required(requestID("blob-request-00000002")),
      operationID: required(requestID("blob-operation-00000002")),
      stageRandom: "AgICAgICAgICAgICAgICAg",
      path: "notes/other",
    });
    const firstStage = required(
      blobStageKey(first.scope, first.sha256, first.operationID, first.stageRandom),
    );
    const secondStage = required(
      blobStageKey(second.scope, second.sha256, second.operationID, second.stageRandom),
    );
    const objectKey = required(blobObjectKey(scope, hash));

    await Effect.runPromise(built.repository.reserveStage(first, firstStage, objectKey, 100));
    await Effect.runPromise(built.repository.reserveStage(second, secondStage, objectKey, 100));
    await Effect.runPromise(
      built.repository.stageImmutable(firstStage, first.body, first.nowSeconds),
    );
    await Effect.runPromise(
      built.repository.stageImmutable(secondStage, second.body, second.nowSeconds),
    );
    await Effect.runPromise(
      built.repository.publishImmutable(
        firstStage,
        objectKey,
        first.sha256,
        first.size,
        first.nowSeconds,
      ),
    );

    // Simulate A's failed metadata path cleaning its own lease while B remains in flight.
    await Effect.runPromise(built.repository.releaseReservation(firstStage, first.nowSeconds));
    // Reconciliation discards/releases A's private stage, but cannot reclaim B's shared final.
    expect(await Effect.runPromise(built.blobService.reconcileOrphans(first.nowSeconds))).toBe(2);
    let state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.keys(state.finals)).toEqual([objectKey]);
    expect(Object.values(state.physicalBytes)).toEqual([first.size * 2]);

    await Effect.runPromise(
      built.repository.publishImmutable(
        secondStage,
        objectKey,
        second.sha256,
        second.size,
        second.nowSeconds,
      ),
    );
    await Effect.runPromise(
      built.repository.verifyFinal(
        secondStage,
        objectKey,
        second.sha256,
        second.size,
        second.nowSeconds,
      ),
    );
    const committed = await Effect.runPromise(
      built.repository.commitStaged(second, secondStage, objectKey, 100),
    );
    expect(committed.metadata.objectKey).toBe(objectKey);
    state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.values(state.physicalBytes)).toEqual([second.size]);
    expect(Object.values(state.references)).toEqual([1]);
  });

  test("rejects a lease that expires between stage, publish, verification, or commit", async () => {
    const stageKey = required(blobStageKey(scope, hash, operation, "AQEBAQEBAQEBAQEBAQEBAQ"));
    const objectKey = required(blobObjectKey(scope, hash));

    const publishExpired = await service(matchingHasher);
    await Effect.runPromise(
      publishExpired.repository.reserveStage(command(), stageKey, objectKey, 100),
    );
    await Effect.runPromise(publishExpired.repository.stageImmutable(stageKey, body, 100));
    const publish = await Effect.runPromiseExit(
      publishExpired.repository.publishImmutable(stageKey, objectKey, hash, body.byteLength, 110),
    );
    expect(JSON.stringify(publish)).toContain("stage_conflict");

    const verifyExpired = await service(matchingHasher);
    await Effect.runPromise(
      verifyExpired.repository.reserveStage(command(), stageKey, objectKey, 100),
    );
    await Effect.runPromise(verifyExpired.repository.stageImmutable(stageKey, body, 100));
    await Effect.runPromise(
      verifyExpired.repository.publishImmutable(stageKey, objectKey, hash, body.byteLength, 100),
    );
    const verify = await Effect.runPromiseExit(
      verifyExpired.repository.verifyFinal(stageKey, objectKey, hash, body.byteLength, 110),
    );
    expect(JSON.stringify(verify)).toContain("final_verification_failed");

    const commitExpired = await service(matchingHasher);
    await Effect.runPromise(
      commitExpired.repository.reserveStage(command(), stageKey, objectKey, 100),
    );
    await Effect.runPromise(commitExpired.repository.stageImmutable(stageKey, body, 100));
    await Effect.runPromise(
      commitExpired.repository.publishImmutable(stageKey, objectKey, hash, body.byteLength, 100),
    );
    const commit = await Effect.runPromiseExit(
      commitExpired.repository.commitStaged(command({ nowSeconds: 110 }), stageKey, objectKey, 110),
    );
    expect(JSON.stringify(commit)).toContain("stage_conflict");
  });

  test("uses the Effect clock at every public transition so elapsed leases cannot commit", async () => {
    const expireAfter = (transition: "stage" | "publish" | "verify") =>
      Effect.gen(function* () {
        const built = yield* makeInMemoryBlobStagingRepository(
          limits,
          [scope],
          [{ ...scope, deviceID: "device-1", authEpoch: 1, credentialEpoch: 1 }],
        );
        const paused = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const pauseAfter = <A>(
          effect: Effect.Effect<A, BlobOperationError>,
          name: "stage" | "publish" | "verify",
        ) =>
          name === transition
            ? effect.pipe(
                Effect.tap(() => Deferred.succeed(paused, undefined)),
                Effect.zipLeft(Deferred.await(release)),
              )
            : effect;
        const repository = {
          ...built.repository,
          stageImmutable: (stageKey: string, stageBody: Uint8Array, nowSeconds: number) =>
            pauseAfter(built.repository.stageImmutable(stageKey, stageBody, nowSeconds), "stage"),
          publishImmutable: (
            stageKey: string,
            finalKey: string,
            expectedHash: string,
            size: number,
            nowSeconds: number,
          ) =>
            pauseAfter(
              built.repository.publishImmutable(stageKey, finalKey, expectedHash, size, nowSeconds),
              "publish",
            ),
          verifyFinal: (
            stageKey: string,
            finalKey: string,
            expectedHash: string,
            size: number,
            nowSeconds: number,
          ) =>
            pauseAfter(
              built.repository.verifyFinal(stageKey, finalKey, expectedHash, size, nowSeconds),
              "verify",
            ),
        };
        const blobService = yield* makeBlobStagingService(limits).pipe(
          Effect.provideService(BlobStagingRepository, repository),
          Effect.provideService(BlobContentHasher, matchingHasher),
        );
        const fiber = yield* Effect.fork(blobService.stage(command()));
        yield* Deferred.await(paused);
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.succeed(release, undefined);
        const exit = yield* Effect.exit(Fiber.join(fiber));
        return { exit, state: yield* Ref.get(built.state) };
      });

    const results = await Effect.runPromise(
      Effect.all([expireAfter("stage"), expireAfter("publish"), expireAfter("verify")], {
        concurrency: 1,
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
    for (const { exit, state } of results) {
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Object.keys(state.blobs)).toEqual([]);
      expect(Object.keys(state.receipts)).toEqual([]);
      expect(Object.keys(state.staged)).toEqual([]);
      expect(Object.keys(state.reservations)).toEqual([]);
    }
    expect(JSON.stringify(results[0]?.exit)).toContain("stage_conflict");
    expect(JSON.stringify(results[1]?.exit)).toContain("final_verification_failed");
    expect(JSON.stringify(results[2]?.exit)).toContain("stage_conflict");
  });

  test("verifies final before metadata, revalidates epochs at commit, and leaves failed metadata final unreadable", async () => {
    const built = await service(matchingHasher);
    const stageKey = required(blobStageKey(scope, hash, operation, "AQEBAQEBAQEBAQEBAQEBAQ"));
    const objectKey = required(blobObjectKey(scope, hash));
    await Effect.runPromise(built.repository.reserveStage(command(), stageKey, objectKey, 100));
    await Effect.runPromise(built.repository.stageImmutable(stageKey, body, 100));
    const withoutFinal = await Effect.runPromiseExit(
      built.repository.commitStaged(command(), stageKey, objectKey, 100),
    );
    expect(JSON.stringify(withoutFinal)).toContain("final_verification_failed");
    expect(Object.keys((await Effect.runPromise(Ref.get(built.state))).blobs)).toEqual([]);

    await Effect.runPromise(
      built.repository.publishImmutable(stageKey, objectKey, hash, body.byteLength, 100),
    );
    await Effect.runPromise(
      Ref.update(built.state, (current) => ({
        ...current,
        activeAuthorizations: {
          ...current.activeAuthorizations,
          [`v2/${scope.ownerID.value}/${scope.vaultID.value}/g${scope.generationEpoch}\u0000device-1`]:
            {
              ...scope,
              deviceID: "device-1",
              authEpoch: 2,
              credentialEpoch: 1,
            },
        },
      })),
    );
    const staleEpoch = await Effect.runPromiseExit(
      built.repository.commitStaged(command(), stageKey, objectKey, 100),
    );
    expect(JSON.stringify(staleEpoch)).toContain("generation_stale");
    expect(Object.keys((await Effect.runPromise(Ref.get(built.state))).blobs)).toEqual([]);
    expect(Object.keys((await Effect.runPromise(Ref.get(built.state))).finals)).toEqual([
      objectKey,
    ]);
  });

  test("preserves the original failure while cleaning only its own stage", async () => {
    const built = await service(matchingHasher, [scope], undefined, {
      publish: true,
      discard: true,
    });
    const unrelatedCommand = command({
      operationID: required(requestID("blob-operation-00000009")),
      stageRandom: "CQkJCQkJCQkJCQkJCQkJCQ",
      sha256: "c".repeat(64),
      body: new Uint8Array([9]),
      size: 1,
    });
    const unrelated = required(
      blobStageKey(
        unrelatedCommand.scope,
        unrelatedCommand.sha256,
        unrelatedCommand.operationID,
        unrelatedCommand.stageRandom,
      ),
    );
    await Effect.runPromise(
      built.repository.reserveStage(
        unrelatedCommand,
        unrelated,
        required(blobObjectKey(unrelatedCommand.scope, unrelatedCommand.sha256)),
        100,
      ),
    );
    await Effect.runPromise(built.repository.stageImmutable(unrelated, new Uint8Array([9]), 100));
    const exit = await Effect.runPromiseExit(built.blobService.stage(command()));
    expect(JSON.stringify(exit)).toContain("publish_failed");
    const state = await Effect.runPromise(Ref.get(built.state));
    expect(state.staged[unrelated]).toBeDefined();
  });

  test("leaves a verified final as an unreadable safe orphan when metadata commit fails", async () => {
    const built = await service(matchingHasher, [scope], undefined, { commit: true });
    const exit = await Effect.runPromiseExit(built.blobService.stage(command()));
    expect(JSON.stringify(exit)).toContain("stage_conflict");
    const state = await Effect.runPromise(Ref.get(built.state));
    expect(Object.keys(state.staged)).toEqual([]);
    expect(Object.keys(state.blobs)).toEqual([]);
    expect(Object.keys(state.receipts)).toEqual([]);
    expect(Object.keys(state.finals)).toEqual([required(blobObjectKey(scope, hash))]);
    const reclaimAtSeconds = Object.values(state.finals)[0]?.reclaimableAtSeconds;
    expect(reclaimAtSeconds).toBeDefined();
    expect(await Effect.runPromise(built.blobService.reconcileOrphans(reclaimAtSeconds ?? 0))).toBe(
      1,
    );
    const restarted = await Effect.runPromise(Ref.get(built.state));
    expect(Object.keys(restarted.finals)).toEqual([]);
    expect(Object.values(restarted.physicalBytes)).toEqual([0]);
  });

  test("keeps stage bytes inaccessible and reconciles orphaned immutable stages", async () => {
    const built = await service(matchingHasher);
    const orphanCommand = command({ nowSeconds: 1 });
    const orphanStage = required(
      blobStageKey(
        orphanCommand.scope,
        orphanCommand.sha256,
        orphanCommand.operationID,
        orphanCommand.stageRandom,
      ),
    );
    await Effect.runPromise(
      built.repository.reserveStage(
        orphanCommand,
        orphanStage,
        required(blobObjectKey(orphanCommand.scope, orphanCommand.sha256)),
        1,
      ),
    );
    await Effect.runPromise(built.repository.stageImmutable(orphanStage, new Uint8Array([9]), 1));
    expect(await Effect.runPromise(built.blobService.reconcileOrphans(10))).toBe(0);
    expect(await Effect.runPromise(built.blobService.reconcileOrphans(11))).toBe(2);
    expect(Object.keys((await Effect.runPromise(Ref.get(built.state))).staged)).toEqual([]);
  });

  test("rejects dot path segments before staging", () => {
    expect(validBlobPath("notes/./today")).toBe(false);
    expect(validBlobPath("notes/../today")).toBe(false);
  });
});
