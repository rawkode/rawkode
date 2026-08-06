import { sha256Hex } from "@enchiridion/protocol";
/** @enchiridion/effect-module */
import {
  CapabilityAudience,
  CapabilityAuthority,
  CapabilityMethod,
  type CapabilityRequestBinding,
  P256Crypto,
} from "@enchiridion/runtime";
import { Context, Data, Effect } from "effect";
import { InternalCapabilityFactory } from "../foundation/crypto";
import { ownerID, vaultID } from "../foundation/schemas";
import {
  deriveDirectoryInitID,
  isCanonicalDirectoryAlias,
  maximumDirectoryReplayRetentionSeconds,
  validDirectoryResolution,
} from "./invariants";
import {
  DirectoryRepository,
  type DirectoryRepositoryError,
  type DirectoryTransactionError,
  directoryTransactionError,
} from "./repository";
import {
  type DirectoryInvocation,
  type DirectoryResolution,
  type DirectorySecureRandom,
  type DirectoryState,
  type DirectoryWireRequest,
  directoryCapabilityPath,
  directoryOperation,
} from "./types";

const digest = /^[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9._~-]{16,128}$/u;
const maxAliases = 3;
/** Bounded by the maximum concurrently live sixty-second capabilities, not historical requests. */
const maximumLiveReplays = 2_048;
/** Covers bounded transport retry and clock skew; it never extends capability authorization. */
export const defaultDirectoryReplayRetentionSeconds = 60;
export { maximumDirectoryReplayRetentionSeconds } from "./invariants";

export interface DirectoryReplayPolicy {
  readonly replayRetentionSeconds: number;
}

const validReplayPolicy = (value: DirectoryReplayPolicy): boolean =>
  Number.isSafeInteger(value.replayRetentionSeconds) &&
  value.replayRetentionSeconds >= 1 &&
  value.replayRetentionSeconds <= maximumDirectoryReplayRetentionSeconds;

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

/**
 * The only production identifier source. The runtime owns Web Crypto access;
 * this adapter adds a visible purpose prefix so Owner and Vault values cannot
 * be confused at a persistence or RPC boundary.
 */
export const makeDirectorySecureRandom = Effect.gen(function* () {
  const crypto = yield* P256Crypto;
  return {
    identifier: (purpose) =>
      crypto.random32().pipe(
        Effect.map((bytes) => `${purpose}-${base64url(bytes)}`),
        Effect.mapError(() => ({ _tag: "DirectoryRandomError" as const })),
      ),
  } satisfies DirectorySecureRandom;
});

export class DirectoryServiceError extends Data.TaggedError("DirectoryServiceError")<{
  readonly reason:
    | "invalid_invocation"
    | "capability_rejected"
    | "replay_conflict"
    | "replay_capacity"
    | "alias_conflict"
    | "random_unavailable"
    | "repository_unavailable";
}> {}

export interface DirectoryService {
  readonly resolveOrBootstrap: (
    invocation: DirectoryInvocation,
    nowSeconds: number,
  ) => Effect.Effect<DirectoryResolution, DirectoryServiceError>;
}

export const DirectoryService = Context.GenericTag<DirectoryService>(
  "@enchiridion/worker-vault/v2/directory/DirectoryService",
);

const canonicalRequest = (request: DirectoryWireRequest): string | undefined => {
  if (
    request.operation !== directoryOperation ||
    !Number.isSafeInteger(request.accessExpiresAt) ||
    request.accessExpiresAt < 1 ||
    !isCanonicalDirectoryAlias(request.currentAlias) ||
    request.aliases.length < 1 ||
    request.aliases.length > maxAliases ||
    request.aliases[0] !== request.currentAlias ||
    !request.aliases.every(isCanonicalDirectoryAlias) ||
    new Set(request.aliases).size !== request.aliases.length ||
    request.aliases.slice(1).some((value) => value === request.currentAlias)
  )
    return undefined;
  return JSON.stringify({
    accessExpiresAt: request.accessExpiresAt,
    aliases: request.aliases,
    currentAlias: request.currentAlias,
    operation: request.operation,
  });
};

export const directoryRequestFingerprint = (request: DirectoryWireRequest): string | undefined => {
  const canonical = canonicalRequest(request);
  return canonical === undefined ? undefined : digestText(canonical);
};

/** Protocol SHA-256 is deterministic, synchronous and shared with the native client generator. */
const digestText = (value: string): string => {
  return sha256Hex(new TextEncoder().encode(value));
};

const requestBinding = (bodySHA256: string): CapabilityRequestBinding => ({
  method: CapabilityMethod.POST,
  path: directoryCapabilityPath,
  canonicalQuery: "",
  bodySHA256,
});

const resolution = (
  bindingID: string,
  generatedOwnerID: string,
  generatedVaultID: string,
): DirectoryResolution | undefined => {
  const owner = ownerID(generatedOwnerID);
  const vault = vaultID(generatedVaultID);
  if (owner === undefined || vault === undefined) return undefined;
  const initID = deriveDirectoryInitID(bindingID);
  if (initID === undefined) return undefined;
  const created = {
    ownerID: owner,
    vaultID: vault,
    initID,
    generationEpoch: 1,
    activeGeneration: 1,
    routingEpoch: 1,
    credentialEpoch: 1,
  } satisfies DirectoryResolution;
  return validDirectoryResolution(bindingID, created) ? created : undefined;
};

const expected = {
  audience: CapabilityAudience.Directory,
  authority: CapabilityAuthority.Directory,
} as const;

const toTransaction = (error: DirectoryServiceError): DirectoryTransactionError =>
  directoryTransactionError(error.reason);

const fromRepository = (
  error: DirectoryRepositoryError | DirectoryTransactionError,
): DirectoryServiceError =>
  new DirectoryServiceError({
    reason: error.reason === "unavailable" ? "repository_unavailable" : error.reason,
  });

const retainUntil = (expiresAt: number, seconds: number): number | undefined =>
  Number.isSafeInteger(expiresAt) &&
  Number.isSafeInteger(seconds) &&
  expiresAt <= Number.MAX_SAFE_INTEGER - seconds
    ? expiresAt + seconds
    : undefined;

/**
 * The Entry layer must install the protocol SHA-256 binding before construction. This keeps all
 * crypto outside application modules; P06-02 replaces it with the typed entry composition.
 */
export const makeDirectoryService = (
  random: DirectorySecureRandom,
  replayPolicy: DirectoryReplayPolicy = {
    replayRetentionSeconds: defaultDirectoryReplayRetentionSeconds,
  },
): Effect.Effect<DirectoryService, never, DirectoryRepository | InternalCapabilityFactory> =>
  Effect.gen(function* () {
    const repository = yield* DirectoryRepository;
    const capabilities = yield* InternalCapabilityFactory;
    const resolveOrBootstrap = (
      invocation: DirectoryInvocation,
      nowSeconds: number,
    ): Effect.Effect<DirectoryResolution, DirectoryServiceError> => {
      if (!validReplayPolicy(replayPolicy))
        return Effect.fail(new DirectoryServiceError({ reason: "invalid_invocation" }));
      const bodySHA256 = directoryRequestFingerprint(invocation.request);
      if (
        bodySHA256 === undefined ||
        !digest.test(bodySHA256) ||
        !Number.isSafeInteger(nowSeconds) ||
        nowSeconds < 0
      )
        return Effect.fail(new DirectoryServiceError({ reason: "invalid_invocation" }));
      return capabilities.verifier
        .verify(invocation.capability, requestBinding(bodySHA256), expected, nowSeconds)
        .pipe(
          Effect.mapError(() => new DirectoryServiceError({ reason: "capability_rejected" })),
          Effect.flatMap((claims) => {
            if (
              claims.expiresAt !==
              Math.min(invocation.request.accessExpiresAt, claims.issuedAt + 60)
            )
              return Effect.fail(new DirectoryServiceError({ reason: "capability_rejected" }));
            return repository
              .transact((state) =>
                Effect.suspend(() => {
                  const retainedReplays = Object.fromEntries(
                    Object.entries(state.replays).filter(
                      ([, value]) => value.retainUntil > nowSeconds,
                    ),
                  );
                  const oldReplay = retainedReplays[claims.jti];
                  if (oldReplay !== undefined) {
                    if (oldReplay.fingerprint !== bodySHA256)
                      return Effect.fail(new DirectoryServiceError({ reason: "replay_conflict" }));
                    return Effect.succeed([
                      oldReplay.resolution,
                      { ...state, replays: retainedReplays },
                    ] as const);
                  }
                  if (Object.keys(retainedReplays).length >= maximumLiveReplays)
                    return Effect.fail(new DirectoryServiceError({ reason: "replay_capacity" }));
                  const aliases = invocation.request.aliases;
                  const targets = aliases
                    .map((value) => state.aliases[value])
                    .filter((value): value is string => value !== undefined);
                  if (new Set(targets).size > 1)
                    return Effect.fail(new DirectoryServiceError({ reason: "alias_conflict" }));
                  const bindingID = targets[0] ?? invocation.request.currentAlias;
                  const existing = state.bindings[bindingID];
                  if (existing !== undefined && !validDirectoryResolution(bindingID, existing))
                    return Effect.fail(
                      new DirectoryServiceError({ reason: "repository_unavailable" }),
                    );
                  const create =
                    existing === undefined
                      ? Effect.all([random.identifier("owner"), random.identifier("vault")]).pipe(
                          Effect.mapError(
                            () => new DirectoryServiceError({ reason: "random_unavailable" }),
                          ),
                        )
                      : Effect.succeed(undefined);
                  return Effect.flatMap(create, (generated) => {
                    const created =
                      existing ??
                      (generated === undefined
                        ? undefined
                        : resolution(bindingID, generated[0], generated[1]));
                    if (created === undefined)
                      return Effect.fail(
                        new DirectoryServiceError({ reason: "random_unavailable" }),
                      );
                    const replayRetainUntil = retainUntil(
                      claims.expiresAt,
                      replayPolicy.replayRetentionSeconds,
                    );
                    if (replayRetainUntil === undefined)
                      return Effect.fail(
                        new DirectoryServiceError({ reason: "capability_rejected" }),
                      );
                    const aliasesNext: Record<string, string> = { ...state.aliases };
                    for (const value of aliases) aliasesNext[value] = bindingID;
                    const next: DirectoryState = {
                      aliases: aliasesNext,
                      bindings:
                        existing === undefined
                          ? { ...state.bindings, [bindingID]: created }
                          : state.bindings,
                      replays: {
                        ...retainedReplays,
                        [claims.jti]: {
                          fingerprint: bodySHA256,
                          expiresAt: claims.expiresAt,
                          retainUntil: replayRetainUntil,
                          resolution: created,
                        },
                      },
                    };
                    return Effect.succeed([created, next] as const);
                  });
                }).pipe(Effect.mapError(toTransaction)),
              )
              .pipe(Effect.mapError(fromRepository));
          }),
        );
    };
    return { resolveOrBootstrap } satisfies DirectoryService;
  });
