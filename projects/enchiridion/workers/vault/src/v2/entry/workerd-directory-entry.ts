// Wrangler-only entry; deliberately not named as a Bun test module.
import {
  type AccessJwksSessionFactory,
  AccessJwtVerificationError,
  type AccessJwtVerificationRequest,
  type VerifiedAccessJwt,
  makeFixedDurableObjectClient,
  makeWorkerBoundary,
  readBoundedRequestBody,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import { directoryDOPath } from "../directory/directory-do";
import { ownerVaultObjectName } from "../directory/lifecycle";
import { parseVaultV2EntryEnv } from "./composition";
import { OwnerVaultV2, makeVaultV2Entry } from "./index";

const fixtureAssertion =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImZpeHR1cmUifQ.eyJmaXh0dXJlIjp0cnVlfQ.fixture";

/**
 * This is deliberately a JWKS-session seam, not an alternate authentication
 * or Directory implementation. The production Access policy subsequently
 * checks issuer, audience, subject and expiry from these verified claims.
 */
const fixtureAccessSession: AccessJwksSessionFactory = () =>
  Effect.succeed({
    verify: (
      request: AccessJwtVerificationRequest,
    ): Effect.Effect<VerifiedAccessJwt, AccessJwtVerificationError> =>
      request.assertion === fixtureAssertion
        ? Effect.succeed({
            protectedHeader: { alg: "RS256", typ: "JWT", kid: "fixture" },
            claims: {
              iss: "https://team.cloudflareaccess.com",
              aud: "fixture-audience",
              iat: request.nowSeconds - 1,
              nbf: request.nowSeconds - 1,
              exp: request.nowSeconds + 60,
              sub: "fixture-subject",
            },
          })
        : Effect.fail(new AccessJwtVerificationError({ reason: "malformed_assertion" })),
  });

const entry = makeVaultV2Entry({ accessJwksSessionFactory: fixtureAccessSession });
const testDirectoryTarget = {
  name: "v2.credential-directory.global",
  method: "POST" as const,
  path: directoryDOPath,
  headers: { "content-type": "application/json" },
  expectedStatus: 200,
  maximumRequestBytes: 16_384,
  maximumResponseBytes: 4_096,
};
const testInvocationPath = "/__test/directory-invocation";
const testOwnerVaultControlPrefix = "/__test/owner-vault-control/";
const testOwnerVault = {
  ownerID: "owner-workerd-fixture",
  vaultID: "vault-workerd-fixture",
  generationEpoch: 2,
} as const;
const ownerVaultControlPath = (pathname: string): string | undefined => {
  switch (pathname.slice(testOwnerVaultControlPrefix.length)) {
    case "private-initialize":
      return "/__v2/internal/owner-vault/private-initialize";
    case "credential-fence":
      return "/__v2/internal/owner-vault/credential-fence";
    case "snapshot":
      return "/__v2/internal/owner-vault/snapshot";
    case "restore":
      return "/__v2/internal/owner-vault/restore";
    default:
      return undefined;
  }
};

/**
 * Workerd-only relay: test code supplies a previously signed, byte-identical
 * Directory wire message. It exercises the production fixed DO transport and
 * `CredentialDirectoryDO`; no alternate Directory implementation is present.
 */
const handler = (request: Request, raw: unknown): Effect.Effect<Response> =>
  Effect.try({
    try: () => ({ method: request.method, pathname: new URL(request.url).pathname }),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((route) => {
      if (route?.method === "POST" && route.pathname.startsWith(testOwnerVaultControlPrefix)) {
        const env = parseVaultV2EntryEnv(raw);
        const targetPath = ownerVaultControlPath(route.pathname);
        if (env === undefined || targetPath === undefined)
          return Effect.succeed(new Response("not found", { status: 404 }));
        const stub = env.OWNER_VAULT_V2_DO.get(
          env.OWNER_VAULT_V2_DO.idFromName(ownerVaultObjectName(testOwnerVault)),
        );
        return Effect.tryPromise({
          try: () => stub.fetch(new Request(`https://owner-vault.invalid${targetPath}`, request)),
          catch: () => new Response("unavailable", { status: 503 }),
        });
      }
      if (route?.method !== "POST" || route.pathname !== testInvocationPath)
        return entry.handler(request, raw);
      const env = parseVaultV2EntryEnv(raw);
      if (env === undefined) return Effect.succeed(new Response("unauthorized", { status: 401 }));
      return readBoundedRequestBody(request, {
        maximumBytes: testDirectoryTarget.maximumRequestBytes,
        requiredContentType: "application/json",
      }).pipe(
        Effect.flatMap((body) =>
          makeFixedDurableObjectClient(env.CREDENTIAL_DIRECTORY_DO, testDirectoryTarget).invoke(
            body,
          ),
        ),
        Effect.map(
          (result) =>
            new Response(result.body, {
              status: result.status,
              headers: { "content-type": "application/json", "cache-control": "no-store" },
            }),
        ),
        Effect.catchAll(() => Effect.succeed(new Response("unavailable", { status: 503 }))),
      );
    }),
    Effect.catchAll(() => entry.handler(request, raw)),
  );
const boundary = makeWorkerBoundary(handler);
export const CredentialDirectoryDO = entry.CredentialDirectoryDO;
export { OwnerVaultV2 };

export default {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) =>
    boundary.handle(request, env, ctx),
};
