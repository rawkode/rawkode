/** @enchiridion/effect-module */
import {
  type DurableObjectBoundaryError,
  type DurableObjectStorage,
  durableObjectTransactionDomainCodec,
} from "@enchiridion/runtime";
import { sha256Hex } from "@enchiridion/protocol";
import { Context, Data, Effect, Layer, Ref, Schema } from "effect";
import { isOwnerID, isVaultID, ownerID, vaultID } from "../foundation/schemas";
import {
  deriveDirectoryInitID,
  isCanonicalDirectoryAlias,
  maximumDirectoryControlReplays,
  maximumDirectoryReplayRetentionSeconds,
  maximumDirectoryRetiredAliases,
  maximumDirectoryTransitions,
  validDirectoryResolution,
} from "./invariants";
import type {
  DirectoryControlReplay,
  DirectoryCredentialTransition,
  DirectoryCredentialTransitionResult,
  DirectoryFreeze,
  DirectoryOwnerVaultInitialization,
  DirectoryOwnerFenceAck,
  DirectoryReplay,
  DirectoryResolution,
  DirectoryRetiredAlias,
  DirectoryState,
} from "./types";

const stateKey = "v2.directory.state";
const identifier = /^[A-Za-z0-9._~-]{1,128}$/u;
const initID = /^init-[a-f0-9]{64}$/u;
const jti = /^[A-Za-z0-9_-]{16,128}$/u;

export class DirectoryRepositoryError extends Data.TaggedError("DirectoryRepositoryError")<{
  readonly reason: "unavailable";
}> {}

/** The complete, serializable failure set used to force DO rollback. */
export interface DirectoryTransactionError {
  readonly _tag: "DirectoryTransactionError";
  readonly reason:
    | "invalid_invocation"
    | "capability_rejected"
    | "replay_conflict"
    | "replay_capacity"
    | "alias_conflict"
    | "random_unavailable"
    | "repository_unavailable"
    | "operation_conflict"
    | "operation_capacity"
    | "binding_unavailable"
    | "binding_frozen"
    | "owner_ack_mismatch";
}

export const directoryTransactionError = (
  reason: DirectoryTransactionError["reason"],
): DirectoryTransactionError => ({ _tag: "DirectoryTransactionError", reason });

const transactionErrorSchema = Schema.Struct({
  _tag: Schema.Literal("DirectoryTransactionError"),
  reason: Schema.Literal(
    "invalid_invocation",
    "capability_rejected",
    "replay_conflict",
    "replay_capacity",
    "alias_conflict",
    "random_unavailable",
    "repository_unavailable",
    "operation_conflict",
    "operation_capacity",
    "binding_unavailable",
    "binding_frozen",
    "owner_ack_mismatch",
  ),
});
const transactionCodec = durableObjectTransactionDomainCodec(transactionErrorSchema);

/** A Directory operation runs in one transaction and can only fail with a closed domain error. */
export interface DirectoryRepository {
  readonly transact: <A>(
    operation: (
      current: DirectoryState,
    ) => Effect.Effect<readonly [A, DirectoryState], DirectoryTransactionError>,
  ) => Effect.Effect<A, DirectoryTransactionError | DirectoryRepositoryError>;
}

export const DirectoryRepository = Context.GenericTag<DirectoryRepository>(
  "@enchiridion/worker-vault/v2/directory/DirectoryRepository",
);

const empty = (): DirectoryState => ({
  aliases: {},
  bindings: {},
  replays: {},
  controlReplays: {},
  transitions: {},
  frozenBindings: {},
  retiredAliases: {},
  initializations: {},
});
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  new Set(keys).size === keys.length &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const epoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const initializationDigest = (value: Omit<DirectoryOwnerVaultInitialization, "initDigest" | "activated">): string =>
  sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        credentialEpoch: value.credentialEpoch,
        controlEpoch: value.controlEpoch,
        generationEpoch: value.generationEpoch,
        operationID: value.operationID,
        ownerID: value.ownerID,
        routingEpoch: value.routingEpoch,
        vaultID: value.vaultID,
      }),
    ),
  );

const decodeInitialization = (value: unknown): DirectoryOwnerVaultInitialization | undefined => {
  const source = record(value);
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
      ...(Object.hasOwn(source, "durableReceipt") ? ["durableReceipt"] : []),
    ]) ||
    typeof source.ownerID !== "string" ||
    ownerID(source.ownerID) === undefined ||
    typeof source.vaultID !== "string" ||
    vaultID(source.vaultID) === undefined ||
    !epoch(source.generationEpoch) ||
    typeof source.operationID !== "string" ||
    !operationID.test(source.operationID) ||
    !epoch(source.credentialEpoch) ||
    !epoch(source.routingEpoch) ||
    !epoch(source.controlEpoch) ||
    typeof source.initDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.initDigest) ||
    (Object.hasOwn(source, "durableReceipt") &&
      (typeof source.durableReceipt !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(source.durableReceipt)))
  )
    return undefined;
  const candidate = {
    ownerID: source.ownerID,
    vaultID: source.vaultID,
    generationEpoch: source.generationEpoch,
    operationID: source.operationID,
    credentialEpoch: source.credentialEpoch,
    routingEpoch: source.routingEpoch,
    controlEpoch: source.controlEpoch,
    initDigest: source.initDigest,
    ...(typeof source.durableReceipt === "string"
      ? { durableReceipt: source.durableReceipt }
      : {}),
  } satisfies DirectoryOwnerVaultInitialization;
  return initializationDigest(candidate) === candidate.initDigest ? candidate : undefined;
};

const decodeResolution = (binding: string, value: unknown): DirectoryResolution | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    !exact(source, [
      "ownerID",
      "vaultID",
      "initID",
      "generationEpoch",
      "activeGeneration",
      "routingEpoch",
      "credentialEpoch",
    ]) ||
    typeof source.ownerID !== "string" ||
    typeof source.vaultID !== "string" ||
    typeof source.initID !== "string" ||
    !initID.test(source.initID) ||
    !epoch(source.generationEpoch) ||
    !epoch(source.activeGeneration) ||
    !epoch(source.routingEpoch) ||
    !epoch(source.credentialEpoch)
  )
    return undefined;
  const parsedOwnerID = ownerID(source.ownerID);
  const parsedVaultID = vaultID(source.vaultID);
  if (parsedOwnerID === undefined || parsedVaultID === undefined) return undefined;
  const resolved = {
    ownerID: parsedOwnerID,
    vaultID: parsedVaultID,
    initID: source.initID,
    generationEpoch: source.generationEpoch,
    activeGeneration: source.activeGeneration,
    routingEpoch: source.routingEpoch,
    credentialEpoch: source.credentialEpoch,
  } satisfies DirectoryResolution;
  return validDirectoryResolution(binding, resolved) ? resolved : undefined;
};

const encodeResolution = (
  binding: string,
  value: DirectoryResolution,
): Readonly<Record<string, unknown>> | undefined =>
  isOwnerID(value.ownerID) &&
  isVaultID(value.vaultID) &&
  initID.test(value.initID) &&
  epoch(value.generationEpoch) &&
  epoch(value.activeGeneration) &&
  epoch(value.routingEpoch) &&
  epoch(value.credentialEpoch) &&
  validDirectoryResolution(binding, value)
    ? {
        ownerID: value.ownerID.value,
        vaultID: value.vaultID.value,
        initID: value.initID,
        generationEpoch: value.generationEpoch,
        activeGeneration: value.activeGeneration,
        routingEpoch: value.routingEpoch,
        credentialEpoch: value.credentialEpoch,
      }
    : undefined;
const sameResolution = (left: DirectoryResolution, right: DirectoryResolution): boolean =>
  left.ownerID.value === right.ownerID.value &&
  left.vaultID.value === right.vaultID.value &&
  left.initID === right.initID &&
  left.generationEpoch === right.generationEpoch &&
  left.activeGeneration === right.activeGeneration &&
  left.routingEpoch === right.routingEpoch &&
  left.credentialEpoch === right.credentialEpoch;

const uniqueBindingIdentities = (
  bindings: Readonly<Record<string, DirectoryResolution>>,
): boolean => {
  const owners = new Set<string>();
  const vaults = new Set<string>();
  const initializers = new Set<string>();
  const pairs = new Set<string>();
  for (const value of Object.values(bindings)) {
    const owner = value.ownerID.value;
    const vault = value.vaultID.value;
    const pair = `${owner}\u0000${vault}`;
    if (owners.has(owner) || vaults.has(vault) || initializers.has(value.initID) || pairs.has(pair))
      return false;
    owners.add(owner);
    vaults.add(vault);
    initializers.add(value.initID);
    pairs.add(pair);
  }
  return true;
};

const validReplayRetention = (expiresAt: number, retainUntil: number): boolean =>
  epoch(expiresAt) &&
  epoch(retainUntil) &&
  retainUntil > expiresAt &&
  retainUntil - expiresAt <= maximumDirectoryReplayRetentionSeconds;

const decodeReplay = (
  value: unknown,
  bindings: Readonly<Record<string, DirectoryResolution>>,
): DirectoryReplay | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    !exact(source, ["fingerprint", "expiresAt", "retainUntil", "resolution"]) ||
    typeof source.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.fingerprint) ||
    !epoch(source.expiresAt) ||
    !epoch(source.retainUntil) ||
    !validReplayRetention(source.expiresAt, source.retainUntil)
  )
    return undefined;
  const rawResolution = record(source.resolution);
  const candidates =
    rawResolution === undefined || typeof rawResolution.initID !== "string"
      ? []
      : Object.entries(bindings).filter(
          ([, candidate]) => candidate.initID === rawResolution.initID,
        );
  const candidate = candidates[0];
  if (candidate === undefined || candidates.length !== 1) return undefined;
  const resolved = decodeResolution(candidate[0], source.resolution);
  return resolved === undefined
    ? undefined
    : sameResolution(candidate[1], resolved)
      ? {
          fingerprint: source.fingerprint,
          expiresAt: source.expiresAt,
          retainUntil: source.retainUntil,
          resolution: resolved,
        }
      : undefined;
};

const decodeControlReplay = (value: unknown): DirectoryControlReplay | undefined => {
  const source = record(value);
  return source === undefined ||
    !exact(source, ["operationID", "fingerprint", "expiresAt", "retainUntil"]) ||
    typeof source.operationID !== "string" ||
    !operationID.test(source.operationID) ||
    typeof source.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.fingerprint) ||
    !epoch(source.expiresAt) ||
    !epoch(source.retainUntil) ||
    !validReplayRetention(source.expiresAt, source.retainUntil)
    ? undefined
    : {
        operationID: source.operationID,
        fingerprint: source.fingerprint,
        expiresAt: source.expiresAt,
        retainUntil: source.retainUntil,
      };
};

const operationID = /^[A-Za-z0-9_-]{16,128}$/u;
const phase = new Set(["PREPARED", "FROZEN", "OWNER_ACKED", "DIRECTORY_CAS", "COMPLETED"]);
const transitionKind = new Set(["revoke", "rebind"]);
const maximumTransitionRetentionSeconds = 300;
const transitionOperationLifetimeSeconds = 60;
const resolutionWire = (binding: string, value: DirectoryResolution) =>
  encodeResolution(binding, value);
const exactNextEpoch = (value: number, next: number): boolean =>
  Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER && next === value + 1;
const decodeFreeze = (value: unknown): DirectoryFreeze | undefined => {
  const source = record(value);
  return source === undefined ||
    !exact(source, ["operationID", "credentialEpochFloor", "routingEpochFloor"]) ||
    typeof source.operationID !== "string" ||
    !operationID.test(source.operationID) ||
    !epoch(source.credentialEpochFloor) ||
    !epoch(source.routingEpochFloor)
    ? undefined
    : {
        operationID: source.operationID,
        credentialEpochFloor: source.credentialEpochFloor,
        routingEpochFloor: source.routingEpochFloor,
      };
};
const decodeRetiredAlias = (alias: string, value: unknown): DirectoryRetiredAlias | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    !exact(source, [
      "bindingID",
      "operationID",
      "ownerID",
      "vaultID",
      "reason",
      "retiredAt",
      "activeGeneration",
      "credentialEpoch",
      "routingEpoch",
    ]) ||
    !isCanonicalDirectoryAlias(alias) ||
    typeof source.bindingID !== "string" ||
    !isCanonicalDirectoryAlias(source.bindingID) ||
    typeof source.operationID !== "string" ||
    !operationID.test(source.operationID) ||
    typeof source.ownerID !== "string" ||
    ownerID(source.ownerID) === undefined ||
    typeof source.vaultID !== "string" ||
    vaultID(source.vaultID) === undefined ||
    typeof source.reason !== "string" ||
    !transitionKind.has(source.reason) ||
    !epoch(source.retiredAt) ||
    !epoch(source.activeGeneration) ||
    !epoch(source.credentialEpoch) ||
    !epoch(source.routingEpoch)
  )
    return undefined;
  return {
    bindingID: source.bindingID,
    operationID: source.operationID,
    ownerID: source.ownerID,
    vaultID: source.vaultID,
    reason: source.reason === "revoke" ? "revoke" : "rebind",
    retiredAt: source.retiredAt,
    activeGeneration: source.activeGeneration,
    credentialEpoch: source.credentialEpoch,
    routingEpoch: source.routingEpoch,
  };
};
const ownerFenceAckKeys = [
  "ownerID",
  "vaultID",
  "generation",
  "operationID",
  "expectedCredentialEpoch",
  "expectedRoutingEpoch",
  "credentialEpoch",
  "routingEpoch",
  "admissionsStopped",
  "socketsFenced",
] as const;

const decodeAck = (value: unknown): DirectoryOwnerFenceAck | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    !exact(source, ownerFenceAckKeys) ||
    typeof source.ownerID !== "string" ||
    typeof source.vaultID !== "string" ||
    typeof source.operationID !== "string" ||
    !operationID.test(source.operationID) ||
    !epoch(source.generation) ||
    !epoch(source.expectedCredentialEpoch) ||
    !epoch(source.expectedRoutingEpoch) ||
    !epoch(source.credentialEpoch) ||
    !epoch(source.routingEpoch) ||
    source.admissionsStopped !== true ||
    source.socketsFenced !== true
  )
    return undefined;
  return {
    ownerID: source.ownerID,
    vaultID: source.vaultID,
    generation: source.generation,
    operationID: source.operationID,
    expectedCredentialEpoch: source.expectedCredentialEpoch,
    expectedRoutingEpoch: source.expectedRoutingEpoch,
    credentialEpoch: source.credentialEpoch,
    routingEpoch: source.routingEpoch,
    admissionsStopped: true,
    socketsFenced: true,
  };
};
const decodeResult = (value: unknown): DirectoryCredentialTransitionResult | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    !Object.keys(source).every((key) =>
      [
        "operationID",
        "kind",
        "bindingID",
        "credentialEpoch",
        "routingEpoch",
        "replacementBindingID",
      ].includes(key),
    ) ||
    !["operationID", "kind", "bindingID", "credentialEpoch", "routingEpoch"].every((key) =>
      Object.hasOwn(source, key),
    ) ||
    typeof source.operationID !== "string" ||
    !operationID.test(source.operationID) ||
    typeof source.kind !== "string" ||
    !transitionKind.has(source.kind) ||
    typeof source.bindingID !== "string" ||
    !isCanonicalDirectoryAlias(source.bindingID) ||
    !epoch(source.credentialEpoch) ||
    !epoch(source.routingEpoch) ||
    (source.replacementBindingID !== undefined &&
      (typeof source.replacementBindingID !== "string" ||
        !isCanonicalDirectoryAlias(source.replacementBindingID)))
  )
    return undefined;
  return {
    operationID: source.operationID,
    kind: source.kind === "revoke" ? "revoke" : "rebind",
    bindingID: source.bindingID,
    credentialEpoch: source.credentialEpoch,
    routingEpoch: source.routingEpoch,
    ...(source.replacementBindingID === undefined
      ? {}
      : { replacementBindingID: source.replacementBindingID }),
  };
};
const decodeTransition = (value: unknown): DirectoryCredentialTransition | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    !Object.keys(source).every((key) =>
      [
        "operationID",
        "fingerprint",
        "kind",
        "bindingID",
        "expected",
        "sourceAliases",
        "replacementAliases",
        "phase",
        "freeze",
        "ownerAck",
        "result",
        "createdAt",
        "expiresAt",
        "retainUntil",
      ].includes(key),
    ) ||
    ![
      "operationID",
      "fingerprint",
      "kind",
      "bindingID",
      "expected",
      "sourceAliases",
      "replacementAliases",
      "phase",
      "freeze",
      "createdAt",
      "expiresAt",
      "retainUntil",
    ].every((key) => Object.hasOwn(source, key)) ||
    typeof source.operationID !== "string" ||
    !operationID.test(source.operationID) ||
    typeof source.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.fingerprint) ||
    typeof source.kind !== "string" ||
    !transitionKind.has(source.kind) ||
    typeof source.bindingID !== "string" ||
    !isCanonicalDirectoryAlias(source.bindingID) ||
    !Array.isArray(source.sourceAliases) ||
    !source.sourceAliases.every(isCanonicalDirectoryAlias) ||
    new Set(source.sourceAliases).size !== source.sourceAliases.length ||
    !Array.isArray(source.replacementAliases) ||
    !source.replacementAliases.every(isCanonicalDirectoryAlias) ||
    new Set(source.replacementAliases).size !== source.replacementAliases.length ||
    typeof source.phase !== "string" ||
    !phase.has(source.phase) ||
    !epoch(source.createdAt) ||
    !epoch(source.expiresAt) ||
    !epoch(source.retainUntil)
  )
    return undefined;
  const expected = decodeResolution(source.bindingID, source.expected);
  const freeze = decodeFreeze(source.freeze);
  const ownerAck = source.ownerAck === undefined ? undefined : decodeAck(source.ownerAck);
  const result = source.result === undefined ? undefined : decodeResult(source.result);
  const evidenceLegal =
    source.phase === "PREPARED" || source.phase === "FROZEN"
      ? ownerAck === undefined && result === undefined
      : source.phase === "OWNER_ACKED"
        ? ownerAck !== undefined && result === undefined
        : ownerAck !== undefined && result !== undefined;
  const lifecycleEvidenceValid =
    ownerAck === undefined
      ? true
      : expected !== undefined &&
        freeze !== undefined &&
        ownerAck.ownerID === expected.ownerID.value &&
        ownerAck.vaultID === expected.vaultID.value &&
        ownerAck.generation === expected.activeGeneration &&
        ownerAck.expectedCredentialEpoch === expected.credentialEpoch &&
        ownerAck.expectedRoutingEpoch === expected.routingEpoch &&
        exactNextEpoch(expected.credentialEpoch, freeze?.credentialEpochFloor ?? 0) &&
        exactNextEpoch(expected.routingEpoch, freeze?.routingEpochFloor ?? 0) &&
        ownerAck.credentialEpoch === freeze?.credentialEpochFloor &&
        ownerAck.routingEpoch === freeze?.routingEpochFloor;
  const transitionKindValid =
    source.kind === "revoke"
      ? source.replacementAliases.length === 0 && result?.replacementBindingID === undefined
      : source.replacementAliases.length >= 1 &&
        !source.replacementAliases.includes(source.bindingID) &&
        (result === undefined || result.replacementBindingID === source.replacementAliases[0]);
  const resultEvidenceValid =
    result === undefined
      ? true
      : ownerAck !== undefined &&
        result.kind === source.kind &&
        result.bindingID === source.bindingID &&
        result.credentialEpoch === ownerAck.credentialEpoch &&
        result.routingEpoch === ownerAck.routingEpoch;
  if (
    expected === undefined ||
    freeze === undefined ||
    !exactNextEpoch(expected.credentialEpoch, freeze.credentialEpochFloor) ||
    !exactNextEpoch(expected.routingEpoch, freeze.routingEpochFloor) ||
    (source.ownerAck !== undefined && ownerAck === undefined) ||
    (source.result !== undefined && result === undefined) ||
    !evidenceLegal ||
    !lifecycleEvidenceValid ||
    !transitionKindValid ||
    !resultEvidenceValid ||
    source.createdAt > Number.MAX_SAFE_INTEGER - transitionOperationLifetimeSeconds ||
    source.createdAt > source.expiresAt ||
    source.expiresAt !== source.createdAt + transitionOperationLifetimeSeconds ||
    source.expiresAt >= source.retainUntil ||
    source.retainUntil - source.expiresAt > maximumTransitionRetentionSeconds ||
    freeze.operationID !== source.operationID ||
    (ownerAck !== undefined && ownerAck.operationID !== source.operationID) ||
    (result !== undefined && result.operationID !== source.operationID)
  )
    return undefined;
  return {
    operationID: source.operationID,
    fingerprint: source.fingerprint,
    kind: source.kind === "revoke" ? "revoke" : "rebind",
    bindingID: source.bindingID,
    expected,
    sourceAliases: source.sourceAliases,
    replacementAliases: source.replacementAliases,
    phase:
      source.phase === "PREPARED" ||
      source.phase === "FROZEN" ||
      source.phase === "OWNER_ACKED" ||
      source.phase === "DIRECTORY_CAS" ||
      source.phase === "COMPLETED"
        ? source.phase
        : "COMPLETED",
    freeze,
    ...(ownerAck === undefined ? {} : { ownerAck }),
    ...(result === undefined ? {} : { result }),
    createdAt: source.createdAt,
    expiresAt: source.expiresAt,
    retainUntil: source.retainUntil,
  };
};
const encodeTransition = (
  value: DirectoryCredentialTransition,
): Readonly<Record<string, unknown>> | undefined => {
  const expected = resolutionWire(value.bindingID, value.expected);
  const decoded = decodeTransition({ ...value, expected });
  return decoded === undefined ? undefined : { ...decoded, expected };
};

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const aliasesFor = (
  aliases: Readonly<Record<string, string>>,
  binding: string,
): readonly string[] =>
  Object.entries(aliases)
    .filter(([, target]) => target === binding)
    .map(([alias]) => alias)
    .sort();
const reboundResolution = (
  transition: DirectoryCredentialTransition,
): DirectoryResolution | undefined => {
  const replacement = transition.result?.replacementBindingID;
  if (replacement === undefined || transition.ownerAck === undefined) return undefined;
  const initID = deriveDirectoryInitID(replacement);
  if (initID === undefined) return undefined;
  const rebound: DirectoryResolution = {
    ...transition.expected,
    initID,
    credentialEpoch: transition.ownerAck.credentialEpoch,
    routingEpoch: transition.ownerAck.routingEpoch,
  };
  return validDirectoryResolution(replacement, rebound) ? rebound : undefined;
};
const exactResult = (transition: DirectoryCredentialTransition): boolean =>
  transition.ownerAck !== undefined &&
  transition.result !== undefined &&
  transition.result.credentialEpoch === transition.freeze.credentialEpochFloor &&
  transition.result.routingEpoch === transition.freeze.routingEpochFloor &&
  transition.ownerAck.credentialEpoch === transition.freeze.credentialEpochFloor &&
  transition.ownerAck.routingEpoch === transition.freeze.routingEpochFloor;
const transitionMapsValid = (
  transition: DirectoryCredentialTransition,
  state: Pick<
    DirectoryState,
    "aliases" | "bindings" | "transitions" | "frozenBindings" | "retiredAliases"
  >,
): boolean => {
  const frozen = state.frozenBindings[transition.bindingID];
  const freezeMatches =
    frozen !== undefined &&
    frozen.operationID === transition.operationID &&
    frozen.credentialEpochFloor === transition.freeze.credentialEpochFloor &&
    frozen.routingEpochFloor === transition.freeze.routingEpochFloor;
  const source = state.bindings[transition.bindingID];
  const sourceLive =
    source !== undefined &&
    sameResolution(source, transition.expected) &&
    sameStrings(aliasesFor(state.aliases, transition.bindingID), transition.sourceAliases);
  const replacementAvailable =
    transition.kind === "revoke" ||
    transition.replacementAliases.every(
      (alias) =>
        state.bindings[alias] === undefined &&
        (state.aliases[alias] === undefined ||
          (state.aliases[alias] === transition.bindingID &&
            transition.sourceAliases.includes(alias))),
    );
  if (
    transition.phase === "PREPARED" ||
    transition.phase === "FROZEN" ||
    transition.phase === "OWNER_ACKED"
  )
    return sourceLive && replacementAvailable && freezeMatches;
  const resultApplied =
    exactResult(transition) &&
    (transition.kind === "revoke"
      ? state.bindings[transition.bindingID] === undefined &&
        aliasesFor(state.aliases, transition.bindingID).length === 0
      : (() => {
          const replacement = transition.result?.replacementBindingID;
          const rebound = reboundResolution(transition);
          return (
            replacement !== undefined &&
            rebound !== undefined &&
            state.bindings[transition.bindingID] === undefined &&
            aliasesFor(state.aliases, transition.bindingID).length === 0 &&
            state.bindings[replacement] !== undefined &&
            sameResolution(state.bindings[replacement], rebound) &&
            sameStrings(aliasesFor(state.aliases, replacement), transition.replacementAliases)
          );
        })());
  const expectedRetired = [...new Set([...transition.sourceAliases, transition.bindingID])].filter(
    (alias) => !transition.replacementAliases.includes(alias),
  );
  const retirementApplied = expectedRetired.every((alias) => {
    const retired = state.retiredAliases[alias];
    return (
      retired !== undefined &&
      retired.bindingID === transition.bindingID &&
      retired.operationID === transition.operationID &&
      retired.ownerID === transition.expected.ownerID.value &&
      retired.vaultID === transition.expected.vaultID.value &&
      retired.reason === transition.kind &&
      retired.retiredAt === transition.createdAt &&
      retired.activeGeneration === transition.expected.activeGeneration &&
      retired.credentialEpoch === transition.freeze.credentialEpochFloor &&
      retired.routingEpoch === transition.freeze.routingEpochFloor
    );
  });
  if (transition.phase === "DIRECTORY_CAS")
    return resultApplied && freezeMatches && retirementApplied;
  // Completion removes the fence. Its immutable result and exact owner acknowledgement prove
  // the CAS that just happened; current maps are deliberately not pinned by history because a
  // later, valid transition may immediately supersede this binding while the receipt is retained.
  return !freezeMatches && exactResult(transition) && retirementApplied;
};
const transitionsCollectivelyValid = (
  state: Pick<
    DirectoryState,
    "aliases" | "bindings" | "transitions" | "frozenBindings" | "retiredAliases"
  >,
): boolean => {
  const activeBindings = new Set<string>();
  const claimedReplacementAliases = new Set<string>();
  for (const transition of Object.values(state.transitions)) {
    if (!transitionMapsValid(transition, state)) return false;
    if (transition.phase === "COMPLETED") continue;
    if (activeBindings.has(transition.bindingID)) return false;
    activeBindings.add(transition.bindingID);
    if (transition.kind === "rebind") {
      for (const alias of transition.replacementAliases) {
        if (claimedReplacementAliases.has(alias)) return false;
        claimedReplacementAliases.add(alias);
      }
    }
  }
  const expectedFrozen = new Map<string, DirectoryFreeze>();
  for (const transition of Object.values(state.transitions)) {
    if (transition.phase === "COMPLETED") continue;
    if (expectedFrozen.has(transition.bindingID)) return false;
    expectedFrozen.set(transition.bindingID, transition.freeze);
  }
  const actual = Object.entries(state.frozenBindings);
  return (
    actual.length === expectedFrozen.size &&
    actual.every(([binding, freeze]) => {
      const expected = expectedFrozen.get(binding);
      return (
        expected !== undefined &&
        expected.operationID === freeze.operationID &&
        expected.credentialEpochFloor === freeze.credentialEpochFloor &&
        expected.routingEpochFloor === freeze.routingEpochFloor
      );
    })
  );
};

const decodeState = (value: unknown): DirectoryState | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    !exact(source, [
      "aliases",
      "bindings",
      "replays",
      "controlReplays",
      "transitions",
      "frozenBindings",
      "retiredAliases",
      "initializations",
    ])
  )
    return undefined;
  const rawAliases = record(source.aliases);
  const rawBindings = record(source.bindings);
  const rawReplays = record(source.replays);
  const rawControlReplays = record(source.controlReplays);
  const rawTransitions = record(source.transitions);
  const rawFrozenBindings = record(source.frozenBindings);
  const rawRetiredAliases = record(source.retiredAliases);
  const rawInitializations = record(source.initializations);
  if (
    rawAliases === undefined ||
    rawBindings === undefined ||
    rawReplays === undefined ||
    rawControlReplays === undefined ||
    rawTransitions === undefined ||
    rawFrozenBindings === undefined ||
    rawRetiredAliases === undefined ||
    rawInitializations === undefined
  )
    return undefined;
  if (Object.keys(rawControlReplays).length > maximumDirectoryControlReplays) return undefined;
  if (Object.keys(rawTransitions).length > maximumDirectoryTransitions) return undefined;
  if (Object.keys(rawRetiredAliases).length > maximumDirectoryRetiredAliases) return undefined;
  const aliases: Record<string, string> = {};
  for (const [alias, binding] of Object.entries(rawAliases)) {
    if (
      !isCanonicalDirectoryAlias(alias) ||
      typeof binding !== "string" ||
      !isCanonicalDirectoryAlias(binding)
    )
      return undefined;
    aliases[alias] = binding;
  }
  const bindings: Record<string, DirectoryResolution> = {};
  for (const [binding, rawResolution] of Object.entries(rawBindings)) {
    const decoded = isCanonicalDirectoryAlias(binding)
      ? decodeResolution(binding, rawResolution)
      : undefined;
    if (decoded === undefined) return undefined;
    bindings[binding] = decoded;
  }
  if (!uniqueBindingIdentities(bindings)) return undefined;
  if (Object.values(aliases).some((binding) => bindings[binding] === undefined)) return undefined;
  if (Object.keys(rawInitializations).length !== Object.keys(bindings).length) return undefined;
  const initializations: Record<string, DirectoryOwnerVaultInitialization> = {};
  for (const [binding, rawInitialization] of Object.entries(rawInitializations)) {
    const decoded = isCanonicalDirectoryAlias(binding)
      ? decodeInitialization(rawInitialization)
      : undefined;
    const bound = bindings[binding];
    if (
      decoded === undefined ||
      bound === undefined ||
      decoded.ownerID !== bound.ownerID.value ||
      decoded.vaultID !== bound.vaultID.value ||
      decoded.generationEpoch !== bound.activeGeneration
    )
      return undefined;
    initializations[binding] = decoded;
  }
  const retiredAliases: Record<string, DirectoryRetiredAlias> = {};
  for (const [alias, rawRetired] of Object.entries(rawRetiredAliases)) {
    const decoded = decodeRetiredAlias(alias, rawRetired);
    if (
      decoded === undefined ||
      aliases[alias] !== undefined ||
      bindings[alias] !== undefined
    )
      return undefined;
    retiredAliases[alias] = decoded;
  }
  const replays: Record<string, DirectoryReplay> = {};
  for (const [key, rawReplay] of Object.entries(rawReplays)) {
    const decoded = jti.test(key) ? decodeReplay(rawReplay, bindings) : undefined;
    if (decoded === undefined) return undefined;
    replays[key] = decoded;
  }
  const transitions: Record<string, DirectoryCredentialTransition> = {};
  for (const [key, rawTransition] of Object.entries(rawTransitions)) {
    const decoded = operationID.test(key) ? decodeTransition(rawTransition) : undefined;
    if (decoded === undefined || decoded.operationID !== key) return undefined;
    transitions[key] = decoded;
  }
  const frozenBindings: Record<string, DirectoryFreeze> = {};
  for (const [binding, rawFreeze] of Object.entries(rawFrozenBindings)) {
    const decoded = isCanonicalDirectoryAlias(binding) ? decodeFreeze(rawFreeze) : undefined;
    if (decoded === undefined || transitions[decoded.operationID] === undefined) return undefined;
    frozenBindings[binding] = decoded;
  }
  if (
    !transitionsCollectivelyValid({
      aliases,
      bindings,
      transitions,
      frozenBindings,
      retiredAliases,
    })
  )
    return undefined;
  const controlReplays: Record<string, DirectoryControlReplay> = {};
  for (const [tokenJTI, rawReplay] of Object.entries(rawControlReplays)) {
    const decoded = jti.test(tokenJTI) ? decodeControlReplay(rawReplay) : undefined;
    if (decoded === undefined) return undefined;
    controlReplays[tokenJTI] = decoded;
  }
  return {
    aliases,
    bindings,
    replays,
    controlReplays,
    transitions,
    frozenBindings,
    retiredAliases,
    initializations,
  };
};

const encodeState = (value: DirectoryState): Readonly<Record<string, unknown>> | undefined => {
  if (Object.keys(value.controlReplays).length > maximumDirectoryControlReplays) return undefined;
  if (Object.keys(value.transitions).length > maximumDirectoryTransitions) return undefined;
  if (Object.keys(value.retiredAliases).length > maximumDirectoryRetiredAliases) return undefined;
  if (!uniqueBindingIdentities(value.bindings)) return undefined;
  if (Object.keys(value.initializations).length !== Object.keys(value.bindings).length)
    return undefined;
  const aliases: Record<string, string> = {};
  for (const [alias, binding] of Object.entries(value.aliases)) {
    if (
      !isCanonicalDirectoryAlias(alias) ||
      !isCanonicalDirectoryAlias(binding) ||
      value.bindings[binding] === undefined
    )
      return undefined;
    aliases[alias] = binding;
  }
  const bindings: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [binding, resolution] of Object.entries(value.bindings)) {
    const encoded = isCanonicalDirectoryAlias(binding)
      ? encodeResolution(binding, resolution)
      : undefined;
    if (encoded === undefined) return undefined;
    bindings[binding] = encoded;
  }
  const initializations: Record<string, DirectoryOwnerVaultInitialization> = {};
  for (const [binding, initialization] of Object.entries(value.initializations)) {
    const decoded = isCanonicalDirectoryAlias(binding)
      ? decodeInitialization(initialization)
      : undefined;
    const bound = value.bindings[binding];
    if (
      decoded === undefined ||
      bound === undefined ||
      decoded.ownerID !== bound.ownerID.value ||
      decoded.vaultID !== bound.vaultID.value ||
      decoded.generationEpoch !== bound.activeGeneration
    )
      return undefined;
    initializations[binding] = decoded;
  }
  const retiredAliases: Record<string, DirectoryRetiredAlias> = {};
  for (const [alias, retired] of Object.entries(value.retiredAliases)) {
    const decoded = decodeRetiredAlias(alias, retired);
    if (
      decoded === undefined ||
      aliases[alias] !== undefined ||
      bindings[alias] !== undefined
    )
      return undefined;
    retiredAliases[alias] = decoded;
  }
  const replays: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [key, replay] of Object.entries(value.replays)) {
    const matchedBinding = Object.entries(value.bindings).find(([, resolution]) =>
      sameResolution(resolution, replay.resolution),
    );
    const encodedResolution =
      jti.test(key) && matchedBinding !== undefined
        ? encodeResolution(matchedBinding[0], replay.resolution)
        : undefined;
    if (
      encodedResolution === undefined ||
      !/^[a-f0-9]{64}$/u.test(replay.fingerprint) ||
      !validReplayRetention(replay.expiresAt, replay.retainUntil)
    )
      return undefined;
    replays[key] = {
      fingerprint: replay.fingerprint,
      expiresAt: replay.expiresAt,
      retainUntil: replay.retainUntil,
      resolution: encodedResolution,
    };
  }
  const transitions: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [key, transition] of Object.entries(value.transitions)) {
    const encoded =
      operationID.test(key) && transition.operationID === key
        ? encodeTransition(transition)
        : undefined;
    if (encoded === undefined) return undefined;
    transitions[key] = encoded;
  }
  const frozenBindings: Record<string, DirectoryFreeze> = {};
  for (const [binding, freeze] of Object.entries(value.frozenBindings)) {
    if (
      !isCanonicalDirectoryAlias(binding) ||
      transitions[freeze.operationID] === undefined ||
      decodeFreeze(freeze) === undefined
    )
      return undefined;
    frozenBindings[binding] = freeze;
  }
  if (
    !transitionsCollectivelyValid({
      aliases: value.aliases,
      bindings: value.bindings,
      transitions: value.transitions,
      frozenBindings,
      retiredAliases: value.retiredAliases,
    })
  )
    return undefined;
  const controlReplays: Record<string, DirectoryControlReplay> = {};
  for (const [tokenJTI, replay] of Object.entries(value.controlReplays)) {
    if (!jti.test(tokenJTI) || decodeControlReplay(replay) === undefined) return undefined;
    controlReplays[tokenJTI] = replay;
  }
  return {
    aliases,
    bindings,
    replays,
    controlReplays,
    transitions,
    frozenBindings,
    retiredAliases,
    initializations,
  };
};

/**
 * Production DO repository. One singleton Directory DO owns this complete map,
 * so versioned aliases can converge before any per-owner routing occurs.
 */
export const makeDurableObjectDirectoryRepository = (
  storage: DurableObjectStorage,
): DirectoryRepository => {
  const transact = <A>(
    operation: (
      current: DirectoryState,
    ) => Effect.Effect<readonly [A, DirectoryState], DirectoryTransactionError>,
  ): Effect.Effect<A, DirectoryTransactionError | DirectoryRepositoryError> =>
    storage
      .transactionOutcome<A, DirectoryTransactionError>(transactionCodec, (transaction) =>
        Effect.flatMap(transaction.get(stateKey), (raw) => {
          const current = raw === undefined ? empty() : decodeState(raw);
          if (current === undefined)
            return Effect.fail(directoryTransactionError("repository_unavailable"));
          return Effect.flatMap(
            operation(current),
            ([value, next]): Effect.Effect<
              A,
              DirectoryTransactionError | DurableObjectBoundaryError
            > => {
              const encoded = encodeState(next);
              return encoded === undefined
                ? Effect.fail(directoryTransactionError("repository_unavailable"))
                : transaction.put(stateKey, encoded).pipe(Effect.as(value));
            },
          );
        }),
      )
      .pipe(
        Effect.flatMap((outcome) =>
          outcome._tag === "success" ? Effect.succeed(outcome.value) : Effect.fail(outcome.error),
        ),
        Effect.mapError((error) =>
          error._tag === "DirectoryTransactionError"
            ? error
            : new DirectoryRepositoryError({ reason: "unavailable" }),
        ),
      );
  return { transact };
};

/** Test seam whose Ref.modify mirrors one DO transaction and runs the same domain channel. */
export const makeInMemoryDirectoryRepository = Effect.gen(function* () {
  const state = yield* Ref.make<DirectoryState>(empty());
  const singleTransaction = yield* Effect.makeSemaphore(1);
  const repository: DirectoryRepository = {
    transact: (operation) =>
      singleTransaction.withPermits(1)(
        Effect.flatMap(Ref.get(state), (current) => {
          if (encodeState(current) === undefined)
            return Effect.fail(directoryTransactionError("repository_unavailable"));
          return Effect.flatMap(operation(current), ([value, next]) =>
            encodeState(next) === undefined
              ? Effect.fail(directoryTransactionError("repository_unavailable"))
              : Effect.as(Ref.set(state, next), value),
          );
        }),
      ),
  };
  return { repository, state, layer: Layer.succeed(DirectoryRepository, repository) };
});
