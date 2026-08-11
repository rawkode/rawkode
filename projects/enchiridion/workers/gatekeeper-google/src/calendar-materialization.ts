// @enchiridion/worker-gatekeeper-google — calendar event normalization,
// cloud-safe identity, and provider-baseline change detection.
//
// Port of the OLD app's
// apps/enchiridion/Sources/EnchiridionCore/CalendarEventMaterialization.swift
// onto Google Calendar's real API shape (`calendar-api.ts`), per plan
// §Google gatekeeper: "materialization ported from
// CalendarEventMaterialization.swift: SHA-256 digest identity (no provider
// IDs leak into the graph), baseline-hash change detection so user edits
// are never clobbered, attendees -> deterministic Person pages."
//
// IDENTITY: delegates entirely to `@enchiridion/graph-core`'s
// `deriveCalendarMaterializedIdentity`/`deriveEventPageId` — the real,
// tested, cross-language-golden-tested port of Swift's
// `CalendarEventMaterialization.identity(for:)` /
// `PageID.materializedCalendarEvent`. This file's only job on the identity
// side is building that function's input from Google's real event shape
// (`normalizeOccurrence` below) — see graph-core's own file header for why
// this two-step split exists (graph-core has no Google-specific knowledge,
// this worker has no digest-scheme knowledge).
//
// BASELINE HASH: unlike PageID derivation, this does NOT need
// cross-language byte-for-byte parity with Swift's `baselineHash` — it is
// a purely LOCAL change-detection cache private to THIS worker's own
// `calendar_materialization_state` table (see schema.ts), never compared
// against anything Swift-side or cross-worker. So this file defines its
// own canonical-JSON hash rather than reproducing Swift's exact
// "key=values.joined()" string format. It DOES extend Swift's field set:
// Swift's `baselineHash` only covers scalar properties (title/start/end/
// all-day/calendar/source/location) because the old app never
// materialized attendee/organizer EDGES at all. This port does (plan:
// "attendees -> deterministic Person pages", new functionality beyond the
// old Swift source) — organizerEmail and the sorted attendee email set are
// folded into the hash too, so an attendee-list change alone (title/time
// unchanged) still triggers re-materialization of the event's edges.
//
// PER-FIELD GRANULARITY (fixes the P2 bundle-hash simplification flagged
// by adversarial review, see the plan's "Google gatekeeper" section):
// `eventBaselineHash`/`personBaselineHash` below fold every owned field
// into ONE combined digest — useful only as a cheap "did anything happen
// at all" signal. `eventFieldBaselineHashes`/`personFieldBaselineHashes`
// instead hash each owned field SEPARATELY, so `materialization.ts` can
// diff them against the previously stored per-field hashes and call
// `materialized-doc.ts`'s `setXIfChanged` ONLY for fields whose
// OWN hash actually changed — never for a field that's untouched at the
// source just because some UNRELATED owned field changed. See
// `materialization.ts`'s header and `materialized-doc.test.ts`'s
// "changedFields" tests for the exact silent-overwrite scenario this
// closes.

import { deriveCalendarMaterializedIdentity, deriveEventPageId, derivePersonPageId } from "@enchiridion/graph-core";
import type { GoogleCalendarEvent, GoogleCalendarEventsListResponse } from "./calendar-api";
import { sha256Hex } from "./hash";

/** The `provider` input to `deriveCalendarMaterializedIdentity` — only its
 *  SHA-256 digest (`sourceScopeDigest`) ever leaves this worker (plan: "no
 *  provider IDs leak into the graph"). A fixed literal, not a per-account
 *  value, since this worker manages exactly one Google account
 *  (single-user scope, matching every other "default"-named singleton in
 *  this worker). */
export const CALENDAR_PROVIDER = "google-calendar";

export interface NormalizedAttendee {
  email: string;
  displayName?: string;
}

/** One calendar OCCURRENCE (not a recurrence series), normalized off
 *  Google's real event shape into exactly what identity derivation and
 *  doc materialization need. `pageID` is precomputed here (not left to
 *  callers) since every consumer needs it and re-deriving it twice would
 *  invite drift. */
export interface NormalizedEventOccurrence {
  pageID: string;
  status: "confirmed" | "tentative" | "cancelled";
  title: string;
  /** ISO-8601 instants — for an all-day event these are UTC midnight of
   *  the start/end civil date (Google's `end.date` is EXCLUSIVE per the
   *  Calendar API's documented all-day convention; kept as-is, not
   *  adjusted, since this is a display value, not used for any interval
   *  arithmetic here). */
  start: string;
  end: string;
  isAllDay: boolean;
  calendarTitle: string;
  location?: string;
  organizer?: NormalizedAttendee;
  attendees: NormalizedAttendee[];
}

function dateTimeToIso(value: { date?: string; dateTime?: string }): string | undefined {
  if (value.dateTime) return new Date(value.dateTime).toISOString();
  if (value.date) return new Date(`${value.date}T00:00:00.000Z`).toISOString();
  return undefined;
}

/** Builds `NormalizedEventOccurrence` from one raw Google event, or
 *  `undefined` when the event can't be identified (matches Swift's
 *  `identity(for:)` returning `nil` for a missing/blank UID — see
 *  graph-core's `deriveCalendarMaterializedIdentity` doc comment) or is
 *  missing the start/end this worker needs to materialize a page at all
 *  (a malformed response must not crash ingest — skip and count it, same
 *  posture as `@enchiridion/projection`'s "never throw on a corrupt doc"
 *  convention). */
export async function normalizeOccurrence(
  event: GoogleCalendarEvent,
  list: GoogleCalendarEventsListResponse,
): Promise<NormalizedEventOccurrence | undefined> {
  const original = event.originalStartTime ?? event.start;
  if (!original) return undefined;

  const identity = original.date
    ? await deriveCalendarMaterializedIdentity({
        iCalendarUID: event.iCalUID,
        provider: CALENDAR_PROVIDER,
        isAllDay: true,
        originalStartCivilDay: original.date,
        timeZoneIdentifier: original.timeZone ?? list.timeZone,
      })
    : original.dateTime
      ? await deriveCalendarMaterializedIdentity({
          iCalendarUID: event.iCalUID,
          provider: CALENDAR_PROVIDER,
          isAllDay: false,
          originalStartDate: new Date(original.dateTime),
        })
      : undefined;
  if (!identity) return undefined;

  if (!event.start || !event.end) return undefined;
  const start = dateTimeToIso(event.start);
  const end = dateTimeToIso(event.end);
  if (!start || !end) return undefined;

  const pageID = await deriveEventPageId(identity);

  return {
    pageID,
    status: event.status ?? "confirmed",
    title: event.summary?.trim() || "(untitled event)",
    start,
    end,
    isAllDay: Boolean(event.start.date),
    calendarTitle: list.summary || "Calendar",
    location: event.location?.trim() || undefined,
    organizer: event.organizer ? { email: event.organizer.email, displayName: event.organizer.displayName } : undefined,
    attendees: (event.attendees ?? [])
      // Google includes the organizer/self/resource rows in `attendees`
      // too in some cases; a resource (e.g. a meeting room) is not a
      // Person — excluded. Everything else (including the organizer, who
      // is also usually a plain attendee row) becomes a Person edge
      // candidate; `materialized-doc.ts` dedupes organizer vs. attendee
      // edges by relation id, not by email, so an email appearing in both
      // roles correctly gets both edges.
      .filter((a) => !a.resource)
      .map((a) => ({ email: a.email, displayName: a.displayName })),
  };
}

/** The provider-owned fields this worker will write to a materialized
 *  Event page — see this file's header on why organizer/attendees are
 *  folded into the hash even though Swift's original `providerProperties`
 *  didn't cover them (Swift never materialized those as edges). */
export async function eventBaselineHash(occurrence: NormalizedEventOccurrence): Promise<string> {
  const canonical = JSON.stringify({
    title: occurrence.title,
    start: occurrence.start,
    end: occurrence.end,
    isAllDay: occurrence.isAllDay,
    calendarTitle: occurrence.calendarTitle,
    location: occurrence.location ?? null,
    organizerEmail: occurrence.organizer?.email.trim().toLowerCase() ?? null,
    attendeeEmails: [...new Set(occurrence.attendees.map((a) => a.email.trim().toLowerCase()))].sort(),
  });
  return sha256Hex(canonical);
}

/** The provider-owned fields this worker will write to a materialized
 *  Person page (title + email — see `materialized-doc.ts`). */
export async function personBaselineHash(displayName: string | undefined, email: string): Promise<string> {
  const canonical = JSON.stringify({
    displayName: displayName?.trim() || null,
    email: email.trim().toLowerCase(),
  });
  return sha256Hex(canonical);
}

/** Every owned field of a materialized Event page, individually hashed —
 *  see this file's header, "PER-FIELD GRANULARITY". Each hash covers
 *  EXACTLY the same canonical value `eventBaselineHash` folds into its one
 *  combined digest for that field, so a field's hash changes if and only
 *  if that field's contribution to the combined hash would have changed
 *  too — this is a refinement of `eventBaselineHash`, not a different
 *  notion of "changed". `organizer`/`attendees` cover the event's owned
 *  RELATIONS (see `materialized-doc.ts`'s `reconcileOwnedEdges`), not a
 *  scalar property. */
export const EVENT_OWNED_FIELDS = [
  "title",
  "start",
  "end",
  "isAllDay",
  "calendarTitle",
  "location",
  "organizer",
  "attendees",
] as const;

export type EventOwnedField = (typeof EVENT_OWNED_FIELDS)[number];

export async function eventFieldBaselineHashes(
  occurrence: NormalizedEventOccurrence,
): Promise<Record<EventOwnedField, string>> {
  const attendeeEmails = [...new Set(occurrence.attendees.map((a) => a.email.trim().toLowerCase()))].sort();
  const entries = await Promise.all(
    EVENT_OWNED_FIELDS.map(async (field) => {
      const canonical = JSON.stringify(
        field === "title"
          ? occurrence.title
          : field === "start"
            ? occurrence.start
            : field === "end"
              ? occurrence.end
              : field === "isAllDay"
                ? occurrence.isAllDay
                : field === "calendarTitle"
                  ? occurrence.calendarTitle
                  : field === "location"
                    ? (occurrence.location ?? null)
                    : field === "organizer"
                      ? (occurrence.organizer?.email.trim().toLowerCase() ?? null)
                      : attendeeEmails,
      );
      return [field, await sha256Hex(canonical)] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<EventOwnedField, string>;
}

/** Every owned field of a materialized Person page, individually hashed —
 *  mirrors `eventFieldBaselineHashes` above. `title` hashes the value
 *  `materialized-doc.ts`'s `setTitleIfChanged` would actually WRITE
 *  (`displayName?.trim() || email`), not the raw `displayName` input, so
 *  the hash tracks the field materialization owns, not an input the
 *  transform might leave unchanged even when its raw source differs (or
 *  vice versa). */
export const PERSON_OWNED_FIELDS = ["title", "email"] as const;

export type PersonOwnedField = (typeof PERSON_OWNED_FIELDS)[number];

export async function personFieldBaselineHashes(
  displayName: string | undefined,
  email: string,
): Promise<Record<PersonOwnedField, string>> {
  const title = displayName?.trim() || email;
  const [titleHash, emailHash] = await Promise.all([
    sha256Hex(JSON.stringify(title)),
    sha256Hex(JSON.stringify(email.trim().toLowerCase())),
  ]);
  return { title: titleHash, email: emailHash };
}

/** Diffs a previous per-field hash map (`undefined` for a page never
 *  materialized before) against a freshly computed one, returning the set
 *  of fields whose hash actually changed. `previous === undefined` returns
 *  EVERY field in `current` — first materialization has no baseline to
 *  compare against, so every owned field is "changed" (there's nothing in
 *  the doc yet for any of them). Generic over the field-key union so both
 *  `EventOwnedField` and `PersonOwnedField` share this one implementation.
 *  `previous` is deliberately typed as a plain `Record<string, string>`
 *  (not `Record<K, string>`) — it comes straight off
 *  `materialization-store.ts`'s `MaterializationState.fieldHashes`, which
 *  is untyped JSON-round-tripped storage and has no compile-time guarantee
 *  of exactly which keys it holds (e.g. a field removed from a later
 *  version of this worker would still be sitting in an old stored row) —
 *  a missing/extra key in `previous` is handled the same as any other
 *  mismatch (`previous[key] !== current[key]`, `undefined !== <hash>`),
 *  never a type error. */
export function diffChangedFields<K extends string>(
  previous: Record<string, string> | undefined,
  current: Record<K, string>,
): Set<K> {
  const keys = Object.keys(current) as K[];
  if (!previous) return new Set(keys);
  const changed = new Set<K>();
  for (const key of keys) {
    if (previous[key] !== current[key]) changed.add(key);
  }
  return changed;
}

export { derivePersonPageId };
