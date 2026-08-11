// @enchiridion/worker-gatekeeper-google — the poison-pill-isolation log for
// `gmail-body-ingest.ts`, mirroring `gmail-ingest-failures-store.ts`
// one-for-one but scoped to a single MESSAGE rather than a whole thread
// (schema.ts's `gmail_body_ingest_failures`, point 14). Deliberately a
// separate module/table from `gmail-ingest-failures-store.ts` rather than a
// generalization of it — same "don't touch already-reviewed working code
// for a four-column table" reasoning that file's own header documents for
// why IT is a separate copy of `ingest-failures-store.ts`.

import type { SqlExecutor } from "./schema";

export interface GmailBodyIngestFailure {
  id: number;
  messageID: string | null;
  threadID: string | null;
  errorMessage: string;
  failedAt: number;
}

interface FailureRow {
  id: number;
  message_id: string | null;
  thread_id: string | null;
  error_message: string;
  failed_at: number;
  [key: string]: unknown;
}

/** Records one message's body/attachment-ingest failure. Never throws
 *  itself — see `gmail-ingest-failures-store.ts`'s identical doc comment;
 *  `gmail-body-ingest.ts`'s per-message try/catch calls this from inside
 *  its `catch` block. */
export function recordGmailBodyIngestFailure(
  sql: SqlExecutor,
  input: { messageID: string | null; threadID: string | null; errorMessage: string },
  now: number,
): void {
  sql.exec(
    `INSERT INTO gmail_body_ingest_failures (message_id, thread_id, error_message, failed_at) VALUES (?, ?, ?, ?)`,
    input.messageID,
    input.threadID,
    input.errorMessage,
    now,
  );
}

/** Every recorded body-ingest failure, most recent first. */
export function readGmailBodyIngestFailures(sql: SqlExecutor): GmailBodyIngestFailure[] {
  return sql
    .exec<FailureRow>(
      "SELECT id, message_id, thread_id, error_message, failed_at FROM gmail_body_ingest_failures ORDER BY id DESC",
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      messageID: row.message_id,
      threadID: row.thread_id,
      errorMessage: row.error_message,
      failedAt: row.failed_at,
    }));
}
