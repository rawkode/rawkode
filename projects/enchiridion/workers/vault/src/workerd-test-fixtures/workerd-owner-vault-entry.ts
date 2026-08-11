// TEST-ONLY Workerd entry (Wrangler `main` for
// v2/owner-vault/wrangler.owner-vault-workerd-test.jsonc). It lives outside
// the deployable `src/v2` root because it is test support, not production
// source: Worker `fetch` is the one native Promise adapter required by
// Wrangler, and the composition itself remains Effect-based. It is
// deliberately not named as a Bun test module: it must export the Durable
// Object classes, whose `cloudflare:workers` import only resolves in Workerd.
import { makeWorkerBoundary, ownerVaultSocketAdmissionPath } from "@enchiridion/runtime";
import { Effect } from "effect";
import {
  ownerVaultFloorSyncPath,
  ownerVaultInitializationPath,
  ownerVaultObjectName,
} from "../v2/directory/lifecycle";
import { parseVaultV2EntryEnv } from "../v2/entry/composition";
import { CredentialDirectoryDO, OwnerVaultV2 } from "../v2/entry/index";

const testReadyPath = "/__owner_vault_do_ready__";
const testOwnerVaultControlPrefix = "/__test/owner-vault-control/";
const testOwnerVaultSocketPath = "/__test/owner-vault-socket";
/** One production OwnerVault DO instance backs every relayed route below. */
const testOwnerVault = {
  ownerID: "owner-do-workerd-fixture-0001",
  vaultID: "vault-do-workerd-fixture-0001",
  generationEpoch: 2,
} as const;
const ownerVaultControlPath = (pathname: string): string | undefined => {
  switch (pathname.slice(testOwnerVaultControlPrefix.length)) {
    case "ensure-initialized":
      return ownerVaultInitializationPath;
    case "sync-floors":
      return ownerVaultFloorSyncPath;
    case "private-initialize":
      return "/__v2/internal/owner-vault/private-initialize";
    case "credential-fence":
      return "/__v2/internal/owner-vault/credential-fence";
    case "snapshot":
      return "/__v2/internal/owner-vault/snapshot";
    case "restore":
      return "/__v2/internal/owner-vault/restore";
    case "devices/challenge":
      return "/__v2/internal/owner-vault/devices/challenge";
    case "devices/complete":
      return "/__v2/internal/owner-vault/devices/complete";
    case "append":
      return "/__v2/internal/owner-vault/append";
    default:
      return undefined;
  }
};

/**
 * Workerd-only relay: test code supplies previously signed, byte-identical
 * control/user wire messages. It exercises the production `OwnerVaultV2`
 * Durable Object and its audited boundary callbacks; no alternate OwnerVault
 * implementation or state seeding path exists here.
 */
const handler = (request: Request, raw: unknown): Effect.Effect<Response> =>
  Effect.try({
    try: () => ({ method: request.method, pathname: new URL(request.url).pathname }),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((route) => {
      if (route?.method === "GET" && route.pathname === testReadyPath)
        return Effect.succeed(new Response("ok", { status: 200 }));
      if (route?.method === "GET" && route.pathname === testOwnerVaultSocketPath) {
        const env = parseVaultV2EntryEnv(raw);
        if (env === undefined) return Effect.succeed(new Response("not found", { status: 404 }));
        const stub = env.OWNER_VAULT_V2_DO.get(
          env.OWNER_VAULT_V2_DO.idFromName(ownerVaultObjectName(testOwnerVault)),
        );
        return Effect.tryPromise({
          try: () =>
            stub.fetch(
              new Request(`https://owner-vault.invalid${ownerVaultSocketAdmissionPath}`, request),
            ),
          catch: () => new Response("unavailable", { status: 503 }),
        });
      }
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
      return Effect.succeed(new Response("not found", { status: 404 }));
    }),
    Effect.catchAll(() => Effect.succeed(new Response("not found", { status: 404 }))),
  );
const boundary = makeWorkerBoundary(handler);
export { CredentialDirectoryDO, OwnerVaultV2 };

export default {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) =>
    boundary.handle(request, env, ctx),
};
