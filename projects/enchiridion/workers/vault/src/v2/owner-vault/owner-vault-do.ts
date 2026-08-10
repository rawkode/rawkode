/** @enchiridion/effect-module */
import { parseJSONWithoutDuplicateMembers, sha256Hex } from "@enchiridion/protocol";
import {
  CapabilityMethod,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  DirectoryControlResource,
  makeDurableObjectBoundary,
  readBoundedRequestBody,
  type SignedCapability,
} from "@enchiridion/runtime";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import {
  ownerVaultFloorSyncPath,
  ownerVaultInitializationPath,
  type OwnerVaultFloorSyncAck,
  type OwnerVaultFloorSyncCommand,
  type OwnerVaultInitializationAck,
  type OwnerVaultInitializationCommand,
  validOwnerVaultFloorSyncCommand,
  validOwnerVaultInitializationCommand,
} from "../directory/lifecycle";
import type { DirectoryControlCapabilityFactory } from "../foundation/crypto";
import { makeOwnerVaultDomainProvider } from "./domains";
import {
  type OwnerVaultStorageTransactionFailure,
  makeDurableObjectOwnerVaultStorageRepository,
} from "./repository";

const maximumBodyBytes = 16_384;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const now = (): number => Math.floor(Date.now() / 1_000);
const response = (body: Readonly<Record<string, unknown>>, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bodyHash = (command: Readonly<Record<string, unknown>>): string =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(command)));
const durableReceipt = (kind: string, operationID: string, digest: string): string =>
  sha256Hex(new TextEncoder().encode(`${kind}\u0000${operationID}\u0000${digest}`));

interface ControlEnvelope<C> { readonly capability: SignedCapability; readonly command: C }
const decodeEnvelope = <C>(
  bytes: Uint8Array,
  validCommand: (value: C) => boolean,
): ControlEnvelope<C> | undefined => {
  try {
    const root = record(parseJSONWithoutDuplicateMembers(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (root === undefined || !exact(root, ["capability", "command"]) || typeof root.capability !== "string") return undefined;
    const command = record(root.command) as C | undefined;
    return command !== undefined && validCommand(command) ? { capability: { value: root.capability }, command } : undefined;
  } catch {
    return undefined;
  }
};
const commandIdentity = (command: OwnerVaultInitializationCommand | OwnerVaultFloorSyncCommand) => ({
  ownerID: command.ownerID,
  vaultID: command.vaultID,
  generationEpoch: command.generationEpoch,
  namespaceState: "PRIVATE" as const,
});
const initPayload = (command: OwnerVaultInitializationCommand, receipt: string) => ({
  initDigest: command.initDigest,
  credentialEpoch: command.credentialEpoch,
  routingEpoch: command.routingEpoch,
  controlEpoch: command.controlEpoch,
  durableReceipt: receipt,
});
const floorPayload = (command: OwnerVaultFloorSyncCommand, receipt: string) => ({
  floorSyncDigest: command.floorSyncDigest,
  credentialEpoch: command.credentialEpoch,
  routingEpoch: command.routingEpoch,
  controlEpoch: command.controlEpoch,
  durableReceipt: receipt,
});
const samePayload = (value: Readonly<Record<string, unknown>>, expected: Readonly<Record<string, unknown>>): boolean =>
  exact(value, Object.keys(expected)) && Object.entries(expected).every(([key, item]) => value[key] === item);
const rejectControl = <A = never>(): Effect.Effect<A, OwnerVaultStorageTransactionFailure> =>
  Effect.fail({ _tag: "OwnerVaultDomainTransactionError", reason: "replay_conflict" });
const samePrivateIdentity = (
  payload: Readonly<Record<string, unknown>>,
  command: OwnerVaultFloorSyncCommand,
): boolean =>
  exact(payload, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) &&
  payload.ownerID === command.ownerID && payload.vaultID === command.vaultID &&
  payload.generationEpoch === command.generationEpoch && payload.namespaceState === "PRIVATE";

export interface OwnerVaultDODependencies {
  readonly controls: DirectoryControlCapabilityFactory;
}
export type OwnerVaultDODependencyProvider = (env: unknown) => OwnerVaultDODependencies | undefined;
export type OwnerVaultDOConstructor = new (
  ctx: DurableObjectState,
  env: Readonly<Record<never, never>>,
) => DurableObject<Readonly<Record<never, never>>>;

/**
 * Fixed internal control surface for a single fresh OwnerVault generation.
 * Directory capability claims bind every byte-relevant field before a durable
 * transaction runs; this object exposes no legacy or general-purpose routes.
 */
export const makeOwnerVaultDO = (
  dependencies: OwnerVaultDODependencies | OwnerVaultDODependencyProvider,
): OwnerVaultDOConstructor => {
  class OwnerVaultV2 extends DurableObject<Readonly<Record<never, never>>> {
    private readonly boundary = makeDurableObjectBoundary(this.ctx);
    private readonly controls: DirectoryControlCapabilityFactory | undefined;
    constructor(ctx: DurableObjectState, env: Readonly<Record<never, never>>) {
      super(ctx, env);
      const resolved = typeof dependencies === "function" ? dependencies(env) : dependencies;
      this.controls = resolved?.controls;
    }

    private initialize = (envelope: ControlEnvelope<OwnerVaultInitializationCommand>): Effect.Effect<Response> => {
      const command = envelope.command;
      const binding = {
        resource: DirectoryControlResource.OwnerVaultInitialization,
        method: CapabilityMethod.POST,
        path: ownerVaultInitializationPath,
        canonicalQuery: "",
        bodySHA256: bodyHash(command as unknown as Readonly<Record<string, unknown>>),
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        initDigest: command.initDigest,
        controlEpoch: command.controlEpoch,
      } as const;
      const expected = {
        audience: DirectoryControlCapabilityAudience.DirectoryControl,
        authority: DirectoryControlCapabilityAuthority.DirectoryControl,
        resource: DirectoryControlResource.OwnerVaultInitialization,
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        credentialEpoch: command.credentialEpoch,
        generationEpoch: command.generationEpoch,
        routingEpoch: command.routingEpoch,
        controlEpoch: command.controlEpoch,
        operationID: command.operationID,
      } as const;
      if (this.controls === undefined) return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return this.controls.verifier.verify(envelope.capability, binding, expected, now()).pipe(
        Effect.flatMap(() => {
          const provider = makeOwnerVaultDomainProvider(repository, commandIdentity(command));
          const payload = initPayload(command, durableReceipt("init", command.operationID, command.initDigest));
          return provider.initialize().pipe(
            Effect.zipRight(repository.transact((tx) => tx.get({ category: "control.initialization-ack", identifier: command.operationID }).pipe(
              Effect.flatMap((existing) => {
                if (existing !== undefined)
                  return samePayload(existing.payload, payload)
                    ? Effect.succeed(payload.durableReceipt)
                    : rejectControl();
                return tx.put({ category: "control.initialization-ack", identifier: command.operationID }, payload)
                  .pipe(Effect.as(payload.durableReceipt));
              }),
            ))),
            Effect.map((receipt): Response => response({ ...command, durableReceipt: receipt } satisfies OwnerVaultInitializationAck)),
          );
        }),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private syncFloors = (envelope: ControlEnvelope<OwnerVaultFloorSyncCommand>): Effect.Effect<Response> => {
      const command = envelope.command;
      const binding = {
        resource: DirectoryControlResource.OwnerVaultFloorSync,
        method: CapabilityMethod.POST,
        path: ownerVaultFloorSyncPath,
        canonicalQuery: "",
        bodySHA256: bodyHash(command as unknown as Readonly<Record<string, unknown>>),
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        floorSyncDigest: command.floorSyncDigest,
        controlEpoch: command.controlEpoch,
      } as const;
      const expected = {
        audience: DirectoryControlCapabilityAudience.DirectoryControl,
        authority: DirectoryControlCapabilityAuthority.DirectoryControl,
        resource: DirectoryControlResource.OwnerVaultFloorSync,
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        credentialEpoch: command.credentialEpoch,
        generationEpoch: command.generationEpoch,
        routingEpoch: command.routingEpoch,
        controlEpoch: command.controlEpoch,
        operationID: command.operationID,
      } as const;
      if (this.controls === undefined) return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return this.controls.verifier.verify(envelope.capability, binding, expected, now()).pipe(
        Effect.flatMap(() => repository.transact((tx) => {
          const payload = floorPayload(command, durableReceipt("floor", command.operationID, command.floorSyncDigest));
          return tx.get({ category: "root.identity" }).pipe(
            Effect.flatMap((identity) =>
              identity === undefined || !samePrivateIdentity(identity.payload, command)
                ? rejectControl()
                : tx.get({ category: "control.floor-sync", identifier: command.operationID }),
            ),
            Effect.flatMap((existing) => {
              if (existing !== undefined)
                return samePayload(existing.payload, payload)
                  ? Effect.succeed(payload.durableReceipt)
                  : rejectControl();
              return tx.get({ category: "control.floor-sync", identifier: "current" }).pipe(
                Effect.flatMap((current) => {
                  if (current !== undefined) {
                    const prior = current.payload;
                    if (
                      typeof prior.credentialEpoch !== "number" || typeof prior.routingEpoch !== "number" ||
                      typeof prior.controlEpoch !== "number" || command.credentialEpoch < prior.credentialEpoch ||
                      command.routingEpoch < prior.routingEpoch || command.controlEpoch < prior.controlEpoch
                    ) return rejectControl();
                  }
                  return tx.put({ category: "control.floor-sync", identifier: command.operationID }, payload).pipe(
                    Effect.zipRight(tx.put({ category: "control.floor-sync", identifier: "current" }, payload)),
                    Effect.as(payload.durableReceipt),
                  );
                }),
              );
            }),
          );
        })),
        Effect.map((receipt): Response => response({ ...command, durableReceipt: receipt } satisfies OwnerVaultFloorSyncAck)),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private readonly effectHandler = (request: Request): Effect.Effect<Response> =>
      Effect.try({ try: () => ({ method: request.method, pathname: new URL(request.url).pathname }), catch: () => undefined }).pipe(
        Effect.flatMap((route) => {
          if (route?.method !== "POST") return Effect.succeed(response({ ok: false }, 404));
          return readBoundedRequestBody(request, { maximumBytes: maximumBodyBytes, requiredContentType: "application/json" }).pipe(
            Effect.flatMap((bytes) => {
              if (route.pathname === ownerVaultInitializationPath) {
                const envelope = decodeEnvelope(bytes, validOwnerVaultInitializationCommand);
                return envelope === undefined ? Effect.succeed(response({ ok: false }, 400)) : this.initialize(envelope);
              }
              if (route.pathname === ownerVaultFloorSyncPath) {
                const envelope = decodeEnvelope(bytes, validOwnerVaultFloorSyncCommand);
                return envelope === undefined ? Effect.succeed(response({ ok: false }, 400)) : this.syncFloors(envelope);
              }
              return Effect.succeed(response({ ok: false }, 404));
            }),
          );
        }),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 400))),
      );
    override readonly fetch = (request: Request): Promise<Response> =>
      this.boundary.callbacks.fetch(this.effectHandler(request));
  }
  return OwnerVaultV2;
};
