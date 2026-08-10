/** @enchiridion/effect-module */
import { sha256Hex } from "@enchiridion/protocol";
import {
  CapabilityMethod,
  type DirectoryControlCapabilitySigner,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  DirectoryControlResource,
  type DurableObjectNamespaceNative,
  type SignedCapability,
} from "@enchiridion/runtime";
import { Data, Effect } from "effect";

export const ownerVaultInitializationPath = "/v2/control/ensure-initialized";
const operationID = /^[A-Za-z0-9_-]{16,128}$/u;
const identity = /^(?:owner|vault)-[A-Za-z0-9_-]{16,128}$/u;
const digest = /^[a-f0-9]{64}$/u;
const durableReceipt = /^[A-Za-z0-9_-]{16,128}$/u;
const epoch = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

export interface OwnerVaultInitializationCommand {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly operationID: string;
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
  readonly controlEpoch: number;
  readonly initDigest: string;
}

/**
 * OwnerVault generates and persists this opaque receipt in its initialization
 * transaction. Directory deliberately cannot derive it from the command.
 */
export interface OwnerVaultInitializationAck extends OwnerVaultInitializationCommand {
  readonly durableReceipt: string;
}

export class OwnerVaultInitializationError extends Data.TaggedError(
  "OwnerVaultInitializationError",
)<{ readonly reason: "invalid_command" | "unavailable" | "ack_mismatch" }> {}

export const validOwnerVaultInitializationCommand = (
  value: OwnerVaultInitializationCommand,
): boolean =>
  identity.test(value.ownerID) &&
  identity.test(value.vaultID) &&
  value.ownerID !== value.vaultID &&
  operationID.test(value.operationID) &&
  digest.test(value.initDigest) &&
  epoch(value.generationEpoch) &&
  epoch(value.credentialEpoch) &&
  epoch(value.routingEpoch) &&
  epoch(value.controlEpoch);

/** Stable, opaque per-generation OwnerVault shard; no legacy identity participates. */
export const ownerVaultObjectName = (command: Pick<OwnerVaultInitializationCommand, "ownerID" | "vaultID" | "generationEpoch">): string =>
  `v2-owner-vault-${sha256Hex(new TextEncoder().encode(`${command.ownerID}\u0000${command.vaultID}\u0000${command.generationEpoch}`))}`;

export const initializationDigest = (command: Omit<OwnerVaultInitializationCommand, "initDigest">): string =>
  sha256Hex(new TextEncoder().encode(JSON.stringify({
    credentialEpoch: command.credentialEpoch,
    controlEpoch: command.controlEpoch,
    generationEpoch: command.generationEpoch,
    operationID: command.operationID,
    ownerID: command.ownerID,
    routingEpoch: command.routingEpoch,
    vaultID: command.vaultID,
  })));

const commandBytes = (command: OwnerVaultInitializationCommand): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(command));
const body = (command: OwnerVaultInitializationCommand, capability: SignedCapability): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ capability: capability.value, command }));

export const sameOwnerVaultInitializationAck = (
  left: OwnerVaultInitializationCommand,
  right: OwnerVaultInitializationAck,
): boolean =>
  left.ownerID === right.ownerID && left.vaultID === right.vaultID &&
  left.generationEpoch === right.generationEpoch && left.operationID === right.operationID &&
  left.credentialEpoch === right.credentialEpoch && left.routingEpoch === right.routingEpoch &&
  left.controlEpoch === right.controlEpoch && left.initDigest === right.initDigest &&
  durableReceipt.test(right.durableReceipt);

const decodeAck = (value: unknown): OwnerVaultInitializationAck | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = Object.fromEntries(Object.entries(value));
  const keys = ["ownerID", "vaultID", "generationEpoch", "operationID", "credentialEpoch", "routingEpoch", "controlEpoch", "initDigest", "durableReceipt"];
  if (Object.keys(source).length !== keys.length || keys.some((key) => !Object.hasOwn(source, key))) return undefined;
  const candidate = source as unknown as OwnerVaultInitializationAck;
  return validOwnerVaultInitializationCommand(candidate) &&
    typeof candidate.durableReceipt === "string" && durableReceipt.test(candidate.durableReceipt)
    ? candidate
    : undefined;
};

export interface OwnerVaultInitializationClient {
  readonly ensureInitialized: (command: OwnerVaultInitializationCommand, capability: SignedCapability) => Effect.Effect<OwnerVaultInitializationAck, OwnerVaultInitializationError>;
}

/** Narrow signed RPC client. OwnerVaultV2 itself is intentionally deferred to P06-05. */
export const makeOwnerVaultInitializationClient = (namespace: DurableObjectNamespaceNative): OwnerVaultInitializationClient => ({
  ensureInitialized: (command, capability) => Effect.tryPromise({
    try: async () => {
      if (!validOwnerVaultInitializationCommand(command)) throw new OwnerVaultInitializationError({ reason: "invalid_command" });
      const stub = namespace.get(namespace.idFromName(ownerVaultObjectName(command)));
      const payload = body(command, capability);
      const requestBody = new Uint8Array(payload.byteLength);
      requestBody.set(payload);
      const response = await stub.fetch(new Request(`https://owner-vault.invalid${ownerVaultInitializationPath}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: requestBody.buffer,
      }));
      if (response.status !== 200) throw new OwnerVaultInitializationError({ reason: "unavailable" });
      const ack = decodeAck(JSON.parse(await response.text()));
      if (ack === undefined || !sameOwnerVaultInitializationAck(command, ack)) throw new OwnerVaultInitializationError({ reason: "ack_mismatch" });
      return ack;
    },
    catch: (cause) => cause instanceof OwnerVaultInitializationError ? cause : new OwnerVaultInitializationError({ reason: "unavailable" }),
  }),
});

export const signOwnerVaultInitialization = (
  signer: DirectoryControlCapabilitySigner,
  command: OwnerVaultInitializationCommand,
  jti: string,
  nowSeconds: number,
): Effect.Effect<SignedCapability, OwnerVaultInitializationError> => {
  if (!validOwnerVaultInitializationCommand(command)) return Effect.fail(new OwnerVaultInitializationError({ reason: "invalid_command" }));
  const bodySHA256 = sha256Hex(commandBytes(command));
  return signer.sign({
    audience: DirectoryControlCapabilityAudience.DirectoryControl,
    authority: DirectoryControlCapabilityAuthority.DirectoryControl,
    resource: DirectoryControlResource.OwnerVaultInitialization,
    method: CapabilityMethod.POST, path: ownerVaultInitializationPath, canonicalQuery: "", bodySHA256,
    ownerID: command.ownerID, vaultID: command.vaultID, initDigest: command.initDigest,
    credentialEpoch: command.credentialEpoch, controlEpoch: command.controlEpoch,
    generationEpoch: command.generationEpoch,
    routingEpoch: command.routingEpoch, operationID: command.operationID, jti, ttlSeconds: 60,
  }, nowSeconds).pipe(Effect.mapError(() => new OwnerVaultInitializationError({ reason: "unavailable" })));
};
