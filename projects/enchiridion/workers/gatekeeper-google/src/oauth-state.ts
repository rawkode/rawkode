// @enchiridion/worker-gatekeeper-google — OAuth `state`-parameter CSRF
// protection.
//
// Plan §Google OAuth pin: server-side auth-code flow doesn't need PKCE
// (that substitutes for a confidential client secret, which this worker
// has), but still needs CSRF protection on the callback — this is that,
// via a short-lived, one-time-use state token stored in GoogleAccountDO's
// own SQLite (the "simplest correct approach" the task brief calls for,
// since a GoogleAccountDO singleton already exists to hold it — no signed
// cookie needed).
//
// Flow: `/oauth/google/authorize` calls `createOAuthState` (via
// `GoogleAccountDO.beginOAuthState()`) and puts the same value in the
// redirect URL's `state` param; `/oauth/google/callback` calls
// `consumeOAuthState` (via `GoogleAccountDO.consumeOAuthState()`) with
// whatever `state` Google echoed back. See `oauth-routes.ts`'s
// `handleOAuthCallback` for why this check happens strictly BEFORE any
// token exchange.
//
// `allowReplace` (see schema.ts's `oauth_state.allow_replace` column):
// `/oauth/google/authorize?reconnect=true` sets this when the state is
// minted; `consumeOAuthState` hands it back to the callback so
// `storeInitialTokens` knows whether THIS specific round trip was an
// explicit "replace the existing connection" request — see
// `token-store.ts`'s header for why this can't just be a callback query
// param instead (a client-supplied flag on the callback would let anyone
// who can guess/observe a valid `state` value silently force a replace;
// tying the flag to the server-minted state row means only whoever
// legitimately started the authorize flow with `?reconnect=true` — i.e.
// whoever is already past this worker's own Access check, see
// `index.ts` — can set it).

import type { SqlExecutor } from "./schema";

/** How long a state token remains valid — long enough for a user to
 *  actually complete Google's consent screen, short enough to bound a
 *  stale/guessed-state replay window. Not configurable; there's no
 *  legitimate reason for this flow to take longer than a few minutes. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function createOAuthState(sql: SqlExecutor, state: string, now: number, allowReplace = false): void {
  sql.exec(
    "INSERT INTO oauth_state (state, created_at, expires_at, allow_replace) VALUES (?, ?, ?, ?)",
    state,
    now,
    now + OAUTH_STATE_TTL_MS,
    allowReplace ? 1 : 0,
  );
}

interface OAuthStateRow {
  expires_at: number;
  allow_replace: number;
  [key: string]: unknown;
}

export interface ConsumeOAuthStateResult {
  /** `true` only if `state` was previously created by `createOAuthState`
   *  and has not yet expired. */
  valid: boolean;
  /** The `allowReplace` flag the state was minted with — only meaningful
   *  when `valid` is `true`; always `false` on an invalid/expired/unknown
   *  state (nothing to read the flag off). */
  allowReplace: boolean;
}

/** Validates and consumes a state token in one step. The row is deleted
 *  unconditionally — whether it matched, whether it was expired, or
 *  whether it didn't exist at all — so a state value can NEVER be
 *  presented twice and succeed, closing a replay window a "check without
 *  delete" implementation would leave open (an attacker who observes a
 *  still-valid state in transit could otherwise race the real callback). A
 *  caller MUST treat `valid: false` as "reject before doing anything else"
 *  — see `oauth-routes.ts`. */
export function consumeOAuthState(sql: SqlExecutor, state: string, now: number): ConsumeOAuthStateResult {
  const row = sql
    .exec<OAuthStateRow>("SELECT expires_at, allow_replace FROM oauth_state WHERE state = ?", state)
    .toArray()[0];
  sql.exec("DELETE FROM oauth_state WHERE state = ?", state);
  if (!row) return { valid: false, allowReplace: false };
  const valid = row.expires_at > now;
  return { valid, allowReplace: valid && row.allow_replace === 1 };
}
