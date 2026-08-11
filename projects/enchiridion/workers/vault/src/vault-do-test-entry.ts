// TEST-ONLY worker entry point — NOT part of the production API surface,
// analogous in spirit to `scripts/p0-exit-drill.ts`'s "DEV-ONLY TOOLING"
// stance (see that file's header). Bundled via the sibling
// `wrangler.vault-do-test.jsonc` config (deliberately separate from the
// real `wrangler.jsonc`/`src/index.ts` — this file changes neither) and
// driven by `wrangler dev` from `vault-do.hibernation.test.ts` (plan Risk
// #13's real-runtime WebSocket Hibernation coverage).
//
// Deliberately thinner than `index.ts`: forwards straight into VaultDO's
// own `fetch()` with NO Cloudflare Access check — matching `vault-do.ts`'s
// own header comment ("This method assumes it's already been
// authenticated; it does not itself re-check") and keeping this test
// bundle free of `jose`/GraphQL/gatekeeper-google Service Binding wiring
// that Risk #13's WebSocket Hibernation question has nothing to do with
// (Access itself already has its own real-JWT-round-trip coverage in
// `access-auth.test.ts`).
//
// `vaultId` query param (real routes have no equivalent — `vault-stub.ts`
// hardcodes a single `"default"` DO name for the real single-vault P0
// design): lets each test give its WebSocket connections an isolated
// VaultDO instance within the same running `wrangler dev` process, so
// tests don't see each other's catalog/doc writes.
export { VaultDO } from "./vault-do";

interface Env {
  VAULT_DO: DurableObjectNamespace;
  BLOBS: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const id = env.VAULT_DO.idFromName(url.searchParams.get("vaultId") ?? "default");
    const stub = env.VAULT_DO.get(id);
    return stub.fetch(request);
  },
};
