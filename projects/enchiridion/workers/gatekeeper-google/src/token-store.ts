// @enchiridion/worker-gatekeeper-google — GoogleAccountDO SQLite read/write
// for OAuth tokens and sync cursors.
//
// Plain functions taking a `SqlExecutor` (schema.ts) — no DO/Workers-runtime
// dependency — so they're directly unit-testable against
// `test-helpers/sqlite-storage-adapter.ts`'s real `bun:sqlite` database,
// same pattern `workers/vault/src/vault-write-model.ts` and friends use.
// `google-account-do.ts` is the only production caller.

import type { SqlExecutor } from "./schema";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute epoch-millisecond expiry — NOT the `expires_in` seconds
   *  Google's token endpoint returns; conversion happens once, at write
   *  time (`storeInitialTokens`/`updateAccessToken`), against the caller's
   *  supplied `now`. */
  expiresAt: number;
  updatedAt: number;
  /** The space-delimited `scope` string Google's token endpoint returned
   *  for the most recent successful token response — see `schema.ts`'s
   *  `granted_scopes` column doc comment and `oauth-client.ts`'s
   *  `TokenResponse.scope`. `undefined` if never recorded (a connection
   *  stored before scope tracking existed, or a token response that
   *  happened to omit `scope`) — see `hasGrantedScope`'s fallback for what
   *  that means for scope checks. */
  grantedScopes?: string;
}

interface OAuthTokensRow {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  updated_at: number;
  granted_scopes: string | null;
  [key: string]: unknown;
}

/** Reads the single stored credential row, or `undefined` if OAuth has
 *  never been completed (the row is only ever created by
 *  `storeInitialTokens`, once, after a successful callback exchange). */
export function getStoredTokens(sql: SqlExecutor): StoredTokens | undefined {
  const row = sql
    .exec<OAuthTokensRow>(
      "SELECT access_token, refresh_token, expires_at, updated_at, granted_scopes FROM oauth_tokens WHERE id = 1",
    )
    .toArray()[0];
  if (!row) return undefined;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    grantedScopes: row.granted_scopes ?? undefined,
  };
}

export type StoreInitialTokensResult =
  | { status: "stored" }
  | { status: "already-connected" };

/** Called after a successful token exchange in the OAuth callback route
 *  (`oauth-routes.ts`'s `handleOAuthCallback`).
 *
 * Deliberately does NOT unconditionally upsert. Cloudflare Access already
 * gates who can even reach `/oauth/google/authorize`/`/callback` (see
 * `index.ts`), but that alone doesn't stop a legitimate, Access-authenticated
 * request from silently overwriting a working connection — e.g. a stale
 * bookmark to `/oauth/google/authorize`, or a second admin session,
 * re-running the flow by accident. Google's `calendar.events` scope covers
 * both read and write, so there's no narrower-scope-grant case (unlike the
 * comment this replaces once claimed) that would make a silent replace
 * desirable; every re-authorization is either a genuine reconnect (handled
 * explicitly, see below) or a mistake this function should refuse.
 *
 * `options.allowReplace` is the explicit override: when `true` (only ever
 * set from `oauth-routes.ts`'s callback handler, itself only ever set when
 * `/oauth/google/authorize?reconnect=true` was used to START this specific
 * flow — see `oauth-state.ts`'s `ConsumeOAuthStateResult.allowReplace`),
 * an existing row is replaced. Without it, a pre-existing connection makes
 * this function a no-op that reports `{ status: "already-connected" }`
 * rather than throwing — a discriminated return, not an exception, so it
 * propagates cleanly across the Workers RPC boundary
 * (`GoogleAccountDO.storeInitialTokens` → `oauth-routes.ts`) the same way
 * this worker's other cross-boundary outcomes already do (e.g.
 * `ConfirmApprovalResult` in `write-model.ts`). See `google-account-do.ts`'s
 * `disconnect()` for the other way to clear an existing connection before
 * reconnecting, without the reconnect flag. */
export function storeInitialTokens(
  sql: SqlExecutor,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number; grantedScopes?: string },
  now: number,
  options: { allowReplace?: boolean } = {},
): StoreInitialTokensResult {
  const existing = getStoredTokens(sql);
  if (existing && !options.allowReplace) {
    return { status: "already-connected" };
  }

  const expiresAt = now + tokens.expiresIn * 1000;
  sql.exec(
    `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, updated_at, granted_scopes)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at,
       granted_scopes = excluded.granted_scopes`,
    tokens.accessToken,
    tokens.refreshToken,
    expiresAt,
    now,
    tokens.grantedScopes ?? null,
  );
  return { status: "stored" };
}

/** The one scope this worker could ever have requested before staged Gmail
 *  consent existed — see `hasGrantedScope`'s fallback for a row with no
 *  recorded `granted_scopes` at all. Deliberately a local, lazily-imported-
 *  free constant (not imported from `oauth-client.ts`) to avoid a circular
 *  import between the two modules; the literal is stable Google API surface,
 *  not a value expected to drift independently of `CALENDAR_EVENTS_SCOPE`. */
const LEGACY_DEFAULT_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/** Splits a stored `granted_scopes` string into its individual scope URLs.
 *  Google's token endpoint space-delimits multiple scopes in one `scope`
 *  string; this is the inverse. Returns `undefined` (not `[]`) when no
 *  connection exists or no scope was ever recorded — see
 *  `hasGrantedScope`'s fallback for why that's a distinct case from "recorded
 *  as granting nothing". */
export function getGrantedScopes(sql: SqlExecutor): string[] | undefined {
  const stored = getStoredTokens(sql);
  if (!stored) return undefined;
  if (stored.grantedScopes === undefined) return undefined;
  return stored.grantedScopes.split(/\s+/).filter((s) => s.length > 0);
}

/** Backs `GoogleAccountDO.hasScope()` — the query Gmail-ingest logic (a
 *  follow-up task, plan §Google gatekeeper) is expected to call before
 *  attempting ANY Gmail API request, so a declined/never-requested scope
 *  fails with a clear "reconnect with Gmail access" message rather than a
 *  confusing Google API 403.
 *
 *  Three cases:
 *   - No connection at all (`getStoredTokens` returns `undefined`): `false`
 *     for every scope — nothing has been granted if nothing is connected.
 *   - A connection exists but recorded NO `granted_scopes` at all (`stored.
 *     grantedScopes === undefined` — either a pre-scope-tracking connection,
 *     or a token response that happened to omit `scope`): falls back to
 *     treating exactly `CALENDAR_EVENTS_SCOPE` as granted (the only scope
 *     this worker could have requested before Gmail scopes existed) and
 *     every other scope as NOT granted — a legacy calendar-only connection
 *     must not be reported as having Gmail access it never actually
 *     consented to.
 *   - A connection exists with a recorded (possibly empty) `granted_scopes`
 *     string: exact membership check against the space-delimited set —
 *     this is the normal case once staged consent has run at least once.
 */
export function hasGrantedScope(sql: SqlExecutor, scope: string): boolean {
  const stored = getStoredTokens(sql);
  if (!stored) return false;
  if (stored.grantedScopes === undefined) return scope === LEGACY_DEFAULT_SCOPE;
  return getGrantedScopes(sql)?.includes(scope) ?? false;
}

/** Clears the stored credential row entirely — the explicit "disconnect"
 *  step `storeInitialTokens`'s no-silent-replace guard points callers at.
 *  Called by `GoogleAccountDO.disconnect()`. A no-op (not an error) if no
 *  connection exists — disconnecting an already-disconnected account is not
 *  a failure. Deliberately does NOT touch `sync_cursors` — the calendar
 *  `syncToken`/future Gmail `historyId` — so a subsequent reconnect can
 *  still resume incremental sync rather than being forced into a full
 *  resync; if a caller ever wants a hard reset, that's a separate,
 *  explicit operation, not folded into disconnect. */
export function deleteStoredTokens(sql: SqlExecutor): void {
  sql.exec("DELETE FROM oauth_tokens WHERE id = 1");
}

/** Called after a successful token-refresh call (`token-refresh.ts`).
 *  `refreshToken` is optional because a bare `refresh_token` grant
 *  response usually does NOT repeat the refresh token that was spent to
 *  make the call — Google only sends a new one on (rare) rotation, in
 *  which case the stored one must be replaced or the old one becomes
 *  unusable on the next refresh. When absent, the existing stored
 *  refresh_token is left untouched. */
export function updateAccessToken(
  sql: SqlExecutor,
  update: { accessToken: string; refreshToken?: string; expiresIn: number },
  now: number,
): void {
  const expiresAt = now + update.expiresIn * 1000;
  if (update.refreshToken) {
    sql.exec(
      "UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = 1",
      update.accessToken,
      update.refreshToken,
      expiresAt,
      now,
    );
  } else {
    sql.exec(
      "UPDATE oauth_tokens SET access_token = ?, expires_at = ?, updated_at = ? WHERE id = 1",
      update.accessToken,
      expiresAt,
      now,
    );
  }
}

interface SyncCursorRow {
  cursor_value: string;
  [key: string]: unknown;
}

/** `resource` is a free-form key (e.g. `"calendar"` today, `"gmail"` in a
 *  future P3 pass) — see schema.ts's file header on why this table is
 *  generic rather than Calendar-specific. */
export function getSyncCursor(sql: SqlExecutor, resource: string): string | undefined {
  const row = sql.exec<SyncCursorRow>("SELECT cursor_value FROM sync_cursors WHERE resource = ?", resource).toArray()[0];
  return row?.cursor_value;
}

export function setSyncCursor(sql: SqlExecutor, resource: string, value: string, now: number): void {
  sql.exec(
    `INSERT INTO sync_cursors (resource, cursor_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (resource) DO UPDATE SET
       cursor_value = excluded.cursor_value,
       updated_at = excluded.updated_at`,
    resource,
    value,
    now,
  );
}
