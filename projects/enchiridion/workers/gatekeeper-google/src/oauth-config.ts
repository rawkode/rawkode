// @enchiridion/worker-gatekeeper-google — Google OAuth config loading,
// fail-closed.
//
// Follows the exact convention `workers/vault/src/access-auth.ts` uses for
// `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`: unconfigured (missing or still the
// `REPLACE_ME` placeholder committed in `wrangler.jsonc`) means every route
// that needs Google OAuth returns a clear 500, never a silent bypass. See
// `GOOGLE_OAUTH_SETUP.md` for the manual dashboard steps that fill these
// values in for real.

import type { GoogleOAuthConfig } from "./oauth-client";

export type { GoogleOAuthConfig } from "./oauth-client";

/** `Env` fields this module reads. `GOOGLE_CLIENT_ID` and
 *  `GOOGLE_OAUTH_REDIRECT_URI` are non-secret (a client id and a redirect
 *  URL are not credentials on their own), so they're plain `vars` in
 *  `wrangler.jsonc`; `GOOGLE_CLIENT_SECRET` is a real credential and MUST
 *  be set via `wrangler secret put GOOGLE_CLIENT_SECRET` — see
 *  GOOGLE_OAUTH_SETUP.md. All three are read off `env` rather than
 *  hardcoded, same as every other environment-specific binding in this
 *  repo. */
export interface GoogleOAuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
}

/** Thrown by `loadOAuthConfig` when any of the three required values is
 *  missing or is still the `REPLACE_ME...` placeholder — a deploy-config
 *  bug, not a caller's fault, matching `access-auth.ts`'s 500-not-401
 *  distinction for its own "not configured" case. */
export class GoogleOAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthConfigError";
  }
}

function isMissingOrPlaceholder(value: string | undefined): value is undefined {
  return !value || value.startsWith("REPLACE_ME");
}

/** Validates and returns the three config values as a `GoogleOAuthConfig`,
 *  or throws `GoogleOAuthConfigError` — fail closed, never returns a
 *  partially-valid config. Called from both `index.ts` (building the
 *  authorize URL / exchanging the callback's code — plain HTTP routes, not
 *  DO RPC) and `GoogleAccountDO.getValidAccessToken()` (the DO refreshing a
 *  token on its own) — both have the same three `Env` fields available. */
export function loadOAuthConfig(env: GoogleOAuthEnv): GoogleOAuthConfig {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_OAUTH_REDIRECT_URI: redirectUri } =
    env;
  if (isMissingOrPlaceholder(clientId) || isMissingOrPlaceholder(clientSecret) || isMissingOrPlaceholder(redirectUri)) {
    throw new GoogleOAuthConfigError(
      "Google OAuth is not configured on this worker (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / " +
        "GOOGLE_OAUTH_REDIRECT_URI missing or still REPLACE_ME) — see GOOGLE_OAUTH_SETUP.md",
    );
  }
  return { clientId, clientSecret, redirectUri };
}
