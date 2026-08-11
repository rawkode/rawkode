// @enchiridion/worker-gatekeeper-google — `format=full` Gmail message MIME
// parsing: base64url decoding + the payload-tree walk that turns
// `gmail-api.ts`'s `GmailFullMessage`/`GmailMessagePart` into exactly what
// `gmail-body-ingest.ts` needs to store (headers + text/html bodies) and
// upload (attachment parts).
//
// Pure functions, no DO/Workers-runtime dependency, no network I/O (a part
// whose `body.attachmentId` is set but has no inline `data` is returned
// with `data: undefined` — `gmail-body-ingest.ts` is the one place that
// makes the follow-up `getMessageAttachment` call, keeping this module
// synchronous and directly unit-testable against literal fixture objects,
// same "pure transform, caller does I/O" split as `gmail-materialization
// .ts`/`gmail-api.ts`).
//
// BASE64URL, NOT BASE64: Gmail's `body.data` fields use RFC 4648 §5's
// URL-and-filename-safe alphabet (`-`/`_` in place of `+`/`/`), with padding
// OMITTED entirely (Google's documented convention for this API) — `atob`/
// `Buffer.from(..., "base64")` both choke on `-`/`_` and mis-decode without
// re-added padding, so `decodeBase64Url` below does both fixups before
// handing off to the platform's own base64 decoder (`Buffer`, available via
// `wrangler.jsonc`'s `nodejs_compat` flag — the SAME primitive
// `blob-routes.ts`'s incremental-hashing path already depends on, so no new
// runtime-compatibility risk).
//
// MIME TREE WALK: `mimeType` distinguishes three cases for any given part:
//   - `multipart/*` (`alternative`, `mixed`, `related`, ...) — a container;
//     never has meaningful `body` content itself, only `parts` (its
//     children) to recurse into.
//   - `text/plain` / `text/html` WITHOUT a `filename` — inline message
//     body content. A message can have EITHER as a lone top-level part (no
//     `multipart/*` wrapper at all — a plain-text-only email), or BOTH
//     nested under a `multipart/alternative` (the common "here's the same
//     message in two formats" shape).
//   - anything else, OR a `text/plain`/`text/html` part that DOES carry a
//     `filename` — an attachment (Gmail's own signal per its API
//     reference: "filename ... Filename of the attachment"; a non-empty
//     filename is definitional for "this is an attachment", regardless of
//     the part's own MIME type — a `.txt` or `.html` file attached to an
//     email is exactly as much an attachment as a `.pdf`).
// A part can appear at ANY depth (Gmail nests `multipart/mixed` >
// `multipart/alternative` > leaf parts for "message with attachments AND
// multiple body formats" freely), so the walk is unconditionally recursive,
// not a fixed two-level `parts`/`parts[].parts` traversal.
//
// FIRST-WINS FOR BODY TEXT/HTML: if a message somehow has more than one
// `text/plain` (or `text/html`) leaf part with no filename — malformed, but
// `parseGmailMessage` must never throw on a foreign/unusual payload shape,
// matching `@enchiridion/projection`'s established "never throw on a
// corrupt/foreign doc" convention — the FIRST one encountered (depth-first,
// left-to-right, Gmail's own part ordering) wins; later ones are silently
// ignored rather than concatenated or overwriting.

import type { GmailHeader, GmailMessagePart } from "./gmail-api";

/** Decodes a Gmail base64url string (see this file's header) to raw bytes. */
export function decodeBase64Url(data: string): Uint8Array {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Decodes a Gmail base64url string as UTF-8 TEXT (message body content is
 *  always textual — `text/plain`/`text/html`) rather than raw bytes. */
export function decodeBase64UrlText(data: string): string {
  return new TextDecoder("utf-8").decode(decodeBase64Url(data));
}

/** Encodes raw bytes to Gmail's base64url wire format — the exact inverse
 *  of `decodeBase64Url` above (RFC 4648 §5 alphabet, padding OMITTED, same
 *  as this file's header documents for the decode direction). Added for
 *  `gmail-send.ts`'s `messages.send` call: Gmail's send API takes a
 *  base64url-encoded `raw` RFC 2822 message, the send-direction mirror of
 *  every read-path field this file already decodes — so the encode/decode
 *  pair for this wire format belongs in one place rather than being
 *  hand-rolled again at the one production call site that needs it. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Encodes UTF-8 TEXT to Gmail's base64url wire format — the encode-direction
 *  sibling of `decodeBase64UrlText` above, for the same reason
 *  `encodeBase64Url` is `decodeBase64Url`'s. */
export function encodeBase64UrlText(text: string): string {
  return encodeBase64Url(new TextEncoder().encode(text));
}

const HEADERS_TO_EXTRACT = ["From", "To", "Cc", "Subject", "Date"] as const;

/** One attachment part, still holding whatever the API gave us (inline
 *  `data` OR an `attachmentId` to fetch separately — see
 *  `GmailMessagePartBody`'s doc comment) — `gmail-body-ingest.ts` resolves
 *  either into real bytes before uploading. */
export interface ParsedAttachmentPart {
  filename: string;
  mimeType: string;
  /** Base64url-encoded inline data, when Gmail included it directly. */
  data?: string;
  /** Set instead of `data` for larger parts — `getMessageAttachment`
   *  (`gmail-api.ts`) fetches the real bytes using this id. */
  attachmentId?: string;
  /** Decoded byte size (Gmail reports this even when `data` is inline). */
  size: number;
}

export interface ParsedGmailMessage {
  /** Exactly `HEADERS_TO_EXTRACT`'s member names as keys, when present on
   *  the message (a header this parser doesn't recognize, or one absent
   *  from this particular message, is simply not a key here — never an
   *  empty-string value standing in for "missing"). */
  headers: Record<string, string>;
  bodyText?: string;
  bodyHtml?: string;
  attachments: ParsedAttachmentPart[];
}

function headerValue(headers: readonly GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Parses one `format=full` message payload (the whole MIME tree) into
 *  exactly what `gmail-body-ingest.ts` needs — see this file's header for
 *  the walk/classification rules. Never throws: an empty/malformed payload
 *  produces an empty-ish `ParsedGmailMessage` (no headers, no body, no
 *  attachments), matching this codebase's "never throw on a foreign/corrupt
 *  doc" convention. */
export function parseGmailMessage(payload: GmailMessagePart | undefined): ParsedGmailMessage {
  const headers: Record<string, string> = {};
  let bodyText: string | undefined;
  let bodyHtml: string | undefined;
  const attachments: ParsedAttachmentPart[] = [];

  if (payload) {
    for (const name of HEADERS_TO_EXTRACT) {
      const value = headerValue(payload.headers, name);
      if (value !== undefined) headers[name] = value;
    }
  }

  function walk(part: GmailMessagePart | undefined): void {
    if (!part) return;

    const mimeType = part.mimeType ?? "";
    const isAttachment = Boolean(part.filename && part.filename.length > 0);

    if (isAttachment) {
      attachments.push({
        filename: part.filename ?? "attachment",
        mimeType: mimeType || "application/octet-stream",
        data: part.body?.data,
        attachmentId: part.body?.attachmentId,
        size: part.body?.size ?? 0,
      });
    } else if (mimeType === "text/plain" && bodyText === undefined && part.body?.data) {
      bodyText = decodeBase64UrlText(part.body.data);
    } else if (mimeType === "text/html" && bodyHtml === undefined && part.body?.data) {
      bodyHtml = decodeBase64UrlText(part.body.data);
    }

    for (const child of part.parts ?? []) {
      walk(child);
    }
  }

  walk(payload);

  return { headers, bodyText, bodyHtml, attachments };
}
