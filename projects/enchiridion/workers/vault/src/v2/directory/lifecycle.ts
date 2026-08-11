/** @enchiridion/effect-module */
import { sha256Hex } from "@enchiridion/protocol";
import {
  CapabilityMethod,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  type DirectoryControlCapabilitySigner,
  DirectoryControlResource,
  type DurableObjectNamespaceNative,
  type SignedCapability,
} from "@enchiridion/runtime";
import { Data, Effect } from "effect";
import { invokeOwnerVaultControl } from "../runtime/owner-vault-control-client";

export const ownerVaultInitializationPath = "/v2/control/ensure-initialized";
export const ownerVaultFloorSyncPath = "/v2/control/sync-floors";
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

/** A private target only accepts monotonic authority floors after initialization. */
export interface OwnerVaultFloorSyncCommand {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly operationID: string;
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
  readonly controlEpoch: number;
  readonly floorSyncDigest: string;
}

export interface OwnerVaultFloorSyncAck extends OwnerVaultFloorSyncCommand {
  /** OwnerVault-generated, durable evidence for this exact forward-only sync. */
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

export const validOwnerVaultFloorSyncCommand = (value: OwnerVaultFloorSyncCommand): boolean =>
  identity.test(value.ownerID) &&
  identity.test(value.vaultID) &&
  value.ownerID !== value.vaultID &&
  operationID.test(value.operationID) &&
  digest.test(value.floorSyncDigest) &&
  epoch(value.generationEpoch) &&
  epoch(value.credentialEpoch) &&
  epoch(value.routingEpoch) &&
  epoch(value.controlEpoch);

/** Stable, opaque per-generation OwnerVault shard; no legacy identity participates. */
export const ownerVaultObjectName = (
  command: Pick<OwnerVaultInitializationCommand, "ownerID" | "vaultID" | "generationEpoch">,
): string =>
  `v2-owner-vault-${sha256Hex(new TextEncoder().encode(`${command.ownerID}\u0000${command.vaultID}\u0000${command.generationEpoch}`))}`;

export const initializationDigest = (
  command: Omit<OwnerVaultInitializationCommand, "initDigest">,
): string =>
  sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        credentialEpoch: command.credentialEpoch,
        controlEpoch: command.controlEpoch,
        generationEpoch: command.generationEpoch,
        operationID: command.operationID,
        ownerID: command.ownerID,
        routingEpoch: command.routingEpoch,
        vaultID: command.vaultID,
      }),
    ),
  );

export const floorSyncDigest = (
  command: Omit<OwnerVaultFloorSyncCommand, "floorSyncDigest">,
): string =>
  sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        credentialEpoch: command.credentialEpoch,
        controlEpoch: command.controlEpoch,
        generationEpoch: command.generationEpoch,
        operationID: command.operationID,
        ownerID: command.ownerID,
        routingEpoch: command.routingEpoch,
        vaultID: command.vaultID,
      }),
    ),
  );

const commandBytes = (command: OwnerVaultInitializationCommand): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(command));
const body = (
  command: OwnerVaultInitializationCommand | OwnerVaultFloorSyncCommand,
  capability: SignedCapability,
): Uint8Array<ArrayBuffer> => {
  const source = new TextEncoder().encode(
    JSON.stringify({ capability: capability.value, command }),
  );
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
};

export const sameOwnerVaultInitializationAck = (
  left: OwnerVaultInitializationCommand,
  right: OwnerVaultInitializationAck,
): boolean =>
  left.ownerID === right.ownerID &&
  left.vaultID === right.vaultID &&
  left.generationEpoch === right.generationEpoch &&
  left.operationID === right.operationID &&
  left.credentialEpoch === right.credentialEpoch &&
  left.routingEpoch === right.routingEpoch &&
  left.controlEpoch === right.controlEpoch &&
  left.initDigest === right.initDigest &&
  durableReceipt.test(right.durableReceipt);

export const sameOwnerVaultFloorSyncAck = (
  left: OwnerVaultFloorSyncCommand,
  right: OwnerVaultFloorSyncAck,
): boolean =>
  left.ownerID === right.ownerID &&
  left.vaultID === right.vaultID &&
  left.generationEpoch === right.generationEpoch &&
  left.operationID === right.operationID &&
  left.credentialEpoch === right.credentialEpoch &&
  left.routingEpoch === right.routingEpoch &&
  left.controlEpoch === right.controlEpoch &&
  left.floorSyncDigest === right.floorSyncDigest &&
  durableReceipt.test(right.durableReceipt);

const plainRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/**
 * Exact acknowledgement decoders. Every field is narrowed from `unknown` and a
 * fresh literal is rebuilt from the proven primitives; the untrusted source
 * object is never coerced into the trusted acknowledgement types.
 */
const decodeAck = (value: unknown): OwnerVaultInitializationAck | undefined => {
  const source = plainRecord(value);
  if (
    source === undefined ||
    !exact(source, [
      "ownerID",
      "vaultID",
      "generationEpoch",
      "operationID",
      "credentialEpoch",
      "routingEpoch",
      "controlEpoch",
      "initDigest",
      "durableReceipt",
    ])
  )
    return undefined;
  const {
    ownerID,
    vaultID,
    generationEpoch,
    operationID: sourceOperationID,
    credentialEpoch,
    routingEpoch,
    controlEpoch,
    initDigest,
    durableReceipt: receipt,
  } = source;
  if (
    typeof ownerID !== "string" ||
    typeof vaultID !== "string" ||
    typeof sourceOperationID !== "string" ||
    typeof initDigest !== "string" ||
    typeof receipt !== "string" ||
    typeof generationEpoch !== "number" ||
    typeof credentialEpoch !== "number" ||
    typeof routingEpoch !== "number" ||
    typeof controlEpoch !== "number"
  )
    return undefined;
  const candidate = {
    ownerID,
    vaultID,
    generationEpoch,
    operationID: sourceOperationID,
    credentialEpoch,
    routingEpoch,
    controlEpoch,
    initDigest,
    durableReceipt: receipt,
  };
  return validOwnerVaultInitializationCommand(candidate) && durableReceipt.test(receipt)
    ? candidate
    : undefined;
};

const decodeFloorSyncAck = (value: unknown): OwnerVaultFloorSyncAck | undefined => {
  const source = plainRecord(value);
  if (
    source === undefined ||
    !exact(source, [
      "ownerID",
      "vaultID",
      "generationEpoch",
      "operationID",
      "credentialEpoch",
      "routingEpoch",
      "controlEpoch",
      "floorSyncDigest",
      "durableReceipt",
    ])
  )
    return undefined;
  const {
    ownerID,
    vaultID,
    generationEpoch,
    operationID: sourceOperationID,
    credentialEpoch,
    routingEpoch,
    controlEpoch,
    floorSyncDigest: sourceFloorSyncDigest,
    durableReceipt: receipt,
  } = source;
  if (
    typeof ownerID !== "string" ||
    typeof vaultID !== "string" ||
    typeof sourceOperationID !== "string" ||
    typeof sourceFloorSyncDigest !== "string" ||
    typeof receipt !== "string" ||
    typeof generationEpoch !== "number" ||
    typeof credentialEpoch !== "number" ||
    typeof routingEpoch !== "number" ||
    typeof controlEpoch !== "number"
  )
    return undefined;
  const candidate = {
    ownerID,
    vaultID,
    generationEpoch,
    operationID: sourceOperationID,
    credentialEpoch,
    routingEpoch,
    controlEpoch,
    floorSyncDigest: sourceFloorSyncDigest,
    durableReceipt: receipt,
  };
  return validOwnerVaultFloorSyncCommand(candidate) && durableReceipt.test(receipt)
    ? candidate
    : undefined;
};

export interface OwnerVaultInitializationClient {
  readonly ensureInitialized: (
    command: OwnerVaultInitializationCommand,
    capability: SignedCapability,
  ) => Effect.Effect<OwnerVaultInitializationAck, OwnerVaultInitializationError>;
}

export interface OwnerVaultFloorSyncClient {
  readonly syncFloors: (
    command: OwnerVaultFloorSyncCommand,
    capability: SignedCapability,
  ) => Effect.Effect<OwnerVaultFloorSyncAck, OwnerVaultInitializationError>;
}

/** Narrow signed RPC client. OwnerVaultV2 itself is intentionally deferred to P06-05. */
export const makeOwnerVaultInitializationClient = (
  namespace: DurableObjectNamespaceNative,
): OwnerVaultInitializationClient => ({
  ensureInitialized: (command, capability) =>
    Effect.suspend(() => {
      if (!validOwnerVaultInitializationCommand(command))
        return Effect.fail(new OwnerVaultInitializationError({ reason: "invalid_command" }));
      return invokeOwnerVaultControl(
        namespace,
        { name: ownerVaultObjectName(command), path: ownerVaultInitializationPath },
        body(command, capability),
      ).pipe(
        Effect.mapError(() => new OwnerVaultInitializationError({ reason: "unavailable" })),
        Effect.flatMap((payload) => {
          const ack = decodeAck(payload);
          return ack !== undefined && sameOwnerVaultInitializationAck(command, ack)
            ? Effect.succeed(ack)
            : Effect.fail(new OwnerVaultInitializationError({ reason: "ack_mismatch" }));
        }),
      );
    }),
});

export const makeOwnerVaultFloorSyncClient = (
  namespace: DurableObjectNamespaceNative,
): OwnerVaultFloorSyncClient => ({
  syncFloors: (command, capability) =>
    Effect.suspend(() => {
      if (!validOwnerVaultFloorSyncCommand(command))
        return Effect.fail(new OwnerVaultInitializationError({ reason: "invalid_command" }));
      return invokeOwnerVaultControl(
        namespace,
        { name: ownerVaultObjectName(command), path: ownerVaultFloorSyncPath },
        body(command, capability),
      ).pipe(
        Effect.mapError(() => new OwnerVaultInitializationError({ reason: "unavailable" })),
        Effect.flatMap((payload) => {
          const ack = decodeFloorSyncAck(payload);
          return ack !== undefined && sameOwnerVaultFloorSyncAck(command, ack)
            ? Effect.succeed(ack)
            : Effect.fail(new OwnerVaultInitializationError({ reason: "ack_mismatch" }));
        }),
      );
    }),
});

export const signOwnerVaultInitialization = (
  signer: DirectoryControlCapabilitySigner,
  command: OwnerVaultInitializationCommand,
  jti: string,
  nowSeconds: number,
): Effect.Effect<SignedCapability, OwnerVaultInitializationError> => {
  if (!validOwnerVaultInitializationCommand(command))
    return Effect.fail(new OwnerVaultInitializationError({ reason: "invalid_command" }));
  const bodySHA256 = sha256Hex(commandBytes(command));
  return signer
    .sign(
      {
        audience: DirectoryControlCapabilityAudience.DirectoryControl,
        authority: DirectoryControlCapabilityAuthority.DirectoryControl,
        resource: DirectoryControlResource.OwnerVaultInitialization,
        method: CapabilityMethod.POST,
        path: ownerVaultInitializationPath,
        canonicalQuery: "",
        bodySHA256,
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        initDigest: command.initDigest,
        credentialEpoch: command.credentialEpoch,
        controlEpoch: command.controlEpoch,
        generationEpoch: command.generationEpoch,
        routingEpoch: command.routingEpoch,
        operationID: command.operationID,
        jti,
        ttlSeconds: 60,
      },
      nowSeconds,
    )
    .pipe(Effect.mapError(() => new OwnerVaultInitializationError({ reason: "unavailable" })));
};

export const signOwnerVaultFloorSync = (
  signer: DirectoryControlCapabilitySigner,
  command: OwnerVaultFloorSyncCommand,
  jti: string,
  nowSeconds: number,
): Effect.Effect<SignedCapability, OwnerVaultInitializationError> => {
  if (!validOwnerVaultFloorSyncCommand(command))
    return Effect.fail(new OwnerVaultInitializationError({ reason: "invalid_command" }));
  const bodySHA256 = sha256Hex(new TextEncoder().encode(JSON.stringify(command)));
  return signer
    .sign(
      {
        audience: DirectoryControlCapabilityAudience.DirectoryControl,
        authority: DirectoryControlCapabilityAuthority.DirectoryControl,
        resource: DirectoryControlResource.OwnerVaultFloorSync,
        method: CapabilityMethod.POST,
        path: ownerVaultFloorSyncPath,
        canonicalQuery: "",
        bodySHA256,
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        floorSyncDigest: command.floorSyncDigest,
        credentialEpoch: command.credentialEpoch,
        controlEpoch: command.controlEpoch,
        generationEpoch: command.generationEpoch,
        routingEpoch: command.routingEpoch,
        operationID: command.operationID,
        jti,
        ttlSeconds: 60,
      },
      nowSeconds,
    )
    .pipe(Effect.mapError(() => new OwnerVaultInitializationError({ reason: "unavailable" })));
};
