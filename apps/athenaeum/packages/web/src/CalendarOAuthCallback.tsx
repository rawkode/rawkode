import { useEffect, useState } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { GoogleCalendarOAuthCallbackInput } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { workspaceId } from "./workspace-id.js"
import { saveCalendarBindingId } from "./calendar-binding-storage.js"

// The REAL other half of `CalendarPanel.tsx`'s OAuth redirect — this is genuinely what a
// production deployment's `CALENDAR_OAUTH_REDIRECT_URI` route does (see `gatekeeper-rpc.ts`'s own
// header comment on `GoogleCalendarOAuthCallbackInput`: "the client's own callback route... calls
// googleCalendarOAuthCallback"), not a dev-only artifact. Google would redirect the browser back
// to exactly this path (`/oauth/google-calendar/callback?code=...&state=...`) after the user
// grants (or denies) consent; this component reads those two query params and completes the
// exchange for real over the real RPC. `packages/web` has no router — this is a plain
// `window.location.pathname` check rendered unconditionally near the top of `Workspace`
// (App.tsx), same "no dependency needed for one route" reasoning `workspace-id.ts`'s own `?workspace=`
// query-param handling already uses. Vite's dev server serves `index.html` for this path too
// (default `appType: "spa"` history-fallback), so this works identically under `vite dev` and a
// real static-asset deployment.
//
// `calendarId`/`mode` are NOT sourced from a calendar picker (`gatekeeper-rpc.ts`'s own doc
// comment: "a client-side calendar picker... is out of scope for this schema-only stage" — still
// true here; no `listGoogleCalendars` RPC exists yet). Hardcoded to `"primary"`/`"allVisible"` —
// the single most useful default for a personal workspace's own primary Google Calendar. A future
// stage that adds a real picker should read these from `sessionStorage`/query params captured at
// `connectGoogleCalendar` time instead of literals here.
const CALLBACK_PATH = "/oauth/google-calendar/callback"
const DEFAULT_CALENDAR_ID = "primary"
const DEFAULT_MODE = "allVisible" as const

type CallbackState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "success"; readonly bindingId: string }
  | { readonly status: "failure"; readonly message: string }
  | { readonly status: "missing-params" }

// An OAuth code is single-use, so the callback must never offer an in-place retry. Its user-facing
// result also must not echo provider query values, domain failures, or transport causes; all of
// those can carry account/provider context and the safe recovery is a fresh connection from the
// calendar surface.
const cancelledMessage = "Calendar connection was cancelled. Return to Athenaeum to try again."
const incompleteMessage = "This calendar connection link is incomplete. Return to Athenaeum and start the connection again."
const failedMessage = "Calendar connection couldn’t be completed. Return to Athenaeum and try connecting your calendar again."

export function CalendarOAuthCallback() {
  const [state, setState] = useState<CallbackState>({ status: "idle" })

  useEffect(() => {
    if (window.location.pathname !== CALLBACK_PATH) return

    const params = new URLSearchParams(window.location.search)
    const code = params.get("code")
    const oauthState = params.get("state")
    const errorParam = params.get("error") // Google sets this (e.g. "access_denied") on refusal.

    if (errorParam !== null) {
      setState({ status: "failure", message: cancelledMessage })
      return
    }
    if (code === null || oauthState === null) {
      setState({ status: "missing-params" })
      return
    }

    setState({ status: "running" })
    const effect = WorkspaceRpcClient.pipe(
      Effect.flatMap((client) =>
        client.googleCalendarOAuthCallback(
          new GoogleCalendarOAuthCallbackInput({
            workspaceId,
            code,
            state: oauthState,
            calendarId: DEFAULT_CALENDAR_ID,
            mode: DEFAULT_MODE
          })
        )
      )
    )
    const fiber = runtime.runFork(Effect.exit(effect))
    fiber.addObserver((outer) => {
      if (!Exit.isSuccess(outer)) return
      const inner = outer.value
      if (Exit.isSuccess(inner)) {
        saveCalendarBindingId(workspaceId, inner.value.binding.id)
        setState({ status: "success", bindingId: inner.value.binding.id })
      } else if (!Exit.isInterrupted(inner)) {
        setState({ status: "failure", message: failedMessage })
        console.error(inner.cause.toString())
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const returnToApp = () => {
    window.history.replaceState(null, "", window.location.origin)
    window.location.assign("/")
  }

  if (window.location.pathname !== CALLBACK_PATH) return null

  return (
    <div className="oauth-callback-overlay">
      <div className="oauth-callback-card">
        <h2>Google Calendar connection</h2>
        {state.status === "idle" && <p>Preparing…</p>}
        {state.status === "running" && <p>Completing the connection…</p>}
        {state.status === "missing-params" && (
          <p className="error" role="alert">{incompleteMessage}</p>
        )}
        {state.status === "failure" && <p className="error" role="alert">{state.message}</p>}
        {state.status === "success" && (
          <p className="oauth-callback-success">
            Google Calendar is connected. The connection is saved for this workspace in this
            browser.
          </p>
        )}
        <button type="button" onClick={returnToApp}>
          Back to Athenaeum
        </button>
      </div>
    </div>
  )
}
