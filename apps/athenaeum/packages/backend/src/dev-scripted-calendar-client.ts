// `makeDevScriptedCalendarGatekeeperClient` — a small, deterministic `CalendarGatekeeperClientApi`
// double for LOCAL WEB BROWSER VERIFICATION ONLY, installed via `/__dev__/enable-scripted-calendar`
// (index.ts) into `calendarGatekeeperClientTestHook.api` — the exact same live, per-call
// indirection `agentEditModelClientTestHook.converse` already uses for the `/__dev__/enable-
// scripted-model` route (see that route's own header comment in index.ts for the full rationale:
// a real browser session is a different OS process than any Vitest run, so it cannot reach a
// module-level test hook except through an HTTP route like this one).
//
// **Deliberately NOT `@athenaeum/gatekeeper-google-calendar`'s own `GoogleCalendarClientScripted`
// double** (the one `test/calendar-service.test.ts` uses, wrapped by that test's own
// `installScriptedCalendarClient` helper). That package is `athenaeum-backend`'s devDependency
// ONLY — `calendar-gatekeeper-client.ts`'s own header comment is explicit: "production
// (`calendar-service-live.ts`) has no dependency on that package... `@athenaeum/gatekeeper-
// google-calendar` IS a devDependency for exactly one reason: `test/calendar-service.test.ts`
// builds a `CalendarGatekeeperClient` Layer that wraps that package's own
// `GoogleCalendarClientScripted` fixture double." Reaching for it from `src/index.ts` (a file
// that ships in the real Worker bundle `wrangler dev`/`wrangler deploy` actually run) would
// upgrade that devDependency into a real production dependency for the sake of one dev-only
// browser-verification route. This file keeps that boundary intact by implementing the SAME
// `CalendarGatekeeperClientApi` surface directly, with its own tiny fixture generator — it proves
// a different thing than `test/calendar-service.test.ts` already proves. That test proves
// `CalendarService`'s merge/attendee-import/recurring-event logic is CORRECT against realistic
// Google Calendar API response shapes (already done, in-process, over real Cap'n Web RPC, per
// this stage's own hard constraint). This route exists only to give a REAL BROWSER something to
// look at during manual verification — synced events that render in `CalendarDayView.tsx` in
// `packages/web` — so its fixture data only needs to be schema-valid and land "today" in wall-
// clock terms, not exhaustively cover every Google Calendar edge case (that coverage already
// exists, and is not this file's job to re-prove).
//
// Observer-verification methods (`mintObserverVerifier`/`addObserver`/`notifyCalendarTouched`)
// are not exercised by anything the web browser-verification flow this route backs actually
// calls (there is no second collaborator/observer in that verification session) — they're
// implemented as harmless successes rather than left `notImplementedInScript`-style broken, so a
// future verification session that DOES exercise sharing/observers against this same scripted
// double doesn't trip over a stub it wasn't expecting to fail.

import * as Effect from "effect/Effect"
import type {
  CalendarGatekeeperClientApi,
  RemoteCalendarEvent,
  RemoteCalendarEventsPage,
  RemoteGoogleCalendarInfo
} from "./calendar-gatekeeper-client.js"

/** Builds a small, fixed set of "today" fixture events (plus one "tomorrow" event, deliberately
 *  OUTSIDE `CalendarDayView.tsx`'s "today" window — proves the real `[from, to)` filtering
 *  `calendar-service-live.ts#listEvents` already does, not just that events render at all),
 *  computed fresh against the REAL current wall-clock time every call — so a verification session
 *  run on any date sees events actually inside "today," rather than a fixed date that ages out
 *  the day after this file is written. */
const buildFixtureEvents = (): ReadonlyArray<RemoteCalendarEvent> => {
  const now = new Date()
  const at = (hour: number, minute = 0): string => {
    const d = new Date(now)
    d.setHours(hour, minute, 0, 0)
    return d.toISOString()
  }
  const tomorrowStart = new Date(now)
  tomorrowStart.setDate(tomorrowStart.getDate() + 1)
  tomorrowStart.setHours(10, 0, 0, 0)
  const tomorrowEnd = new Date(tomorrowStart)
  tomorrowEnd.setHours(11, 0, 0, 0)

  return [
    {
      id: "dev-fixture-standup",
      title: "Team standup",
      start: { kind: "dateTime", dateTime: at(9, 30) },
      end: { kind: "dateTime", dateTime: at(9, 45) },
      status: "confirmed",
      attendees: [
        { email: "alice@example.test", displayName: "Alice" },
        { email: "bob@example.test", displayName: "Bob" }
      ]
    },
    {
      id: "dev-fixture-design-review",
      title: "Design review",
      start: { kind: "dateTime", dateTime: at(14, 0) },
      end: { kind: "dateTime", dateTime: at(15, 0) },
      status: "confirmed",
      attendees: [{ email: "carol@example.test", displayName: "Carol" }]
    },
    {
      id: "dev-fixture-tomorrow-planning",
      title: "Tomorrow's planning (outside today's window)",
      start: { kind: "dateTime", dateTime: tomorrowStart.toISOString() },
      end: { kind: "dateTime", dateTime: tomorrowEnd.toISOString() },
      status: "confirmed"
    }
  ]
}

/** Builds a fresh scripted `CalendarGatekeeperClientApi` — a new fixture-event set (re-anchored to
 *  "now") each time this is called, matching `/__dev__/enable-scripted-model`'s own
 *  install-fresh-every-call convention (index.ts's `enableScriptedModel`). Accepts ANY
 *  email/calendarId/code — this double has exactly one fixture "account," not per-email fixture
 *  data (unlike the gatekeeper package's own `GoogleCalendarClientScripted`, which the browser-
 *  verification flow this backs has no need to distinguish accounts for). */
export const makeDevScriptedCalendarGatekeeperClient = (): CalendarGatekeeperClientApi => {
  const events = buildFixtureEvents()

  const primaryCalendar: RemoteGoogleCalendarInfo = {
    id: "primary",
    summary: "Dev scripted calendar",
    accessRole: "owner",
    primary: true
  }

  const api: CalendarGatekeeperClientApi = {
    buildAuthorizationUrl: (state) =>
      Effect.succeed({
        // A syntactically real Google authorization URL (correct host/path/query shape, per
        // Google's own documented OAuth endpoint) with an inert `client_id` — genuinely reachable
        // over the network, and genuinely rejected by Google (no real OAuth client is registered
        // under this id — hard constraint: "no real Google OAuth client id/secret exists"), which
        // is exactly the honest "attempt the real redirect, let it visibly fail at Google's end"
        // behavior `CalendarPanel.tsx`'s own header comment documents. `state` round-trips
        // unchanged, same as the real `google-calendar-client-real.ts` builder.
        url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=athenaeum-dev-scripted.apps.googleusercontent.com&response_type=code&access_type=offline&scope=${encodeURIComponent("https://www.googleapis.com/auth/calendar")}&state=${encodeURIComponent(state)}`
      }),

    // Scripted: the "code exchange" always succeeds — there is no real Google authorization code
    // to validate in this environment (see this file's header comment).
    exchangeAndConnect: () => Effect.void,

    listCalendars: () => Effect.succeed([primaryCalendar]),

    eventsPage: (): Effect.Effect<RemoteCalendarEventsPage, never> => Effect.succeed({ items: events }),

    mintObserverVerifier: (observerEmail) => Effect.succeed({ token: `dev-scripted-verifier:${observerEmail}` }),

    addObserver: () => Effect.void,

    notifyCalendarTouched: () => Effect.succeed({ failedObserverIds: [] })
  }

  return api
}
