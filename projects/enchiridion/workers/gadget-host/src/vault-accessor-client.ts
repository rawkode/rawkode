// @enchiridion/worker-gadget-host — thin client for VaultDO's EXISTING
// typed accessor + write-model RPC surface, reached over a cross-script
// Durable Object binding (`VAULT`, `script_name: "enchiridion-vault"` —
// see wrangler.jsonc's comment).
//
// Mirrors `workers/gatekeeper-google/src/vault-client.ts` almost exactly —
// same "local, minimal, structural stub type; types imported from a shared
// contract package; one cast at the one point RPC is dispatched" pattern
// (see that file's header for the full rationale, not restated here).
//
// NO VaultDO CHANGE: every method this client calls is EXISTING VaultDO RPC
// surface (`getPage`, `getPages`, `listPages`, `getNodeWithFacts`,
// `getNodesWithFacts`, `listNodesByTag`, `getRelationTargets`,
// `getRelationSources`, `createOrUpdatePage`) — see
// `@enchiridion/gadget-vault-rpc-contract`'s file header for why
// `graph.query`/`graph.propose` needed no additive VaultDO method at all.

import type { GadgetVaultAccessorStub } from "@enchiridion/gadget-vault-rpc-contract";

export type { GadgetVaultAccessorStub } from "@enchiridion/gadget-vault-rpc-contract";

export interface VaultClientEnv {
  VAULT: DurableObjectNamespace;
}

/** Resolves the stub for the one VaultDO instance this vault manages —
 *  `idFromName("default")`, the SAME fixed name every other worker in this
 *  system uses (`workers/vault/src/vault-stub.ts`,
 *  `workers/gatekeeper-google/src/vault-client.ts`) — so gadget reads/
 *  writes land in the exact same VaultDO instance a device's `/sync`
 *  WebSocket talks to. */
export function defaultVaultAccessorStub(env: VaultClientEnv): GadgetVaultAccessorStub {
  const id = env.VAULT.idFromName("default");
  return env.VAULT.get(id) as unknown as GadgetVaultAccessorStub;
}
