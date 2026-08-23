import { useEffect, useState, type FormEvent } from "react"
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [newTitle, setNewTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    const stub = openUserSession(session.credential)
    listWorkspaces(stub).then(
      (result) => {
        if (!cancelled) setWorkspaces(result)
      },
      (thrown: unknown) => {
        if (!cancelled) setLoadError(thrown instanceof Error ? thrown.message : String(thrown))
      }
    )
    return () => {
      cancelled = true
      closeUserSession(stub)
    }
  }, [session.credential, refreshKey])

  const activeInCatalog = workspaces?.some((workspace) => workspace.workspaceId === activeWorkspaceId) ?? true

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = newTitle.trim()
    if (trimmed.length === 0) return
    setCreating(true)
    setCreateError(null)
    const stub = openUserSession(session.credential)
    createWorkspace(stub, trimmed).then(
      (workspace) => {
        closeUserSession(stub)
        setCreating(false)
        setNewTitle("")
        setRefreshKey((k) => k + 1)
        onSwitch(workspace.workspaceId, workspace.title)
      },
      (thrown: unknown) => {
        closeUserSession(stub)
        setCreating(false)
        setCreateError(thrown instanceof Error ? thrown.message : String(thrown))
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
      {workspaces === undefined && loadError === null && <span className="workspace-switcher-loading">loading…</span>}
      {loadError !== null && <span className="error">{loadError}</span>}
      {workspaces !== undefined && (
        <select
          id="workspace-switcher-select"
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
            <option value={SHARED_LINK_WORKSPACE_ID}>Shared workspace (opened via link) — {activeWorkspaceId}</option>
          )}
          {workspaces.map((workspace) => (
            <option
              key={workspace.workspaceId}
              value={workspace.workspaceId}
              title={`${workspace.title}${workspace.isDefault ? " (default)" : ""} — ${workspace.role}`}
            >
              {workspace.title}
              {workspace.isDefault ? " (default)" : ""} — {workspace.role}
            </option>
          ))}
        </select>
      )}
      <form onSubmit={handleCreate} className="workspace-switcher-create">
        <input
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          placeholder="New workspace title"
          disabled={creating}
        />
        <button type="submit" disabled={creating || newTitle.trim().length === 0}>
          {creating ? "Creating…" : "+ New workspace"}
        </button>
      </form>
      {createError !== null && <p className="error">{createError}</p>}
    </div>
  )
}
