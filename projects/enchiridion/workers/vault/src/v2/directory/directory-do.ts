/** @enchiridion/effect-module */
import { DurableObject } from "cloudflare:workers";
import { parseJSONWithoutDuplicateMembers } from "@enchiridion/protocol";
import { makeDurableObjectBoundary, readBoundedRequestBody } from "@enchiridion/runtime";
import { Effect } from "effect";
import {
  type InternalCapabilityFactory as CapabilityFactory,
  DirectoryControlCapabilityFactory,
  type DirectoryControlCapabilityFactory as DirectoryControlFactory,
  InternalCapabilityFactory,
} from "../foundation/crypto";
import { isCanonicalDirectoryAlias } from "./invariants";
import { DirectoryRepository, makeDurableObjectDirectoryRepository } from "./repository";
import {
  DirectoryOwnerVaultInitializer,
  type DirectoryService,
  makeDirectoryService,
} from "./service";
import type {
  DirectoryInvocation,
  DirectoryResolution,
  DirectorySecureRandom,
  DirectoryWireRequest,
} from "./types";

export const directoryDOPath = "/v2/internal/directory/resolve";
const maximumBodyBytes = 16_384;
const identifier = /^[A-Za-z0-9._~-]{1,128}$/u;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const decodeInvocation = (source: string): DirectoryInvocation | undefined => {
  try {
    const root = record(parseJSONWithoutDuplicateMembers(source));
    if (root === undefined || !exact(root, ["capability", "request"])) return undefined;
    const capability = record(root.capability);
    const request = record(root.request);
    if (
      capability === undefined ||
      !exact(capability, ["value"]) ||
      typeof capability.value !== "string" ||
      capability.value.length < 16 ||
      capability.value.length > 8_192 ||
      request === undefined ||
      !exact(request, ["aliases", "currentAlias", "accessExpiresAt", "operation"]) ||
      !Array.isArray(request.aliases) ||
      !request.aliases.every(
        (entry) => typeof entry === "string" && isCanonicalDirectoryAlias(entry),
      ) ||
      typeof request.currentAlias !== "string" ||
      !isCanonicalDirectoryAlias(request.currentAlias) ||
      typeof request.accessExpiresAt !== "number" ||
      !Number.isSafeInteger(request.accessExpiresAt) ||
      request.operation !== "resolve-or-bootstrap"
    )
      return undefined;
    return {
      capability: { value: capability.value },
      request: {
        aliases: request.aliases,
        currentAlias: request.currentAlias,
        accessExpiresAt: request.accessExpiresAt,
        operation: request.operation,
      } satisfies DirectoryWireRequest,
    };
  } catch {
    return undefined;
  }
};

const wireResolution = (
  value: DirectoryResolution,
): Readonly<Record<string, string | number>> | undefined =>
  identifier.test(value.ownerID.value) &&
  identifier.test(value.vaultID.value) &&
  /^init-[a-f0-9]{64}$/u.test(value.initID) &&
  positive(value.generationEpoch) &&
  positive(value.activeGeneration) &&
  positive(value.routingEpoch) &&
  positive(value.credentialEpoch) &&
  positive(value.controlEpoch)
    ? {
        ownerID: value.ownerID.value,
        vaultID: value.vaultID.value,
        initID: value.initID,
        generationEpoch: value.generationEpoch,
        activeGeneration: value.activeGeneration,
        routingEpoch: value.routingEpoch,
        credentialEpoch: value.credentialEpoch,
        controlEpoch: value.controlEpoch,
      }
    : undefined;

const response = (body: Readonly<Record<string, unknown>>, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

interface RequestRoute {
  readonly method: string;
  readonly pathname: string;
}

/** Native Request getters are hostile ingress too; capture them inside the closed Effect boundary. */
const requestRoute = (request: Request): Effect.Effect<RequestRoute | undefined> =>
  Effect.try({
    try: () => ({ method: request.method, pathname: new URL(request.url).pathname }),
    catch: () => new Error("request_malformed"),
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

export interface CredentialDirectoryDODependencies {
  readonly capabilities: CapabilityFactory;
  readonly controls: DirectoryControlFactory;
  readonly random: DirectorySecureRandom;
  readonly ownerVault: DirectoryOwnerVaultInitializer;
}
export type CredentialDirectoryDependencyProvider = (
  env: unknown,
) => CredentialDirectoryDODependencies | undefined;
export type CredentialDirectoryDOConstructor = new (
  ctx: DurableObjectState,
  env: Readonly<Record<never, never>>,
) => DurableObject<Readonly<Record<never, never>>>;

/** Fixed HTTP-only Directory DO. All untrusted bytes are bounded and duplicate-safe decoded. */
export const makeCredentialDirectoryDO = (
  dependencies: CredentialDirectoryDODependencies | CredentialDirectoryDependencyProvider,
): CredentialDirectoryDOConstructor => {
  class CredentialDirectoryDO extends DurableObject<Readonly<Record<never, never>>> {
    private readonly boundary = makeDurableObjectBoundary(this.ctx);
    private readonly service: DirectoryService | undefined;
    constructor(ctx: DurableObjectState, env: Readonly<Record<never, never>>) {
      super(ctx, env);
      const resolved = typeof dependencies === "function" ? dependencies(env) : dependencies;
      this.service =
        resolved === undefined
          ? undefined
          : Effect.runSync(
              makeDirectoryService(resolved.random).pipe(
                Effect.provideService(
                  DirectoryRepository,
                  makeDurableObjectDirectoryRepository(this.boundary.storage),
                ),
                Effect.provideService(InternalCapabilityFactory, resolved.capabilities),
                Effect.provideService(DirectoryControlCapabilityFactory, resolved.controls),
                Effect.provideService(DirectoryOwnerVaultInitializer, resolved.ownerVault),
              ),
            );
    }
    private readonly effectHandler = (request: Request): Effect.Effect<Response> => {
      const resolve = (bytes: Uint8Array<ArrayBuffer>): Effect.Effect<Response> =>
        Effect.sync(() =>
          decodeInvocation(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        ).pipe(
          Effect.flatMap((invocation) =>
            invocation === undefined || this.service === undefined
              ? Effect.succeed(response({ ok: false }, 400))
              : this.service.resolveOrBootstrap(invocation, Math.floor(Date.now() / 1_000)).pipe(
                  Effect.map((resolved) => {
                    const wire = wireResolution(resolved);
                    return wire === undefined
                      ? response({ ok: false }, 500)
                      : response({ ok: true, resolution: wire });
                  }),
                  Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
                ),
          ),
        );
      return requestRoute(request).pipe(
        Effect.flatMap((route) => {
          if (route === undefined || route.method !== "POST" || route.pathname !== directoryDOPath)
            return Effect.succeed(response({ ok: false }, 404));
          return readBoundedRequestBody(request, {
            maximumBytes: maximumBodyBytes,
            requiredContentType: "application/json",
          }).pipe(Effect.flatMap(resolve));
        }),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 400))),
      );
    };
    override readonly fetch = (request: Request) =>
      this.boundary.callbacks.fetch(this.effectHandler(request));
  }
  return CredentialDirectoryDO;
};
