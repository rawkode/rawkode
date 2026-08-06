// @enchiridion/worker-gatekeeper-google — Gmail API v1 HTTP client.
//
// Plan §Google gatekeeper: "Gmail: initial backfill is chunked and
// resumable ... Then history.list incremental with the same expiry
// fallback Calendar gets". Pure functions, no DO/Workers-runtime
// dependency, injectable `fetchImpl` — same testable-HTTP-client pattern as
// `calendar-api.ts`/`oauth-client.ts` (see either file's header). This
// module owns four Gmail API v1 endpoints under `users.me`:
//   - `threads.list` / `threads.get` — thread discovery + per-thread detail
//     (subject/participants/labels/snippet), used by both backfill and
//     history-triggered incremental re-fetches (`gmail-ingest.ts`).
//   - `history.list` — the incremental-sync primitive, keyed by
//     `historyId` (Gmail's equivalent of Calendar's `syncToken`).
//   - `messages.list` / `messages.get` — NOT used by this pass's ingest
//     orchestration (`threads.get` already returns each message's headers
//     inline, which is all thread materialization needs), but built now
//     per the task brief so the follow-up message-bodies/attachments task
//     (plan: "Message bodies stay out of the CRDT graph — bodies in
//     gatekeeper DO SQLite ... served via server-only GraphQL fields") has
//     a ready client rather than needing to add one from scratch.
//   - `getProfile` — NOT one of the four endpoints the task brief names,
//     but a real, minimal Gmail API v1 endpoint (`users.getProfile`) this
//     worker needs for two things `gmail-ingest.ts` documents in full:
//     discovering the account's own email address (to exclude "yourself"
//     from thread participant edges) and seeding the very first
//     `historyId` cursor once backfill completes (Gmail's `threads.list`/
//     `threads.get` responses don't carry a mailbox-wide "current
//     historyId" the way Calendar's `events.list` carries `nextSyncToken`
//     on its own listing calls).
//
// Response shapes below are the REAL Gmail API v1 resource shapes (per
// Google's published API reference —
// https://developers.google.com/gmail/api/reference/rest/v1/users.threads,
// .../users.messages, .../users.history, .../users.getProfile), not a
// simplified stand-in: `labelIds`/`internalDate`/`payload.headers` nesting,
// `nextPageToken` pagination, and the `404` expired-`historyId` error shape
// are all exactly what a real deployment sees.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailHeader {
  name: string;
  value: string;
}

/** Trimmed-down `payload` shape — this worker only ever requests
 *  `format=metadata` with an explicit `metadataHeaders` allowlist
 *  (`METADATA_HEADERS` below), so `headers` is the only field ever
 *  populated; `parts`/`body`/`mimeType` (present on `format=full`) are
 *  deliberately NOT modeled here — reading a message body is out of this
 *  pass's scope (plan: "Message bodies stay out of the CRDT graph"), and a
 *  `metadata`-format response never includes them anyway. */
export interface GmailMessagePayload {
  headers?: GmailHeader[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  /** System + user label ids (e.g. `"INBOX"`, `"IMPORTANT"`, `"SENT"`, or a
   *  user label's opaque id like `"Label_1"`) — see
   *  `gmail-materialization.ts` for how `"SENT"` specifically drives the
   *  participant quality gate. */
  labelIds?: string[];
  snippet?: string;
  /** Epoch MILLISECONDS, encoded as a decimal STRING — Gmail's actual wire
   *  type (not a number), per the API reference. `gmail-materialization.ts`
   *  parses this with `Number(...)`. */
  internalDate?: string;
  payload?: GmailMessagePayload;
}

export interface GmailThread {
  id: string;
  /** The mailbox historyId as of this thread's last change — present on
   *  both `threads.list` stubs and `threads.get`'s full resource. Not used
   *  for cursor purposes by this worker (the mailbox-wide `historyId` from
   *  `history.list`/`getProfile` is what's persisted), but real API
   *  surface, kept for fidelity. */
  historyId?: string;
  snippet?: string;
  /** Present on `threads.get` (this worker always requests it), absent on
   *  a bare `threads.list` stub. */
  messages?: GmailMessage[];
}

export interface GmailThreadsListResponse {
  threads?: { id: string; snippet?: string; historyId?: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** A real, non-404 error from the Gmail API (auth failure, rate limit,
 *  malformed request, ...) — distinct from `GmailHistoryIdExpiredError` so
 *  callers only special-case the one recoverable status. Mirrors
 *  `calendar-api.ts`'s `CalendarApiError` exactly. */
export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

/** Thrown on `404 Not Found` from `history.list` specifically — Gmail's
 *  signal that the supplied `startHistoryId` is older than the ~7 days of
 *  history Gmail retains (per Google's docs: "if the historyId is very
 *  old, ... returns an HTTP 404 error"). Mirrors `calendar-api.ts`'s
 *  `CalendarSyncTokenExpiredError` for the same recoverable-error-class
 *  reason; `gmail-ingest.ts` catches this specifically and re-baselines
 *  (see that file's header for the chosen recovery strategy). */
export class GmailHistoryIdExpiredError extends Error {
  constructor() {
    super("Gmail historyId expired or invalid (404) — a fresh backfill is required.");
    this.name = "GmailHistoryIdExpiredError";
  }
}

/** The one Subject/From/To/Cc header set thread/participant materialization
 *  needs — Gmail's `metadataHeaders` param is an ALLOWLIST (headers not
 *  named here are omitted from the response entirely, not just unused), so
 *  this constant is the single source of truth for which headers
 *  `getThread` actually asks Google for. */
const METADATA_HEADERS = ["Subject", "From", "To", "Cc"] as const;

async function parseErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ? `: ${body.error.message}` : "";
  } catch {
    return "";
  }
}

export interface ListThreadsPageParams {
  accessToken: string;
  /** Gmail search-syntax query (e.g. `"newer_than:365d"` — see
   *  `gmail-ingest.ts`'s backfill window). Omitted entirely for an
   *  unbounded listing (never used by this worker's own ingest path, which
   *  always scopes backfill to a window — kept optional for API fidelity
   *  and follow-up-task flexibility). */
  q?: string;
  pageToken?: string;
  /** Bounds one page's result count — this worker's own ingest path always
   *  sets this to its per-tick batch size (`gmail-ingest.ts`'s
   *  `BACKFILL_BATCH_SIZE`), never left to Gmail's own default. */
  maxResults?: number;
  fetchImpl?: FetchLike;
}

/** `GET .../threads` (`threads.list`) — one page of thread STUBS (id +
 *  snippet + historyId only, no messages/headers — `getThread` below is
 *  needed for those). */
export async function listThreadsPage(params: ListThreadsPageParams): Promise<GmailThreadsListResponse> {
  const url = new URL(`${GMAIL_API_BASE}/threads`);
  if (params.q) url.searchParams.set("q", params.q);
  if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
  if (params.maxResults) url.searchParams.set("maxResults", String(params.maxResults));

  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });

  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new GmailApiError(response.status, `Gmail threads.list failed (HTTP ${response.status})${detail}`);
  }
  return (await response.json()) as GmailThreadsListResponse;
}

export interface GetThreadParams {
  accessToken: string;
  threadId: string;
  fetchImpl?: FetchLike;
}

/** `GET .../threads/{id}` (`threads.get`) — the full thread, `format=metadata`
 *  with `metadataHeaders` restricted to `METADATA_HEADERS` (Subject/From/
 *  To/Cc): every message's headers are returned, but never any body/parts
 *  content — the API-level enforcement of "message bodies stay out of this
 *  worker's thread-materialization path" (the plan's stronger "bodies stay
 *  out of the CRDT graph" rule is enforced again, independently, by
 *  `gmail-materialized-doc.ts` never writing anything body-shaped to the
 *  page even if it had it — belt and suspenders, not reliance on this API
 *  param alone). */
export async function getThread(params: GetThreadParams): Promise<GmailThread> {
  const url = new URL(`${GMAIL_API_BASE}/threads/${encodeURIComponent(params.threadId)}`);
  url.searchParams.set("format", "metadata");
  for (const header of METADATA_HEADERS) {
    url.searchParams.append("metadataHeaders", header);
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });

  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new GmailApiError(response.status, `Gmail threads.get failed (HTTP ${response.status})${detail}`);
  }
  return (await response.json()) as GmailThread;
}

export interface GmailHistoryMessageRef {
  id: string;
  threadId: string;
  labelIds?: string[];
}

/** One `history.list` record — Gmail reports several sub-event kinds per
 *  record; this worker only reads `messagesAdded` (new messages —
 *  sufficient to discover every thread that changed: a label-only change
 *  also touches a message, but per Google's docs `messagesAdded` alone,
 *  combined with re-`threads.get`-ing the affected thread, is sufficient
 *  to pick up its current label set too, since `getThread` re-reads
 *  everything about the thread fresh, not just the new message). */
export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: { message: GmailHistoryMessageRef }[];
}

export interface GmailHistoryListResponse {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  /** Present on the FINAL page of a `history.list` response sequence — the
   *  new baseline to persist for the next incremental sync. Mirrors
   *  Calendar's `nextSyncToken` mutual-exclusivity-with-pagination
   *  convention (Google's actual behavior for this field was not
   *  independently re-verified against a live account as part of this
   *  pass — documented as an assumption mirroring Calendar's verified
   *  convention, flagged for confirmation once this worker is smoke-tested
   *  against a real Gmail account per this repo's established
   *  `wrangler dev`-before-real-traffic practice, see `google-account-do.ts`'s
   *  file header). */
  historyId?: string;
}

export interface ListHistoryPageParams {
  accessToken: string;
  /** The last cursor this worker persisted (`sync_cursors` resource
   *  `"gmail"`) — Gmail returns every change SINCE this historyId. */
  startHistoryId: string;
  pageToken?: string;
  fetchImpl?: FetchLike;
}

/** `GET .../history` (`history.list`), scoped to `messagesAdded` only (see
 *  `GmailHistoryRecord`'s doc comment). Throws
 *  `GmailHistoryIdExpiredError` on `404` — see that class's doc comment. */
export async function listHistoryPage(params: ListHistoryPageParams): Promise<GmailHistoryListResponse> {
  const url = new URL(`${GMAIL_API_BASE}/history`);
  url.searchParams.set("startHistoryId", params.startHistoryId);
  url.searchParams.set("historyTypes", "messageAdded");
  if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);

  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });

  if (response.status === 404) {
    throw new GmailHistoryIdExpiredError();
  }
  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new GmailApiError(response.status, `Gmail history.list failed (HTTP ${response.status})${detail}`);
  }
  return (await response.json()) as GmailHistoryListResponse;
}

export interface ListMessagesPageParams {
  accessToken: string;
  q?: string;
  pageToken?: string;
  maxResults?: number;
  fetchImpl?: FetchLike;
}

export interface GmailMessagesListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** `GET .../messages` (`messages.list`) — NOT called by this pass's own
 *  ingest orchestration (see this file's header); provided for the
 *  follow-up message-bodies task and any future per-address Sent-folder
 *  precision pass (`gmail-materialization.ts`'s header documents why THIS
 *  pass's participant quality gate deliberately avoids needing per-address
 *  queries like `q: "from:me to:<address>"` against this endpoint, for
 *  API-call-budget reasons). */
export async function listMessagesPage(params: ListMessagesPageParams): Promise<GmailMessagesListResponse> {
  const url = new URL(`${GMAIL_API_BASE}/messages`);
  if (params.q) url.searchParams.set("q", params.q);
  if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
  if (params.maxResults) url.searchParams.set("maxResults", String(params.maxResults));

  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });

  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new GmailApiError(response.status, `Gmail messages.list failed (HTTP ${response.status})${detail}`);
  }
  return (await response.json()) as GmailMessagesListResponse;
}

export interface GetMessageParams {
  accessToken: string;
  messageId: string;
  /** `"metadata"` (headers only, this worker's own use so far) or `"full"`
   *  (the follow-up body-fetching task's concern) — defaults to
   *  `"metadata"` so a caller that forgets to specify never accidentally
   *  pulls a full body through this worker's read path. */
  format?: "metadata" | "full";
  fetchImpl?: FetchLike;
}

/** `GET .../messages/{id}` (`messages.get`) — NOT called by this pass's own
 *  ingest orchestration (`threads.get` already returns every message's
 *  headers inline); provided per the task brief for the follow-up
 *  message-bodies task (`format: "full"`) and any future single-message
 *  re-read need. */
export async function getMessage(params: GetMessageParams): Promise<GmailMessage> {
  const url = new URL(`${GMAIL_API_BASE}/messages/${encodeURIComponent(params.messageId)}`);
  url.searchParams.set("format", params.format ?? "metadata");
  if ((params.format ?? "metadata") === "metadata") {
    for (const header of METADATA_HEADERS) {
      url.searchParams.append("metadataHeaders", header);
    }
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });

  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new GmailApiError(response.status, `Gmail messages.get failed (HTTP ${response.status})${detail}`);
  }
  return (await response.json()) as GmailMessage;
}

// ---------------------------------------------------------------------------
// `format=full` message shape — used by the message-body/attachment ingest
// task this file's header anticipated ("a ready client rather than needing
// to add one from scratch"). Deliberately a SEPARATE type from
// `GmailMessagePayload` above (which stays `headers`-only, matching its own
// doc comment) rather than widening that type — every existing caller of
// `getMessage`/`GmailMessage` (thread materialization, `format=metadata`
// only) keeps working against the narrower shape unchanged; a caller that
// requests `format: "full"` casts the response to `GmailFullMessage`
// (`gmail-body-ingest.ts` does this once, at its one call site) rather than
// this file threading a shape-varies-by-parameter union through every
// existing `GmailMessage` consumer.
// ---------------------------------------------------------------------------

/** One MIME body part's `body` field, per Gmail's `MessagePartBody`
 *  resource. `data` is base64url-encoded (RFC 4648 §5 — `-`/`_` instead of
 *  `+`/`/`, no padding) content, present when the part is small enough for
 *  Gmail to inline it directly; `attachmentId` is present instead (with
 *  `data` OMITTED) for larger parts, requiring a separate
 *  `getMessageAttachment` call to fetch the actual bytes — see that
 *  function's doc comment. `size` is the DECODED byte size either way. */
export interface GmailMessagePartBody {
  size?: number;
  data?: string;
  attachmentId?: string;
}

/** One node of a `format=full` message's MIME tree. A `multipart/*` part
 *  has `parts` (its children) and no meaningful `body`/`filename` of its
 *  own; a leaf part (`text/plain`, `text/html`, or an attachment of any
 *  `mimeType`) has `body` and no `parts`. `filename` is Gmail's own signal
 *  for "this leaf part is an attachment, not inline message content" — an
 *  empty/absent `filename` on a leaf part means inline body content
 *  (`gmail-mime.ts`'s `parseGmailMessage` is the one place that
 *  distinguishes these cases). */
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

/** A `format=full` `messages.get` response — same envelope as `GmailMessage`
 *  (id/threadId/labelIds/snippet/internalDate all present identically) but
 *  with `payload` carrying the full MIME tree instead of just headers. */
export interface GmailFullMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

export interface GmailAttachmentData {
  size: number;
  /** Base64url-encoded — same encoding as `GmailMessagePartBody.data`, see
   *  that field's doc comment. */
  data: string;
}

export interface GetMessageAttachmentParams {
  accessToken: string;
  messageId: string;
  attachmentId: string;
  fetchImpl?: FetchLike;
}

/** `GET .../messages/{messageId}/attachments/{attachmentId}`
 *  (`messages.attachments.get`) — fetches the actual bytes for an
 *  attachment part whose `body` carried `attachmentId` instead of inline
 *  `data` (see `GmailMessagePartBody`'s doc comment: Gmail omits `data` for
 *  attachments above its own inlining size threshold). Real Gmail API v1
 *  endpoint, per Google's published reference
 *  (`users.messages.attachments.get`). */
export async function getMessageAttachment(params: GetMessageAttachmentParams): Promise<GmailAttachmentData> {
  const url = new URL(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(params.messageId)}/attachments/${encodeURIComponent(params.attachmentId)}`,
  );
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });

  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new GmailApiError(response.status, `Gmail messages.attachments.get failed (HTTP ${response.status})${detail}`);
  }
  return (await response.json()) as GmailAttachmentData;
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  /** The mailbox's CURRENT historyId at the moment of this call — used
   *  once, by `gmail-ingest.ts`, to seed the very first incremental-sync
   *  cursor the instant backfill completes (see that file's header). */
  historyId?: string;
}

export interface GetUserProfileParams {
  accessToken: string;
  fetchImpl?: FetchLike;
}

/** `GET .../profile` (`users.getProfile`) — see this file's header for why
 *  this worker needs it (self-email discovery + the initial `historyId`
 *  baseline). */
export async function getUserProfile(params: GetUserProfileParams): Promise<GmailProfile> {
  const url = new URL(`${GMAIL_API_BASE}/profile`);
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });

  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new GmailApiError(response.status, `Gmail users.getProfile failed (HTTP ${response.status})${detail}`);
  }
  return (await response.json()) as GmailProfile;
}

// ---------------------------------------------------------------------------
// `threads.modify` — the one WRITE (mutating) Gmail API v1 endpoint this
// file wraps (every other function above is a read). Added for the triage
// write-model (`gmail-triage.ts`/`write-model.ts`'s `archiveThread`/
// `applyLabel`/`removeLabel`/`markRead`/`markUnread`): archiving a thread,
// applying/removing a label, and marking read/unread all resolve to exactly
// this one Gmail operation under the hood — a label add/remove is Gmail's
// only primitive for all four (archive = remove `INBOX`, mark-read/unread =
// remove/add `UNREAD`) — see Google's own API reference
// (https://developers.google.com/gmail/api/reference/rest/v1/users.threads/modify).
// Deliberately still just a thin HTTP wrapper here, same shape as every read
// function above (injectable `fetchImpl`, throws `GmailApiError` on non-2xx)
// — this file has NO opinion on what the caller wants a label change to
// MEAN (archive vs. mark-read vs. ...); that mapping lives in
// `gmail-triage.ts`, one layer up, matching this worker's established
// "thin API wrapper vs. real-logic module" split (`calendar-api.ts` vs.
// `calendar-write-model.ts`).
// ---------------------------------------------------------------------------

export interface ModifyThreadLabelsParams {
  accessToken: string;
  threadId: string;
  /** Label ids to add (e.g. `"UNREAD"`, `"IMPORTANT"`, or a user label's
   *  own opaque id like `"Label_1"`) — omitted entirely (not an empty
   *  array) when nothing should be added, matching Gmail's own optional-
   *  field semantics for this endpoint. */
  addLabelIds?: string[];
  /** Label ids to remove — same shape/omission convention as
   *  `addLabelIds`. */
  removeLabelIds?: string[];
  fetchImpl?: FetchLike;
}

/** `POST .../threads/{id}/modify` (`threads.modify`) — the real label
 *  add/remove mutation, only ever called from `gmail-triage.ts`'s five
 *  thin wrappers, themselves only ever called from `write-model.ts`'s
 *  `executeApprovedAction`, after the approval-gate CAS has already
 *  transitioned `pending -> confirmed` AND the `GMAIL_MODIFY_SCOPE` gate has
 *  already passed (see that file). Body is exactly
 *  `{addLabelIds?, removeLabelIds?}` per Google's API reference; response is
 *  the updated `GmailThread` resource (same shape `getThread` above
 *  returns). Mirrors this file's other write-shaped call —
 *  `gmail-send.ts`'s `sendGmailMessage` — for the "throws `GmailApiError`
 *  on non-2xx" convention, even though that function lives in a different
 *  file (send is the write-model's OWN provider call, not a `gmail-api.ts`
 *  wrapper, because `messages.send`'s `raw` RFC 2822 body-building logic
 *  doesn't belong in a thin HTTP-shape wrapper — `threads.modify`'s body is
 *  already a flat structured object, so it fits here instead). */
export async function modifyThreadLabels(params: ModifyThreadLabelsParams): Promise<GmailThread> {
  const url = new URL(`${GMAIL_API_BASE}/threads/${encodeURIComponent(params.threadId)}/modify`);
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: { authorization: `Bearer ${params.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      addLabelIds: params.addLabelIds,
      removeLabelIds: params.removeLabelIds,
    }),
  });

  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new GmailApiError(response.status, `Gmail threads.modify failed (HTTP ${response.status})${detail}`);
  }
  return (await response.json()) as GmailThread;
}
