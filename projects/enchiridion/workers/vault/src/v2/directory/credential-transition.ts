/** @enchiridion/effect-module */
import { sha256Hex } from "@enchiridion/protocol";
import {
  CapabilityMethod,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  DirectoryControlResource,
  type SignedCapability,
} from "@enchiridion/runtime";
import { Context, Data, Effect } from "effect";
import { DirectoryControlCapabilityFactory } from "../foundation/crypto";
import {
  deriveDirectoryInitID,
  isCanonicalDirectoryAlias,
  maximumDirectoryControlReplays,
  maximumDirectoryRetiredAliases,
  maximumDirectoryTransitions,
  validDirectoryResolution,
} from "./invariants";
import {
  DirectoryRepository,
  type DirectoryTransactionError,
  directoryTransactionError,
} from "./repository";
import type {
  DirectoryCredentialTransition,
  DirectoryCredentialTransitionResult,
  DirectoryOwnerFenceAck,
  DirectoryOwnerFenceRequest,
  DirectoryResolution,
  DirectoryRetiredAlias,
  DirectoryState,
  DirectoryTransitionRequest,
} from "./types";

const operationID = /^[A-Za-z0-9_-]{16,128}$/u;
const authorityID = /^[A-Za-z0-9._~-]{16,128}$/u;
const defaultRetentionSeconds = 300;
const authorizationReceiptSeconds = 60;

export class DirectoryCredentialTransitionError extends Data.TaggedError(
  "DirectoryCredentialTransitionError",
)<{
  readonly reason:
    | "invalid_request"
    | "authority_rejected"
    | "operation_conflict"
    | "operation_capacity"
    | "binding_unavailable"
    | "binding_frozen"
    | "alias_conflict"
    | "owner_rejected"
    | "owner_ack_mismatch"
    | "repository_unavailable";
}> {}

/** P06-03 supplies the provider; Directory deliberately cannot infer authority from Access claims. */
export interface DirectoryTransitionAuthorizer {
  readonly authorize: (
    request: DirectoryTransitionRequest,
    nowSeconds: number,
  ) => Effect.Effect<void, DirectoryCredentialTransitionError>;
}
export const DirectoryTransitionAuthorizer = Context.GenericTag<DirectoryTransitionAuthorizer>(
  "@enchiridion/worker-vault/v2/directory/DirectoryTransitionAuthorizer",
);

/** Internal-only restart authority. P06-03/04 must bind this to a capability for this exact journal. */
const directoryTransitionResumePath = "/v2/internal/directory/credential-transition/resume";
const resumeBinding = (transition: DirectoryCredentialTransition) => ({
  resource: DirectoryControlResource.CredentialTransition,
  method: CapabilityMethod.POST,
  path: directoryTransitionResumePath,
  canonicalQuery: "",
  bodySHA256: digest(JSON.stringify({ operationID: transition.operationID })),
  ownerID: transition.expected.ownerID.value,
  vaultID: transition.expected.vaultID.value,
});
const resumeExpectation = (transition: DirectoryCredentialTransition) => ({
  audience: DirectoryControlCapabilityAudience.DirectoryControl,
  authority: DirectoryControlCapabilityAuthority.DirectoryControl,
  resource: DirectoryControlResource.CredentialTransition,
  ownerID: transition.expected.ownerID.value,
  vaultID: transition.expected.vaultID.value,
  credentialEpoch: transition.expected.credentialEpoch,
  generationEpoch: transition.expected.activeGeneration,
  routingEpoch: transition.expected.routingEpoch,
  operationID: transition.operationID,
});

/** Internal DO control capability. It is not an HTTP wire route. */
export interface OwnerVaultCredentialFence {
  readonly fenceCredentialEpoch: (
    request: DirectoryOwnerFenceRequest,
  ) => Effect.Effect<DirectoryOwnerFenceAck, DirectoryCredentialTransitionError>;
}
export const OwnerVaultCredentialFence = Context.GenericTag<OwnerVaultCredentialFence>(
  "@enchiridion/worker-vault/v2/directory/OwnerVaultCredentialFence",
);

export interface DirectoryCredentialTransitionService {
  readonly execute: (
    request: DirectoryTransitionRequest,
    nowSeconds: number,
  ) => Effect.Effect<DirectoryCredentialTransitionResult, DirectoryCredentialTransitionError>;
  /** Restart/retry entrypoint: no untrusted identity or request data participates. */
  readonly resume: (
    operationID: string,
    capability: SignedCapability,
    nowSeconds: number,
  ) => Effect.Effect<DirectoryCredentialTransitionResult, DirectoryCredentialTransitionError>;
}
export const DirectoryCredentialTransitionService =
  Context.GenericTag<DirectoryCredentialTransitionService>(
    "@enchiridion/worker-vault/v2/directory/DirectoryCredentialTransitionService",
  );

const digest = (source: string): string => sha256Hex(new TextEncoder().encode(source));
const sameResolution = (left: DirectoryResolution, right: DirectoryResolution): boolean =>
  left.ownerID.value === right.ownerID.value &&
  left.vaultID.value === right.vaultID.value &&
  left.initID === right.initID &&
  left.generationEpoch === right.generationEpoch &&
  left.activeGeneration === right.activeGeneration &&
  left.routingEpoch === right.routingEpoch &&
  left.credentialEpoch === right.credentialEpoch;
const nextEpoch = (value: number): number | undefined =>
  Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER ? value + 1 : undefined;
const validAuthority = (authority: DirectoryTransitionRequest["authority"]): boolean =>
  authority._tag === "registered_device"
    ? authorityID.test(authority.deviceID) && authorityID.test(authority.proofID)
    : authority._tag === "offline_recovery" && authorityID.test(authority.recoveryID);
const replacement = (request: DirectoryTransitionRequest): readonly string[] | undefined => {
  if (request.kind === "revoke") return [];
  const aliases = request.replacementAliases;
  return aliases.length >= 1 &&
    aliases.length <= 3 &&
    aliases.every(isCanonicalDirectoryAlias) &&
    new Set(aliases).size === aliases.length &&
    !aliases.includes(request.bindingID)
    ? aliases
    : undefined;
};
export const directoryTransitionFingerprint = (
  request: DirectoryTransitionRequest,
): string | undefined => {
  const aliases = replacement(request);
  if (
    aliases === undefined ||
    !operationID.test(request.operationID) ||
    !isCanonicalDirectoryAlias(request.bindingID) ||
    !validDirectoryResolution(request.bindingID, request.expected) ||
    !validAuthority(request.authority)
  )
    return undefined;
  const authority =
    request.authority._tag === "registered_device"
      ? {
          _tag: request.authority._tag,
          deviceID: request.authority.deviceID,
          proofID: request.authority.proofID,
        }
      : { _tag: request.authority._tag, recoveryID: request.authority.recoveryID };
  return digest(
    JSON.stringify({
      authority,
      bindingID: request.bindingID,
      expected: request.expected,
      kind: request.kind,
      operationID: request.operationID,
      replacementAliases: aliases,
    }),
  );
};
const error = (reason: DirectoryCredentialTransitionError["reason"]) =>
  new DirectoryCredentialTransitionError({ reason });
const transactionError = (
  reason: DirectoryCredentialTransitionError["reason"],
): DirectoryTransactionError =>
  directoryTransactionError(
    reason === "operation_conflict" ||
      reason === "operation_capacity" ||
      reason === "binding_unavailable" ||
      reason === "binding_frozen" ||
      reason === "alias_conflict" ||
      reason === "owner_ack_mismatch" ||
      reason === "repository_unavailable"
      ? reason
      : "invalid_invocation",
  );

const fromTransaction = (
  reason: DirectoryTransactionError["reason"] | "unavailable",
): DirectoryCredentialTransitionError =>
  error(
    reason === "operation_conflict" ||
      reason === "operation_capacity" ||
      reason === "binding_unavailable" ||
      reason === "binding_frozen" ||
      reason === "alias_conflict" ||
      reason === "owner_ack_mismatch"
      ? reason
      : reason === "invalid_invocation"
        ? "invalid_request"
        : "repository_unavailable",
  );

const requestFor = (transition: DirectoryCredentialTransition): DirectoryOwnerFenceRequest => ({
  ownerID: transition.expected.ownerID.value,
  vaultID: transition.expected.vaultID.value,
  generation: transition.expected.activeGeneration,
  operationID: transition.operationID,
  expectedCredentialEpoch: transition.expected.credentialEpoch,
  expectedRoutingEpoch: transition.expected.routingEpoch,
});
const validAck = (
  transition: DirectoryCredentialTransition,
  ack: DirectoryOwnerFenceAck,
): boolean => {
  const expected = requestFor(transition);
  return (
    ack.ownerID === expected.ownerID &&
    ack.vaultID === expected.vaultID &&
    ack.generation === expected.generation &&
    ack.operationID === expected.operationID &&
    ack.expectedCredentialEpoch === expected.expectedCredentialEpoch &&
    ack.expectedRoutingEpoch === expected.expectedRoutingEpoch &&
    ack.credentialEpoch === transition.freeze.credentialEpochFloor &&
    ack.routingEpoch === transition.freeze.routingEpochFloor &&
    ack.admissionsStopped &&
    ack.socketsFenced
  );
};
const sameAck = (left: DirectoryOwnerFenceAck, right: DirectoryOwnerFenceAck): boolean =>
  left.ownerID === right.ownerID &&
  left.vaultID === right.vaultID &&
  left.generation === right.generation &&
  left.operationID === right.operationID &&
  left.expectedCredentialEpoch === right.expectedCredentialEpoch &&
  left.expectedRoutingEpoch === right.expectedRoutingEpoch &&
  left.credentialEpoch === right.credentialEpoch &&
  left.routingEpoch === right.routingEpoch &&
  left.admissionsStopped === right.admissionsStopped &&
  left.socketsFenced === right.socketsFenced;

const result = (
  transition: DirectoryCredentialTransition,
): DirectoryCredentialTransitionResult | undefined => transition.result;

/** Source aliases retained by a rebind are live replacement authority, not retirement evidence. */
const retiredAliasesFor = (transition: DirectoryCredentialTransition): readonly string[] =>
  [...new Set([...transition.sourceAliases, transition.bindingID])]
    .filter((alias) => !transition.replacementAliases.includes(alias))
    .sort();

export const makeDirectoryCredentialTransitionService = Effect.gen(function* () {
  const repository = yield* DirectoryRepository;
  const authorizer = yield* DirectoryTransitionAuthorizer;
  const resumeCapabilities = yield* DirectoryControlCapabilityFactory;
  const owner = yield* OwnerVaultCredentialFence;
  const retainedTransitions = (state: DirectoryState, nowSeconds: number) =>
    Object.fromEntries(
      Object.entries(state.transitions).filter(
        ([, value]) => value.phase !== "COMPLETED" || value.retainUntil > nowSeconds,
      ),
    );
  const load = (id: string, nowSeconds: number, requestFingerprint?: string) =>
    repository
      .transact((state) =>
        Effect.suspend(() => {
          const transitions = retainedTransitions(state, nowSeconds);
          const transition = transitions[id];
          if (
            transition !== undefined &&
            requestFingerprint !== undefined &&
            transition.fingerprint !== requestFingerprint
          )
            return Effect.fail(transactionError("operation_conflict"));
          return Effect.succeed([transition, { ...state, transitions }] as const);
        }),
      )
      .pipe(Effect.mapError((failure) => fromTransaction(failure.reason)));
  const claimControlReplay = (
    transition: DirectoryCredentialTransition,
    capability: SignedCapability,
    jti: string,
    expiresAt: number,
    nowSeconds: number,
  ) =>
    repository
      .transact((state) =>
        Effect.suspend(() => {
          const retained = Object.fromEntries(
            Object.entries(state.controlReplays).filter(
              ([, replay]) => replay.retainUntil > nowSeconds,
            ),
          );
          const tokenFingerprint = digest(capability.value);
          const existing = retained[jti];
          if (existing !== undefined) {
            if (
              existing.operationID !== transition.operationID ||
              existing.fingerprint !== tokenFingerprint
            )
              return Effect.fail(transactionError("operation_conflict"));
            return Effect.succeed([undefined, { ...state, controlReplays: retained }] as const);
          }
          if (Object.keys(retained).length >= maximumDirectoryControlReplays)
            return Effect.fail(transactionError("operation_capacity"));
          const retainUntil = expiresAt + defaultRetentionSeconds;
          if (!Number.isSafeInteger(retainUntil))
            return Effect.fail(transactionError("invalid_request"));
          return Effect.succeed([
            undefined,
            {
              ...state,
              controlReplays: {
                ...retained,
                [jti]: {
                  operationID: transition.operationID,
                  fingerprint: tokenFingerprint,
                  expiresAt,
                  retainUntil,
                },
              },
            },
          ] as const);
        }),
      )
      .pipe(Effect.mapError((failure) => fromTransaction(failure.reason)));
  const prepare = (
    request: DirectoryTransitionRequest,
    nowSeconds: number,
    requestFingerprint: string,
  ) =>
    repository
      .transact((state) =>
        Effect.suspend(() => {
          const retained = retainedTransitions(state, nowSeconds);
          const existing = retained[request.operationID];
          if (existing !== undefined) {
            if (existing.fingerprint !== requestFingerprint)
              return Effect.fail(transactionError("operation_conflict"));
            return Effect.succeed([existing, { ...state, transitions: retained }] as const);
          }
          if (Object.keys(retained).length >= maximumDirectoryTransitions)
            return Effect.fail(transactionError("operation_capacity"));
          const current = state.bindings[request.bindingID];
          if (current === undefined || !sameResolution(current, request.expected))
            return Effect.fail(transactionError("binding_unavailable"));
          if (state.frozenBindings[request.bindingID] !== undefined)
            return Effect.fail(transactionError("binding_frozen"));
          const aliases = replacement(request);
          if (aliases === undefined) return Effect.fail(transactionError("invalid_request"));
          if (
            request.kind === "rebind" &&
            aliases.some(
              (alias) =>
                (state.aliases[alias] !== undefined &&
                  state.aliases[alias] !== request.bindingID) ||
                state.bindings[alias] !== undefined ||
                state.retiredAliases[alias] !== undefined ||
                Object.values(retained).some(
                  (transition) =>
                    transition.phase !== "COMPLETED" &&
                    transition.kind === "rebind" &&
                    transition.replacementAliases.includes(alias),
                ),
            )
          )
            return Effect.fail(transactionError("alias_conflict"));
          const sourceAliases = Object.entries(state.aliases)
            .filter(([, target]) => target === request.bindingID)
            .map(([alias]) => alias)
            .sort();
          const retirementCount = new Set(
            [...sourceAliases, request.bindingID].filter((alias) => !aliases.includes(alias)),
          ).size;
          // Tombstones are permanent. Refuse before freezing or contacting OwnerVault so the
          // transition cannot strand a live binding once the lifetime directory quota is full.
          if (
            Object.keys(state.retiredAliases).length + retirementCount >
            maximumDirectoryRetiredAliases
          )
            return Effect.fail(transactionError("operation_capacity"));
          const credentialEpochFloor = nextEpoch(current.credentialEpoch);
          const routingEpochFloor = nextEpoch(current.routingEpoch);
          const expiresAt = nowSeconds + authorizationReceiptSeconds;
          const retainUntil = expiresAt + defaultRetentionSeconds;
          if (
            credentialEpochFloor === undefined ||
            routingEpochFloor === undefined ||
            !Number.isSafeInteger(expiresAt) ||
            !Number.isSafeInteger(retainUntil)
          )
            return Effect.fail(transactionError("invalid_request"));
          const transition: DirectoryCredentialTransition = {
            operationID: request.operationID,
            fingerprint: requestFingerprint,
            kind: request.kind,
            bindingID: request.bindingID,
            expected: current,
            sourceAliases,
            replacementAliases: aliases,
            phase: "PREPARED",
            freeze: { operationID: request.operationID, credentialEpochFloor, routingEpochFloor },
            createdAt: nowSeconds,
            expiresAt,
            retainUntil,
          };
          return Effect.succeed([
            transition,
            {
              ...state,
              transitions: { ...retained, [request.operationID]: transition },
              frozenBindings: { ...state.frozenBindings, [request.bindingID]: transition.freeze },
            },
          ] as const);
        }),
      )
      .pipe(Effect.mapError((failure) => fromTransaction(failure.reason)));
  const advanceFrozen = (transition: DirectoryCredentialTransition) =>
    repository
      .transact((state) =>
        Effect.suspend(() => {
          const current = state.transitions[transition.operationID];
          if (current === undefined || current.fingerprint !== transition.fingerprint)
            return Effect.fail(transactionError("binding_unavailable"));
          const next =
            current.phase === "PREPARED" ? { ...current, phase: "FROZEN" as const } : current;
          return Effect.succeed([
            next,
            { ...state, transitions: { ...state.transitions, [next.operationID]: next } },
          ] as const);
        }),
      )
      .pipe(Effect.mapError((failure) => fromTransaction(failure.reason)));
  const recordAck = (transition: DirectoryCredentialTransition, ack: DirectoryOwnerFenceAck) =>
    repository
      .transact((state) =>
        Effect.suspend(() => {
          const current = state.transitions[transition.operationID];
          if (current === undefined || !validAck(current, ack))
            return Effect.fail(transactionError("owner_ack_mismatch"));
          if (current.ownerAck !== undefined) {
            if (
              !sameAck(current.ownerAck, ack) ||
              (current.phase !== "OWNER_ACKED" &&
                current.phase !== "DIRECTORY_CAS" &&
                current.phase !== "COMPLETED")
            )
              return Effect.fail(transactionError("owner_ack_mismatch"));
            return Effect.succeed([current, state] as const);
          }
          if (current.phase !== "FROZEN")
            return Effect.fail(transactionError("owner_ack_mismatch"));
          const next: DirectoryCredentialTransition = {
            ...current,
            phase: "OWNER_ACKED",
            ownerAck: ack,
          };
          return Effect.succeed([
            next,
            { ...state, transitions: { ...state.transitions, [next.operationID]: next } },
          ] as const);
        }),
      )
      .pipe(Effect.mapError((failure) => fromTransaction(failure.reason)));
  const cas = (transition: DirectoryCredentialTransition) =>
    repository
      .transact((state) =>
        Effect.suspend(() => {
          const current = state.transitions[transition.operationID];
          if (
            current === undefined ||
            current.ownerAck === undefined ||
            !validAck(current, current.ownerAck)
          )
            return Effect.fail(transactionError("owner_ack_mismatch"));
          if (current.phase === "DIRECTORY_CAS" || current.phase === "COMPLETED")
            return Effect.succeed([current, state] as const);
          if (current.phase !== "OWNER_ACKED")
            return Effect.fail(transactionError("owner_ack_mismatch"));
          const actual = state.bindings[current.bindingID];
          if (actual === undefined || !sameResolution(actual, current.expected))
            return Effect.fail(transactionError("binding_unavailable"));
          const credentialEpoch = current.ownerAck.credentialEpoch;
          const routingEpoch = current.ownerAck.routingEpoch;
          let bindings: Record<string, DirectoryResolution> = { ...state.bindings };
          let aliases: Record<string, string> = { ...state.aliases };
          let replacementBindingID: string | undefined;
          const retiredAliases: Record<string, DirectoryRetiredAlias> = {
            ...state.retiredAliases,
          };
          if (current.kind === "revoke") {
            bindings = Object.fromEntries(
              Object.entries(bindings).filter(([key]) => key !== current.bindingID),
            );
            aliases = Object.fromEntries(
              Object.entries(aliases).filter(([, value]) => value !== current.bindingID),
            );
          } else {
            replacementBindingID = current.replacementAliases[0];
            if (replacementBindingID === undefined)
              return Effect.fail(transactionError("alias_conflict"));
            if (state.retiredAliases[replacementBindingID] !== undefined)
              return Effect.fail(transactionError("alias_conflict"));
            const initID = deriveDirectoryInitID(replacementBindingID);
            if (initID === undefined) return Effect.fail(transactionError("alias_conflict"));
            const rebound: DirectoryResolution = {
              ...actual,
              initID,
              routingEpoch,
              credentialEpoch,
            };
            if (!validDirectoryResolution(replacementBindingID, rebound))
              return Effect.fail(transactionError("alias_conflict"));
            bindings = {
              ...Object.fromEntries(
                Object.entries(bindings).filter(([key]) => key !== current.bindingID),
              ),
              [replacementBindingID]: rebound,
            };
            aliases = Object.fromEntries(
              Object.entries(aliases).filter(([, value]) => value !== current.bindingID),
            );
            for (const alias of current.replacementAliases) aliases[alias] = replacementBindingID;
          }
          const transitionResult: DirectoryCredentialTransitionResult = {
            operationID: current.operationID,
            kind: current.kind,
            bindingID: current.bindingID,
            credentialEpoch,
            routingEpoch,
            ...(replacementBindingID === undefined ? {} : { replacementBindingID }),
          };
          for (const alias of retiredAliasesFor(current)) {
            if (retiredAliases[alias] !== undefined)
              return Effect.fail(transactionError("repository_unavailable"));
            retiredAliases[alias] = {
              bindingID: current.bindingID,
              operationID: current.operationID,
              ownerID: current.expected.ownerID.value,
              vaultID: current.expected.vaultID.value,
              reason: current.kind,
              retiredAt: current.createdAt,
              activeGeneration: current.expected.activeGeneration,
              credentialEpoch,
              routingEpoch,
            };
          }
          const next: DirectoryCredentialTransition = {
            ...current,
            phase: "DIRECTORY_CAS",
            result: transitionResult,
          };
          return Effect.succeed([
            next,
            {
              ...state,
              bindings,
              aliases,
              transitions: { ...state.transitions, [next.operationID]: next },
              retiredAliases,
            },
          ] as const);
        }),
      )
      .pipe(Effect.mapError((failure) => fromTransaction(failure.reason)));
  const complete = (transition: DirectoryCredentialTransition) =>
    repository
      .transact((state) =>
        Effect.suspend(() => {
          const current = state.transitions[transition.operationID];
          if (current === undefined || current.result === undefined)
            return Effect.fail(transactionError("binding_unavailable"));
          if (current.phase === "COMPLETED")
            return Effect.succeed([current.result, state] as const);
          if (current.phase !== "DIRECTORY_CAS")
            return Effect.fail(transactionError("binding_unavailable"));
          const transitionResult = current.result;
          const next: DirectoryCredentialTransition = { ...current, phase: "COMPLETED" };
          const frozenBindings = Object.fromEntries(
            Object.entries(state.frozenBindings).filter(
              ([, freeze]) => freeze.operationID !== next.operationID,
            ),
          );
          return Effect.succeed([
            transitionResult,
            {
              ...state,
              transitions: { ...state.transitions, [next.operationID]: next },
              frozenBindings,
            },
          ] as const);
        }),
      )
      .pipe(Effect.mapError((failure) => fromTransaction(failure.reason)));
  const drive = (
    initial: DirectoryCredentialTransition,
  ): Effect.Effect<DirectoryCredentialTransitionResult, DirectoryCredentialTransitionError> =>
    Effect.gen(function* () {
      let current = initial;
      if (current.phase === "COMPLETED")
        return result(current) ?? (yield* Effect.fail(error("repository_unavailable")));
      if (current.phase === "PREPARED") current = yield* advanceFrozen(current);
      if (current.phase === "FROZEN") {
        const ack = yield* owner
          .fenceCredentialEpoch(requestFor(current))
          .pipe(Effect.mapError(() => error("owner_rejected")));
        current = yield* recordAck(current, ack);
      }
      if (current.phase === "COMPLETED")
        return result(current) ?? (yield* Effect.fail(error("repository_unavailable")));
      if (current.phase === "OWNER_ACKED") current = yield* cas(current);
      if (current.phase === "DIRECTORY_CAS") return yield* complete(current);
      if (current.phase === "COMPLETED")
        return result(current) ?? (yield* Effect.fail(error("repository_unavailable")));
      return yield* Effect.fail(error("repository_unavailable"));
    });
  return {
    execute: (request, nowSeconds) => {
      const requestFingerprint = directoryTransitionFingerprint(request);
      if (requestFingerprint === undefined || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
        return Effect.fail(error("invalid_request"));
      return load(request.operationID, nowSeconds, requestFingerprint).pipe(
        Effect.flatMap((existing) =>
          existing !== undefined
            ? existing.phase === "COMPLETED"
              ? drive(existing)
              : existing.expiresAt <= nowSeconds
                ? authorizer
                    .authorize(request, nowSeconds)
                    .pipe(Effect.flatMap(() => drive(existing)))
                : drive(existing)
            : authorizer.authorize(request, nowSeconds).pipe(
                Effect.flatMap(() => prepare(request, nowSeconds, requestFingerprint)),
                Effect.flatMap(drive),
              ),
        ),
      );
    },
    resume: (id, capability, nowSeconds) =>
      !operationID.test(id) || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0
        ? Effect.fail(error("invalid_request"))
        : load(id, nowSeconds).pipe(
            Effect.flatMap((transition) =>
              transition === undefined
                ? Effect.fail(error("binding_unavailable"))
                : resumeCapabilities.verifier
                    .verify(
                      capability,
                      resumeBinding(transition),
                      resumeExpectation(transition),
                      nowSeconds,
                    )
                    .pipe(Effect.mapError(() => error("authority_rejected")))
                    .pipe(
                      Effect.flatMap((claims) =>
                        claimControlReplay(
                          transition,
                          capability,
                          claims.jti,
                          claims.expiresAt,
                          nowSeconds,
                        ),
                      ),
                      Effect.flatMap(() => drive(transition)),
                    ),
            ),
          ),
  } satisfies DirectoryCredentialTransitionService;
});
