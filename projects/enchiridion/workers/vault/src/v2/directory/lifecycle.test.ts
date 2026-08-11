import { expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  CapabilityMethod,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  DirectoryControlResource,
  makeDirectoryControlCapabilitySigner,
  makeDirectoryControlCapabilityVerifier,
} from "@enchiridion/runtime";
import {
  initializationDigest,
  floorSyncDigest,
  makeOwnerVaultInitializationClient,
  ownerVaultInitializationPath,
  ownerVaultObjectName,
  signOwnerVaultInitialization,
  signOwnerVaultFloorSync,
  ownerVaultFloorSyncPath,
} from "./lifecycle";

const base = {
  ownerID: "owner-abcdefghijklmnop",
  vaultID: "vault-abcdefghijklmnop",
  generationEpoch: 1,
  operationID: "initialize-operation-0001",
  credentialEpoch: 1,
  routingEpoch: 1,
  controlEpoch: 1,
};
const command = { ...base, initDigest: initializationDigest(base) };
const ring = { purpose: "internal-capability" as const, current: { keyID: "control", secret: Redacted.make("directory-control-secret-0123456789") }, prior: [] };

test("signs a command-bound OwnerVault initialization capability", async () => {
  const signed = await Effect.runPromise(signOwnerVaultInitialization(makeDirectoryControlCapabilitySigner(ring), command, "init-capability-jti-0001", 100));
  const claims = await Effect.runPromise(makeDirectoryControlCapabilityVerifier(ring).verify(signed, {
    resource: DirectoryControlResource.OwnerVaultInitialization,
    method: CapabilityMethod.POST, path: ownerVaultInitializationPath, canonicalQuery: "",
    bodySHA256: (await import("@enchiridion/protocol")).sha256Hex(new TextEncoder().encode(JSON.stringify(command))),
    ownerID: command.ownerID, vaultID: command.vaultID, initDigest: command.initDigest,
    controlEpoch: command.controlEpoch,
  }, {
    audience: DirectoryControlCapabilityAudience.DirectoryControl,
    authority: DirectoryControlCapabilityAuthority.DirectoryControl,
    resource: DirectoryControlResource.OwnerVaultInitialization,
    ownerID: command.ownerID, vaultID: command.vaultID,
    credentialEpoch: 1, controlEpoch: 1, generationEpoch: 1, routingEpoch: 1, operationID: command.operationID,
  }, 101));
  expect(claims.initDigest).toBe(command.initDigest);
});

test("signs an exact forward-only OwnerVault floor-sync capability", async () => {
  const syncBase = { ...base, operationID: "floor-sync-operation-0001", credentialEpoch: 2, routingEpoch: 3, controlEpoch: 4 };
  const sync = { ...syncBase, floorSyncDigest: floorSyncDigest(syncBase) };
  const signed = await Effect.runPromise(signOwnerVaultFloorSync(makeDirectoryControlCapabilitySigner(ring), sync, "floor-sync-capability-jti", 100));
  const claims = await Effect.runPromise(makeDirectoryControlCapabilityVerifier(ring).verify(signed, {
    resource: DirectoryControlResource.OwnerVaultFloorSync,
    method: CapabilityMethod.POST, path: ownerVaultFloorSyncPath, canonicalQuery: "",
    bodySHA256: (await import("@enchiridion/protocol")).sha256Hex(new TextEncoder().encode(JSON.stringify(sync))),
    ownerID: sync.ownerID, vaultID: sync.vaultID, floorSyncDigest: sync.floorSyncDigest,
    controlEpoch: sync.controlEpoch,
  }, {
    audience: DirectoryControlCapabilityAudience.DirectoryControl,
    authority: DirectoryControlCapabilityAuthority.DirectoryControl,
    resource: DirectoryControlResource.OwnerVaultFloorSync,
    ownerID: sync.ownerID, vaultID: sync.vaultID,
    credentialEpoch: sync.credentialEpoch, controlEpoch: sync.controlEpoch,
    generationEpoch: sync.generationEpoch, routingEpoch: sync.routingEpoch, operationID: sync.operationID,
  }, 101));
  expect(claims.floorSyncDigest).toBe(sync.floorSyncDigest);
});

test("uses a target-only stable shard and rejects substituted or echo-only acknowledgements", async () => {
  expect(ownerVaultObjectName(command)).toBe(ownerVaultObjectName({ ownerID: command.ownerID, vaultID: command.vaultID, generationEpoch: command.generationEpoch }));
  const client = makeOwnerVaultInitializationClient({
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: async () => new Response(JSON.stringify({
      ...command,
      operationID: "substituted-operation-1",
      durableReceipt: "owner-vault-receipt-0001",
    })) }),
  });
  const exit = await Effect.runPromiseExit(client.ensureInitialized(command, { value: "token" }));
  expect(exit._tag).toBe("Failure");
  const echo = makeOwnerVaultInitializationClient({
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: async () => new Response(JSON.stringify(command)) }),
  });
  expect((await Effect.runPromiseExit(echo.ensureInitialized(command, { value: "token" })))._tag).toBe("Failure");
  const acknowledged = makeOwnerVaultInitializationClient({
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: async () => new Response(JSON.stringify({
      ...command,
      durableReceipt: "owner-vault-receipt-0001",
    })) }),
  });
  expect((await Effect.runPromiseExit(acknowledged.ensureInitialized(command, { value: "token" })))._tag).toBe("Success");
});
