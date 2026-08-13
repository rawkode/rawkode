import { describe, expect, test } from "bun:test";
import {
  type ImmutableR2Boundary,
  ImmutableR2Error,
  type ImmutableR2ObjectMetadata,
  ManifestVerificationError,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import { ownerVaultAppendProofValidate } from "./append-proof";
import { createOwnerVaultBackup, restoreOwnerVaultBackup } from "./backup";
import {
  canonicalOwnerVaultBackupBytes,
  canonicalPageBytes,
  canonicalSnapshotRecordBytes,
  ownerVaultBackupControlDigest,
  ownerVaultBackupDigest,
  validOwnerVaultBackupControlDigest,
} from "./backup-canonical";
import { OwnerVaultBackupError } from "./backup-types";
import type {
  OwnerVaultBackupPageEntry,
  OwnerVaultBackupRuntime,
  OwnerVaultBackupScope,
  OwnerVaultBackupSnapshotSource,
  OwnerVaultPrivateRestoreTarget,
  OwnerVaultRestoreImportReceipt,
  OwnerVaultSnapshotObject,
} from "./backup-types";

const scope: OwnerVaultBackupScope = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 3 };
const backupID = "backup-0000000001";
const objectKey = (ordinal: number) =>
  `v2/owner-vault/backups/${scope.ownerID}/${scope.vaultID}/${scope.generationEpoch}/${backupID}/objects/${ordinal.toString().padStart(8, "0")}.json`;

const r2 = (): {
  readonly boundary: ImmutableR2Boundary;
  readonly objects: Map<string, Uint8Array>;
} => {
  const objects = new Map<string, Uint8Array>();
  const copy = (input: Uint8Array) => new Uint8Array(input);
  const meta = (key: string, bytes: Uint8Array): ImmutableR2ObjectMetadata => ({
    key,
    etag: ownerVaultBackupDigest(bytes),
    size: bytes.byteLength,
  });
  return {
    objects,
    boundary: {
      putIfAbsent: (key, bytes) =>
        objects.has(key)
          ? Effect.fail(
              new ImmutableR2Error({ operation: "put_if_absent", reason: "already_exists" }),
            )
          : Effect.sync(() => {
              objects.set(key, copy(bytes));
              return meta(key, bytes);
            }),
      head: (key) =>
        Effect.sync(() => {
          const bytes = objects.get(key);
          return bytes === undefined ? undefined : meta(key, bytes);
        }),
      read: (key) => {
        const bytes = objects.get(key);
        return bytes === undefined
          ? Effect.fail(new ImmutableR2Error({ operation: "read", reason: "not_found" }))
          : Effect.succeed({ ...meta(key, bytes), bytes: copy(bytes) });
      },
      listExactPrefix: () => Effect.succeed({ objects: [], truncated: false }),
      deleteExact: (key) =>
        Effect.sync(() => {
          objects.delete(key);
        }),
    },
  };
};

const runtime = (boundary: ImmutableR2Boundary): OwnerVaultBackupRuntime => ({
  r2: boundary,
  signer: {
    keyID: "backup-key",
    signCanonical: (bytes) =>
      Effect.succeed({ keyID: "backup-key", signatureDERBase64: ownerVaultBackupDigest(bytes) }),
  },
  verifier: {
    verifyCanonical: (bytes, signature) =>
      signature.keyID === "backup-key" &&
      signature.signatureDERBase64 === ownerVaultBackupDigest(bytes)
        ? Effect.void
        : Effect.fail(new ManifestVerificationError({ reason: "signature_invalid" })),
  },
});

const records = (): readonly OwnerVaultSnapshotObject[] => {
  const source: readonly {
    readonly category: OwnerVaultSnapshotObject["address"]["category"];
    readonly identifier: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[] = [
    { category: "device", identifier: "device-1", payload: { publicKey: "key" } },
    {
      category: "append-log.entry",
      identifier: "00000000000000000001",
      payload: {
        operationID: "operation-1",
        fingerprint: "a".repeat(64),
        payloadHash: "b".repeat(64),
        payloadBase64: "Y2hhbmdl",
        source: "http",
        deviceID: "device-1",
        logSequence: 1,
      },
    },
  ];
  return source.map((item, ordinal) => {
    const address = { category: item.category, identifier: item.identifier } as const;
    const record = { category: item.category, version: 1 as const, payload: item.payload };
    const bytes = canonicalSnapshotRecordBytes(address, record);
    if (bytes === undefined) throw new Error("test encoding failed");
    return {
      ordinal,
      address,
      record,
      size: bytes.byteLength,
      sha256Base64: ownerVaultBackupDigest(bytes),
    };
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
  const catalog = ownerVaultBackupDigest(
    new TextEncoder().encode(JSON.stringify(entries.map(({ key, ...entry }) => entry))),
  );
  const appendEntries = items
    .filter((item) => item.address.category === "append-log.entry")
    .map((item) => item.record.payload as unknown as import("./domains").OwnerVaultAppendLogEntry);
  const appendProof = ownerVaultAppendProofValidate(scope, appendEntries);
  if (appendProof === undefined) throw new Error("test append proof setup failed");
  return {
    beginSnapshot: () =>
      Effect.succeed({
        backupID,
        scope,
        highWaterMark: ownerVaultBackupDigest(new TextEncoder().encode("high-water")),
        appendLogSequence: appendProof.appendLogSequence,
        appendLogDigest: appendProof.appendLogDigest,
        catalogDigest: catalog,
        pinProof: "p".repeat(16),
      }),
    readSnapshotPage: (_pin, cursor) =>
      cursor === undefined
        ? Effect.succeed({ entries: items, digest: ownerVaultBackupDigest(pageBytes) })
        : Effect.fail(new OwnerVaultBackupError({ reason: "catalog_invalid" })),
    completeSnapshot: () => Effect.void,
    releaseSnapshot: () => Effect.void,
    abortSnapshot: () => Effect.void,
  };
};

const target = (
  alreadyCompleted = false,
): {
  readonly target: OwnerVaultPrivateRestoreTarget;
  readonly applied: number[];
  readonly events: string[];
} => {
  const applied: number[] = [];
  const events: string[] = [];
  return {
    applied,
    events,
    target: {
      root: {
        ownerID: scope.ownerID,
        vaultID: scope.vaultID,
        generationEpoch: 4,
        namespaceState: "PRIVATE",
      },
      assertFreshPrivateTarget: () => Effect.sync(() => events.push("private")),
      restoreImport: {
        recoverRestoreImport: () => Effect.succeed(undefined),
        beginRestoreImport: (_restoreID, plan) =>
          Effect.sync(() => {
            events.push(`begin:${plan.objectCount}`);
            return alreadyCompleted ? ({} as OwnerVaultRestoreImportReceipt) : undefined;
          }),
        applyRestoreRecord: ({ expected }) =>
          Effect.sync(() => {
            applied.push(expected.ordinal);
            return undefined;
          }),
        finalizeRestoreImport: () =>
          Effect.sync(() => {
            events.push("complete");
            return {} as import("./backup-types").OwnerVaultRestoreImportReceipt;
          }),
        finalizeRestoreImportWithTerminalFence: () =>
          Effect.sync(() => {
            events.push("complete");
            return {} as import("./backup-types").OwnerVaultRestoreImportReceipt;
          }),
      },
      blobScope: {
        ownerID: { value: scope.ownerID },
        vaultID: { value: scope.vaultID },
        generationEpoch: 4,
      },
      blobLimits: {
        maximumBlobBytes: 8 * 1024 * 1024,
        maximumVaultBytes: 96 * 1024 * 1024,
        maximumOrphanBytes: 0,
        maximumOrphanCount: 0,
        maximumActiveLeasesPerVault: 32,
        maximumActiveLeasesPerFinal: 32,
        stageTTLSeconds: 60,
      },
    },
  };
};

describe("OwnerVault bounded paged backup and private restore", () => {
  test("uses one canonical base64url digest spelling for Directory control", () => {
    const control = ownerVaultBackupControlDigest(new Uint8Array([1, 2, 3]));
    expect(control).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(validOwnerVaultBackupControlDigest(control)).toBe(true);
    expect(validOwnerVaultBackupControlDigest(`${control}=`)).toBe(false);
    expect(validOwnerVaultBackupControlDigest(`${control.slice(0, -1)}+`)).toBe(false);
  });

  test("archives a pinned high-water page and restores it into a later private generation", async () => {
    const store = r2();
    const signed = await Effect.runPromise(
      createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID),
    );
    expect(signed.manifest.objectCount).toBe(2);
    expect(signed.manifest.pages).toHaveLength(1);
    const restored = target();
    await Effect.runPromise(
      restoreOwnerVaultBackup(runtime(store.boundary), restored.target, scope, backupID),
    );
    expect(restored.applied).toEqual([0, 1]);
    expect(restored.events).toEqual(expect.arrayContaining(["private", "begin:2", "complete"]));
  });

  test("fails closed for a tampered signed manifest", async () => {
    const store = r2();
    await Effect.runPromise(
      createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID),
    );
    const key = `v2/owner-vault/backups/${scope.ownerID}/${scope.vaultID}/${scope.generationEpoch}/${backupID}/manifest.json`;
    const bytes = store.objects.get(key);
    if (bytes === undefined) throw new Error("manifest missing");
    const text = new TextDecoder().decode(bytes).replace("backup-key", "other-key_");
    store.objects.set(key, new TextEncoder().encode(text));
    const exit = await Effect.runPromiseExit(
      restoreOwnerVaultBackup(runtime(store.boundary), target().target, scope, backupID),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("manifest_untrusted");
  });

  test("binds a restore command digest before reading archive pages or applying state", async () => {
    const store = r2();
    await Effect.runPromise(
      createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID),
    );
    const reads: string[] = [];
    const bounded: ImmutableR2Boundary = {
      ...store.boundary,
      read: (key) => {
        reads.push(key);
        return store.boundary.read(key);
      },
    };
    const restored = target();
    const exit = await Effect.runPromiseExit(
      restoreOwnerVaultBackup(
        runtime(bounded),
        restored.target,
        scope,
        backupID,
        ownerVaultBackupControlDigest(new Uint8Array([9])),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("manifest_invalid");
    expect(reads).toHaveLength(1);
    expect(restored.applied).toEqual([]);
    expect(restored.events).toEqual(["private"]);
  });

  test("treats a completed C1 begin receipt as terminal without apply or finalization callbacks", async () => {
    const store = r2();
    await Effect.runPromise(
      createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID),
    );
    const restored = target(true);
    await Effect.runPromise(
      restoreOwnerVaultBackup(runtime(store.boundary), restored.target, scope, backupID),
    );
    expect(restored.applied).toEqual([]);
    expect(restored.events).toEqual(["private", "begin:2"]);
  });

  test("rejects a source catalog with a mismatched R2 metadata proof", async () => {
    const bad = records().map((entry) =>
      entry.ordinal === 0
        ? {
            ...entry,
            r2: { key: "r2-key", size: entry.size + 1, sha256Base64: entry.sha256Base64 },
          }
        : entry,
    );
    const exit = await Effect.runPromiseExit(
      createOwnerVaultBackup(source(bad), runtime(r2().boundary), scope, backupID),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("catalog_invalid");
  });

  test("resumes from its bounded per-object journal after a target interruption", async () => {
    const store = r2();
    await Effect.runPromise(
      createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID),
    );
    const restored = target();
    let interrupted = true;
    const interrupting: OwnerVaultPrivateRestoreTarget = {
      ...restored.target,
      restoreImport: {
        ...restored.target.restoreImport,
        applyRestoreRecord: ({ restoreID, expected, record }) =>
          expected.ordinal === 1 && interrupted
            ? Effect.fail(new OwnerVaultBackupError({ reason: "source_unavailable" }))
            : restored.target.restoreImport.applyRestoreRecord({
                restoreID,
                manifestDigest: "a".repeat(44),
                expected,
                record,
              }),
      },
    };
    const first = await Effect.runPromiseExit(
      restoreOwnerVaultBackup(runtime(store.boundary), interrupting, scope, backupID),
    );
    expect(Exit.isFailure(first)).toBe(true);
    interrupted = false;
    await Effect.runPromise(
      restoreOwnerVaultBackup(runtime(store.boundary), interrupting, scope, backupID),
    );
    expect(restored.applied).toEqual([0, 0, 1]);
    expect(restored.events).toContain("complete");
  });

  test("rejects a re-signed page whose entries decode outside the closed grammar before any object read or import", async () => {
    // Every digest and signature is recomputed consistently, so only the exact
    // page-entry decoder can reject the archive - and it must do so before any
    // object bytes are read and before the import transaction begins.
    const corrupt = async (mutate: (entry: Record<string, unknown>) => Record<string, unknown>) => {
      const store = r2();
      await Effect.runPromise(
        createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID),
      );
      const prefix = `v2/owner-vault/backups/${scope.ownerID}/${scope.vaultID}/${scope.generationEpoch}/${backupID}`;
      const pageStorageKey = `${prefix}/pages/00000000.json`;
      const manifestStorageKey = `${prefix}/manifest.json`;
      const text = new TextDecoder("utf-8", { fatal: true });
      const pageBytes = store.objects.get(pageStorageKey);
      const manifestBytes = store.objects.get(manifestStorageKey);
      if (pageBytes === undefined || manifestBytes === undefined)
        throw new Error("archive missing");
      const page = JSON.parse(text.decode(pageBytes)) as {
        readonly ordinal: number;
        readonly entries: readonly Record<string, unknown>[];
        readonly digest: string;
      };
      const entries = page.entries.map((entry, index) => (index === 0 ? mutate(entry) : entry));
      const unsigned = canonicalOwnerVaultBackupBytes({
        ordinal: page.ordinal,
        entries,
        digest: "",
      });
      if (unsigned === undefined) throw new Error("page encoding failed");
      const digest = ownerVaultBackupDigest(unsigned);
      const tamperedPage = canonicalOwnerVaultBackupBytes({
        ordinal: page.ordinal,
        entries,
        digest,
      });
      if (tamperedPage === undefined) throw new Error("page encoding failed");
      const signed = JSON.parse(text.decode(manifestBytes)) as {
        readonly manifest: Record<string, unknown> & {
          readonly pages: readonly Record<string, unknown>[];
        };
      };
      const manifest = {
        ...signed.manifest,
        pages: signed.manifest.pages.map((descriptor) => ({
          ...descriptor,
          digest,
          size: tamperedPage.byteLength,
        })),
      };
      const canonical = canonicalOwnerVaultBackupBytes(manifest);
      if (canonical === undefined) throw new Error("manifest encoding failed");
      const resigned = canonicalOwnerVaultBackupBytes({
        manifest,
        signature: { keyID: "backup-key", signatureDERBase64: ownerVaultBackupDigest(canonical) },
      });
      if (resigned === undefined) throw new Error("manifest encoding failed");
      store.objects.set(pageStorageKey, tamperedPage);
      store.objects.set(manifestStorageKey, resigned);
      const reads: string[] = [];
      const tracked: ImmutableR2Boundary = {
        ...store.boundary,
        read: (key) => {
          reads.push(key);
          return store.boundary.read(key);
        },
      };
      const restored = target();
      const exit = await Effect.runPromiseExit(
        restoreOwnerVaultBackup(runtime(tracked), restored.target, scope, backupID),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("integrity_failed");
      expect(restored.applied).toEqual([]);
      expect(restored.events).toEqual(["private"]);
      expect(reads.some((key) => key.includes("/objects/"))).toBe(false);
    };
    await corrupt((entry) => ({ ...entry, category: "mystery.category" }));
    await corrupt((entry) => ({ ...entry, provenance: "unknown-member" }));
  });

  test("rejects a tampered page and a non-contiguous append sequence before completion", async () => {
    const store = r2();
    await Effect.runPromise(
      createOwnerVaultBackup(source(), runtime(store.boundary), scope, backupID),
    );
    const page = `v2/owner-vault/backups/${scope.ownerID}/${scope.vaultID}/${scope.generationEpoch}/${backupID}/pages/00000000.json`;
    const original = store.objects.get(page);
    if (original === undefined) throw new Error("page missing");
    store.objects.set(
      page,
      new TextEncoder().encode(new TextDecoder().decode(original).replace("device-1", "device-2")),
    );
    const pageExit = await Effect.runPromiseExit(
      restoreOwnerVaultBackup(runtime(store.boundary), target().target, scope, backupID),
    );
    expect(Exit.isFailure(pageExit)).toBe(true);
    expect(JSON.stringify(pageExit)).toContain("integrity_failed");

    const second = r2();
    const sequence = records().map((entry) => {
      if (entry.ordinal !== 1) return entry;
      const address = { ...entry.address, identifier: "00000000000000000002" };
      const bytes = canonicalSnapshotRecordBytes(address, entry.record);
      if (bytes === undefined) throw new Error("test encoding failed");
      return {
        ...entry,
        address,
        size: bytes.byteLength,
        sha256Base64: ownerVaultBackupDigest(bytes),
      };
    });
    await Effect.runPromise(
      createOwnerVaultBackup(source(sequence), runtime(second.boundary), scope, backupID),
    );
    const sequenceExit = await Effect.runPromiseExit(
      restoreOwnerVaultBackup(runtime(second.boundary), target().target, scope, backupID),
    );
    expect(Exit.isFailure(sequenceExit)).toBe(true);
    expect(JSON.stringify(sequenceExit)).toContain("integrity_failed");
  });
});
