import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { CreateAppInput, GetAppInput, HumanUiMutationAttribution, ListAppsInput, UpdateAppCodeInput, type App, type AppIcon, type EntityId } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { EmptyState } from "./EmptyState.js"

// Web stage: "an icon-grid App Library (per David's explicit 'like on iPhone' reference — a grid
// of app icons/tiles, each launchable)." This is that grid — the PRIMARY `/apps` view
// (`routes/AppsRoute.tsx` mounts it at the index state). Tapping a tile launches the App (fires
// `onLaunch`, handled by `AppsRoute.tsx` switching to `AppLaunchView`) rather than editing it —
// exactly like tapping an iPhone home-screen icon opens the app, not a code editor. Editing an
// App's code is a deliberately secondary action, reached from the launch view's own "Edit code"
// button (`AppLaunchView.tsx`), the iPhone-equivalent of "long-press to edit."
//
// The "+" tile creates a new, codeless App (mainline `createApp`, `app-rpc.ts` — never a chat/
// pending path) and immediately opens it in the EDIT view (`onCreated`) since a fresh App has
// nothing to launch yet.

/** The literal, hand-written example app this stage's own verification requirement calls for:
 *  "test it via ModelClientScripted feeding in REAL hand-written example app code (e.g. a simple
 *  counter or todo-list app)". A previous stage already proved this exact server+client pair
 *  through the sandboxed runtime via `AppsService`/Worker Loader tests
 *  (`packages/backend/test/app-library.test.ts`'s `COUNTER_SERVER_CODE`); this dev-only seed
 *  writes the SAME server logic through the real mainline `createApp`/`updateAppCode` RPCs so this
 *  stage's own real-browser verification (click "+1", see the count round-trip through the actual
 *  sandboxed Worker Loader isolate) doesn't require a live LLM turn to produce it — see this
 *  file's own "Dev-only test app" section below for why the CLIENT code here is written as plain
 *  JS (not the backend test's own HTML-shaped `COUNTER_CLIENT_CODE`, which cannot actually execute
 *  as a classic `<script src>`, the only way client code is ever loaded in a real browser). */
const DEV_COUNTER_SERVER_CODE = `
let count = 0
export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/increment") count++
    return new Response(JSON.stringify({ count }), { headers: { "content-type": "application/json" } })
  }
}
`.trim()

/** Plain JS, not HTML — `client.js` is served with `Content-Type: text/javascript` and always
 *  loaded via a classic `<script src="...">` tag (`AppRunFrame.tsx`), so its content must itself
 *  be valid top-level JavaScript that manipulates the sandboxed document's `#app-root`, not a full
 *  `<!doctype html>...` document. Calls `fetch("/increment")` with a bare relative path exactly
 *  like the backend test's own example — `app-sandbox-bootstrap.ts`'s inline bootstrap script
 *  (loaded before this one, same `srcDoc`) transparently rewrites that to the App's own
 *  credentialed `/run/increment` route, so this code never needs to know its own workspaceId/
 *  appId/token. */
const DEV_COUNTER_CLIENT_CODE = `
var root = document.getElementById("app-root");
var button = document.createElement("button");
button.id = "inc";
button.textContent = "+1";
var span = document.createElement("span");
span.id = "count";
span.textContent = "0";
span.style.marginLeft = "0.75rem";
root.appendChild(button);
root.appendChild(span);
button.addEventListener("click", function () {
  fetch("/increment")
    .then(function (res) { return res.json(); })
    .then(function (data) { span.textContent = String(data.count); });
});
`.trim()

type DevSeedIntent = Readonly<{
  appId: EntityId
  createRequestId: string
  serverRequestId: string
  clientRequestId: string
}>

const appCreationFailureMessage =
  "We couldn’t confirm that this app was created. Its title and icon are still here. Review your apps before taking another action."
const appAttribution = () => new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-app-library" })
type CreateAppIntent = Readonly<{ id: EntityId; requestId: string; title: string; icon: string; commitMessage: string }>

function CreateAppForm({
  openRequest,
  onCreated
}: {
  readonly openRequest: number
  readonly onCreated: (appId: EntityId) => void
}) {
  const [open, setOpen] = useState(false)
  const handledOpenRequest = useRef(openRequest)
  const [title, setTitle] = useState("")
  const [icon, setIcon] = useState("🧩")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isCreatingRef = useRef(false)
  // A network response can be lost after the DO commits. Keep the exact intent identity across a
  // retry so the ledger replays that commit instead of creating a second App. Editing any intent
  // field below deliberately retires the claim and starts a new request identity on submit.
  const intentRef = useRef<CreateAppIntent | undefined>(undefined)

  useEffect(() => {
    if (openRequest === handledOpenRequest.current) return
    handledOpenRequest.current = openRequest
    setOpen(true)
  }, [openRequest])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    const trimmedIcon = icon.trim()
    const commitMessage = reason.trim()
    if (trimmedTitle.length === 0 || trimmedIcon.length === 0 || commitMessage.length === 0) return
    if (isCreatingRef.current) return
    const previous = intentRef.current
    const intent = previous !== undefined && previous.title === trimmedTitle && previous.icon === trimmedIcon && previous.commitMessage === commitMessage
      ? previous
      : { id: crypto.randomUUID() as EntityId, requestId: crypto.randomUUID(), title: trimmedTitle, icon: trimmedIcon, commitMessage }
    intentRef.current = intent
    isCreatingRef.current = true
    setBusy(true)
    setError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.createApp(new CreateAppInput({ workspaceId, title: intent.title, icon: intent.icon as AppIcon, id: intent.id, requestId: intent.requestId, commitMessage: intent.commitMessage, attribution: appAttribution() }))
        )
      )
    )
    fiber.addObserver((exit) => {
      isCreatingRef.current = false
      setBusy(false)
      if (Exit.isSuccess(exit)) {
        intentRef.current = undefined
        setOpen(false)
        setTitle("")
        setIcon("🧩")
        setReason("")
        onCreated(exit.value.app.id)
      } else if (!Exit.isInterrupted(exit)) {
        setError(appCreationFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  if (!open) {
    return (
      <button type="button" className="app-tile app-tile-new" onClick={() => setOpen(true)}>
        <span className="app-tile-icon" aria-hidden="true">
          +
        </span>
        <span className="app-tile-title">New App</span>
      </button>
    )
  }

  return (
    <form className="app-create-form" onSubmit={handleSubmit}>
      <input
        value={icon}
        onChange={(event) => { intentRef.current = undefined; setIcon(event.target.value) }}
        placeholder="🧩"
        aria-label="App icon"
        maxLength={32}
        disabled={busy}
        autoFocus
      />
      <input value={reason} onChange={(event) => { intentRef.current = undefined; setReason(event.target.value) }} placeholder="Why create this app?" aria-label="Create commit message" disabled={busy} />
      <input
        value={title}
        onChange={(event) => { intentRef.current = undefined; setTitle(event.target.value) }}
        placeholder="App title"
        aria-label="App title"
        disabled={busy}
      />
      <div className="app-create-form-actions">
        <button type="submit" disabled={busy || title.trim().length === 0 || icon.trim().length === 0 || reason.trim().length === 0}>
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" className="app-create-form-cancel" onClick={() => { intentRef.current = undefined; setOpen(false) }} disabled={busy}>
          Cancel
        </button>
      </div>
      {error !== null && <p className="error" role="alert">{error}</p>}
    </form>
  )
}

/**
 * Dev-only, per this stage's own hard constraint ("no real LLM API key exists... wire a dev-only
 * way to create a test app for verification purposes... so this can be verified end-to-end in a
 * real browser without a live agent turn"). Gated on `import.meta.env.DEV` (Vite's own dev/build
 * distinction — the same mechanism the rest of this codebase already treats as the "not shipped to
 * a real deployment build" boundary), so a production `vite build` never includes this affordance
 * at all, not merely hides it. Writes through the exact same mainline `createApp`/`updateAppCode`
 * RPCs the "+ New App" form above uses — no backend/domain changes, no new dev-only HTTP route,
 * and no bypass of `requireRoleForGovernedWorkspace` (the signed-in dev user's own "build" role on
 * their own workspace already authorizes every call this makes, identically to typing the same
 * code into the editor by hand). See this file's own header comment for why the code seeded here
 * is real, previously-verified-through-the-sandbox logic, not a placeholder.
 */
function DevSeedTestAppButton({ onSeeded }: { readonly onSeeded: (appId: EntityId) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The seed performs three ledgered writes. If a response is lost between any two, retain all
  // request identities and resume from the verified App row instead of replaying an earlier
  // receipt after later lifecycle revisions have advanced it.
  const intentRef = useRef<DevSeedIntent | undefined>(undefined)

  const handleClick = () => {
    const intent = intentRef.current ?? {
      appId: crypto.randomUUID() as EntityId,
      createRequestId: crypto.randomUUID(),
      serverRequestId: crypto.randomUUID(),
      clientRequestId: crypto.randomUUID()
    }
    intentRef.current = intent
    setBusy(true)
    setError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          Effect.gen(function* () {
            const existing = yield* client.getApp(new GetAppInput({ workspaceId, appId: intent.appId })).pipe(
              Effect.catchTag("AppNotFound", () => Effect.succeed(undefined))
            )
            const created = existing ?? (yield* client.createApp(
              new CreateAppInput({ workspaceId, title: "Counter (dev seed)", icon: "🔢" as AppIcon, id: intent.appId, requestId: intent.createRequestId, commitMessage: "Seed the verified counter app.", attribution: appAttribution() })
            ))
            const server = created.app.serverCodeVersion > 0
              ? created
              : yield* client.updateAppCode(
                new UpdateAppCodeInput({ workspaceId, appId: created.app.id, kind: "server", code: DEV_COUNTER_SERVER_CODE, expectedCurrentVersion: created.app.serverCodeVersion, expectedRevision: created.app.revision, expectedUpdatedAt: created.app.updatedAt, requestId: intent.serverRequestId, commitMessage: "Add the counter server implementation.", attribution: appAttribution() })
              )
            if (server.app.clientCodeVersion === 0) {
              yield* client.updateAppCode(
                new UpdateAppCodeInput({ workspaceId, appId: server.app.id, kind: "client", code: DEV_COUNTER_CLIENT_CODE, expectedCurrentVersion: server.app.clientCodeVersion, expectedRevision: server.app.revision, expectedUpdatedAt: server.app.updatedAt, requestId: intent.clientRequestId, commitMessage: "Add the counter client implementation.", attribution: appAttribution() })
              )
            }
            return server.app.id
          })
        )
      )
    )
    fiber.addObserver((exit) => {
      setBusy(false)
      if (Exit.isSuccess(exit)) {
        intentRef.current = undefined
        onSeeded(exit.value)
      } else if (!Exit.isInterrupted(exit)) {
        setError("Failed to seed test app")
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <div className="app-dev-seed">
      <button type="button" className="app-dev-seed-button" onClick={handleClick} disabled={busy}>
        {busy ? "Seeding…" : "Seed test Counter app (dev)"}
      </button>
      <p className="app-dev-seed-hint">
        No live LLM is configured in this environment — this writes real, hand-written counter code through the same
        mainline path an agent turn would, so the sandboxed runtime is verifiable without one.
      </p>
      {error !== null && <p className="error">{error}</p>}
    </div>
  )
}

export function AppLauncherGrid({
  onLaunch,
  onEdit
}: {
  readonly onLaunch: (appId: EntityId) => void
  readonly onEdit: (appId: EntityId) => void
}) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [createAppOpenRequest, setCreateAppOpenRequest] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)
  const appsEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listApps(new ListAppsInput({ workspaceId })))),
    [refreshKey]
  )
  const appsState = useEffectQuery(appsEffect, [refreshKey])
  // `useEffectQuery` keeps its preceding settled result until the next generation enters its
  // loading state. Keep that result as a same-workspace cache, but do not let it claim an empty
  // catalog or make a grid of app tiles disappear while the current generation is unresolved.
  const activeRefreshKey = useRef(refreshKey)
  useEffect(() => {
    activeRefreshKey.current = refreshKey
  }, [refreshKey])
  const stateIsCurrent = activeRefreshKey.current === refreshKey
  const currentApps = stateIsCurrent && appsState.status === "success" ? appsState.value.apps : undefined
  const successfulApps = useRef<ReadonlyArray<App> | undefined>(currentApps)
  if (currentApps !== undefined) successfulApps.current = currentApps
  const cachedApps = successfulApps.current
  const visibleApps = currentApps ?? cachedApps ?? []
  const isLoadingApps = !stateIsCurrent || appsState.status === "loading"
  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (appsState.status === "loading") {
      claim.sawLoading = true
      return
    }
    // The refresh-key render still contains the preceding catalog failure. Keep the visible
    // claim until this app-list retry enters loading and then reaches a terminal result.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [appsState.status])
  const retryApps = useCallback(() => {
    if (retryClaim.current !== undefined || appsState.status === "loading") return
    retryClaim.current = { sawLoading: false }
    setRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [appsState.status])
  const isRetryingApps = retryClaimed || isLoadingApps

  const handleCreated = (appId: EntityId) => {
    setRefreshKey((k) => k + 1)
    onEdit(appId) // a fresh App has no code yet — editing, not launching, is the useful next step
  }

  const handleSeeded = (appId: EntityId) => {
    setRefreshKey((k) => k + 1)
    onLaunch(appId) // the seed already wrote real code — launching demonstrates the round trip
  }

  return (
    <section className="app-launcher">
      {isLoadingApps && <p>{cachedApps === undefined ? "Loading…" : "Refreshing apps…"}</p>}
      {appsState.status === "failure" && (
        <section className="app-launcher-load-state" role="alert">
          <div>
            <h2>Apps are unavailable</h2>
            <p>
              {cachedApps === undefined
                ? "Apps could not be loaded. Nothing has been changed. Retry to check them again."
                : "Apps could not be refreshed. Your previously loaded apps remain available. Retry to check them again."}
            </p>
          </div>
          <button type="button" onClick={retryApps} disabled={isRetryingApps}>
            {isRetryingApps ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {currentApps !== undefined && currentApps.length === 0 && (
        <EmptyState
          icon="✦"
          title="Make a tool for the moment"
          message="Create a small App for a task you keep repeating. You can keep it, change it, or throw it away when the work is done."
          action={
            <button type="button" onClick={() => setCreateAppOpenRequest((request) => request + 1)}>
              Create an app
            </button>
          }
        />
      )}

      <div className="app-grid" role="list">
        {visibleApps.map((app) => (
          <button
            key={app.id}
            type="button"
            role="listitem"
            className="app-tile"
            onClick={() => onLaunch(app.id)}
            aria-label={`Launch ${app.title}`}
          >
            <span className="app-tile-icon" aria-hidden="true">
              {app.icon}
            </span>
            <span className="app-tile-title">{app.title}</span>
            {app.pending !== undefined && <span className="app-tile-pending-badge">pending</span>}
          </button>
        ))}
        <CreateAppForm openRequest={createAppOpenRequest} onCreated={handleCreated} />
      </div>

      {import.meta.env.DEV && <DevSeedTestAppButton onSeeded={handleSeeded} />}
    </section>
  )
}
