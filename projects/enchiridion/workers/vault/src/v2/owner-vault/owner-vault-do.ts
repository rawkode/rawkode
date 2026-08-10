import { DurableObject } from "cloudflare:workers";
/** @enchiridion/effect-module */
import { parseJSONWithoutDuplicateMembers, sha256Hex } from "@enchiridion/protocol";
import {
  CapabilityMethod,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  DirectoryControlResource,
  OwnerVaultDirectoryControlResource,
  type SignedCapability,
  type SignedOwnerVaultDirectoryControl,
  makeDurableObjectBoundary,
  ownerVaultCredentialFencePath,
  ownerVaultPrivateInitializePath,
  ownerVaultRestorePath,
  ownerVaultSnapshotPath,
  readBoundedRequestBody,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import {
  type OwnerVaultFloorSyncAck,
  type OwnerVaultFloorSyncCommand,
  type OwnerVaultInitializationAck,
  type OwnerVaultInitializationCommand,
  ownerVaultFloorSyncPath,
  ownerVaultInitializationPath,
  validOwnerVaultFloorSyncCommand,
  validOwnerVaultInitializationCommand,
} from "../directory/lifecycle";
import type { OwnerVaultDirectoryControlFactory } from "../entry/composition";
import type { OwnerVaultProductionAuthority } from "../entry/owner-vault-production";
import type { DirectoryControlCapabilityFactory } from "../foundation/crypto";
import { restoreOwnerVaultBackup } from "./backup";
import { OwnerVaultBackupError } from "./backup-types";
import { makeOwnerVaultDomainProvider } from "./domains";
import { makeOwnerVaultProviderGraph } from "./provider-graph";
import {
  type OwnerVaultStorageTransactionFailure,
  makeDurableObjectOwnerVaultStorageRepository,
} from "./repository";

const maximumBodyBytes = 16_384;
const controlMaximumBodyBytes = 32_768;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const now = (): number => Math.floor(Date.now() / 1_000);
const response = (body: Readonly<Record<string, unknown>>, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const bodyHash = (command: Readonly<Record<string, unknown>>): string =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(command)));
const durableReceipt = (kind: string, operationID: string, digest: string): string =>
  sha256Hex(new TextEncoder().encode(`${kind}\u0000${operationID}\u0000${digest}`));
const privateRestoreLink = (
  command: Pick<
    OwnerVaultPrivateInitializeCommand | OwnerVaultRestoreCommand,
    | "sourceGeneration"
    | "targetGeneration"
    | "allocationID"
    | "initID"
    | "backupID"
    | "manifestDigest"
  >,
): string =>
  sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        sourceGeneration: command.sourceGeneration,
        targetGeneration: command.targetGeneration,
        allocationID: command.allocationID,
        initID: command.initID,
        backupID: command.backupID,
        manifestDigest: command.manifestDigest,
      }),
    ),
  );

interface ControlEnvelope<C> {
  readonly capability: SignedCapability;
  readonly command: C;
}
interface OwnerVaultControlEnvelope<C> {
  readonly capability: SignedOwnerVaultDirectoryControl;
  readonly command: C;
}
const decodeEnvelope = <C>(
  bytes: Uint8Array,
  validCommand: (value: C) => boolean,
): ControlEnvelope<C> | undefined => {
  try {
    const root = record(
      parseJSONWithoutDuplicateMembers(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      root === undefined ||
      !exact(root, ["capability", "command"]) ||
      typeof root.capability !== "string"
    )
      return undefined;
    const command = record(root.command) as C | undefined;
    return command !== undefined && validCommand(command)
      ? { capability: { value: root.capability }, command }
      : undefined;
  } catch {
    return undefined;
  }
};
const decodeOwnerVaultControlEnvelope = <C extends Readonly<Record<string, unknown>>>(
  bytes: Uint8Array,
  validCommand: (value: Readonly<Record<string, unknown>>) => value is C,
): OwnerVaultControlEnvelope<C> | undefined => {
  try {
    const root = record(
      parseJSONWithoutDuplicateMembers(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      root === undefined ||
      !exact(root, ["capability", "command"]) ||
      typeof root.capability !== "string"
    )
      return undefined;
    const command = record(root.command);
    return command !== undefined && validCommand(command)
      ? { capability: { value: root.capability }, command }
      : undefined;
  } catch {
    return undefined;
  }
};
const commandIdentity = (
  command: OwnerVaultInitializationCommand | OwnerVaultFloorSyncCommand,
) => ({
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
const samePayload = (
  value: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean =>
  exact(value, Object.keys(expected)) &&
  Object.entries(expected).every(([key, item]) => value[key] === item);
const rejectControl = <A = never>(): Effect.Effect<A, OwnerVaultStorageTransactionFailure> =>
  Effect.fail({ _tag: "OwnerVaultDomainTransactionError", reason: "replay_conflict" });
const samePrivateIdentity = (
  payload: Readonly<Record<string, unknown>>,
  command: OwnerVaultFloorSyncCommand,
): boolean =>
  exact(payload, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) &&
  payload.ownerID === command.ownerID &&
  payload.vaultID === command.vaultID &&
  payload.generationEpoch === command.generationEpoch &&
  payload.namespaceState === "PRIVATE";

const opaqueID = /^[A-Za-z0-9._~-]{1,128}$/u;
const opaqueOperationID = /^[A-Za-z0-9_-]{16,128}$/u;
const hexDigest = /^[a-f0-9]{64}$/u;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const controlCommonKeys = [
  "ownerID",
  "vaultID",
  "generationEpoch",
  "routingEpoch",
  "credentialEpoch",
  "controlEpoch",
  "securityFloor",
  "operationID",
  "jti",
] as const;
interface OwnerVaultControlCommand extends Readonly<Record<string, unknown>> {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly routingEpoch: number;
  readonly credentialEpoch: number;
  readonly controlEpoch: number;
  readonly securityFloor: number;
  readonly operationID: string;
  readonly jti: string;
}
interface OwnerVaultPrivateInitializeCommand extends OwnerVaultControlCommand {
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly allocationID: string;
  readonly initID: string;
  readonly backupID: string;
  readonly manifestDigest: string;
}
interface OwnerVaultCredentialFenceCommand extends OwnerVaultControlCommand {
  readonly expectedCredentialEpoch: number;
  readonly expectedRoutingEpoch: number;
  readonly expectedControlEpoch: number;
  readonly expectedSecurityFloor: number;
  readonly raisedCredentialEpoch: number;
  readonly raisedRoutingEpoch: number;
}
interface OwnerVaultSnapshotCommand extends OwnerVaultControlCommand {
  readonly backupID: string;
  readonly sourceGeneration: number;
  readonly sourceRoutingEpoch: number;
  readonly sourceCredentialEpoch: number;
  readonly sourceControlEpoch: number;
  readonly sourceSecurityFloor: number;
}
interface OwnerVaultRestoreCommand extends OwnerVaultControlCommand {
  readonly allocationID: string;
  readonly initID: string;
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly backupID: string;
  readonly manifestDigest: string;
}
const validControlCommon = (
  value: Readonly<Record<string, unknown>>,
): value is OwnerVaultControlCommand =>
  controlCommonKeys.every((key) => Object.hasOwn(value, key)) &&
  typeof value.ownerID === "string" &&
  opaqueID.test(value.ownerID) &&
  typeof value.vaultID === "string" &&
  opaqueID.test(value.vaultID) &&
  value.ownerID !== value.vaultID &&
  positive(value.generationEpoch) &&
  positive(value.routingEpoch) &&
  positive(value.credentialEpoch) &&
  positive(value.controlEpoch) &&
  positive(value.securityFloor) &&
  typeof value.operationID === "string" &&
  opaqueOperationID.test(value.operationID) &&
  typeof value.jti === "string" &&
  opaqueOperationID.test(value.jti);
const validPrivateInitialize = (
  value: Readonly<Record<string, unknown>>,
): value is OwnerVaultPrivateInitializeCommand =>
  exact(value, [
    ...controlCommonKeys,
    "sourceGeneration",
    "targetGeneration",
    "allocationID",
    "initID",
    "backupID",
    "manifestDigest",
  ]) &&
  validControlCommon(value) &&
  positive(value.sourceGeneration) &&
  positive(value.targetGeneration) &&
  value.targetGeneration === value.generationEpoch &&
  value.sourceGeneration < value.targetGeneration &&
  typeof value.allocationID === "string" &&
  opaqueOperationID.test(value.allocationID) &&
  typeof value.initID === "string" &&
  opaqueOperationID.test(value.initID) &&
  typeof value.backupID === "string" &&
  opaqueOperationID.test(value.backupID) &&
  typeof value.manifestDigest === "string" &&
  hexDigest.test(value.manifestDigest);
const validFence = (
  value: Readonly<Record<string, unknown>>,
): value is OwnerVaultCredentialFenceCommand =>
  exact(value, [
    ...controlCommonKeys,
    "expectedCredentialEpoch",
    "expectedRoutingEpoch",
    "expectedControlEpoch",
    "expectedSecurityFloor",
    "raisedCredentialEpoch",
    "raisedRoutingEpoch",
  ]) &&
  validControlCommon(value) &&
  positive(value.expectedCredentialEpoch) &&
  positive(value.expectedRoutingEpoch) &&
  positive(value.expectedControlEpoch) &&
  positive(value.expectedSecurityFloor) &&
  positive(value.raisedCredentialEpoch) &&
  positive(value.raisedRoutingEpoch) &&
  value.credentialEpoch === value.raisedCredentialEpoch &&
  value.routingEpoch === value.raisedRoutingEpoch &&
  value.controlEpoch === value.expectedControlEpoch &&
  value.securityFloor === value.expectedSecurityFloor &&
  value.raisedCredentialEpoch === value.expectedCredentialEpoch + 1 &&
  value.raisedRoutingEpoch === value.expectedRoutingEpoch + 1;
const validSnapshot = (
  value: Readonly<Record<string, unknown>>,
): value is OwnerVaultSnapshotCommand =>
  exact(value, [
    ...controlCommonKeys,
    "backupID",
    "sourceGeneration",
    "sourceRoutingEpoch",
    "sourceCredentialEpoch",
    "sourceControlEpoch",
    "sourceSecurityFloor",
  ]) &&
  validControlCommon(value) &&
  typeof value.backupID === "string" &&
  opaqueOperationID.test(value.backupID) &&
  positive(value.sourceGeneration) &&
  positive(value.sourceRoutingEpoch) &&
  positive(value.sourceCredentialEpoch) &&
  positive(value.sourceControlEpoch) &&
  positive(value.sourceSecurityFloor) &&
  value.sourceGeneration === value.generationEpoch &&
  value.sourceRoutingEpoch === value.routingEpoch &&
  value.sourceCredentialEpoch === value.credentialEpoch &&
  value.sourceControlEpoch === value.controlEpoch &&
  value.sourceSecurityFloor === value.securityFloor;
const validRestore = (
  value: Readonly<Record<string, unknown>>,
): value is OwnerVaultRestoreCommand =>
  exact(value, [
    ...controlCommonKeys,
    "allocationID",
    "initID",
    "sourceGeneration",
    "targetGeneration",
    "backupID",
    "manifestDigest",
  ]) &&
  validControlCommon(value) &&
  typeof value.allocationID === "string" &&
  opaqueOperationID.test(value.allocationID) &&
  typeof value.initID === "string" &&
  opaqueOperationID.test(value.initID) &&
  positive(value.sourceGeneration) &&
  positive(value.targetGeneration) &&
  value.targetGeneration === value.generationEpoch &&
  value.sourceGeneration < value.targetGeneration &&
  typeof value.backupID === "string" &&
  opaqueOperationID.test(value.backupID) &&
  typeof value.manifestDigest === "string" &&
  hexDigest.test(value.manifestDigest);

export interface OwnerVaultDODependencies {
  readonly controls: DirectoryControlCapabilityFactory;
  /** ovdc1 is deliberately distinct from the historical Directory capability. */
  readonly ownerVaultControls?: OwnerVaultDirectoryControlFactory;
  /** The only configuration authority supplied to P02/P03/C2/C4 providers. */
  readonly production?: OwnerVaultProductionAuthority;
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
    private readonly ownerVaultControls: OwnerVaultDirectoryControlFactory | undefined;
    private readonly production: OwnerVaultProductionAuthority | undefined;
    constructor(ctx: DurableObjectState, env: Readonly<Record<never, never>>) {
      super(ctx, env);
      const resolved = typeof dependencies === "function" ? dependencies(env) : dependencies;
      this.controls = resolved?.controls;
      this.ownerVaultControls = resolved?.ownerVaultControls;
      this.production = resolved?.production;
    }

    private initialize = (
      envelope: ControlEnvelope<OwnerVaultInitializationCommand>,
    ): Effect.Effect<Response> => {
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
          const payload = initPayload(
            command,
            durableReceipt("init", command.operationID, command.initDigest),
          );
          return provider.initialize().pipe(
            Effect.zipRight(
              repository.transact((tx) =>
                tx
                  .get({ category: "control.initialization-ack", identifier: command.operationID })
                  .pipe(
                    Effect.flatMap((existing) => {
                      if (existing !== undefined)
                        return samePayload(existing.payload, payload)
                          ? Effect.succeed(payload.durableReceipt)
                          : rejectControl();
                      return tx
                        .put(
                          {
                            category: "control.initialization-ack",
                            identifier: command.operationID,
                          },
                          payload,
                        )
                        .pipe(Effect.as(payload.durableReceipt));
                    }),
                  ),
              ),
            ),
            Effect.map(
              (receipt): Response =>
                response({
                  ...command,
                  durableReceipt: receipt,
                } satisfies OwnerVaultInitializationAck),
            ),
          );
        }),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private syncFloors = (
      envelope: ControlEnvelope<OwnerVaultFloorSyncCommand>,
    ): Effect.Effect<Response> => {
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
        Effect.flatMap(() =>
          repository.transact((tx) => {
            const payload = floorPayload(
              command,
              durableReceipt("floor", command.operationID, command.floorSyncDigest),
            );
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
                        typeof prior.credentialEpoch !== "number" ||
                        typeof prior.routingEpoch !== "number" ||
                        typeof prior.controlEpoch !== "number" ||
                        command.credentialEpoch < prior.credentialEpoch ||
                        command.routingEpoch < prior.routingEpoch ||
                        command.controlEpoch < prior.controlEpoch
                      )
                        return rejectControl();
                    }
                    return tx
                      .put(
                        { category: "control.floor-sync", identifier: command.operationID },
                        payload,
                      )
                      .pipe(
                        Effect.zipRight(
                          tx.put(
                            { category: "control.floor-sync", identifier: "current" },
                            payload,
                          ),
                        ),
                        Effect.as(payload.durableReceipt),
                      );
                  }),
                );
              }),
            );
          }),
        ),
        Effect.map(
          (receipt): Response =>
            response({ ...command, durableReceipt: receipt } satisfies OwnerVaultFloorSyncAck),
        ),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private privateInitialize = (
      envelope: OwnerVaultControlEnvelope<OwnerVaultPrivateInitializeCommand>,
    ): Effect.Effect<Response> => {
      const command = envelope.command;
      const root = {
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        generationEpoch: command.generationEpoch,
        namespaceState: "PRIVATE" as const,
      };
      const binding = {
        resource: OwnerVaultDirectoryControlResource.PrivateInitialize,
        path: ownerVaultPrivateInitializePath,
        method: "POST" as const,
        canonicalQuery: "" as const,
        bodySHA256: bodyHash(command),
        ...command,
      } as const;
      if (this.ownerVaultControls === undefined || this.production === undefined)
        return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      const graph = makeOwnerVaultProviderGraph(repository, root, this.production);
      if (graph === undefined) return Effect.succeed(response({ ok: false }, 403));
      const receipt = durableReceipt("private-init", command.operationID, command.manifestDigest);
      const acknowledgement = {
        kind: "private-initialize",
        privateRestoreLink: privateRestoreLink(command),
        controlDigest: bodyHash(command),
        durableReceipt: receipt,
      } as const;
      const authority = {
        kind: "authority",
        credentialEpoch: command.credentialEpoch,
        routingEpoch: command.routingEpoch,
        controlEpoch: command.controlEpoch,
        securityFloor: command.securityFloor,
      } as const;
      return this.ownerVaultControls.verify(envelope.capability, binding, binding, now()).pipe(
        Effect.flatMap(() => graph.domains.initialize()),
        Effect.zipRight(
          repository.transact((tx) =>
            tx.get({ category: "control.initialization-ack", identifier: command.initID }).pipe(
              Effect.flatMap((existing) => {
                if (existing !== undefined)
                  return samePayload(existing.payload, acknowledgement)
                    ? Effect.succeed(receipt)
                    : rejectControl();
                return tx.get({ category: "control.floor-sync", identifier: "authority" }).pipe(
                  Effect.flatMap((prior) => {
                    if (prior !== undefined && !samePayload(prior.payload, authority))
                      return rejectControl();
                    return tx
                      .put({ category: "root.floors" }, { securityFloor: command.securityFloor })
                      .pipe(
                        Effect.zipRight(
                          tx.put(
                            { category: "control.initialization-ack", identifier: command.initID },
                            acknowledgement,
                          ),
                        ),
                        Effect.zipRight(
                          tx.put(
                            { category: "control.floor-sync", identifier: "authority" },
                            authority,
                          ),
                        ),
                        Effect.as(receipt),
                      );
                  }),
                );
              }),
            ),
          ),
        ),
        Effect.map((durableReceipt): Response => response({ ...command, durableReceipt })),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private credentialFence = (
      envelope: OwnerVaultControlEnvelope<OwnerVaultCredentialFenceCommand>,
    ): Effect.Effect<Response> => {
      const command = envelope.command;
      const binding = {
        resource: OwnerVaultDirectoryControlResource.CredentialFence,
        path: ownerVaultCredentialFencePath,
        method: "POST" as const,
        canonicalQuery: "" as const,
        bodySHA256: bodyHash(command),
        ...command,
      } as const;
      if (this.ownerVaultControls === undefined)
        return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      const receipt = durableReceipt("credential-fence", command.operationID, bodyHash(command));
      const acknowledgement = {
        kind: "credential-fence",
        controlDigest: bodyHash(command),
        durableReceipt: receipt,
      } as const;
      const raisedAuthority = {
        kind: "authority",
        credentialEpoch: command.raisedCredentialEpoch,
        routingEpoch: command.raisedRoutingEpoch,
        controlEpoch: command.expectedControlEpoch,
        securityFloor: command.expectedSecurityFloor,
      } as const;
      return this.ownerVaultControls.verify(envelope.capability, binding, binding, now()).pipe(
        Effect.flatMap(() =>
          repository.transact((tx) =>
            tx.get({ category: "control.floor-sync", identifier: command.operationID }).pipe(
              Effect.flatMap((priorAck) => {
                if (priorAck !== undefined)
                  return samePayload(priorAck.payload, acknowledgement)
                    ? Effect.succeed(receipt)
                    : rejectControl();
                return Effect.all([
                  tx.get({ category: "root.identity" }),
                  tx.get({ category: "root.floors" }),
                  tx.get({ category: "root.admission" }),
                  tx.get({ category: "control.floor-sync", identifier: "authority" }),
                ]).pipe(
                  Effect.flatMap(([identity, floors, admission, authority]) => {
                    const root = identity === undefined ? undefined : record(identity.payload);
                    const currentFloors = floors === undefined ? undefined : record(floors.payload);
                    const currentAdmission =
                      admission === undefined ? undefined : record(admission.payload);
                    const currentAuthority =
                      authority === undefined ? undefined : record(authority.payload);
                    const expectedAuthority = {
                      kind: "authority",
                      credentialEpoch: command.expectedCredentialEpoch,
                      routingEpoch: command.expectedRoutingEpoch,
                      controlEpoch: command.expectedControlEpoch,
                      securityFloor: command.expectedSecurityFloor,
                    };
                    if (
                      root === undefined ||
                      !exact(root, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) ||
                      root.ownerID !== command.ownerID ||
                      root.vaultID !== command.vaultID ||
                      root.generationEpoch !== command.generationEpoch ||
                      (root.namespaceState !== "PRIVATE" && root.namespaceState !== "ACTIVE") ||
                      currentFloors === undefined ||
                      !exact(currentFloors, ["securityFloor"]) ||
                      currentFloors.securityFloor !== command.expectedSecurityFloor ||
                      currentAdmission === undefined ||
                      typeof currentAdmission.stopped !== "boolean" ||
                      currentAdmission.stopped ||
                      currentAuthority === undefined ||
                      !samePayload(currentAuthority, expectedAuthority)
                    )
                      return rejectControl();
                    return tx
                      .put(
                        { category: "control.floor-sync", identifier: command.operationID },
                        acknowledgement,
                      )
                      .pipe(
                        Effect.zipRight(
                          tx.put(
                            { category: "control.floor-sync", identifier: "authority" },
                            raisedAuthority,
                          ),
                        ),
                        Effect.zipRight(
                          tx.put(
                            { category: "root.admission" },
                            { ...currentAdmission, stopped: true },
                          ),
                        ),
                        Effect.as(receipt),
                      );
                  }),
                );
              }),
            ),
          ),
        ),
        // The acknowledgement transaction has committed before a live socket
        // is observed. Attachments contain only IDs/expiry, so cleanup cannot
        // resurrect a bearer or carry authority across a restart.
        Effect.tap(() =>
          Effect.sync(() => {
            for (const socket of this.ctx.getWebSockets()) socket.close(4401, "credential fenced");
          }),
        ),
        Effect.map((durableReceipt): Response => response({ ...command, durableReceipt })),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private snapshot = (
      envelope: OwnerVaultControlEnvelope<OwnerVaultSnapshotCommand>,
    ): Effect.Effect<Response> => {
      const command = envelope.command;
      const root = {
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        generationEpoch: command.generationEpoch,
        namespaceState: "PRIVATE" as const,
      };
      const binding = {
        resource: OwnerVaultDirectoryControlResource.Snapshot,
        path: ownerVaultSnapshotPath,
        method: "POST" as const,
        canonicalQuery: "" as const,
        bodySHA256: bodyHash(command),
        ...command,
      } as const;
      if (this.ownerVaultControls === undefined || this.production === undefined)
        return Effect.succeed(response({ ok: false }, 503));
      const graph = makeOwnerVaultProviderGraph(
        makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage),
        root,
        this.production,
      );
      if (graph === undefined) return Effect.succeed(response({ ok: false }, 403));
      return this.ownerVaultControls.verify(envelope.capability, binding, binding, now()).pipe(
        Effect.flatMap(() =>
          graph.snapshots.beginSnapshot(
            {
              ownerID: command.ownerID,
              vaultID: command.vaultID,
              generationEpoch: command.sourceGeneration,
            },
            command.backupID,
          ),
        ),
        Effect.map((pin): Response => response({ pin })),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private restore = (
      envelope: OwnerVaultControlEnvelope<OwnerVaultRestoreCommand>,
    ): Effect.Effect<Response> => {
      const command = envelope.command;
      const root = {
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        generationEpoch: command.targetGeneration,
        namespaceState: "PRIVATE" as const,
      };
      const binding = {
        resource: OwnerVaultDirectoryControlResource.Restore,
        path: ownerVaultRestorePath,
        method: "POST" as const,
        canonicalQuery: "" as const,
        bodySHA256: bodyHash(command),
        ...command,
      } as const;
      if (this.ownerVaultControls === undefined || this.production === undefined)
        return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      const graph = makeOwnerVaultProviderGraph(repository, root, this.production);
      if (graph === undefined) return Effect.succeed(response({ ok: false }, 403));
      const assertFreshPrivateTarget = (): Effect.Effect<void, OwnerVaultBackupError> =>
        repository
          .transact((tx) =>
            tx.get({ category: "control.initialization-ack", identifier: command.initID }).pipe(
              Effect.flatMap((ack) => {
                const payload = ack === undefined ? undefined : record(ack.payload);
                return payload !== undefined &&
                  samePayload(payload, {
                    kind: "private-initialize",
                    privateRestoreLink: privateRestoreLink(command),
                    controlDigest: payload.controlDigest,
                    durableReceipt: payload.durableReceipt,
                  })
                  ? Effect.void
                  : Effect.fail({
                      _tag: "OwnerVaultStorageError",
                      reason: "identity_conflict",
                    } as const);
              }),
            ),
          )
          .pipe(
            Effect.mapError(() => new OwnerVaultBackupError({ reason: "private_target_required" })),
          );
      return this.ownerVaultControls.verify(envelope.capability, binding, binding, now()).pipe(
        Effect.flatMap(() => graph.backupRuntime()),
        Effect.flatMap((runtime) =>
          restoreOwnerVaultBackup(
            runtime,
            graph.privateRestoreTarget(assertFreshPrivateTarget),
            {
              ownerID: command.ownerID,
              vaultID: command.vaultID,
              generationEpoch: command.sourceGeneration,
            },
            command.backupID,
          ),
        ),
        Effect.as(
          response({
            ok: true,
            backupID: command.backupID,
            targetGeneration: command.targetGeneration,
          }),
        ),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private readonly effectHandler = (request: Request): Effect.Effect<Response> =>
      Effect.try({
        try: () => ({ method: request.method, pathname: new URL(request.url).pathname }),
        catch: () => undefined,
      }).pipe(
        Effect.flatMap((route) => {
          if (route?.method !== "POST") return Effect.succeed(response({ ok: false }, 404));
          const ovdc =
            route.pathname === ownerVaultPrivateInitializePath ||
            route.pathname === ownerVaultCredentialFencePath ||
            route.pathname === ownerVaultSnapshotPath ||
            route.pathname === ownerVaultRestorePath;
          return readBoundedRequestBody(request, {
            maximumBytes: ovdc ? controlMaximumBodyBytes : maximumBodyBytes,
            requiredContentType: "application/json",
          }).pipe(
            Effect.flatMap((bytes) => {
              if (route.pathname === ownerVaultPrivateInitializePath) {
                const envelope = decodeOwnerVaultControlEnvelope(bytes, validPrivateInitialize);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.privateInitialize(envelope);
              }
              if (route.pathname === ownerVaultCredentialFencePath) {
                const envelope = decodeOwnerVaultControlEnvelope(bytes, validFence);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.credentialFence(envelope);
              }
              if (route.pathname === ownerVaultSnapshotPath) {
                const envelope = decodeOwnerVaultControlEnvelope(bytes, validSnapshot);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.snapshot(envelope);
              }
              if (route.pathname === ownerVaultRestorePath) {
                const envelope = decodeOwnerVaultControlEnvelope(bytes, validRestore);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.restore(envelope);
              }
              if (route.pathname === ownerVaultInitializationPath) {
                const envelope = decodeEnvelope(bytes, validOwnerVaultInitializationCommand);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.initialize(envelope);
              }
              if (route.pathname === ownerVaultFloorSyncPath) {
                const envelope = decodeEnvelope(bytes, validOwnerVaultFloorSyncCommand);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.syncFloors(envelope);
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
