// @enchiridion/worker-gatekeeper-google — HTTP-level wiring for the OAuth
// routes: Cloudflare Access verification (Fix 1) + OAuth config loading +
// Request/Response adaptation around oauth-routes.ts's plain
// handleOAuthAuthorize/handleOAuthCallback (Fix 2's no-silent-replace
// guard, Fix 3's callback try/catch).
//
// Split out from index.ts for the same "logic lives in a plain module,
// index.ts just wires Request/Response around it" reason oauth-routes.ts
// itself documents in its own header: `index.ts` imports `WorkerEntrypoint`
// from `cloudflare:workers`, which only resolves inside a real Workers
// runtime (`wrangler dev`/deployed) — `bun test` cannot import `index.ts`
// directly (see `google-account-do.ts`'s file header for the identical
// reasoning about `DurableObject`). This module has NO `cloudflare:workers`
// dependency, so `oauth-http.test.ts` can exercise the FULL
// "Access-gate -> config-load -> route-handling" pipeline exactly as
// `index.ts`'s `fetch()` calls it — including proving an unauthenticated
// request never reaches Google's token endpoint — without needing a live
// Workers runtime this sandbox doesn't have.
//
// `index.ts`'s `fetch()` handler for `/oauth/google/authorize` and
// `/oauth/google/callback` is now a two-line delegate to the two functions
// below, passing a real `defaultGoogleAccountStub(env)`.

import type { AccessEnv } from "@enchiridion/access-auth";
import { accessDenyResponse, verifyAccessRequest } from "@enchiridion/access-auth";
import type { FetchLike } from "./oauth-client";
import { GoogleOAuthError, isOAuthScopeStage, scopeForStage } from "./oauth-client";
import { GoogleOAuthConfigError, loadOAuthConfig } from "./oauth-config";
import type { GoogleOAuthEnv } from "./oauth-config";
import { handleOAuthAuthorize, handleOAuthCallback, type OAuthAccountStub } from "./oauth-routes";

export interface OAuthHttpEnv extends GoogleOAuthEnv, AccessEnv {}

function configErrorResponse(error: GoogleOAuthConfigError): Response {
  return new Response(error.message, { status: 500 });
}

/** `GET /oauth/google/authorize`. Access is verified FIRST — before
 *  `loadOAuthConfig` or `account.beginOAuthState` (a durable DO write) —
 *  see this file's header and `index.ts`'s file header for the full Fix 1
 *  rationale. `?reconnect=true` is Fix 2's explicit-override entry point —
 *  see `oauth-state.ts`'s file header.
 *
 *  `?scope=<stage>` (plan §Google OAuth pin: "calendar.events ->
 *  gmail.readonly -> gmail.send, separate consent" — extended by the
 *  triage-write-model task with a fourth stage, `gmail_modify`, for
 *  `threads.modify`, see `oauth-client.ts`'s `GMAIL_MODIFY_SCOPE` doc
 *  comment) selects which staged Google scope this particular authorize
 *  round trip requests — `oauth-client.ts`'s `OAuthScopeStage` ("calendar" |
 *  "gmail_readonly" | "gmail_send" | "gmail_modify"), resolved to the real
 *  Google scope URL via `scopeForStage` BEFORE `handleOAuthAuthorize` (which
 *  stays
 *  stage-naming-agnostic — see `AuthorizeOptions.scope`'s doc comment).
 *  Omitted (or absent): defaults to `"calendar"`, preserving the
 *  pre-staged-consent behavior for any existing bookmark/link. An
 *  unrecognized value is rejected with 400 BEFORE touching the account
 *  stub or Google — same "fail closed on a bad request, don't guess" shape
 *  as `loadOAuthConfig`'s fail-closed config check just above it. */
export async function handleOAuthAuthorizeRequest(
  request: Request,
  env: OAuthHttpEnv,
  account: Pick<OAuthAccountStub, "beginOAuthState">,
): Promise<Response> {
  const accessResult = await verifyAccessRequest(request, env);
  if (!accessResult.ok) {
    return accessDenyResponse(accessResult);
  }

  let config;
  try {
    config = loadOAuthConfig(env);
  } catch (error) {
    if (error instanceof GoogleOAuthConfigError) return configErrorResponse(error);
    throw error;
  }

  const url = new URL(request.url);
  const reconnect = url.searchParams.get("reconnect") === "true";

  const rawScope = url.searchParams.get("scope");
  const stage = rawScope ?? "calendar";
  if (!isOAuthScopeStage(stage)) {
    return new Response(
      `invalid ?scope= value "${stage}" — must be one of: calendar, gmail_readonly, gmail_send, gmail_modify`,
      { status: 400, headers: { "content-type": "text/plain" } },
    );
  }

  const result = await handleOAuthAuthorize(config, account, { reconnect, scope: scopeForStage(stage) });
  return new Response(null, { status: result.status, headers: { location: result.location } });
}

/** `GET /oauth/google/callback`. Access is verified FIRST, same ordering as
 *  `handleOAuthAuthorizeRequest` above. The whole `handleOAuthCallback` call
 *  is wrapped in try/catch (Fix 3) — a `GoogleOAuthError` (Google's token
 *  endpoint rejecting the exchange) or any other thrown error becomes a
 *  controlled error `Response`, never an unhandled exception. */
export async function handleOAuthCallbackRequest(
  request: Request,
  env: OAuthHttpEnv,
  account: Pick<OAuthAccountStub, "consumeOAuthState" | "storeInitialTokens">,
  fetchImpl?: FetchLike,
): Promise<Response> {
  const accessResult = await verifyAccessRequest(request, env);
  if (!accessResult.ok) {
    return accessDenyResponse(accessResult);
  }

  let config;
  try {
    config = loadOAuthConfig(env);
  } catch (error) {
    if (error instanceof GoogleOAuthConfigError) return configErrorResponse(error);
    throw error;
  }

  const url = new URL(request.url);
  try {
    const result = await handleOAuthCallback(
      {
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
        error: url.searchParams.get("error"),
      },
      config,
      account,
      fetchImpl,
    );
    return new Response(result.body, { status: result.status, headers: { "content-type": "text/plain" } });
  } catch (error) {
    if (error instanceof GoogleOAuthError) {
      return new Response(`Google OAuth token exchange failed (${error.code}): ${error.message}`, {
        status: 502,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response(`OAuth callback failed: ${error instanceof Error ? error.message : String(error)}`, {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  }
}
