import { describe, expect, test } from "bun:test";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import { ownerID, vaultID } from "../foundation/schemas";
import { type BlobLimits, type BlobScope, blobObjectKey } from "../blobs/blobs";
import { canonicalSnapshotRecordBytes, ownerVaultBackupDigest } from "./backup-canonical";
import type {
  OwnerVaultRestoreImportFinalization,
  OwnerVaultRestoreImportPlan,
  OwnerVaultRestoreImportRecord,
} from "./backup-types";
import { makeDurableObjectOwnerVaultStorageRepository } from "./repository";
import { makeOwnerVaultRestoreImport, ownerVaultRestoreImportHashChain } from "./restore-import";
import { ownerVaultAppendProofValidate } from "./append-proof";
import { makeOwnerVaultDomainProvider } from "./domains";
import type { OwnerVaultAppendLogEntry } from "./domains";
import type { OwnerVaultStorageRecord } from "./storage-registry";

const root = {
  ownerID: "owner-1",
  vaultID: "vault-1",
  generationEpoch: 2,
  namespaceState: "PRIVATE",
} as const;
const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("test setup");
  return value;
};
const blobScope: BlobScope = {
  ownerID: required(ownerID(root.ownerID)),
  vaultID: required(vaultID(root.vaultID)),
  generationEpoch: root.generationEpoch,
};
const blobLimits: BlobLimits = {
  maximumBlobBytes: 16,
  maximumVaultBytes: 32,
  maximumOrphanBytes: 16,
  maximumOrphanCount: 2,
  maximumActiveLeasesPerVault: 4,
  maximumActiveLeasesPerFinal: 4,
  stageTTLSeconds: 10,
};

const nativeState = (): {
  readonly state: DurableObjectStateNative;
  readonly storage: DurableObjectStorageNative;
  readonly entries: Map<string, unknown>;
} => {
  const entries = new Map<string, unknown>();
  const transaction: DurableObjectTransactionNative = {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(entries.delete(key)),
  };
  const storage: DurableObjectStorageNative = {
    ...transaction,
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
    transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
      const before = new Map(entries);
      return work(transaction).catch((error: unknown) => {
        entries.clear();
        for (const [key, value] of before) entries.set(key, value);
        return Promise.reject(error);
      });
    },
  };
  return { entries, storage, state: { storage, blockConcurrencyWhile: (work) => work() } };
};

const restoreID = "restore-import-0001";
const testRestore = (
  repository: ReturnType<typeof makeDurableObjectOwnerVaultStorageRepository>,
) => {
  const restore = makeOwnerVaultRestoreImport({ repository });
  return {
    beginRestoreImport: (plan: OwnerVaultRestoreImportPlan) =>
      restore.beginRestoreImport(restoreID, plan),
    applyRestoreRecord: (input: {
      readonly manifestDigest: string;
      readonly expected: OwnerVaultRestoreImportRecord;
      readonly record: OwnerVaultStorageRecord;
    }) => restore.applyRestoreRecord({ ...input, restoreID }),
    finalizeRestoreImport: (
      manifestDigest: string,
      finalization: OwnerVaultRestoreImportFinalization,
    ) => restore.finalizeRestoreImport(restoreID, manifestDigest, finalization),
  };
};
const fixture = async () => {
  const native = nativeState();
  const repository = makeDurableObjectOwnerVaultStorageRepository(
    makeDurableObjectBoundary(native.state).storage,
  );
  await Effect.runPromise(
    repository.transact((tx) =>
      tx
        .initialize(root)
        .pipe(Effect.zipRight(tx.put({ category: "root.floors" }, { securityFloor: 0 }))),
    ),
  );
  return { native, repository, restore: testRestore(repository) };
};
const digest = (text: string): string => ownerVaultBackupDigest(new TextEncoder().encode(text));
const record = (
  ordinal: number,
  id: string,
): {
  readonly expected: OwnerVaultRestoreImportRecord;
  readonly stored: OwnerVaultStorageRecord;
} => {
  const stored: OwnerVaultStorageRecord = {
    category: "device",
    version: 1,
    payload: { publicKey: `spki-${id}` },
  };
  const bytes = canonicalSnapshotRecordBytes({ category: "device", identifier: id }, stored);
  if (bytes === undefined) throw new Error("test setup");
  return {
    expected: {
      ordinal,
      address: { category: "device", identifier: id },
      version: 1,
      category: "device",
      codec: "owner-vault-storage-record-v1",
      sha256Base64: ownerVaultBackupDigest(bytes),
      size: bytes.byteLength,
    },
    stored,
  };
};
const imported = (
  ordinal: number,
  category: OwnerVaultRestoreImportRecord["category"],
  identifier: string,
  payload: Readonly<Record<string, unknown>>,
) => {
  const stored: OwnerVaultStorageRecord = { category, version: 1, payload };
  const bytes = canonicalSnapshotRecordBytes({ category, identifier }, stored);
  if (bytes === undefined) throw new Error("test setup");
  return {
    expected: {
      ordinal,
      address: { category, identifier },
      version: 1 as const,
      category,
      codec: "owner-vault-storage-record-v1" as const,
      sha256Base64: ownerVaultBackupDigest(bytes),
      size: bytes.byteLength,
    },
    stored,
  };
};
const sourceScope = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 1 } as const;
const planWithHead = (
  appendLogSequence: number,
  ...items: readonly {
    readonly expected: OwnerVaultRestoreImportRecord;
    readonly stored: OwnerVaultStorageRecord;
  }[]
): OwnerVaultRestoreImportPlan => {
  const manifestDigest = digest("signed-manifest");
  const records = items.map((item) => item.expected);
  const hashChain = ownerVaultRestoreImportHashChain(manifestDigest, records);
  if (hashChain === undefined) throw new Error("test setup");
  const log = items
    .filter((item) => item.expected.category === "append-log.entry")
    .map((item) => item.stored.payload as unknown as OwnerVaultAppendLogEntry);
  const appendProof = ownerVaultAppendProofValidate(sourceScope, log);
  if (appendProof === undefined || appendProof.appendLogSequence !== appendLogSequence)
    throw new Error("test setup");
  return {
    backupID: "backup-restore-0001",
    manifestDigest,
    source: sourceScope,
    highWaterMark: digest("catalog-identity"),
    appendLogSequence,
    appendLogDigest: appendProof.appendLogDigest,
    totalBytes: records.reduce((total, item) => total + item.size, 0),
    objectCount: records.length,
    hashChain,
    records,
  };
};
const planFor = (
  ...items: readonly {
    readonly expected: OwnerVaultRestoreImportRecord;
    readonly stored: OwnerVaultStorageRecord;
  }[]
): OwnerVaultRestoreImportPlan => planWithHead(0, ...items);
const finalization = () => ({ blobScope, blobLimits, targetBlobEvidence: [] });
const revision = (entries: Map<string, unknown>): number =>
  (entries.get("v2.ov/catalog/current") as { payload: { catalogRevision: number } }).payload
    .catalogRevision;

describe("OwnerVault C1 restore import", () => {
  test("binds the immutable source audit to first begin and rejects an audit mismatch", async () => {
    const built = await fixture();
    const first = record(0, "device-a");
    const plan = planFor(first);
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    expect(built.native.entries.get("v2.ov/audit/restore-source")).toEqual({
      category: "audit.restore-source",
      version: 1,
      payload: {
        source: plan.source,
        audit: { backupID: plan.backupID, manifestDigest: plan.manifestDigest },
      },
    });
    built.native.entries.set("v2.ov/audit/restore-source", {
      category: "audit.restore-source",
      version: 1,
      payload: {
        source: plan.source,
        audit: { backupID: "backup-other-0001", manifestDigest: plan.manifestDigest },
      },
    });
    const exit = await Effect.runPromiseExit(built.restore.beginRestoreImport(plan));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("keeps partial rows non-authoritative across restart, requires ordinal order, and accepts only exact duplicate replay", async () => {
    const first = record(0, "device-a");
    const second = record(1, "device-b");
    const plan = planFor(first, second);
    const built = await fixture();
    const initialAccounting = (
      built.native.entries.get("v2.ov/root/accounting") as { payload: { usedBytes: number } }
    ).payload.usedBytes;
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    await Effect.runPromise(
      built.restore.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: first.expected,
        record: first.stored,
      }),
    );
    expect(revision(built.native.entries)).toBe(0);
    expect(built.native.entries.has("v2.ov/device/device-a")).toBe(true);
    expect(built.native.entries.has("v2.ov/catalog/page/00000000000000000001-0000")).toBe(false);

    const restarted = testRestore(built.repository);
    await Effect.runPromise(
      restarted.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: first.expected,
        record: first.stored,
      }),
    );
    const outOfOrder = await Effect.runPromiseExit(
      restarted.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: { ...second.expected, ordinal: 2 },
        record: second.stored,
      }),
    );
    expect(Exit.isFailure(outOfOrder)).toBe(true);
    const conflict = await Effect.runPromiseExit(
      restarted.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: first.expected,
        record: { ...first.stored, payload: { publicKey: "changed" } },
      }),
    );
    expect(Exit.isFailure(conflict)).toBe(true);
    await Effect.runPromise(
      restarted.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: second.expected,
        record: second.stored,
      }),
    );
    const receipt = await Effect.runPromise(
      restarted.finalizeRestoreImport(plan.manifestDigest, finalization()),
    );
    const committed = JSON.stringify([...built.native.entries]);
    // Simulate a lost terminal response: every exact terminal retry is a
    // no-write replay, including after rebuilding the importer on restart.
    const afterCommitRestart = testRestore(built.repository);
    expect(await Effect.runPromise(afterCommitRestart.beginRestoreImport(plan))).toEqual(receipt);
    expect(
      await Effect.runPromise(
        afterCommitRestart.applyRestoreRecord({
          manifestDigest: plan.manifestDigest,
          expected: first.expected,
          record: first.stored,
        }),
      ),
    ).toEqual(receipt);
    expect(
      await Effect.runPromise(
        afterCommitRestart.finalizeRestoreImport(plan.manifestDigest, finalization()),
      ),
    ).toEqual(receipt);
    expect(JSON.stringify([...built.native.entries])).toBe(committed);
    const mismatch = await Effect.runPromiseExit(
      afterCommitRestart.beginRestoreImport({ ...plan, backupID: "backup-restore-0002" }),
    );
    expect(Exit.isFailure(mismatch)).toBe(true);
    expect(revision(built.native.entries)).toBe(1);
    expect(
      (built.native.entries.get("v2.ov/root/accounting") as { payload: { usedBytes: number } })
        .payload.usedBytes,
    ).toBeGreaterThan(initialAccounting);
    expect(built.native.entries.get("v2.ov/blob/accounting")).toMatchObject({
      payload: { referencedBytes: 0, leaseIDs: [], purgeSHA256s: [] },
    });
    expect(built.native.entries.get("v2.ov/root/log-head")).toEqual({
      category: "root.log-head",
      version: 1,
      payload: {
        appendLogSequence: 0,
        appendLogDigest: ownerVaultAppendProofValidate(sourceScope, [])?.appendLogDigest,
      },
    });
  });

  test("accepts the manifest's zero-based append inventory only when strict contiguous P02 rows match its head digest", async () => {
    const entry = (ordinal: number, sequence: number) =>
      imported(ordinal, "append-log.entry", String(sequence).padStart(20, "0"), {
        operationID: `operation-${sequence}`,
        fingerprint: "a".repeat(64),
        payloadHash: "b".repeat(64),
        payloadBase64: "Y2hhbmdl",
        source: "http",
        deviceID: "device-1",
        logSequence: sequence,
      });
    const first = entry(0, 1);
    const second = entry(1, 2);
    const plan = planWithHead(2, first, second);
    const built = await fixture();
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    await Effect.runPromise(
      built.restore.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: first.expected,
        record: first.stored,
      }),
    );
    await Effect.runPromise(
      built.restore.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: second.expected,
        record: second.stored,
      }),
    );
    await Effect.runPromise(
      built.restore.finalizeRestoreImport(plan.manifestDigest, finalization()),
    );
    expect(revision(built.native.entries)).toBe(1);
    expect(built.native.entries.get("v2.ov/append-log/head")).toEqual({
      category: "append-log.head",
      version: 1,
      payload: { appendLogSequence: 2, appendLogDigest: plan.appendLogDigest },
    });
  });

  test("publishes restored N into the catalog and appends N+1 from the canonical head tuple", async () => {
    const entry = (ordinal: number, sequence: number) =>
      imported(ordinal, "append-log.entry", String(sequence).padStart(20, "0"), {
        operationID: `operation-${sequence}`,
        fingerprint: "a".repeat(64),
        payloadHash: "b".repeat(64),
        payloadBase64: "Y2hhbmdl",
        source: "http",
        deviceID: "device-1",
        logSequence: sequence,
      });
    const plan = planWithHead(2, entry(0, 1), entry(1, 2));
    const built = await fixture();
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    for (const item of plan.records) {
      const storedRecord = [entry(0, 1), entry(1, 2)][item.ordinal];
      if (storedRecord === undefined) throw new Error("test setup missing restored row");
      const stored = storedRecord.stored;
      await Effect.runPromise(
        built.restore.applyRestoreRecord({
          manifestDigest: plan.manifestDigest,
          expected: item,
          record: stored,
        }),
      );
    }
    await Effect.runPromise(
      built.restore.finalizeRestoreImport(plan.manifestDigest, finalization()),
    );
    const restoredCatalog = built.native.entries.get("v2.ov/catalog/root/00000000000000000001") as {
      readonly payload: { readonly appendLogSequence: number; readonly appendLogDigest: string };
    };
    expect(restoredCatalog.payload).toMatchObject({
      appendLogSequence: 2,
      appendLogDigest: plan.appendLogDigest,
    });

    const provider = makeOwnerVaultDomainProvider(built.repository, root);
    await Effect.runPromise(provider.initialize());
    await Effect.runPromise(
      provider.issueChallenge(
        {
          challengeID: "challenge-12345678",
          challengeBase64: "challenge",
          challengeAudience: "enroll",
          devicePublicKey: "spki",
          expiresAtMilliseconds: 5_000,
          consumed: false,
        },
        1_000,
      ),
    );
    await Effect.runPromise(
      provider.registerDevice({
        registrationID: "register-12345678",
        proofFingerprint: "c".repeat(64),
        challengeID: "challenge-12345678",
        device: {
          deviceID: "device-1",
          publicKeySPKI: "spki",
          authEpoch: 1,
          credentialEpoch: 1,
          revoked: false,
          securityFloor: 0,
        },
        nowMilliseconds: 1_000,
      }),
    );
    const appended = await Effect.runPromise(
      provider.append({
        operationID: "operation-3",
        fingerprint: "d".repeat(64),
        payloadHash: "e".repeat(64),
        payloadBase64: "Y2hhbmdl",
        source: "http",
        observedHighWater: 2,
        nowSeconds: 1_000,
        receiptExpiresAtSeconds: 2_000,
        actor: { deviceID: "device-1", authEpoch: 1, credentialEpoch: 1, securityFloor: 0 },
        nonce: {
          value: "nonce-123456789012",
          expiresAtSeconds: 1_200,
          fingerprint: "f".repeat(64),
        },
        capability: {
          jti: "jti-123456789012",
          expiresAtSeconds: 1_200,
          resource: "/v2/sync",
          claims: '{"jti":"jti-123456789012","operationID":"operation-3"}',
          claimsFingerprint: "28be316b46f6d80eafb3e66807d45a441d233b5c5247fee7454c245e27096448",
          tokenFingerprint: "e".repeat(64),
        },
      }),
    );
    expect(appended.logSequence).toBe(3);
    const catalog = built.native.entries.get("v2.ov/catalog/current") as {
      readonly payload: { readonly catalogRevision: number };
    };
    const nextCatalog = built.native.entries.get(
      `v2.ov/catalog/root/${String(catalog.payload.catalogRevision).padStart(20, "0")}`,
    ) as { readonly payload: { readonly appendLogSequence: number } };
    expect(nextCatalog.payload.appendLogSequence).toBe(3);
  });

  test("rejects missing, extra, or head-chain-mismatched append inventories before publication", async () => {
    const entry = imported(0, "append-log.entry", "00000000000000000001", {
      operationID: "operation-1",
      fingerprint: "a".repeat(64),
      payloadHash: "b".repeat(64),
      payloadBase64: "Y2hhbmdl",
      source: "http",
      deviceID: "device-1",
      logSequence: 1,
    });
    const valid = planWithHead(1, entry);
    for (const plan of [
      { ...valid, appendLogSequence: 2 },
      { ...valid, appendLogSequence: 0 },
      { ...valid, appendLogDigest: "a".repeat(64) },
    ]) {
      const built = await fixture();
      await Effect.runPromise(built.restore.beginRestoreImport(plan));
      await Effect.runPromise(
        built.restore.applyRestoreRecord({
          manifestDigest: plan.manifestDigest,
          expected: entry.expected,
          record: entry.stored,
        }),
      );
      const exit = await Effect.runPromiseExit(
        built.restore.finalizeRestoreImport(plan.manifestDigest, finalization()),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(revision(built.native.entries)).toBe(0);
    }
  });

  test("rejects a tampered strict append entry and keeps the target private", async () => {
    const entry = imported(0, "append-log.entry", "00000000000000000001", {
      operationID: "operation-1",
      fingerprint: "a".repeat(64),
      payloadHash: "b".repeat(64),
      payloadBase64: "Y2hhbmdl",
      source: "http",
      deviceID: "device-1",
      logSequence: 1,
    });
    const plan = planWithHead(1, entry);
    const built = await fixture();
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    await Effect.runPromise(
      built.restore.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: entry.expected,
        record: entry.stored,
      }),
    );
    built.native.entries.set("v2.ov/append-log/entry/00000000000000000001", {
      category: "append-log.entry",
      version: 1,
      payload: { ...entry.stored.payload, logSequence: 2 },
    });
    const exit = await Effect.runPromiseExit(
      built.restore.finalizeRestoreImport(plan.manifestDigest, finalization()),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(revision(built.native.entries)).toBe(0);
  });

  test("rolls finalization back on staged-row corruption and never advances the catalog", async () => {
    const item = record(0, "device-a");
    const plan = planFor(item);
    const built = await fixture();
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    await Effect.runPromise(
      built.restore.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: item.expected,
        record: item.stored,
      }),
    );
    built.native.entries.set("v2.ov/device/device-a", {
      category: "device",
      version: 1,
      payload: { publicKey: "tampered" },
    });
    const exit = await Effect.runPromiseExit(
      built.restore.finalizeRestoreImport(plan.manifestDigest, finalization()),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(revision(built.native.entries)).toBe(0);
    expect(built.native.entries.has("v2.ov/blob/accounting")).toBe(false);
  });

  test("rolls finalization back when the pure reconstruction callback rejects its typed inventory", async () => {
    const item = record(0, "device-a");
    const plan = planFor(item);
    const built = await fixture();
    const restore = makeOwnerVaultRestoreImport({
      repository: built.repository,
      reconstruct: () => ({
        _tag: "OwnerVaultBlobRestoreReconstructionFailure",
        reason: "invalid_inventory",
      }),
    });
    await Effect.runPromise(restore.beginRestoreImport(restoreID, plan));
    await Effect.runPromise(
      restore.applyRestoreRecord({
        restoreID,
        manifestDigest: plan.manifestDigest,
        expected: item.expected,
        record: item.stored,
      }),
    );
    const exit = await Effect.runPromiseExit(
      restore.finalizeRestoreImport(restoreID, plan.manifestDigest, finalization()),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(revision(built.native.entries)).toBe(0);
    expect(built.native.entries.has("v2.ov/blob/accounting")).toBe(false);
  });

  test("derives blob inventory from restored rows and rejects source object-key evidence through P03", async () => {
    const built = await fixture();
    const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const sourceScope: BlobScope = {
      ownerID: required(ownerID(root.ownerID)),
      vaultID: required(vaultID(root.vaultID)),
      generationEpoch: 1,
    };
    const sourceKey = required(blobObjectKey(sourceScope, sha256));
    const metadata = imported(0, "blob.metadata", sha256, {
      requestID: "restore-request-0001",
      path: "notes/today",
      sha256,
      size: 3,
      objectKey: sourceKey,
    });
    const reference = imported(1, "blob.reference", sha256, {
      objectKey: sourceKey,
      size: 3,
      referenceCount: 1,
      activeLeaseCount: 0,
    });
    const plan = planFor(metadata, reference);
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    await Effect.runPromise(
      built.restore.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: metadata.expected,
        record: metadata.stored,
      }),
    );
    await Effect.runPromise(
      built.restore.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: reference.expected,
        record: reference.stored,
      }),
    );
    const exit = await Effect.runPromiseExit(
      built.restore.finalizeRestoreImport(plan.manifestDigest, {
        ...finalization(),
        targetBlobEvidence: [
          {
            sha256,
            requestID: "restore-request-0001",
            path: "notes/today",
            size: 3,
            objectKey: sourceKey,
          },
        ],
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(revision(built.native.entries)).toBe(0);
    expect(built.native.entries.has("v2.ov/blob/accounting")).toBe(false);
  });

  test("rejects empty or substituted target evidence instead of trusting caller-selected blob inventory", async () => {
    const built = await fixture();
    const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const targetKey = required(blobObjectKey(blobScope, sha256));
    const metadata = imported(0, "blob.metadata", sha256, {
      requestID: "restore-request-0001",
      path: "notes/today",
      sha256,
      size: 3,
      objectKey: targetKey,
    });
    const reference = imported(1, "blob.reference", sha256, {
      objectKey: targetKey,
      size: 3,
      referenceCount: 1,
      activeLeaseCount: 0,
    });
    const plan = planFor(metadata, reference);
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    await Effect.runPromise(
      built.restore.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: metadata.expected,
        record: metadata.stored,
      }),
    );
    await Effect.runPromise(
      built.restore.applyRestoreRecord({
        manifestDigest: plan.manifestDigest,
        expected: reference.expected,
        record: reference.stored,
      }),
    );
    const exit = await Effect.runPromiseExit(
      built.restore.finalizeRestoreImport(plan.manifestDigest, finalization()),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const substituted = await Effect.runPromiseExit(
      built.restore.finalizeRestoreImport(plan.manifestDigest, {
        ...finalization(),
        targetBlobEvidence: [
          {
            sha256,
            requestID: "restore-request-0001",
            path: "notes/today",
            size: 3,
            objectKey: "v2/blobs/substituted",
          },
        ],
      }),
    );
    expect(Exit.isFailure(substituted)).toBe(true);
    expect(revision(built.native.entries)).toBe(0);
    expect(built.native.entries.has("v2.ov/blob/accounting")).toBe(false);
  });
});
