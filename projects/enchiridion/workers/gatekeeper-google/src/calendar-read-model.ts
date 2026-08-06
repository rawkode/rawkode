// @enchiridion/worker-gatekeeper-google — the Calendar READ surface: pure
// functions backing `CalendarReadModel` (./index.ts), a `WorkerEntrypoint`
// exposed to `workers/gadget-host`'s `gatekeeper.google.calendar.read`
// capability over a NAMED-ENTRYPOINT Cloudflare Service Binding
// (`workers/gadget-host/wrangler.jsonc`'s `GATEKEEPER_GOOGLE` binding,
// `entrypoint: "CalendarReadModel"`) — real Workers RPC, no `fetch()`-routed
// path, exactly like `GmailReadModel`/`gmail-read-model.ts`.
//
// NEW IN THIS PASS (plan §Gadgets, P4 "gatekeeper.google.calendar.read"
// capability) — see `@enchiridion/gadget-gatekeeper-google-rpc-contract`'s
// file header for the full "why this is a new, additive, minimal exception"
// writeup. This file adds exactly one operation and touches no existing
// method/route anywhere in this worker.
//
// `listUpcomingEvents` is deliberately narrower than calendar ingest: a
// single, un-paginated, time-windowed `events.list` call with NO
// `syncToken` (so it can never desynchronize `runCalendarIngestCycle`'s own
// cursor — see `calendar-api.ts`'s `ListEventsParams` doc comment on
// `syncToken`/`timeMin`/`timeMax` being mutually exclusive at the caller
// level), and it never writes anything — no materialization, no VaultDO
// call. Same `hasScope(...)` defense-in-depth gate `gmail-read-model.ts`
// establishes for Gmail, applied to `CALENDAR_EVENTS_SCOPE` here.

import {
  CALENDAR_SCOPE_NOT_GRANTED_MESSAGE,
  DEFAULT_CALENDAR_READ_MAX_RESULTS,
  DEFAULT_CALENDAR_READ_WINDOW_DAYS,
  MAX_CALENDAR_READ_MAX_RESULTS,
  MAX_CALENDAR_READ_WINDOW_DAYS,
  type CalendarEventSummaryDTO,
} from "@enchiridion/gadget-gatekeeper-google-rpc-contract";
import { listEventsPage, type FetchLike, type GoogleCalendarEvent } from "./calendar-api";
import { CALENDAR_EVENTS_SCOPE } from "./oauth-client";

/** The slice of `GoogleAccountDO`'s RPC surface this function needs — same
 *  "structurally satisfied by a real DurableObjectStub<GoogleAccountDO>,
 *  same-script so no cross-worker-contract cast needed" convention
 *  `gmail-read-model.ts`'s `GmailRpcStub` documents. */
export interface CalendarReadRpcStub {
  hasScope(scope: string): Promise<boolean>;
  getValidAccessToken(): Promise<string>;
}

function summarize(event: GoogleCalendarEvent): CalendarEventSummaryDTO {
  const start = event.start?.dateTime ?? event.start?.date ?? "";
  const end = event.end?.dateTime ?? event.end?.date ?? "";
  return {
    id: event.id,
    title: event.summary ?? "(no title)",
    start,
    end,
    isAllDay: event.start?.date !== undefined,
    location: event.location,
    status: event.status ?? "confirmed",
  };
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/** Backs `CalendarReadModel.listUpcomingEvents` — a bounded, read-only,
 *  side-effect-free window over the connected account's primary calendar,
 *  starting from "now". Never touches the ingest `syncToken` cursor
 *  (`google-account-do.ts`'s `getSyncCursor`/`setSyncCursor`) and never
 *  writes to VaultDO — see this file's header. */
export async function listUpcomingEvents(
  stub: CalendarReadRpcStub,
  maxResults?: number,
  windowDays?: number,
  now: Date = new Date(),
  fetchImpl?: FetchLike,
): Promise<CalendarEventSummaryDTO[]> {
  if (!(await stub.hasScope(CALENDAR_EVENTS_SCOPE))) {
    throw new Error(CALENDAR_SCOPE_NOT_GRANTED_MESSAGE);
  }

  const resolvedMax = clamp(maxResults, DEFAULT_CALENDAR_READ_MAX_RESULTS, MAX_CALENDAR_READ_MAX_RESULTS);
  const resolvedWindowDays = clamp(windowDays, DEFAULT_CALENDAR_READ_WINDOW_DAYS, MAX_CALENDAR_READ_WINDOW_DAYS);

  const accessToken = await stub.getValidAccessToken();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + resolvedWindowDays * 24 * 60 * 60 * 1000).toISOString();

  const page = await listEventsPage({ accessToken, timeMin, timeMax, fetchImpl });
  return page.items.slice(0, resolvedMax).map(summarize);
}
