// @enchiridion/worker-gadget-host — the `gatekeeper.google.calendar.read`
// capability's enforcement + dispatch.
//
// Plan §Gadgets: "gatekeeper.google.calendar.read — a capability that, when
// granted, allows a gadget to call a narrow read-only calendar query (via a
// service/DO binding to gatekeeper-google ...)." Single-layer denial (the
// grant is all-or-nothing, no further scoping — see `capability-types.ts`'s
// `CapabilityScope` doc comment for why) plus the underlying
// `CalendarReadModel.listUpcomingEvents` RPC's OWN `hasScope(CALENDAR_
// EVENTS_SCOPE)` gate, unchanged — a gadget granted this capability can
// still be denied at the Google-account level if the connected account
// never granted Calendar access at all. Two independent gates, same
// "capability grant" vs. "underlying account has the data" distinction
// `graph-query-capability.ts`'s two-layer check draws (grant existence vs.
// view allowlist), just across a worker boundary this time.
//
// RE-CHECKED AGAIN AFTER THE CROSS-WORKER AWAIT (adversarial review
// finding): `requireCapability` before `calendar.listUpcomingEvents` only
// proves the grant was active at the MOMENT the call started.
// `listUpcomingEvents` crosses a worker boundary (a Service/DO binding to
// gatekeeper-google) and can take an arbitrary amount of wall-clock time to
// resolve — this file's own header promises revocation takes effect "on
// the very next call, not eventually" (per `capability-enforcement.ts`),
// which is only true if every call site re-reads the grant AFTER any await
// that could have let a revocation land, not just before. Without this, a
// grant revoked while the RPC is in flight has no effect: the in-flight
// call still completes and its result still reaches the gadget. So this
// function checks twice — once before dispatching (fail fast, same as
// before) and once after the await resolves, discarding the already-
// fetched result (never returning it) if the grant was revoked in between.
import { requireCapability } from "./capability-enforcement";
import type { CalendarReadStub } from "./gatekeeper-calendar-client";
import type { SqlExecutor } from "./schema";
import type { CalendarEventSummaryDTO } from "@enchiridion/gadget-gatekeeper-google-rpc-contract";

export async function readUpcomingCalendarEvents(
  sql: SqlExecutor,
  calendar: CalendarReadStub,
  gadgetId: string,
  maxResults?: number,
  windowDays?: number,
): Promise<CalendarEventSummaryDTO[]> {
  requireCapability(sql, gadgetId, "gatekeeper.google.calendar.read");
  const events = await calendar.listUpcomingEvents(maxResults, windowDays);
  // Re-check: the await above crossed into gatekeeper-google and could
  // have taken long enough for the grant to be revoked mid-flight. A grant
  // that was active before the call is not proof it's still active now —
  // deny (discard `events`, never return them) if it's gone.
  requireCapability(sql, gadgetId, "gatekeeper.google.calendar.read");
  return events;
}
