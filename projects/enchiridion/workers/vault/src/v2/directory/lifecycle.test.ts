import { expect, test } from "bun:test";
import {
  CapabilityMethod,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  DirectoryControlResource,
  makeDirectoryControlCapabilitySigner,
  makeDirectoryControlCapabilityVerifier,
} from "@enchiridion/runtime";
import { Effect, Redacted } from "effect";
import {
  floorSyncDigest,
  initializationDigest,
  makeOwnerVaultInitializationClient,
  ownerVaultFloorSyncPath,
  ownerVaultInitializationPath,
  ownerVaultObjectName,
  signOwnerVaultFloorSync,
  signOwnerVaultInitialization,
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
const ring = {
  purpose: "internal-capability" as const,
  current: { keyID: "control", secret: Redacted.make("directory-control-secret-0123456789") },
  prior: [],
};

test("signs a command-bound OwnerVault initialization capability", async () => {
  const jti = "init-capability-jti-0001";
  const verifier = makeDirectoryControlCapabilityVerifier(ring);
  const signed = await Effect.runPromise(
    signOwnerVaultInitialization(makeDirectoryControlCapabilitySigner(ring), command, jti, 100),
  );
  const binding = {
    resource: DirectoryControlResource.OwnerVaultInitialization,
    method: CapabilityMethod.POST,
    path: ownerVaultInitializationPath,
    canonicalQuery: "",
    bodySHA256: (await import("@enchiridion/protocol")).sha256Hex(
      new TextEncoder().encode(JSON.stringify(command)),
    ),
    ownerID: command.ownerID,
    vaultID: command.vaultID,
    initDigest: command.initDigest,
    controlEpoch: command.controlEpoch,
    jti,
  } as const;
  const expectation = {
    audience: DirectoryControlCapabilityAudience.DirectoryControl,
    authority: DirectoryControlCapabilityAuthority.DirectoryControl,
    resource: DirectoryControlResource.OwnerVaultInitialization,
    ownerID: command.ownerID,
    vaultID: command.vaultID,
    credentialEpoch: 1,
    controlEpoch: 1,
    generationEpoch: 1,
    routingEpoch: 1,
    operationID: command.operationID,
    jti,
  } as const;
  const claims = await Effect.runPromise(verifier.verify(signed, binding, expectation, 101));
  expect(claims.initDigest).toBe(command.initDigest);
  expect(claims.jti).toBe(jti);
  expect(
    (
      await Effect.runPromiseExit(
        verifier.verify(signed, { ...binding, jti: "init-capability-jti-other" }, expectation, 101),
      )
    )._tag,
  ).toBe("Failure");
  expect(
    (
      await Effect.runPromiseExit(
        verifier.verify(signed, binding, { ...expectation, jti: "init-capability-jti-other" }, 101),
      )
    )._tag,
  ).toBe("Failure");
});

test("signs an exact forward-only OwnerVault floor-sync capability", async () => {
  const syncBase = {
    ...base,
    operationID: "floor-sync-operation-0001",
    credentialEpoch: 2,
    routingEpoch: 3,
    controlEpoch: 4,
  };
  const sync = { ...syncBase, floorSyncDigest: floorSyncDigest(syncBase) };
  const jti = "floor-sync-capability-jti";
  const verifier = makeDirectoryControlCapabilityVerifier(ring);
  const signed = await Effect.runPromise(
    signOwnerVaultFloorSync(makeDirectoryControlCapabilitySigner(ring), sync, jti, 100),
  );
  const binding = {
    resource: DirectoryControlResource.OwnerVaultFloorSync,
    method: CapabilityMethod.POST,
    path: ownerVaultFloorSyncPath,
    canonicalQuery: "",
    bodySHA256: (await import("@enchiridion/protocol")).sha256Hex(
      new TextEncoder().encode(JSON.stringify(sync)),
    ),
    ownerID: sync.ownerID,
    vaultID: sync.vaultID,
    floorSyncDigest: sync.floorSyncDigest,
    controlEpoch: sync.controlEpoch,
    jti,
  } as const;
  const expectation = {
    audience: DirectoryControlCapabilityAudience.DirectoryControl,
    authority: DirectoryControlCapabilityAuthority.DirectoryControl,
    resource: DirectoryControlResource.OwnerVaultFloorSync,
    ownerID: sync.ownerID,
    vaultID: sync.vaultID,
    credentialEpoch: sync.credentialEpoch,
    controlEpoch: sync.controlEpoch,
    generationEpoch: sync.generationEpoch,
    routingEpoch: sync.routingEpoch,
    operationID: sync.operationID,
    jti,
  } as const;
  const claims = await Effect.runPromise(verifier.verify(signed, binding, expectation, 101));
  expect(claims.floorSyncDigest).toBe(sync.floorSyncDigest);
  expect(claims.jti).toBe(jti);
  expect(
    (
      await Effect.runPromiseExit(
        verifier.verify(
          signed,
          { ...binding, jti: "floor-sync-capability-other" },
          expectation,
          101,
        ),
      )
    )._tag,
  ).toBe("Failure");
  expect(
    (
      await Effect.runPromiseExit(
        verifier.verify(
          signed,
          binding,
          { ...expectation, jti: "floor-sync-capability-other" },
          101,
        ),
      )
    )._tag,
  ).toBe("Failure");
});

test("rejects a missing or malformed operation JTI before signing and before any DO interaction", async () => {
  // P05-A: the initialization capability JTI is the command operationID. A
  // missing or malformed value must fail closed before the Directory control
  // signer produces a capability and before any OwnerVault namespace lookup.
  for (const operationID of ["", "bad jti"]) {
    const malformedBase = { ...base, operationID };
    const malformedCommand = { ...malformedBase, initDigest: initializationDigest(malformedBase) };

    let signs = 0;
    const signer = makeDirectoryControlCapabilitySigner(ring);
    const countingSigner: typeof signer = {
      ...signer,
      sign: (input, nowSeconds) => {
        signs += 1;
        return signer.sign(input, nowSeconds);
      },
    };
    const signExit = await Effect.runPromiseExit(
      signOwnerVaultInitialization(countingSigner, malformedCommand, operationID, 100),
    );
    expect(signExit._tag).toBe("Failure");
    expect(JSON.stringify(signExit)).toContain("invalid_command");
    expect(signs).toBe(0);

    let namespaceLookups = 0;
    let fetches = 0;
    const client = makeOwnerVaultInitializationClient({
      idFromName: (name) => {
        namespaceLookups += 1;
        return { toString: () => name };
      },
      get: () => ({
        fetch: async () => {
          fetches += 1;
          return new Response(
            JSON.stringify({ ...malformedCommand, durableReceipt: "owner-vault-receipt-0001" }),
          );
        },
      }),
    });
    const clientExit = await Effect.runPromiseExit(
      client.ensureInitialized(malformedCommand, { value: "token" }),
    );
    expect(clientExit._tag).toBe("Failure");
    expect(JSON.stringify(clientExit)).toContain("invalid_command");
    expect(namespaceLookups).toBe(0);
    expect(fetches).toBe(0);
  }
});

test("uses a target-only stable shard and rejects substituted or echo-only acknowledgements", async () => {
  expect(ownerVaultObjectName(command)).toBe(
    ownerVaultObjectName({
      ownerID: command.ownerID,
      vaultID: command.vaultID,
      generationEpoch: command.generationEpoch,
    }),
  );
  const client = makeOwnerVaultInitializationClient({
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({
      fetch: async () =>
        new Response(
          JSON.stringify({
            ...command,
            operationID: "substituted-operation-1",
            durableReceipt: "owner-vault-receipt-0001",
          }),
        ),
    }),
  });
  const exit = await Effect.runPromiseExit(client.ensureInitialized(command, { value: "token" }));
  expect(exit._tag).toBe("Failure");
  const echo = makeOwnerVaultInitializationClient({
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: async () => new Response(JSON.stringify(command)) }),
  });
  expect(
    (await Effect.runPromiseExit(echo.ensureInitialized(command, { value: "token" })))._tag,
  ).toBe("Failure");
  const acknowledged = makeOwnerVaultInitializationClient({
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({
      fetch: async () =>
        new Response(
          JSON.stringify({
            ...command,
            durableReceipt: "owner-vault-receipt-0001",
          }),
        ),
    }),
  });
  expect(
    (await Effect.runPromiseExit(acknowledged.ensureInitialized(command, { value: "token" })))._tag,
  ).toBe("Success");
});
