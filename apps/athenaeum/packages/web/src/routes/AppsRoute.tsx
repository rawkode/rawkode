import { useMemo, useState } from "react"
import * as Effect from "effect/Effect"
import { GetAppInput, type EntityId } from "@athenaeum/domain"
import { WorkspaceRpcClient } from "../rpc-client.js"
import { useEffectQuery } from "../use-effect-query.js"
import { workspaceId } from "../workspace-id.js"
import { formatDomainError } from "../format-domain-error.js"
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
  const appEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.getApp(new GetAppInput({ workspaceId, appId })))),
    [appId]
  )
  const appState = useEffectQuery(appEffect, [appId, refreshKey])

  return (
    <div className="app-edit-view">
      <header className="app-launch-header">
        <button type="button" className="app-launch-back" onClick={onBack}>
          ← Apps
        </button>
      </header>

      {appState.status === "loading" && <p>Loading…</p>}
      {appState.status === "failure" && appState.error._tag === "AppNotFound" && (
        <p className="app-library-empty">This App was deleted.</p>
      )}
      {appState.status === "failure" && appState.error._tag !== "AppNotFound" && (
        <p className="error">{formatDomainError(appState.error)}</p>
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
        <span className="route-heading-kicker">Sandboxed</span>
        <h1>App Library</h1>
        <p>Agent-authored Apps — each runs in a genuinely sandboxed Worker Loader isolate.</p>
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
