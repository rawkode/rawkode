import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Effect from "effect/Effect"
import { GetAppInput, type EntityId } from "@athenaeum/domain"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { AppRunFrame } from "./AppRunFrame.js"

// Web stage, item 2: "An app launch view: clicking an app opens it, rendering its client.js in a
// properly sandboxed <iframe>... with the postMessage bridge to its server wired up." The "bridge"
// here is `AppRunFrame.tsx`'s `window.fetch` rewrite (`app-sandbox-bootstrap.ts`), not a literal
// `postMessage` handshake — see `AppRunFrame.tsx`'s own header comment for why: the sandboxed
// document's script calls its OWN `fetch("/some/path")` exactly as if it had a normal backend, and
// the bootstrap script (loaded into the SAME document, before the App's own code) transparently
// retargets that call to this App's credentialed `/run` route. This is a strictly narrower channel
// than `postMessage` would be (no message listener inside the sandboxed document at all, so
// nothing the App's own client code does can accidentally widen it), and reuses the exact
// mechanism already proven end-to-end by the backend stage's sandbox-security tests.
//
// The iframe itself is genuinely sandboxed — confirmed here, not just asserted: `AppRunFrame.tsx`
// renders `sandbox="allow-scripts"` ONLY (no `allow-same-origin` in the string, and no other
// token widens same-origin access), so this document always gets a unique opaque origin. That
// means, structurally, it can never read `document.cookie`, `window.parent`'s DOM, or
// `localStorage` for this page's real origin, no matter what code the App itself runs.
export function AppLaunchView({
  appId,
  onBack,
  onEdit
}: {
  readonly appId: EntityId
  readonly onBack: () => void
  readonly onEdit: () => void
}) {
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ appId: EntityId; sawLoading: boolean } | undefined>(undefined)
  const appEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.getApp(new GetAppInput({ workspaceId, appId })))),
    [appId]
  )
  const appState = useEffectQuery(appEffect, [appId, retryGeneration])
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
    // The retry-generation render still contains the preceding failure. Keep the presentation
    // claim until this app lookup visibly loads and then reaches its terminal result.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [appId, appState.status])
  const retryApp = useCallback(() => {
    if (retryClaim.current !== undefined || appState.status === "loading") return
    retryClaim.current = { appId, sawLoading: false }
    setRetryClaimed(true)
    setRetryGeneration((generation) => generation + 1)
  }, [appId, appState.status])
  const isRetryingApp = retryClaimed || appState.status === "loading"
  const appUnavailable = appState.status === "failure" && appState.error._tag !== "AppNotFound"

  return (
    <div className="app-launch-view">
      <header className="app-launch-header">
        <button type="button" className="app-launch-back" onClick={onBack}>
          ← Apps
        </button>
        {appState.status === "success" && (
          <>
            <span className="app-launch-icon" aria-hidden="true">
              {appState.value.app.icon}
            </span>
            <h2 className="app-launch-title">{appState.value.app.title}</h2>
          </>
        )}
        {appState.status === "success" && (
          <button type="button" className="app-launch-edit" onClick={onEdit}>
            Edit code
          </button>
        )}
      </header>

      {appState.status === "loading" && (
        <p role="status" aria-live="polite" aria-atomic="true">
          Loading…
        </p>
      )}
      {appState.status === "failure" && appState.error._tag === "AppNotFound" && (
        <section className="app-launch-empty" role="alert">
          <p>This App no longer exists.</p>
        </section>
      )}
      {appUnavailable && (
        <section className="app-launch-load-state" role="alert">
          <div>
            <p className="app-launch-load-title">This app couldn&rsquo;t be loaded.</p>
            <p>Nothing was changed.</p>
          </div>
          <button type="button" onClick={retryApp} disabled={isRetryingApp}>
            {isRetryingApp ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}

      {appState.status === "success" && appState.value.app.clientCodeVersion === 0 && (
        <div className="app-launch-empty">
          <p>This App has no client code yet.</p>
          <button type="button" onClick={onEdit}>
            Write some code
          </button>
        </div>
      )}

      {appState.status === "success" && appState.value.app.clientCodeVersion > 0 && (
        <AppRunFrame
          appId={appId}
          clientCodeVersion={appState.value.app.clientCodeVersion}
          className="app-launch-frame"
        />
      )}
    </div>
  )
}
