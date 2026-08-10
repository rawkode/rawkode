import { describe, expect, test } from "bun:test";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  type ImmutableR2Boundary,
  ImmutableR2Error,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import { ownerID, requestID, vaultID } from "../foundation/schemas";
import { makeDurableObjectOwnerVaultStorageRepository } from "../owner-vault/repository";
import { blobObjectKey, blobStageKey, type BlobAuthorization, type BlobScope, type BlobStageCommand } from "./blobs";
import { makeOwnerVaultBlobStagingRepository } from "./owner-vault-blob-repository";

const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("invalid test setup");
  return value;
};
const body = new Uint8Array([1, 2, 3]);
const sha256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const scope: BlobScope = { ownerID: required(ownerID("owner-1")), vaultID: required(vaultID("vault-1")), generationEpoch: 1 };
const authorization: BlobAuthorization = { ...scope, deviceID: "device-1", authEpoch: 1, credentialEpoch: 1 };
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
    put: (key, value) => { entries.set(key, value); return Promise.resolve(); },
    delete: (key) => Promise.resolve(entries.delete(key)),
  };
  const storage: DurableObjectStorageNative = {
    ...transaction,
    getAlarm: () => Promise.resolve(null), setAlarm: () => Promise.resolve(), deleteAlarm: () => Promise.resolve(),
    transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
      const before = new Map(entries);
      return work(transaction).catch((error: unknown) => { entries.clear(); for (const [key, value] of before) entries.set(key, value); return Promise.reject(error); });
    },
  };
  const state: DurableObjectStateNative = { storage, blockConcurrencyWhile: (work) => work() };
  return { entries, state };
};

const failure = (operation: ImmutableR2Error["operation"], reason: ImmutableR2Error["reason"]) =>
  Effect.fail(new ImmutableR2Error({ operation, reason }));
const bytesEqual = (left: Uint8Array, right: Uint8Array) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
const shaBase64 = btoa(String.fromCharCode(...Uint8Array.from(sha256.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16))));

const r2 = (faults: { readonly failDelete?: boolean; readonly failPut?: boolean } = {}) => {
  const objects = new Map<string, Uint8Array>();
  const boundary: ImmutableR2Boundary = {
    putIfAbsent: (key, bytes) => {
      if (faults.failPut) return failure("put_if_absent", "platform_failed");
      if (objects.has(key)) return failure("put_if_absent", "already_exists");
      objects.set(key, new Uint8Array(bytes));
      return Effect.succeed({ key, etag: `etag-${key}`, size: bytes.byteLength, sha256Base64: shaBase64 });
    },
    head: (key) => {
      const bytes = objects.get(key);
      return Effect.succeed(bytes === undefined ? undefined : { key, etag: `etag-${key}`, size: bytes.byteLength, sha256Base64: shaBase64 });
    },
    read: (key) => {
      const bytes = objects.get(key);
      return bytes === undefined ? failure("read", "not_found") : Effect.succeed({ key, etag: `etag-${key}`, size: bytes.byteLength, sha256Base64: shaBase64, bytes: new Uint8Array(bytes) });
    },
    listExactPrefix: (prefix) => Effect.succeed({ objects: [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, etag: `etag-${key}`, size: bytes.byteLength, sha256Base64: shaBase64 })), truncated: false }),
    deleteExact: (key) => faults.failDelete ? failure("delete", "platform_failed") : Effect.sync(() => { objects.delete(key); }),
  };
  return { boundary, objects };
};

const build = async (faults: { readonly failDelete?: boolean; readonly failPut?: boolean } = {}) => {
  const native = nativeState();
  const storage = makeDurableObjectOwnerVaultStorageRepository(makeDurableObjectBoundary(native.state).storage);
  await Effect.runPromise(storage.transact((tx) => tx.initialize({ ownerID: scope.ownerID.value, vaultID: scope.vaultID.value, generationEpoch: scope.generationEpoch, namespaceState: "ACTIVE" }).pipe(
    Effect.zipRight(tx.put({ category: "root.floors" }, { generation: 1, securityFloor: 0 })),
    Effect.zipRight(tx.put({ category: "root.admission" }, { referencedBytes: 0, reservedStageBytes: 0, prospectiveFinalBytes: 0, leaseIDs: [], purgeSHA256s: [] })),
    Effect.zipRight(tx.put({ category: "device", identifier: "device-1" }, { deviceID: "device-1", authEpoch: 1, credentialEpoch: 1, revoked: false, securityFloor: 0 })),
  )));
  const bucket = r2(faults);
  const repository = makeOwnerVaultBlobStagingRepository({ storage, r2: bucket.boundary, scope, limits: { maximumBlobBytes: 8, maximumVaultBytes: 32, maximumOrphanBytes: 16, maximumOrphanCount: 2, maximumActiveLeasesPerVault: 4, maximumActiveLeasesPerFinal: 4, stageTTLSeconds: 10 }, deleteGraceSeconds: 10 });
  return { native, storage, repository, ...bucket };
};

const stage = async (repository: ReturnType<typeof makeOwnerVaultBlobStagingRepository>, input = command()) => {
  const stageKey = required(blobStageKey(input.scope, input.sha256, input.operationID, input.stageRandom));
  const finalKey = required(blobObjectKey(input.scope, input.sha256));
  await Effect.runPromise(repository.preflightReceipt(input, [input.operationID.value, input.requestID.value, input.stageRandom, input.path, input.sha256, String(input.size), input.deviceID, String(input.authEpoch), String(input.credentialEpoch)].join("\u0000")));
  await Effect.runPromise(repository.reserveStage(input, stageKey, finalKey, 100));
  await Effect.runPromise(repository.stageImmutable(stageKey, input.body, 100));
  await Effect.runPromise(repository.publishImmutable(stageKey, finalKey, input.sha256, input.size, 100));
  await Effect.runPromise(repository.verifyFinal(stageKey, finalKey, input.sha256, input.size, 100));
  return { input, stageKey, finalKey, result: await Effect.runPromise(repository.commitStaged(input, stageKey, finalKey, 100)) };
};

describe("durable OwnerVault blob saga", () => {
  test("persists reserve to stage to publish to finalize, and returns exact retry only", async () => {
    const built = await build();
    const input = command();
    const stageKey = required(blobStageKey(input.scope, input.sha256, input.operationID, input.stageRandom));
    const finalKey = required(blobObjectKey(input.scope, input.sha256));
    const reserved = await Effect.runPromiseExit(built.repository.reserveStage(input, stageKey, finalKey, 100));
    expect(JSON.stringify(reserved)).not.toContain("stage_conflict");
    const first = await stage(built.repository, input);
    expect(first.result.status).toBe("APPLIED");
    expect(built.objects.has(first.finalKey)).toBe(true);
    const duplicate = await Effect.runPromise(built.repository.preflightReceipt(first.input, [first.input.operationID.value, first.input.requestID.value, first.input.stageRandom, first.input.path, first.input.sha256, String(first.input.size), first.input.deviceID, String(first.input.authEpoch), String(first.input.credentialEpoch)].join("\u0000")));
    expect(duplicate).toEqual(first.result);
    const changed = await Effect.runPromiseExit(built.repository.preflightReceipt(first.input, "changed"));
    expect(JSON.stringify(changed)).toContain("replay_conflict");
  });

  test("fails closed on malformed admission state and a stale device fence", async () => {
    const built = await build();
    const admissionKey = "v2.ov/root/admission";
    built.native.entries.set(admissionKey, { category: "root.admission", version: 1, payload: { referencedBytes: 0, reservedStageBytes: 0, prospectiveFinalBytes: 0, leaseIDs: [] } });
    const input = command();
    const stageKey = required(blobStageKey(input.scope, input.sha256, input.operationID, input.stageRandom));
    const finalKey = required(blobObjectKey(input.scope, input.sha256));
    expect(JSON.stringify(await Effect.runPromiseExit(built.repository.reserveStage(input, stageKey, finalKey, 100)))).toContain("stage_conflict");
    await Effect.runPromise(built.storage.transact((tx) => tx.put({ category: "root.admission" }, { referencedBytes: 0, reservedStageBytes: 0, prospectiveFinalBytes: 0, leaseIDs: [], purgeSHA256s: [] }).pipe(
      Effect.zipRight(tx.put({ category: "device", identifier: "device-1" }, { deviceID: "device-1", authEpoch: 2, credentialEpoch: 1, revoked: false, securityFloor: 0 })),
    )));
    expect(JSON.stringify(await Effect.runPromiseExit(built.repository.reserveStage(input, stageKey, finalKey, 100)))).toContain("generation_stale");
    expect(built.objects.size).toBe(0);
  });

  test("cleans a failed R2 stage durably and permits retry after a repository restart", async () => {
    const faults: { failPut?: boolean } = { failPut: true };
    const built = await build(faults);
    const input = command();
    const stageKey = required(blobStageKey(input.scope, input.sha256, input.operationID, input.stageRandom));
    const finalKey = required(blobObjectKey(input.scope, input.sha256));
    await Effect.runPromise(built.repository.reserveStage(input, stageKey, finalKey, 100));
    expect(JSON.stringify(await Effect.runPromiseExit(built.repository.stageImmutable(stageKey, input.body, 100)))).toContain("stage_conflict");
    await Effect.runPromise(built.repository.discardStage(stageKey));
    await Effect.runPromise(built.repository.releaseReservation(stageKey, 100));
    faults.failPut = false;
    // A new repository instance shares only durable state and R2, not process-local maps.
    const restarted = makeOwnerVaultBlobStagingRepository({ storage: built.storage, r2: built.boundary, scope, limits: { maximumBlobBytes: 8, maximumVaultBytes: 32, maximumOrphanBytes: 16, maximumOrphanCount: 2, maximumActiveLeasesPerVault: 4, maximumActiveLeasesPerFinal: 4, stageTTLSeconds: 10 }, deleteGraceSeconds: 10 });
    await Effect.runPromise(restarted.reserveStage(input, stageKey, finalKey, 101));
    await Effect.runPromise(restarted.stageImmutable(stageKey, input.body, 101));
  });

  test("tombstones by SHA, waits for grace, then purges R2 before allowing a fresh reference", async () => {
    const built = await build();
    const first = await stage(built.repository);
    const deleted = await Effect.runPromise(built.repository.deleteBySHA256({ authorization, requestID: "blob-delete-request-0001", sha256, nowSeconds: 100 }));
    expect(deleted.status).toBe("APPLIED");
    expect(built.objects.has(first.finalKey)).toBe(true);
    const blocked = await Effect.runPromiseExit(built.repository.reserveStage(command("02"), required(blobStageKey(scope, sha256, command("02").operationID, command("02").stageRandom)), first.finalKey, 101));
    expect(JSON.stringify(blocked)).toContain("stage_conflict");
    expect(await Effect.runPromise(built.repository.reconcile(109))).toBe(0);
    expect(built.objects.has(first.finalKey)).toBe(true);
    expect(await Effect.runPromise(built.repository.reconcile(110))).toBe(1);
    expect(built.objects.has(first.finalKey)).toBe(false);
    const fresh = command("03");
    await Effect.runPromise(built.repository.reserveStage(fresh, required(blobStageKey(scope, sha256, fresh.operationID, fresh.stageRandom)), first.finalKey, 111));
  });
});
