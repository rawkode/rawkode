// @enchiridion/worker-gatekeeper-google — Calendar cron ingest
// orchestration.
//
// Plan §Google gatekeeper: "Calendar: cron incremental sync (syncToken,
// full resync on 410) -> vault.ingestEvents() -> materialization ...".
// Ties together `calendar-api.ts` (HTTP), `token-store.ts`'s generic
// sync-cursor storage (`resource = "calendar"`), `calendar-materialization.ts`
// (identity/normalization), and `materialization.ts` (the actual
// build+push+skip decision per event). Pure function over an injected
// `SqlExecutor`/`accessToken`/`now`/`fetchImpl` — no DO/Workers-runtime
// dependency, directly unit-testable — `google-account-do.ts`'s
// `runCalendarIngestCycle()` RPC method is the thin wrapper that resolves
// a real access token and `this.sql` and calls this.
//
// SYNC MODE DECISION: incremental (`syncToken`) whenever this worker has
// one stored; otherwise (first-ever run, OR after a `410 Gone`) a
// time-windowed full sync — Google requires SOME bound on a syncToken-less
// `events.list` call to avoid an unbounded full-calendar-history dump.
// The window (30 days back, 180 days forward, `FULL_SYNC_WINDOW_*` below)
// is a deliberate, documented choice, not a Google-mandated value: wide
// enough to materialize "the stuff a personal assistant cares about"
// (recent past for context, the practical future-planning horizon) without
// walking a calendar's entire history on every full resync. Once
// `nextSyncToken` is captured, every later run is incremental regardless
// of this window — the window only bounds how far back/forward a (re)sync
// looks, once.
//
// CURSOR-AFTER-MATERIALIZATION + POISON-PILL ISOLATION (adversarial-review
// finding, plan §Google gatekeeper: "The sync cursor must only advance
// after a batch's materialization succeeds"): `setSyncCursor` is called
// ONLY after every event in the fetched batch has been ATTEMPTED (success
// or recorded failure) — never before the materialization loop runs.
// Advancing the cursor first (the original bug) meant that if any event's
// `materializeEventOccurrence`/`pushPageUpdate` threw, the whole batch's
// remaining events were never attempted (the exception aborted the loop),
// yet the cursor had already moved past all of them — Google's
// incremental `syncToken` API never re-reports events once a cursor has
// advanced past them, so this was silent, PERMANENT data loss, not a
// retry-next-tick situation. Mirrors
// `workers/vault/src/rebuild-projections.ts`'s "POISON-PILL ISOLATION"
// pattern one-for-one: each event's materialization runs inside its own
// try/catch (`ingest-failures-store.ts` records the failure), so one bad
// event costs exactly that event, never its batch siblings — and the
// cursor advance happens exactly once, after the full loop, regardless of
// how many individual events failed.

import { getSyncCursor, setSyncCursor } from "./token-store";
import {
  CalendarSyncTokenExpiredError,
  listEventsPage,
  type FetchLike,
  type GoogleCalendarEvent,
  type GoogleCalendarEventsListResponse,
} from "./calendar-api";
import { deleteCalendarEventId, recordCalendarEventId } from "./calendar-event-id-store";
import { normalizeOccurrence } from "./calendar-materialization";
import { materializeEventOccurrence, retractCancelledEvent } from "./materialization";
import { recordCalendarIngestFailure } from "./ingest-failures-store";
import type { SqlExecutor } from "./schema";
import type { VaultClientEnv } from "./vault-client";

const CALENDAR_SYNC_RESOURCE = "calendar";
const FULL_SYNC_WINDOW_PAST_DAYS = 30;
const FULL_SYNC_WINDOW_FUTURE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The one calendar this worker ever ingests from — `eventUrl`
 *  (`calendar-write-model.ts`) separately defaults to this same literal
 *  ("the user's own primary calendar, not arbitrary shared calendars" —
 *  plan's calendar scope). Threaded explicitly into BOTH `listEventsPage`
 *  below (`fetchAllPages`) AND `recordCalendarEventId` below (this file's
 *  `calendar_event_ids` write, plan §"Live Backend Connectivity (P8)",
 *  `proposeRsvp` real event-ID verification) — an adversarial-review fix:
 *  this constant used to be passed only to `recordCalendarEventId`, while
 *  `fetchAllPages` separately relied on `listEventsPage`'s own inline `??
 *  "primary"` default (`calendar-api.ts`) to agree with it, which the two
 *  literals only did COINCIDENTALLY — nothing enforced they stayed equal,
 *  so an edit to either default in isolation could have silently
 *  desynced which calendar events are actually fetched from vs. which
 *  calendar id `calendar_event_ids` claims they came from, undetectable by
 *  any test. Passing this ONE constant to both call sites makes the
 *  coupling real. */
const PRIMARY_CALENDAR_ID = "primary";

export interface CalendarIngestDeps {
  sql: SqlExecutor;
  env: VaultClientEnv;
  accessToken: string;
  now: Date;
  fetchImpl?: FetchLike;
}

export interface CalendarIngestResult {
  /** Did this run use the time-windowed full-resync path (first run, or
   *  recovering from an expired syncToken) rather than incremental? */
  fullResync: boolean;
  /** Total raw events seen across every fetched page (before filtering
   *  cancelled/unidentifiable ones out). */
  eventCount: number;
  /** Events that were materialized/re-materialized (a VaultDO write
   *  actually happened for the event page — organizer/attendee Person
   *  writes aren't counted separately here). */
  materializedCount: number;
  /** Events skipped: either the provider baseline hadn't changed (no
   *  write needed) or the event couldn't be identified (missing/blank
   *  iCalendar UID, malformed start/end — see `normalizeOccurrence`). */
  skippedCount: number;
  /** Previously-materialized events retracted because the provider now
   *  reports them `cancelled`. */
  retractedCount: number;
  /** Events whose materialization (or retraction) threw — recorded in
   *  `calendar_ingest_failures` (`ingest-failures-store.ts`) and skipped,
   *  WITHOUT aborting the rest of the batch or blocking the cursor
   *  advance. See this file's header, "CURSOR-AFTER-MATERIALIZATION +
   *  POISON-PILL ISOLATION". */
  failedCount: number;
}

async function fetchAllPages(deps: CalendarIngestDeps, syncToken: string | undefined): Promise<GoogleCalendarEventsListResponse[]> {
  const pages: GoogleCalendarEventsListResponse[] = [];
  let pageToken: string | undefined;
  const timeMin = syncToken ? undefined : new Date(deps.now.getTime() - FULL_SYNC_WINDOW_PAST_DAYS * DAY_MS).toISOString();
  const timeMax = syncToken ? undefined : new Date(deps.now.getTime() + FULL_SYNC_WINDOW_FUTURE_DAYS * DAY_MS).toISOString();

  for (;;) {
    const page = await listEventsPage({
      accessToken: deps.accessToken,
      // Passed EXPLICITLY (not left to `listEventsPage`'s own `?? "primary"`
      // default) — adversarial-review finding: the two literals used to
      // agree only coincidentally (this file's own `PRIMARY_CALENDAR_ID`
      // vs. `calendar-api.ts`'s independent inline default), so a future
      // edit to either one in isolation could silently desync which
      // calendar events are actually fetched from vs. which calendar id
      // `recordCalendarEventId` below claims they came from — with no test
      // able to catch that drift. Passing it explicitly here makes the
      // coupling real, not coincidental.
      calendarId: PRIMARY_CALENDAR_ID,
      syncToken,
      timeMin,
      timeMax,
      pageToken,
      fetchImpl: deps.fetchImpl,
    });
    pages.push(page);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return pages;
}

/** Runs one full ingest cycle: fetch (incremental or full), materialize,
 *  persist the new cursor. Never throws `CalendarSyncTokenExpiredError` —
 *  that's caught internally and turned into a full-resync retry (the
 *  documented recovery path); other errors (auth, network, a genuine
 *  Calendar API failure) propagate to the caller. */
export async function runCalendarIngest(deps: CalendarIngestDeps): Promise<CalendarIngestResult> {
  const storedSyncToken = getSyncCursor(deps.sql, CALENDAR_SYNC_RESOURCE);
  let fullResync = !storedSyncToken;
  let pages: GoogleCalendarEventsListResponse[];

  try {
    pages = await fetchAllPages(deps, storedSyncToken);
  } catch (error) {
    if (!(error instanceof CalendarSyncTokenExpiredError)) throw error;
    // 410 Gone: the stored syncToken is no longer usable — Google's
    // documented recovery is a full resync with no syncToken at all. The
    // stale cursor gets overwritten below once the resync completes and
    // yields a fresh `nextSyncToken`; nothing needs to be cleared eagerly.
    fullResync = true;
    pages = await fetchAllPages(deps, undefined);
  }

  let eventCount = 0;
  let materializedCount = 0;
  let skippedCount = 0;
  let retractedCount = 0;
  let failedCount = 0;

  for (const page of pages) {
    for (const event of page.items) {
      eventCount += 1;
      try {
        await ingestOneEvent(deps, event, page, {
          onSkipped: () => (skippedCount += 1),
          onRetracted: () => (retractedCount += 1),
          onMaterialized: () => (materializedCount += 1),
        });
      } catch (error) {
        // POISON-PILL ISOLATION — see this file's header. This event's
        // failure must not abort the rest of the batch, and must not
        // block the cursor advance below (which only happens once, after
        // every event in the batch has been attempted).
        failedCount += 1;
        recordCalendarIngestFailure(
          deps.sql,
          {
            eventId: event.id ?? null,
            iCalUid: event.iCalUID ?? null,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          deps.now.getTime(),
        );
      }
    }
  }

  // CURSOR-AFTER-MATERIALIZATION — see this file's header. Only advance
  // once the ENTIRE fetched batch has been attempted (every event either
  // materialized, skipped, retracted, or recorded as a failure above) —
  // never before, and never partway through.
  const finalPage = pages[pages.length - 1];
  if (finalPage?.nextSyncToken) {
    setSyncCursor(deps.sql, CALENDAR_SYNC_RESOURCE, finalPage.nextSyncToken, deps.now.getTime());
  }

  return { fullResync, eventCount, materializedCount, skippedCount, retractedCount, failedCount };
}

interface IngestOneEventCallbacks {
  onSkipped: () => void;
  onRetracted: () => void;
  onMaterialized: () => void;
}

/** Normalizes + materializes (or retracts) exactly one raw event. Split
 *  out of `runCalendarIngest`'s loop so that loop's per-event try/catch
 *  wraps one clearly-scoped unit of work — everything that can throw for
 *  a single event (`normalizeOccurrence`, `retractCancelledEvent`,
 *  `materializeEventOccurrence`) lives inside this one call.
 *
 *  `calendar_event_ids` bookkeeping (this file's `PRIMARY_CALENDAR_ID` doc
 *  comment, plan §"Live Backend Connectivity (P8)"): recorded for EVERY
 *  successfully-identified, non-cancelled occurrence — not just ones that
 *  actually got (re)materialized this cycle — since `event.id` is stable
 *  for a page's whole lifetime and a later `proposeRsvp` call must be able
 *  to resolve it even on a cycle where nothing else about the event
 *  changed. Removed on cancellation (mirrors `retractCancelledEvent`'s own
 *  `calendar_materialization_state` cleanup one line below it) so a
 *  retracted event can never resolve for a FRESH RSVP proposal afterward. */
async function ingestOneEvent(
  deps: CalendarIngestDeps,
  event: GoogleCalendarEvent,
  page: GoogleCalendarEventsListResponse,
  callbacks: IngestOneEventCallbacks,
): Promise<void> {
  const occurrence = await normalizeOccurrence(event, page);
  if (!occurrence) {
    callbacks.onSkipped();
    return;
  }
  if (occurrence.status === "cancelled") {
    deleteCalendarEventId(deps.sql, occurrence.pageID);
    const result = await retractCancelledEvent(deps.sql, deps.env, occurrence.pageID);
    if (result.tombstoned) callbacks.onRetracted();
    return;
  }
  if (event.id) {
    recordCalendarEventId(deps.sql, occurrence.pageID, event.id, PRIMARY_CALENDAR_ID);
  }
  const result = await materializeEventOccurrence(deps.sql, deps.env, occurrence, deps.now);
  if (result.applied) callbacks.onMaterialized();
  else callbacks.onSkipped();
}
