import { useEffect, useState } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  ConnectGoogleCalendarInput,
  DisconnectGoogleCalendarInput,
  type EntityId
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { workspaceId } from "./workspace-id.js"
import {
  CALENDAR_BINDING_CHANGED_EVENT,
  loadCalendarBindingId,
  clearCalendarBindingId
} from "./calendar-binding-storage.js"

// Web-stage task item 1: "A 'Connect Google Calendar' button/flow... since no real OAuth app
// exists, this must correctly show a real 'not configured' or a genuine OAuth-redirect attempt...
// document exactly what state a real user sees today."
//
// **The choice made here, and why**: attempt the REAL RPC call for real (`connectGoogleCalendar`
// — genuine Cap'n Web round trip to `WorkspaceDurableObject`, genuine `CalendarService#connect`,
// genuine `CalendarGatekeeperClient#buildAuthorizationUrl`), then render whatever REAL outcome
// comes back — never a faked "connected" state, never a client-side-only simulation. Two distinct
// honest outcomes exist depending on deployment configuration, and this component surfaces both
// faithfully rather than special-casing either:
//
//   1. **"Not configured" (what David sees TODAY, in this environment)** — `wrangler.jsonc`
//      deliberately leaves the `GATEKEEPER_GOOGLE_CALENDAR` service binding commented out (that
//      file's own header comment: "no real Google OAuth client id/secret for the gatekeeper
//      Worker to do anything useful with even if bound"). `env.GATEKEEPER_GOOGLE_CALENDAR` is
//      therefore `undefined`, so `CalendarService#connect` runs against
//      `CalendarGatekeeperClientUnconfigured` (`calendar-gatekeeper-client.ts`), which fails
//      every call with a clear `UnexpectedError`. This component exposes that honest unavailable
//      state with a generic retryable message while retaining the diagnostic in the console: an
//      upstream provider or gatekeeper cause is not safe to put into the DOM.
//   2. **A genuine OAuth-redirect attempt (what a real, fully-configured deployment's user sees,
//      and what THIS environment's own `/__dev__/enable-scripted-calendar` dev route — see
//      `dev-scripted-calendar-client.ts` — makes reachable for verification purposes only)** —
//      once `connectGoogleCalendar` succeeds, this component shows a real `<a href=>` to the
//      returned `authorizationUrl` rather than auto-navigating (better UX: a surprise full-page
//      redirect on click is worse than a confirm step, and it keeps this tab's app state intact
//      if the user backs out). Clicking it is a GENUINE redirect attempt — in a real deployment
//      with a real Google Cloud Console OAuth client registered (see
//      `docs/gatekeeper-google-calendar-decisions.md` §3 for the exact steps David needs), it
//      lands on Google's real consent screen; with the scripted dev double installed (or with a
//      real service binding but no real registered client id), it lands on Google's own real
//      `accounts.google.com` and fails there with Google's own `invalid_client` error — "visibly
//      fail at Google's end," exactly as the task's own suggested default describes, never
//      something this app fabricates or hides.
//
// **What is NOT possible to verify live in this environment** (hard constraint: "no real Google
// OAuth client id/secret exists... no real Google account is available"): actually completing
// Google's consent screen and receiving a REAL authorization code. `CalendarOAuthCallback.tsx`
// (the real callback-handling code any deployment needs) is exercised in verification by
// navigating directly to its URL with a `state` captured from a real `connectGoogleCalendar` call
// (made real by the scripted gatekeeper double) and a placeholder `code` — proving the callback
// code path for real, without pretending a real Google consent screen was involved. See this
// stage's own report for the exact browser-verification steps taken.

type ConnectState =
  | { readonly status: "idle" }
  | { readonly status: "busy" }
  | { readonly status: "ready"; readonly authorizationUrl: string }
  | { readonly status: "failure" }

const calendarConnectFailureMessage =
  "Calendar connection couldn’t be started. Check the calendar integration, then try again."
const calendarDisconnectFailureMessage =
  "We couldn’t confirm that your calendar was disconnected. It may still be connected. Review the connection before trying again."

export function CalendarPanel() {
  const [connect, setConnect] = useState<ConnectState>({ status: "idle" })
  const [bindingId, setBindingId] = useState<EntityId | undefined>(() => loadCalendarBindingId(workspaceId))
  const [disconnectBusy, setDisconnectBusy] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)

  // Same-tab coherence with `CalendarOAuthCallback.tsx` — see `calendar-binding-storage.ts`'s own
  // header comment for the full rationale (`storage` never fires in the writing document itself).
  // Without this, landing on the callback overlay (rendered above this component in the SAME
  // mounted `Workspace`, per `App.tsx`) would leave this panel showing "Connect Google Calendar"
  // until a manual reload, even though the connection just succeeded.
  useEffect(() => {
    const refresh = () => setBindingId(loadCalendarBindingId(workspaceId))
    window.addEventListener("storage", refresh)
    window.addEventListener(CALENDAR_BINDING_CHANGED_EVENT, refresh)
    return () => {
      window.removeEventListener("storage", refresh)
      window.removeEventListener(CALENDAR_BINDING_CHANGED_EVENT, refresh)
    }
  }, [])

  const handleConnect = () => {
    setConnect({ status: "busy" })
    const fiber = runtime.runFork(
      Effect.exit(
        WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.connectGoogleCalendar(new ConnectGoogleCalendarInput({ workspaceId }))))
      )
    )
    fiber.addObserver((outer) => {
      if (!Exit.isSuccess(outer)) return
      const inner = outer.value
      if (Exit.isSuccess(inner)) {
        setConnect({ status: "ready", authorizationUrl: inner.value.authorizationUrl })
      } else if (!Exit.isInterrupted(inner)) {
        setConnect({ status: "failure" })
        console.error(inner.cause.toString())
      }
    })
  }

  const handleDisconnect = () => {
    if (bindingId === undefined) return
    setDisconnectBusy(true)
    setDisconnectError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.disconnectGoogleCalendar(new DisconnectGoogleCalendarInput({ workspaceId, bindingId })))
      )
    )
    fiber.addObserver((exit) => {
      setDisconnectBusy(false)
      if (Exit.isSuccess(exit)) {
        clearCalendarBindingId(workspaceId)
        setBindingId(undefined)
        setConnect({ status: "idle" })
      } else if (!Exit.isInterrupted(exit)) {
        setDisconnectError(calendarDisconnectFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <section className="calendar-panel">
      <h2>Google Calendar</h2>

      {bindingId !== undefined ? (
        <div className="calendar-connected">
          <div className="calendar-connected-status" role="status">
            <span className="calendar-status-dot" aria-hidden="true" />
            <div>
              <strong>Google Calendar connected</strong>
              <p className="calendar-connected-hint">
                This connection is ready for the workspace in this browser.
              </p>
            </div>
          </div>
          {disconnectError !== null && (
            <section
              className="calendar-disconnect-unavailable"
              role="alert"
              aria-label="Calendar disconnection is unconfirmed"
            >
              <p>{disconnectError}</p>
            </section>
          )}
          <button type="button" onClick={handleDisconnect} disabled={disconnectBusy}>
            {disconnectBusy ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="calendar-connect">
          <div className="calendar-connect-copy">
            <strong>Bring your schedule into Today</strong>
            <p>Connect Google Calendar to keep meetings and the daily note in one place.</p>
          </div>
          {connect.status !== "ready" && (
            <button type="button" onClick={handleConnect} disabled={connect.status === "busy"}>
              {connect.status === "busy" ? "Connecting…" : "Connect Google Calendar"}
            </button>
          )}
          {connect.status === "failure" && (
            <div className="calendar-connect-unavailable" role="alert">
              <strong>Calendar connection unavailable</strong>
              <p>{calendarConnectFailureMessage}</p>
            </div>
          )}
          {connect.status === "ready" && (
            <div className="calendar-redirect-ready">
              <p><strong>Continue in Google</strong></p>
              <p>Review Athenaeum’s access request, then return here to finish connecting.</p>
              <a
                className="calendar-redirect-link"
                href={connect.authorizationUrl}
                target="_blank"
                rel="noreferrer"
              >
                Continue to Google →
              </a>
              <button type="button" onClick={() => setConnect({ status: "idle" })}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
