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
  makeOwnerVaultInitializationClient,
  ownerVaultInitializationPath,
  ownerVaultObjectName,
  signOwnerVaultInitialization,
} from "./lifecycle";

const base = {
  ownerID: "owner-abcdefghijklmnop",
  vaultID: "vault-abcdefghijklmnop",
  generationEpoch: 1,
  operationID: "initialize-operation-0001",
  credentialEpoch: 1,
  routingEpoch: 1,
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
  }, {
    audience: DirectoryControlCapabilityAudience.DirectoryControl,
    authority: DirectoryControlCapabilityAuthority.DirectoryControl,
    resource: DirectoryControlResource.OwnerVaultInitialization,
    ownerID: command.ownerID, vaultID: command.vaultID,
    credentialEpoch: 1, generationEpoch: 1, routingEpoch: 1, operationID: command.operationID,
  }, 101));
  expect(claims.initDigest).toBe(command.initDigest);
});

test("uses a target-only stable shard and rejects substituted acknowledgements", async () => {
  expect(ownerVaultObjectName(command)).toBe(ownerVaultObjectName({ ownerID: command.ownerID, vaultID: command.vaultID, generationEpoch: command.generationEpoch }));
  const client = makeOwnerVaultInitializationClient({
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: async () => new Response(JSON.stringify({ ...command, operationID: "substituted-operation-1" })) }),
  });
  const exit = await Effect.runPromiseExit(client.ensureInitialized(command, { value: "token" }));
  expect(exit._tag).toBe("Failure");
});
