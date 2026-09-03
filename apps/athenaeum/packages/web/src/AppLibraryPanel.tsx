import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  DeleteAppInput,
  GetAppCodeInput,
  HumanUiMutationAttribution,
  UpdateAppCodeInput,
  type App,
  type AppCodeKind,
  type EntityId,
  type IsoDateTimeString
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
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

const appCodeSaveFailureMessage =
  "We couldn’t confirm that this code was saved. Your draft is still here. Review the current code before saving again."
type SaveAppCodeIntent = Readonly<{
  appId: EntityId
  kind: AppCodeKind
  code: string
  commitMessage: string
  expectedCurrentVersion: number
  expectedRevision: number
  expectedUpdatedAt: IsoDateTimeString
  requestId: string
}>

function CodeEditor({
  app,
  appId,
  kind,
  onSaved
}: {
  readonly app: App
  readonly appId: EntityId
  readonly kind: AppCodeKind
  readonly onSaved: () => void
}) {
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const [retainedCode, setRetainedCode] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const isSavingRef = useRef(false)
  // Preserve the exact write identity across an ambiguous network failure. A retry with the same
  // code/reason/base replays the ledger receipt; any edited intent gets a fresh claim.
  const intentRef = useRef<SaveAppCodeIntent | undefined>(undefined)
  const retryClaim = useRef<{ appId: EntityId; kind: AppCodeKind; sawLoading: boolean } | undefined>(undefined)
  const codeEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.getAppCode(new GetAppCodeInput({ workspaceId, appId, kind })))
      ),
    [appId, kind]
  )
  const codeState = useEffectQuery(codeEffect, [appId, kind, retryGeneration])

  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (claim.appId !== appId || claim.kind !== kind) {
      retryClaim.current = undefined
      setRetryClaimed(false)
      return
    }
    if (codeState.status === "loading") {
      claim.sawLoading = true
      return
    }
    // The retry-generation render still contains the preceding failure. Keep the presentation
    // claim until this keyed code read visibly loads and then reaches its terminal result.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [appId, codeState.status, kind])

  const retryCode = useCallback(() => {
    if (retryClaim.current !== undefined || codeState.status === "loading") return
    retryClaim.current = { appId, kind, sawLoading: false }
    setRetryClaimed(true)
    setRetryGeneration((generation) => generation + 1)
  }, [appId, codeState.status, kind])

  const isRetryingCode = retryClaimed || codeState.status === "loading"

  useEffect(() => {
    const intent = intentRef.current
    if (intent !== undefined && (intent.appId !== app.id || intent.kind !== kind || intent.expectedRevision !== app.revision || intent.expectedUpdatedAt !== app.updatedAt)) {
      intentRef.current = undefined
    }
  }, [app.id, app.revision, app.updatedAt, kind])

  const knownEmpty = codeState.status === "failure" && codeState.error._tag === "AppCodeVersionNotFound"
  const codeUnavailable = codeState.status === "failure" && !knownEmpty

  // Keep an already-observed code snapshot on screen through a transient reload failure. The
  // component is keyed by app/kind below, so this state can never cross from Client to Server
  // code (or between Apps), and the failure branch keeps it read-only until a real read succeeds.
  useEffect(() => {
    if (codeState.status === "success") setRetainedCode(codeState.value.codeVersion.code)
    else if (knownEmpty) setRetainedCode("")
  }, [codeState, knownEmpty])

  const loadedCode =
    codeState.status === "success"
      ? codeState.value.codeVersion.code
      : knownEmpty
        ? ""
        : retainedCode

  const value = draft ?? loadedCode ?? ""
  const retainedEditorVisible = loadedCode !== undefined || draft !== null
  const editorReadOnly = codeUnavailable || codeState.status === "loading"

  const handleSave = () => {
    if (isSavingRef.current) return
    const commitMessage = reason.trim()
    if (commitMessage.length === 0) return
    const expectedCurrentVersion = kind === "client" ? app.clientCodeVersion : app.serverCodeVersion
    const previous = intentRef.current
    const intent = previous !== undefined && previous.appId === appId && previous.kind === kind && previous.code === value && previous.commitMessage === commitMessage && previous.expectedCurrentVersion === expectedCurrentVersion && previous.expectedRevision === app.revision && previous.expectedUpdatedAt === app.updatedAt
      ? previous
      : { appId, kind, code: value, commitMessage, expectedCurrentVersion, expectedRevision: app.revision, expectedUpdatedAt: app.updatedAt, requestId: crypto.randomUUID() }
    intentRef.current = intent
    isSavingRef.current = true
    setBusy(true)
    setError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.updateAppCode(new UpdateAppCodeInput({ workspaceId, appId: intent.appId, kind: intent.kind, code: intent.code, expectedCurrentVersion: intent.expectedCurrentVersion, expectedRevision: intent.expectedRevision, expectedUpdatedAt: intent.expectedUpdatedAt, requestId: intent.requestId, commitMessage: intent.commitMessage, attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-app-library" }) })))
      )
    )
    fiber.addObserver((exit) => {
      isSavingRef.current = false
      setBusy(false)
      if (Exit.isSuccess(exit)) {
        intentRef.current = undefined
        setDraft(null)
        setReason("")
        onSaved()
      } else if (!Exit.isInterrupted(exit)) {
        setError(appCodeSaveFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <div className="app-library-code-editor">
      {codeState.status === "loading" && (
        <p role="status" aria-live="polite" aria-atomic="true">
          Loading {kind} code…
        </p>
      )}
      {codeUnavailable && (
        <section className="app-code-load-state" role="alert">
          <div>
            <p className="app-code-load-title">{kind === "client" ? "Client" : "Server"} code couldn&rsquo;t be loaded.</p>
            <p>{retainedEditorVisible ? "Current content is kept read-only until this succeeds." : "Retry before editing or saving code."}</p>
          </div>
          <button type="button" onClick={retryCode} disabled={isRetryingCode}>
            {isRetryingCode ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {retainedEditorVisible && (
        <>
          <textarea
            className="app-library-code-textarea"
            spellCheck={false}
            value={value}
            onChange={(event) => { intentRef.current = undefined; setDraft(event.target.value) }}
            placeholder={`No ${kind} code yet — write some and save.`}
            aria-label={`${kind} code`}
            readOnly={editorReadOnly}
            disabled={busy}
          />
          {error !== null && <p className="error" role="alert">{error}</p>}
          <input value={reason} onChange={(event) => { intentRef.current = undefined; setReason(event.target.value) }} placeholder="Why make this change?" aria-label={`Save ${kind} code commit message`} disabled={busy || editorReadOnly} />
          <button type="button" onClick={handleSave} disabled={busy || editorReadOnly || draft === null || reason.trim().length === 0}>
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

const appDeleteFailureMessage =
  "We couldn’t confirm that this app was deleted. It may still be available. Review your apps before taking another action."
type DeleteAppIntent = Readonly<{
  appId: EntityId
  commitMessage: string
  expectedUpdatedAt: IsoDateTimeString
  expectedRevision: number
  expectedClientCodeVersion: number
  expectedServerCodeVersion: number
  requestId: string
}>

export function AppDetail({ app, onChanged }: { readonly app: App; readonly onChanged: () => void }) {
  const [tab, setTab] = useState<AppCodeKind>("client")
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteReason, setDeleteReason] = useState("")
  const isDeletingRef = useRef(false)
  // Keep delete identity stable after an ambiguous response. The confirmation dialog is not a
  // new intent; changing the rationale or observed App revision is.
  const deleteIntentRef = useRef<DeleteAppIntent | undefined>(undefined)

  useEffect(() => {
    const intent = deleteIntentRef.current
    if (intent !== undefined && (intent.appId !== app.id || intent.expectedRevision !== app.revision || intent.expectedUpdatedAt !== app.updatedAt || intent.expectedClientCodeVersion !== app.clientCodeVersion || intent.expectedServerCodeVersion !== app.serverCodeVersion)) {
      deleteIntentRef.current = undefined
    }
  }, [app.id, app.revision, app.updatedAt, app.clientCodeVersion, app.serverCodeVersion])

  const handleDelete = () => {
    if (isDeletingRef.current || deleteReason.trim().length === 0) return
    if (!window.confirm(`Delete "${app.title}"? This cannot be undone.`)) return
    const commitMessage = deleteReason.trim()
    const previous = deleteIntentRef.current
    const intent = previous !== undefined && previous.appId === app.id && previous.commitMessage === commitMessage && previous.expectedRevision === app.revision && previous.expectedUpdatedAt === app.updatedAt && previous.expectedClientCodeVersion === app.clientCodeVersion && previous.expectedServerCodeVersion === app.serverCodeVersion
      ? previous
      : { appId: app.id, commitMessage, expectedUpdatedAt: app.updatedAt, expectedRevision: app.revision, expectedClientCodeVersion: app.clientCodeVersion, expectedServerCodeVersion: app.serverCodeVersion, requestId: crypto.randomUUID() }
    deleteIntentRef.current = intent
    isDeletingRef.current = true
    setDeleteBusy(true)
    setDeleteError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.deleteApp(new DeleteAppInput({ workspaceId, appId: intent.appId, expectedUpdatedAt: intent.expectedUpdatedAt, expectedRevision: intent.expectedRevision, expectedClientCodeVersion: intent.expectedClientCodeVersion, expectedServerCodeVersion: intent.expectedServerCodeVersion, requestId: intent.requestId, commitMessage: intent.commitMessage, attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-app-library" }) }))))
    )
    fiber.addObserver((exit) => {
      isDeletingRef.current = false
      setDeleteBusy(false)
      if (Exit.isSuccess(exit)) {
        deleteIntentRef.current = undefined
        onChanged()
      } else if (!Exit.isInterrupted(exit)) {
        setDeleteError(appDeleteFailureMessage)
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
        <input value={deleteReason} onChange={(event) => { deleteIntentRef.current = undefined; setDeleteReason(event.target.value) }} placeholder="Why delete?" aria-label="Delete App commit message" disabled={deleteBusy} />
        <button type="button" className="app-library-delete-button" onClick={handleDelete} disabled={deleteBusy || deleteReason.trim().length === 0}>
          {deleteBusy ? "Deleting…" : "Delete"}
        </button>
      </header>
      {deleteError !== null && <p className="error" role="alert">{deleteError}</p>}

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

      <CodeEditor key={`${app.id}:${tab}`} app={app} appId={app.id} kind={tab} onSaved={onChanged} />

      {tab === "client" && (
        <>
          <h4 className="app-library-preview-heading">Preview</h4>
          <AppPreview appId={app.id} clientCodeVersion={app.clientCodeVersion} />
        </>
      )}
    </div>
  )
}
