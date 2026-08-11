// @enchiridion/worker-gatekeeper-google — the real Gmail `messages.send` API
// MUTATION call (`POST .../messages/send`). Pure functions, injectable
// `fetchImpl`, same testable-HTTP-client pattern as
// `calendar-write-model.ts`/`calendar-api.ts`/`oauth-client.ts`.
// Deliberately separate from `gmail-api.ts` (read-only `threads`/`history`/
// `messages` GET endpoints) even though both hit the same Gmail API surface
// — this file is the Gmail write-model's actual provider call, mirroring
// `calendar-write-model.ts`'s exact split from `calendar-api.ts`. Only ever
// invoked from `write-model.ts`'s `confirmApproval`, never from ingest.
//
// GMAIL'S `messages.send` SHAPE: unlike Calendar's `events.insert` (a
// structured JSON body — see `calendar-write-model.ts`), Gmail's send API
// takes exactly one field, `raw`: a base64url-encoded FULL RFC 2822 message
// (headers + a MIME body), per Google's own API reference
// (https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send).
// This file's job is building that raw message from the write-model's
// structured `SendEmailInput` and base64url-encoding it — reusing
// `gmail-mime.ts`'s `encodeBase64Url` (that file's encode-direction sibling
// to its existing decode helpers, added by this same task after confirming
// no encode helper existed yet — see that file's header) rather than
// hand-rolling the base64url alphabet a second time.
//
// HEADER-INJECTION HARDENING (adversarial review, plan §Google gatekeeper
// "Google gatekeeper" section, Fix 1): `to`/`cc`/`bcc`/`subject` used to be
// concatenated directly into RFC 2822 header lines with zero sanitization —
// a subject or address containing `"\r\nBcc: attacker@evil.com"` would
// inject a real header, and `"\r\n\r\n"` would override the entire MIME
// body. `validateSendEmailInput` below rejects (throws, never silently
// strips) any such value BEFORE a raw message is ever built. It is called
// from two places, deliberately: `write-model.ts`'s `proposeSendEmail`
// (so a malicious proposal is rejected before an approval row even exists
// — the earliest possible point) AND at the top of `buildRawEmailMessage`
// itself (defense-in-depth — this file must never trust an input it
// receives, even from a caller that's supposed to have already validated,
// the same "don't rely on the caller" posture `gmail-mime.ts`'s "never
// throw on a corrupt/foreign doc" convention takes for the opposite
// direction).
//
// MESSAGE-ID / IDEMPOTENCY (adversarial review, Fix 2): `messageId`, when
// present, is written out as this message's RFC 2822 `Message-ID` header —
// generated once by `write-model.ts`'s `proposeSendEmail` (via
// `generateGmailMessageId` below) at PROPOSAL time (not send time) and
// persisted on the approval row (`approvals-store.ts`'s
// `provider_message_id` column), so it exists even if the send itself never
// runs. This is the hook a future reconciliation-time Gmail search
// (`messages.list?q=rfc822msgid:<id>`) would key off of to confirm whether
// a stuck `confirmed` approval's message actually reached Gmail — see
// `approvals-store.ts`'s `reconcileStuckConfirmedApprovals` doc comment for
// why that full verification round-trip is a tracked follow-up, not
// implemented in this pass, and what ships instead (a distinct `"unknown"`
// terminal status).

import { GmailApiError } from "./gmail-api";
import { encodeBase64Url } from "./gmail-mime";

/** Thrown by `validateSendEmailInput` — a clear, dedicated error type (not
 *  a generic `Error`) so callers (and tests) can assert on the failure mode
 *  specifically, mirroring `GmailApiError`/`GmailHistoryIdExpiredError`'s
 *  "a real error class per distinct failure kind" convention elsewhere in
 *  this worker. */
export class SendEmailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendEmailValidationError";
  }
}

// `\s` (used by the address-shape regex below) already matches `\r`/`\n`,
// so excluding whitespace from the local/domain parts incidentally blocks
// CRLF injection through an address too — but subject has no such shape
// constraint, so it needs its own explicit CR/LF check. Both are checked
// explicitly below rather than relying on that incidental overlap, so the
// injection defense doesn't silently depend on an unrelated regex's shape.
const CRLF_PATTERN = /[\r\n]/;

/** Deliberately simple — this worker's `SendEmailInput` is documented as
 *  "plain email address strings, no display-name wrapping" (see that
 *  interface's own doc comment), so full RFC 5322 address-parsing (the
 *  `gmail-address.ts` module) is the wrong tool here: that module PARSES
 *  trusted provider-supplied header values, this one VALIDATES the shape of
 *  untrusted caller-supplied plain addresses before they become header
 *  values. One `local@domain.tld`-shaped check, not an over-engineered
 *  grammar. */
const PLAUSIBLE_EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertNoCrlf(fieldLabel: string, value: string): void {
  if (CRLF_PATTERN.test(value)) {
    throw new SendEmailValidationError(
      `${fieldLabel} must not contain a CR or LF character (rejected a possible RFC 2822 header-injection attempt)`,
    );
  }
}

function assertPlausibleAddress(fieldLabel: string, address: string): void {
  assertNoCrlf(fieldLabel, address);
  if (!PLAUSIBLE_EMAIL_ADDRESS.test(address.trim())) {
    throw new SendEmailValidationError(`${fieldLabel} "${address}" does not look like a valid email address`);
  }
}

function assertPlausibleAddressList(fieldLabel: string, addresses: string[] | undefined): void {
  if (!addresses) return;
  for (const address of addresses) {
    assertPlausibleAddress(fieldLabel, address);
  }
}

/** Rejects (throws `SendEmailValidationError`, never silently strips/
 *  sanitizes) a `SendEmailInput` whose `to`/`cc`/`bcc`/`subject` either
 *  contains a raw CR or LF (RFC 2822 header injection) or — for addresses —
 *  doesn't look like a plausible email address. See this file's header,
 *  "HEADER-INJECTION HARDENING", for why this is called from two places. */
export function validateSendEmailInput(input: SendEmailInput): void {
  if (input.to.length === 0) {
    throw new SendEmailValidationError("to must contain at least one recipient");
  }
  assertPlausibleAddressList("to", input.to);
  assertPlausibleAddressList("cc", input.cc);
  assertPlausibleAddressList("bcc", input.bcc);
  assertNoCrlf("subject", input.subject);
}

/** Generates a fresh RFC 2822 `Message-ID` value (angle-bracket-wrapped,
 *  ready to drop straight into a `Message-ID:` header line) — see this
 *  file's header, "MESSAGE-ID / IDEMPOTENCY". The domain part need not be
 *  resolvable (Gmail doesn't validate it — plenty of real mail servers mint
 *  Message-IDs under internal-only domains); it only needs to be stable and
 *  identifiable so a human (or a future automated check) can grep for it. */
export function generateGmailMessageId(): string {
  return `<${crypto.randomUUID()}@gatekeeper.enchiridion.rawkode.academy>`;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SEND_URL = "https://www.googleapis.com/gmail/v1/users/me/messages/send";

/** The write-model's structured send-email input — what a caller
 *  (`write-model.ts`'s `proposeSendEmail`) actually works with; this file
 *  is the only place it gets flattened into an RFC 2822 message. Plain
 *  email address strings (no display-name wrapping) — same "keep it simple,
 *  this is a single-user mailbox" spirit as `calendar-write-model.ts`'s
 *  `attendeeEmails?: string[]`. */
export interface SendEmailInput {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  /** Populated by `write-model.ts`'s `proposeSendEmail` (via
   *  `generateGmailMessageId` below) at PROPOSAL time, not by the original
   *  caller — see this file's header, "MESSAGE-ID / IDEMPOTENCY". Optional
   *  here (rather than required) so this file's own direct unit tests can
   *  exercise `buildRawEmailMessage` without needing to fabricate one. */
  messageId?: string;
}

export interface SentGmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
}

const ASCII_ONLY = /^[\x00-\x7F]*$/;

/** RFC 2047 "encoded-word" wrap for a header VALUE that contains non-ASCII
 *  characters (e.g. an emoji or accented character in a subject line) —
 *  plain 7-bit-ASCII values pass through unchanged, which covers the
 *  overwhelming majority of real subject lines. Header content is
 *  technically restricted to 7-bit-ASCII by RFC 2822; RFC 2047 is the
 *  standard escape hatch for anything outside that range (unlike the
 *  message BODY, which this file sends as-is under
 *  `Content-Transfer-Encoding: 8bit` — see `buildRawEmailMessage`). */
function encodeHeaderValue(value: string): string {
  if (ASCII_ONLY.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function addressHeaderLine(name: string, addresses: string[] | undefined): string | undefined {
  if (!addresses || addresses.length === 0) return undefined;
  return `${name}: ${addresses.join(", ")}`;
}

/** Builds the raw RFC 2822 message Gmail's `messages.send` `raw` field
 *  expects — To/Cc/Bcc/Subject/MIME headers, a blank line, then the plain-
 *  text body, CRLF line endings per the RFC. Exported for direct unit
 *  testing of the MIME shape independent of the HTTP call (mirrors this
 *  worker's established "pure transform, separately testable from the HTTP
 *  wrapper" convention — see `gmail-mime.ts`'s `parseGmailMessage`).
 *
 *  Gmail accepts (and honors) a `Bcc` header in the raw message the same
 *  way a normal SMTP submission does: recipients are sent the message, but
 *  the header itself is stripped from what's actually delivered — this
 *  file doesn't need to special-case it beyond including it here.
 *
 *  Validates `input` first (see this file's header, "HEADER-INJECTION
 *  HARDENING") — throws `SendEmailValidationError` rather than building a
 *  malicious raw message, even though `write-model.ts`'s `proposeSendEmail`
 *  already validates at proposal time; this is the defense-in-depth copy of
 *  that check, not the only one. */
export function buildRawEmailMessage(input: SendEmailInput): string {
  validateSendEmailInput(input);

  const headers: string[] = [];
  const to = addressHeaderLine("To", input.to);
  if (to) headers.push(to);
  const cc = addressHeaderLine("Cc", input.cc);
  if (cc) headers.push(cc);
  const bcc = addressHeaderLine("Bcc", input.bcc);
  if (bcc) headers.push(bcc);
  headers.push(`Subject: ${encodeHeaderValue(input.subject)}`);
  if (input.messageId) headers.push(`Message-ID: ${input.messageId}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  // 8bit, not a base64/quoted-printable inner encoding: the WHOLE raw
  // message (headers + body) is base64url-encoded exactly once for Gmail's
  // `raw` field below — double-encoding the body on top of that would be
  // redundant, and Gmail's API (like modern SMTP with 8BITMIME) accepts
  // UTF-8 body octets under this header without complaint.
  headers.push("Content-Transfer-Encoding: 8bit");

  return `${headers.join("\r\n")}\r\n\r\n${input.body}`;
}

async function parseErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ? `: ${body.error.message}` : "";
  } catch {
    return "";
  }
}

/** `POST .../messages/send` (`messages.send`) — the real send-email
 *  mutation, only ever called from `write-model.ts`'s `confirmApproval`,
 *  after the approval-gate CAS has already transitioned `pending ->
 *  confirmed` AND the `GMAIL_SEND_SCOPE` gate has already passed (see that
 *  file). Mirrors `calendar-write-model.ts`'s `createCalendarEvent` exactly:
 *  injectable `fetchImpl`, throws `GmailApiError` (reused from
 *  `gmail-api.ts` — same HTTP-error shape as every other Gmail API call in
 *  this worker, not a new error class) on a non-2xx response. */
export async function sendGmailMessage(
  accessToken: string,
  input: SendEmailInput,
  fetchImpl: FetchLike = fetch,
): Promise<SentGmailMessage> {
  const raw = encodeBase64Url(new TextEncoder().encode(buildRawEmailMessage(input)));
  const response = await fetchImpl(SEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!response.ok) {
    throw new GmailApiError(response.status, `Gmail messages.send failed (HTTP ${response.status})${await parseErrorDetail(response)}`);
  }
  return (await response.json()) as SentGmailMessage;
}
