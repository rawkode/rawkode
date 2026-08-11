// @enchiridion/worker-gatekeeper-google — the Gmail READ surface: pure
// functions backing `GmailReadModel` (./index.ts), a `WorkerEntrypoint`
// exposed to `workers/vault` over a NAMED-ENTRYPOINT Cloudflare Service
// Binding (`workers/vault/wrangler.jsonc`'s `GATEKEEPER_GOOGLE` binding,
// `entrypoint: "GmailReadModel"`) — real Workers RPC, not an HTTP route.
//
// FIX (adversarial-review BLOCKER, plan §Google gatekeeper): this file used
// to expose `/gmail/messages`/`/gmail/search` as plain HTTP routes on this
// worker's public `fetch()` handler (`handleGmailMessagesRequest`/
// `handleGmailSearchRequest`), reasoning that because `workers/vault` only
// ever reached them over a Cloudflare Service Binding
// (`env.GATEKEEPER_GOOGLE.fetch(...)`), the routes had no real public
// attack surface — "Service Bindings dispatch worker-to-worker inside
// Cloudflare's own network and are never reachable from the public
// internet at all, so there is no edge boundary for Access to gate here."
// That reasoning was WRONG: a Service Binding's `.fetch(request)` dispatches
// to the TARGET WORKER'S OWN `fetch()` HANDLER — the exact same public
// entry point `wrangler dev`/a deployed Worker's default route would
// invoke for ANY request that reaches it, Service-Binding-originated or
// not. Nothing about how the request arrived changed which code ran or
// what checked it. `hasScope(GMAIL_READONLY_SCOPE)` (still present below)
// was real defense-in-depth against a connected-but-unscoped Google
// account, but it checked a fact about DATA availability, never a fact
// about the CALLER — anyone who could reach this worker's `fetch()` at all
// (its own public route, a misconfigured binding, a future caller nobody
// audited) could call these two routes with no credential of any kind.
//
// THE FIX: `getMessagesForThreads`/`searchEmailMessages` below are no
// longer HTTP handlers — they take and return plain typed values (no
// `Request`/`Response` anywhere in their signatures) and are called ONLY
// by `GmailReadModel` (./index.ts), a `WorkerEntrypoint` subclass. Workers
// RPC entrypoint methods are not reachable via `fetch()`/HTTP the way a
// route is at all — they can only be invoked by a caller holding a real
// `Service<GmailReadModel>`-shaped binding, wired ONLY into
// `workers/vault/wrangler.jsonc` (`entrypoint: "GmailReadModel"`), the same
// "worker-to-worker inside Cloudflare's own network, never the public
// internet" property Service Bindings always had — the difference is that
// now there is genuinely no `fetch()`-routed path to this data at all, not
// an unenforced assumption that one wouldn't be misused. See
// `./index.ts`'s `fetch()` handler (its `/gmail/` branch now returns 404
// unconditionally) and `./gmail-read-model.test.ts`'s
// "no HTTP route surface" tests for the two ways this is proven: the
// pathname-matching logic below is pure and directly tested, and
// `getMessagesForThreads`/`searchEmailMessages` are proven to have no
// Request/Response-shaped call surface at all (they're called with plain
// values in every test).
//
// The `hasScope(GMAIL_READONLY_SCOPE)` check stays (task brief point 5:
// "Gate both new GraphQL fields on hasScope(GMAIL_READONLY_SCOPE) at the
// resolver level too") as genuine defense-in-depth against a caller that
// DOES hold the RPC binding but whose Google account has no Gmail scope
// granted — it was never the problem; it just wasn't sufficient on its own
// to be the ONLY check, which is what made the missing caller-identity
// check a BLOCKER.
//
// Pure functions over a narrow `GmailRpcStub` interface (not
// `DurableObjectStub<GoogleAccountDO>` directly) — same "plain function,
// unit-testable without cloudflare:workers" split `oauth-http.ts` and
// `token-refresh.ts` already use throughout this worker (see
// `oauth-http.ts`'s file header for why `index.ts` itself — which imports
// `WorkerEntrypoint`/`DurableObject` from `cloudflare:workers` — cannot be
// imported by `bun test` at all); `index.ts`'s `GmailReadModel` RPC methods
// are thin delegates to the functions below, passing the real
// `defaultGoogleAccountStub(env)`.

import {
  DEFAULT_EMAIL_SEARCH_LIMIT,
  GMAIL_SCOPE_NOT_GRANTED_MESSAGE,
  MAX_EMAIL_SEARCH_LIMIT,
  type EmailMessageDTO,
} from "@enchiridion/gatekeeper-google-rpc-contract";
import { GMAIL_READONLY_SCOPE } from "./oauth-client";

/** The slice of `GoogleAccountDO`'s RPC surface these functions need —
 *  structurally satisfied by a real `DurableObjectStub<GoogleAccountDO>`
 *  (same-script DO, so no cross-worker-contract cast is needed the way
 *  `vault-client.ts`'s `VaultDOStub` needs one for the cross-script `VAULT`
 *  binding — see that file's header for why THAT case is different). */
export interface GmailRpcStub {
  hasScope(scope: string): Promise<boolean>;
  getMessagesForThreads(pageIDs: string[]): Promise<Record<string, EmailMessageDTO[]>>;
  searchEmailMessages(query: string, limit: number): Promise<EmailMessageDTO[]>;
}

/** Checked FIRST in both functions below, before any other work — matches
 *  the original HTTP handlers' ordering (scope denial short-circuits
 *  before even inspecting the rest of the call), now expressed as a thrown
 *  `Error` instead of a 403 `Response` (see `@enchiridion/gatekeeper-google
 *  -rpc-contract`'s `GMAIL_SCOPE_NOT_GRANTED_MESSAGE` doc comment for why a
 *  plain-message `Error`, not a custom subclass, is the shared contract
 *  across the Workers RPC boundary). */
async function requireGmailReadScope(stub: GmailRpcStub): Promise<void> {
  if (!(await stub.hasScope(GMAIL_READONLY_SCOPE))) {
    throw new Error(GMAIL_SCOPE_NOT_GRANTED_MESSAGE);
  }
}

/** Backs `GmailReadModel.getMessagesForThreads` — batched lookup for
 *  `EmailThread.messages`. See
 *  `@enchiridion/gatekeeper-google-rpc-contract`'s
 *  `GetMessagesForThreadsParams`/`GetMessagesForThreadsResult` for the
 *  shared parameter/return contract this implements the real side of. */
export async function getMessagesForThreads(
  stub: GmailRpcStub,
  threadPageIDs: string[],
): Promise<Record<string, EmailMessageDTO[]>> {
  await requireGmailReadScope(stub);
  if (!Array.isArray(threadPageIDs)) {
    throw new TypeError("threadPageIDs must be an array of strings");
  }
  return stub.getMessagesForThreads(threadPageIDs);
}

/** Backs `GmailReadModel.searchEmailMessages` — full-text-ish search over
 *  ingested Gmail message bodies, backs `Query.emailSearch`. `limit`
 *  resolves to `DEFAULT_EMAIL_SEARCH_LIMIT` when omitted/non-finite/`<= 0`,
 *  and is clamped to `MAX_EMAIL_SEARCH_LIMIT` otherwise — the same
 *  default/clamp behavior the original `?limit=` query-string parsing had,
 *  now applied to a plain numeric parameter instead of a string one. */
export async function searchEmailMessages(
  stub: GmailRpcStub,
  query: string,
  limit?: number,
): Promise<EmailMessageDTO[]> {
  await requireGmailReadScope(stub);
  if (!query || query.trim().length === 0) {
    throw new TypeError("query is required");
  }

  let resolvedLimit = DEFAULT_EMAIL_SEARCH_LIMIT;
  if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
    resolvedLimit = Math.min(Math.floor(limit), MAX_EMAIL_SEARCH_LIMIT);
  }

  return stub.searchEmailMessages(query, resolvedLimit);
}

/** Pure pathname check backing `./index.ts`'s `fetch()` handler's `/gmail/`
 *  branch — ALL `/gmail/*` paths 404 unconditionally now (Gmail reads are
 *  `GmailReadModel` RPC-only, Gmail sends are `GmailWriteModel` RPC-only —
 *  see `./index.ts`'s file header, "no generic API passthrough"). Split out
 *  as a pure function (rather than left as an inline `if` in `index.ts`)
 *  specifically so `gmail-read-model.test.ts` can assert — without needing
 *  a live Workers runtime `index.ts`'s own `cloudflare:workers` import
 *  rules out for `bun test` (see this file's header) — that the two
 *  previously-vulnerable paths really do 404 and that this module's own
 *  exports (`getMessagesForThreads`/`searchEmailMessages` above) are the
 *  only way to reach this data, never a `Request`-shaped call. */
export function gmailNotFoundResponse(pathname: string): Response | undefined {
  if (!pathname.startsWith("/gmail/")) return undefined;
  return new Response(
    "not found — Gmail has no HTTP route surface; use the GmailReadModel WorkerEntrypoint RPC " +
      "(getMessagesForThreads/searchEmailMessages) or the GmailWriteModel WorkerEntrypoint RPC " +
      "(sendEmail/confirmApproval) instead.\n" +
      "Plan: /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md",
    { status: 404 },
  );
}
