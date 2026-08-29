import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Effect from "effect/Effect"
import { GetAppInput, type EntityId } from "@athenaeum/domain"
import { WorkspaceRpcClient } from "../rpc-client.js"
import { useEffectQuery } from "../use-effect-query.js"
import { workspaceId } from "../workspace-id.js"
import { AppLauncherGrid } from "../AppLauncherGrid.js"
import { AppLaunchView } from "../AppLaunchView.js"
import { AppDetail } from "../AppLibraryPanel.js"

// Web stage: App Library route. Three internal views, switched by plain component state rather
// than a nested react-router route (`Meetings`/`Workouts` already established this codebase's own
// "list+detail lives in one component's state" convention — no route in this app currently
// URL-addresses an individual entity, so introducing the first one here for Apps alone would be an
// inconsistency, not an improvement):
//
//   - "grid" (default): `AppLauncherGrid` — the "like on iPhone" icon grid this stage's own brief
//     asks for. Tapping a tile launches the app.
//   - "launch": `AppLaunchView` — the app actually running, client code inside a genuinely
//     sandboxed `<iframe>` (`AppRunFrame.tsx`), talking to its own sandboxed server code.
//   - "edit": `AppDetail` (from `AppLibraryPanel.tsx`, unchanged — the code editor + tabs + inline
//     preview this codebase already had and tested) — reached via the launch view's "Edit code"
//     button or straight from a fresh "+ New App" creation, the iPhone-equivalent of long-press.
type View = { readonly kind: "grid" } | { readonly kind: "launch"; readonly appId: EntityId } | { readonly kind: "edit"; readonly appId: EntityId }

function EditView({ appId, onBack }: { readonly appId: EntityId; readonly onBack: () => void }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ appId: EntityId; sawLoading: boolean } | undefined>(undefined)
  const appEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.getApp(new GetAppInput({ workspaceId, appId })))),
    [appId]
  )
  const appState = useEffectQuery(appEffect, [appId, refreshKey])
  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (claim.appId !== appId) {
      retryClaim.current = undefined
      setRetryClaimed(false)
      return
    }
    if (appState.status === "loading") {
      claim.sawLoading = true
      return
    }
    // The retry-key render still contains the prior failure. Wait until this query visibly loads,
    // then release the presentation claim only after it reaches a terminal state.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [appId, appState.status])
  const retryApp = useCallback(() => {
    if (retryClaim.current !== undefined || appState.status === "loading") return
    retryClaim.current = { appId, sawLoading: false }
    setRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [appId, appState.status])
  const isRetryingApp = retryClaimed || appState.status === "loading"
  const appUnavailable = appState.status === "failure" && appState.error._tag !== "AppNotFound"

  return (
    <div className="app-edit-view">
      <header className="app-launch-header">
        <button type="button" className="app-launch-back" onClick={onBack}>
          ← Apps
        </button>
      </header>

      {appState.status === "loading" && (
        <p role="status" aria-live="polite" aria-atomic="true">
          Loading…
        </p>
      )}
      {appState.status === "failure" && appState.error._tag === "AppNotFound" && (
        <section className="app-launch-empty" role="alert">
          <p>This App was deleted.</p>
        </section>
      )}
      {appUnavailable && (
        <section className="app-launch-load-state" role="alert">
          <div>
            <p className="app-launch-load-title">This app couldn&rsquo;t be loaded.</p>
            <p>Nothing was changed. Retry to check it again.</p>
          </div>
          <button type="button" onClick={retryApp} disabled={isRetryingApp}>
            {isRetryingApp ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {appState.status === "success" && (
        <AppDetail app={appState.value.app} onChanged={() => setRefreshKey((k) => k + 1)} />
      )}
    </div>
  )
}

export function AppsRoute() {
  const [view, setView] = useState<View>({ kind: "grid" })

  return (
    <div className="route-view route-view--light">
      <header className="route-heading">
        <span className="route-heading-kicker">Tools for the moment</span>
        <h1>App Library</h1>
        <p>Build small tools for the work in front of you, then keep them around when they become useful.</p>
      </header>

      {view.kind === "grid" && (
        <AppLauncherGrid
          onLaunch={(appId) => setView({ kind: "launch", appId })}
          onEdit={(appId) => setView({ kind: "edit", appId })}
        />
      )}

      {view.kind === "launch" && (
        <AppLaunchView
          appId={view.appId}
          onBack={() => setView({ kind: "grid" })}
          onEdit={() => setView({ kind: "edit", appId: view.appId })}
        />
      )}

      {view.kind === "edit" && <EditView appId={view.appId} onBack={() => setView({ kind: "grid" })} />}
    </div>
  )
}
