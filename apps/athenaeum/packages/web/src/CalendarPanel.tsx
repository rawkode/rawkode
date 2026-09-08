import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  BeginGoogleCalendarConnectionInput,
  IssueGoogleCalendarLaunchInput,
  GetGoogleCalendarConnectionCompletionInput,
  DisconnectGoogleCalendarInput,
  ListGatekeeperBindingsInput,
  SyncGoogleCalendarInput,
  HumanUiMutationAttribution,
  type CalendarOAuthClientAttemptHandle,
  type GatekeeperBindingSummary,
  type EntityId
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { workspaceId } from "./workspace-id.js"
import { useEffectQuery } from "./use-effect-query.js"
import {
  CALENDAR_BINDING_CHANGED_EVENT,
  CALENDAR_SYNC_TRIGGERED_EVENT,
  loadCalendarBindingId,
  clearCalendarBindingId
} from "./calendar-binding-storage.js"

// New clients use a two-step, opaque flow: begin an attributable admission, then explicitly follow
// a fixed first-party launch URL. Provider code/state never enters this component. Completion is
// read from the Workspace projection after the browser returns; an unconfigured deployment stays
// visibly unavailable rather than fabricating a connection.

type ConnectState =
  | { readonly status: "idle" }
  | { readonly status: "busy" }
  | { readonly status: "ready"; readonly attemptHandle: CalendarOAuthClientAttemptHandle; readonly fixedLaunchUrl: string }
  | { readonly status: "waiting"; readonly attemptHandle: CalendarOAuthClientAttemptHandle }
  | { readonly status: "failure" }

type SyncState =
  | { readonly status: "idle" }
  | { readonly status: "busy"; readonly bindingId: EntityId }
  | { readonly status: "success"; readonly bindingId: EntityId }
  | { readonly status: "failure"; readonly bindingId: EntityId }

const calendarConnectFailureMessage =
  "Calendar connection couldn’t be started. Check the calendar integration, then try again."
const calendarDisconnectFailureMessage =
  "We couldn’t confirm that your calendar was disconnected. It may still be connected. Review the connection before trying again."

const calendarCatalogFailureMessage =
  "We couldn’t confirm the calendar connections for this workspace. Retry before connecting another account."
const calendarCatalogFallbackMessage =
  "A calendar connection is remembered in this browser, but the workspace could not confirm it."
const calendarSyncFailureMessage =
  "Calendar sync couldn’t be started. Nothing has changed. Retry from this connection."

const calendarAttemptStorageKey = (id: EntityId): string => `athenaeum.calendar-oauth.attempt.v1:${id}`
const loadCalendarAttemptHandle = (id: EntityId): CalendarOAuthClientAttemptHandle | undefined => {
  try { return window.sessionStorage.getItem(calendarAttemptStorageKey(id)) as CalendarOAuthClientAttemptHandle | null ?? undefined } catch { return undefined }
}
const saveCalendarAttemptHandle = (id: EntityId, handle: CalendarOAuthClientAttemptHandle): void => {
  try { window.sessionStorage.setItem(calendarAttemptStorageKey(id), handle) } catch { /* session restoration is optional */ }
}
const clearCalendarAttemptHandle = (id: EntityId): void => {
  try { window.sessionStorage.removeItem(calendarAttemptStorageKey(id)) } catch { /* session restoration is optional */ }
}

type CatalogResult = {
  readonly generation: number
  readonly value: { readonly bindings: ReadonlyArray<GatekeeperBindingSummary> }
}

type CatalogFailure = {
  readonly generation: number
  readonly error: unknown
}

const bindingLabel = (binding: GatekeeperBindingSummary): string => {
  const mode = binding.mode === "allVisible" ? "All visible calendars" : "Selected calendar"
  let created: string = binding.createdAt
  try {
    created = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(binding.createdAt))
  } catch {
    // The server schema already guarantees an ISO timestamp. Keep the raw value only as a
    // defensive fallback if a future decoder is relaxed.
  }
  const account = binding.accountAlias === undefined ? "Google Calendar account" : binding.accountAlias
  return `${account} · ${mode} · connected ${created}`
}

export function CalendarPanel() {
  const [connect, setConnect] = useState<ConnectState>(() => {
    const attemptHandle = loadCalendarAttemptHandle(workspaceId)
    return attemptHandle === undefined ? { status: "idle" } : { status: "waiting", attemptHandle }
  })
  const [sync, setSync] = useState<SyncState>({ status: "idle" })
  const [localBindingId, setLocalBindingId] = useState<EntityId | undefined>(() => loadCalendarBindingId(workspaceId))
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0)
  const [selectedBindingId, setSelectedBindingId] = useState<EntityId | undefined>()
  const [disconnectingBindingId, setDisconnectingBindingId] = useState<EntityId | undefined>()
  const [disconnectError, setDisconnectError] = useState<string | null>(null)

  // `useEffectQuery` cancels its previous fiber, but a transport can still deliver an already
  // queued result after a refresh. Carry a monotonic generation inside the value/error so an old
  // catalog can never restore a stale binding after an OAuth callback or confirmed disconnect.
  const catalogGeneration = useRef(0)
  const catalogEffect = useMemo(() => {
    const generation = catalogRefreshKey + 1
    catalogGeneration.current = generation
    const request = WorkspaceRpcClient.pipe(
      Effect.flatMap((client) =>
        client.listGatekeeperBindings(new ListGatekeeperBindingsInput({ workspaceId }))
      )
    )
    return request.pipe(
      Effect.map((value) => ({ generation, value } satisfies CatalogResult)),
      Effect.mapError((error) => ({ generation, error } satisfies CatalogFailure))
    )
  }, [catalogRefreshKey])
  const catalogState = useEffectQuery(catalogEffect, [catalogRefreshKey])
  const currentCatalog: ReadonlyArray<GatekeeperBindingSummary> | undefined =
    catalogState.status === "success" && catalogState.value.generation === catalogGeneration.current
      ? catalogState.value.value.bindings
      : undefined
  const catalogFailed =
    catalogState.status === "failure" && catalogState.error.generation === catalogGeneration.current
  const catalogChecking = currentCatalog === undefined && !catalogFailed

  useEffect(() => {
    if (currentCatalog === undefined) return
    setSelectedBindingId((previous) => {
      if (previous !== undefined && currentCatalog.some((binding) => binding.id === previous)) return previous
      if (localBindingId !== undefined && currentCatalog.some((binding) => binding.id === localBindingId)) {
        return localBindingId
      }
      return currentCatalog[0]?.id
    })
  }, [currentCatalog, localBindingId])

  // Same-tab coherence with `CalendarOAuthCallback.tsx` — see `calendar-binding-storage.ts`'s own
  // header comment for the full rationale (`storage` never fires in the writing document itself).
  // The event is only a refresh hint: the server catalog remains the source of truth.
  useEffect(() => {
    const refresh = () => {
      setLocalBindingId(loadCalendarBindingId(workspaceId))
      setCatalogRefreshKey((key) => key + 1)
    }
    window.addEventListener("storage", refresh)
    window.addEventListener(CALENDAR_BINDING_CHANGED_EVENT, refresh)
    return () => {
      window.removeEventListener("storage", refresh)
      window.removeEventListener(CALENDAR_BINDING_CHANGED_EVENT, refresh)
    }
  }, [])

  const retryCatalog = useCallback(() => {
    setDisconnectError(null)
    setCatalogRefreshKey((key) => key + 1)
  }, [])

  useEffect(() => {
    if (connect.status !== "waiting") return
    let cancelled = false
    let timer: number | undefined
    let attempts = 0
    const poll = () => {
      if (cancelled) return
      attempts += 1
      const fiber = runtime.runFork(Effect.exit(WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.getGoogleCalendarConnectionCompletion(
          new GetGoogleCalendarConnectionCompletionInput({ workspaceId, attemptHandle: connect.attemptHandle })
        ))
      )))
      fiber.addObserver((outer) => {
        if (cancelled || !Exit.isSuccess(outer)) return
        const result = outer.value
        if (!Exit.isSuccess(result)) {
          if (attempts < 6) timer = window.setTimeout(poll, 5_000)
          return
        }
        if (result.value.status === "connected") {
          clearCalendarAttemptHandle(workspaceId)
          setCatalogRefreshKey((key) => key + 1)
          setConnect({ status: "idle" })
          return
        }
        if (result.value.status === "failed" || result.value.status === "expired") {
          clearCalendarAttemptHandle(workspaceId)
          setConnect({ status: "failure" })
          return
        }
        if (attempts < 6) timer = window.setTimeout(poll, 5_000)
      })
    }
    poll()
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer) }
  }, [connect])

  const handleConnect = () => {
    setConnect({ status: "busy" })
    let attemptHandle: CalendarOAuthClientAttemptHandle | undefined
    const fiber = runtime.runFork(
      Effect.exit(
        WorkspaceRpcClient.pipe(
          Effect.flatMap((client) => client.beginGoogleCalendarConnection(new BeginGoogleCalendarConnectionInput({
            workspaceId,
            requestId: `web-calendar-${crypto.randomUUID()}`,
            commitMessage: "Connect Google Calendar.",
            attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-calendar" })
          })).pipe(
            Effect.tap((begin) => Effect.sync(() => {
              attemptHandle = begin.attemptHandle
              saveCalendarAttemptHandle(workspaceId, begin.attemptHandle)
            })),
            Effect.flatMap((begin) => client.issueGoogleCalendarLaunch(new IssueGoogleCalendarLaunchInput({ workspaceId, attemptHandle: begin.attemptHandle })))
          ))
        )
      )
    )
    fiber.addObserver((outer) => {
      if (!Exit.isSuccess(outer)) return
      const inner = outer.value
      if (Exit.isSuccess(inner)) {
        if (attemptHandle === undefined) { setConnect({ status: "failure" }); return }
        setConnect({ status: "ready", attemptHandle, fixedLaunchUrl: inner.value.fixedLaunchUrl })
      } else if (!Exit.isInterrupted(inner)) {
        setConnect({ status: "failure" })
        console.error(inner.cause.toString())
      }
    })
  }

  const beginLaunch = () => {
    if (connect.status !== "ready") return
    setConnect({ status: "waiting", attemptHandle: connect.attemptHandle })
    window.location.assign(connect.fixedLaunchUrl)
  }

  const handleDisconnect = (bindingId: EntityId) => {
    if (currentCatalog === undefined || !currentCatalog.some((binding) => binding.id === bindingId)) return
    setDisconnectingBindingId(bindingId)
    setDisconnectError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.disconnectGoogleCalendar(new DisconnectGoogleCalendarInput({ workspaceId, bindingId })))
      )
    )
    fiber.addObserver((exit) => {
      setDisconnectingBindingId(undefined)
      if (Exit.isSuccess(exit)) {
        if (localBindingId === bindingId) {
          clearCalendarBindingId(workspaceId)
          setLocalBindingId(undefined)
        }
        setSelectedBindingId(undefined)
        setConnect({ status: "idle" })
        setCatalogRefreshKey((key) => key + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setDisconnectError(calendarDisconnectFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  const handleSync = (bindingId: EntityId) => {
    if (currentCatalog === undefined || !currentCatalog.some((binding) => binding.id === bindingId)) return
    setSync({ status: "busy", bindingId })
    const fiber = runtime.runFork(
      Effect.exit(
        WorkspaceRpcClient.pipe(
          Effect.flatMap((client) => client.syncGoogleCalendar(new SyncGoogleCalendarInput({ workspaceId, bindingId })))
        )
      )
    )
    fiber.addObserver((outer) => {
      if (!Exit.isSuccess(outer)) return
      const inner = outer.value
      if (Exit.isSuccess(inner)) {
        setSync({ status: "success", bindingId })
        // The server returns an acknowledgement, not the eventual event rows. Ask the sibling
        // projection to re-read its bounded day window so the connection control and schedule
        // stay in one visible workflow.
        window.dispatchEvent(new CustomEvent(CALENDAR_SYNC_TRIGGERED_EVENT))
      } else if (!Exit.isInterrupted(inner)) {
        setSync({ status: "failure", bindingId })
        console.error(inner.cause.toString())
      }
    })
  }

  const confirmedBindings = currentCatalog ?? []
  const selectedBinding = confirmedBindings.find((binding) => binding.id === selectedBindingId)
  const hasConfirmedConnections = currentCatalog !== undefined && confirmedBindings.length > 0
  const hasLocalFallback = catalogFailed && localBindingId !== undefined
  const disconnectBusy = disconnectingBindingId !== undefined
  const syncBusy = sync.status === "busy"
  const selectedSync = sync.status !== "idle" && sync.bindingId === selectedBindingId
    ? sync
    : { status: "idle" as const }

  return (
    <section className="calendar-panel">
      <h2>Google Calendar</h2>

      {hasConfirmedConnections ? (
        <div className="calendar-connected">
          <div className="calendar-connected-status" role="status">
            <span className="calendar-status-dot" aria-hidden="true" />
            <div>
              <strong>Google Calendar connected</strong>
              <p className="calendar-connected-hint">
                {confirmedBindings.length === 1
                  ? "This connection is available to the workspace."
                  : `${confirmedBindings.length} connections are available to the workspace.`}
              </p>
            </div>
          </div>
          {confirmedBindings.length > 1 && (
            <label className="calendar-binding-selector">
              <span>Select a connection</span>
              <select
                value={selectedBindingId ?? ""}
                onChange={(event) => setSelectedBindingId(event.target.value as EntityId)}
                aria-label="Select Google Calendar connection"
                disabled={disconnectBusy}
              >
                {confirmedBindings.map((binding) => (
                  <option key={binding.id} value={binding.id}>
                    {bindingLabel(binding)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selectedBinding !== undefined && (
            <p className="calendar-connected-hint">{bindingLabel(selectedBinding)}</p>
          )}
          {disconnectError !== null && (
            <section
              className="calendar-disconnect-unavailable"
              role="alert"
              aria-label="Calendar disconnection is unconfirmed"
            >
              <p>{disconnectError}</p>
            </section>
          )}
          <div className="calendar-binding-actions">
            <button
              type="button"
              className="calendar-sync-button"
              onClick={() => selectedBinding !== undefined && handleSync(selectedBinding.id)}
              disabled={syncBusy || disconnectBusy || selectedBinding === undefined}
              aria-label="Sync selected Google Calendar"
            >
              {syncBusy ? "Syncing…" : "Sync now"}
            </button>
            <button
              type="button"
              onClick={() => selectedBinding !== undefined && handleDisconnect(selectedBinding.id)}
              disabled={disconnectBusy || syncBusy || selectedBinding === undefined}
            >
              {disconnectBusy ? "Disconnecting…" : "Disconnect selected"}
            </button>
          </div>
          {selectedSync.status === "success" && (
            <p className="calendar-sync-success" role="status">Sync requested. Calendar events will refresh shortly.</p>
          )}
          {selectedSync.status === "failure" && (
            <p className="calendar-sync-failure" role="alert">{calendarSyncFailureMessage}</p>
          )}
          <div className="calendar-connection-actions">
            {(connect.status === "idle" || connect.status === "failure") && (
              <button type="button" onClick={handleConnect}>
                Connect another account
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
                <button type="button" className="calendar-redirect-link" onClick={beginLaunch}>
                  Continue to Google →
                </button>
                <button type="button" onClick={() => {
                  clearCalendarAttemptHandle(workspaceId)
                  setConnect({ status: "idle" })
                }}>
                  Cancel
                </button>
              </div>
            )}
            {connect.status === "busy" && <p className="calendar-connected-hint" role="status">Preparing a secure Google Calendar connection…</p>}
            {connect.status === "waiting" && <p className="calendar-connected-hint" role="status">Waiting for Google Calendar to finish connecting…</p>}
          </div>
        </div>
      ) : catalogChecking ? (
        <div className="calendar-catalog-checking" role="status">
          <strong>Checking calendar connections…</strong>
          <p>Refreshing the workspace’s server-authoritative connection list.</p>
        </div>
      ) : catalogFailed ? (
        <div className="calendar-catalog-unavailable" role="alert">
          <strong>Calendar connections unavailable</strong>
          <p>{hasLocalFallback ? calendarCatalogFallbackMessage : calendarCatalogFailureMessage}</p>
          {hasLocalFallback && (
            <p className="calendar-connected-hint">
              A connection remembered by this browser has not been confirmed by the workspace.
            </p>
          )}
          <button type="button" onClick={retryCatalog}>Retry</button>
        </div>
      ) : (
        <div className="calendar-connect">
          <div className="calendar-connect-copy">
            <strong>Bring your schedule into Today</strong>
            <p>Connect Google Calendar to keep meetings and the daily note in one place.</p>
          </div>
          {(connect.status === "idle" || connect.status === "failure") && (
            <button type="button" onClick={handleConnect}>
              Connect Google Calendar
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
              <button type="button" className="calendar-redirect-link" onClick={beginLaunch}>
                Continue to Google →
              </button>
              <button type="button" onClick={() => {
                clearCalendarAttemptHandle(workspaceId)
                setConnect({ status: "idle" })
              }}>
                Cancel
              </button>
            </div>
          )}
          {connect.status === "busy" && <p className="calendar-connected-hint" role="status">Preparing a secure Google Calendar connection…</p>}
          {connect.status === "waiting" && <p className="calendar-connected-hint" role="status">Waiting for Google Calendar to finish connecting…</p>}
        </div>
      )}
    </section>
  )
}
