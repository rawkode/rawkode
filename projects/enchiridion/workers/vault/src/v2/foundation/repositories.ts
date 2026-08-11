/** @enchiridion/effect-module */
import { Context, Effect, Layer, Ref } from "effect";
import {
  type CredentialBindingDigest,
  isCredentialBindingDigest,
  isCredentialBindingDigestWireValue,
} from "./crypto";
import {
  type CredentialID,
  type DirectoryIdentity,
  credentialID,
  isCredentialID,
  isOwnerID,
  isVaultID,
  ownerID,
  requestID,
  validDirectoryIdentity,
  vaultID,
} from "./schemas";

export type DirectoryStatus = "INITIALIZING" | "ACTIVE";

export interface CredentialRecord {
  readonly credentialID: CredentialID;
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
  readonly revoked: boolean;
  readonly revocationRequestID?: string;
}

export interface DirectoryRecord extends DirectoryIdentity {
  readonly bindingDigest: CredentialBindingDigest;
  readonly initID: string;
  readonly initializerConfirmed: boolean;
  /** Storage compare-and-set revision; distinct from immutable vault generation. */
  readonly revision: number;
  readonly status: DirectoryStatus;
  readonly credentials: Readonly<Record<string, CredentialRecord>>;
}

export class DirectoryRepositoryError extends Error {
  readonly _tag = "DirectoryRepositoryError";
  constructor(readonly reason: "conflict" | "not_found" | "invalid_transition") {
    super(reason);
  }
}

export interface CredentialDirectoryRepository {
  readonly read: (
    bindingDigest: CredentialBindingDigest,
  ) => Effect.Effect<DirectoryRecord | undefined>;
  readonly compareAndSet: (
    bindingDigest: CredentialBindingDigest,
    expectedRevision: number | undefined,
    next: unknown,
  ) => Effect.Effect<boolean>;
}

export const CredentialDirectoryRepository = Context.GenericTag<CredentialDirectoryRepository>(
  "@enchiridion/worker-vault/v2/CredentialDirectoryRepository",
);

type UnknownRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown): UnknownRecord | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key),
    )
  )
    return undefined;
  return Object.fromEntries(Object.entries(value));
};

const exactly = (value: UnknownRecord, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const safeIntegerAtLeast = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

const decodeCredentialRecord = (key: string, value: unknown): CredentialRecord | undefined => {
  const source = record(value);
  if (source === undefined) return undefined;
  const revoked = source.revoked;
  if (typeof revoked !== "boolean") return undefined;
  const keys = revoked
    ? ["credentialID", "credentialEpoch", "routingEpoch", "revoked", "revocationRequestID"]
    : ["credentialID", "credentialEpoch", "routingEpoch", "revoked"];
  if (!exactly(source, keys)) return undefined;
  const parsedCredentialID = credentialID(source.credentialID);
  if (
    parsedCredentialID === undefined ||
    parsedCredentialID.value !== key ||
    !safeIntegerAtLeast(source.credentialEpoch, 1) ||
    !safeIntegerAtLeast(source.routingEpoch, 1)
  )
    return undefined;
  if (!revoked)
    return {
      credentialID: parsedCredentialID,
      credentialEpoch: source.credentialEpoch,
      routingEpoch: source.routingEpoch,
      revoked,
    };
  const parsedRequestID = requestID(source.revocationRequestID);
  if (parsedRequestID === undefined) return undefined;
  return {
    credentialID: parsedCredentialID,
    credentialEpoch: source.credentialEpoch,
    routingEpoch: source.routingEpoch,
    revoked,
    revocationRequestID: parsedRequestID.value,
  };
};

/**
 * The sole persistence rehydration boundary. It accepts wire strings only after validating every
 * field and invariant, then retains the caller's authenticated lookup token. Raw persistence
 * never mints digest authority, even when its text has the canonical wire shape.
 */
const decodeDirectoryRecord = (
  lookupDigest: CredentialBindingDigest,
  value: unknown,
): DirectoryRecord | undefined => {
  const key = lookupDigest.value;
  const source = record(value);
  if (
    source === undefined ||
    !exactly(source, [
      "ownerID",
      "vaultID",
      "generationEpoch",
      "bindingDigest",
      "initID",
      "initializerConfirmed",
      "revision",
      "status",
      "credentials",
    ]) ||
    typeof source.initID !== "string" ||
    typeof source.initializerConfirmed !== "boolean" ||
    !safeIntegerAtLeast(source.generationEpoch, 0) ||
    !safeIntegerAtLeast(source.revision, 0) ||
    (source.status !== "INITIALIZING" && source.status !== "ACTIVE")
  )
    return undefined;
  if (
    (source.status === "INITIALIZING" && source.initializerConfirmed) ||
    (source.status === "ACTIVE" && !source.initializerConfirmed)
  )
    return undefined;
  const parsedOwnerID = ownerID(source.ownerID);
  const parsedVaultID = vaultID(source.vaultID);
  const rawCredentials = record(source.credentials);
  if (
    parsedOwnerID === undefined ||
    parsedVaultID === undefined ||
    !isCredentialBindingDigestWireValue(source.bindingDigest) ||
    source.bindingDigest !== key ||
    source.initID !== `init-${key}` ||
    rawCredentials === undefined
  )
    return undefined;
  const credentials: Record<string, CredentialRecord> = {};
  for (const [credentialKey, rawCredential] of Object.entries(rawCredentials)) {
    const decoded = decodeCredentialRecord(credentialKey, rawCredential);
    if (decoded === undefined) return undefined;
    credentials[credentialKey] = decoded;
  }
  const identity: DirectoryIdentity = {
    ownerID: parsedOwnerID,
    vaultID: parsedVaultID,
    generationEpoch: source.generationEpoch,
  };
  if (!validDirectoryIdentity(identity)) return undefined;
  return {
    ...identity,
    bindingDigest: lookupDigest,
    initID: source.initID,
    initializerConfirmed: source.initializerConfirmed,
    revision: source.revision,
    status: source.status,
    credentials,
  };
};

const encodeCredentialRecord = (value: CredentialRecord): UnknownRecord | undefined => {
  if (
    !isCredentialID(value.credentialID) ||
    !safeIntegerAtLeast(value.credentialEpoch, 1) ||
    !safeIntegerAtLeast(value.routingEpoch, 1)
  )
    return undefined;
  if (!value.revoked)
    return {
      credentialID: value.credentialID.value,
      credentialEpoch: value.credentialEpoch,
      routingEpoch: value.routingEpoch,
      revoked: false,
    };
  const parsedRequestID = requestID(value.revocationRequestID);
  if (parsedRequestID === undefined) return undefined;
  return {
    credentialID: value.credentialID.value,
    credentialEpoch: value.credentialEpoch,
    routingEpoch: value.routingEpoch,
    revoked: true,
    revocationRequestID: parsedRequestID.value,
  };
};

/**
 * Strict CAS input decoder. Unlike the storage encoder, it refuses extra or coerced properties;
 * callers cannot smuggle data through a typed `DirectoryRecord` annotation and have it dropped.
 */
const decodeNextCredentialRecord = (key: string, value: unknown): CredentialRecord | undefined => {
  const source = record(value);
  if (source === undefined || typeof source.revoked !== "boolean") return undefined;
  const keys = source.revoked
    ? ["credentialID", "credentialEpoch", "routingEpoch", "revoked", "revocationRequestID"]
    : ["credentialID", "credentialEpoch", "routingEpoch", "revoked"];
  if (
    !exactly(source, keys) ||
    !isCredentialID(source.credentialID) ||
    source.credentialID.value !== key ||
    !safeIntegerAtLeast(source.credentialEpoch, 1) ||
    !safeIntegerAtLeast(source.routingEpoch, 1)
  )
    return undefined;
  if (!source.revoked)
    return {
      credentialID: source.credentialID,
      credentialEpoch: source.credentialEpoch,
      routingEpoch: source.routingEpoch,
      revoked: false,
    };
  if (
    typeof source.revocationRequestID !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(source.revocationRequestID)
  )
    return undefined;
  return {
    credentialID: source.credentialID,
    credentialEpoch: source.credentialEpoch,
    routingEpoch: source.routingEpoch,
    revoked: true,
    revocationRequestID: source.revocationRequestID,
  };
};

const decodeNextDirectoryRecord = (
  key: CredentialBindingDigest,
  value: unknown,
): DirectoryRecord | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    !exactly(source, [
      "ownerID",
      "vaultID",
      "generationEpoch",
      "bindingDigest",
      "initID",
      "initializerConfirmed",
      "revision",
      "status",
      "credentials",
    ]) ||
    !isOwnerID(source.ownerID) ||
    !isVaultID(source.vaultID) ||
    !isCredentialBindingDigest(source.bindingDigest) ||
    source.bindingDigest.value !== key.value ||
    typeof source.initID !== "string" ||
    source.initID !== `init-${key.value}` ||
    typeof source.initializerConfirmed !== "boolean" ||
    !safeIntegerAtLeast(source.generationEpoch, 0) ||
    !safeIntegerAtLeast(source.revision, 0) ||
    (source.status !== "INITIALIZING" && source.status !== "ACTIVE") ||
    (source.status === "INITIALIZING" && source.initializerConfirmed) ||
    (source.status === "ACTIVE" && !source.initializerConfirmed)
  )
    return undefined;
  const rawCredentials = record(source.credentials);
  if (rawCredentials === undefined) return undefined;
  const credentials: Record<string, CredentialRecord> = {};
  for (const [credentialKey, rawCredential] of Object.entries(rawCredentials)) {
    const credential = decodeNextCredentialRecord(credentialKey, rawCredential);
    if (credential === undefined) return undefined;
    credentials[credentialKey] = credential;
  }
  const identity: DirectoryIdentity = {
    ownerID: source.ownerID,
    vaultID: source.vaultID,
    generationEpoch: source.generationEpoch,
  };
  if (!validDirectoryIdentity(identity)) return undefined;
  return {
    ...identity,
    bindingDigest: source.bindingDigest,
    initID: source.initID,
    initializerConfirmed: source.initializerConfirmed,
    revision: source.revision,
    status: source.status,
    credentials,
  };
};

const encodeDirectoryRecord = (
  key: CredentialBindingDigest,
  value: DirectoryRecord,
): UnknownRecord | undefined => {
  if (
    !isCredentialBindingDigest(key) ||
    !isCredentialBindingDigest(value.bindingDigest) ||
    value.bindingDigest.value !== key.value ||
    !validDirectoryIdentity(value) ||
    value.initID !== `init-${key.value}` ||
    !safeIntegerAtLeast(value.revision, 0) ||
    (value.status !== "INITIALIZING" && value.status !== "ACTIVE") ||
    (value.status === "INITIALIZING" && value.initializerConfirmed) ||
    (value.status === "ACTIVE" && !value.initializerConfirmed)
  )
    return undefined;
  const credentials: Record<string, UnknownRecord> = {};
  for (const [credentialKey, credential] of Object.entries(value.credentials)) {
    const encoded = encodeCredentialRecord(credential);
    if (encoded === undefined || credential.credentialID.value !== credentialKey) return undefined;
    credentials[credentialKey] = encoded;
  }
  return {
    ownerID: value.ownerID.value,
    vaultID: value.vaultID.value,
    generationEpoch: value.generationEpoch,
    bindingDigest: value.bindingDigest.value,
    initID: value.initID,
    initializerConfirmed: value.initializerConfirmed,
    revision: value.revision,
    status: value.status,
    credentials,
  };
};

export const makeInMemoryCredentialDirectoryRepository = Effect.gen(function* () {
  /** Raw serializable state intentionally exercises the same trusted decode boundary as durable storage. */
  const state = yield* Ref.make<Readonly<Record<string, unknown>>>({});
  const repository: CredentialDirectoryRepository = {
    read: (bindingDigest) =>
      Effect.map(Ref.get(state), (all) => {
        if (!isCredentialBindingDigest(bindingDigest)) return undefined;
        const value = all[bindingDigest.value];
        return value === undefined ? undefined : decodeDirectoryRecord(bindingDigest, value);
      }),
    compareAndSet: (bindingDigest, expectedRevision, next) =>
      Ref.modify(state, (current) => {
        const validated = isCredentialBindingDigest(bindingDigest)
          ? decodeNextDirectoryRecord(bindingDigest, next)
          : undefined;
        const encoded =
          validated === undefined ? undefined : encodeDirectoryRecord(bindingDigest, validated);
        if (encoded === undefined) return [false, current] as const;
        const rawCurrent = current[bindingDigest.value];
        const existing =
          rawCurrent === undefined ? undefined : decodeDirectoryRecord(bindingDigest, rawCurrent);
        if (rawCurrent !== undefined && existing === undefined) return [false, current] as const;
        const matches =
          existing === undefined
            ? expectedRevision === undefined
            : existing.revision === expectedRevision;
        return [
          matches,
          matches ? { ...current, [bindingDigest.value]: encoded } : current,
        ] as const;
      }),
  };
  return { repository, state, layer: Layer.succeed(CredentialDirectoryRepository, repository) };
});
