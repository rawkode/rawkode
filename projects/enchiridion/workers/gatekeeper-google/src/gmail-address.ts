// @enchiridion/worker-gatekeeper-google — RFC 5322-ish `From`/`To`/`Cc`
// header address-list parsing.
//
// Gmail's `metadataHeaders` response returns each header's raw string
// value verbatim (e.g. `"David Flanagan <david@rawkode.academy>, Guest
// <guest@example.com>"` or a bare `"someone@example.com"`), never
// pre-parsed into structured addresses — this module is this worker's one
// point of contact with that parsing, kept separate from
// `gmail-materialization.ts` so it's independently unit-testable against
// real-shaped header strings without needing a full `GmailThread` fixture.
//
// Deliberately NOT a full RFC 5322 parser (group syntax, nested comments,
// encoded-word `=?UTF-8?...?=` display names are all out of scope) — Gmail
// itself normalizes most of that away before headers reach the API, and a
// personal single-account mailbox's real header values are overwhelmingly
// the two simple forms handled here: `"Display Name" <addr>` / `Display
// Name <addr>` and a bare `addr`. A header entry this parser can't make
// sense of is dropped, never thrown — matches `@enchiridion/projection`'s
// "never throw on a corrupt/foreign doc" convention applied to a
// corrupt/unusual header instead.

export interface ParsedAddress {
  email: string;
  displayName?: string;
}

/** Splits a comma-separated address-list header value into its individual
 *  entries, respecting double-quoted display names that may themselves
 *  contain a comma (e.g. `"Flanagan, David" <david@rawkode.academy>`) — a
 *  naive `.split(",")` would incorrectly split that one address in two. */
function splitAddressList(headerValue: string): string[] {
  const entries: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of headerValue) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === "," && !inQuotes) {
      entries.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) entries.push(current);
  return entries;
}

const ANGLE_ADDR = /^(.*)<([^<>]+)>\s*$/;

/** Parses one address-list entry (already comma-split) into
 *  `{email, displayName?}`, or `undefined` if it contains nothing
 *  email-shaped. */
function parseOneAddress(entry: string): ParsedAddress | undefined {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return undefined;

  const angleMatch = ANGLE_ADDR.exec(trimmed);
  if (angleMatch) {
    const [, rawName, rawEmail] = angleMatch as unknown as [string, string, string];
    const email = rawEmail.trim();
    if (email.length === 0) return undefined;
    const displayName = rawName.trim().replace(/^"(.*)"$/, "$1").trim();
    return { email, displayName: displayName.length > 0 ? displayName : undefined };
  }

  // Bare address, no `<...>` wrapper (e.g. `someone@example.com`) — Gmail
  // sends this form for headers with no display name at all.
  if (trimmed.includes("@")) {
    return { email: trimmed };
  }
  return undefined;
}

/** Parses a full `From`/`To`/`Cc` header VALUE (comma-separated, possibly
 *  multiple addresses for `To`/`Cc`) into `ParsedAddress[]`. Entries this
 *  parser can't make sense of are silently dropped (see this file's
 *  header) rather than aborting the whole header. Returns `[]` for an
 *  empty/whitespace-only value. */
export function parseAddressList(headerValue: string | undefined): ParsedAddress[] {
  if (!headerValue || headerValue.trim().length === 0) return [];
  const result: ParsedAddress[] = [];
  for (const entry of splitAddressList(headerValue)) {
    const parsed = parseOneAddress(entry);
    if (parsed) result.push(parsed);
  }
  return result;
}

/** Normalizes an email for identity/comparison purposes — trim + lowercase,
 *  matching `@enchiridion/graph-core`'s `derivePersonPageId` normalization
 *  order exactly (trim first, then lowercase) so an address compared here
 *  agrees with the page id that address would derive to. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
