import { useEffect, useRef, useState, type FormEvent } from "react"
import * as Schema from "effect/Schema"
import { EntityId, type WorkspaceCatalogEntry } from "@athenaeum/domain"
import { closeUserSession, createWorkspace, listWorkspaces, openUserSession } from "./user-rpc-client.js"
import type { DevSession } from "./dev-session.js"

// Web-stage task item 2: "A workspace switcher (list workspaces from the user's catalog, switch the
// active workspace, showing the default Personal workspace)."
//
// `listWorkspaces` only returns the caller's OWN catalog (workspaces they created/own — see
// `user-rpc-client.ts`'s own doc comment) — a workspace someone else shared with the caller does not
// appear here yet (that would need a `UserDurableObject#recordSharedGadgetOpen`-equivalent, not
// built this stage — see docs/sharing.md's own "does not appear on a collaborator's home page
// until they first open it" precedent, which this stage's backend does not yet implement the
// second half of). This component still lets a collaborator reach a shared workspace: `App.tsx`
// resolves the active workspace id from `?workspace=<id>` in the URL first (per `workspace-id.ts`'s own
// resolution rule, unchanged by this stage), and if that id isn't in the fetched catalog, this
// component synthesizes a visible "Shared workspace (opened via link)" entry for it so the switcher
// never silently hides which workspace is actually active.
//
// Connection lifetime: deliberately NOT a `useMemo`-cached stub disposed by a separate
// `useEffect` keyed on it — that shape has a real StrictMode bug (caught by this stage's own
// browser verification, not hypothetical): React's dev-only mount→cleanup→remount cycle disposes
// the memoized stub on the synthetic cleanup, but `useMemo` returns the SAME cached reference on
// the immediate remount (its deps didn't change), so the remounted fetch effect calls
// `listWorkspaces`/`createWorkspace` on an already-disposed stub and fails with "Attempted to use RPC
// stub after it has been disposed." Each effect/handler below instead opens and disposes its OWN
// short-lived stub, so no two logical operations ever share one stub's lifecycle.

const SHARED_LINK_WORKSPACE_ID = "__shared_link__"

const workspaceCreationFailureMessage =
  "We couldn’t confirm that this workspace was created. The title is still here. Review your workspaces before taking another action."

export function WorkspaceSwitcher({
  session,
  activeWorkspaceId,
  onSwitch
}: {
  readonly session: DevSession
  readonly activeWorkspaceId: EntityId
  readonly onSwitch: (workspaceId: EntityId, title: string) => void
}) {
  const [workspaces, setWorkspaces] = useState<ReadonlyArray<WorkspaceCatalogEntry> | undefined>(undefined)
  const [loadError, setLoadError] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [newTitle, setNewTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [catalogRetryClaimed, setCatalogRetryClaimed] = useState(false)
  const isCreatingWorkspaceRef = useRef(false)
  const catalogRetryClaim = useRef<symbol | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    // The effect that starts a manual retry owns its release; a cancelled older read must never
    // clear the claim for a newer catalog request.
    const retryClaim = catalogRetryClaim.current
    const releaseRetryClaim = () => {
      if (retryClaim === undefined || catalogRetryClaim.current !== retryClaim) return
      catalogRetryClaim.current = undefined
      setCatalogRetryClaimed(false)
    }
    setLoadError(false)
    const stub = openUserSession(session.credential)
    listWorkspaces(stub).then(
      (result) => {
        if (!cancelled) {
          setWorkspaces(result)
          releaseRetryClaim()
        }
      },
      () => {
        if (!cancelled) {
          // A catalog failure is not an empty catalog. Hide any stale selection until a real
          // response replaces it, while leaving workspace management available below.
          setWorkspaces(undefined)
          setLoadError(true)
          releaseRetryClaim()
        }
      }
    )
    return () => {
      cancelled = true
      closeUserSession(stub)
    }
  }, [session.credential, refreshKey])

  const retryCatalog = () => {
    if (catalogRetryClaim.current !== undefined) return
    catalogRetryClaim.current = Symbol("workspace-catalog-retry")
    setCatalogRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }

  const activeInCatalog = workspaces?.some((workspace) => workspace.workspaceId === activeWorkspaceId) ?? true

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = newTitle.trim()
    if (trimmed.length === 0 || isCreatingWorkspaceRef.current) return
    isCreatingWorkspaceRef.current = true
    setCreating(true)
    setCreateError(null)
    const stub = openUserSession(session.credential)
    createWorkspace(stub, trimmed).then(
      (workspace) => {
        closeUserSession(stub)
        isCreatingWorkspaceRef.current = false
        setCreating(false)
        setNewTitle("")
        setRefreshKey((k) => k + 1)
        onSwitch(workspace.workspaceId, workspace.title)
      },
      (thrown: unknown) => {
        closeUserSession(stub)
        isCreatingWorkspaceRef.current = false
        setCreating(false)
        setCreateError(workspaceCreationFailureMessage)
        console.error(thrown)
      }
    )
  }

  const handleSelect = (value: string) => {
    if (value === SHARED_LINK_WORKSPACE_ID) return // already active, nothing to do
    const decoded = Schema.decodeUnknownEither(EntityId)(value)
    if (decoded._tag === "Right") onSwitch(decoded.right, value)
  }

  return (
    <div className="workspace-switcher">
      <label htmlFor="workspace-switcher-select">Workspace</label>
      {workspaces === undefined && !loadError && (
        <span className="workspace-switcher-loading" role="status" aria-live="polite">
          loading…
        </span>
      )}
      {loadError && (
        <div className="workspace-switcher-load-state" role="alert">
          <span>Workspaces couldn&rsquo;t be loaded. Retry to restore the switcher.</span>
          <button type="button" onClick={retryCatalog} disabled={catalogRetryClaimed}>
            {catalogRetryClaimed ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {workspaces !== undefined && (
        <select
          id="workspace-switcher-select"
          className="ds-field"
          value={activeInCatalog ? activeWorkspaceId : SHARED_LINK_WORKSPACE_ID}
          onChange={(event) => handleSelect(event.target.value)}
          title={
            activeInCatalog
              ? (() => {
                  const active = workspaces.find((workspace) => workspace.workspaceId === activeWorkspaceId)
                  return active === undefined
                    ? undefined
                    : `${active.title}${active.isDefault ? " (default)" : ""} — ${active.role}`
                })()
              : `Shared workspace (opened via link) — ${activeWorkspaceId}`
          }
        >
          {!activeInCatalog && (
            <option
              value={SHARED_LINK_WORKSPACE_ID}
              title={`Shared workspace (opened via link) — ${activeWorkspaceId}`}
            >
              Shared workspace
            </option>
          )}
          {workspaces.map((workspace) => (
            <option
              key={workspace.workspaceId}
              value={workspace.workspaceId}
              title={`${workspace.title}${workspace.isDefault ? " (default)" : ""} — ${workspace.role}`}
            >
              {workspace.title}
            </option>
          ))}
        </select>
      )}
      <details className="ds-disclosure workspace-switcher-manage">
        <summary>Manage workspaces</summary>
        <form onSubmit={handleCreate} className="workspace-switcher-create">
          <label htmlFor="workspace-switcher-new-title" className="sr-only">
            New workspace title
          </label>
          <input
            id="workspace-switcher-new-title"
            className="ds-field"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="New workspace title"
            disabled={creating}
          />
          <button className="ds-button" type="submit" disabled={creating || newTitle.trim().length === 0}>
            {creating ? "Creating…" : "+ New workspace"}
          </button>
        </form>
        {createError !== null && (
          <p className="error" role="alert">
            {createError}
          </p>
        )}
      </details>
    </div>
  )
}
