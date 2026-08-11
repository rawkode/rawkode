// @enchiridion/worker-vault — shared "which VaultDO instance" resolver.
//
// Every call site that needs a `DurableObjectStub<VaultDO>` (the `/sync`
// and `/blobs/*` routes and the `scheduled()` cron handler in `./index.ts`,
// plus `./graphql/yoga.ts`'s `context()`) resolves it via
// `env.VAULT_DO.idFromName("default")` — a single, fixed DO name. This is a
// deliberate single-vault placeholder for the P0 single-user case, not a
// multi-vault design: a future multi-vault retrofit (deriving the DO name
// from a URL path segment or an Access-identity claim instead of a
// constant) only needs to change this one function, not every call site
// that previously repeated the literal inline.

import type { VaultDO } from "./vault-do";

/** The env shape every call site of `defaultVaultStub` already has —
 *  structurally identical to `Env["VAULT_DO"]` in `./index.ts` and
 *  `./graphql/yoga.ts`. */
export interface DefaultVaultEnv {
  VAULT_DO: DurableObjectNamespace<VaultDO>;
}

/** Resolves the stub for the one VaultDO instance this worker talks to
 *  today. See this file's header comment for why `"default"` is a
 *  placeholder, not a multi-vault design. */
export function defaultVaultStub(env: DefaultVaultEnv): DurableObjectStub<VaultDO> {
  const id = env.VAULT_DO.idFromName("default");
  return env.VAULT_DO.get(id);
}
