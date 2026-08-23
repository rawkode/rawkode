import { useMemo, useState } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  DeleteAppInput,
  GetAppCodeInput,
  UpdateAppCodeInput,
  type App,
  type AppCodeKind,
  type EntityId
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { formatDomainError } from "./format-domain-error.js"
import { AppRunFrame } from "./AppRunFrame.js"

// App Library editor — the direct/mainline path (`updateAppCode`/`getAppCode`/`deleteApp`,
// app-rpc.ts) a human editing an App's code from the web UI exercises directly, never through an
// agent chat's `chatId`-scoped pending mechanism (that path is `ChatPanel.tsx`'s
// `CreateAppTool`/`UpdateAppCodeTool`, unaffected by this component).
//
// Launcher-stage note: this file used to also own the App list + create-form (the whole
// `AppLibraryPanel`) — that responsibility has moved to `AppLauncherGrid.tsx` (the new "like on
// iPhone" icon-grid `/apps` view, per this stage's own brief), which is a better fit for
// launching/creating and calls `createApp` itself. `AppDetail` below (exported, used by
// `routes/AppsRoute.tsx`'s edit view) is unchanged in behavior — it just no longer needs to live
// inside a list+create wrapper to be reachable.
//
// Security note (this stage's dominant concern, per the App Library's own domain header comment
// in `app.ts`): the "Preview" pane below renders an App's `client` code inside an `<iframe>` with
// `sandbox="allow-scripts"` ONLY — deliberately omitting `allow-same-origin`, so the iframe's
// document is forced to an opaque, unique origin no matter what path its script fetches from. That
// origin can never read this parent page's DOM, `localStorage`, `document.cookie`, or the
// workspace's own RPC session — it can only run the script tag's own code, which itself talks
// exclusively to its own sandboxed `server` code via the backend's `/apps/:appId/run` route (never
// this page's own `WorkspaceRpcClient`). The iframe's `srcDoc` loads the App's *current mainline*
// `client.js` from the real, already-implemented `GET /api/workspace/:workspaceId/apps/:appId/
// client.js` route (`workspace-durable-object.ts`'s `#serveAppClientCode`) — genuine served code,
// not a mock.
//
// **Adversarial-review fix**: on a GOVERNED workspace (every real signed-in user's default
// workspace), `client.js` and `/run` are gated behind `requireRoleForGovernedWorkspace` exactly
// like every other App read — so the sandboxed iframe above needs SOME credential to load/run at
// all, and it must never be the user's own real session Bearer token (that would let any
// agent-authored App impersonate its creator against every OTHER RPC method too). `AppPreview`
// below mints a fresh, narrowly-scoped `athenaeum-app-run-v1` credential
// (`mintAppRunCredential`/`app-run-credential.ts`) — naming exactly this `{workspaceId, appId}`,
// nothing else — and hands it ONLY to the sandboxed document itself: once as the `client.js`
// `<script src>`'s own `?token=`, and once via an inline bootstrap `<script>`
// (`app-sandbox-bootstrap.ts`) that patches the sandboxed document's OWN `window.fetch` to attach
// the same token to the App's own `/run` calls. The parent page's `WorkspaceRpcClient`/session
// credential never crosses into the iframe at all.

function CodeEditor({
  appId,
  kind,
  onSaved
}: {
  readonly appId: EntityId
  readonly kind: AppCodeKind
  readonly onSaved: () => void
}) {
  const codeEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.getAppCode(new GetAppCodeInput({ workspaceId, appId, kind })))
      ),
    [appId, kind]
  )
  const codeState = useEffectQuery(codeEffect, [appId, kind])

  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadedCode =
    codeState.status === "success"
      ? codeState.value.codeVersion.code
      : codeState.status === "failure" && codeState.error._tag === "AppCodeVersionNotFound"
        ? ""
        : undefined

  const value = draft ?? loadedCode ?? ""

  const handleSave = () => {
    setBusy(true)
    setError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.updateAppCode(new UpdateAppCodeInput({ workspaceId, appId, kind, code: value })))
      )
    )
    fiber.addObserver((exit) => {
      setBusy(false)
      if (Exit.isSuccess(exit)) {
        setDraft(null)
        onSaved()
      } else if (!Exit.isInterrupted(exit)) {
        setError("Failed to save code")
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <div className="app-library-code-editor">
      {codeState.status === "loading" && <p>Loading {kind} code…</p>}
      {codeState.status === "failure" && codeState.error._tag !== "AppCodeVersionNotFound" && (
        <p className="error">{formatDomainError(codeState.error)}</p>
      )}
      {codeState.status !== "loading" && (
        <>
          <textarea
            className="app-library-code-textarea"
            spellCheck={false}
            value={value}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`No ${kind} code yet — write some and save.`}
            aria-label={`${kind} code`}
            disabled={busy}
          />
          {error !== null && <p className="error">{error}</p>}
          <button type="button" onClick={handleSave} disabled={busy || draft === null}>
            {busy ? "Saving…" : `Save ${kind} code`}
          </button>
        </>
      )}
    </div>
  )
}

function AppPreview({ appId, clientCodeVersion }: { readonly appId: EntityId; readonly clientCodeVersion: number }) {
  return <AppRunFrame appId={appId} clientCodeVersion={clientCodeVersion} className="app-library-preview-frame" />
}

export function AppDetail({ app, onChanged }: { readonly app: App; readonly onChanged: () => void }) {
  const [tab, setTab] = useState<AppCodeKind>("client")
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleDelete = () => {
    if (!window.confirm(`Delete "${app.title}"? This cannot be undone.`)) return
    setDeleteBusy(true)
    setDeleteError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.deleteApp(new DeleteAppInput({ workspaceId, appId: app.id }))))
    )
    fiber.addObserver((exit) => {
      setDeleteBusy(false)
      if (Exit.isSuccess(exit)) {
        onChanged()
      } else if (!Exit.isInterrupted(exit)) {
        setDeleteError("Failed to delete app")
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <div className="app-library-detail">
      <header className="app-library-detail-header">
        <span className="app-library-detail-icon" aria-hidden="true">
          {app.icon}
        </span>
        <div>
          <h3>{app.title}</h3>
          <p className="app-library-detail-meta">
            server v{app.serverCodeVersion} · client v{app.clientCodeVersion}
          </p>
        </div>
        <button type="button" className="app-library-delete-button" onClick={handleDelete} disabled={deleteBusy}>
          {deleteBusy ? "Deleting…" : "Delete"}
        </button>
      </header>
      {deleteError !== null && <p className="error">{deleteError}</p>}

      <div className="app-library-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "client"}
          className={`app-library-tab${tab === "client" ? " app-library-tab-active" : ""}`}
          onClick={() => setTab("client")}
        >
          Client
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "server"}
          className={`app-library-tab${tab === "server" ? " app-library-tab-active" : ""}`}
          onClick={() => setTab("server")}
        >
          Server
        </button>
      </div>

      <CodeEditor appId={app.id} kind={tab} onSaved={onChanged} />

      {tab === "client" && (
        <>
          <h4 className="app-library-preview-heading">Preview</h4>
          <AppPreview appId={app.id} clientCodeVersion={app.clientCodeVersion} />
        </>
      )}
    </div>
  )
}
