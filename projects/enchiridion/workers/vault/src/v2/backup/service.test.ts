import { describe, expect, test } from "bun:test";
import {
  type ImmutableR2Boundary,
  ImmutableR2Error,
  type ImmutableR2ObjectMetadata,
  type ManifestSigner,
  type ManifestVerifier,
  makeManifestP256KeyRing,
  makeManifestSigner,
  makeManifestVerifier,
} from "@enchiridion/runtime";
import { Effect, Exit, Redacted } from "effect";
import { ownerID, vaultID } from "../foundation/schemas";
import {
  backupArchivePrefix,
  backupManifestKey,
  backupObjectKey,
  backupObjectKinds,
  canonicalSHA256Base64,
  catalogDigest,
  decodeSignedBackupManifest,
  parseBackupObjectKey,
} from "./canonical";
import { createBackup, loadVerifiedBackup, restoreVerifiedBackup } from "./service";
import {
  BackupError,
  type BackupManifest,
  type BackupManifestObject,
  type BackupObjectKind,
  BackupRecoveryRepository,
  BackupRuntime,
  type BackupScope,
  BackupSnapshotSource,
  type BackupRecoveryRepository as RecoveryRepository,
  type BackupRuntime as Runtime,
  type BackupSnapshotSource as SnapshotSource,
} from "./types";

const privateKey =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnqgn2CchsOl0SE25sbl1fSF4GeFyIyhcGXfmk+nORRihRANCAARgDj/LiRqx4+xQpW1yKXYVWEGHCg+4hJxT4PbHMBrFWthHzkiAYKYvic295OBVCfvBwjOQEZVKtWmC+t+IMFbF";
const publicKey =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYA4/y4kasePsUKVtcil2FVhBhwoPuIScU+D2xzAaxVrYR85IgGCmL4nNveTgVQn7wcIzkBGVSrVpgvrfiDBWxQ==";
const now = 1_760_000_000_000;
const backupID = "AAAAAAAAAAAAAAAA";
const owner = ownerID("owner-1");
const vault = vaultID("vault-1");
if (owner === undefined || vault === undefined) throw new Error("test identity invalid");
const scope: BackupScope = { ownerID: owner, vaultID: vault, generationEpoch: 3 };

const metadata = (key: string, bytes: Uint8Array): ImmutableR2ObjectMetadata => ({
  key,
  etag: `etag-${key}`,
  size: bytes.byteLength,
});

const memoryR2 = (): {
  readonly r2: ImmutableR2Boundary;
  readonly objects: Map<string, Uint8Array>;
} => {
  const objects = new Map<string, Uint8Array>();
  const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
    const output = new Uint8Array(bytes.byteLength);
    output.set(bytes);
    return output;
  };
  return {
    objects,
    r2: {
      putIfAbsent: (key, bytes) => {
        if (objects.has(key))
          return Effect.fail(
            new ImmutableR2Error({ operation: "put_if_absent", reason: "already_exists" }),
          );
        objects.set(key, copy(bytes));
        return Effect.succeed(metadata(key, bytes));
      },
      head: (key) => {
        const bytes = objects.get(key);
        return Effect.succeed(bytes === undefined ? undefined : metadata(key, bytes));
      },
      read: (key) => {
        const bytes = objects.get(key);
        return bytes === undefined
          ? Effect.fail(new ImmutableR2Error({ operation: "read", reason: "not_found" }))
          : Effect.succeed({ ...metadata(key, bytes), bytes: copy(bytes) });
      },
      listExactPrefix: (prefix) =>
        Effect.succeed({
          objects: [...objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, bytes]) => metadata(key, bytes)),
          truncated: false,
        }),
      deleteExact: (key) => {
        objects.delete(key);
        return Effect.void;
      },
    },
  };
};

const runtime = async (r2: ImmutableR2Boundary): Promise<Runtime> => {
  const ring = await Effect.runPromise(
    makeManifestP256KeyRing({
      current: {
        keyID: "manifest-current",
        privateKeyPKCS8Base64: Redacted.make(privateKey),
        publicKeySPKIDERBase64: publicKey,
      },
    }),
  );
  const signer: ManifestSigner = makeManifestSigner(ring);
  const verifier: ManifestVerifier = makeManifestVerifier(ring);
  return { r2, signer, verifier };
};

const source = (
  objects: readonly {
    readonly kind: BackupObjectKind;
    readonly sourceID: string;
    readonly text: string;
  }[],
): SnapshotSource => ({
  snapshot: (snapshotScope, archiveID) =>
    Effect.sync(() => {
      const complete = [...objects];
      for (const kind of backupObjectKinds)
        if (!complete.some((object) => object.kind === kind))
          complete.push({ kind, sourceID: `catalog-${kind}`, text: kind });
      const snapshotObjects = complete.map((object) => ({
        kind: object.kind,
        sourceID: object.sourceID,
        bytes: new TextEncoder().encode(object.text),
      }));
      const records: BackupManifestObject[] = [];
      for (const object of snapshotObjects) {
        const key = backupObjectKey(snapshotScope, archiveID, object.kind, object.sourceID);
        if (key === undefined) throw new Error("test key invalid");
        records.push({
          kind: object.kind,
          key,
          sha256Base64: canonicalSHA256Base64(object.bytes),
          size: object.bytes.byteLength,
        });
      }
      records.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
      return {
        highWaterMark: canonicalSHA256Base64(new TextEncoder().encode("high-water")),
        routingEpoch: 7,
        controlEpoch: 9,
        credentialEpoch: 5,
        generationEpoch: snapshotScope.generationEpoch,
        catalogDigest: catalogDigest(records),
        objects: snapshotObjects,
      };
    }),
});

const recovery = (
  targetEpoch = 4,
): {
  readonly repository: RecoveryRepository;
  readonly restored: BackupManifestObject[];
  readonly events: string[];
} => {
  const restored: BackupManifestObject[] = [];
  const events: string[] = [];
  return {
    restored,
    events,
    repository: {
      allocateInactiveGeneration: () =>
        Effect.succeed({
          scope: { ...scope, generationEpoch: targetEpoch },
          inactivePrivate: true,
        }),
      controlEpochFloor: () => Effect.succeed(9),
      restoreObject: (_target, object) =>
        Effect.sync(() => {
          restored.push(object);
          events.push(`restore:${object.key}`);
        }),
      validateInactiveGeneration: (_target, manifest: BackupManifest) =>
        Effect.sync(() => events.push(`validate:${manifest.backupID}`)),
    },
  };
};

const provide = <A>(
  effect: Effect.Effect<A, unknown, Runtime | SnapshotSource | RecoveryRepository>,
  runtimeValue: Runtime,
  sourceValue: SnapshotSource,
  recoveryValue: RecoveryRepository,
) =>
  Effect.provideService(
    Effect.provideService(
      Effect.provideService(effect, BackupRuntime, runtimeValue),
      BackupSnapshotSource,
      sourceValue,
    ),
    BackupRecoveryRepository,
    recoveryValue,
  );

describe("v2 immutable signed backup and recovery", () => {
  test("writes immutable objects before the signed manifest and restores only a fresh generation", async () => {
    const store = memoryR2();
    const recoveryState = recovery();
    const runtimeValue = await runtime(store.r2);
    const sourceValue = source([
      { kind: "tombstone", sourceID: "vault-state", text: "state" },
      { kind: "document", sourceID: "page-1", text: "document" },
      { kind: "blob", sourceID: "blob-1", text: "blob" },
    ]);
    const created = await Effect.runPromise(
      provide(
        createBackup(scope, backupID, now, 60_000),
        runtimeValue,
        sourceValue,
        recoveryState.repository,
      ),
    );
    expect(created.manifest.objects.map((object) => object.key)).toEqual(
      [...created.manifest.objects].map((object) => object.key).sort(),
    );
    const restored = await Effect.runPromise(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        sourceValue,
        recoveryState.repository,
      ),
    );
    expect(restored.scope.generationEpoch).toBe(4);
    expect(recoveryState.restored).toHaveLength(6);
    expect(new Set(created.manifest.objects.map((object) => object.kind))).toEqual(
      new Set(backupObjectKinds),
    );
    expect(recoveryState.events.at(-1)).toBe(`validate:${backupID}`);
  });

  test("owns the complete snapshot before delayed R2 work can observe caller mutation", async () => {
    const store = memoryR2();
    const mutableScope = { ...scope };
    const mutableLimits = {
      maximumObjects: 10,
      maximumObjectBytes: 1_024,
      maximumTotalObjectBytes: 4_096,
      maximumManifestBytes: 4_096,
      maximumObjectKeyBytes: 1_024,
      maximumManifestLifetimeMilliseconds: 60_000,
    };
    const originalObjects = backupObjectKinds.map((kind) => ({
      kind,
      sourceID: `stable-${kind}`,
      bytes: new TextEncoder().encode(`before-${kind}`),
    }));
    const expectedRecords = originalObjects
      .map((object) => {
        const key = backupObjectKey(scope, backupID, object.kind, object.sourceID);
        if (key === undefined) throw new Error("expected backup key");
        return {
          kind: object.kind,
          key,
          size: object.bytes.byteLength,
          sha256Base64: canonicalSHA256Base64(object.bytes),
        };
      })
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const expectedHighWater = canonicalSHA256Base64(new TextEncoder().encode("pre-await"));
    const mutableSnapshot = {
      highWaterMark: expectedHighWater,
      routingEpoch: 7,
      controlEpoch: 9,
      credentialEpoch: 5,
      generationEpoch: scope.generationEpoch,
      catalogDigest: catalogDigest(expectedRecords),
      objects: originalObjects,
    };
    const mutableSource: SnapshotSource = {
      snapshot: () => Effect.succeed(mutableSnapshot),
    };
    let mutated = false;
    const mutateCallerSnapshot = () => {
      if (mutated) return;
      mutated = true;
      originalObjects[0]?.bytes.fill(0);
      if (originalObjects[0] !== undefined) originalObjects[0].sourceID = "mutated-source-id";
      mutableSnapshot.highWaterMark = "not-the-pre-await-high-water";
      mutableSnapshot.routingEpoch = 99;
      mutableSnapshot.controlEpoch = 98;
      mutableSnapshot.credentialEpoch = 97;
      mutableSnapshot.catalogDigest = canonicalSHA256Base64(new TextEncoder().encode("mutated"));
      mutableSnapshot.objects.splice(0, mutableSnapshot.objects.length, {
        kind: "document",
        sourceID: "mutated-document",
        bytes: new TextEncoder().encode("mutated"),
      });
      mutableScope.generationEpoch = 99;
      mutableLimits.maximumObjects = 1;
      mutableLimits.maximumManifestBytes = 1;
    };
    const delayedR2: ImmutableR2Boundary = {
      ...store.r2,
      head: (key) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Promise.resolve());
          yield* Effect.sync(mutateCallerSnapshot);
          return yield* store.r2.head(key);
        }),
    };
    const runtimeValue = await runtime(delayedR2);
    const recoveryState = recovery();
    const restoredBytes = new Map<string, Uint8Array>();
    const restoreRepository: RecoveryRepository = {
      ...recoveryState.repository,
      restoreObject: (_target, object, bytes) =>
        Effect.sync(() => restoredBytes.set(object.key, new Uint8Array(bytes))),
    };
    const created = await Effect.runPromise(
      provide(
        createBackup(mutableScope, backupID, now, 60_000, mutableLimits),
        runtimeValue,
        mutableSource,
        restoreRepository,
      ),
    );
    expect(mutated).toBe(true);
    expect(created.manifest.highWaterMark).toBe(expectedHighWater);
    expect(created.manifest.scope.generationEpoch).toBe(scope.generationEpoch);
    expect(created.manifest.routingEpoch).toBe(7);
    expect(created.manifest.controlEpoch).toBe(9);
    expect(created.manifest.credentialEpoch).toBe(5);
    expect(created.manifest.catalogDigest).toBe(catalogDigest(expectedRecords));
    expect(created.manifest.objects).toEqual(expectedRecords);

    const loaded = await Effect.runPromise(
      provide(
        loadVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        mutableSource,
        restoreRepository,
      ),
    );
    expect(loaded.manifest).toEqual(created.manifest);
    const restored = await Effect.runPromise(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        mutableSource,
        restoreRepository,
      ),
    );
    expect(restored.scope.generationEpoch).toBe(4);
    for (const record of expectedRecords) {
      const archived = store.objects.get(record.key);
      const restoredBytesForRecord = restoredBytes.get(record.key);
      if (archived === undefined || restoredBytesForRecord === undefined)
        throw new Error("expected archived and restored bytes");
      expect(canonicalSHA256Base64(archived)).toBe(record.sha256Base64);
      expect(canonicalSHA256Base64(restoredBytesForRecord)).toBe(record.sha256Base64);
    }
  });

  test("never writes an oversized signed manifest and applies the same bound to load and restore", async () => {
    const limitedStore = memoryR2();
    const limitedRecovery = recovery();
    const limitedRuntime = await runtime(limitedStore.r2);
    const sourceValue = source([{ kind: "document", sourceID: "page-1", text: "document" }]);
    const limits = {
      maximumObjects: 10,
      maximumObjectBytes: 1_024,
      maximumTotalObjectBytes: 4_096,
      maximumManifestBytes: 128,
      maximumObjectKeyBytes: 1_024,
      maximumManifestLifetimeMilliseconds: 60_000,
    };
    const rejectedCreate = await Effect.runPromiseExit(
      provide(
        createBackup(scope, backupID, now, 60_000, limits),
        limitedRuntime,
        sourceValue,
        limitedRecovery.repository,
      ),
    );
    expect(Exit.isFailure(rejectedCreate)).toBe(true);
    const manifestKey = backupManifestKey(scope, backupID);
    if (manifestKey === undefined) throw new Error("expected manifest key");
    expect(limitedStore.objects.has(manifestKey)).toBe(false);

    const fullStore = memoryR2();
    const fullRuntime = await runtime(fullStore.r2);
    await Effect.runPromise(
      provide(
        createBackup(scope, backupID, now, 60_000),
        fullRuntime,
        sourceValue,
        recovery().repository,
      ),
    );
    const encoded = fullStore.objects.get(manifestKey);
    if (encoded === undefined) throw new Error("expected manifest");
    expect(encoded.byteLength).toBeGreaterThan(1_500);
    const limitedLoad = await Effect.runPromiseExit(
      provide(
        loadVerifiedBackup(scope, backupID, now + 1, limits),
        fullRuntime,
        sourceValue,
        recovery().repository,
      ),
    );
    const limitedRestore = await Effect.runPromiseExit(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1, limits),
        fullRuntime,
        sourceValue,
        recovery().repository,
      ),
    );
    expect(Exit.isFailure(limitedLoad)).toBe(true);
    expect(Exit.isFailure(limitedRestore)).toBe(true);
  });

  test("rejects tampering, expiry, immutable collision, and in-place recovery", async () => {
    const store = memoryR2();
    const recoveryState = recovery(3);
    const runtimeValue = await runtime(store.r2);
    const initialSource = source([{ kind: "document", sourceID: "page-1", text: "one" }]);
    await Effect.runPromise(
      provide(
        createBackup(scope, backupID, now, 10),
        runtimeValue,
        initialSource,
        recoveryState.repository,
      ),
    );
    const expired = await Effect.runPromiseExit(
      provide(
        loadVerifiedBackup(scope, backupID, now + 10),
        runtimeValue,
        initialSource,
        recoveryState.repository,
      ),
    );
    expect(Exit.isFailure(expired)).toBe(true);
    const collision = await Effect.runPromiseExit(
      provide(
        createBackup(scope, backupID, now, 60_000),
        runtimeValue,
        source([{ kind: "document", sourceID: "page-1", text: "changed" }]),
        recoveryState.repository,
      ),
    );
    expect(Exit.isFailure(collision)).toBe(true);
    const inPlace = await Effect.runPromiseExit(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        initialSource,
        recoveryState.repository,
      ),
    );
    expect(Exit.isFailure(inPlace)).toBe(true);
    const manifestKey = backupManifestKey(scope, backupID);
    if (manifestKey === undefined) throw new Error("expected manifest key");
    store.objects.set(manifestKey, new TextEncoder().encode("{}"));
    const tampered = await Effect.runPromiseExit(
      provide(
        loadVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        initialSource,
        recoveryState.repository,
      ),
    );
    expect(Exit.isFailure(tampered)).toBe(true);
  });

  test("does not complete an inactive restore when validation fails", async () => {
    const store = memoryR2();
    const recoveryState = recovery();
    const runtimeValue = await runtime(store.r2);
    const sourceValue = source([{ kind: "document", sourceID: "page-1", text: "one" }]);
    await Effect.runPromise(
      provide(
        createBackup(scope, backupID, now, 60_000),
        runtimeValue,
        sourceValue,
        recoveryState.repository,
      ),
    );
    const validationFailure: RecoveryRepository = {
      ...recoveryState.repository,
      validateInactiveGeneration: () =>
        Effect.fail(new BackupError({ reason: "integrity_failed" })),
    };
    const result = await Effect.runPromiseExit(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        sourceValue,
        validationFailure,
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(recoveryState.events).toHaveLength(backupObjectKinds.length);
    expect(recoveryState.events.some((event) => event.startsWith("validate:"))).toBe(false);
  });

  test("rejects an archive with an omitted, additional, duplicate, or mismatched member before promotion", async () => {
    const store = memoryR2();
    const recoveryState = recovery();
    const runtimeValue = await runtime(store.r2);
    const sourceValue = source([
      { kind: "document", sourceID: "page-1", text: "one" },
      { kind: "tombstone", sourceID: "vault-state", text: "two" },
    ]);
    const created = await Effect.runPromise(
      provide(
        createBackup(scope, backupID, now, 60_000),
        runtimeValue,
        sourceValue,
        recoveryState.repository,
      ),
    );
    const firstKey = created.manifest.objects[0]?.key;
    const prefix = backupArchivePrefix(scope, backupID);
    if (firstKey === undefined || prefix === undefined) throw new Error("expected archive keys");

    store.objects.delete(firstKey);
    const omitted = await Effect.runPromiseExit(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        sourceValue,
        recoveryState.repository,
      ),
    );
    expect(Exit.isFailure(omitted)).toBe(true);

    store.objects.set(firstKey, new TextEncoder().encode("not-the-signed-bytes"));
    store.objects.set(`${prefix}objects/document/unlisted`, new TextEncoder().encode("extra"));
    const additional = await Effect.runPromiseExit(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        sourceValue,
        recoveryState.repository,
      ),
    );
    expect(Exit.isFailure(additional)).toBe(true);
    expect(recoveryState.events.some((event) => event.startsWith("validate:"))).toBe(false);

    const manifestKey = backupManifestKey(scope, backupID);
    if (manifestKey === undefined) throw new Error("expected manifest key");
    const stored = store.objects.get(manifestKey);
    if (stored === undefined) throw new Error("expected signed manifest");
    const text = new TextDecoder().decode(stored);
    expect(
      decodeSignedBackupManifest(text.replace('"version":1', '"version":1,"version":1')),
    ).toBeUndefined();
  });

  test("captures one concurrent snapshot boundary and rejects schema, scope, hash, and size substitutions", async () => {
    const store = memoryR2();
    const recoveryState = recovery();
    const runtimeValue = await runtime(store.r2);
    let sourceText = "at-high-water";
    const concurrent: SnapshotSource = {
      snapshot: (snapshotScope, archiveID) =>
        Effect.sync(() => {
          const captured = sourceText;
          sourceText = "after-snapshot";
          const objects = backupObjectKinds.map((kind) => ({
            kind,
            sourceID: kind === "document" ? "page-1" : `catalog-${kind}`,
            bytes: new TextEncoder().encode(kind === "document" ? captured : kind),
          }));
          const records: BackupManifestObject[] = [];
          for (const object of objects) {
            const key = backupObjectKey(snapshotScope, archiveID, object.kind, object.sourceID);
            if (key === undefined) throw new Error("test key invalid");
            records.push({
              kind: object.kind,
              key,
              sha256Base64: canonicalSHA256Base64(object.bytes),
              size: object.bytes.byteLength,
            });
          }
          records.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
          return {
            highWaterMark: canonicalSHA256Base64(new TextEncoder().encode("high-water")),
            routingEpoch: 7,
            controlEpoch: 9,
            credentialEpoch: 5,
            generationEpoch: snapshotScope.generationEpoch,
            catalogDigest: catalogDigest(records),
            objects,
          };
        }),
    };
    const created = await Effect.runPromise(
      provide(
        createBackup(scope, backupID, now, 60_000),
        runtimeValue,
        concurrent,
        recoveryState.repository,
      ),
    );
    expect(sourceText).toBe("after-snapshot");
    const object = created.manifest.objects.find((candidate) => candidate.kind === "document");
    if (object === undefined) throw new Error("expected object");
    expect(new TextDecoder().decode(store.objects.get(object.key))).toBe("at-high-water");
    const manifestKey = backupManifestKey(scope, backupID);
    if (manifestKey === undefined) throw new Error("expected manifest key");
    const original = store.objects.get(manifestKey);
    if (original === undefined) throw new Error("expected signed manifest");
    const candidates = [
      new TextDecoder().decode(original).replace('"schemaVersion":1', '"schemaVersion":2'),
      new TextDecoder().decode(original).replace('"generationEpoch":3', '"generationEpoch":4'),
      new TextDecoder()
        .decode(original)
        .replace(object.sha256Base64, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
      new TextDecoder()
        .decode(original)
        .replace(`"size":${object.size}`, `"size":${object.size + 1}`),
      new TextDecoder().decode(original).replace(object.key, `${object.key}-other`),
      new TextDecoder().decode(original).replace(/("signatureDERBase64":")[^"]/, "$1A"),
    ];
    for (const candidate of candidates) {
      store.objects.set(manifestKey, new TextEncoder().encode(candidate));
      const exit = await Effect.runPromiseExit(
        provide(
          restoreVerifiedBackup(scope, backupID, now + 1),
          runtimeValue,
          concurrent,
          recoveryState.repository,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("rejects noncanonical manifest text, cross-prefix keys, and partial atomic catalogs", async () => {
    const store = memoryR2();
    const recoveryState = recovery();
    const runtimeValue = await runtime(store.r2);
    const complete = source([{ kind: "document", sourceID: "page-1", text: "one" }]);
    const created = await Effect.runPromise(
      provide(
        createBackup(scope, backupID, now, 60_000),
        runtimeValue,
        complete,
        recoveryState.repository,
      ),
    );
    const manifestKey = backupManifestKey(scope, backupID);
    const object = created.manifest.objects[0];
    if (manifestKey === undefined || object === undefined) throw new Error("expected manifest");
    const raw = store.objects.get(manifestKey);
    if (raw === undefined) throw new Error("expected raw manifest");
    const text = new TextDecoder().decode(raw);
    expect(decodeSignedBackupManifest(` ${text}`)).toBeUndefined();
    expect(
      decodeSignedBackupManifest(text.replace('"backupID"', '"\\u0062ackupID"')),
    ).toBeUndefined();
    expect(parseBackupObjectKey(scope, backupID, object.key)).toBeDefined();
    expect(
      parseBackupObjectKey(scope, backupID, object.key.replace("/objects/", "/objects/../")),
    ).toBeUndefined();
    expect(
      parseBackupObjectKey(scope, backupID, object.key.replace("v1/vaults/", "v1/vaults/other/")),
    ).toBeUndefined();

    const partial: SnapshotSource = {
      snapshot: (snapshotScope, archiveID) => {
        const key = backupObjectKey(snapshotScope, archiveID, "document", "page-1");
        if (key === undefined) return Effect.fail(new BackupError({ reason: "source_invalid" }));
        const bytes = new TextEncoder().encode("one");
        const record: BackupManifestObject = {
          kind: "document",
          key,
          sha256Base64: canonicalSHA256Base64(bytes),
          size: bytes.byteLength,
        };
        return Effect.succeed({
          highWaterMark: canonicalSHA256Base64(new TextEncoder().encode("high-water")),
          routingEpoch: 7,
          controlEpoch: 9,
          credentialEpoch: 5,
          generationEpoch: snapshotScope.generationEpoch,
          catalogDigest: catalogDigest([record]),
          objects: [{ kind: "document", sourceID: "page-1", bytes }],
        });
      },
    };
    const missingCategory = await Effect.runPromiseExit(
      provide(
        createBackup(scope, "CCCCCCCCCCCCCCCC", now, 60_000),
        runtimeValue,
        partial,
        recoveryState.repository,
      ),
    );
    expect(Exit.isFailure(missingCategory)).toBe(true);
  });

  test("rejects stale control floors, foreign/nonprivate targets, and oversize ingress before allocation", async () => {
    const store = memoryR2();
    const runtimeValue = await runtime(store.r2);
    const sourceValue = source([{ kind: "document", sourceID: "page-1", text: "one" }]);
    const created = await Effect.runPromise(
      provide(
        createBackup(scope, backupID, now, 60_000),
        runtimeValue,
        sourceValue,
        recovery().repository,
      ),
    );
    expect(created.manifest.controlEpoch).toBe(9);
    const staleFloor = recovery();
    const floorRepository: RecoveryRepository = {
      ...staleFloor.repository,
      controlEpochFloor: () => Effect.succeed(10),
    };
    const stale = await Effect.runPromiseExit(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        sourceValue,
        floorRepository,
      ),
    );
    expect(Exit.isFailure(stale)).toBe(true);

    const foreignOwner = ownerID("owner-2");
    if (foreignOwner === undefined) throw new Error("expected foreign owner");
    const foreignRepository: RecoveryRepository = {
      ...recovery().repository,
      allocateInactiveGeneration: () =>
        Effect.succeed({
          scope: { ownerID: foreignOwner, vaultID: vault, generationEpoch: 4 },
          inactivePrivate: true,
        }),
    };
    const foreign = await Effect.runPromiseExit(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        sourceValue,
        foreignRepository,
      ),
    );
    expect(Exit.isFailure(foreign)).toBe(true);

    const publicRepository: RecoveryRepository = {
      ...recovery().repository,
      allocateInactiveGeneration: () =>
        Effect.succeed({
          scope: { ...scope, generationEpoch: 4 },
          inactivePrivate: false,
        }),
    };
    const publicTarget = await Effect.runPromiseExit(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1),
        runtimeValue,
        sourceValue,
        publicRepository,
      ),
    );
    expect(Exit.isFailure(publicTarget)).toBe(true);

    const limited = await Effect.runPromiseExit(
      provide(
        restoreVerifiedBackup(scope, backupID, now + 1, {
          maximumObjects: 10,
          maximumObjectBytes: 1_024,
          maximumTotalObjectBytes: 4_096,
          maximumManifestBytes: 8,
          maximumObjectKeyBytes: 1_024,
          maximumManifestLifetimeMilliseconds: 60_000,
        }),
        runtimeValue,
        sourceValue,
        recovery().repository,
      ),
    );
    expect(Exit.isFailure(limited)).toBe(true);
  });
});
