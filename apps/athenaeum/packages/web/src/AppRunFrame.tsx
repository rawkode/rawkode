import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import * as Effect from "effect/Effect"
import { MintAppRunCredentialInput, type EntityId } from "@athenaeum/domain"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { buildAppSandboxBootstrapScript } from "./app-sandbox-bootstrap.js"
import { buildAppSandboxDocument } from "./app-sandbox-document.js"

// Extracted from `AppLibraryPanel.tsx`'s original `useAppRunCredential`/`AppPreview` pair so the
// launcher's full-view `AppLaunchView.tsx` and the code editor's inline preview can share the
// EXACT SAME sandbox-construction logic rather than two copies that could silently drift apart —
// the security-relevant part (mint a narrowly-scoped run credential, never the parent page's own
// session credential; `sandbox="allow-scripts"` only, no `allow-same-origin`) lives in exactly one
// place now. See `AppLibraryPanel.tsx`'s original header comment (still present there) for the
// full "why" — repeated in brief here since this is now the file that actually implements it.
//
// Security recap, for a reader who lands on this file directly: the returned `<iframe>`'s document
// gets an opaque, unique origin (no `allow-same-origin`) so it can never read this parent page's
// DOM/`localStorage`/`document.cookie`/RPC session no matter what its own script does. It never
// receives the user's real session Bearer token — only a fresh, App-and-workspace-scoped
// `athenaeum-app-run-v1` credential (`mintAppRunCredential`), attached to the `client.js` load via
// `?token=` and to the App's own same-document-relative `fetch()` calls via the inline bootstrap
// script (`app-sandbox-bootstrap.ts`), which patches `window.fetch` INSIDE the sandboxed document
// itself — nothing this parent component does reaches into the iframe after it's created.

/**
 * Mints (or re-mints, whenever `appId` or an explicit retry changes) the App-run credential the
 * sandboxed iframe needs.
 * Deliberately NOT re-minted on every `clientCodeVersion` bump — see this file's header comment on
 * `AppRunFrame`'s `key` for why one still-valid mint keeps authorizing across code edits.
 */
export function useAppRunCredential(appId: EntityId, retryGeneration = 0) {
  const credentialEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.mintAppRunCredential(new MintAppRunCredentialInput({ workspaceId, appId })))
      ),
    [appId]
  )
  return useEffectQuery(credentialEffect, [appId, retryGeneration])
}

const subscribeToHostTheme = (onChange: () => void): (() => void) => {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => undefined
  const root = document.documentElement
  if (!root) return () => undefined
  const observer = new MutationObserver(onChange)
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] })
  return () => observer.disconnect()
}

const readHostTheme = (): "dark" | "paper" =>
  typeof document !== "undefined" && document.documentElement?.dataset.theme === "paper" ? "paper" : "dark"

/** Re-render running Apps when the shell's persisted Paper/Dark choice changes. */
const useHostTheme = (): "dark" | "paper" => useSyncExternalStore(subscribeToHostTheme, readHostTheme, () => "dark")

/**
 * The sandboxed iframe itself. `clientCodeVersion === 0` (no client code written yet) renders a
 * placeholder rather than an iframe with nothing to load — mirrors the original `AppPreview`'s
 * behavior exactly. `className` lets callers style the frame differently (a small preview pane in
 * the code editor vs. a full-bleed launch surface) without duplicating the sandbox wiring. The
 * document shell is rebuilt when the host theme changes, so an already-running App follows the
 * workspace's Paper/Dark choice without receiving access to the parent document.
 */
export function AppRunFrame({
  appId,
  clientCodeVersion,
  className
}: {
  readonly appId: EntityId
  readonly clientCodeVersion: number
  readonly className: string
}) {
  const [credentialRetryGeneration, setCredentialRetryGeneration] = useState(0)
  const credentialState = useAppRunCredential(appId, credentialRetryGeneration)
  const credentialRetryClaim = useRef<{ readonly appId: EntityId; sawLoading: boolean } | undefined>(undefined)
  const [credentialRetryClaimed, setCredentialRetryClaimed] = useState(false)
  const theme = useHostTheme()

  useEffect(() => {
    const claim = credentialRetryClaim.current
    if (claim === undefined) return
    if (claim.appId !== appId) {
      credentialRetryClaim.current = undefined
      setCredentialRetryClaimed(false)
      return
    }
    if (credentialState.status === "loading") {
      claim.sawLoading = true
      return
    }
    // A dependency change first renders the previous settled query result. Release only after
    // this claimed generation has published loading and then reached its next terminal state.
    if (!claim.sawLoading) return
    credentialRetryClaim.current = undefined
    setCredentialRetryClaimed(false)
  }, [appId, credentialState.status])

  const retryCredential = useCallback(() => {
    if (credentialRetryClaim.current !== undefined || credentialState.status === "loading") return
    credentialRetryClaim.current = { appId, sawLoading: false }
    setCredentialRetryClaimed(true)
    setCredentialRetryGeneration((generation) => generation + 1)
  }, [appId, credentialState.status])

  const isRetryingCredential = credentialRetryClaimed || credentialState.status === "loading"

  if (clientCodeVersion === 0) {
    return <p className="app-library-empty">No client code yet — write and save some to run it here.</p>
  }
  if (credentialState.status === "loading") {
    return (
      <p className="app-library-empty" role="status" aria-live="polite" aria-atomic="true">
        Preparing sandbox…
      </p>
    )
  }
  if (credentialState.status === "failure") {
    return (
      <section className="app-run-frame-state app-run-frame-failure" role="alert">
        <div>
          <p className="app-run-frame-state-title">This app couldn&rsquo;t start.</p>
          <p>Its code and workspace are unchanged.</p>
        </div>
        <button type="button" onClick={retryCredential} disabled={isRetryingCredential}>
          {isRetryingCredential ? "Retrying…" : "Retry"}
        </button>
      </section>
    )
  }

  const token = credentialState.value.credential
  const runBaseUrl = `/api/workspace/${workspaceId}/apps/${appId}/run`
  // Cache-bust on every code version so the iframe always reflects current mainline code rather
  // than a stale cached script; the credential rides as `?token=` — never this page's own session
  // credential (see this file's header comment).
  const clientJsUrl = `/api/workspace/${workspaceId}/apps/${appId}/client.js?v=${clientCodeVersion}&token=${encodeURIComponent(token)}`
  const bootstrapScript = buildAppSandboxBootstrapScript(runBaseUrl, token)
  const srcDoc = buildAppSandboxDocument({ clientJsUrl, bootstrapScript, theme })
  return (
    <iframe
      // Remounts on every code-version/credential/theme change so the PREVIEWED CODE and its
      // document contract are always current even though the credential underneath it isn't
      // re-minted every render.
      key={`${clientCodeVersion}:${theme}:${token}`}
      className={className}
      title="App"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
    />
  )
}
