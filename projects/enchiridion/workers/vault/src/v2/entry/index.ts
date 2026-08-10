/** @enchiridion/effect-module */
import {
  type CanonicalJSON,
  canonicalJSONStringify,
  parseJSONWithoutDuplicateMembers,
} from "@enchiridion/protocol";
import {
  makeFixedDurableObjectClient,
  makeP256Crypto,
  makeWorkerBoundary,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import { directoryDOPath, makeCredentialDirectoryDO } from "../directory/directory-do";
import { makeDirectoryInvocation } from "../directory/gateway";
import { validDirectoryResolution } from "../directory/invariants";
import { makeOwnerVaultDO } from "../owner-vault/owner-vault-do";
import { accessAssertionHeadersFromWorkerHeaders } from "../foundation/access";
import { InternalCapabilityFactory } from "../foundation/crypto";
import {
  type VaultV2EntryCompositionOptions,
  makeVaultV2EntryCompositionCache,
  parseVaultV2EntryEnv,
} from "./composition";

const directory = {
  name: "v2.credential-directory.global",
  method: "POST" as const,
  path: directoryDOPath,
  headers: { "content-type": "application/json" },
  expectedStatus: 200,
  maximumRequestBytes: 16_384,
  maximumResponseBytes: 4_096,
};
const now = (): number => Math.floor(Date.now() / 1_000);
const base64url = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};
const invocationJSON = (value: {
  readonly capability: { readonly value: string };
  readonly request: {
    readonly aliases: readonly string[];
    readonly currentAlias: string;
    readonly accessExpiresAt: number;
    readonly operation: string;
  };
}): CanonicalJSON => ({
  capability: { value: value.capability.value },
  request: {
    aliases: [...value.request.aliases],
    currentAlias: value.request.currentAlias,
    accessExpiresAt: value.request.accessExpiresAt,
    operation: value.request.operation,
  },
});
const response = (body: Readonly<Record<string, unknown>>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const bytes = (body: string): Uint8Array<ArrayBuffer> => {
  const source = new TextEncoder().encode(body);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
};
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const identifier = /^[A-Za-z0-9._~-]{1,128}$/u;
const initID = /^init-[a-f0-9]{64}$/u;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/**
 * Directory is an authority boundary: success is accepted only when every
 * field is the closed wire contract.  In particular, a forged `{ ok: true }`
 * response can never become a bootstrap acknowledgement.
 */
const validResponse = (
  bytes: Uint8Array,
  aliases: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  try {
    const root = record(
      parseJSONWithoutDuplicateMembers(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (root === undefined || !exact(root, ["ok", "resolution"]) || root.ok !== true)
      return undefined;
    const resolution = record(root.resolution);
    if (
      resolution === undefined ||
      !exact(resolution, [
        "ownerID",
        "vaultID",
        "initID",
        "generationEpoch",
        "activeGeneration",
        "routingEpoch",
        "credentialEpoch",
        "controlEpoch",
      ]) ||
      typeof resolution.ownerID !== "string" ||
      !identifier.test(resolution.ownerID) ||
      typeof resolution.vaultID !== "string" ||
      !identifier.test(resolution.vaultID) ||
      typeof resolution.initID !== "string" ||
      !initID.test(resolution.initID) ||
      !positive(resolution.generationEpoch) ||
      !positive(resolution.activeGeneration) ||
      !positive(resolution.routingEpoch) ||
      !positive(resolution.credentialEpoch) ||
      !positive(resolution.controlEpoch)
    )
      return undefined;
    const ownerID = resolution.ownerID;
    const vaultID = resolution.vaultID;
    const candidate = {
      ownerID: { value: ownerID },
      vaultID: { value: vaultID },
      initID: resolution.initID,
      generationEpoch: resolution.generationEpoch,
      activeGeneration: resolution.activeGeneration,
      routingEpoch: resolution.routingEpoch,
      credentialEpoch: resolution.credentialEpoch,
      controlEpoch: resolution.controlEpoch,
    };
    if (!aliases.some((binding) => validDirectoryResolution(binding, candidate))) return undefined;
    return root;
  } catch {
    return undefined;
  }
};

interface RequestRoute {
  readonly method: string;
  readonly pathname: string;
  readonly headers: Headers;
}

const requestRoute = (request: Request): Effect.Effect<RequestRoute, never> =>
  Effect.try({
    try: () => {
      const method = request.method;
      const url = request.url;
      const headers = request.headers;
      return { method, pathname: new URL(url).pathname, headers };
    },
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((value) =>
      value === undefined ? Effect.fail(undefined) : Effect.succeed(value),
    ),
    Effect.catchAll(() => Effect.succeed({ method: "", pathname: "", headers: new Headers() })),
  );

/**
 * Builds the deployable Worker and its Directory DO from exactly one
 * composition factory. Tests may inject only the runtime JWKS session
 * factory; they do not get a second HTTP handler or Directory service.
 */
export const makeVaultV2Entry = (
  options: VaultV2EntryCompositionOptions = {},
): {
  readonly CredentialDirectoryDO: ReturnType<typeof makeCredentialDirectoryDO>;
  readonly handler: (request: Request, raw: unknown) => Effect.Effect<Response>;
} => {
  const resolveComposition = makeVaultV2EntryCompositionCache(options);

  const handler = (request: Request, raw: unknown): Effect.Effect<Response> => {
    const env = parseVaultV2EntryEnv(raw);
    if (env === undefined) return Effect.succeed(new Response("unauthorized", { status: 401 }));
    const resolvedComposition = resolveComposition(env);
    if (resolvedComposition === undefined)
      return Effect.succeed(new Response("unauthorized", { status: 401 }));
    const seconds = now();
    return requestRoute(request).pipe(
      Effect.flatMap((route) =>
        route.method !== "POST" || route.pathname !== "/__v2/internal/bootstrap"
          ? Effect.succeed(new Response("not found", { status: 404 }))
          : resolvedComposition.assertionVerifier
              .verify(accessAssertionHeadersFromWorkerHeaders(route.headers), seconds)
              .pipe(
                Effect.flatMap((verified) =>
                  resolvedComposition.issuerHasher
                    .aliases({ issuer: verified.issuer, subject: verified.subject })
                    .pipe(
                      Effect.flatMap((aliases) =>
                        makeP256Crypto()
                          .random32()
                          .pipe(
                            Effect.flatMap((random) =>
                              makeDirectoryInvocation(
                                aliases,
                                verified.claims.exp,
                                base64url(random),
                                seconds,
                              ).pipe(
                                Effect.provideService(
                                  InternalCapabilityFactory,
                                  resolvedComposition.capabilities,
                                ),
                              ),
                            ),
                          ),
                      ),
                    ),
                ),
                Effect.flatMap((invocation) =>
                  Effect.map(
                    makeFixedDurableObjectClient(env.CREDENTIAL_DIRECTORY_DO, directory).invoke(
                      bytes(canonicalJSONStringify(invocationJSON(invocation))),
                    ),
                    (result) => ({ result, aliases: invocation.request.aliases }),
                  ),
                ),
                Effect.map(({ result, aliases }) => {
                  const parsed = validResponse(result.body, aliases);
                  return parsed === undefined
                    ? new Response("unavailable", { status: 503 })
                    : response(parsed);
                }),
                Effect.catchAll(() => Effect.succeed(new Response("unavailable", { status: 503 }))),
              ),
      ),
    );
  };
  /**
   * The configured production Durable Object.  Its dependencies are resolved
   * from the same validated isolate composition as the Worker fetch entry; a
   * malformed binding set yields the fixed closed DO response, never defaults.
   */
  const CredentialDirectoryDO = makeCredentialDirectoryDO((raw) => {
    const env = parseVaultV2EntryEnv(raw);
    const resolvedComposition = env === undefined ? undefined : resolveComposition(env);
    return resolvedComposition === undefined
      ? undefined
      : {
          capabilities: resolvedComposition.capabilities,
          controls: resolvedComposition.directoryControls,
          random: resolvedComposition.random,
          ownerVault: { client: resolvedComposition.ownerVaultInitialization },
        };
  });
  return {
    CredentialDirectoryDO,
    handler,
  };
};

const productionEntry = makeVaultV2Entry();
const boundary = makeWorkerBoundary(productionEntry.handler);
export const CredentialDirectoryDO = productionEntry.CredentialDirectoryDO;
const ownerVaultComposition = makeVaultV2EntryCompositionCache();
export const OwnerVaultV2 = makeOwnerVaultDO((raw) => {
  const resolved = ownerVaultComposition(raw);
  return resolved === undefined ? undefined : { controls: resolved.directoryControls };
});
export default {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) =>
    boundary.handle(request, env, ctx),
};
