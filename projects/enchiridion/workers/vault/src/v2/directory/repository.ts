/** @enchiridion/effect-module */
import {
  type DurableObjectBoundaryError,
  type DurableObjectStorage,
  durableObjectTransactionDomainCodec,
} from "@enchiridion/runtime";
import { Context, Data, Effect, Layer, Ref, Schema } from "effect";
import { isOwnerID, isVaultID, ownerID, vaultID } from "../foundation/schemas";
import {
  isCanonicalDirectoryAlias,
  maximumDirectoryReplayRetentionSeconds,
  validDirectoryResolution,
} from "./invariants";
import type { DirectoryReplay, DirectoryResolution, DirectoryState } from "./types";

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
    | "repository_unavailable";
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

const empty = (): DirectoryState => ({ aliases: {}, bindings: {}, replays: {} });
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const epoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

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

const decodeState = (value: unknown): DirectoryState | undefined => {
  const source = record(value);
  if (source === undefined || !exact(source, ["aliases", "bindings", "replays"])) return undefined;
  const rawAliases = record(source.aliases);
  const rawBindings = record(source.bindings);
  const rawReplays = record(source.replays);
  if (rawAliases === undefined || rawBindings === undefined || rawReplays === undefined)
    return undefined;
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
  const replays: Record<string, DirectoryReplay> = {};
  for (const [key, rawReplay] of Object.entries(rawReplays)) {
    const decoded = jti.test(key) ? decodeReplay(rawReplay, bindings) : undefined;
    if (decoded === undefined) return undefined;
    replays[key] = decoded;
  }
  return { aliases, bindings, replays };
};

const encodeState = (value: DirectoryState): Readonly<Record<string, unknown>> | undefined => {
  if (!uniqueBindingIdentities(value.bindings)) return undefined;
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
  return { aliases, bindings, replays };
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
