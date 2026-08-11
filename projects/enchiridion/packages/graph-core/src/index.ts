// @enchiridion/graph-core
//
// TypeScript port of the deterministic identity scheme defined by the Swift
// app (apps/enchiridion/Sources/EnchiridionCore/{PageModels,GraphIdentifiers,
// CalendarEventMaterialization}.swift). See plan
// /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, "Critical
// invariant": these IDs must be byte-for-byte identical to the Swift-derived
// IDs given the same inputs — divergence silently forks pages. Every
// derivation here is locked against the shared fixture file
// `src/__fixtures__/golden-ids.json`, asserted by `index.test.ts` on the TS
// side and (once the new Swift package has real PageID code — tracked
// separately) by an equivalent Swift test loading the same JSON.
//
// Digest primitive (Swift: `PageID.digest(_:)`, PageModels.swift:54-59, and
// mirrored independently at GraphDatabase.swift:827-829 and
// WorkoutModule.swift:434 for other identifier spaces using the identical
// scheme):
//
//   SHA256.hash(data: Data(value.utf8)).prefix(20).map { %02x }.joined()
//
// i.e. SHA-256 over the UTF-8 bytes of the input string, TRUNCATED to the
// first 20 bytes (160 bits) of the 32-byte digest, then lowercase-hex
// encoded -> a 40-hex-char string. This is the "id digest": used for
// person_, calendar_event_, series_, task_occurrence_, task_series_
// (event_/series_ raw-EventKit-identity and task_* recurrence schemes are
// documented below but NOT yet ported here — see "Not yet ported").
//
// A SEPARATE, un-truncated convention is used for `blob_` ids: full 64-hex
// SHA-256 (see deriveBlobId doc comment for why).

/**
 * Hashing is implemented with the standard WebCrypto `crypto.subtle` API
 * (available as a global in Node >=19, Bun, and Cloudflare Workers) rather
 * than a hand-rolled SHA-256 implementation or Node's `node:crypto` module.
 * Rationale:
 *   - This package must run unmodified inside a Cloudflare Worker (the vault
 *     worker's GraphQL resolvers and the gatekeeper-google ingest path both
 *     call into these derivations), where `node:crypto` is not the native
 *     primitive and a hand-rolled digest is an unacceptable correctness risk
 *     for an identity scheme whose entire purpose is exact cross-language
 *     agreement.
 *   - `crypto.subtle.digest` is inherently async in every environment that
 *     implements it (including Bun and Node), so every function that hashes
 *     is async here. `deriveDailyPageId`, `deriveFreePageId`, and
 *     `predicateId` need no hash and stay synchronous, matching their Swift
 *     counterparts' cost (string formatting only).
 */
async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(input));
  return new Uint8Array(digest);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Slice to a fresh ArrayBuffer so callers can pass views over larger
  // buffers (e.g. a Uint8Array subarray) without hashing extra bytes.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** Swift: `PageID.digest(_:)` (PageModels.swift:54-59) — SHA-256, truncated
 *  to the first 20 bytes, lowercase hex (40 chars). This is the primitive
 *  behind person_/calendar_event_ ids below. */
async function idDigestHex(value: string): Promise<string> {
  const full = await sha256Bytes(new TextEncoder().encode(value));
  return bytesToHex(full.subarray(0, 20));
}

/** Full, un-truncated SHA-256 hex (64 chars). Swift uses this exact
 *  un-truncated form for `CalendarMaterializedIdentity.uidDigest` and
 *  `.sourceScopeDigest` (CalendarEventMaterialization.swift:24 and :31-32,
 *  :43-44) — those two fields are themselves inputs to a second, truncated
 *  `idDigestHex` call that produces the final page id. `deriveBlobId` below
 *  also uses this full form, for unrelated reasons (see its doc comment). */
async function fullDigestHex(value: string): Promise<string> {
  const full = await sha256Bytes(new TextEncoder().encode(value));
  return bytesToHex(full);
}

async function fullDigestHexBytes(bytes: Uint8Array): Promise<string> {
  const full = await sha256Bytes(bytes);
  return bytesToHex(full);
}

// ---------------------------------------------------------------------------
// daily:YYYY-MM-DD
// ---------------------------------------------------------------------------

/** A calendar date, matching Swift's `DayKey` (PageModels.swift:127-149):
 *  civil year/month/day components, zero-padded on formatting via
 *  `String(format: "%04d-%02d-%02d", ...)`. No timezone/instant is involved
 *  — this is deliberately a pure civil-date value. */
export interface DailyPageDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

function formatDayKey(date: DailyPageDate): string {
  const year = String(date.year).padStart(4, "0");
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Deterministic PageID for a vault's daily page.
 *  Swift: `PageID.daily(_ day: DayKey)` (PageModels.swift:20-22) —
 *  `"daily:\(day.rawValue)"`, where `day.rawValue` is the zero-padded
 *  "YYYY-MM-DD" string. Not hashed.
 *
 *  Accepts either an already-formatted ISO date string or explicit
 *  {year,month,day} components; both paths re-zero-pad through
 *  `formatDayKey` so a caller passing an unpadded string (e.g. "2026-1-5")
 *  or unpadded numeric components still produces the correct id. */
export function deriveDailyPageId(date: DailyPageDate | string): string {
  const components: DailyPageDate =
    typeof date === "string" ? parseIsoDate(date) : date;
  return `daily:${formatDayKey(components)}`;
}

function parseIsoDate(isoDate: string): DailyPageDate {
  const match = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(isoDate);
  if (!match) {
    throw new Error(`deriveDailyPageId: not a "YYYY-MM-DD" date: ${isoDate}`);
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return { year: Number(year), month: Number(month), day: Number(day) };
}

// ---------------------------------------------------------------------------
// person_<idDigest(email)>
// ---------------------------------------------------------------------------

/** Deterministic PageID for a person, keyed by email.
 *  Swift: `PageID.person(email:)` (PageModels.swift:42-44) —
 *  `"person_\(digest(email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()))"`.
 *  Normalization order matters: trim first, THEN lowercase, then digest. */
export async function derivePersonPageId(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  return `person_${await idDigestHex(normalized)}`;
}

// ---------------------------------------------------------------------------
// calendar_event_<idDigest(stableKey)>
//
// This ports `PageID.materializedCalendarEvent` /
// `CalendarMaterializedIdentity` (PageModels.swift:34-36, :191-208 and
// CalendarEventMaterialization.swift:10-34) — the cloud-safe materialized
// Event identity used once an external event is copied into the graph.
// Provider IDs and iCalendar UIDs never appear directly in the id or its
// prefix (plan §Google gatekeeper: "no provider IDs leak into the graph");
// only their SHA-256 digests do, and only after being run through a SECOND
// digest as part of the final stableKey.
//
// NOT YET PORTED (out of scope for this pass — no current call site needs
// them, and porting `CalendarEventIdentity.stableKey` requires exactly
// matching Swift's `Date.ISO8601FormatStyle(includingFractionalSeconds:
// true)` string form, which is a separate, self-contained risk worth its
// own golden-tested pass rather than guessing at):
//   - `PageID.calendarEvent` / `.calendarOccurrence` (the `event_` prefix,
//     keyed off raw `CalendarEventIdentity.stableKey` /
//     `.canonicalOccurrenceKey`, which embed an ISO-8601-with-fractional-
//     seconds timestamp) — EventKit-only, not used by the Cloudflare
//     gatekeeper ingest path per the plan.
//   - `PageID.calendarSeries` (the `series_` prefix).
//   - `PageID.taskOccurrence` / `TaskRecurrenceSeriesID.derived` (the
//     `task_occurrence_` / `task_series_` prefixes) — task recurrence is a
//     P1+ concern, not P0 calendar/blob/person/daily.
// ---------------------------------------------------------------------------

/** Mirrors `CalendarMaterializedIdentity` (PageModels.swift:191-208):
 *  version + uidDigest + occurrenceToken + optional sourceScopeDigest. */
export interface CalendarMaterializedIdentity {
  version: number;
  uidDigest: string;
  occurrenceToken: string;
  sourceScopeDigest?: string;
}

/** Domain-level input mirroring what
 *  `CalendarEventMaterialization.identity(for:)` reads off a
 *  `CalendarEventSnapshot` (CalendarEventMaterialization.swift:10-34), before
 *  it has been reduced to digests. Exported so callers with raw event data
 *  (e.g. the Google Calendar gatekeeper ingest path) don't need to
 *  pre-compute digests themselves. */
export type CalendarEventMaterializationInput =
  | {
      /** iCalendar UID (`event.iCalendarUID`), NFC-normalized by this
       *  function to match Swift's `.precomposedStringWithCanonicalMapping`
       *  (CalendarEventMaterialization.swift:11). */
      iCalendarUID: string;
      provider: string;
      isAllDay: true;
      /** Civil day the (unmoved) occurrence originally started on, as
       *  "YYYY-MM-DD" — `originalStartCivilDay.rawValue`. */
      originalStartCivilDay: string;
      /** IANA time zone identifier, e.g. "Europe/London". */
      timeZoneIdentifier: string;
    }
  | {
      iCalendarUID: string;
      provider: string;
      isAllDay: false;
      /** The occurrence's original start instant. A `Date`/`number`
       *  (epoch milliseconds) is accepted for convenience and converted to
       *  whole epoch seconds, truncated toward zero — matching Swift's
       *  `Int64(original.timeIntervalSince1970.rounded(.towardZero))`
       *  (CalendarEventMaterialization.swift:22). */
      originalStartDate: Date | number;
    };

function normalizeNfc(value: string): string {
  // Swift's `.precomposedStringWithCanonicalMapping` is Unicode NFC
  // (canonical composition) — the same normal form as JS's
  // `String.prototype.normalize("NFC")` (the default form).
  return value.normalize("NFC");
}

function epochSecondsTruncatedTowardZero(value: Date | number): number {
  const ms = typeof value === "number" ? value : value.getTime();
  return Math.trunc(ms / 1000);
}

/** Swift: `CalendarEventMaterialization.identity(for:)`
 *  (CalendarEventMaterialization.swift:10-34). Returns `undefined` when the
 *  Swift source would also return `nil` (empty/whitespace-only UID or
 *  provider after normalization). */
export async function deriveCalendarMaterializedIdentity(
  input: CalendarEventMaterializationInput,
): Promise<CalendarMaterializedIdentity | undefined> {
  const uid = normalizeNfc(input.iCalendarUID).trim();
  if (uid.length === 0) return undefined;

  const provider = normalizeNfc(input.provider).trim();
  if (provider.length === 0) return undefined;

  let occurrenceToken: string;
  if (input.isAllDay) {
    const day = input.originalStartCivilDay.trim();
    const zone = input.timeZoneIdentifier.trim();
    if (day.length === 0 || zone.length === 0) return undefined;
    occurrenceToken = `all-day ${day} ${zone}`;
  } else {
    const seconds = epochSecondsTruncatedTowardZero(input.originalStartDate);
    occurrenceToken = `instant ${seconds}`;
  }

  // NOTE: `uid` is re-normalized+trimmed above (not re-precomposed on the
  // original, un-trimmed string) intentionally — Swift trims via its
  // `nonEmpty` helper on the ALREADY-precomposed string
  // (CalendarEventMaterialization.swift:11), so precompose-then-trim is the
  // matching order.
  const uidDigest = await fullDigestHex(uid);
  const sourceScopeDigest = await fullDigestHex(provider);

  return {
    version: 1,
    uidDigest,
    occurrenceToken,
    sourceScopeDigest,
  };
}

/** Swift: `CalendarMaterializedIdentity.stableKey`
 *  (PageModels.swift:205-207) — joins
 *  ["calendar-materialized-v<version>", uidDigest, occurrenceToken,
 *  sourceScopeDigest ?? ""] with NUL separators. */
function calendarMaterializedStableKey(identity: CalendarMaterializedIdentity): string {
  return [
    `calendar-materialized-v${identity.version}`,
    identity.uidDigest,
    identity.occurrenceToken,
    identity.sourceScopeDigest ?? "",
  ].join(" ");
}

/** Deterministic PageID for a materialized calendar event.
 *  Swift: `PageID.materializedCalendarEvent(_:)` (PageModels.swift:34-36) —
 *  `"calendar_event_\(digest(identity.stableKey))"`. */
export async function deriveEventPageId(
  identity: CalendarMaterializedIdentity,
): Promise<string> {
  return `calendar_event_${await idDigestHex(calendarMaterializedStableKey(identity))}`;
}

/** Convenience: derive directly from domain input (calls
 *  `deriveCalendarMaterializedIdentity` then `deriveEventPageId`).
 *  Returns `undefined` when the identity can't be formed (matching Swift's
 *  `identity(for:)` returning `nil`), e.g. missing UID/provider or missing
 *  all-day civil-day/timezone fields. */
export async function deriveEventPageIdFromInput(
  input: CalendarEventMaterializationInput,
): Promise<string | undefined> {
  const identity = await deriveCalendarMaterializedIdentity(input);
  if (!identity) return undefined;
  return deriveEventPageId(identity);
}

// ---------------------------------------------------------------------------
// email_thread_<idDigest(threadId)>
// ---------------------------------------------------------------------------

/** Deterministic PageID for a materialized Gmail thread.
 *  Plan §Google gatekeeper (Gmail section): "Threads -> EmailThread pages
 *  (subject, participant edges, labels, snippet)"; plan §Backend
 *  architecture, "Critical invariant": deterministic PageIDs
 *  (`daily:YYYY-MM-DD`, `person_<sha256(email)>`, `event_<digest>`).
 *
 *  Gmail thread ids are already stable and provider-unique on their own —
 *  unlike `deriveEventPageId`'s Calendar case, there's no occurrence/
 *  recurrence ambiguity to fold into a composite stableKey. Even so, this
 *  goes through the same truncated `idDigestHex` scheme
 *  `derivePersonPageId`/`deriveEventPageId` use (20 bytes / 40 hex chars)
 *  rather than embedding the raw thread id in the PageID directly, for two
 *  reasons: consistency with the rest of the graph's identity space (every
 *  other provider-derived id in this file is digested, never passed
 *  through raw), and matching the plan's "no provider IDs leak into the
 *  graph" rule already applied to Calendar's `uidDigest`/
 *  `sourceScopeDigest` above — a raw Gmail thread id is exactly the kind
 *  of provider identifier that rule exists to keep out of the graph.
 *
 *  No Swift precedent exists for this one (Gmail/`EmailThread` materialization
 *  is server-only per the plan — gatekeeper-google's ingest path, not any
 *  on-device code) — a fresh design choice, like `deriveBlobId`'s. Still
 *  routed through the golden-fixture file for consistency with every other
 *  derivation in this module, even though there's no Swift side to assert
 *  it against yet. */
export async function deriveEmailThreadPageId(threadId: string): Promise<string> {
  const normalized = threadId.trim();
  return `email_thread_${await idDigestHex(normalized)}`;
}

// ---------------------------------------------------------------------------
// page_<uuid> (random, not derived)
// ---------------------------------------------------------------------------

/** Random PageID for an untyped/free page.
 *  Swift: `PageID.free(_ id: UUID = UUID())` (PageModels.swift:16-18) —
 *  `"page_\(id.uuidString.lowercased())"`. `crypto.randomUUID()` already
 *  produces a lowercase, hyphenated UUIDv4 string in Node/Bun/Workers, so no
 *  further normalization is needed. Not deterministic by design — excluded
 *  from the cross-language golden fixtures for the same reason the Swift
 *  stub noted ("no TS equivalent needed for the golden tests"). */
export function deriveFreePageId(): string {
  return `page_${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// blob_<sha256> — content-addressed R2 blob ids
// ---------------------------------------------------------------------------

/**
 * Deterministic, content-addressed id for an R2-stored blob.
 *
 * DECISION (resolving the open question left in the prior stub): full,
 * un-truncated 64-hex-char SHA-256, NOT the 20-byte/40-hex-char truncation
 * `PageID.digest` uses for graph identities. Rationale:
 *   - There is no Swift precedent to match byte-for-byte — the plan
 *     (§Backend architecture, "Blobs (R2)") only specifies
 *     `blob_<sha256>` and the old app has no blob concept at all, so this
 *     is a fresh design choice, not a port.
 *   - Blob ids are the dedup key for arbitrary user-uploaded content
 *     (images/video/PDFs, plan §Backend architecture) at R2 scale over the
 *     life of the vault; PageID's 160-bit truncation is an acceptable
 *     collision-resistance tradeoff for a bounded, curated set of graph
 *     identities (dates, emails, calendar occurrences) but is the wrong
 *     tradeoff for content-addressed storage, where any collision silently
 *     merges two different files' bytes. Full SHA-256 (128-bit collision
 *     resistance) is the conventional choice for content-addressed stores
 *     (git, IPFS, OCI registries all use full-length hashes) and costs
 *     nothing extra to compute.
 */
export async function deriveBlobId(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return `blob_${await fullDigestHexBytes(view)}`;
}

// ---------------------------------------------------------------------------
// property:<tagID>:<fieldID> predicate identity
// ---------------------------------------------------------------------------

/** Swift: `PredicateID.property(tagID:fieldID:)`
 *  (GraphIdentifiers.swift:44-46) — `"property:\(tagID.rawValue):\(fieldID.rawValue)"`.
 *  Field/relation identity is `(tagID, fieldID)` (plan §Supertag module
 *  contract), and this is just the string-formatting of that pair; it
 *  carries no runtime supertag-registry state, so it's safe to port
 *  directly rather than deferring to the schema-porting task. */
export function predicateId(tagId: string, fieldId: string): string {
  return `property:${tagId}:${fieldId}`;
}
