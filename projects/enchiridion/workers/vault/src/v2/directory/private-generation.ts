/** @enchiridion/effect-module */
import { Context, Data, Effect } from "effect";
import { DirectoryControlCapabilityFactory, type DirectoryControlCapabilityFactory as DirectoryControlFactory } from "../foundation/crypto";
import { ownerID, vaultID } from "../foundation/schemas";
import {
  floorSyncDigest,
  initializationDigest,
  sameOwnerVaultFloorSyncAck,
  sameOwnerVaultInitializationAck,
  signOwnerVaultFloorSync,
  signOwnerVaultInitialization,
  type OwnerVaultFloorSyncClient,
  type OwnerVaultFloorSyncCommand,
  type OwnerVaultInitializationAck,
  type OwnerVaultInitializationClient,
  type OwnerVaultInitializationCommand,
} from "./lifecycle";
import { DirectoryRepository, directoryTransactionError, type DirectoryTransactionError } from "./repository";
import { maximumDirectoryPrivateGenerations } from "./invariants";
import type {
  DirectoryPrivateGeneration,
  DirectoryResolution,
  DirectorySecureRandom,
  DirectoryState,
} from "./types";

const operationID = /^[A-Za-z0-9_-]{16,128}$/u;
const maximumFloorReconciliations = 4;

export interface DirectoryPrivateGenerationSource {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
}

export class DirectoryPrivateGenerationError extends Data.TaggedError(
  "DirectoryPrivateGenerationError",
)<{
  readonly reason:
    | "floor_changed"
    | "initialization_unavailable"
    | "invalid_source"
    | "operation_conflict"
    | "root_unavailable"
    | "sync_unavailable";
}> {}

/** P06-05 consumes only this private target contract; promotion is intentionally absent. */
export interface DirectoryPrivateGenerationService {
  readonly prepare: (
    source: DirectoryPrivateGenerationSource,
    operation: string,
    nowSeconds: number,
  ) => Effect.Effect<DirectoryPrivateGeneration, DirectoryPrivateGenerationError>;
}

export const DirectoryPrivateGenerationService = Context.GenericTag<DirectoryPrivateGenerationService>(
  "@enchiridion/worker-vault/v2/directory/DirectoryPrivateGenerationService",
);

export interface DirectoryOwnerVaultPrivateGeneration {
  readonly initialization: OwnerVaultInitializationClient;
  readonly floors: OwnerVaultFloorSyncClient;
}

export const DirectoryOwnerVaultPrivateGeneration = Context.GenericTag<DirectoryOwnerVaultPrivateGeneration>(
  "@enchiridion/worker-vault/v2/directory/DirectoryOwnerVaultPrivateGeneration",
);

const validSource = (source: DirectoryPrivateGenerationSource): boolean =>
  ownerID(source.ownerID) !== undefined &&
  vaultID(source.vaultID) !== undefined &&
  source.ownerID !== source.vaultID &&
  Number.isSafeInteger(source.generationEpoch) && source.generationEpoch >= 1;

const sameRoot = (source: DirectoryPrivateGenerationSource, value: DirectoryResolution): boolean =>
  source.ownerID === value.ownerID.value &&
  source.vaultID === value.vaultID.value &&
  source.generationEpoch === value.activeGeneration;

const root = (
  state: DirectoryState,
  source: DirectoryPrivateGenerationSource,
): DirectoryResolution | undefined => {
  const matches = Object.values(state.bindings).filter((candidate) => sameRoot(source, candidate));
  return matches.length === 1 ? matches[0] : undefined;
};

const authoritativeRoot = (
  state: DirectoryState,
  target: DirectoryPrivateGeneration,
): DirectoryResolution | undefined => {
  const matches = Object.values(state.bindings).filter(
    (candidate) => candidate.ownerID.value === target.ownerID && candidate.vaultID.value === target.vaultID,
  );
  return matches.length === 1 ? matches[0] : undefined;
};

const targetGeneration = (state: DirectoryState, resolved: DirectoryResolution): number | undefined => {
  let generation = resolved.activeGeneration;
  for (const target of Object.values(state.privateGenerations)) {
    if (target.ownerID === resolved.ownerID.value && target.vaultID === resolved.vaultID.value)
      generation = Math.max(generation, target.generationEpoch);
  }
  return generation < Number.MAX_SAFE_INTEGER ? generation + 1 : undefined;
};

const transactionFailure = (error: DirectoryPrivateGenerationError): DirectoryTransactionError =>
  directoryTransactionError(
    error.reason === "operation_conflict" ? "operation_conflict" : "repository_unavailable",
  );

const fromTransaction = (error: unknown): DirectoryPrivateGenerationError =>
  error instanceof DirectoryPrivateGenerationError
    ? error
    : new DirectoryPrivateGenerationError({ reason: "root_unavailable" });

type Reservation =
  | { readonly _tag: "initialize"; readonly target: DirectoryPrivateGeneration }
  | { readonly _tag: "reconcile"; readonly target: DirectoryPrivateGeneration };

/**
 * Allocates a fresh private generation.  The transaction persists an exact
 * command before leaving Directory, so a failed RPC can only be retried with
 * the same target and command.  The source is used solely to find the root;
 * no source scope is copied into the target authority row.
 */
export const makeDirectoryPrivateGenerationService = (
  random: DirectorySecureRandom,
): Effect.Effect<
  DirectoryPrivateGenerationService,
  never,
  DirectoryRepository | DirectoryControlCapabilityFactory | DirectoryOwnerVaultPrivateGeneration
> =>
  Effect.gen(function* () {
    const repository = yield* DirectoryRepository;
    const controls = yield* DirectoryControlCapabilityFactory;
    const ownerVault = yield* DirectoryOwnerVaultPrivateGeneration;

    const prepare = (
      source: DirectoryPrivateGenerationSource,
      operation: string,
      nowSeconds: number,
    ): Effect.Effect<DirectoryPrivateGeneration, DirectoryPrivateGenerationError> => {
      if (!validSource(source) || !operationID.test(operation) || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
        return Effect.fail(new DirectoryPrivateGenerationError({ reason: "invalid_source" }));
      return random.identifier("owner-vault-initialization").pipe(
        Effect.mapError(() => new DirectoryPrivateGenerationError({ reason: "initialization_unavailable" })),
        Effect.flatMap((generatedInitializationOperation) =>
          repository.transact<Reservation>((state) =>
            Effect.suspend(() => {
              const existing = state.privateGenerations[operation];
              if (existing !== undefined) {
                if (
                  existing.ownerID !== source.ownerID || existing.vaultID !== source.vaultID ||
                  existing.generationEpoch <= source.generationEpoch
                ) return Effect.fail(transactionFailure(new DirectoryPrivateGenerationError({ reason: "operation_conflict" })));
                return Effect.succeed([{ _tag: existing.initialization.durableReceipt === undefined ? "initialize" : "reconcile", target: existing } as const, state] as const);
              }
              const resolved = root(state, source);
              const generationEpoch = resolved === undefined ? undefined : targetGeneration(state, resolved);
              if (Object.keys(state.privateGenerations).length >= maximumDirectoryPrivateGenerations)
                return Effect.fail(transactionFailure(new DirectoryPrivateGenerationError({ reason: "root_unavailable" })));
              if (resolved === undefined || generationEpoch === undefined)
                return Effect.fail(transactionFailure(new DirectoryPrivateGenerationError({ reason: "root_unavailable" })));
              const unsigned = {
                ownerID: resolved.ownerID.value,
                vaultID: resolved.vaultID.value,
                generationEpoch,
                operationID: generatedInitializationOperation,
                credentialEpoch: resolved.credentialEpoch,
                routingEpoch: resolved.routingEpoch,
                controlEpoch: resolved.controlEpoch,
              };
              const initialization: OwnerVaultInitializationCommand = {
                ...unsigned,
                initDigest: initializationDigest(unsigned),
              };
              const target: DirectoryPrivateGeneration = {
                operationID: operation,
                ownerID: resolved.ownerID.value,
                vaultID: resolved.vaultID.value,
                generationEpoch,
                phase: "PRIVATE_INITIALIZING",
                initialization,
                credentialEpoch: resolved.credentialEpoch,
                routingEpoch: resolved.routingEpoch,
                controlEpoch: resolved.controlEpoch,
              };
              return Effect.succeed([
                { _tag: "initialize" as const, target },
                { ...state, privateGenerations: { ...state.privateGenerations, [operation]: target } },
              ] as const);
            }),
          ).pipe(
            Effect.mapError(fromTransaction),
            Effect.flatMap((reservation) =>
              (reservation._tag === "initialize"
                ? signOwnerVaultInitialization(
                    controls.signer,
                    reservation.target.initialization,
                    reservation.target.initialization.operationID,
                    nowSeconds,
                  ).pipe(
                    Effect.flatMap((capability) => ownerVault.initialization.ensureInitialized(reservation.target.initialization, capability)),
                    Effect.mapError(() => new DirectoryPrivateGenerationError({ reason: "initialization_unavailable" })),
                    Effect.flatMap((ack) => persistInitializationAck(repository, reservation.target, ack)),
                  )
                : Effect.succeed(reservation.target)
              ).pipe(Effect.flatMap((target) => reconcile(repository, controls, ownerVault, random, operation, target, nowSeconds, 0))),
            ),
          ),
        ),
      );
    };
    return { prepare } satisfies DirectoryPrivateGenerationService;
  });

const persistInitializationAck = (
  repository: DirectoryRepository,
  target: DirectoryPrivateGeneration,
  ack: OwnerVaultInitializationAck,
): Effect.Effect<DirectoryPrivateGeneration, DirectoryPrivateGenerationError> =>
  repository.transact((state) =>
    Effect.suspend(() => {
      const current = state.privateGenerations[target.operationID];
      if (
        current === undefined ||
        current.phase !== "PRIVATE_INITIALIZING" ||
        current.initialization.durableReceipt !== undefined ||
        !sameOwnerVaultInitializationAck(current.initialization, ack)
      ) return Effect.fail(transactionFailure(new DirectoryPrivateGenerationError({ reason: "root_unavailable" })));
      const updated: DirectoryPrivateGeneration = {
        ...current,
        initialization: { ...current.initialization, durableReceipt: ack.durableReceipt },
      };
      return Effect.succeed([updated, { ...state, privateGenerations: { ...state.privateGenerations, [updated.operationID]: updated } }] as const);
    }),
  ).pipe(Effect.mapError(fromTransaction));

type Reconciliation =
  | { readonly _tag: "ready"; readonly target: DirectoryPrivateGeneration }
  | { readonly _tag: "sync"; readonly target: DirectoryPrivateGeneration; readonly command: OwnerVaultFloorSyncCommand };

const reconcile = (
  repository: DirectoryRepository,
  controls: DirectoryControlFactory,
  ownerVault: DirectoryOwnerVaultPrivateGeneration,
  random: DirectorySecureRandom,
  operation: string,
  target: DirectoryPrivateGeneration,
  nowSeconds: number,
  attempt: number,
): Effect.Effect<DirectoryPrivateGeneration, DirectoryPrivateGenerationError> => {
  if (attempt >= maximumFloorReconciliations)
    return Effect.fail(new DirectoryPrivateGenerationError({ reason: "floor_changed" }));
  return random.identifier("owner-vault-floor-sync").pipe(
    Effect.mapError(() => new DirectoryPrivateGenerationError({ reason: "sync_unavailable" })),
    Effect.flatMap((generatedOperation) =>
      repository.transact<Reconciliation>((state) =>
        Effect.suspend(() => {
          const current = state.privateGenerations[operation];
          const authoritative = current === undefined ? undefined : authoritativeRoot(state, current);
          if (current === undefined || authoritative === undefined || current.phase !== "PRIVATE_INITIALIZING" || current.initialization.durableReceipt === undefined)
            return Effect.fail(transactionFailure(new DirectoryPrivateGenerationError({ reason: "root_unavailable" })));
          if (
            authoritative.credentialEpoch < current.credentialEpoch ||
            authoritative.routingEpoch < current.routingEpoch ||
            authoritative.controlEpoch < current.controlEpoch
          ) return Effect.fail(transactionFailure(new DirectoryPrivateGenerationError({ reason: "root_unavailable" })));
          const currentFloors =
            authoritative.credentialEpoch === current.credentialEpoch &&
            authoritative.routingEpoch === current.routingEpoch &&
            authoritative.controlEpoch === current.controlEpoch;
          if (currentFloors) {
            const ready: DirectoryPrivateGeneration = { ...current, phase: "PRIVATE_READY" };
            return Effect.succeed<readonly [Reconciliation, DirectoryState]>([
              { _tag: "ready" as const, target: ready },
              { ...state, privateGenerations: { ...state.privateGenerations, [operation]: ready } },
            ] as const);
          }
          const existing = current.floorSync;
          const command =
            existing !== undefined && existing.durableReceipt === undefined
              ? existing
              : (() => {
                  const unsigned = {
                    ownerID: current.ownerID, vaultID: current.vaultID, generationEpoch: current.generationEpoch,
                    operationID: generatedOperation,
                    credentialEpoch: authoritative.credentialEpoch,
                    routingEpoch: authoritative.routingEpoch,
                    controlEpoch: authoritative.controlEpoch,
                  };
                  return { ...unsigned, floorSyncDigest: floorSyncDigest(unsigned) } satisfies OwnerVaultFloorSyncCommand;
                })();
          const updated = existing !== command
            ? { ...current, floorSync: command }
            : current;
          return Effect.succeed<readonly [Reconciliation, DirectoryState]>([
            { _tag: "sync" as const, target: updated, command },
            { ...state, privateGenerations: { ...state.privateGenerations, [operation]: updated } },
          ] as const);
        }),
      ).pipe(
        Effect.mapError(fromTransaction),
        Effect.flatMap((next) => {
          if (next._tag === "ready") return Effect.succeed(next.target);
          return signOwnerVaultFloorSync(controls.signer, next.command, next.command.operationID, nowSeconds).pipe(
            Effect.flatMap((capability) => ownerVault.floors.syncFloors(next.command, capability)),
            Effect.mapError(() => new DirectoryPrivateGenerationError({ reason: "sync_unavailable" })),
            Effect.flatMap((ack) =>
              repository.transact((state) =>
                Effect.suspend(() => {
                  const current = state.privateGenerations[operation];
                  if (
                    current === undefined || current.floorSync === undefined || current.floorSync.durableReceipt !== undefined ||
                    !sameOwnerVaultFloorSyncAck(current.floorSync, ack)
                  ) return Effect.fail(transactionFailure(new DirectoryPrivateGenerationError({ reason: "root_unavailable" })));
                  const updated: DirectoryPrivateGeneration = {
                    ...current,
                    credentialEpoch: ack.credentialEpoch,
                    routingEpoch: ack.routingEpoch,
                    controlEpoch: ack.controlEpoch,
                    floorSync: { ...current.floorSync, durableReceipt: ack.durableReceipt },
                  };
                  return Effect.succeed([updated, { ...state, privateGenerations: { ...state.privateGenerations, [operation]: updated } }] as const);
                }),
              ).pipe(Effect.mapError(fromTransaction)),
            ),
            Effect.flatMap((updated) => reconcile(repository, controls, ownerVault, random, operation, updated, nowSeconds, attempt + 1)),
          );
        }),
      ),
    ),
  );
};
