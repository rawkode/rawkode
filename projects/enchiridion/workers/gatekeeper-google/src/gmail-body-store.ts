// @enchiridion/worker-gatekeeper-google — SQLite read/write for
// `gmail_thread_messages`/`gmail_message_bodies` (schema.ts, points 11/12).
// Plain functions over a `SqlExecutor`, no DO/Workers-runtime dependency —
// same pattern as `token-store.ts`/`materialization-store.ts`, directly
// unit-testable against `test-helpers/sqlite-storage-adapter.ts`.
//
// SEARCH STRATEGY — `searchMessageBodies` uses a plain SQL `LIKE` scan over
// `body_text`/`body_html`/`headers`, NOT SQLite's FTS5 virtual-table
// extension. Documented choice (task brief: "LIKE-based search is an
// acceptable P3 baseline, don't over-engineer FTS5 here unless it's
// genuinely trivial to add"): it is NOT trivial here — FTS5 needs its own
// virtual table kept in sync with `gmail_message_bodies` (either a
// `content=` external-content table with manual `INSERT`/`UPDATE`/`DELETE`
// triggers, or a duplicated-storage standalone FTS5 table), a token-quality
// decision (does `subject`/`headers` deserve separate weighting from body
// text?), and — per DO SQLite's documented extension set — FTS5 support
// itself wasn't independently re-verified as available in this sandbox
// (unlike `@cloudflare/workers-types`, which this codebase's other R2/DO
// surfaces were checked against directly; see e.g. `r2-types.ts`'s header).
// `LIKE '%term%'` is a full table scan with no index that can help it, but
// at a single personal mailbox's realistic message-body-row count (low
// thousands even after a year of backfill — see `gmail-ingest.ts`'s
// `BACKFILL_QUERY` window), a scan is fast enough for a P3 baseline; this
// is explicitly flagged as the first thing to swap for FTS5 if search
// volume or corpus size ever makes it a real bottleneck.

import type { SqlExecutor } from "./schema";

export interface StoredMessageBody {
  messageID: string;
  pageID: string;
  threadID: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyHtml?: string;
  receivedAt: number;
}

interface MessageBodyRow {
  message_id: string;
  page_id: string;
  thread_id: string;
  headers: string;
  body_text: string | null;
  body_html: string | null;
  received_at: number;
  [key: string]: unknown;
}

function fromRow(row: MessageBodyRow): StoredMessageBody {
  return {
    messageID: row.message_id,
    pageID: row.page_id,
    threadID: row.thread_id,
    headers: JSON.parse(row.headers) as Record<string, string>,
    bodyText: row.body_text ?? undefined,
    bodyHtml: row.body_html ?? undefined,
    receivedAt: row.received_at,
  };
}

const SELECT_COLUMNS = "message_id, page_id, thread_id, headers, body_text, body_html, received_at";

export function hasMessageBody(sql: SqlExecutor, messageID: string): boolean {
  return sql.exec<{ message_id: string }>("SELECT message_id FROM gmail_message_bodies WHERE message_id = ?", messageID).toArray().length > 0;
}

/** Upserts one message body — idempotent by `messageID` (a message's
 *  content is immutable once sent, so a re-fetch, should one ever happen,
 *  simply overwrites with identical data; see `gmail-body-ingest.ts`'s file
 *  header for why the ingest sweep never re-fetches an already-stored
 *  message in the first place). */
export function setMessageBody(sql: SqlExecutor, body: StoredMessageBody): void {
  sql.exec(
    `INSERT INTO gmail_message_bodies (message_id, page_id, thread_id, headers, body_text, body_html, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (message_id) DO UPDATE SET
       page_id = excluded.page_id,
       thread_id = excluded.thread_id,
       headers = excluded.headers,
       body_text = excluded.body_text,
       body_html = excluded.body_html,
       received_at = excluded.received_at`,
    body.messageID,
    body.pageID,
    body.threadID,
    JSON.stringify(body.headers),
    body.bodyText ?? null,
    body.bodyHtml ?? null,
    body.receivedAt,
  );
}

export function getMessageBody(sql: SqlExecutor, messageID: string): StoredMessageBody | undefined {
  const row = sql.exec<MessageBodyRow>(`SELECT ${SELECT_COLUMNS} FROM gmail_message_bodies WHERE message_id = ?`, messageID).toArray()[0];
  return row ? fromRow(row) : undefined;
}

/** Batched lookup — `GmailReadModel.getMessagesForThreads`'s one query for
 *  however many `EmailThread` page ids a single GraphQL operation asked for
 *  (plan Risk #11 / batching contract — see
 *  `@enchiridion/gatekeeper-google-rpc-contract`'s
 *  `GetMessagesForThreadsParams` doc comment). A page id with no stored
 *  messages is simply absent from the returned map, never an error or an
 *  empty-array entry — the caller (`gmail-read-model.ts`'s
 *  `getMessagesForThreads`) decides how to represent "no messages yet" in
 *  its own return shape. Messages within each page id's array are ordered
 *  oldest-first. */
export function listMessageBodiesByPageIDs(sql: SqlExecutor, pageIDs: readonly string[]): Map<string, StoredMessageBody[]> {
  const result = new Map<string, StoredMessageBody[]>();
  if (pageIDs.length === 0) return result;

  const placeholders = pageIDs.map(() => "?").join(", ");
  const rows = sql
    .exec<MessageBodyRow>(
      `SELECT ${SELECT_COLUMNS} FROM gmail_message_bodies WHERE page_id IN (${placeholders}) ORDER BY received_at ASC`,
      ...pageIDs,
    )
    .toArray();

  for (const row of rows) {
    const body = fromRow(row);
    const existing = result.get(body.pageID);
    if (existing) existing.push(body);
    else result.set(body.pageID, [body]);
  }
  return result;
}

/** `LIKE`-based search across headers + both body variants — see this
 *  file's header for why `LIKE`, not FTS5, was chosen for this P3 pass.
 *  Case-insensitive for ASCII (SQLite's default `LIKE` behavior). Ordered
 *  most-recent-first (`receivedAt DESC`) — the conventional "search
 *  results, newest first" expectation, and cheap here since it's the same
 *  full scan regardless of ORDER BY. */
export function searchMessageBodies(sql: SqlExecutor, query: string, limit: number): StoredMessageBody[] {
  const pattern = `%${query}%`;
  const rows = sql
    .exec<MessageBodyRow>(
      `SELECT ${SELECT_COLUMNS} FROM gmail_message_bodies
       WHERE headers LIKE ? OR body_text LIKE ? OR body_html LIKE ?
       ORDER BY received_at DESC
       LIMIT ?`,
      pattern,
      pattern,
      pattern,
      limit,
    )
    .toArray();
  return rows.map(fromRow);
}

// --- gmail_thread_messages (schema.ts point 11) -------------------------

/** Records that `pageID`'s materialized `EmailThread` is now known to
 *  contain `messageIDs` — `INSERT OR IGNORE` per id, so re-recording an
 *  already-known message (every subsequent materialization of an
 *  unchanged-or-grown thread) is a harmless no-op, never an error and never
 *  a duplicate row (the table's primary key is the `(page_id, message_id)`
 *  pair). Called by `gmail-thread-materialization.ts` on every
 *  `materializeEmailThread` call, success OR skip — the message-id set is
 *  valid/known either way (see that file's own header for why). */
export function recordThreadMessages(sql: SqlExecutor, pageID: string, threadID: string, messageIDs: readonly string[]): void {
  for (const messageID of messageIDs) {
    sql.exec(
      `INSERT INTO gmail_thread_messages (page_id, thread_id, message_id)
       VALUES (?, ?, ?)
       ON CONFLICT (page_id, message_id) DO NOTHING`,
      pageID,
      threadID,
      messageID,
    );
  }
}

export interface MissingMessageBody {
  pageID: string;
  threadID: string;
  messageID: string;
}

/** The body-ingest sweep's catch-up query (`gmail-body-ingest.ts`): every
 *  known `(page, message)` pair with no corresponding row in
 *  `gmail_message_bodies` yet, most-recently-touched thread first (`tm.
 *  rowid DESC` as a cheap recency proxy — newer rows were inserted later;
 *  `gmail_thread_messages` has no `updated_at` column of its own, and
 *  SQLite's implicit `rowid` ordering is a correct, free substitute given
 *  rows are only ever inserted, never updated). Bounded by `limit` — the
 *  cron-tick batch size this worker's other resumable sweeps also respect
 *  (`gmail-ingest.ts`'s `BACKFILL_BATCH_SIZE` is the precedent for "bound
 *  the batch, let a naturally-idempotent design cover the rest across
 *  ticks" — see `gmail-body-ingest.ts`'s header for why NO separate cursor
 *  table is needed here, unlike `gmail_backfill_state`). */
export function listMessagesMissingBodies(sql: SqlExecutor, limit: number): MissingMessageBody[] {
  return sql
    .exec<{ page_id: string; thread_id: string; message_id: string }>(
      `SELECT tm.page_id, tm.thread_id, tm.message_id
       FROM gmail_thread_messages tm
       LEFT JOIN gmail_message_bodies b ON b.message_id = tm.message_id
       WHERE b.message_id IS NULL
       ORDER BY tm.rowid DESC
       LIMIT ?`,
      limit,
    )
    .toArray()
    .map((row) => ({ pageID: row.page_id, threadID: row.thread_id, messageID: row.message_id }));
}

/** VAULT `threadPageID` -> RAW Gmail thread id lookup — added for the
 *  triage write-model (`gmail-triage.ts`/`write-model.ts`'s
 *  `proposeArchiveThread`/`proposeApplyLabel`/`proposeRemoveLabel`/
 *  `proposeMarkRead`/`proposeMarkUnread`), which is deliberately keyed by
 *  the VAULT PageID of an `EmailThread` page (`email_thread_<digest>`,
 *  `@enchiridion/graph-core`'s `deriveEmailThreadPageId`) rather than
 *  Gmail's own raw thread id — same "no provider IDs leak into the graph"
 *  invariant `@enchiridion/gatekeeper-google-rpc-contract`'s
 *  `EmailMessageDTO.threadPageID` already documents (see that package's
 *  file header). `gmail_thread_messages` (this file's own header, point 11)
 *  already stores exactly this `(page_id, thread_id)` pairing for every
 *  materialized thread — every row is inserted during thread
 *  materialization (`gmail-thread-materialization.ts`), which always runs
 *  BEFORE body-ingest can populate `gmail_message_bodies`, so any
 *  `threadPageID` a client could plausibly have obtained via
 *  `searchEmailThreads`/`emailSearch` is guaranteed to already have a row
 *  here. `LIMIT 1` — every row for the same `page_id` carries the same
 *  `thread_id` (one Gmail thread materializes to exactly one `EmailThread`
 *  page), so any row is as good as any other; this is a plain existence
 *  lookup, not an aggregation. Returns `undefined` (not a thrown error) for
 *  an unknown/unresolvable `pageID` — the caller (`write-model.ts`'s
 *  `proposeArchiveThread` etc.) is what turns that into a rejection, at
 *  PROPOSE time, before any approval row is created (mirrors
 *  `proposeSendEmail`'s early-rejection posture via
 *  `validateSendEmailInput`). */
export function resolveThreadIdForPageID(sql: SqlExecutor, pageID: string): string | undefined {
  const row = sql.exec<{ thread_id: string }>("SELECT thread_id FROM gmail_thread_messages WHERE page_id = ? LIMIT 1", pageID).toArray()[0];
  return row?.thread_id;
}
