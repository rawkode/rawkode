// @enchiridion/worker-vault — the composed GraphQL schema: every supertag
// type from `@enchiridion/graphql-composer` (built off the ONE loaded
// module, `supertags/core` — `supertag-registry.ts`), PLUS the P0
// hand-written generic `Page` type from `./schema.ts`, merged onto ONE
// Pothos builder and served as ONE `GraphQLSchema` at `/graphql`.
//
// MERGE DECISION — Page and the supertag types are COMPLEMENTARY, not
// overlapping, so both are kept, composed together rather than one
// replacing the other:
//   - `Page` is a generic, doc-type-agnostic view over `graph_nodes` (id/
//     kind/title/timestamps only) — it resolves for ANY page, including
//     one with no supertag at all (a bare untyped capture — PRODUCT.md's
//     "literal capture first, interpretation later" principle, plan
//     §Native apps).
//   - `Person`/`Task`/`Project`/... (from `graphql-composer`) are richer,
//     per-supertag views with typed fields and relation traversal
//     (`task.project.name`) — they only resolve for a page that actually
//     carries that supertag.
//   A page tagged `task` is simultaneously a valid `Page` (via
//   `page(id:)`) and a valid `Task` (via `task(id:)`) — same underlying
//   `graph_nodes` row, two different field sets over it. Neither schema
//   subsumes the other (Page has no relation fields or typed properties;
//   Task has no "works for literally any doc" guarantee), so this file
//   composes them into one servable schema rather than picking one.
//
// HOW THE MERGE WORKS — `composePothosConfig()` builds and returns its OWN
// `SchemaBuilder` (`packages/graphql-composer/src/index.ts`'s
// `ComposedPothosConfig.builder`), documented there as safe to keep
// extending "before calling .toSchema() again (e.g. a future mutation
// pass)". This file does exactly that: takes the returned `builder`,
// implements `Page`/`PageConnection` on it (verbatim port of
// `./schema.ts`'s hand-written definitions), adds `page`/`pages` root
// fields via `builder.queryFields(...)` (Pothos's documented
// incremental-add API — `@pothos/core`'s `SchemaBuilder.queryFields`,
// distinct from the one-time `queryType()` `composePothosConfigFromRegistry`
// already called), then calls `builder.toSchema()` a second time to get an
// updated `GraphQLSchema` that includes both halves. No schema-stitching
// library, no second HTTP round trip, no gateway — one Pothos builder, one
// schema, matching the plan's "no gateway, no federation" pin even while
// composing two logically-separate field sets.
//
// CONTEXT TYPE CAST — `composePothosConfig()`'s builder is generically
// typed to `GraphQLComposerContext` (`{ vault: SupertagAccessors }`,
// `packages/graphql-composer/src/accessors.ts`), so field resolvers added
// here see `ctx.vault` typed as `SupertagAccessors` only — it has no
// `getPage`/`listPages` methods (those are `VaultAccessors`,
// `./schema.ts`). The REAL context object `./yoga.ts` builds always
// satisfies BOTH interfaces (`ComposedVaultContext` below,
// `SupertagAccessors & VaultAccessors`) — the cast in `page`/`pages`'
// resolvers below is a narrow, one-boundary widening of that already-true
// runtime shape back to its full type, not a general escape hatch.

import { createBatchLoader, composePothosConfig, type GraphQLComposerContext, type SupertagAccessors } from "@enchiridion/graphql-composer";
import type { EmailAttachmentDTO, EmailMessageDTO } from "@enchiridion/gatekeeper-google-rpc-contract";
import coreSupertagsModule from "@enchiridion/supertags-core";
import emailSupertagsModule, { EmailSupertagIDs } from "@enchiridion/supertags-email";
import type { GraphQLSchema } from "graphql";
import type { ListPagesOptions, ListPagesResult, PageAccessorRow } from "../query-accessors";
import type { VaultAccessors } from "./schema";

export type { VaultAccessors } from "./schema";

/** The gatekeeper-google-backed half of the composed context — server-only
 *  data (plan: "Message bodies stay out of the CRDT graph") reached over a
 *  Cloudflare Service Binding, never vault's own SQL. `./yoga.ts` is the
 *  only place that implements this for real (an `env.GATEKEEPER_GOOGLE
 *  .fetch(...)` call per method, parsing `@enchiridion/gatekeeper-google-
 *  rpc-contract`'s response DTOs) — this file's resolvers below (and
 *  `email-fields.test.ts`) only ever depend on this narrow interface, the
 *  same "resolvers call a typed accessor contract, never own the transport"
 *  split `SupertagAccessors`/`VaultAccessors` already establish. */
export interface GatekeeperGoogleAccessors {
  /** Batched per GraphQL operation (plan Risk #11) — see
   *  `@enchiridion/gatekeeper-google-rpc-contract`'s
   *  `GetMessagesForThreadsParams` doc comment. A thread page id with no
   *  stored messages is absent from the returned map (same "absence means
   *  empty" convention every other accessor in this codebase follows). */
  getMessagesForThreads(threadPageIDs: readonly string[]): Promise<ReadonlyMap<string, EmailMessageDTO[]>>;
  searchEmail(query: string, limit?: number): Promise<EmailMessageDTO[]>;
}

/** The real context shape `./yoga.ts` builds at request time — a single
 *  `vault` object satisfying both `SupertagAccessors` (what
 *  `graphql-composer`'s generated fields are written against) and
 *  `VaultAccessors` (what the hand-written `Page`/`PageConnection` fields
 *  below are written against), PLUS `gatekeeperGoogle` for the server-only
 *  Gmail fields (`EmailThread.messages`/`Query.emailSearch`, below). */
export interface ComposedVaultContext {
  vault: SupertagAccessors & VaultAccessors;
  gatekeeperGoogle: GatekeeperGoogleAccessors;
}

/** Widens a plain `GraphQLComposerContext` (what `graphql-composer`'s
 *  generated resolvers statically see `ctx` as) to the real, wider runtime
 *  shape — same "CONTEXT TYPE CAST" pattern this file's header already
 *  documents for `asVaultAccessors` below, applied to the `gatekeeperGoogle`
 *  key instead of widening `vault` itself. */
function asComposedContext(ctx: GraphQLComposerContext): ComposedVaultContext {
  return ctx as unknown as ComposedVaultContext;
}

const composed = composePothosConfig([coreSupertagsModule, emailSupertagsModule]);
const builder = composed.builder;

/** Re-export so a caller (yoga.ts, tests) can inspect what
 *  `graphql-composer` generated without re-running `composePothosConfig`
 *  itself — same registry/type-name maps `ComposedPothosConfig` exposes. */
export const composedRegistry = composed.registry;
export const typeNameForTagID = composed.typeNameForTagID;
export const queryFieldNameForTagID = composed.queryFieldNameForTagID;

// ---------------------------------------------------------------------
// `Page` / `PageConnection` / `Query.page` / `Query.pages` — a verbatim
// port of `./schema.ts`'s hand-written P0 definitions onto the composed
// builder. See this file's header ("CONTEXT TYPE CAST") for why the
// resolvers below cast `ctx.vault`.
// ---------------------------------------------------------------------

const PageRef = builder.objectRef<PageAccessorRow>("Page").implement({
  description:
    "A vault page, projected from its graph_nodes row — resolves for ANY doc type, including one with no loaded supertag (see composed-schema.ts's merge decision).",
  fields: (t) => ({
    id: t.exposeString("id", { nullable: false }),
    kind: t.exposeString("kind", { nullable: false }),
    title: t.exposeString("title", { nullable: false }),
    createdAt: t.exposeFloat("createdAt", { nullable: false }),
    modifiedAt: t.exposeFloat("modifiedAt", { nullable: false }),
    deletedAt: t.exposeFloat("deletedAt", { nullable: true }),
  }),
});

const PageConnectionRef = builder.objectRef<ListPagesResult>("PageConnection").implement({
  description: "A single page of `pages(...)` results.",
  fields: (t) => ({
    items: t.field({ type: [PageRef], nullable: false, resolve: (parent) => parent.items }),
    nextCursor: t.string({ nullable: true, resolve: (parent) => parent.nextCursor }),
  }),
});

/** Widens `ctx.vault` back to the real runtime shape — see this file's
 *  header, "CONTEXT TYPE CAST". */
function asVaultAccessors(vault: SupertagAccessors): VaultAccessors {
  return vault as unknown as VaultAccessors;
}

builder.queryFields((t) => ({
  page: t.field({
    type: PageRef,
    nullable: true,
    args: { id: t.arg.string({ required: true }) },
    resolve: (_root, args, ctx) => asVaultAccessors(ctx.vault).getPage(args.id),
  }),
  pages: t.field({
    type: PageConnectionRef,
    nullable: false,
    args: {
      limit: t.arg.int({ required: false }),
      cursor: t.arg.string({ required: false }),
      includeDeleted: t.arg.boolean({ required: false }),
    },
    resolve: (_root, args, ctx): Promise<ListPagesResult> => {
      const options: ListPagesOptions = {
        limit: args.limit ?? undefined,
        cursor: args.cursor ?? undefined,
        includeDeleted: args.includeDeleted ?? undefined,
      };
      return asVaultAccessors(ctx.vault).listPages(options);
    },
  }),
}));

// ---------------------------------------------------------------------
// `EmailMessage` / `EmailAttachment` / `EmailThread.messages` /
// `Query.emailSearch` — the server-only Gmail fields (plan §"Cross-worker
// field resolution" + §Google gatekeeper Gmail section: "served via
// server-only GraphQL fields (`thread.messages`, `emailSearch`)").
//
// `EmailMessage`/`EmailAttachment` are HAND-WRITTEN plain-data Pothos types
// (like `Page`/`PageConnection` above), not `graphql-composer`-generated —
// they resolve directly over `@enchiridion/gatekeeper-google-rpc-contract`'s
// DTOs, never over a `SupertagNodeRecord`/`graph_facts` row, since this data
// never enters the graph at all.
//
// `EmailThread.messages` is added onto the ALREADY-COMPOSED `EmailThread`
// Pothos type via `builder.objectFields(...)` — the exact mechanism
// `graphql-composer`'s own Pass 3 uses internally for backlink fields
// (`packages/graphql-composer/src/index.ts`), now exposed past that
// package's return value via `ComposedPothosConfig.objectRefForTagID` (see
// that field's doc comment) specifically so a field a supertag module
// itself doesn't declare (server-only, cross-worker) can still be attached
// to a composed type. `EmailSupertagIDs.emailThread` must be a real
// loaded/composed supertag id for this lookup to succeed — see
// `supertag-registry.ts`'s header for why `@enchiridion/supertags-email` is
// now loaded here specifically to make this true.
// ---------------------------------------------------------------------

const EmailAttachmentRef = builder.objectRef<EmailAttachmentDTO>("EmailAttachment").implement({
  description: "One attachment part of an EmailMessage, content-addressed into gatekeeper-google's own R2 bucket.",
  fields: (t) => ({
    blobId: t.exposeString("blobID", { nullable: false }),
    filename: t.exposeString("filename", { nullable: true }),
    mimeType: t.exposeString("mimeType", { nullable: true }),
    size: t.exposeFloat("size", { nullable: false }),
  }),
});

const EmailMessageRef = builder.objectRef<EmailMessageDTO>("EmailMessage").implement({
  description:
    "One Gmail message's full content (headers + body) — server-only data that never enters the CRDT graph (plan: \"Message bodies stay out of the CRDT graph\").",
  fields: (t) => ({
    id: t.exposeString("id", { nullable: false }),
    threadPageId: t.exposeString("threadPageID", { nullable: false }),
    from: t.exposeString("from", { nullable: true }),
    to: t.exposeString("to", { nullable: true }),
    cc: t.exposeString("cc", { nullable: true }),
    subject: t.exposeString("subject", { nullable: true }),
    date: t.exposeString("date", { nullable: true }),
    bodyText: t.exposeString("bodyText", { nullable: true }),
    bodyHtml: t.exposeString("bodyHtml", { nullable: true }),
    receivedAt: t.exposeFloat("receivedAt", { nullable: false }),
    attachments: t.field({
      type: [EmailAttachmentRef],
      nullable: false,
      resolve: (parent) => parent.attachments,
    }),
  }),
});

/** Per-GraphQL-request batching loader cache for `EmailThread.messages` —
 *  same `WeakMap<context, loader>` scoping convention
 *  `request-loaders.ts`'s `relationTargetLoaderFor`/`relationSourceLoaderFor`
 *  already use (keyed off the context object, which `graphql-yoga`
 *  constructs fresh per request), so N sibling `EmailThread` selections in
 *  ONE query still make exactly one `getMessagesForThreads` call —
 *  `createBatchLoader` (`@enchiridion/graphql-composer`, re-exported from
 *  `request-loaders.ts`) is the same microtask-coalescing primitive every
 *  other batched relation field in this schema already uses. */
const messagesLoaderCache = new WeakMap<GraphQLComposerContext, (threadPageID: string) => Promise<EmailMessageDTO[] | undefined>>();

function messagesLoaderFor(ctx: GraphQLComposerContext): (threadPageID: string) => Promise<EmailMessageDTO[] | undefined> {
  const existing = messagesLoaderCache.get(ctx);
  if (existing) return existing;

  const gatekeeperGoogle = asComposedContext(ctx).gatekeeperGoogle;
  const loader = createBatchLoader<string, EmailMessageDTO[]>((threadPageIDs) =>
    gatekeeperGoogle.getMessagesForThreads(threadPageIDs),
  );
  messagesLoaderCache.set(ctx, loader);
  return loader;
}

const emailThreadRef = composed.objectRefForTagID.get(EmailSupertagIDs.emailThread);
if (!emailThreadRef) {
  throw new Error(
    `composed-schema.ts: expected "${EmailSupertagIDs.emailThread}" to be a composed supertag type (is @enchiridion/supertags-email loaded in supertag-registry.ts's LOADED_SUPERTAG_MODULES?) — cannot attach EmailThread.messages`,
  );
}

builder.objectFields(emailThreadRef, (t) => ({
  messages: t.field({
    type: [EmailMessageRef],
    nullable: false,
    description: "Full message content for this thread (server-only — gatekeeper-google's own DO SQLite, never the CRDT graph).",
    resolve: async (parent, _args, ctx) => (await messagesLoaderFor(ctx)(parent.id)) ?? [],
  }),
}));

builder.queryFields((t) => ({
  emailSearch: t.field({
    type: [EmailMessageRef],
    nullable: false,
    description: "Full-text-ish search over ingested Gmail message bodies (server-only — see gatekeeper-google's gmail-body-store.ts for the LIKE-based search strategy chosen for this pass).",
    args: {
      query: t.arg.string({ required: true }),
      limit: t.arg.int({ required: false }),
    },
    resolve: (_root, args, ctx) => asComposedContext(ctx).gatekeeperGoogle.searchEmail(args.query, args.limit ?? undefined),
  }),
}));

/** The final merged schema: every `graphql-composer`-generated supertag
 *  type/field (Person, Organization, Company, Event, Area, Project, Task,
 *  Place, EmailThread, and their relation fields) PLUS `Page`/
 *  `PageConnection`/`Query.page`/`Query.pages`/`EmailMessage`/
 *  `EmailAttachment`/`EmailThread.messages`/`Query.emailSearch` above, all
 *  on one `GraphQLSchema`. */
export const schema: GraphQLSchema = builder.toSchema();
