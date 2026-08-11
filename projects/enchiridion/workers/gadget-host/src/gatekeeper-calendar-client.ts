// @enchiridion/worker-gadget-host — thin client for gatekeeper-google's
// `CalendarReadModel` RPC surface, reached over a NAMED-ENTRYPOINT
// Cloudflare Service Binding (`GATEKEEPER_GOOGLE`, `entrypoint:
// "CalendarReadModel"` — see wrangler.jsonc's comment).
//
// Same "local, minimal, structural stub; types imported from a shared
// contract package" pattern as `vault-accessor-client.ts` — see that file's
// header, and `@enchiridion/gadget-gatekeeper-google-rpc-contract`'s file
// header for why `CalendarReadModel` is a new, minimal, additive
// `WorkerEntrypoint` on `workers/gatekeeper-google/src/index.ts`.

import type { CalendarEventSummaryDTO } from "@enchiridion/gadget-gatekeeper-google-rpc-contract";

export interface CalendarReadStub {
  listUpcomingEvents(maxResults?: number, windowDays?: number): Promise<CalendarEventSummaryDTO[]>;
}

export interface GatekeeperGoogleClientEnv {
  GATEKEEPER_GOOGLE: CalendarReadStub;
}

export function defaultCalendarReadStub(env: GatekeeperGoogleClientEnv): CalendarReadStub {
  return env.GATEKEEPER_GOOGLE;
}
