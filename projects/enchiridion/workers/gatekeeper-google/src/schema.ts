// @enchiridion/worker-gatekeeper-google — GoogleAccountDO SQLite schema.
//
// Plan §Google gatekeeper (Calendar P2, Gmail P3): "OAuth server-side;
// tokens + cursors in a GoogleAccountDO." This file owns every table that
// DO's storage layer creates, mirroring `workers/vault/src/schema.ts`'s
// convention (one file, all DDL, a plain `initializeSchema(sql)` entry
// point) so `token-store.ts`, `oauth-state.ts`, and `google-account-do.ts`
// all agree on names/columns instead of re-declaring DDL locally.
//
// Seven tables:
//
// 1. `oauth_tokens` — single row (`id = 1`): this worker manages exactly
//    one Google account (plan: single-user scope), so there is no
//    multi-account key here, matching `vault-stub.ts`'s "single, fixed DO
//    name" placeholder reasoning for the same underlying assumption.
//    `granted_scopes` (added for staged Gmail consent, plan §Google OAuth
//    pin: "calendar.events -> gmail.readonly -> gmail.send, separate
//    consent") is the space-delimited `scope` string Google's token
//    endpoint actually returned for the MOST RECENT successful token
//    response (initial exchange or refresh) — NOT the scope that was
//    requested; a user can decline part of a consent screen, so this can be
//    a narrower set than `buildAuthorizationUrl` asked for
//    (`oauth-client.ts`'s `TokenResponse.scope` doc comment). Nullable
//    because a connection stored before this column existed has no
//    recorded value — `token-store.ts`'s `hasGrantedScope` documents the
//    fallback behavior for that case. `initializeSchema` below adds this
//    column to an already-existing table via a guarded `ALTER TABLE`, since
//    `CREATE TABLE IF NOT EXISTS` alone is a no-op against a table that
//    already exists from before this column was added.
// 2. `sync_cursors` — generic `(resource, cursor_value)` pairs, deliberately
//    NOT specific to Calendar: `resource = "calendar"` stores a Calendar
//    `syncToken` today; a future P3 Gmail pass reuses this same table with
//    `resource = "gmail"` storing a `historyId`, per the task brief ("a
//    generic sync_cursors table ... generic enough for both P2 and future
//    P3").
// 3. `oauth_state` — short-lived CSRF state tokens for the authorization-
//    code flow (`oauth-state.ts`), NOT part of the "clean interface" a
//    calendar-ingest follow-up task needs; purely OAuth-flow bookkeeping.
//    `allow_replace` carries a `/oauth/google/authorize?reconnect=true`
//    request's intent through Google's redirect round-trip so the callback
//    can tell "this authorize call explicitly asked to replace an existing
//    connection" apart from "this is a normal first-time connect" without
//    trusting anything client-supplied on the callback itself — see
//    `token-store.ts`'s header for why `storeInitialTokens` refuses to
//    silently replace an existing connection otherwise.
// 4. `calendar_materialization_state` — one row per materialized Event/
//    Person page, keyed by that page's deterministic PageID
//    (`materialization-store.ts`). Holds a persisted Loro doc SNAPSHOT (not
//    just a baseline hash) — see `materialized-doc.ts`'s file header for
//    why: this worker calls VaultDO's `createOrUpdatePage` RPC "blind" (no
//    RPC exists to fetch a page's current raw doc bytes back), so it must
//    keep its OWN durable copy of the doc it last wrote in order to build
//    correctly-ordered (causally-descended) future edits — otherwise a
//    freshly-constructed `LoroDoc` on every cron tick would produce ops
//    with low Lamport counters that silently LOSE Loro's last-write-wins
//    conflict resolution against the doc's already-more-advanced state in
//    VaultDO once more than one materialization write has happened.
//    `field_hashes` is the change-detection cache: a JSON-encoded map of
//    EACH owned field's own hash (`calendar-materialization.ts`'s
//    `eventFieldBaselineHashes`/`personFieldBaselineHashes`), not one
//    bundled hash for the whole page — `materialization.ts` diffs this
//    against a freshly computed map (`diffChangedFields`) and only
//    re-touches the specific fields whose OWN hash changed, so an
//    unrelated provider-side field change can no longer cause a rewrite
//    attempt on a field that didn't actually change at the source. (A
//    single combined hash was the original P2 shape — fixed per
//    adversarial review, see the plan's "Google gatekeeper" section.)
// 5. `pending_approvals` — one row per proposed write (create/RSVP), gating
//    real Google Calendar mutation behind an explicit `confirmApproval`
//    call (`approvals-store.ts`, `write-model.ts`). `version_token` is the
//    first-writer-wins compare-and-swap key: `confirmApproval` only
//    transitions a row `pending -> confirmed` when the caller's token
//    still matches AND status is still `pending`; a racing second
//    confirmation sees a `conflict`. Its `confirmed` status can get
//    durably stuck if a DO is interrupted between `tryConfirmApproval`'s
//    CAS commit and the terminal `executed`/`failed` transition
//    (`write-model.ts`'s `confirmApproval`) — reconciled by
//    `approvals-store.ts`'s `reconcileStuckConfirmedApprovals`, which
//    reuses this table's own `updated_at` column (the CAS commit
//    timestamp) rather than a new table/column, since no concurrent
//    writer can touch a `confirmed` row before this sweep does
//    (`tryConfirmApproval` only ever transitions `pending` rows). A stuck
//    `sendEmail` approval is reconciled to a DISTINCT `"unknown"` status,
//    not `"failed"` — see `provider_message_id`'s own comment on this
//    table's DDL below, and `approvals-store.ts`'s
//    `reconcileStuckConfirmedApprovals` doc comment, for why (Fix 2,
//    adversarial review).
// 6. `action_log` — append-only (this worker never issues an `UPDATE`/
//    `DELETE` against it) audit trail of every propose/confirm/execute/fail
//    transition, independent of `pending_approvals`' current-state row so
//    the history survives even though `pending_approvals` only tracks the
//    latest state per approval.
// 7. `calendar_ingest_failures` — the "record the failure, advance past
//    it" poison-pill-isolation log for calendar cron ingest
//    (`calendar-ingest.ts`, `ingest-failures-store.ts`), mirroring
//    `workers/vault/src/rebuild-projections.ts`'s `rebuild_failures` table
//    one-for-one: one event whose `normalizeOccurrence`/
//    `materializeEventOccurrence`/`retractCancelledEvent` call throws must
//    never abort the rest of the fetched batch — see `calendar-ingest.ts`'s
//    file header for the full "cursor only advances after the whole batch
//    has been attempted" argument this table exists to support.
//
// Three more tables, added for "P3: Gmail" (plan §Google gatekeeper, Gmail
// section) — `calendar_materialization_state` (point 4 above) is reused
// AS-IS for materialized EmailThread/Person pages too (it's already keyed
// generically by pageID, not calendar-specific data — see
// `gmail-materialized-doc.ts`'s file header for why a materialized Gmail
// Person page shares the SAME table, and potentially the SAME row, as a
// Calendar-attendee-origin Person page for the same email):
//
// 8. `gmail_backfill_state` — single row (`id = 1`), the persisted
//    checkpoint for Gmail's chunked/resumable initial backfill
//    (`gmail-ingest.ts`). `page_token` is the last `threads.list`
//    `nextPageToken` this worker has NOT yet processed (NULL = start from
//    the very first page); `completed` flips to `1` once a backfill page
//    comes back with no `nextPageToken` at all (every thread in the
//    backfill window has been attempted at least once) — `gmail-ingest.ts`
//    then switches this worker into `history.list`-based incremental sync
//    for good, until/unless a `404` (expired `historyId`) resets this row
//    back to a fresh backfill (see that file's header for the full
//    mode-switch logic).
// 9. `gmail_participant_stats` — the participant quality-gate ledger (plan:
//    "Person pages are only auto-created for correspondents you've
//    actually exchanged mail with, not every newsletter sender" —
//    `gmail-materialization.ts`'s file header documents the exact
//    heuristic and why it's implemented this way rather than one of the
//    plan's two suggested alternatives verbatim). `sent_to_count` is
//    cumulative across EVERY ingest cycle for this address's lifetime
//    (backfill and incremental alike) — once an address crosses the gate
//    it stays qualified forever (this worker never revokes a Person page
//    once created, matching the "never auto-promoted" but also
//    never-auto-demoted posture the rest of this worker's materialization
//    already takes for granted).
// 10. `gmail_ingest_failures` — the Gmail-side twin of
//     `calendar_ingest_failures` (point 7 above) — one bad thread's
//     `normalizeThread`/materialization call must not abort the rest of a
//     fetched backfill/incremental batch, mirrored one-for-one via
//     `gmail-ingest-failures-store.ts` (see that file's header, itself a
//     near-verbatim copy of `ingest-failures-store.ts`'s own header
//     argument — duplicated rather than generalized to keep Calendar's
//     already-adversarially-reviewed table/module completely untouched by
//     this pass, per this task's "do not reintroduce any of these
//     already-fixed bug classes" instruction: touching shared code here
//     would be new surface for the SAME bug class to hide in, for no
//     reuse benefit big enough to justify the risk).
//
// Four more tables, added for "Gmail message bodies + attachments" (plan
// §Google gatekeeper, Gmail section: "Message bodies stay out of the CRDT
// graph — bodies in gatekeeper DO SQLite, attachments in R2 (same
// content-addressed scheme), served via server-only GraphQL fields
// (`thread.messages`, `emailSearch`)"). NONE of this data is ever pushed to
// VaultDO (see `vault-client.ts`'s `pushPageUpdate` — nothing in
// `gmail-body-ingest.ts` calls it) — these four tables ARE the durable
// store the plan's "bodies stay out of the CRDT graph" sentence refers to.
//
// 11. `gmail_thread_messages` — one row per (materialized EmailThread page,
//     Gmail message id) the thread-materialization pipeline
//     (`gmail-thread-materialization.ts`) has ever observed, keyed by the
//     PAIR so the same message id can't accidentally collide across two
//     different thread pages. This is NOT the body/attachment storage
//     itself (see points 12/13) — it's the durable "which messages exist"
//     index `gmail-body-ingest.ts`'s catch-up sweep joins against
//     `gmail_message_bodies` to find messages that still need their full
//     content fetched (a plain SQL `LEFT JOIN ... WHERE body.message_id IS
//     NULL`, deliberately NOT a JSON-array column + `json_each` — see
//     `gmail-body-store.ts`'s file header for why a real join table was
//     chosen over encoding the message-id set as JSON). A message id, once
//     recorded here, is never deleted (Gmail threads only ever gain
//     messages from this worker's perspective — see
//     `gmail-thread-materialization.ts`'s own header for why re-recording
//     an already-known id is a harmless `INSERT OR IGNORE`).
// 12. `gmail_message_bodies` — one row per Gmail message this worker has
//     fetched in `format=full` and parsed (`gmail-mime.ts`'s
//     `parseGmailMessage`). `page_id` is the VAULT PageID of the
//     `EmailThread` page this message belongs to (`email_thread_<digest>`,
//     `@enchiridion/graph-core`'s `deriveEmailThreadPageId`) — indexed
//     (`idx_gmail_message_bodies_page_id`) because `EmailThread.messages`'s
//     resolver (`workers/vault`'s composed schema, over the
//     `/gmail/messages` route) looks messages up BY page id, batched across
//     however many threads one GraphQL operation asked for, never by raw
//     Gmail thread id (which never crosses the worker boundary at all —
//     `@enchiridion/gatekeeper-google-rpc-contract`'s `EmailMessageDTO`
//     carries `threadPageID`, not Gmail's own thread id). `thread_id` (the
//     RAW Gmail thread id) is still kept here too — purely a local
//     debugging/fidelity aid for this worker's own storage, mirroring
//     `calendar_materialization_state`'s posture on keeping more than the
//     read path strictly needs when the extra column is nearly free.
//     `headers` is a JSON-encoded `Record<string,string>` of exactly the
//     header names `gmail-mime.ts` extracts (`From`/`To`/`Cc`/`Subject`/
//     `Date`) — NOT the full raw header list Gmail returns, matching this
//     worker's established "extract only what's needed, never store the
//     whole provider payload verbatim" posture (`gmail-materialization.ts`'s
//     `METADATA_HEADERS` allowlist is the same policy applied to metadata-
//     format ingest). `body_text`/`body_html` are nullable — a message can
//     genuinely have only one MIME alternative, or (rare, but
//     `gmail-mime.ts` must not throw on it) neither.
// 13. `gmail_message_attachments` — one row per attachment PART this worker
//     has uploaded to its own R2 bucket (`GMAIL_ATTACHMENTS`,
//     wrangler.jsonc) — see that binding's doc comment for the
//     bucket-ownership decision (gatekeeper-google's OWN bucket, not
//     vault's `enchiridion-blobs`). `blob_id` is `@enchiridion/graph-core`'s
//     `deriveBlobId` output over the attachment's decoded bytes — the SAME
//     content-addressed `blob_<sha256>` scheme vault's own blob routes use
//     (plan: "same content-addressed scheme"), so an identical attachment
//     that also happens to exist in vault's bucket (e.g. forwarded from an
//     email into a page as a manual upload) would derive to the SAME id,
//     even though the BYTES live in two separate buckets — deliberate, see
//     wrangler.jsonc's bucket-ownership comment for why sharing a bucket
//     wasn't chosen instead. Indexed by `message_id`
//     (`idx_gmail_message_attachments_message_id`) for the same
//     batched-by-message-set read pattern as point 12.
// 14. `gmail_body_ingest_failures` — the poison-pill-isolation log for
//     `gmail-body-ingest.ts`, mirroring `gmail_ingest_failures` (point 10)
//     one-for-one but scoped to per-MESSAGE (not per-thread) failures: one
//     message whose `getMessage(format:"full")`/`getMessageAttachment`/R2
//     upload call throws must not abort the rest of that cron tick's batch
//     of otherwise-unrelated messages across possibly many different
//     threads.
//
// One more table, added for "P8: Live Backend Connectivity" —
// `proposeRsvp`'s real Google event-ID verification (plan: closes the gap
// P5 originally flagged and P7 flagged again — see `write-model.ts`'s
// `resolveEventIdOrThrow` doc comment):
//
// 15. `calendar_event_ids` — VAULT Event `pageID` -> REAL Google Calendar
//     `(eventId, calendarId)` lookup, the calendar twin of
//     `gmail_thread_messages` (point 11)'s `threadPageID` -> raw Gmail
//     thread id mapping. Populated by `calendar-ingest.ts` on every
//     ingested (non-cancelled) occurrence — `event.id` is stable across a
//     page's lifetime once assigned, so this is a plain upsert keyed by
//     `page_id`, not append-only. Removed when the provider reports the
//     event `cancelled` (`calendar-ingest.ts`'s retraction path), so a
//     retracted event can never resolve for a fresh RSVP proposal.
//     `calendar-write-model.ts`'s `RsvpInput` carries the vault-side
//     `eventPageID` a caller actually has (never Google's raw event id
//     directly, per this codebase's "no provider IDs leak into the graph"
//     invariant applied to the write direction too, mirroring
//     `gmail-triage.ts`'s `threadPageID` design) — `write-model.ts`'s
//     `proposeRsvp` resolves it against this table BEFORE creating any
//     approval row, rejecting immediately (`RsvpEventNotFoundError`) if
//     unresolvable.
//
// DO SQLite storage: `SqlStorage.exec()` is synchronous (no async I/O — the
// whole DO SQLite database is memory-mapped into the isolate), so every
// function in this module is synchronous too — same reasoning as vault's
// schema.ts.

/** Minimal ambient shape of Cloudflare's `SqlStorage` this module needs —
 *  declared locally (rather than importing `@cloudflare/workers-types`'
 *  `SqlStorage` directly) so this worker's storage modules can be unit
 *  tested against a `bun:sqlite`-backed adapter
 *  (`test-helpers/sqlite-storage-adapter.ts`), which implements this same
 *  shape. Kept structurally identical to the real `SqlStorage` interface
 *  (same method signature) so no adapting is needed at the call site in
 *  `google-account-do.ts`. Deliberately duplicated from
 *  `workers/vault/src/schema.ts` rather than imported — these are two
 *  independently deployed workers with no shared runtime package between
 *  them (matching the plan's "no gateway, no shared subgraph" stance for
 *  this pair of workers). */
export interface SqlExecutor {
  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}

export interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
  raw<U extends unknown[]>(): IterableIterator<U>;
  columnNames: string[];
  [Symbol.iterator](): IterableIterator<T>;
}

const DDL_STATEMENTS: readonly string[] = [
  // Single-row credential store — `storeInitialTokens` upserts this row on
  // first OAuth completion; `updateAccessToken` updates it on every
  // subsequent refresh. `expires_at`/`updated_at` are epoch-millisecond
  // integers (DO SQLite has no native date type, matching vault's schema
  // convention).
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    granted_scopes TEXT
  )`,

  // Generic per-resource sync cursor — see this file's header point 2.
  `CREATE TABLE IF NOT EXISTS sync_cursors (
    resource TEXT PRIMARY KEY,
    cursor_value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  // CSRF state for the authorization-code flow (`oauth-state.ts`). Each row
  // is consumed (deleted) on first use by `consumeOAuthState`, whether or
  // not it validates — see that file's header for why a state can never be
  // replayed, valid or not. `allow_replace` — see this file's header point 3.
  `CREATE TABLE IF NOT EXISTS oauth_state (
    state TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    allow_replace INTEGER NOT NULL DEFAULT 0
  )`,

  // See this file's header point 4. `doc_snapshot` is a full Loro
  // `exportSnapshot()` blob for the page as this worker last wrote it —
  // small (a handful of scalar properties + a title + a few edges), not
  // the page's full synced state (VaultDO/devices may have merged in more
  // since, e.g. a user's own edits to other fields — that's fine, this
  // snapshot only needs to be causally sufficient for THIS worker's own
  // next write, not a mirror of vault's truth).
  `CREATE TABLE IF NOT EXISTS calendar_materialization_state (
    page_id TEXT PRIMARY KEY,
    field_hashes TEXT NOT NULL,
    doc_snapshot BLOB NOT NULL,
    last_synced_at INTEGER NOT NULL
  )`,

  // See this file's header point 5. `payload` is a JSON-encoded action
  // input (shape depends on `action_type` — see `approvals-store.ts`).
  // `result` is populated once the approval reaches a terminal state
  // (`executed`/`failed`) — JSON-encoded outcome (the created event id, or
  // an error message).
  // `provider_message_id` (adversarial review, plan §Google gatekeeper Fix
  // 2) — nullable, populated ONLY for `sendEmail` approvals, at PROPOSE
  // time (`write-model.ts`'s `proposeSendEmail`, via `gmail-send.ts`'s
  // `generateGmailMessageId`). Holds the RFC 2822 `Message-ID` this
  // approval's outgoing message carries (or will carry, once/if it's
  // actually sent) — the idempotency key a future reconciliation-time
  // Gmail search would key off of to tell whether a stuck `confirmed`
  // `sendEmail` approval's message actually reached Gmail despite the DO
  // interruption (see `approvals-store.ts`'s
  // `reconcileStuckConfirmedApprovals` doc comment for why that search
  // isn't wired up yet, and what ships in this pass instead). `createEvent`/
  // `rsvp` approvals never populate this column — Calendar's stuck-approval
  // story has no equivalent irreversibility risk (see the same doc comment).
  `CREATE TABLE IF NOT EXISTS pending_approvals (
    id TEXT PRIMARY KEY,
    action_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    version_token TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    provider_message_id TEXT
  )`,

  // See this file's header point 6. Append-only by convention (enforced by
  // never issuing UPDATE/DELETE against this table anywhere in this
  // worker, not by a DB-level trigger) — `approval_id` is nullable only in
  // principle (every row this worker writes today has one); kept nullable
  // rather than required in case a future non-approval-gated action ever
  // needs to log here too.
  `CREATE TABLE IF NOT EXISTS action_log (
    id TEXT PRIMARY KEY,
    approval_id TEXT,
    action_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    outcome TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  // See this file's header point 7. `event_id`/`ical_uid` are nullable —
  // an event can fail before `normalizeOccurrence` derives an identity at
  // all (a malformed response), so this table logs whatever identifying
  // information was available at the point of failure, never less than
  // Google's raw `id` when even that couldn't be read.
  `CREATE TABLE IF NOT EXISTS calendar_ingest_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    ical_uid TEXT,
    error_message TEXT NOT NULL,
    failed_at INTEGER NOT NULL
  )`,

  // See this file's header, point 8.
  `CREATE TABLE IF NOT EXISTS gmail_backfill_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    page_token TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,

  // See this file's header, point 9.
  `CREATE TABLE IF NOT EXISTS gmail_participant_stats (
    email TEXT PRIMARY KEY,
    sent_to_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,

  // See this file's header, point 10.
  `CREATE TABLE IF NOT EXISTS gmail_ingest_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT,
    error_message TEXT NOT NULL,
    failed_at INTEGER NOT NULL
  )`,

  // See this file's header, point 11.
  `CREATE TABLE IF NOT EXISTS gmail_thread_messages (
    page_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (page_id, message_id)
  )`,

  // See this file's header, point 12.
  `CREATE TABLE IF NOT EXISTS gmail_message_bodies (
    message_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    headers TEXT NOT NULL,
    body_text TEXT,
    body_html TEXT,
    received_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gmail_message_bodies_page_id ON gmail_message_bodies (page_id)`,

  // See this file's header, point 13.
  `CREATE TABLE IF NOT EXISTS gmail_message_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    filename TEXT,
    mime_type TEXT,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gmail_message_attachments_message_id ON gmail_message_attachments (message_id)`,

  // See this file's header, point 14.
  `CREATE TABLE IF NOT EXISTS gmail_body_ingest_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    thread_id TEXT,
    error_message TEXT NOT NULL,
    failed_at INTEGER NOT NULL
  )`,

  // See this file's header, point 15.
  `CREATE TABLE IF NOT EXISTS calendar_event_ids (
    page_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL
  )`,
];

/** Idempotently creates every table this DO owns. Safe to call on every DO
 *  wake (constructor) — schema state must be durable and re-derivable from
 *  a cold start, never assumed already-applied (same reasoning as vault's
 *  `initializeSchema`). */
export function initializeSchema(sql: SqlExecutor): void {
  for (const statement of DDL_STATEMENTS) {
    sql.exec(statement);
  }
  addGrantedScopesColumnIfMissing(sql);
  addProviderMessageIdColumnIfMissing(sql);
}

/** Additive migration for a DO whose `oauth_tokens` table was created
 *  before `granted_scopes` existed (see this file's header, point 1) — a
 *  fresh DO already gets the column from `CREATE TABLE IF NOT EXISTS`
 *  above, so this is a no-op for it; SQLite has no `ADD COLUMN IF NOT
 *  EXISTS` syntax, so "already applied" is detected by catching the
 *  "duplicate column name" error `ALTER TABLE` raises rather than checking
 *  first — same idempotent-by-catching-the-expected-error shape as this
 *  worker's other "safe to call unconditionally on every wake" functions. */
function addGrantedScopesColumnIfMissing(sql: SqlExecutor): void {
  try {
    sql.exec("ALTER TABLE oauth_tokens ADD COLUMN granted_scopes TEXT");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }
}

/** Additive migration for a DO whose `pending_approvals` table was created
 *  before `provider_message_id` existed (see this file's Fix 2 comment
 *  above `pending_approvals`'s DDL) — same idempotent-by-catching-the-
 *  expected-error shape as `addGrantedScopesColumnIfMissing`. */
function addProviderMessageIdColumnIfMissing(sql: SqlExecutor): void {
  try {
    sql.exec("ALTER TABLE pending_approvals ADD COLUMN provider_message_id TEXT");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }
}
