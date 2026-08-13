import { describe, expect, test } from "bun:test";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import {
  type OwnerVaultControlOperationDetails,
  claimOwnerVaultControlOperation,
  completeOwnerVaultControlOperation,
  completeOwnerVaultControlOperationInTx,
  fenceOwnerVaultControlOperationInTx,
  ownerVaultControlOperationCohortCapacity,
  progressOwnerVaultControlOperation,
  readCompletedOwnerVaultControlOperation,
  reconcileOwnerVaultControlOperations,
  recoverExpiredOwnerVaultControlOperation,
} from "./control-operation";
import { makeDurableObjectOwnerVaultStorageRepository } from "./repository";

const nativeState = () => {
  const entries = new Map<string, unknown>();
  let alarm: number | null = null;
  const transaction: DurableObjectTransactionNative = {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(entries.delete(key)),
    getAlarm: () => Promise.resolve(alarm),
    setAlarm: (atMilliseconds) => {
      alarm = atMilliseconds;
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarm = null;
      return Promise.resolve();
    },
  };
  const storage: DurableObjectStorageNative = {
    ...transaction,
    transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
      const before = new Map(entries);
      const alarmBefore = alarm;
      return work(transaction).catch((error: unknown) => {
        entries.clear();
        for (const [key, value] of before) entries.set(key, value);
        alarm = alarmBefore;
        return Promise.reject(error);
      });
    },
  };
  const state: DurableObjectStateNative = { storage, blockConcurrencyWhile: (work) => work() };
  const repository = () =>
    makeDurableObjectOwnerVaultStorageRepository(makeDurableObjectBoundary(state).storage, storage);
  return { entries, alarm: () => alarm, repository };
};

const expirySeconds = Math.floor(Date.now() / 1_000) + 120;
const details: OwnerVaultControlOperationDetails = {
  kind: "snapshot",
  root: {
    ownerID: "owner-control-test",
    vaultID: "vault-control-test",
    generationEpoch: 1,
    namespaceState: "PRIVATE",
  },
  operationID: "control-operation-test-0001",
  receiptJTI: "control-operation-jti-0001",
  lifecycle: "receipt-lease-v1",
  expiresAtSeconds: expirySeconds,
  receiptFingerprint: "a".repeat(64),
  controlDigest: "b".repeat(64),
  canonicalCommand: '{"backupID":"backup-0001","operationID":"control-operation-test-0001"}',
  hardDeadlineMilliseconds: expirySeconds * 1_000,
};
const snapshotResult = {
  kind: "snapshot" as const,
  manifestDigest: "A".repeat(43),
  sourceSnapshotPublication: {
    schema: "source-snapshot-publication-v1" as const,
    authority: "owner-vault-production-manifest-ring-v1" as const,
    algorithm: "ES256-P256-canonical-low-s-der" as const,
    publication: {
      category: "owner-vault.snapshot-pin" as const,
      schema: "snapshot-pin-v2" as const,
      state: "COMPLETED" as const,
    },
    sourceRoot: details.root,
    backupID: "backup-control-test-001",
    manifestDigest: "A".repeat(43),
    snapshotOperationID: details.operationID,
    snapshotJTI: details.receiptJTI,
    snapshotCommandSHA256: details.controlDigest,
    signingKeyID: "manifest-key-001",
    signature: { keyID: "manifest-key-001", signatureDERBase64: "AAAA" },
  },
};

const setup = async () => {
  const native = nativeState();
  const repository = native.repository();
  await Effect.runPromise(
    repository.transact((tx) =>
      tx
        .initialize({
          ownerID: "owner-control-test",
          vaultID: "vault-control-test",
          generationEpoch: 1,
          namespaceState: "PRIVATE",
        })
        .pipe(
          Effect.zipRight(
            tx.put(
              { category: "root.admission" },
              {
                schema: "admission-v3",
                total: 0,
                activeChallenges: 0,
                legacyOutstandingChallenges: 0,
                activeDevices: 0,
                activeSessions: 0,
                capabilityReceipts: 0,
                controlReceiptLeases: 0,
                pendingSocketAdmissions: 0,
                activeSocketAdmissions: 0,
                stopped: false,
              },
            ),
          ),
          Effect.zipRight(tx.put({ category: "control-receipt-lease-index" }, { entries: [] })),
        ),
    ),
  );
  return { ...native, repository, repositoryFactory: native.repository };
};

const withClock = async <A>(atMilliseconds: number, work: () => Promise<A>): Promise<A> => {
  const original = Date.now;
  Date.now = () => atMilliseconds;
  try {
    return await work();
  } finally {
    Date.now = original;
  }
};

const cohortOperation = (index: number, expiresAtSeconds = expirySeconds) => {
  const suffix = String(index).padStart(4, "0");
  const operationID = `control-capacity-operation-${suffix}`;
  const receiptJTI = `control-capacity-jti-${suffix}`;
  const controlDigest = index.toString(16).padStart(64, "0");
  return {
    ...details,
    operationID,
    receiptJTI,
    expiresAtSeconds,
    controlDigest,
    canonicalCommand: `{"backupID":"backup-capacity-${suffix}","operationID":"${operationID}"}`,
    hardDeadlineMilliseconds: expiresAtSeconds * 1_000,
  };
};

const cohortResult = (operation: OwnerVaultControlOperationDetails) => ({
  ...snapshotResult,
  sourceSnapshotPublication: {
    ...snapshotResult.sourceSnapshotPublication,
    backupID: `backup-capacity-${operation.operationID.slice(-4)}`,
    snapshotOperationID: operation.operationID,
    snapshotJTI: operation.receiptJTI,
    snapshotCommandSHA256: operation.controlDigest,
  },
});

describe("OwnerVault snapshot/restore control operation lease", () => {
  test("atomically creates PREPARED receipt/journal, rejects an active peer, and rolls back a failed former boundary", async () => {
    const { entries, repository } = await setup();
    const first = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, details, "lease-owner-0001"),
    );
    expect(first).toEqual({
      state: "FRESH",
      lease: { leaseID: "lease-owner-0001", leaseEpoch: 1 },
    });
    const active = await Effect.runPromiseExit(
      claimOwnerVaultControlOperation(repository, details, "lease-owner-0002"),
    );
    expect(Exit.isFailure(active)).toBe(true);

    const before = new Map(entries);
    const rolledBack = await Effect.runPromiseExit(
      repository.transact((tx) =>
        tx
          .put(
            { category: "control.operation", identifier: "rollback-operation-0001" },
            {
              ...details,
              operationID: "rollback-operation-0001",
              schema: "control-operation-v1",
              receiptState: "PREPARED",
              phase: "CLAIMED",
              leaseID: "lease-owner-rollback",
              leaseEpoch: 1,
              leaseUntilMilliseconds: 61_000,
            },
          )
          .pipe(
            Effect.zipRight(
              tx.put({ category: "control.operation", identifier: "invalid" }, { malformed: true }),
            ),
          ),
      ),
    );
    expect(Exit.isFailure(rolledBack)).toBe(true);
    expect(entries).toEqual(before);
  });

  test("rejects an expired nonterminal retry and fences stale progress", async () => {
    const { repository } = await setup();
    const first = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, details, "lease-owner-0001"),
    );
    if (first.state !== "FRESH") throw new Error("missing first lease");
    await Effect.runPromise(
      repository.transact((tx) =>
        tx.get({ category: "control.operation", identifier: details.operationID }).pipe(
          Effect.flatMap((row) =>
            row === undefined
              ? Effect.die("missing control row")
              : tx.put(
                  { category: "control.operation", identifier: details.operationID },
                  {
                    ...row.payload,
                    leaseUntilMilliseconds: Date.now() - 1,
                  },
                ),
          ),
        ),
      ),
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          claimOwnerVaultControlOperation(repository, details, "lease-owner-0002"),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          progressOwnerVaultControlOperation(repository, details, first.lease),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          repository.transact((tx) =>
            completeOwnerVaultControlOperationInTx(
              tx,
              details,
              first.lease,
              snapshotResult,
              () => Effect.void,
            ),
          ),
        ),
      ),
    ).toBe(true);
  });

  test("replays an exact completed operation read-only after repository restart and rejects malformed journals", async () => {
    const { entries, repository, repositoryFactory } = await setup();
    const first = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, details, "lease-owner-0001"),
    );
    if (first.state !== "FRESH") throw new Error("missing lease");
    await Effect.runPromise(
      completeOwnerVaultControlOperation(repository, details, first.lease, snapshotResult),
    );
    const writesBeforeReplay = entries.size;
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          claimOwnerVaultControlOperation(repositoryFactory(), details, "lease-owner-0002"),
        ),
      ),
    ).toBe(true);
    const replay = await Effect.runPromise(
      readCompletedOwnerVaultControlOperation(repositoryFactory(), {
        kind: details.kind,
        operationID: details.operationID,
        receiptFingerprint: details.receiptFingerprint,
        controlDigest: details.controlDigest,
        canonicalCommand: details.canonicalCommand,
      }),
    );
    expect(replay).toEqual(snapshotResult);
    expect(entries.size).toBe(writesBeforeReplay);

    entries.set("v2.ov/control/operation/corrupt-operation-0001", {
      category: "control.operation",
      version: 1,
      payload: { schema: "control-operation-v0" },
    });
    const corrupt = await Effect.runPromiseExit(
      claimOwnerVaultControlOperation(
        repositoryFactory(),
        { ...details, operationID: "corrupt-operation-0001" },
        "lease-owner-0003",
      ),
    );
    expect(Exit.isFailure(corrupt)).toBe(true);
  });

  test("uses the durable JTI namespace in both directions and fences an expired same-epoch write", async () => {
    const { repository } = await setup();
    await Effect.runPromise(
      repository.transact((tx) =>
        tx.put(
          { category: "jti", identifier: details.receiptJTI },
          {
            operationID: "generic-operation-0001",
            expiresAtSeconds: details.expiresAtSeconds,
          },
        ),
      ),
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          claimOwnerVaultControlOperation(repository, details, "lease-owner-0001"),
        ),
      ),
    ).toBe(true);

    const clean = (await setup()).repository;
    const claim = await Effect.runPromise(
      claimOwnerVaultControlOperation(clean, details, "lease-owner-0001"),
    );
    if (claim.state !== "FRESH") throw new Error("missing fresh claim");
    await Effect.runPromise(
      clean.transact((tx) =>
        tx.get({ category: "control.operation", identifier: details.operationID }).pipe(
          Effect.flatMap((row) =>
            row === undefined
              ? Effect.die("missing control row")
              : tx.put(
                  { category: "control.operation", identifier: details.operationID },
                  {
                    ...row.payload,
                    leaseUntilMilliseconds: Date.now() - 1,
                  },
                ),
          ),
        ),
      ),
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          clean.transact((tx) => fenceOwnerVaultControlOperationInTx(tx, details, claim.lease)),
        ),
      ),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        readCompletedOwnerVaultControlOperation(clean, {
          kind: details.kind,
          operationID: details.operationID,
          receiptFingerprint: details.receiptFingerprint,
          controlDigest: details.controlDigest,
          canonicalCommand: details.canonicalCommand,
        }),
      ),
    ).toBeUndefined();
  });

  test("rolls back every terminal cohort row when the required terminal fragment faults", async () => {
    const { entries, repository } = await setup();
    const claim = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, details, "lease-owner-0001"),
    );
    if (claim.state !== "FRESH") throw new Error("missing fresh claim");
    const before = new Map(entries);
    const failed = await Effect.runPromiseExit(
      repository.transact((tx) =>
        completeOwnerVaultControlOperationInTx(tx, details, claim.lease, snapshotResult, () =>
          tx
            .put(
              { category: "control.initialization-ack", identifier: "terminal-fault-0001" },
              { marker: "staged" },
            )
            .pipe(
              Effect.zipRight(
                Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const),
              ),
            ),
        ),
      ),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect(entries).toEqual(before);
  });

  test("commits terminal fragment, control row, raw JTI, lease index, and admission count together", async () => {
    const { entries, repository } = await setup();
    const claim = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, details, "lease-owner-0001"),
    );
    if (claim.state !== "FRESH") throw new Error("missing fresh claim");
    await Effect.runPromise(
      repository.transact((tx) =>
        completeOwnerVaultControlOperationInTx(tx, details, claim.lease, snapshotResult, () =>
          tx.put(
            { category: "control.initialization-ack", identifier: "terminal-success-0001" },
            { marker: "committed" },
          ),
        ),
      ),
    );
    const values = JSON.stringify([...entries.values()]);
    expect(values).toContain('"state":"COMPLETED"');
    expect(values).toContain('"controlReceiptLeases":0');
    expect(values).toContain('"marker":"committed"');
    expect(values).toContain('"control-terminal-evidence-v1"');
  });

  test("admits and completes concurrent operations whose IDs collate divergently from code-unit order", async () => {
    const { entries, repository } = await setup();
    // Locale collation orders "a1…" before "B1…" while the C2 index
    // validators require strict code-unit operationID order ("B1…" first), so
    // a locale-sorted lease or completed-retention index rejects its put and
    // fails the valid claim or terminal completion.
    const first = {
      ...details,
      operationID: "B1-collation-operation-0001",
      receiptJTI: "B1-collation-jti-00000001",
      canonicalCommand:
        '{"backupID":"backup-collation-b","operationID":"B1-collation-operation-0001"}',
    };
    const second = {
      ...details,
      operationID: "a1-collation-operation-0002",
      receiptJTI: "a1-collation-jti-00000002",
      controlDigest: "c".repeat(64),
      canonicalCommand:
        '{"backupID":"backup-collation-a","operationID":"a1-collation-operation-0002"}',
    };
    const resultFor = (operation: OwnerVaultControlOperationDetails) => ({
      ...snapshotResult,
      sourceSnapshotPublication: {
        ...snapshotResult.sourceSnapshotPublication,
        snapshotOperationID: operation.operationID,
        snapshotJTI: operation.receiptJTI,
        snapshotCommandSHA256: operation.controlDigest,
      },
    });
    const firstClaim = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, first, "lease-collation-0001"),
    );
    if (firstClaim.state !== "FRESH") throw new Error("missing first fresh claim");
    const secondClaim = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, second, "lease-collation-0002"),
    );
    if (secondClaim.state !== "FRESH") throw new Error("missing second fresh claim");
    const leaseIndex = entries.get("v2.ov/control-receipt-lease-index") as {
      payload: { entries: readonly { operationID: string }[] };
    };
    expect(leaseIndex.payload.entries.map((entry) => entry.operationID)).toEqual([
      "B1-collation-operation-0001",
      "a1-collation-operation-0002",
    ]);
    await Effect.runPromise(
      completeOwnerVaultControlOperation(repository, first, firstClaim.lease, resultFor(first)),
    );
    // The retained "B1…" completion must not block the "a1…" terminal commit.
    await Effect.runPromise(
      completeOwnerVaultControlOperation(repository, second, secondClaim.lease, resultFor(second)),
    );
    const completedIndex = entries.get("v2.ov/control-receipt-completed-index") as {
      payload: { entries: readonly { operationID: string }[] };
    };
    expect(completedIndex.payload.entries.map((entry) => entry.operationID)).toEqual([
      "B1-collation-operation-0001",
      "a1-collation-operation-0002",
    ]);
    expect(
      await Effect.runPromise(readCompletedOwnerVaultControlOperation(repository, second)),
    ).toEqual(resultFor(second));
  });

  test("post-lease recovery consumes only exact closed evidence and rejects a mismatch without mutation", async () => {
    const { entries, repository } = await setup();
    const claim = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, details, "lease-owner-0001"),
    );
    if (claim.state !== "FRESH") throw new Error("missing fresh claim");
    await Effect.runPromise(
      completeOwnerVaultControlOperation(repository, details, claim.lease, snapshotResult),
    );
    const replay = {
      kind: details.kind,
      operationID: details.operationID,
      receiptFingerprint: details.receiptFingerprint,
      controlDigest: details.controlDigest,
      canonicalCommand: details.canonicalCommand,
    } as const;
    await Effect.runPromise(
      repository.transact((tx) =>
        tx
          .get({ category: "control.operation", identifier: details.operationID })
          .pipe(
            Effect.flatMap((row) =>
              row === undefined
                ? Effect.die("missing operation")
                : tx.put(
                    { category: "control.operation", identifier: details.operationID },
                    { ...row.payload, leaseUntilMilliseconds: Date.now() - 1 },
                  ),
            ),
          ),
      ),
    );
    expect(
      await Effect.runPromise(recoverExpiredOwnerVaultControlOperation(repository, replay)),
    ).toEqual(snapshotResult);
    const evidenceKey = "v2.ov/control/terminal-evidence/control-operation-test-0001";
    const evidence = entries.get(evidenceKey) as
      | {
          readonly category: string;
          readonly version: number;
          readonly payload: Readonly<Record<string, unknown>>;
        }
      | undefined;
    if (evidence === undefined) throw new Error("missing evidence");
    // Simulate corrupt durable bytes outside the repository writer, which
    // correctly refuses to create this invalid closed record itself.
    entries.set(evidenceKey, {
      ...evidence,
      payload: { ...evidence.payload, controlDigest: "c".repeat(64) },
    });
    const before = new Map(entries);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(recoverExpiredOwnerVaultControlOperation(repository, replay)),
      ),
    ).toBe(true);
    expect(entries).toEqual(before);
  });

  test("returns a completed terminal result only before its lease, then only through exact recovery", async () => {
    const { entries, repository } = await setup();
    const claim = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, details, "lease-owner-boundary-0001"),
    );
    if (claim.state !== "FRESH") throw new Error("missing fresh claim");
    await Effect.runPromise(
      completeOwnerVaultControlOperation(repository, details, claim.lease, snapshotResult),
    );
    const stored = entries.get("v2.ov/control/operation/control-operation-test-0001") as
      | {
          readonly payload: {
            readonly leaseUntilMilliseconds: number;
            readonly hardDeadlineMilliseconds: number;
          };
        }
      | undefined;
    if (stored === undefined) throw new Error("missing completed operation");
    const { leaseUntilMilliseconds, hardDeadlineMilliseconds } = stored.payload;
    const replay = {
      kind: details.kind,
      operationID: details.operationID,
      receiptFingerprint: details.receiptFingerprint,
      controlDigest: details.controlDigest,
      canonicalCommand: details.canonicalCommand,
    } as const;

    await withClock(leaseUntilMilliseconds - 1, async () => {
      expect(
        await Effect.runPromise(readCompletedOwnerVaultControlOperation(repository, replay)),
      ).toEqual(snapshotResult);
      expect(
        await Effect.runPromise(recoverExpiredOwnerVaultControlOperation(repository, replay)),
      ).toBeUndefined();
    });
    await withClock(leaseUntilMilliseconds, async () => {
      expect(
        await Effect.runPromise(readCompletedOwnerVaultControlOperation(repository, replay)),
      ).toBeUndefined();
      expect(
        await Effect.runPromise(recoverExpiredOwnerVaultControlOperation(repository, replay)),
      ).toEqual(snapshotResult);
    });
    await withClock(hardDeadlineMilliseconds - 1, async () => {
      expect(
        await Effect.runPromise(readCompletedOwnerVaultControlOperation(repository, replay)),
      ).toBeUndefined();
      expect(
        await Effect.runPromise(recoverExpiredOwnerVaultControlOperation(repository, replay)),
      ).toEqual(snapshotResult);
    });
    await withClock(hardDeadlineMilliseconds, async () => {
      expect(
        await Effect.runPromise(readCompletedOwnerVaultControlOperation(repository, replay)),
      ).toBeUndefined();
      expect(
        await Effect.runPromise(recoverExpiredOwnerVaultControlOperation(repository, replay)),
      ).toBeUndefined();
    });
  });

  test("expiry cleanup reciprocally removes only the bounded C2 receipt cohort", async () => {
    const { entries, repository } = await setup();
    const claim = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, details, "lease-owner-0001"),
    );
    if (claim.state !== "FRESH") throw new Error("missing fresh claim");
    await Effect.runPromise(
      completeOwnerVaultControlOperation(repository, details, claim.lease, snapshotResult),
    );
    const untouched = {
      category: "backup.pin" as const,
      version: 1,
      payload: { marker: "outside-c2" },
    };
    entries.set("v2.ov/backup/pin/backup-control-test-001", untouched);
    expect(
      await Effect.runPromise(
        reconcileOwnerVaultControlOperations(repository, details.hardDeadlineMilliseconds + 1),
      ),
    ).toBeUndefined();
    expect(entries.has("v2.ov/control/operation/control-operation-test-0001")).toBe(false);
    expect(entries.has("v2.ov/jti/control-operation-jti-0001")).toBe(false);
    expect(entries.has("v2.ov/control/terminal-evidence/control-operation-test-0001")).toBe(false);
    expect(entries.get("v2.ov/backup/pin/backup-control-test-001")).toEqual(untouched);
    expect(JSON.stringify([...entries.values()])).toContain('"controlReceiptLeases":0');
  });

  test("bounded reconciliation retains a live lease and returns its signed expiry alarm", async () => {
    const { entries, repository } = await setup();
    await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, details, "lease-owner-0001"),
    );
    expect(
      await Effect.runPromise(reconcileOwnerVaultControlOperations(repository, Date.now())),
    ).toBe(details.hardDeadlineMilliseconds);
    expect(entries.has("v2.ov/control/operation/control-operation-test-0001")).toBe(true);
  });

  test("reconciles mixed active and completed cohorts over a batch boundary with an immediate cursor follow-up", async () => {
    const { entries, repository } = await setup();
    const cohort = Array.from({ length: 10 }, (_, index) => {
      const suffix = String(index + 1).padStart(4, "0");
      return {
        ...details,
        operationID: `control-reconcile-batch-${suffix}`,
        receiptJTI: `control-reconcile-jti-${suffix}`,
        canonicalCommand: `{"backupID":"backup-${suffix}","operationID":"control-reconcile-batch-${suffix}"}`,
      };
    });
    for (const [index, operation] of cohort.entries()) {
      const claim = await Effect.runPromise(
        claimOwnerVaultControlOperation(repository, operation, `lease-owner-batch-${index}`),
      );
      if (claim.state !== "FRESH") throw new Error("missing batch lease");
      if (index % 2 === 0)
        await Effect.runPromise(
          completeOwnerVaultControlOperation(repository, operation, claim.lease, {
            ...snapshotResult,
            sourceSnapshotPublication: {
              ...snapshotResult.sourceSnapshotPublication,
              snapshotOperationID: operation.operationID,
              snapshotJTI: operation.receiptJTI,
              snapshotCommandSHA256: operation.controlDigest,
            },
          }),
        );
    }
    const atMilliseconds = details.hardDeadlineMilliseconds + 1;
    const immediateFollowUp = await Effect.runPromise(
      reconcileOwnerVaultControlOperations(repository, atMilliseconds, 8),
    );
    expect(immediateFollowUp).toBe(details.hardDeadlineMilliseconds);
    expect(immediateFollowUp).toBeLessThan(atMilliseconds);
    expect(entries.get("v2.ov/control-receipt-reconcile-cursor")).toMatchObject({
      payload: { nextOperationID: "control-reconcile-batch-0009" },
    });
    expect(
      [...entries.keys()].filter((key) =>
        key.startsWith("v2.ov/control/operation/control-reconcile-batch-"),
      ),
    ).toHaveLength(2);
    expect(
      await Effect.runPromise(reconcileOwnerVaultControlOperations(repository, atMilliseconds, 8)),
    ).toBeUndefined();
    expect(entries.get("v2.ov/control-receipt-reconcile-cursor")).toMatchObject({
      payload: { nextOperationID: null },
    });
    expect(
      [...entries.keys()].filter((key) =>
        key.startsWith("v2.ov/control/operation/control-reconcile-batch-"),
      ),
    ).toHaveLength(0);
  });

  test("rejects a fresh claim at 64 completed slots without changing durable rows or alarm", async () => {
    const { entries, alarm, repository } = await setup();
    for (let index = 1; index <= ownerVaultControlOperationCohortCapacity; index += 1) {
      const operation = cohortOperation(index);
      const claim = await Effect.runPromise(
        claimOwnerVaultControlOperation(repository, operation, `lease-capacity-${index}`),
      );
      await Effect.runPromise(
        completeOwnerVaultControlOperation(
          repository,
          operation,
          claim.lease,
          cohortResult(operation),
        ),
      );
    }
    const before = JSON.stringify([...entries.entries()]);
    const alarmBefore = alarm();
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          claimOwnerVaultControlOperation(
            repository,
            cohortOperation(ownerVaultControlOperationCohortCapacity + 1),
            "lease-capacity-overflow",
          ),
        ),
      ),
    ).toBe(true);
    expect(JSON.stringify([...entries.entries()])).toBe(before);
    expect(alarm()).toBe(alarmBefore);
  });

  test("a reserved final slot transfers to completed retention without raising cohort occupancy", async () => {
    const { entries, repository } = await setup();
    for (let index = 1; index < ownerVaultControlOperationCohortCapacity; index += 1) {
      const operation = cohortOperation(index);
      const claim = await Effect.runPromise(
        claimOwnerVaultControlOperation(repository, operation, `lease-transfer-${index}`),
      );
      await Effect.runPromise(
        completeOwnerVaultControlOperation(
          repository,
          operation,
          claim.lease,
          cohortResult(operation),
        ),
      );
    }
    const reserved = cohortOperation(ownerVaultControlOperationCohortCapacity);
    const reservedClaim = await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, reserved, "lease-transfer-reserved"),
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          claimOwnerVaultControlOperation(
            repository,
            cohortOperation(ownerVaultControlOperationCohortCapacity + 1),
            "lease-transfer-overflow",
          ),
        ),
      ),
    ).toBe(true);
    await Effect.runPromise(
      completeOwnerVaultControlOperation(
        repository,
        reserved,
        reservedClaim.lease,
        cohortResult(reserved),
      ),
    );
    expect(entries.get("v2.ov/control-receipt-lease-index")).toMatchObject({
      payload: { entries: [] },
    });
    const completed = entries.get("v2.ov/control-receipt-completed-index") as {
      readonly payload: { readonly entries: readonly unknown[] };
    };
    expect(completed.payload.entries).toHaveLength(ownerVaultControlOperationCohortCapacity);
    expect(entries.get("v2.ov/root/admission")).toMatchObject({
      payload: { controlReceiptLeases: 0 },
    });
  });

  test("mixed expiry cleanup frees a cohort slot for a later fresh claim", async () => {
    const { repository } = await setup();
    const nowSeconds = Math.floor(Date.now() / 1_000);
    for (let index = 1; index <= 62; index += 1) {
      const operation = cohortOperation(index, nowSeconds + 120);
      const claim = await Effect.runPromise(
        claimOwnerVaultControlOperation(repository, operation, `lease-cleanup-completed-${index}`),
      );
      await Effect.runPromise(
        completeOwnerVaultControlOperation(
          repository,
          operation,
          claim.lease,
          cohortResult(operation),
        ),
      );
    }
    const expiredCompleted = cohortOperation(63, nowSeconds + 10);
    const expiredCompletedClaim = await Effect.runPromise(
      claimOwnerVaultControlOperation(
        repository,
        expiredCompleted,
        "lease-cleanup-expired-completed",
      ),
    );
    await Effect.runPromise(
      completeOwnerVaultControlOperation(
        repository,
        expiredCompleted,
        expiredCompletedClaim.lease,
        cohortResult(expiredCompleted),
      ),
    );
    const expiredActive = cohortOperation(64, nowSeconds + 10);
    await Effect.runPromise(
      claimOwnerVaultControlOperation(repository, expiredActive, "lease-cleanup-expired-active"),
    );
    const blocked = cohortOperation(65, nowSeconds + 120);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          claimOwnerVaultControlOperation(repository, blocked, "lease-cleanup-blocked"),
        ),
      ),
    ).toBe(true);
    await Effect.runPromise(
      reconcileOwnerVaultControlOperations(repository, (nowSeconds + 11) * 1_000),
    );
    expect(
      await Effect.runPromise(
        claimOwnerVaultControlOperation(repository, blocked, "lease-cleanup-admitted"),
      ),
    ).toMatchObject({ state: "FRESH" });
  });
});
