// @enchiridion/worker-gatekeeper-google — OAuth authorize/callback route
// logic.
//
// Plain functions taking an injected "account" dependency (structurally a
// `DurableObjectStub<GoogleAccountDO>`, but typed here as a narrow
// interface so tests can pass a hand-written fake instead of standing up a
// real DO) — no `Request`/`Response`/Workers-runtime dependency, so both
// routes are directly unit-testable (`oauth-routes.test.ts`), same
// "logic lives in a plain module, `index.ts` just wires Request/Response
// around it" split every other real module in this codebase (vault's
// `vault-write-model.ts`, `blob-routes.ts`, etc.) already follows.
//
// `index.ts` is what actually resolves a real `DurableObjectStub`, reads
// `URL.searchParams`, and turns the plain result objects below into real
// `Response`s.

import type { FetchLike, GoogleOAuthConfig } from "./oauth-client";
import { buildAuthorizationUrl, exchangeAuthorizationCode } from "./oauth-client";
import type { ConsumeOAuthStateResult } from "./oauth-state";
import type { StoreInitialTokensResult } from "./token-store";

/** The subset of `GoogleAccountDO`'s RPC surface these two routes need.
 *  `index.ts` passes a real `DurableObjectStub<GoogleAccountDO>` in
 *  production (which satisfies this structurally — Workers RPC stub
 *  methods mirror the DO class's own async method signatures);
 *  `oauth-routes.test.ts` passes a hand-written fake to assert exactly
 *  when each method is (and, critically, is NOT) called. */
export interface OAuthAccountStub {
  /** `reconnect` (default `false`) marks the minted state as authorizing an
   *  explicit replace of an existing connection — see oauth-state.ts's file
   *  header. Set from `/oauth/google/authorize?reconnect=true`. */
  beginOAuthState(reconnect?: boolean): Promise<string>;
  consumeOAuthState(state: string): Promise<ConsumeOAuthStateResult>;
  /** `allowReplace` must be the `allowReplace` flag `consumeOAuthState`
   *  returned for THIS callback's state — never a caller-supplied value —
   *  see `handleOAuthCallback` below. `grantedScopes` (added for staged
   *  Gmail consent — plan §Google OAuth pin) is Google's own token-response
   *  `scope` field, passed through unmodified; optional (and appended last)
   *  so this stays a backward-compatible widening of the RPC surface, not a
   *  breaking signature change — see `oauth-client.ts`'s
   *  `TokenResponse.scope` doc comment for why it can be narrower than what
   *  was requested. */
  storeInitialTokens(
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
    allowReplace: boolean,
    grantedScopes?: string,
  ): Promise<StoreInitialTokensResult>;
}

export interface AuthorizeResult {
  status: 302;
  location: string;
}

export interface AuthorizeOptions {
  /** Mirrors `OAuthAccountStub.beginOAuthState`'s `reconnect` param —
   *  plumbed from `index.ts` reading `?reconnect=true` off the request URL. */
  reconnect?: boolean;
  /** The actual Google scope URL to request — already resolved from a
   *  `?scope=<stage>` query param by `oauth-http.ts` (via
   *  `oauth-client.ts`'s `scopeForStage`) before this function ever sees
   *  it; this module stays scope-stage-naming-agnostic on purpose, same
   *  split as `reconnect`. Defaults to `buildAuthorizationUrl`'s own
   *  default (`CALENDAR_EVENTS_SCOPE`) when omitted — preserves the
   *  pre-staged-consent behavior for any caller that doesn't pass one. */
  scope?: string;
}

/** `/oauth/google/authorize` — mints a fresh CSRF state (delegated to the
 *  DO, so it's stored durably before the redirect is ever issued) and
 *  returns where to send the user's browser next. */
export async function handleOAuthAuthorize(
  config: GoogleOAuthConfig,
  account: Pick<OAuthAccountStub, "beginOAuthState">,
  options: AuthorizeOptions = {},
): Promise<AuthorizeResult> {
  const state = await account.beginOAuthState(options.reconnect ?? false);
  return { status: 302, location: buildAuthorizationUrl(config, state, options.scope) };
}

export interface CallbackParams {
  code: string | null;
  state: string | null;
  /** Google sets `?error=access_denied` (etc.) instead of `?code=...` when
   *  the user declines consent — checked first, before even looking at
   *  `state`, since there's nothing to verify in that case. */
  error: string | null;
}

export type CallbackResult =
  | { status: 200; body: string }
  | { status: 400 | 403 | 409 | 500; body: string };

/** `/oauth/google/callback` — verifies the CSRF `state` BEFORE exchanging
 *  `code` for tokens, then stores the result.
 *
 * Ordering is load-bearing, not incidental: `account.consumeOAuthState`
 * is awaited and checked FIRST; `exchangeAuthorizationCode` (the only line
 * in this function that makes a network call to Google) is textually and
 * causally unreachable unless that check returns `valid: true`. A missing,
 * expired, or mismatched `state` returns a 403 with zero calls to Google's
 * token endpoint — `oauth-routes.test.ts` asserts this by counting
 * `fetchImpl` invocations, not just by checking the response status.
 *
 * `stateResult.allowReplace` (never a value read off `params` or any other
 * caller-controlled input — see `oauth-state.ts`'s file header) is threaded
 * straight into `storeInitialTokens`. If a connection already exists and
 * `allowReplace` is `false`, `storeInitialTokens` doesn't throw — it
 * returns `{status: "already-connected"}` (`token-store.ts`), which this
 * function turns into a 409 here, distinct from a network/exchange failure. */
export async function handleOAuthCallback(
  params: CallbackParams,
  config: GoogleOAuthConfig,
  account: Pick<OAuthAccountStub, "consumeOAuthState" | "storeInitialTokens">,
  fetchImpl?: FetchLike,
): Promise<CallbackResult> {
  if (params.error) {
    return { status: 400, body: `Google declined authorization: ${params.error}` };
  }
  if (!params.state) {
    return { status: 400, body: "missing state parameter" };
  }
  if (!params.code) {
    return { status: 400, body: "missing code parameter" };
  }

  const stateResult = await account.consumeOAuthState(params.state);
  if (!stateResult.valid) {
    return { status: 403, body: "invalid or expired state parameter (possible CSRF) — authorization aborted" };
  }

  const tokens = await exchangeAuthorizationCode(config, params.code, fetchImpl);
  if (!tokens.refreshToken) {
    // access_type=offline + prompt=consent (buildAuthorizationUrl) is
    // supposed to guarantee a refresh_token on this grant — if Google
    // still didn't send one, storing an access-token-only credential would
    // silently create a Google account connection that goes dead the
    // first time the access token expires (no way to refresh it). Fail
    // closed instead of storing a half-working credential.
    return {
      status: 500,
      body:
        "Google did not return a refresh_token for this authorization — expected with " +
        "access_type=offline&prompt=consent; see GOOGLE_OAUTH_SETUP.md",
    };
  }

  const storeResult = await account.storeInitialTokens(
    tokens.accessToken,
    tokens.refreshToken,
    tokens.expiresIn,
    stateResult.allowReplace,
    tokens.scope,
  );
  if (storeResult.status === "already-connected") {
    return {
      status: 409,
      body:
        "A Google account is already connected — refusing to silently replace it. " +
        "Visit /oauth/google/authorize?reconnect=true to explicitly replace the existing connection, " +
        "or call GoogleAccountDO.disconnect() first. See GOOGLE_OAUTH_SETUP.md.",
    };
  }

  return { status: 200, body: "Google account connected." };
}
