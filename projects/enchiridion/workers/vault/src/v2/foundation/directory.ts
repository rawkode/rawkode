/** @enchiridion/effect-module */
import { Context, Data, Effect, Schedule } from "effect";
import { VaultV2Config } from "./config";
import { type CredentialBindingDigest, isCredentialBindingDigest } from "./crypto";
import { VaultV2Metrics } from "./metrics";
import {
  CredentialDirectoryRepository,
  type CredentialRecord,
  type DirectoryRecord,
} from "./repositories";
import {
  type CredentialID,
  type DirectoryIdentity,
  type RequestID,
  isCredentialID,
  isRequestID,
  validDirectoryIdentity,
} from "./schemas";

export interface EnsureInitializedRequest extends DirectoryIdentity {
  readonly bindingDigest: CredentialBindingDigest;
}
export interface EnsureInitializedResponse extends DirectoryIdentity {
  readonly status: "ACTIVE";
}

export class CredentialDirectoryError extends Data.TaggedError("CredentialDirectoryError")<{
  readonly reason:
    | "identity_conflict"
    | "quota_exceeded"
    | "transition_conflict"
    | "invalid_identity";
}> {}

export interface OwnerVaultInitializer {
  readonly ensureInitialized: (input: {
    readonly initID: string;
    readonly identity: DirectoryIdentity;
  }) => Effect.Effect<boolean, CredentialDirectoryError>;
}
export const OwnerVaultInitializer = Context.GenericTag<OwnerVaultInitializer>(
  "@enchiridion/worker-vault/v2/OwnerVaultInitializer",
);

export interface CredentialDirectory {
  /** Idempotent, retry-safe initialization RPC; never changes existing identity/generation. */
  readonly ensureInitialized: (
    request: EnsureInitializedRequest,
  ) => Effect.Effect<EnsureInitializedResponse, CredentialDirectoryError>;
  readonly enrollCredential: (
    request: EnsureInitializedRequest,
    credentialID: CredentialID,
  ) => Effect.Effect<CredentialRecord, CredentialDirectoryError>;
  readonly revokeCredential: (
    bindingDigest: CredentialBindingDigest,
    credentialID: CredentialID,
    requestID: RequestID,
  ) => Effect.Effect<CredentialRecord, CredentialDirectoryError>;
}

export const CredentialDirectory = Context.GenericTag<CredentialDirectory>(
  "@enchiridion/worker-vault/v2/CredentialDirectory",
);

const sameIdentity = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.ownerID.value === right.ownerID.value &&
  left.vaultID.value === right.vaultID.value &&
  left.generationEpoch === right.generationEpoch;

const active = (record: DirectoryRecord): EnsureInitializedResponse => ({
  ownerID: record.ownerID,
  vaultID: record.vaultID,
  generationEpoch: record.generationEpoch,
  status: "ACTIVE",
});

const initializing = (request: EnsureInitializedRequest): DirectoryRecord => ({
  ...request,
  initID: `init-${request.bindingDigest.value}`,
  initializerConfirmed: false,
  revision: 0,
  status: "INITIALIZING",
  credentials: {},
});

const activate = (record: DirectoryRecord): DirectoryRecord => ({
  ...record,
  revision: record.revision + 1,
  status: "ACTIVE",
});

export const makeCredentialDirectory = Effect.gen(function* () {
  const repository = yield* CredentialDirectoryRepository;
  const config = yield* VaultV2Config;
  const metrics = yield* VaultV2Metrics;
  const initializer = yield* OwnerVaultInitializer;

  const ensureInitialized = (
    request: EnsureInitializedRequest,
  ): Effect.Effect<EnsureInitializedResponse, CredentialDirectoryError> => {
    if (!validDirectoryIdentity(request) || !isCredentialBindingDigest(request.bindingDigest))
      return Effect.fail(new CredentialDirectoryError({ reason: "invalid_identity" }));
    const transition = Effect.gen(function* () {
      const current = yield* repository.read(request.bindingDigest);
      if (current === undefined) {
        const created = initializing(request);
        const claimed = yield* repository.compareAndSet(request.bindingDigest, undefined, created);
        if (!claimed)
          return yield* Effect.fail(
            new CredentialDirectoryError({ reason: "transition_conflict" }),
          );
        const confirmed = yield* initializer.ensureInitialized({
          initID: created.initID,
          identity: request,
        });
        if (!confirmed)
          return yield* Effect.fail(
            new CredentialDirectoryError({ reason: "transition_conflict" }),
          );
        const activated = activate({ ...created, initializerConfirmed: true });
        const committed = yield* repository.compareAndSet(
          request.bindingDigest,
          created.revision,
          activated,
        );
        if (!committed)
          return yield* Effect.fail(
            new CredentialDirectoryError({ reason: "transition_conflict" }),
          );
        yield* metrics.increment("directory.initialized");
        return active(activated);
      }
      if (!sameIdentity(current, request))
        return yield* Effect.fail(new CredentialDirectoryError({ reason: "identity_conflict" }));
      if (current.status === "ACTIVE") return active(current);
      const confirmed = yield* initializer.ensureInitialized({
        initID: current.initID,
        identity: request,
      });
      if (!confirmed)
        return yield* Effect.fail(new CredentialDirectoryError({ reason: "transition_conflict" }));
      const activated = activate({ ...current, initializerConfirmed: true });
      const committed = yield* repository.compareAndSet(
        request.bindingDigest,
        current.revision,
        activated,
      );
      if (!committed)
        return yield* Effect.fail(new CredentialDirectoryError({ reason: "transition_conflict" }));
      yield* metrics.increment("directory.retry");
      return active(activated);
    });
    return transition.pipe(
      Effect.retry({
        schedule: Schedule.recurs(4),
        while: (error) => error.reason === "transition_conflict",
      }),
    );
  };

  const enrollCredential = (
    request: EnsureInitializedRequest,
    credentialID: CredentialID,
  ): Effect.Effect<CredentialRecord, CredentialDirectoryError> =>
    Effect.flatMap(ensureInitialized(request), () =>
      Effect.gen(function* () {
        if (!isCredentialID(credentialID))
          return yield* Effect.fail(new CredentialDirectoryError({ reason: "invalid_identity" }));
        const current = yield* repository.read(request.bindingDigest);
        if (current === undefined || current.status !== "ACTIVE")
          return yield* Effect.fail(
            new CredentialDirectoryError({ reason: "transition_conflict" }),
          );
        const existing = current.credentials[credentialID.value];
        if (existing !== undefined) return existing;
        if (Object.keys(current.credentials).length >= config.credentialQuota)
          return yield* Effect.fail(new CredentialDirectoryError({ reason: "quota_exceeded" }));
        const credential: CredentialRecord = {
          credentialID,
          credentialEpoch: 1,
          routingEpoch: 1,
          revoked: false,
        };
        const next: DirectoryRecord = {
          ...current,
          revision: current.revision + 1,
          credentials: { ...current.credentials, [credentialID.value]: credential },
        };
        const committed = yield* repository.compareAndSet(
          request.bindingDigest,
          current.revision,
          next,
        );
        if (!committed)
          return yield* Effect.fail(
            new CredentialDirectoryError({ reason: "transition_conflict" }),
          );
        return credential;
      }),
    ).pipe(
      Effect.retry({
        schedule: Schedule.recurs(4),
        while: (error) => error.reason === "transition_conflict",
      }),
    );

  const revokeCredential = (
    bindingDigest: CredentialBindingDigest,
    credentialID: CredentialID,
    requestID: RequestID,
  ): Effect.Effect<CredentialRecord, CredentialDirectoryError> =>
    Effect.gen(function* () {
      if (!isCredentialBindingDigest(bindingDigest) || !isCredentialID(credentialID))
        return yield* Effect.fail(new CredentialDirectoryError({ reason: "invalid_identity" }));
      if (!isRequestID(requestID))
        return yield* Effect.fail(new CredentialDirectoryError({ reason: "invalid_identity" }));
      const current = yield* repository.read(bindingDigest);
      if (current === undefined || current.status !== "ACTIVE")
        return yield* Effect.fail(new CredentialDirectoryError({ reason: "transition_conflict" }));
      const credential = current.credentials[credentialID.value];
      if (credential === undefined)
        return yield* Effect.fail(new CredentialDirectoryError({ reason: "identity_conflict" }));
      if (credential.revoked)
        return credential.revocationRequestID === requestID.value
          ? credential
          : yield* Effect.fail(new CredentialDirectoryError({ reason: "transition_conflict" }));
      const revoked: CredentialRecord = {
        ...credential,
        credentialEpoch: credential.credentialEpoch + 1,
        routingEpoch: credential.routingEpoch + 1,
        revoked: true,
        revocationRequestID: requestID.value,
      };
      const committed = yield* repository.compareAndSet(bindingDigest, current.revision, {
        ...current,
        revision: current.revision + 1,
        credentials: { ...current.credentials, [credentialID.value]: revoked },
      });
      if (!committed)
        return yield* Effect.fail(new CredentialDirectoryError({ reason: "transition_conflict" }));
      return revoked;
    }).pipe(
      Effect.retry({
        schedule: Schedule.recurs(4),
        while: (error) => error.reason === "transition_conflict",
      }),
    );

  return { ensureInitialized, enrollCredential, revokeCredential } satisfies CredentialDirectory;
});
