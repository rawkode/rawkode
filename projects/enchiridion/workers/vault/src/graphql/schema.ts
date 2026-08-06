// @enchiridion/worker-vault — the vault GraphQL schema.
//
// Plan §Backend architecture, "GraphQL API": "vault builds a single Pothos
// schema ... and serves it via GraphQL Yoga at /graphql, directly, behind
// Cloudflare Access. There is no gateway and no `supergraph.graphql` build
// step." Pinned-technology table row "GraphQL": "Pothos-core (code-first
// schema builder; explicitly not `plugin-federation` or `plugin-drizzle`)".
//
// This is intentionally the HAND-WRITTEN P0 schema the task brief called
// for ("keep your actual vault schema minimal/hand-written directly in
// workers/vault for now") — not output from
// `@enchiridion/graphql-composer`, which is still a P1-scoped stub (see
// that package's file header). When `graphql-composer`'s
// `composePothosConfig()` becomes real in P1, this file is the concrete
// example it generalizes from: one `SchemaBuilder`, object types built
// with `builder.objectRef(...).implement(...)`, resolvers that call typed
// accessor RPC methods — no `plugin-federation`/`plugin-drizzle` anywhere
// in this file, matching the plan's correction away from the earlier
// federation-gateway design.
//
// Resolvers below call ONLY the typed, batched accessor surface
// (`../query-accessors.ts`, exposed as VaultDO RPC methods and adapted to
// `VaultAccessors` by `./yoga.ts`) — never `vault.query()` (the bounded
// free-form SQL RPC in `../query-rpc.ts`), per plan §"Query surfaces — two,
// not one": "This is what vault's Pothos resolvers actually call; it's a
// separate, narrower surface."
//
// No mutations yet — P1 follow-up (see the file-bottom comment) rather
// than forced in here, per the task brief's guidance: VaultDO's
// `createOrUpdatePage` write-model RPC takes an already-encoded Loro CRDT
// update (see `../vault-write-model.ts`'s doc comment on why bytes, not a
// content string), which isn't a natural shape for a hand-typed GraphQL
// mutation argument — a real "create/update a page over GraphQL" mutation
// needs either a CRDT-aware client generating those bytes (not this P0
// schema's caller) or a deliberately-designed plain-text/field-map input
// that then gets turned into CRDT ops server-side (undesigned, P1 scope).

import SchemaBuilder from "@pothos/core";
import type { GraphQLSchema } from "graphql";
import type { ListPagesOptions, ListPagesResult, PageAccessorRow } from "../query-accessors";

/** The typed accessor surface a GraphQL context must provide — the same
 *  shape as VaultDO's `getPage`/`listPages` RPC methods (see
 *  `../vault-do.ts`), just declared here so this schema module doesn't
 *  need to import the DO class (and so `schema.test.ts` can satisfy it
 *  with accessors wired directly to `../query-accessors.ts` functions
 *  against a test SQLite database, with no DO/Workers runtime involved —
 *  see that test file). `./yoga.ts` is the ONLY place that adapts a real
 *  `DurableObjectStub<VaultDO>` to this interface. */
export interface VaultAccessors {
  getPage(id: string): Promise<PageAccessorRow | undefined>;
  listPages(options: ListPagesOptions): Promise<ListPagesResult>;
}

export interface VaultGraphQLContext {
  vault: VaultAccessors;
}

const builder = new SchemaBuilder<{ Context: VaultGraphQLContext }>({});

/** GraphQL SDL-equivalent:
 *
 *   type Page {
 *     id: String!
 *     kind: String!
 *     title: String!
 *     createdAt: Float!
 *     modifiedAt: Float!
 *     deletedAt: Float
 *   }
 *
 * `createdAt`/`modifiedAt`/`deletedAt` are epoch-millisecond timestamps
 * (see `../schema.ts`'s `graph_nodes` DDL comment: "DO SQLite has no
 * native date type"). Exposed as `Float`, not the built-in GraphQL `Int`
 * (a 32-bit signed integer, max ~2.1 billion) — epoch-millisecond
 * "now" values are already well past that, so `Int` would silently
 * misrepresent every real timestamp. `Float` (a JS `number`/IEEE-754
 * double) represents epoch-ms integers exactly up to 2^53, decades beyond
 * any real timestamp here. */
// NOTE on nullability: Pothos-core defaults every field to NULLABLE unless
// told otherwise (the opposite of what the "SDL-equivalent" doc comments
// below would suggest at a glance) — `{ nullable: false }` is passed
// explicitly everywhere a field can never actually be null, so the real
// generated SDL (verifiable via `printSchema(schema)` from the `graphql`
// package) matches these comments exactly, not Pothos's bare defaults.
const PageRef = builder.objectRef<PageAccessorRow>("Page").implement({
  description: "A vault page, projected from its graph_nodes row.",
  fields: (t) => ({
    id: t.exposeString("id", { nullable: false }),
    kind: t.exposeString("kind", { nullable: false }),
    title: t.exposeString("title", { nullable: false }),
    createdAt: t.exposeFloat("createdAt", { nullable: false }),
    modifiedAt: t.exposeFloat("modifiedAt", { nullable: false }),
    deletedAt: t.exposeFloat("deletedAt", { nullable: true }),
  }),
});

/** GraphQL SDL-equivalent:
 *
 *   type PageConnection {
 *     items: [Page!]!
 *     nextCursor: String
 *   }
 *
 * Deliberately NOT full Relay-style cursor pagination (edges/PageInfo) —
 * task brief: "a plain list with a limit is fine for P0, don't
 * over-build". `nextCursor` is a page id to pass back as `pages(cursor:
 * ...)`'s argument for the next page; `null` means there is no more data. */
const PageConnectionRef = builder.objectRef<ListPagesResult>("PageConnection").implement({
  description: "A single page of `pages(...)` results.",
  fields: (t) => ({
    items: t.field({
      type: [PageRef],
      nullable: false,
      resolve: (parent) => parent.items,
    }),
    nextCursor: t.string({ nullable: true, resolve: (parent) => parent.nextCursor }),
  }),
});

/** GraphQL SDL-equivalent:
 *
 *   type Query {
 *     page(id: String!): Page
 *     pages(limit: Int, cursor: String, includeDeleted: Boolean): PageConnection!
 *   }
 */
builder.queryType({
  fields: (t) => ({
    page: t.field({
      type: PageRef,
      nullable: true,
      args: {
        id: t.arg.string({ required: true }),
      },
      resolve: (_root, args, ctx) => ctx.vault.getPage(args.id),
    }),
    pages: t.field({
      type: PageConnectionRef,
      nullable: false,
      args: {
        limit: t.arg.int({ required: false }),
        cursor: t.arg.string({ required: false }),
        includeDeleted: t.arg.boolean({ required: false }),
      },
      resolve: (_root, args, ctx) =>
        ctx.vault.listPages({
          limit: args.limit ?? undefined,
          cursor: args.cursor ?? undefined,
          includeDeleted: args.includeDeleted ?? undefined,
        }),
    }),
  }),
});

export const schema: GraphQLSchema = builder.toSchema();

// TODO(plan §Phasing P1, "GraphQL composition + Swift codegen" +
// packages/graphql-composer's file header): once supertag modules exist
// in a useful form, `graphql-composer`'s `composePothosConfig()` should
// generalize this file's hand-written pattern (objectRef+implement per
// supertag, resolvers over typed/batched accessors) across every loaded
// SupertagModule's `supertags`/`relations`/`resolvers`, still against one
// `SchemaBuilder`/one schema — not per-module subgraphs. A
// `createPage`/`updatePage` mutation over VaultDO's `createOrUpdatePage`
// write-model RPC is also P1 scope (see file header above for why it
// doesn't fit cleanly as a P0 add).
