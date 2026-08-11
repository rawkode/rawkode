// @enchiridion/worker-vault — GraphQL Yoga wiring for the /graphql route.
//
// Plan §Backend architecture, "GraphQL API": vault serves its one Pothos
// schema (./schema.ts) directly via GraphQL Yoga at /graphql — no
// gateway, no federation, no supergraph build step. This module is the
// ONLY place that resolves a real `DurableObjectStub<VaultDO>` and adapts
// its typed accessor RPC methods (`getPage`/`listPages` — see
// `../vault-do.ts` and `../query-accessors.ts`) to the `VaultAccessors`
// shape `./schema.ts`'s resolvers are written against; `./schema.test.ts`
// exercises the schema directly without this file, wiring `VaultAccessors`
// straight to `../query-accessors.ts`'s functions instead (see that test
// file's header for why that's a faithful-enough substitute — everything
// this file adds beyond that is the DO-stub RPC hop and HTTP transport,
// both of which need a live Workers runtime to exercise for real).
//
// Server-context wiring follows Yoga's documented Cloudflare Workers
// integration: `../index.ts`'s /graphql route calls `yoga.fetch(request,
// env)`; `@whatwg-node/server` (which Yoga is built on) flat-merges the
// extra positional argument into `TServerContext` before calling
// `context()` below — so `env`'s own binding keys (`VAULT_DO`) land
// directly on that one object, not nested under an `.env` key. (`ctx:
// ExecutionContext` isn't threaded through today — nothing here needs
// `waitUntil`/`passThroughOnException` yet; adding it later is a one-line
// change to both this generic and `../index.ts`'s call site, not a
// redesign — @whatwg-node/server's `fetch` overloads accept any number of
// extra context-part arguments.)
//
// Access verification (plan P0 "Access service-token auth incl. WebSocket
// upgrade", Risk #10): real as of this pass — `handleGraphQLRequest` below
// is a pre-check in front of Yoga (per the task brief's "or a plugin/
// pre-check before Yoga handles the request" option), not a Yoga plugin or
// a `context()` check. A `context()`-based check was rejected: Yoga only
// calls `context()` after it has already started handling the request
// (including serving the GraphiQL landing page on a bare GET), so a check
// placed there would still let an unauthenticated GET through to GraphiQL.
// Checking before `yoga.fetch` is ever called closes that gap — see
// `access-auth.ts`'s file header for the full client → Access → origin
// flow this verifies the last leg of. `../index.ts`'s `/graphql` route
// calls `handleGraphQLRequest`, not `yoga.fetch`, directly.

import type {
  EmailMessageDTO,
  GetMessagesForThreadsParams,
  GetMessagesForThreadsResult,
  SearchEmailMessagesParams,
  SearchEmailMessagesResult,
} from "@enchiridion/gatekeeper-google-rpc-contract";
import { accessDenyResponse, type AccessEnv, verifyAccessRequest } from "../access-auth";
import { createYoga } from "graphql-yoga";
import { GraphQLError } from "graphql";
import type { VaultDO } from "../vault-do";
import { defaultVaultStub } from "../vault-stub";
import { schema, type ComposedVaultContext, type GatekeeperGoogleAccessors } from "./composed-schema";

export interface Env extends AccessEnv {
  VAULT_DO: DurableObjectNamespace<VaultDO>;
  /** NAMED-ENTRYPOINT Cloudflare Service Binding to `workers/gatekeeper-
   *  google`'s `GmailReadModel` `WorkerEntrypoint` (`services` entry,
   *  `entrypoint: "GmailReadModel"` — wrangler.jsonc) — real Workers RPC,
   *  NOT `env.GATEKEEPER_GOOGLE.fetch(...)`.
   *
   *  FIX (adversarial-review BLOCKER, plan §Google gatekeeper): this
   *  binding used to be a plain (no-`entrypoint`) Service Binding, and
   *  `buildGatekeeperGoogleAccessors` below called
   *  `env.GATEKEEPER_GOOGLE.fetch(...)` against gatekeeper-google's public
   *  `/gmail/messages`/`/gmail/search` HTTP routes — which had zero
   *  application-layer authentication (a Service Binding's `.fetch()`
   *  dispatches to the target worker's own PUBLIC `fetch()` handler, so
   *  "only reachable over a Service Binding" was never real caller-identity
   *  isolation). See `gatekeeper-google/src/gmail-read-model.ts`'s file
   *  header for the full writeup.
   *
   *  Still typed as the ambient global `Fetcher` (from
   *  `@cloudflare/workers-types`, already a project dependency) rather than
   *  `Service<GmailReadModel>` — `@cloudflare/workers-types`' `Service<T>`
   *  requires `T` to be a branded `WorkerEntrypoint` subclass, which
   *  importing gatekeeper-google's REAL `GmailReadModel` class would
   *  satisfy, but only by pulling its entire runtime module graph
   *  (including `cloudflare:workers` imports) into this worker's build —
   *  exactly what this codebase's established "only TYPES cross the worker
   *  boundary, via a shared rpc-contract package" convention avoids (same
   *  reasoning `gatekeeper-google/src/vault-client.ts`'s file header gives
   *  for keeping ITS `VAULT` binding as a plain, unparameterized
   *  `DurableObjectNamespace` rather than `DurableObjectNamespace<VaultDO>`).
   *  `buildGatekeeperGoogleAccessors` below does the one narrowing cast to
   *  a local structural `GmailReadModelStub` interface (typed from
   *  `@enchiridion/gatekeeper-google-rpc-contract`'s shared parameter/
   *  result types), matching `vault-client.ts`'s `defaultVaultDOStub`
   *  pattern exactly. A Service Binding still dispatches worker-to-worker
   *  inside Cloudflare's network, never over the public internet, so
   *  (unlike `/graphql` itself) no Cloudflare Access check applies to this
   *  call — that part of the original reasoning was correct; what was
   *  missing was that gatekeeper-google's OWN `fetch()` handler was the
   *  thing with no check, not this binding. */
  GATEKEEPER_GOOGLE: Fetcher;
}

/** The slice of `GmailReadModel`'s RPC surface
 *  (`workers/gatekeeper-google/src/index.ts`) this worker calls — a local,
 *  minimal structural type (not an import of the real `GmailReadModel`
 *  class), with parameter/return types imported from
 *  `@enchiridion/gatekeeper-google-rpc-contract` so a future gatekeeper-
 *  google signature change breaks gatekeeper-google's OWN build first
 *  rather than silently drifting here — see this file's `GATEKEEPER_GOOGLE`
 *  binding comment above and `@enchiridion/gatekeeper-google-rpc-contract`'s
 *  file header for the full rationale (mirrors `vault-client.ts`'s
 *  `VaultDOStub` exactly, for the reverse-direction binding). */
interface GmailReadModelStub {
  getMessagesForThreads(...args: GetMessagesForThreadsParams): Promise<GetMessagesForThreadsResult>;
  searchEmailMessages(...args: SearchEmailMessagesParams): Promise<SearchEmailMessagesResult>;
}

/** The one narrowing cast every call in `buildGatekeeperGoogleAccessors`
 *  below goes through — see `GmailReadModelStub`'s doc comment for why a
 *  cast (not a generic `Service<GmailReadModel>` binding type) is this
 *  codebase's established pattern here. Workers RPC dispatches a
 *  named-entrypoint Service Binding's calls by method name/arity over the
 *  wire, not by the caller's static TypeScript type, so this is safe as
 *  long as `GmailReadModelStub` stays structurally accurate to
 *  `GmailReadModel`'s real methods (enforced by both sides importing the
 *  same `@enchiridion/gatekeeper-google-rpc-contract` types). */
function asGmailReadModelStub(fetcher: Fetcher): GmailReadModelStub {
  return fetcher as unknown as GmailReadModelStub;
}

/** Real `GatekeeperGoogleAccessors` implementation — the ONLY place in this
 *  worker that calls into `GmailReadModel`'s RPC methods. Any error thrown
 *  across the RPC boundary (the resolver-level `hasScope
 *  (GMAIL_READONLY_SCOPE)` defense-in-depth gate enforced server-side in
 *  `gatekeeper-google/src/gmail-read-model.ts`, or any other RPC failure)
 *  is re-wrapped as a `GraphQLError` carrying the same message, never a
 *  silent empty result — a scope problem (or any other failure) should be
 *  loud in the GraphQL response, not look like "no mail found". */
function buildGatekeeperGoogleAccessors(fetcher: Fetcher): GatekeeperGoogleAccessors {
  const stub = asGmailReadModelStub(fetcher);

  async function callGatekeeperGoogleRpc<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GraphQLError(message);
    }
  }

  return {
    async getMessagesForThreads(threadPageIDs) {
      if (threadPageIDs.length === 0) return new Map();
      const record = await callGatekeeperGoogleRpc(() => stub.getMessagesForThreads([...threadPageIDs]));
      return new Map(Object.entries(record)) as ReadonlyMap<string, EmailMessageDTO[]>;
    },

    async searchEmail(query, limit) {
      return callGatekeeperGoogleRpc(() => stub.searchEmailMessages(query, limit));
    },
  };
}

/** The one servable schema — `graphql-composer`'s supertag types
 *  (Person/Organization/Company/Event/Area/Project/Task/Place/EmailThread,
 *  from `supertags/core` + `supertags/email`) merged with the hand-written
 *  generic `Page` type AND the server-only `EmailMessage`/`EmailAttachment`
 *  types/fields onto one Pothos builder. See `./composed-schema.ts`'s
 *  header for why both are kept (complementary, not overlapping) and how
 *  the merge works. */
export const yoga = createYoga<Env, ComposedVaultContext>({
  schema,
  graphqlEndpoint: "/graphql",
  context: (env): ComposedVaultContext => {
    const stub = defaultVaultStub(env);
    // One `vault` object satisfying BOTH `VaultAccessors` (Page) and
    // `SupertagAccessors` (every composed supertag type) — the same
    // "adapt DO-stub RPC methods to the accessor contract" role this file
    // has always had, just covering two contracts now instead of one.
    // `getRelationTargets`/`getRelationSources` convert the DO RPC's plain
    // `Record<string, string[]>` return value (see `vault-do.ts`'s doc
    // comment on why the RPC method itself avoids returning a `Map`) back
    // into the `ReadonlyMap` `SupertagAccessors` requires.
    const vault: ComposedVaultContext["vault"] = {
      getPage: (pageId) => stub.getPage(pageId),
      listPages: (options) => stub.listPages(options),
      getNodeWithFacts: (id) => stub.getNodeWithFacts(id),
      getNodesWithFacts: (ids) => stub.getNodesWithFacts([...ids]),
      listNodesByTag: (tagID, options) => stub.listNodesByTag(tagID, options),
      getRelationTargets: async (relationID, sourceNodeIDs) => {
        const record = await stub.getRelationTargets(relationID, [...sourceNodeIDs]);
        return new Map(Object.entries(record));
      },
      getRelationSources: async (relationID, targetNodeIDs) => {
        const record = await stub.getRelationSources(relationID, [...targetNodeIDs]);
        return new Map(Object.entries(record));
      },
    };
    return { vault, gatekeeperGoogle: buildGatekeeperGoogleAccessors(env.GATEKEEPER_GOOGLE) };
  },
});

/** `../index.ts`'s `/graphql` route calls this instead of `yoga.fetch`
 *  directly — verifies Cloudflare Access first (see this file's header
 *  comment on why that has to happen before Yoga is invoked at all, not
 *  inside `context()`), and only forwards to Yoga on success. On failure,
 *  returns the 401/403/500 `accessDenyResponse` — VaultDO (and even
 *  Yoga/GraphiQL itself) is never reached. */
export async function handleGraphQLRequest(request: Request, env: Env): Promise<Response> {
  const access = await verifyAccessRequest(request, env);
  if (!access.ok) {
    return accessDenyResponse(access);
  }
  return yoga.fetch(request, env);
}
