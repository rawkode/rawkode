// @enchiridion/worker-gatekeeper-google — Google OAuth 2.0 HTTP client.
//
// Plan §Google gatekeeper: "Server-side auth-code flow" (pinned Google
// OAuth decision). This module is the ONLY place that talks to Google's
// authorization/token endpoints — pure functions, no DO/Workers-runtime
// dependency, so they're directly unit-testable with an injected
// `fetchImpl` (see `oauth-client.test.ts`), the same pattern
// `workers/vault/src/access-auth.ts` uses for its JWKS fetch.
//
// Adapted from the OLD app's client-side flow
// (apps/enchiridion/Sources/EnchiridionCore/GoogleCalendarProvider.swift):
// same token-endpoint shape (`POST https://oauth2.googleapis.com/token`,
// form-encoded, `grant_type=authorization_code` / `grant_type=refresh_token`)
// and the same `access_type=offline&prompt=consent` pairing to guarantee a
// refresh token — but server-side, so there is no PKCE
// (`code_verifier`/`code_challenge`): the client secret itself is the
// confidential-client credential PKCE exists to substitute for on a public
// (device) client. CSRF protection is the `state` parameter instead
// (`oauth-state.ts`/`oauth-routes.ts`), same as the old app already did in
// parallel with PKCE.

/** The three worker-config values every Google OAuth HTTP call needs. See
 *  `oauth-config.ts` for how this is loaded (and fail-closed validated)
 *  from `Env`. */
export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Narrower than `typeof fetch` (no `preconnect`, etc.) — matches the shape
 *  every call site actually needs and keeps tests' hand-written fakes
 *  simple, same reasoning as `access-auth.ts`'s `FetchImplementation` reuse
 *  of `jose`'s narrower type. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TokenResponse {
  accessToken: string;
  /** Seconds until expiry, as Google returns it (`expires_in`) — NOT an
   *  absolute timestamp; callers (`token-store.ts`) convert to an absolute
   *  `expires_at` at the point they know "now". */
  expiresIn: number;
  /** Only present on the authorization_code grant (and occasionally on a
   *  refresh, if Google decides to rotate it) — a bare `refresh_token`
   *  grant response never repeats the refresh token that was spent to make
   *  the call. */
  refreshToken?: string;
  /** The space-delimited set of scopes Google ACTUALLY granted for this
   *  token — present on Google's token-endpoint response per its own OAuth
   *  2.0 documentation. Plan §Google OAuth pin: "Staged scopes:
   *  calendar.events -> gmail.readonly -> gmail.send (separate consent)".
   *  This can be a NARROWER set than what `buildAuthorizationUrl` requested
   *  if the user declines part of the consent screen (Google still issues
   *  tokens for whatever was actually approved, it doesn't fail the whole
   *  exchange) — callers (`token-store.ts`'s `storeInitialTokens`) persist
   *  exactly this string, never the requested scope, so
   *  `GoogleAccountDO.hasScope()` reports what's really usable. Undefined
   *  only if Google's response omits the field entirely (not expected in
   *  practice, but not assumed present either — see `requestToken` below). */
  scope?: string;
}

/** A real error Google's token endpoint returned (e.g. `invalid_grant` for
 *  a revoked/expired refresh token, `invalid_client` for a wrong
 *  client_id/secret) — distinct from a plain `Error` (thrown for
 *  network/parsing failures below), so callers can tell "Google explicitly
 *  rejected this" apart from "something went wrong talking to Google".
 *  `code` is Google's own machine-checkable `error` field; `message`
 *  includes `error_description` when Google sent one. Never retried
 *  automatically anywhere in this worker — see `token-refresh.ts`'s file
 *  header on why a revoked grant must surface, not loop. */
export class GoogleOAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

/** Calendar write scope (the task brief's exact value) — broader than the
 *  old app's read-only `calendar.readonly`, matching the plan's "Staged
 *  scopes: calendar.events -> gmail.readonly -> gmail.send" list, since a
 *  follow-up task's create/RSVP write-model needs write access, not just
 *  read. */
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/** Second staged-consent scope (plan §Google OAuth pin: "calendar.events ->
 *  gmail.readonly -> gmail.send, separate consent"). Requested on its own
 *  `/oauth/google/authorize?scope=gmail_readonly` round trip, NOT bundled
 *  into the calendar authorize call — Google shows a separate consent
 *  screen per the plan's "separate consent" wording, which only happens if
 *  each stage is its own `buildAuthorizationUrl` call with its own `scope`
 *  value (Google doesn't re-prompt for a scope it already granted in an
 *  earlier authorization unless `prompt=consent` forces the screen, which
 *  every stage already sets — see `buildAuthorizationUrl`). Read by a
 *  follow-up Gmail-ingest task before making any Gmail API read call — see
 *  `GoogleAccountDO.hasScope()` (`token-store.ts`). */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Third staged-consent scope — see `GMAIL_READONLY_SCOPE`'s doc comment.
 *  Requested via `/oauth/google/authorize?scope=gmail_send`, only needed
 *  once a follow-up task's `sendEmail()` write-model RPC exists (plan
 *  §Google gatekeeper: "Writes (send email, ...)"). Declared now so the
 *  full staged-scope set is defined in one place from the start, even
 *  though nothing calls it yet. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/** Fourth staged-consent scope — see `GMAIL_READONLY_SCOPE`'s doc comment.
 *  Requested via `/oauth/google/authorize?scope=gmail_modify`, needed by
 *  the triage write-model RPCs (`write-model.ts`'s `archiveThread`/
 *  `applyLabel`/`removeLabel`/`markRead`/`markUnread`) — Gmail's
 *  `threads.modify` endpoint (`gmail-api.ts`'s `modifyThreadLabels`) is
 *  what archive/label/mark-read/mark-unread all resolve to under the hood
 *  (archiving = removing the `INBOX` label, mark-read/unread = removing/
 *  adding the `UNREAD` label — see `gmail-triage.ts`), and per Google's own
 *  scope documentation that endpoint requires `gmail.modify` specifically —
 *  narrower than `gmail.send` (a send-only scope) and NOT implied by
 *  `gmail.readonly`. A separate staged consent from all three other scopes,
 *  same "each stage its own `buildAuthorizationUrl` round trip" reasoning as
 *  `GMAIL_SEND_SCOPE`. */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** The four named authorize-request stages `/oauth/google/authorize`'s
 *  `?scope=` query param accepts (see `oauth-http.ts`) — short, URL-friendly
 *  keys rather than the full Google scope URL, so the query string stays
 *  readable and a caller can't accidentally request an arbitrary,
 *  un-reviewed Google scope through this worker's own endpoint. */
export type OAuthScopeStage = "calendar" | "gmail_readonly" | "gmail_send" | "gmail_modify";

const SCOPE_BY_STAGE: Record<OAuthScopeStage, string> = {
  calendar: CALENDAR_EVENTS_SCOPE,
  gmail_readonly: GMAIL_READONLY_SCOPE,
  gmail_send: GMAIL_SEND_SCOPE,
  gmail_modify: GMAIL_MODIFY_SCOPE,
};

/** Resolves a `?scope=` stage key (`oauth-http.ts`) to the actual Google
 *  scope URL `buildAuthorizationUrl` requests. The single source of truth
 *  for the stage-key <-> scope-URL mapping, so `oauth-http.ts` never
 *  hand-builds a scope string itself. */
export function scopeForStage(stage: OAuthScopeStage): string {
  return SCOPE_BY_STAGE[stage];
}

/** Type guard narrowing an arbitrary string (e.g. a raw query-param value)
 *  to `OAuthScopeStage` — lets `oauth-http.ts` reject an unrecognized
 *  `?scope=` value with a clear 400 instead of silently falling through to
 *  the default stage. */
export function isOAuthScopeStage(value: string): value is OAuthScopeStage {
  return Object.hasOwn(SCOPE_BY_STAGE, value);
}

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Builds the URL to redirect the user's browser to for Google's OAuth
 *  consent screen. `access_type=offline` + `prompt=consent` together are
 *  what guarantee Google actually issues a `refresh_token` on this grant
 *  (not just an access_token) — `prompt=consent` forces the screen even if
 *  the user previously granted this app access, which is what makes the
 *  `offline` access type's refresh-token issuance reliable instead of
 *  silently skipped for a returning user (see GOOGLE_OAUTH_SETUP.md).
 *
 *  `include_granted_scopes=true` is always set — this is what makes Google's
 *  staged-consent flow (plan: "calendar.events -> gmail.readonly ->
 *  gmail.send, separate consent") work as *incremental* authorization
 *  instead of each stage silently narrowing the account's usable scope: per
 *  Google's own OAuth 2.0 documentation, when this flag is set, a token
 *  response's `scope` field reflects the UNION of every scope the user has
 *  ever granted this client, not just the one requested on this particular
 *  call — so requesting `gmail_readonly` on a later call doesn't return a
 *  token whose `scope` silently drops the already-granted
 *  `calendar.events`. `token-store.ts`'s `storeInitialTokens` stores
 *  Google's returned `scope` value directly (no separate merge logic on
 *  this worker's side), relying on this parameter for the union — see that
 *  file's header for why that's sufficient rather than a gap. */
export function buildAuthorizationUrl(
  config: GoogleOAuthConfig,
  state: string,
  scope: string = CALENDAR_EVENTS_SCOPE,
): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchanges an authorization `code` (from the callback's `?code=...`) for
 *  an access + refresh token pair. Server-side auth-code flow — no
 *  `code_verifier` (see this file's header on why PKCE doesn't apply
 *  here). */
export async function exchangeAuthorizationCode(
  config: GoogleOAuthConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  return requestToken(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    },
    fetchImpl,
  );
}

/** Refreshes an access token using a previously stored `refresh_token`.
 *  Real network call to Google's token endpoint — `token-refresh.ts` is
 *  what decides WHEN to call this (expired/near-expiry vs. still valid);
 *  this function always performs the request when called, with no
 *  internal retry — see that file's header for why. */
export async function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  return requestToken(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    },
    fetchImpl,
  );
}

async function requestToken(form: Record<string, string>, fetchImpl: FetchLike): Promise<TokenResponse> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Google token endpoint returned a non-JSON response (HTTP ${response.status})`);
  }

  if (!response.ok) {
    // Google's error shape: { error: "invalid_grant", error_description:
    // "Token has been expired or revoked." } — verified against Google's
    // own OAuth 2.0 error documentation, not guessed. A revoked/expired
    // refresh token surfaces here as `invalid_grant`.
    const body = data as { error?: unknown; error_description?: unknown };
    const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
    const description = typeof body.error_description === "string" ? body.error_description : undefined;
    throw new GoogleOAuthError(
      code,
      description
        ? `Google token endpoint rejected the request: ${code} (${description})`
        : `Google token endpoint rejected the request: ${code} (HTTP ${response.status})`,
    );
  }

  const body = data as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown };
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new Error(
      "Google token endpoint returned a 2xx response with an unexpected shape (missing access_token/expires_in)",
    );
  }

  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}
