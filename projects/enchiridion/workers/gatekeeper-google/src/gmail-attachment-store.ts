// @enchiridion/worker-gatekeeper-google — SQLite read/write for
// `gmail_message_attachments` (schema.ts, point 13). Plain functions over a
// `SqlExecutor`, no DO/Workers-runtime dependency — same pattern as every
// other `*-store.ts` module in this worker.

import type { SqlExecutor } from "./schema";

export interface StoredAttachment {
  messageID: string;
  blobID: string;
  filename?: string;
  mimeType?: string;
  size: number;
}

interface AttachmentRow {
  message_id: string;
  blob_id: string;
  filename: string | null;
  mime_type: string | null;
  size: number;
  [key: string]: unknown;
}

function fromRow(row: AttachmentRow): StoredAttachment {
  return {
    messageID: row.message_id,
    blobID: row.blob_id,
    filename: row.filename ?? undefined,
    mimeType: row.mime_type ?? undefined,
    size: row.size,
  };
}

/** Records one uploaded attachment part. NOT deduplicated by `(message_id,
 *  blob_id)` at the SQL level (no unique constraint) — a re-ingest of the
 *  same message is prevented upstream by `gmail-body-store.ts`'s
 *  `hasMessageBody` check (a message with a stored body is never
 *  re-processed at all, see `gmail-body-ingest.ts`), so this function is
 *  only ever called once per real attachment part in practice; a plain
 *  `INSERT` keeps this function simple rather than defending against a
 *  case its one caller already prevents. */
export function recordAttachment(sql: SqlExecutor, attachment: StoredAttachment, now: number): void {
  sql.exec(
    `INSERT INTO gmail_message_attachments (message_id, blob_id, filename, mime_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    attachment.messageID,
    attachment.blobID,
    attachment.filename ?? null,
    attachment.mimeType ?? null,
    attachment.size,
    now,
  );
}

/** Batched lookup across however many message ids the `/gmail/messages`
 *  route needs attachments for in one call (same N+1-avoidance contract as
 *  `gmail-body-store.ts`'s `listMessageBodiesByPageIDs`) — a message id
 *  with no attachments is absent from the returned map, never an empty-array
 *  entry (the caller decides how to represent "no attachments"). */
export function listAttachmentsByMessageIDs(sql: SqlExecutor, messageIDs: readonly string[]): Map<string, StoredAttachment[]> {
  const result = new Map<string, StoredAttachment[]>();
  if (messageIDs.length === 0) return result;

  const placeholders = messageIDs.map(() => "?").join(", ");
  const rows = sql
    .exec<AttachmentRow>(
      `SELECT message_id, blob_id, filename, mime_type, size FROM gmail_message_attachments
       WHERE message_id IN (${placeholders}) ORDER BY id ASC`,
      ...messageIDs,
    )
    .toArray();

  for (const row of rows) {
    const attachment = fromRow(row);
    const existing = result.get(attachment.messageID);
    if (existing) existing.push(attachment);
    else result.set(attachment.messageID, [attachment]);
  }
  return result;
}
