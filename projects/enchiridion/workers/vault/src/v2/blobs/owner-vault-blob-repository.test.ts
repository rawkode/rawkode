import { describe, expect, test } from "bun:test";
import {
  type BlobR2Boundary,
  BlobR2Error,
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import { ownerID, requestID, vaultID } from "../foundation/schemas";
import { makeDurableObjectOwnerVaultStorageRepository } from "../owner-vault/repository";
import { makeOwnerVaultSnapshotPinController } from "../owner-vault/snapshot-pin";
import {
  type BlobAuthorization,
  type BlobScope,
  type BlobStageCommand,
  blobObjectKey,
  blobStageKey,
} from "./blobs";
import { makeOwnerVaultBlobStagingRepository } from "./owner-vault-blob-repository";

const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("invalid test setup");
  return value;
};
const body = new Uint8Array([1, 2, 3]);
const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const scope: BlobScope = {
  ownerID: required(ownerID("owner-1")),
  vaultID: required(vaultID("vault-1")),
  generationEpoch: 1,
};
const authorization: BlobAuthorization = {
  ...scope,
  deviceID: "device-1",
  authEpoch: 1,
  credentialEpoch: 1,
};
const command = (suffix = "01"): BlobStageCommand => ({
  scope,
  requestID: required(requestID(`blob-request-000000${suffix}`)),
  operationID: required(requestID(`blob-operation-00000${suffix}`)),
  stageRandom: "AQEBAQEBAQEBAQEBAQEBAQ",
  deviceID: authorization.deviceID,
  authEpoch: authorization.authEpoch,
  credentialEpoch: authorization.credentialEpoch,
  path: "notes/today",
  sha256,
  size: body.byteLength,
  body,
  nowSeconds: 100,
});

const nativeState = () => {
  const entries = new Map<string, unknown>();
  const transaction: DurableObjectTransactionNative = {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(entries.delete(key)),
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
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
  const state: DurableObjectStateNative = { storage, blockConcurrencyWhile: (work) => work() };
  return { entries, state };
};

const failure = (operation: BlobR2Error["operation"], reason: BlobR2Error["reason"]) =>
  Effect.fail(new BlobR2Error({ operation, reason }));
const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
const shaBase64 = btoa(
  String.fromCharCode(
    ...Uint8Array.from(sha256.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16)),
  ),
);

const r2 = (faults: { readonly failDelete?: boolean; readonly failPut?: boolean } = {}) => {
  const objects = new Map<string, Uint8Array>();
  const boundary: BlobR2Boundary = {
    putIfAbsent: (key, bytes) => {
      if (faults.failPut) return failure("put_if_absent", "platform_failed");
      if (objects.has(key)) return failure("put_if_absent", "already_exists");
      objects.set(key, new Uint8Array(bytes));
      return Effect.succeed({
        key,
        etag: `etag-${key}`,
        size: bytes.byteLength,
        sha256Base64: shaBase64,
      });
    },
    head: (key) => {
      const bytes = objects.get(key);
      return Effect.succeed(
        bytes === undefined
          ? undefined
          : { key, etag: `etag-${key}`, size: bytes.byteLength, sha256Base64: shaBase64 },
      );
    },
    read: (key) => {
      const bytes = objects.get(key);
      return bytes === undefined
        ? failure("read", "not_found")
        : Effect.succeed({
            key,
            etag: `etag-${key}`,
            size: bytes.byteLength,
            sha256Base64: shaBase64,
            bytes: new Uint8Array(bytes),
          });
    },
    deleteExact: (key) =>
      faults.failDelete
        ? failure("delete", "platform_failed")
        : Effect.sync(() => {
            objects.delete(key);
          }),
  };
  return { boundary, objects };
};

const build = async (
  faults: { readonly failDelete?: boolean; readonly failPut?: boolean } = {},
) => {
  const native = nativeState();
  const storage = makeDurableObjectOwnerVaultStorageRepository(
    makeDurableObjectBoundary(native.state).storage,
  );
  await Effect.runPromise(
    storage.transact((tx) =>
      tx
        .initialize({
          ownerID: scope.ownerID.value,
          vaultID: scope.vaultID.value,
          generationEpoch: scope.generationEpoch,
          namespaceState: "ACTIVE",
        })
        .pipe(
          Effect.zipRight(tx.put({ category: "root.floors" }, { securityFloor: 0 })),
          Effect.zipRight(
            tx.put(
              { category: "blob.accounting" },
              {
                referencedBytes: 0,
                reservedStageBytes: 0,
                prospectiveFinalBytes: 0,
                leaseIDs: [],
                purgeSHA256s: [],
              },
            ),
          ),
          Effect.zipRight(
            tx.put(
              { category: "device", identifier: "device-1" },
              {
                deviceID: "device-1",
                authEpoch: 1,
                credentialEpoch: 1,
                revoked: false,
                securityFloor: 0,
              },
            ),
          ),
        ),
    ),
  );
  const bucket = r2(faults);
  const repository = makeOwnerVaultBlobStagingRepository({
    storage,
    r2: bucket.boundary,
    scope,
    limits: {
      maximumBlobBytes: 8,
      maximumVaultBytes: 32,
      maximumOrphanBytes: 16,
      maximumOrphanCount: 2,
      maximumActiveLeasesPerVault: 4,
      maximumActiveLeasesPerFinal: 4,
      stageTTLSeconds: 10,
    },
    deleteGraceSeconds: 10,
  });
  return { native, storage, repository, ...bucket };
};

const stage = async (
  repository: ReturnType<typeof makeOwnerVaultBlobStagingRepository>,
  input = command(),
) => {
  const stageKey = required(
    blobStageKey(input.scope, input.sha256, input.operationID, input.stageRandom),
  );
  const finalKey = required(blobObjectKey(input.scope, input.sha256));
  await Effect.runPromise(
    repository.preflightReceipt(
      input,
      [
        input.operationID.value,
        input.requestID.value,
        input.stageRandom,
        input.path,
        input.sha256,
        String(input.size),
        input.deviceID,
        String(input.authEpoch),
        String(input.credentialEpoch),
      ].join("\u0000"),
    ),
  );
  await Effect.runPromise(repository.reserveStage(input, stageKey, finalKey, 100));
  await Effect.runPromise(repository.stageImmutable(stageKey, input.body, 100));
  await Effect.runPromise(
    repository.publishImmutable(stageKey, finalKey, input.sha256, input.size, 100),
  );
  await Effect.runPromise(
    repository.verifyFinal(stageKey, finalKey, input.sha256, input.size, 100),
  );
  return {
    input,
    stageKey,
    finalKey,
    result: await Effect.runPromise(repository.commitStaged(input, stageKey, finalKey, 100)),
  };
};

describe("durable OwnerVault blob saga", () => {
  test("registers blob rows through the transparent catalog and retains delete preimages for an OPEN pin", async () => {
    const built = await build();
    const first = await stage(built.repository);
    const controller = makeOwnerVaultSnapshotPinController(built.storage, {
      makePinProof: () => "blob-catalog-pin-proof-which-is-long-enough",
    });
    const pin = await Effect.runPromise(
      controller.beginSnapshot(
        {
          ownerID: scope.ownerID.value,
          vaultID: scope.vaultID.value,
          generationEpoch: scope.generationEpoch,
        },
        "blob-catalog-snapshot-0001",
      ),
    );
    const opened = await Effect.runPromise(controller.readSnapshotPage(pin, undefined));
    expect(opened.entries.map((entry) => entry.address.category)).toEqual(
      expect.arrayContaining(["blob.metadata", "blob.reference"]),
    );

    await Effect.runPromise(
      built.repository.deleteBySHA256({
        authorization,
        requestID: "blob-catalog-delete-0001",
        sha256,
        nowSeconds: 100,
      }),
    );
    const retained = await Effect.runPromise(controller.readSnapshotPage(pin, undefined));
    expect(
      retained.entries.find((entry) => entry.address.category === "blob.metadata")?.record.payload,
    ).toMatchObject({
      objectKey: first.finalKey,
      sha256,
    });
    expect(
      retained.entries.find((entry) => entry.address.category === "blob.tombstone"),
    ).toBeUndefined();
    expect(
      [...built.native.entries.keys()].some((key) => key.startsWith("v2.ov/backup/preimage/")),
    ).toBe(true);

    await Effect.runPromise(controller.abortSnapshot(pin));
    expect(await Effect.runPromise(controller.collectGarbage(pin.backupID))).toBe(true);
    expect(
      [...built.native.entries.keys()].some((key) => key.startsWith("v2.ov/backup/preimage/")),
    ).toBe(false);
  });

  test("persists reserve to stage to publish to finalize, and returns exact retry only", async () => {
    const built = await build();
    const input = command();
    const stageKey = required(
      blobStageKey(input.scope, input.sha256, input.operationID, input.stageRandom),
    );
    const finalKey = required(blobObjectKey(input.scope, input.sha256));
    const reserved = await Effect.runPromiseExit(
      built.repository.reserveStage(input, stageKey, finalKey, 100),
    );
    expect(JSON.stringify(reserved)).not.toContain("stage_conflict");
    const first = await stage(built.repository, input);
    expect(first.result.status).toBe("APPLIED");
    expect(built.objects.has(first.finalKey)).toBe(true);
    const duplicate = await Effect.runPromise(
      built.repository.preflightReceipt(
        first.input,
        [
          first.input.operationID.value,
          first.input.requestID.value,
          first.input.stageRandom,
          first.input.path,
          first.input.sha256,
          String(first.input.size),
          first.input.deviceID,
          String(first.input.authEpoch),
          String(first.input.credentialEpoch),
        ].join("\u0000"),
      ),
    );
    expect(duplicate).toEqual(first.result);
    const changed = await Effect.runPromiseExit(
      built.repository.preflightReceipt(first.input, "changed"),
    );
    expect(JSON.stringify(changed)).toContain("replay_conflict");
  });

  test("fails closed on malformed blob accounting and a stale device fence", async () => {
    const built = await build();
    const accountingKey = "v2.ov/blob/accounting";
    built.native.entries.set(accountingKey, {
      category: "blob.accounting",
      version: 1,
      payload: {
        referencedBytes: 0,
        reservedStageBytes: 0,
        prospectiveFinalBytes: 0,
        leaseIDs: [],
      },
    });
    const input = command();
    const stageKey = required(
      blobStageKey(input.scope, input.sha256, input.operationID, input.stageRandom),
    );
    const finalKey = required(blobObjectKey(input.scope, input.sha256));
    expect(
      JSON.stringify(
        await Effect.runPromiseExit(built.repository.reserveStage(input, stageKey, finalKey, 100)),
      ),
    ).toContain("stage_conflict");
    built.native.entries.set(accountingKey, {
      category: "blob.accounting",
      version: 1,
      payload: {
        referencedBytes: 0,
        reservedStageBytes: 0,
        prospectiveFinalBytes: 0,
        leaseIDs: [],
        purgeSHA256s: [],
      },
    });
    await Effect.runPromise(
      built.storage.transact((tx) =>
        tx.put(
          { category: "device", identifier: "device-1" },
          {
            deviceID: "device-1",
            authEpoch: 2,
            credentialEpoch: 1,
            revoked: false,
            securityFloor: 0,
          },
        ),
      ),
    );
    expect(
      JSON.stringify(
        await Effect.runPromiseExit(built.repository.reserveStage(input, stageKey, finalKey, 100)),
      ),
    ).toContain("generation_stale");
    expect(built.objects.size).toBe(0);
  });

  test("derives generation authority from root identity, never root floors", async () => {
    const built = await build();
    built.native.entries.set("v2.ov/root/identity", {
      category: "root.identity",
      version: 1,
      payload: {
        ownerID: scope.ownerID.value,
        vaultID: scope.vaultID.value,
        generationEpoch: 2,
        namespaceState: "ACTIVE",
      },
    });
    const input = command();
    const stageKey = required(
      blobStageKey(input.scope, input.sha256, input.operationID, input.stageRandom),
    );
    const finalKey = required(blobObjectKey(input.scope, input.sha256));
    expect(
      JSON.stringify(
        await Effect.runPromiseExit(built.repository.reserveStage(input, stageKey, finalKey, 100)),
      ),
    ).toContain("generation_stale");
  });

  test("cleans a failed R2 stage durably and permits retry after a repository restart", async () => {
    const faults: { failPut?: boolean } = { failPut: true };
    const built = await build(faults);
    const input = command();
    const stageKey = required(
      blobStageKey(input.scope, input.sha256, input.operationID, input.stageRandom),
    );
    const finalKey = required(blobObjectKey(input.scope, input.sha256));
    await Effect.runPromise(built.repository.reserveStage(input, stageKey, finalKey, 100));
    expect(
      JSON.stringify(
        await Effect.runPromiseExit(built.repository.stageImmutable(stageKey, input.body, 100)),
      ),
    ).toContain("stage_conflict");
    await Effect.runPromise(built.repository.discardStage(stageKey));
    await Effect.runPromise(built.repository.releaseReservation(stageKey, 100));
    faults.failPut = false;
    // A new repository instance shares only durable state and R2, not process-local maps.
    const restarted = makeOwnerVaultBlobStagingRepository({
      storage: built.storage,
      r2: built.boundary,
      scope,
      limits: {
        maximumBlobBytes: 8,
        maximumVaultBytes: 32,
        maximumOrphanBytes: 16,
        maximumOrphanCount: 2,
        maximumActiveLeasesPerVault: 4,
        maximumActiveLeasesPerFinal: 4,
        stageTTLSeconds: 10,
      },
      deleteGraceSeconds: 10,
    });
    await Effect.runPromise(restarted.reserveStage(input, stageKey, finalKey, 101));
    await Effect.runPromise(restarted.stageImmutable(stageKey, input.body, 101));
  });

  test("rejects a corrupted persisted stage receipt on restart replay before any R2 effect", async () => {
    const built = await build();
    const input = command();
    const first = await stage(built.repository, input);
    expect(first.result.status).toBe("APPLIED");
    const fingerprint = [
      input.operationID.value,
      input.requestID.value,
      input.stageRandom,
      input.path,
      input.sha256,
      String(input.size),
      input.deviceID,
      String(input.authEpoch),
      String(input.credentialEpoch),
    ].join("\u0000");
    const receiptEntry = [...built.native.entries.entries()].find(([, value]) => {
      const row = value as { readonly payload?: { readonly kind?: unknown } };
      return row.payload?.kind === "blob-stage";
    });
    if (receiptEntry === undefined) throw new Error("stage receipt row missing");
    const receiptKey = receiptEntry[0];
    const receiptRow = receiptEntry[1] as {
      readonly category: string;
      readonly version: number;
      readonly payload: {
        readonly kind: string;
        readonly fingerprint: string;
        readonly response: {
          readonly status: string;
          readonly metadata: Readonly<Record<string, unknown>>;
        };
      };
    };
    const operations: string[] = [];
    const tracked: BlobR2Boundary = {
      putIfAbsent: (key, bytes) => {
        operations.push(`put:${key}`);
        return built.boundary.putIfAbsent(key, bytes);
      },
      head: (key) => {
        operations.push(`head:${key}`);
        return built.boundary.head(key);
      },
      read: (key) => {
        operations.push(`read:${key}`);
        return built.boundary.read(key);
      },
      deleteExact: (key) => {
        operations.push(`delete:${key}`);
        return built.boundary.deleteExact(key);
      },
    };
    // The retry after a crash-after-commit reaches a fresh instance over the
    // same durable rows; the persisted receipt is its only replay evidence.
    const restarted = makeOwnerVaultBlobStagingRepository({
      storage: built.storage,
      r2: tracked,
      scope,
      limits: {
        maximumBlobBytes: 8,
        maximumVaultBytes: 32,
        maximumOrphanBytes: 16,
        maximumOrphanCount: 2,
        maximumActiveLeasesPerVault: 4,
        maximumActiveLeasesPerFinal: 4,
        stageTTLSeconds: 10,
      },
      deleteGraceSeconds: 10,
    });
    const attempt = async (metadata: Readonly<Record<string, unknown>>) => {
      built.native.entries.set(receiptKey, {
        ...receiptRow,
        payload: {
          ...receiptRow.payload,
          response: { ...receiptRow.payload.response, metadata },
        },
      });
      const before = new Map(built.native.entries);
      expect(
        JSON.stringify(await Effect.runPromiseExit(restarted.preflightReceipt(input, fingerprint))),
      ).toContain("stage_conflict");
      expect(built.native.entries).toEqual(before);
    };
    // A persisted generation epoch is an unknown member: replays must re-derive
    // epoch authority from the live root, never trust a stored one.
    await attempt({ ...receiptRow.payload.response.metadata, generationEpoch: 999 });
    // A mistyped size fails closed the same way.
    await attempt({ ...receiptRow.payload.response.metadata, size: String(input.size) });
    expect(operations).toEqual([]);

    // The intact durable receipt still replays exactly after the restart.
    built.native.entries.set(receiptKey, receiptRow);
    expect(await Effect.runPromise(restarted.preflightReceipt(input, fingerprint))).toEqual(
      first.result,
    );
  });

  test("tombstones by SHA, waits for grace, then purges R2 before allowing a fresh reference", async () => {
    const built = await build();
    const first = await stage(built.repository);
    const deleted = await Effect.runPromise(
      built.repository.deleteBySHA256({
        authorization,
        requestID: "blob-delete-request-0001",
        sha256,
        nowSeconds: 100,
      }),
    );
    expect(deleted.status).toBe("APPLIED");
    expect(built.objects.has(first.finalKey)).toBe(true);
    const blocked = await Effect.runPromiseExit(
      built.repository.reserveStage(
        command("02"),
        required(blobStageKey(scope, sha256, command("02").operationID, command("02").stageRandom)),
        first.finalKey,
        101,
      ),
    );
    expect(JSON.stringify(blocked)).toContain("stage_conflict");
    expect(await Effect.runPromise(built.repository.reconcile(109))).toBe(0);
    expect(built.objects.has(first.finalKey)).toBe(true);
    expect(await Effect.runPromise(built.repository.reconcile(110))).toBe(1);
    expect(built.objects.has(first.finalKey)).toBe(false);
    const fresh = command("03");
    await Effect.runPromise(
      built.repository.reserveStage(
        fresh,
        required(blobStageKey(scope, sha256, fresh.operationID, fresh.stageRandom)),
        first.finalKey,
        111,
      ),
    );
  });
});
