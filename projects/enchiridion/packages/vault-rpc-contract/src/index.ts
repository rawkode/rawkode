// @enchiridion/vault-rpc-contract
//
// Shared, types-only contract for the slice of `VaultDO`'s RPC surface that
// `workers/gatekeeper-google` calls over the cross-script Durable Object
// binding configured in its `wrangler.jsonc` (`VAULT`, `script_name:
// "enchiridion-vault"`). See `workers/gatekeeper-google/src/vault-client.ts`'s
// file header for why that binding is typed as a plain, unparameterized
// `DurableObjectNamespace`/`DurableObjectStub` rather than
// `DurableObjectNamespace<VaultDO>` — this package exists to close the gap
// that leaves: previously `vault-client.ts` hand-maintained a structural
// `VaultDOStub` interface with NO compile-time link back to `VaultDO`'s real
// methods, so a future signature change in vault (reordered/retyped
// parameters, not just a rename — Workers RPC already fails loudly on a
// rename) could silently corrupt data at the RPC boundary instead of
// failing a build.
//
// Direction of the source of truth: `workers/vault/src/vault-do.ts` imports
// these types DIRECTLY INTO its own method signatures (via a destructured
// rest parameter, e.g. `async createOrUpdatePage(...[pageID, docType,
// updateBytesBase64]: CreateOrUpdatePageParams)`), so VaultDO's own real
// method signature IS this contract, enforced by vault's own `tsc --build`.
// If a future vault change reorders/retypes a parameter without updating
// this package, vault's OWN build breaks — the strongest guarantee
// available given the two workers are independently deployed with no
// runtime dependency on each other. `vault-client.ts` then imports the SAME
// types for `VaultDOStub`, so real drift becomes a compile-time TypeScript
// error at the gatekeeper-google call site too, not a silent runtime
// mismatch through its `as unknown as VaultDOStub` narrowing cast.
//
// Scope: only the RPC methods gatekeeper-google actually calls
// (`createOrUpdatePage`, `tombstonePage` — see `vault-client.ts`). VaultDO's
// much larger RPC surface (`query`, `getPage`, `listPages`,
// `getNodeWithFacts`, ...) has no cross-worker caller today and stays
// un-shared until one exists — adding an unused contract here would just be
// more surface to keep in sync for no real safety gain.
//
// Parameter shapes are exported as TUPLE types (not object/options bags)
// because both RPC methods take positional arguments over the wire — a
// tuple type lets each side spread it into a real parameter list (a
// destructured rest parameter on the vault-do.ts side, `...args:
// CreateOrUpdatePageParams` on the vault-client.ts side) instead of just
// asserting structural compatibility after the fact.

/** Mirrors `VaultDO.createOrUpdatePage`'s real parameter list
 *  (`workers/vault/src/vault-do.ts`). `updateBytesBase64` is a
 *  base64-encoded Loro update (or snapshot) blob — matching the sync
 *  protocol's own encoding, so a client's outbox can reuse the exact same
 *  encoding for both the WebSocket path and this direct RPC path. */
export type CreateOrUpdatePageParams = [pageID: string, docType: string, updateBytesBase64: string];

/** Mirrors `VaultDO.createOrUpdatePage`'s real return shape. */
export type CreateOrUpdatePageResult = { applied: boolean };

/** Mirrors `VaultDO.tombstonePage`'s real parameter list. */
export type TombstonePageParams = [pageID: string];

/** Mirrors `VaultDO.tombstonePage`'s real return shape. */
export type TombstonePageResult = { tombstoned: boolean };
