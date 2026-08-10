import { describe, expect, test } from "bun:test";
import { ImmutableR2Error, ManifestVerificationError, type ImmutableR2Boundary, type ImmutableR2ObjectMetadata } from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import { canonicalPageBytes, canonicalSnapshotRecordBytes, ownerVaultBackupDigest } from "./backup-canonical";
import { createOwnerVaultBackup, restoreOwnerVaultBackup } from "./backup";
import { OwnerVaultBackupError } from "./backup-types";
import type {
  OwnerVaultBackupPageEntry,
  OwnerVaultBackupRuntime,
  OwnerVaultBackupScope,
  OwnerVaultBackupSnapshotSource,
  OwnerVaultPrivateRestoreTarget,
  OwnerVaultRestoreJournal,
  OwnerVaultSnapshotObject,
} from "./backup-types";

const scope: OwnerVaultBackupScope = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 3 };
const backupID = "backup-0000000001";
const objectKey = (ordinal: number) => `v2/owner-vault/backups/${scope.ownerID}/${scope.vaultID}/${scope.generationEpoch}/${backupID}/objects/${ordinal.toString().padStart(8, "0")}.json`;

const r2 = (): { readonly boundary: ImmutableR2Boundary; readonly objects: Map<string, Uint8Array> } => {
  const objects = new Map<string, Uint8Array>();
  const copy = (input: Uint8Array) => new Uint8Array(input);
  const meta = (key: string, bytes: Uint8Array): ImmutableR2ObjectMetadata => ({ key, etag: ownerVaultBackupDigest(bytes), size: bytes.byteLength });
  return {
    objects,
    boundary: {
      putIfAbsent: (key, bytes) => objects.has(key)
        ? Effect.fail(new ImmutableR2Error({ operation: "put_if_absent", reason: "already_exists" }))
        : Effect.sync(() => { objects.set(key, copy(bytes)); return meta(key, bytes); }),
      head: (key) => Effect.sync(() => { const bytes = objects.get(key); return bytes === undefined ? undefined : meta(key, bytes); }),
      read: (key) => {
        const bytes = objects.get(key);
        return bytes === undefined
          ? Effect.fail(new ImmutableR2Error({ operation: "read", reason: "not_found" }))
          : Effect.succeed({ ...meta(key, bytes), bytes: copy(bytes) });
      },
      listExactPrefix: () => Effect.succeed({ objects: [], truncated: false }),
      deleteExact: (key) => Effect.sync(() => { objects.delete(key); }),
    },
  };
};

const runtime = (boundary: ImmutableR2Boundary): OwnerVaultBackupRuntime => ({
  r2: boundary,
  signer: { signCanonical: (bytes) => Effect.succeed({ keyID: "backup-key", signatureDERBase64: ownerVaultBackupDigest(bytes) }) },
  verifier: { verifyCanonical: (bytes, signature) => signature.keyID === "backup-key" && signature.signatureDERBase64 === ownerVaultBackupDigest(bytes) ? Effect.void : Effect.fail(new ManifestVerificationError({ reason: "signature_invalid" })) },
});

const records = (): readonly OwnerVaultSnapshotObject[] => {
  const source: readonly { readonly category: OwnerVaultSnapshotObject["address"]["category"]; readonly identifier: string; readonly payload: Readonly<Record<string, unknown>> }[] = [
    { category: "device", identifier: "device-1", payload: { publicKey: "key" } },
    { category: "append-log.entry", identifier: "00000000000000000001", payload: { operationID: "op-1", payload: "change" } },
  ];
  return source.map((item, ordinal) => {
    const address = { category: item.category, identifier: item.identifier } as const;
    const record = { category: item.category, version: 1 as const, payload: item.payload };
    const bytes = canonicalSnapshotRecordBytes(address, record);
    if (bytes === undefined) throw new Error("test encoding failed");
    return { ordinal, address, record, size: bytes.byteLength, sha256Base64: ownerVaultBackupDigest(bytes) };
  });
};

const source = (items = records()): OwnerVaultBackupSnapshotSource => {
  const entries: OwnerVaultBackupPageEntry[] = items.map((item) => ({
    ordinal: item.ordinal,
    key: objectKey(item.ordinal),
    sha256Base64: item.sha256Base64,
    size: item.size,
    category: item.address.category,
    identifier: item.address.identifier,
  }));
  const pageBytes = canonicalPageBytes({ ordinal: 0, entries, digest: "" });
  if (pageBytes === undefined) throw new Error("test page encoding failed");
  const catalog = ownerVaultBackupDigest(new TextEncoder().encode(JSON.stringify(entries.map(({ key, ...entry }) => entry))));
  return {
    beginSnapshot: () => Effect.succeed({ backupID, scope, highWaterMark: ownerVaultBackupDigest(new TextEncoder().encode("high-water")), logHead: 1, catalogDigest: catalog, pinProof: "p".repeat(16) }),
    readSnapshotPage: (_pin, cursor) => cursor === undefined
      ? Effect.succeed({ entries: items, digest: ownerVaultBackupDigest(pageBytes) })
      : Effect.fail(new OwnerVaultBackupError({ reason: "catalog_invalid" })),
    releaseSnapshot: () => Effect.void,
  };
};

const target = (): { readonly target: OwnerVaultPrivateRestoreTarget; readonly applied: number[]; readonly events: string[] } => {
  let journal: OwnerVaultRestoreJournal | undefined;
  const applied: number[] = [];
  const events: string[] = [];
  return {
    applied,
    events,
    target: {
      root: { ownerID: scope.ownerID, vaultID: scope.vaultID, generationEpoch: 4, namespaceState: "PRIVATE" },
      assertFreshPrivateTarget: () => Effect.sync(() => events.push("private")),
      readJournal: () => Effect.succeed(journal),
      writeJournal: (next) => Effect.sync(() => { journal = next; events.push(`journal:${next.lastAppliedOrdinal}:${next.state}`); }),
      applyRecord: (entry) => Effect.sync(() => { applied.push(entry.ordinal); }),
      writeRestoreAudit: () => Effect.sync(() => events.push("audit")),
      completeRestore: (input) => Effect.sync(() => events.push(`complete:${input.highWaterMark}:${input.logHead}`)),
    },
  };
};

describe("OwnerVault bounded paged backup and private restore", () => {
  test("archives a pinned high-water page and restores it into a later private generation", async () => {
    const store = r2();
    const signed = await Effect.runPromise(createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID));
    expect(signed.manifest.objectCount).toBe(2);
    expect(signed.manifest.pages).toHaveLength(1);
    const restored = target();
    await Effect.runPromise(restoreOwnerVaultBackup(runtime(store.boundary), restored.target, scope, backupID));
    expect(restored.applied).toEqual([0, 1]);
    expect(restored.events).toEqual(expect.arrayContaining(["private", "audit", "journal:1:COMPLETED"]));
  });

  test("fails closed for a tampered signed manifest", async () => {
    const store = r2();
    await Effect.runPromise(createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID));
    const key = `v2/owner-vault/backups/${scope.ownerID}/${scope.vaultID}/${scope.generationEpoch}/${backupID}/manifest.json`;
    const bytes = store.objects.get(key);
    if (bytes === undefined) throw new Error("manifest missing");
    const text = new TextDecoder().decode(bytes).replace("backup-key", "other-key_");
    store.objects.set(key, new TextEncoder().encode(text));
    const exit = await Effect.runPromiseExit(restoreOwnerVaultBackup(runtime(store.boundary), target().target, scope, backupID));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("manifest_untrusted");
  });

  test("rejects a source catalog with a mismatched R2 metadata proof", async () => {
    const bad = records().map((entry) => entry.ordinal === 0 ? { ...entry, r2: { key: "r2-key", size: entry.size + 1, sha256Base64: entry.sha256Base64 } } : entry);
    const exit = await Effect.runPromiseExit(createOwnerVaultBackup(source(bad), runtime(r2().boundary), scope, backupID));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("catalog_invalid");
  });

  test("resumes from its bounded per-object journal after a target interruption", async () => {
    const store = r2();
    await Effect.runPromise(createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID));
    const restored = target();
    let interrupted = true;
    const interrupting: OwnerVaultPrivateRestoreTarget = {
      ...restored.target,
      applyRecord: (entry, record) => entry.ordinal === 1 && interrupted
        ? Effect.fail(new OwnerVaultBackupError({ reason: "source_unavailable" }))
        : restored.target.applyRecord(entry, record),
    };
    const first = await Effect.runPromiseExit(restoreOwnerVaultBackup(runtime(store.boundary), interrupting, scope, backupID));
    expect(Exit.isFailure(first)).toBe(true);
    interrupted = false;
    await Effect.runPromise(restoreOwnerVaultBackup(runtime(store.boundary), interrupting, scope, backupID));
    expect(restored.applied).toEqual([0, 1]);
    expect(restored.events).toContain("journal:1:COMPLETED");
  });

  test("rejects a tampered page and a non-contiguous append sequence before completion", async () => {
    const store = r2();
    await Effect.runPromise(createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID));
    const page = `v2/owner-vault/backups/${scope.ownerID}/${scope.vaultID}/${scope.generationEpoch}/${backupID}/pages/00000000.json`;
    const original = store.objects.get(page);
    if (original === undefined) throw new Error("page missing");
    store.objects.set(page, new TextEncoder().encode(new TextDecoder().decode(original).replace("device-1", "device-2")));
    const pageExit = await Effect.runPromiseExit(restoreOwnerVaultBackup(runtime(store.boundary), target().target, scope, backupID));
    expect(Exit.isFailure(pageExit)).toBe(true);
    expect(JSON.stringify(pageExit)).toContain("integrity_failed");

    const second = r2();
    const sequence = records().map((entry) => {
      if (entry.ordinal !== 1) return entry;
      const address = { ...entry.address, identifier: "00000000000000000002" };
      const bytes = canonicalSnapshotRecordBytes(address, entry.record);
      if (bytes === undefined) throw new Error("test encoding failed");
      return { ...entry, address, size: bytes.byteLength, sha256Base64: ownerVaultBackupDigest(bytes) };
    });
    await Effect.runPromise(createOwnerVaultBackup(source(sequence), runtime(second.boundary), scope, backupID));
    const sequenceExit = await Effect.runPromiseExit(restoreOwnerVaultBackup(runtime(second.boundary), target().target, scope, backupID));
    expect(Exit.isFailure(sequenceExit)).toBe(true);
    expect(JSON.stringify(sequenceExit)).toContain("integrity_failed");
  });
});
