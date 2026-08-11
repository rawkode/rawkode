// @enchiridion/gatekeeper-google-rpc-contract
//
// Shared, types-only contract for the REVERSE cross-worker direction from
// `@enchiridion/vault-rpc-contract`: `workers/vault`'s Pothos resolvers
// calling INTO `workers/gatekeeper-google` to resolve the server-only
// `EmailThread.messages` / `Query.emailSearch` GraphQL fields (plan
// §"Cross-worker field resolution").
//
// FIX (adversarial-review BLOCKER, plan §Google gatekeeper): this package
// used to describe an HTTP-shaped contract (`/gmail/messages`/`/gmail/search`
// request/response JSON bodies, reached via `env.GATEKEEPER_GOOGLE
// .fetch(...)`) on the theory that a Cloudflare Service Binding's `.fetch()`
// call was itself an authentication boundary. It is not — a Service
// Binding's `.fetch()` dispatches to the TARGET WORKER'S OWN PUBLIC
// `fetch()` HANDLER, so those two routes had zero application-layer auth
// (see `workers/gatekeeper-google/src/gmail-read-model.ts`'s file header
// for the full writeup). This package now describes a REAL Workers-RPC
// contract instead: `GetMessagesForThreadsParams`/`SearchEmailMessagesParams`
// mirror `GmailReadModel`'s (a `WorkerEntrypoint`,
// `workers/gatekeeper-google/src/index.ts`) real method signatures, the
// same "positional tuple type routed through both sides' real code" pattern
// `@enchiridion/vault-rpc-contract` already uses for its (also real-RPC)
// direction. `workers/vault/wrangler.jsonc`'s `GATEKEEPER_GOOGLE` binding
// now names `entrypoint: "GmailReadModel"` — Workers RPC entrypoint methods
// are not reachable via HTTP/`fetch()` at all, which is what closes the gap
// (rather than gating the old HTTP routes with a header check).
//
// Direction of the source of truth (mirrors vault-rpc-contract exactly):
// `GmailReadModel`'s real method signatures
// (`workers/gatekeeper-google/src/index.ts`, delegating to
// `gmail-read-model.ts`'s pure functions) are written against these exact
// types, so a future gatekeeper-google signature change breaks gatekeeper-
// google's OWN build first if this package isn't updated to match; vault's
// `graphql/yoga.ts` imports the SAME types for its structural
// `GmailReadModelStub` cast (the same "local minimal structural type, real
// types imported from the shared contract package" convention
// `workers/gatekeeper-google/src/vault-client.ts` already uses for the
// reverse-direction `VAULT` binding).
//
// Scope: only the two RPC methods vault's composed schema actually calls
// (`getMessagesForThreads` for `EmailThread.messages`, `searchEmailMessages`
// for `Query.emailSearch`) — mirrors vault-rpc-contract's "only what's
// actually called" scoping note.

/** One materialized Gmail message, as gatekeeper-google's own DO SQLite
 *  (`gmail_message_bodies`, `gmail_message_attachments` — see
 *  `workers/gatekeeper-google/src/schema.ts`) stores it. `threadPageID` is
 *  the VAULT PageID of the `EmailThread` page this message belongs to
 *  (`email_thread_<digest>`, `@enchiridion/graph-core`'s
 *  `deriveEmailThreadPageId`) — NOT Gmail's own raw thread id, which never
 *  leaves gatekeeper-google's own storage (plan: "no provider IDs leak into
 *  the graph"). `headers` is the exact From/To/Cc/Subject/Date header
 *  VALUES this worker read off the Gmail API (`gmail-mime.ts`'s
 *  `parseGmailMessage`), unparsed — vault's GraphQL layer exposes them as
 *  raw strings (`EmailMessage.from`/`.to`/`.cc`/`.subject`/`.date` in
 *  `composed-schema.ts`), matching this worker's existing "never leaks a
 *  parsed-address abstraction across the worker boundary" posture (compare
 *  `gmail-address.ts`'s `ParsedAddress`, which also never crosses into
 *  `gmail-materialized-doc.ts`'s page-facing shapes). */
export interface EmailMessageDTO {
  /** Gmail's own message id — safe to expose here (unlike a thread id,
   *  plan's "no provider IDs leak into the graph" concerns the VAULT graph
   *  specifically; this DTO is server-only data that never gets written
   *  into a page). */
  id: string;
  threadPageID: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  bodyText?: string;
  bodyHtml?: string;
  /** Epoch milliseconds — Gmail's own `internalDate`, matching every other
   *  epoch-millisecond timestamp convention in this codebase
   *  (`Page.createdAt` etc.). */
  receivedAt: number;
  attachments: EmailAttachmentDTO[];
}

/** One attachment, content-addressed into gatekeeper-google's OWN R2
 *  bucket (see `workers/gatekeeper-google/wrangler.jsonc`'s `GMAIL_
 *  ATTACHMENTS` binding doc comment for the bucket-ownership decision) —
 *  `blobID` uses the SAME `blob_<sha256>` scheme
 *  `@enchiridion/graph-core`'s `deriveBlobId` derives for vault's own R2
 *  bucket, so ids are comparable/dedupable across the whole system even
 *  though the BYTES live in two physically different buckets. There is
 *  deliberately no download URL here — a client that wants the bytes needs
 *  a real fetch route, out of this pass's scope (see `gmail-body-ingest.ts`'s
 *  file header for what's deferred). */
export interface EmailAttachmentDTO {
  blobID: string;
  filename?: string;
  mimeType?: string;
  size: number;
}

/** Mirrors `GmailReadModel.getMessagesForThreads`'s real parameter list
 *  (`workers/gatekeeper-google/src/index.ts`, delegating to
 *  `gmail-read-model.ts`'s `getMessagesForThreads`) — the RPC method
 *  `workers/vault/src/graphql/composed-schema.ts`'s `EmailThread.messages`
 *  resolver ultimately calls, over the named-entrypoint Service Binding
 *  configured in `workers/vault/wrangler.jsonc`
 *  (`entrypoint: "GmailReadModel"`). Same "positional tuple type" convention
 *  `@enchiridion/vault-rpc-contract` uses for the reverse-direction binding
 *  (plan Risk #11 / "Query surfaces": batched per top-level GraphQL
 *  operation, never one RPC call per thread — this is the batching contract
 *  `composed-schema.ts`'s resolver honors via
 *  `@enchiridion/graphql-composer`'s `createBatchLoader`). */
export type GetMessagesForThreadsParams = [threadPageIDs: string[]];

/** Mirrors `GmailReadModel.getMessagesForThreads`'s real return shape —
 *  keyed by the SAME `threadPageID` values the caller supplied; a thread
 *  page id absent from every stored message (no ingested body yet, or
 *  simply not a Gmail-materialized page at all) is simply ABSENT from this
 *  record, not an error — matches this codebase's established "absence
 *  means empty, not error" accessor convention (`SupertagAccessors`'s doc
 *  comments). Messages within each array are ordered oldest-first
 *  (`receivedAt` ascending). */
export type GetMessagesForThreadsResult = Record<string, EmailMessageDTO[]>;

/** Mirrors `GmailReadModel.searchEmailMessages`'s real parameter list
 *  (`workers/gatekeeper-google/src/index.ts`, delegating to
 *  `gmail-read-model.ts`'s `searchEmailMessages`) — the RPC method
 *  `Query.emailSearch`'s resolver calls. `limit` is optional (the caller
 *  omitting it, or passing an invalid value, resolves to
 *  `DEFAULT_EMAIL_SEARCH_LIMIT` server-side — see `gmail-read-model.ts`). */
export type SearchEmailMessagesParams = [query: string, limit?: number];

/** Mirrors `GmailReadModel.searchEmailMessages`'s real return shape. */
export type SearchEmailMessagesResult = EmailMessageDTO[];

/** The exact message `GmailReadModel`'s RPC methods throw (as a plain
 *  `Error` — Workers RPC does not reliably preserve a thrown error's
 *  prototype chain across the worker boundary, only its `.message`, so this
 *  is a string constant rather than a custom `Error` subclass both sides
 *  import) when the connected Google account hasn't granted
 *  `gmail.readonly` — the resolver-level defense-in-depth gate (plan
 *  §Google gatekeeper task brief point 5: "Gate both new GraphQL fields on
 *  hasScope(GMAIL_READONLY_SCOPE) at the resolver level too"), independent
 *  of and IN ADDITION TO the ingest-time gate `gmail-ingest-cycle.ts`
 *  already enforces. `workers/vault/src/graphql/yoga.ts` re-wraps ANY
 *  caught RPC error (this one included) as a `GraphQLError` carrying the
 *  same message — a scope problem (or any other RPC failure) should be loud
 *  in the GraphQL response, never a silent empty result. Shared here so
 *  gatekeeper-google's own tests and vault's tests can both assert against
 *  the exact same string without one side hand-copying the other's
 *  wording. */
export const GMAIL_SCOPE_NOT_GRANTED_MESSAGE =
  "Gmail read access not granted — connect via /oauth/google/authorize?scope=gmail_readonly&reconnect=true";

/** Default/max result count for `Query.emailSearch` when the caller omits
 *  `limit` — a documented, non-Google-mandated choice (mirrors this
 *  codebase's convention of documenting every such constant rather than
 *  leaving a bare magic number — see e.g. `gmail-ingest.ts`'s
 *  `BACKFILL_BATCH_SIZE`). 25 keeps a single search response small enough
 *  to never need its own pagination for a personal-mailbox-scale LIKE
 *  search (see `gmail-body-store.ts`'s file header for why LIKE, not FTS5,
 *  was chosen for this P3 pass). */
export const DEFAULT_EMAIL_SEARCH_LIMIT = 25;
export const MAX_EMAIL_SEARCH_LIMIT = 100;
