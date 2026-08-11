// @enchiridion/gadget-vault-rpc-contract
//
// Shared, types-only contract for the slice of `VaultDO`'s RPC surface that
// `workers/gadget-host`'s `graph.query`/`graph.propose` capabilities call
// over a cross-script Durable Object binding to `workers/vault` (mirrors
// `@enchiridion/vault-rpc-contract`'s existing gatekeeper-google <-> vault
// contract, and `workers/gatekeeper-google/src/vault-client.ts`'s file
// header for the full "why a types-only package, not a runtime import"
// rationale — repeated only in brief here).
//
// SCOPE / WHY A SEPARATE PACKAGE FROM `@enchiridion/vault-rpc-contract`:
// that package's own header states its scope deliberately: "only the RPC
// methods gatekeeper-google actually calls ... adding an unused contract
// here would just be more surface to keep in sync for no real safety gain."
// gadget-host calls a DIFFERENT slice of VaultDO's RPC surface — the typed,
// batched ACCESSOR methods (`getPage`, `getPages`, `listPages`,
// `getNodeWithFacts`, `getNodesWithFacts`, `listNodesByTag`,
// `getRelationTargets`, `getRelationSources`) that back `graph.query`'s
// pre-defined view allowlist (plan §Gadgets: "pre-defined parameterized
// views only — untrusted gadget code never sends free-form SQL") — NEVER
// `VaultDO.query()`, the free-form bounded-SQL RPC device/GraphQL/assistant
// callers use. Respecting `vault-rpc-contract`'s own scoping principle means
// this is a new package, not an addition there.
//
// `createOrUpdatePage`/`tombstonePage` (the write side, used by
// `graph.propose()`'s execution step once a proposal is approved) ARE
// re-exported from `@enchiridion/vault-rpc-contract` rather than redefined
// here — that contract already covers exactly this method pair and is
// already the enforced source of truth on VaultDO's side
// (`workers/vault/src/vault-do.ts`'s `createOrUpdatePage`/`tombstonePage`
// signatures are literally typed against it), so redefining a second,
// unlinked copy would be the exact drift risk both contract packages exist
// to prevent.
//
// NO VaultDO CHANGE REQUIRED: every method below is EXISTING VaultDO RPC
// surface (`workers/vault/src/vault-do.ts`) — `graph.query`'s "curated
// subset of supertag-accessors.ts's existing typed methods" option (plan
// §Gadgets task brief) is the integration this package encodes, so
// `workers/vault/src/` needed no additive method for reads. Writes reuse
// the SAME `createOrUpdatePage` RPC gatekeeper-google's materializers
// already use (see `graph-propose-capability.ts`'s file header) — also no
// VaultDO change.
//
// Direction of source of truth: unlike `vault-rpc-contract` (whose types
// are imported directly into `vault-do.ts`'s own method signatures via a
// destructured rest parameter), these READ accessor methods' return types
// live in `@enchiridion/graphql-composer` (`SupertagNodeRecord`,
// `SupertagListOptions`, `SupertagListResult`) and `workers/vault/src/
// query-accessors.ts` (`PageAccessorRow`, `ListPagesOptions`,
// `ListPagesResult`) — this package re-declares them structurally
// (matching those two modules' shapes field-for-field, verified against
// `workers/vault/src/vault-do.ts`'s real method signatures as of this
// pass) rather than importing across the workspace boundary, because
// `workers/vault/src/query-accessors.ts` is a worker-internal module, not a
// published package, and `@enchiridion/graphql-composer`'s own types are
// already re-exported publicly — importing THOSE directly (rather than
// re-declaring) is done below where possible to minimize drift surface.

import type {
  CreateOrUpdatePageParams,
  CreateOrUpdatePageResult,
  TombstonePageParams,
  TombstonePageResult,
} from "@enchiridion/vault-rpc-contract";

export type {
  CreateOrUpdatePageParams,
  CreateOrUpdatePageResult,
  TombstonePageParams,
  TombstonePageResult,
} from "@enchiridion/vault-rpc-contract";

/** Mirrors `workers/vault/src/query-accessors.ts`'s `PageAccessorRow` —
 *  `VaultDO.getPage`/`getPages`/`listPages`'s real row shape. */
export interface GadgetPageAccessorRow {
  id: string;
  kind: string;
  title: string;
  createdAt: number;
  modifiedAt: number;
  deletedAt: number | null;
}

export interface GadgetListPagesOptions {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
}

export interface GadgetListPagesResult {
  items: GadgetPageAccessorRow[];
  nextCursor: string | null;
}

/** Mirrors `@enchiridion/graphql-composer`'s `SupertagNodeRecord` —
 *  `VaultDO.getNodeWithFacts`/`getNodesWithFacts`/`listNodesByTag`'s real
 *  row shape. */
export interface GadgetSupertagNodeRecord {
  id: string;
  tagIDs: readonly string[];
  createdAt: number;
  modifiedAt: number;
  deletedAt: number | null;
  facts: Readonly<Record<string, unknown>>;
}

export interface GadgetSupertagListOptions {
  limit?: number;
  cursor?: string;
}

/** Mirrors `workers/vault/src/supertag-accessors.ts`'s
 *  `SupertagAccessorFilterOptions` — the P4 adversarial-review privacy-gate
 *  fix (plan §Gadgets: "graph.query ... must itself be personVisibility-
 *  aware"). Additive, optional parameter on the three methods below that
 *  can return a Person-shaped node; `workers/gadget-host/src/
 *  graph-query-views.ts` is the only caller that actually sets it (with
 *  `excludePersonVisibility: ["other"]`), on the `nodeWithFacts`/
 *  `nodesWithFacts`/`nodesByTag` views. See that VaultDO-side file's
 *  header for the full trusted-path-vs-gadget-path rationale — this
 *  package just carries the type across the cross-script DO binding. */
export interface GadgetVaultAccessorFilterOptions {
  excludePersonVisibility?: readonly string[];
}

export interface GadgetSupertagListResult {
  items: GadgetSupertagNodeRecord[];
  nextCursor: string | null;
}

/** Mirrors `VaultDO`'s real method list this package covers — the
 *  structural type `workers/gadget-host/src/vault-accessor-client.ts`
 *  narrows its cross-script `DurableObjectStub` to. Method names/arities
 *  match `workers/vault/src/vault-do.ts` exactly as of this pass; a future
 *  VaultDO signature change either updates this package (and gadget-host
 *  picks it up) or is caught the same way `vault-rpc-contract`'s header
 *  describes (vault's own `tsc --build` breaks first if VaultDO's methods
 *  were routed through these types directly — they are NOT, for the
 *  "worker-internal module, not imported" reason above, so this package's
 *  guarantee is weaker than `vault-rpc-contract`'s: a drift here is only
 *  caught by `gadget-host`'s own tests/typecheck against its structural
 *  cast, not by VaultDO's build. Documented, not silently assumed). */
export interface GadgetVaultAccessorStub {
  getPage(id: string): Promise<GadgetPageAccessorRow | undefined>;
  getPages(ids: string[]): Promise<GadgetPageAccessorRow[]>;
  listPages(options?: GadgetListPagesOptions): Promise<GadgetListPagesResult>;
  getNodeWithFacts(
    id: string,
    options?: GadgetVaultAccessorFilterOptions,
  ): Promise<GadgetSupertagNodeRecord | undefined>;
  getNodesWithFacts(ids: string[], options?: GadgetVaultAccessorFilterOptions): Promise<GadgetSupertagNodeRecord[]>;
  listNodesByTag(
    tagID: string,
    options?: GadgetSupertagListOptions & GadgetVaultAccessorFilterOptions,
  ): Promise<GadgetSupertagListResult>;
  getRelationTargets(relationID: string, sourceNodeIDs: string[]): Promise<Record<string, string[]>>;
  getRelationSources(relationID: string, targetNodeIDs: string[]): Promise<Record<string, string[]>>;

  /** The write side — `graph.propose()`'s execution step, once an approval
   *  is confirmed, pushes its built Loro update through this exact method
   *  (see this file's header on why it's re-exported from
   *  `vault-rpc-contract` rather than redefined). Same method
   *  `workers/gatekeeper-google/src/vault-client.ts`'s materializers call. */
  createOrUpdatePage(...args: CreateOrUpdatePageParams): Promise<CreateOrUpdatePageResult>;
  tombstonePage(...args: TombstonePageParams): Promise<TombstonePageResult>;
}
