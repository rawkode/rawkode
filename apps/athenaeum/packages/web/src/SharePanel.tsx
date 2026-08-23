import { useMemo, useState, type FormEvent } from "react"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  AddCollaboratorInput,
  CreateShareLinkInput,
  ListCollaboratorsInput,
  ListShareLinksInput,
  PreviewRemoveCollaboratorInput,
  PreviewRevokeShareLinkInput,
  RedeemShareLinkInput,
  RemoveCollaboratorInput,
  RevokeShareLinkInput,
  type AffectedCollaborator,
  type CollaboratorInfo,
  type DomainError,
  type Email,
  type Role,
  type ShareKeyHash,
  type ShareLink
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { formatDomainError } from "./format-domain-error.js"

// Web-stage task item 3: "A share UI: add a collaborator by email + role, create/copy a share
// link, list current collaborators/links with remove/revoke actions, and a 'this removal will
// also affect: ...' preview warning per sharing.md's preview/confirm two-phase UX."
//
// Talks to the real `SharingService` RPC surface `rpc-client.ts` now exposes
// (`addCollaborator`/`removeCollaborator`/`previewRemoveCollaborator`/`createShareLink`/
// `redeemShareLink`/`revokeShareLink`/`previewRevokeShareLink`/`listCollaborators`/
// `listShareLinks`), mirroring `ChatPanel.tsx`'s own `refreshKey`-bump-after-mutation convention
// (no live subscription exists for this data yet — see `sharing-rpc.ts`'s own scope notes).
//
// Two-phase preview/confirm (docs/sharing.md §"Preview and confirm"): clicking "Remove"/"Revoke"
// does NOT mutate anything by itself — it calls the corresponding `preview*` RPC and stores the
// hypothetical `AffectedCollaborator[]` in `pendingRemoval`/`pendingRevoke` state, which renders an
// inline warning ("removing X will also affect: ...") with separate Confirm/Cancel buttons. Only
// Confirm calls the real `removeCollaborator`/`revokeShareLink`.

const roleLabel = (role: Role): string => (role === "build" ? "build (full edit)" : "use (read + tasks)")

const summarizeAffected = (affected: ReadonlyArray<AffectedCollaborator>): string =>
  affected
    .map((a) => (a.newRole === null ? `${a.profileId} loses access` : `${a.profileId} → ${a.newRole}`))
    .join(", ")

function RoleSelect({ value, onChange }: { readonly value: Role; readonly onChange: (role: Role) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as Role)}>
      <option value="use">use (read + tasks)</option>
      <option value="build">build (full edit)</option>
    </select>
  )
}

export function SharePanel() {
  const [refreshKey, setRefreshKey] = useState(0)

  const collaboratorsEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.listCollaborators(new ListCollaboratorsInput({ workspaceId })))
      ),
    [refreshKey]
  )
  const collaboratorsState = useEffectQuery(collaboratorsEffect, [refreshKey])

  const shareLinksEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listShareLinks(new ListShareLinksInput({ workspaceId })))),
    [refreshKey]
  )
  const shareLinksState = useEffectQuery(shareLinksEffect, [refreshKey])

  // --- Add collaborator ---------------------------------------------------------------------
  const [addEmail, setAddEmail] = useState("")
  const [addRole, setAddRole] = useState<Role>("use")
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const handleAddCollaborator = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = addEmail.trim().toLowerCase()
    if (trimmed.length === 0) return
    setAddBusy(true)
    setAddError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.addCollaborator(new AddCollaboratorInput({ workspaceId, profileId: trimmed as Email, role: addRole }))
        )
      )
    )
    fiber.addObserver((exit) => {
      setAddBusy(false)
      if (Exit.isSuccess(exit)) {
        setAddEmail("")
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setAddError(`Failed to add collaborator: ${formatDomainError(failure)}`)
        console.error(exit.cause.toString())
      }
    })
  }

  // --- Create share link ---------------------------------------------------------------------
  const [linkRole, setLinkRole] = useState<Role>("use")
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [mintedKey, setMintedKey] = useState<string | null>(null)

  const handleCreateShareLink = () => {
    setLinkBusy(true)
    setLinkError(null)
    setMintedKey(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.createShareLink(new CreateShareLinkInput({ workspaceId, role: linkRole })))
      )
    )
    fiber.addObserver((exit) => {
      setLinkBusy(false)
      if (Exit.isSuccess(exit)) {
        setMintedKey(exit.value.key)
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setLinkError(`Failed to create share link: ${formatDomainError(failure)}`)
        console.error(exit.cause.toString())
      }
    })
  }

  // The workspace's own URL (real — `?workspace=` is `workspace-id.ts`'s established resolution rule) plus the
  // raw key are shown separately, not fused into one auto-redeeming link: there is no
  // `#share=`-fragment auto-redeem flow built this stage (App.tsx does not parse one) — a
  // recipient opens the workspace URL, signs in, then pastes the key into the "Redeem" field below.
  const workspaceUrl = `${window.location.origin}${window.location.pathname}?workspace=${workspaceId}`

  // --- Redeem a share key (manual entry — for testing/collaborators without the auto-redeem-on-
  // load flow, which is not built this stage; see `App.tsx`'s own note on `#share=` fragments) --
  const [redeemKey, setRedeemKey] = useState("")
  const [redeemBusy, setRedeemBusy] = useState(false)
  const [redeemError, setRedeemError] = useState<string | null>(null)
  const [redeemSuccess, setRedeemSuccess] = useState(false)

  const handleRedeem = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = redeemKey.trim()
    if (trimmed.length === 0) return
    setRedeemBusy(true)
    setRedeemError(null)
    setRedeemSuccess(false)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.redeemShareLink(new RedeemShareLinkInput({ workspaceId, key: trimmed })))
      )
    )
    fiber.addObserver((exit) => {
      setRedeemBusy(false)
      if (Exit.isSuccess(exit)) {
        setRedeemKey("")
        setRedeemSuccess(true)
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setRedeemError("Failed to redeem share key — it may be invalid, expired, or revoked")
        console.error(exit.cause.toString())
      }
    })
  }

  // --- Remove collaborator (preview/confirm) --------------------------------------------------
  const [pendingRemoval, setPendingRemoval] = useState<{
    readonly profileId: string
    readonly affected: ReadonlyArray<AffectedCollaborator>
  } | null>(null)
  const [removalBusy, setRemovalBusy] = useState(false)
  const [removalError, setRemovalError] = useState<string | null>(null)

  const startPreviewRemoval = (profileId: string) => {
    setRemovalError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.previewRemoveCollaborator(new PreviewRemoveCollaboratorInput({ workspaceId, profileId: profileId as Email }))
        )
      )
    )
    fiber.addObserver((exit) => {
      if (Exit.isSuccess(exit)) {
        setPendingRemoval({ profileId, affected: exit.value.affected })
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setRemovalError(`Failed to preview removal: ${formatDomainError(failure)}`)
        console.error(exit.cause.toString())
      }
    })
  }

  const confirmRemoval = () => {
    if (pendingRemoval === null) return
    setRemovalBusy(true)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.removeCollaborator(new RemoveCollaboratorInput({ workspaceId, profileId: pendingRemoval.profileId as Email }))
        )
      )
    )
    fiber.addObserver((exit) => {
      setRemovalBusy(false)
      setPendingRemoval(null)
      if (Exit.isSuccess(exit)) {
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setRemovalError(`Failed to remove collaborator: ${formatDomainError(failure)}`)
        console.error(exit.cause.toString())
      }
    })
  }

  // --- Revoke share link (preview/confirm) ----------------------------------------------------
  const [pendingRevoke, setPendingRevoke] = useState<{
    readonly linkId: string
    readonly affected: ReadonlyArray<AffectedCollaborator>
  } | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const startPreviewRevoke = (linkId: string) => {
    setRevokeError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.previewRevokeShareLink(new PreviewRevokeShareLinkInput({ workspaceId, linkId: linkId as ShareKeyHash }))
        )
      )
    )
    fiber.addObserver((exit) => {
      if (Exit.isSuccess(exit)) {
        setPendingRevoke({ linkId, affected: exit.value.affected })
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setRevokeError(`Failed to preview revocation: ${formatDomainError(failure)}`)
        console.error(exit.cause.toString())
      }
    })
  }

  const confirmRevoke = () => {
    if (pendingRevoke === null) return
    setRevokeBusy(true)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.revokeShareLink(new RevokeShareLinkInput({ workspaceId, linkId: pendingRevoke.linkId as ShareKeyHash }))
        )
      )
    )
    fiber.addObserver((exit) => {
      setRevokeBusy(false)
      setPendingRevoke(null)
      if (Exit.isSuccess(exit)) {
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setRevokeError(`Failed to revoke share link: ${formatDomainError(failure)}`)
        console.error(exit.cause.toString())
      }
    })
  }

  const collaborators: ReadonlyArray<CollaboratorInfo> =
    collaboratorsState.status === "success" ? collaboratorsState.value.collaborators : []
  const shareLinks: ReadonlyArray<ShareLink> = shareLinksState.status === "success" ? shareLinksState.value.shareLinks : []

  return (
    <section className="share-panel">
      <h2>Sharing</h2>

      <div className="share-section">
        <h3>Add a collaborator</h3>
        <form onSubmit={handleAddCollaborator} className="share-form">
          <input
            type="email"
            value={addEmail}
            onChange={(event) => setAddEmail(event.target.value)}
            placeholder="collaborator@example.com"
            aria-label="Collaborator email"
            disabled={addBusy}
          />
          <RoleSelect value={addRole} onChange={setAddRole} />
          <button type="submit" disabled={addBusy || addEmail.trim().length === 0}>
            {addBusy ? "Adding…" : "Add"}
          </button>
        </form>
        {addError !== null && <p className="error">{addError}</p>}
      </div>

      <div className="share-section">
        <h3>Share link</h3>
        <div className="share-form">
          <RoleSelect value={linkRole} onChange={setLinkRole} />
          <button type="button" onClick={handleCreateShareLink} disabled={linkBusy}>
            {linkBusy ? "Creating…" : "Create share link"}
          </button>
        </div>
        {linkError !== null && <p className="error">{linkError}</p>}
        {mintedKey !== null && (
          <div className="share-minted-key">
            <p>
              Shown once — copy it now, it cannot be recovered later (only its hash is stored).
              Send the recipient both the workspace link and the key; they redeem it below.
            </p>
            <label htmlFor="share-workspace-link">Workspace link</label>
            <input
              id="share-workspace-link"
              readOnly
              value={workspaceUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
            <label htmlFor="share-key">Share key</label>
            <input id="share-key" readOnly value={mintedKey} onFocus={(event) => event.currentTarget.select()} />
          </div>
        )}
        <form onSubmit={handleRedeem} className="share-form share-redeem-form">
          <input
            value={redeemKey}
            onChange={(event) => setRedeemKey(event.target.value)}
            placeholder="Paste a share key to redeem it"
            aria-label="Share key to redeem"
            disabled={redeemBusy}
          />
          <button type="submit" disabled={redeemBusy || redeemKey.trim().length === 0}>
            {redeemBusy ? "Redeeming…" : "Redeem"}
          </button>
        </form>
        {redeemError !== null && <p className="error">{redeemError}</p>}
        {redeemSuccess && <p className="share-redeem-success">Redeemed — you now have access to this workspace.</p>}
      </div>

      <div className="share-section">
        <h3>Collaborators</h3>
        {collaboratorsState.status === "loading" && <p>Loading…</p>}
        {collaboratorsState.status === "failure" && (
          <p className="error">{formatDomainError(collaboratorsState.error)}</p>
        )}
        {collaboratorsState.status === "success" && collaborators.length === 0 && (
          <p className="share-empty">No collaborators yet.</p>
        )}
        {removalError !== null && <p className="error">{removalError}</p>}
        <ul className="share-list">
          {collaborators.map((collaborator) => (
            <li key={collaborator.profileId} className="share-list-item">
              <span>
                {collaborator.profileId} — <strong>{roleLabel(collaborator.role)}</strong>
              </span>
              {pendingRemoval?.profileId === collaborator.profileId ? (
                <span className="share-confirm">
                  {pendingRemoval.affected.length > 0 ? (
                    <span className="share-affected-warning">
                      This will also affect: {summarizeAffected(pendingRemoval.affected)}
                    </span>
                  ) : (
                    <span className="share-affected-warning">No downstream effects.</span>
                  )}
                  <button type="button" onClick={confirmRemoval} disabled={removalBusy} className="share-confirm-remove">
                    {removalBusy ? "Removing…" : "Confirm removal"}
                  </button>
                  <button type="button" onClick={() => setPendingRemoval(null)} disabled={removalBusy}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => startPreviewRemoval(collaborator.profileId)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="share-section">
        <h3>Share links</h3>
        {shareLinksState.status === "loading" && <p>Loading…</p>}
        {shareLinksState.status === "failure" && <p className="error">{formatDomainError(shareLinksState.error)}</p>}
        {shareLinksState.status === "success" && shareLinks.length === 0 && (
          <p className="share-empty">No active share links.</p>
        )}
        {revokeError !== null && <p className="error">{revokeError}</p>}
        <ul className="share-list">
          {shareLinks.map((link) => (
            <li key={link.id} className="share-list-item">
              <span>
                <code>{link.id.slice(0, 12)}…</code> — <strong>{roleLabel(link.role)}</strong> by{" "}
                {link.creatorId}
              </span>
              {pendingRevoke?.linkId === link.id ? (
                <span className="share-confirm">
                  {pendingRevoke.affected.length > 0 ? (
                    <span className="share-affected-warning">
                      This will also affect: {summarizeAffected(pendingRevoke.affected)}
                    </span>
                  ) : (
                    <span className="share-affected-warning">No downstream effects.</span>
                  )}
                  <button type="button" onClick={confirmRevoke} disabled={revokeBusy} className="share-confirm-remove">
                    {revokeBusy ? "Revoking…" : "Confirm revoke"}
                  </button>
                  <button type="button" onClick={() => setPendingRevoke(null)} disabled={revokeBusy}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => startPreviewRevoke(link.id)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
