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
import type { OwnerVaultRestoreImportPlan, OwnerVaultRestoreImportRecord } from "./backup-types";
import { makeDurableObjectOwnerVaultStorageRepository } from "./repository";
import { makeOwnerVaultRestoreImport, ownerVaultRestoreImportHashChain } from "./restore-import";
import type { OwnerVaultStorageRecord } from "./storage-registry";

const root = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 2, namespaceState: "PRIVATE" } as const;
const required = <A>(value: A | undefined): A => { if (value === undefined) throw new Error("test setup"); return value; };
const blobScope: BlobScope = { ownerID: required(ownerID(root.ownerID)), vaultID: required(vaultID(root.vaultID)), generationEpoch: root.generationEpoch };
const blobLimits: BlobLimits = { maximumBlobBytes: 16, maximumVaultBytes: 32, maximumOrphanBytes: 16, maximumOrphanCount: 2, maximumActiveLeasesPerVault: 4, maximumActiveLeasesPerFinal: 4, stageTTLSeconds: 10 };

const nativeState = (): {
  readonly state: DurableObjectStateNative;
  readonly storage: DurableObjectStorageNative;
  readonly entries: Map<string, unknown>;
} => {
  const entries = new Map<string, unknown>();
  const transaction: DurableObjectTransactionNative = {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, value) => { entries.set(key, value); return Promise.resolve(); },
    delete: (key) => Promise.resolve(entries.delete(key)),
  };
  const storage: DurableObjectStorageNative = {
    ...transaction, getAlarm: () => Promise.resolve(null), setAlarm: () => Promise.resolve(), deleteAlarm: () => Promise.resolve(),
    transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
      const before = new Map(entries);
      return work(transaction).catch((error: unknown) => { entries.clear(); for (const [key, value] of before) entries.set(key, value); return Promise.reject(error); });
    },
  };
  return { entries, storage, state: { storage, blockConcurrencyWhile: (work) => work() } };
};

const fixture = async () => {
  const native = nativeState();
  const repository = makeDurableObjectOwnerVaultStorageRepository(makeDurableObjectBoundary(native.state).storage);
  await Effect.runPromise(repository.transact((tx) => tx.initialize(root)));
  return { native, repository, restore: makeOwnerVaultRestoreImport({ repository }) };
};
const digest = (text: string): string => ownerVaultBackupDigest(new TextEncoder().encode(text));
const record = (ordinal: number, id: string): { readonly expected: OwnerVaultRestoreImportRecord; readonly stored: OwnerVaultStorageRecord } => {
  const stored: OwnerVaultStorageRecord = { category: "device", version: 1, payload: { publicKey: `spki-${id}` } };
  const bytes = canonicalSnapshotRecordBytes({ category: "device", identifier: id }, stored);
  if (bytes === undefined) throw new Error("test setup");
  return { expected: { ordinal, address: { category: "device", identifier: id }, version: 1, category: "device", codec: "owner-vault-storage-record-v1", sha256Base64: ownerVaultBackupDigest(bytes), size: bytes.byteLength }, stored };
};
const planFor = (...items: readonly { readonly expected: OwnerVaultRestoreImportRecord; readonly stored: OwnerVaultStorageRecord }[]): OwnerVaultRestoreImportPlan => {
  const manifestDigest = digest("signed-manifest"); const records = items.map((item) => item.expected);
  const hashChain = ownerVaultRestoreImportHashChain(manifestDigest, records);
  if (hashChain === undefined) throw new Error("test setup");
  return { backupID: "backup-restore-0001", manifestDigest, highWaterMark: digest("high-water"), logHead: 2, totalBytes: records.reduce((total, item) => total + item.size, 0), objectCount: records.length, hashChain, records };
};
const finalization = () => ({ blobScope, blobLimits, targetScopedBlobInventory: { metadata: [], references: [], tombstones: [] } });
const revision = (entries: Map<string, unknown>): number => (entries.get("v2.ov/catalog/current") as { payload: { catalogRevision: number } }).payload.catalogRevision;

describe("OwnerVault C1 restore import", () => {
  test("keeps partial rows non-authoritative across restart, requires ordinal order, and accepts only exact duplicate replay", async () => {
    const first = record(1, "device-a"); const second = record(2, "device-b"); const plan = planFor(first, second);
    const built = await fixture();
    const initialAccounting = (built.native.entries.get("v2.ov/root/accounting") as { payload: { usedBytes: number } }).payload.usedBytes;
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    await Effect.runPromise(built.restore.applyRestoreRecord({ manifestDigest: plan.manifestDigest, expected: first.expected, record: first.stored }));
    expect(revision(built.native.entries)).toBe(0);
    expect(built.native.entries.has("v2.ov/device/device-a")).toBe(true);
    expect(built.native.entries.has("v2.ov/catalog/page/00000000000000000001-0000")).toBe(false);

    const restarted = makeOwnerVaultRestoreImport({ repository: built.repository });
    await Effect.runPromise(restarted.applyRestoreRecord({ manifestDigest: plan.manifestDigest, expected: first.expected, record: first.stored }));
    const outOfOrder = await Effect.runPromiseExit(restarted.applyRestoreRecord({ manifestDigest: plan.manifestDigest, expected: { ...second.expected, ordinal: 3 }, record: second.stored }));
    expect(Exit.isFailure(outOfOrder)).toBe(true);
    const conflict = await Effect.runPromiseExit(restarted.applyRestoreRecord({ manifestDigest: plan.manifestDigest, expected: first.expected, record: { ...first.stored, payload: { publicKey: "changed" } } }));
    expect(Exit.isFailure(conflict)).toBe(true);
    await Effect.runPromise(restarted.applyRestoreRecord({ manifestDigest: plan.manifestDigest, expected: second.expected, record: second.stored }));
    await Effect.runPromise(restarted.finalizeRestoreImport(plan.manifestDigest, finalization()));
    expect(revision(built.native.entries)).toBe(1);
    expect((built.native.entries.get("v2.ov/root/accounting") as { payload: { usedBytes: number } }).payload.usedBytes).toBeGreaterThan(initialAccounting);
    expect(built.native.entries.get("v2.ov/blob/accounting")).toMatchObject({ payload: { referencedBytes: 0, leaseIDs: [], purgeSHA256s: [] } });
    expect(built.native.entries.get("v2.ov/root/log-head")).toEqual({ category: "root.log-head", version: 1, payload: { logSequence: 2 } });
  });

  test("rolls finalization back on staged-row corruption and never advances the catalog", async () => {
    const item = record(1, "device-a"); const plan = planFor(item); const built = await fixture();
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    await Effect.runPromise(built.restore.applyRestoreRecord({ manifestDigest: plan.manifestDigest, expected: item.expected, record: item.stored }));
    built.native.entries.set("v2.ov/device/device-a", { category: "device", version: 1, payload: { publicKey: "tampered" } });
    const exit = await Effect.runPromiseExit(built.restore.finalizeRestoreImport(plan.manifestDigest, finalization()));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(revision(built.native.entries)).toBe(0);
    expect(built.native.entries.has("v2.ov/blob/accounting")).toBe(false);
  });

  test("rolls finalization back when the pure reconstruction callback rejects its typed inventory", async () => {
    const item = record(1, "device-a"); const plan = planFor(item); const built = await fixture();
    const restore = makeOwnerVaultRestoreImport({ repository: built.repository, reconstruct: () => ({ _tag: "OwnerVaultBlobRestoreReconstructionFailure", reason: "invalid_inventory" }) });
    await Effect.runPromise(restore.beginRestoreImport(plan));
    await Effect.runPromise(restore.applyRestoreRecord({ manifestDigest: plan.manifestDigest, expected: item.expected, record: item.stored }));
    const exit = await Effect.runPromiseExit(restore.finalizeRestoreImport(plan.manifestDigest, finalization()));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(revision(built.native.entries)).toBe(0);
    expect(built.native.entries.has("v2.ov/blob/accounting")).toBe(false);
  });

  test("rejects source object-key evidence through the P03 callback and leaves private target non-authoritative", async () => {
    const item = record(1, "device-a"); const plan = planFor(item); const built = await fixture();
    await Effect.runPromise(built.restore.beginRestoreImport(plan));
    await Effect.runPromise(built.restore.applyRestoreRecord({ manifestDigest: plan.manifestDigest, expected: item.expected, record: item.stored }));
    const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const sourceScope: BlobScope = { ownerID: required(ownerID(root.ownerID)), vaultID: required(vaultID(root.vaultID)), generationEpoch: 1 };
    const sourceKey = required(blobObjectKey(sourceScope, sha256));
    const exit = await Effect.runPromiseExit(built.restore.finalizeRestoreImport(plan.manifestDigest, {
      ...finalization(),
      targetScopedBlobInventory: {
        metadata: [{ sha256, requestID: "restore-request-0001", path: "notes/today", size: 3, objectKey: sourceKey }],
        references: [{ sha256, reference: { objectKey: sourceKey, size: 3, referenceCount: 1, activeLeaseCount: 0 } }],
        tombstones: [],
      },
    }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(revision(built.native.entries)).toBe(0);
    expect(built.native.entries.has("v2.ov/blob/accounting")).toBe(false);
  });
});
