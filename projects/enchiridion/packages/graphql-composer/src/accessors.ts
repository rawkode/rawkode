// @enchiridion/graphql-composer — the typed accessor CONTRACT this
// package's generated resolvers are written against.
//
// Plan §Backend architecture, "Query surfaces — two, not one": vault's
// Pothos resolvers call typed, batched accessor RPC methods, never
// `vault.query()`'s bounded free-form SQL — see
// `workers/vault/src/query-accessors.ts` (the `getPage`/`getPages`/
// `listPages` precedent this file generalizes) and
// `workers/vault/src/graphql/schema.ts`'s `VaultAccessors` (the P0
// hand-written example this generalizes across every supertag, not just
// `Page`).
//
// `SupertagAccessors` does NOT exist as a real VaultDO RPC surface yet —
// per this task's brief, that's `packages/projection` + a VaultDO-wiring
// task, still in progress as of this pass (see `packages/projection/src/
// index.ts`'s skeleton). This interface is the CONCRETE CONTRACT that
// wiring task must implement: every method here is shaped the way it is
// specifically so `index.ts`'s generated resolvers can call it correctly
// today, against a fake/in-memory implementation in tests (see
// `index.test.ts`), and so the eventual VaultDO-backed implementation is a
// drop-in swap, not a redesign.
//
// Batching (plan Risk #11, "DO-RPC-per-field N+1"): every method that can
// be called once per node in a GraphQL selection set takes an ARRAY of
// keys and returns a map/array keyed by those ids — `getNodesWithFacts`,
// `getRelationTargets`, `getRelationSources`. `index.ts`'s generated
// resolvers never call these directly per-field; they go through
// `request-loaders.ts`'s per-GraphQL-request microtask-coalescing loaders,
// so N sibling fields resolving the same relation across a list of nodes
// still make exactly one batched call into whatever implements this
// interface — the batching contract is enforced at the resolver-generation
// layer, not left as a caller convention the VaultDO wiring task has to
// remember to honor.

/** The shape of one graph node ("page") plus its EFFECTIVE-SCHEMA facts —
 *  the "typed accessor" analog of `PageAccessorRow`
 *  (`workers/vault/src/query-accessors.ts`), generalized from `Page`'s
 *  fixed 6 columns to every supertag's arbitrary field set.
 *
 *  `facts` is keyed by the SAME string `@enchiridion/schema`'s
 *  `propertyKeyToString({supertagID, fieldID})` produces
 *  (`packages/schema/src/inheritance.ts`) — reusing that exact helper
 *  (not a parallel encoding) is what lets a field inherited from an
 *  ancestor supertag (e.g. `Company.website`, declared on `Organization`)
 *  resolve against the SAME storage key regardless of which supertag's
 *  GraphQL type the query asked through, matching
 *  `GraphDataModel.md`'s `graph_facts` contract: "Predicate identity is
 *  stable even when a field is renamed" (and, by the same logic, stable
 *  across which subtype queried it). A fact's JS value shape follows its
 *  `SupertagFieldType`: `text`/`url`/`email`/`phone`/`select` -> `string`;
 *  `number` -> `number`; `boolean` -> `boolean`; `date`/`dateTime` ->
 *  `number` (epoch-milliseconds, matching `Page.createdAt`'s `Float!`
 *  convention — see index.ts's field-mapping comment). A field with
 *  `allowsMultiple: true` stores an array of that same per-value shape.
 *  `entityReference` fields are NEVER present in `facts` — they resolve
 *  through `getRelationTargets`/`getRelationSources` against
 *  `graph_edges`, not through `graph_facts` (`GraphDataModel.md`: "A
 *  relationship is one source-owned canonical edge ... A backlink is the
 *  inverse projection of an incoming canonical edge. It is never a second
 *  mutable record."). A key simply absent from `facts` means "no value
 *  set for that property on this node" — resolvers treat that the same as
 *  an explicit `null`/empty-list, never an error. */
export interface SupertagNodeRecord {
  id: string;
  /** Every supertag id directly assigned to this node (`graph_node_tags`),
   *  NOT the effective/closure set — used only to pick a concrete GraphQL
   *  object type out of a union when an `entityReference` field's
   *  `allowedSupertagIDs` names more than one supertag (see
   *  `resolveEndpointType` in index.ts.) Most resolvers never touch this
   *  field directly. */
  tagIDs: readonly string[];
  createdAt: number;
  modifiedAt: number;
  deletedAt: number | null;
  facts: Readonly<Record<string, unknown>>;
}

export interface SupertagListOptions {
  limit?: number;
  cursor?: string;
}

export interface SupertagListResult {
  items: SupertagNodeRecord[];
  nextCursor: string | null;
}

/** The typed accessor surface every generated root/relation resolver in
 *  this package is written against — the CONTRACT for the VaultDO-wiring
 *  task (see this file's header). A GraphQL context satisfying
 *  `GraphQLComposerContext` (below) provides one of these as `.vault`; in
 *  `workers/vault`, this is expected to become the same kind of thin
 *  RPC-method adapter `workers/vault/src/graphql/yoga.ts`'s `context()`
 *  already builds for `VaultAccessors` — resolving a real
 *  `DurableObjectStub<VaultDO>` and forwarding each method below to a
 *  correspondingly-named VaultDO RPC method backed by
 *  `packages/projection`'s `graph_nodes`/`graph_facts`/`graph_edges`
 *  tables (`Documentation/GraphDataModel.md`). Nothing in this package
 *  resolves a `DurableObjectStub` itself — same separation `schema.ts` /
 *  `yoga.ts` already have for `Page`. */
export interface SupertagAccessors {
  /** Single-node lookup by id, with every effective-schema fact attached.
   *  Mirrors `getPage(id)`. Root singular query fields (`person(id:
   *  ...)`) call this directly — one accessor call per root field, not a
   *  concern for Risk #11 since there's exactly one such call per
   *  operation regardless of selection-set shape. */
  getNodeWithFacts(id: string): Promise<SupertagNodeRecord | undefined>;

  /** Batched multi-node lookup — mirrors `getPages(ids)`. This is what
   *  `request-loaders.ts`'s node loader calls once per GraphQL operation
   *  (coalescing every relation-field resolution across the whole query),
   *  not what individual field resolvers call directly. Unknown ids are
   *  simply absent from the result, not an error — matches `getPages`'s
   *  contract exactly. Result order is not guaranteed to match `ids`'
   *  order; callers re-key by `.id` (again matching `getPages`). */
  getNodesWithFacts(ids: readonly string[]): Promise<SupertagNodeRecord[]>;

  /** Paginated listing of nodes carrying a given (own, non-effective)
   *  supertag id — mirrors `listPages(options)`, filtered to one tag.
   *  Root plural query fields (`people(limit: ..., cursor: ...)`) call
   *  this. Cursor semantics match `listPages`: an opaque `node_id`-shaped
   *  keyset cursor, `nextCursor: null` meaning no further page. */
  listNodesByTag(tagID: string, options?: SupertagListOptions): Promise<SupertagListResult>;

  /** Batched FORWARD canonical-edge resolution: for every `sourceNodeID`
   *  in `sourceNodeIDs`, the ordered list of node ids it points at via
   *  `relationID`'s canonical edge (`graph_edges`, `GraphDataModel.md`:
   *  "one source-owned canonical edge"). This is what an
   *  `entityReference` field's generated resolver ultimately calls
   *  (through `request-loaders.ts`'s per-relation batching loader) — e.g.
   *  `Task.project`'s resolver asks for `taskProject`'s targets from one
   *  task id, hydrates the returned target id(s) via
   *  `getNodesWithFacts`. A source id absent from the result map has no
   *  outgoing edge for that relation (not an error) — same "absence means
   *  empty, not error" convention as `getPages`. Cardinality is not
   *  re-validated here: a max-one relation is trusted to return at most
   *  one id per source (the projection/write-model's job to guarantee,
   *  per `GraphDataModel.md`'s "Concurrent maximum-one edges are
   *  preserved and surfaced as graph issues" — an accessor implementation
   *  that finds more than one live edge for a max-one relation should
   *  surface that as a `graph_issues` row, not silently truncate here). */
  getRelationTargets(
    relationID: string,
    sourceNodeIDs: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>>;

  /** Batched INVERSE canonical-edge resolution — the query-time
   *  projection backing a relation's backlink field (plan §Supertag
   *  module contract: "backlinks are projections, never materialized").
   *  For every `targetNodeID` in `targetNodeIDs`, the ordered list of
   *  source node ids whose `relationID` canonical edge points AT it. Same
   *  "absence means empty" and cardinality-trust conventions as
   *  `getRelationTargets`, mirrored for the inverse direction. */
  getRelationSources(
    relationID: string,
    targetNodeIDs: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>>;
}

/** The GraphQL context shape every field this package generates is
 *  written against — deliberately just `{ vault: SupertagAccessors }`,
 *  mirroring `VaultGraphQLContext` (`workers/vault/src/graphql/schema.ts`)
 *  exactly so a future merge of the two is a rename, not a redesign. */
export interface GraphQLComposerContext {
  vault: SupertagAccessors;
}
