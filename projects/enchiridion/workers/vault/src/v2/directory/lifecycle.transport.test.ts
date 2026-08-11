import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type OwnerVaultInitializationError,
  floorSyncDigest,
  initializationDigest,
  makeOwnerVaultFloorSyncClient,
  makeOwnerVaultInitializationClient,
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
const syncBase = { ...base, operationID: "floor-sync-operation-0001" };
const sync = { ...syncBase, floorSyncDigest: floorSyncDigest(syncBase) };
const capability = { value: "token" };
const receipt = "owner-vault-receipt-0001";

const respondingNamespace = (respond: () => Response) => ({
  idFromName: (name: string) => ({ toString: () => name }),
  get: () => ({ fetch: async () => respond() }),
});

const failureReason = async (
  effect: Effect.Effect<unknown, OwnerVaultInitializationError>,
): Promise<OwnerVaultInitializationError["reason"]> =>
  (await Effect.runPromise(Effect.flip(effect))).reason;

test("rejects acknowledgements with unknown extra fields", async () => {
  const client = makeOwnerVaultInitializationClient(
    respondingNamespace(
      () => new Response(JSON.stringify({ ...command, durableReceipt: receipt, extra: true })),
    ),
  );
  expect(await failureReason(client.ensureInitialized(command, capability))).toBe("ack_mismatch");
});

test("rejects acknowledgements with wrong field types or malformed receipts", async () => {
  const wrongType = makeOwnerVaultInitializationClient(
    respondingNamespace(
      () =>
        new Response(JSON.stringify({ ...command, durableReceipt: receipt, controlEpoch: "1" })),
    ),
  );
  expect(await failureReason(wrongType.ensureInitialized(command, capability))).toBe(
    "ack_mismatch",
  );
  const badReceipt = makeOwnerVaultInitializationClient(
    respondingNamespace(
      () => new Response(JSON.stringify({ ...command, durableReceipt: "bad receipt!" })),
    ),
  );
  expect(await failureReason(badReceipt.ensureInitialized(command, capability))).toBe(
    "ack_mismatch",
  );
});

test("rejects duplicate-member acknowledgement JSON before decoding", async () => {
  const duplicated = JSON.stringify({ ...command, durableReceipt: receipt }).replace(
    /^\{/u,
    `{"durableReceipt":"forged-receipt-000001",`,
  );
  const client = makeOwnerVaultInitializationClient(
    respondingNamespace(() => new Response(duplicated)),
  );
  expect(await failureReason(client.ensureInitialized(command, capability))).toBe("unavailable");
});

test("rejects oversized and non-200 acknowledgement responses as unavailable", async () => {
  const oversized = makeOwnerVaultInitializationClient(
    respondingNamespace(
      () =>
        new Response(
          JSON.stringify({ ...command, durableReceipt: receipt, pad: "x".repeat(8_192) }),
        ),
    ),
  );
  expect(await failureReason(oversized.ensureInitialized(command, capability))).toBe("unavailable");
  const failing = makeOwnerVaultInitializationClient(
    respondingNamespace(() => new Response("{}", { status: 503 })),
  );
  expect(await failureReason(failing.ensureInitialized(command, capability))).toBe("unavailable");
});

test("fails invalid commands before any Durable Object interaction", async () => {
  let touched = 0;
  const namespace = {
    idFromName: (name: string) => {
      touched += 1;
      return { toString: () => name };
    },
    get: () => {
      touched += 1;
      return { fetch: async () => new Response("{}") };
    },
  };
  const invalid = { ...command, ownerID: command.vaultID };
  expect(
    await failureReason(
      makeOwnerVaultInitializationClient(namespace).ensureInitialized(invalid, capability),
    ),
  ).toBe("invalid_command");
  const invalidSync = { ...sync, floorSyncDigest: "not-a-digest" };
  expect(
    await failureReason(
      makeOwnerVaultFloorSyncClient(namespace).syncFloors(invalidSync, capability),
    ),
  ).toBe("invalid_command");
  expect(touched).toBe(0);
});

test("accepts an exact floor-sync acknowledgement and rejects echoes", async () => {
  const acknowledged = makeOwnerVaultFloorSyncClient(
    respondingNamespace(() => new Response(JSON.stringify({ ...sync, durableReceipt: receipt }))),
  );
  const ack = await Effect.runPromise(acknowledged.syncFloors(sync, capability));
  expect(ack.durableReceipt).toBe(receipt);
  expect(ack.floorSyncDigest).toBe(sync.floorSyncDigest);
  const echo = makeOwnerVaultFloorSyncClient(
    respondingNamespace(() => new Response(JSON.stringify(sync))),
  );
  expect(await failureReason(echo.syncFloors(sync, capability))).toBe("ack_mismatch");
  const substituted = makeOwnerVaultFloorSyncClient(
    respondingNamespace(
      () => new Response(JSON.stringify({ ...sync, durableReceipt: receipt, credentialEpoch: 2 })),
    ),
  );
  expect(await failureReason(substituted.syncFloors(sync, capability))).toBe("ack_mismatch");
});
