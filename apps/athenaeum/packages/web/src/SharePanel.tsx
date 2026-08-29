import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
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
  type Email,
  type Role,
  type ShareKeyHash,
  type ShareLink
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"

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

const addCollaboratorFailureMessage =
  "We couldn’t confirm that this collaborator was added. The email is still here. Review the list before trying again."

const shareLinkCreationFailureMessage =
  "We couldn’t confirm that a share link was created. Review the active links before creating another."

const shareKeyRedemptionFailureMessage =
  "We couldn’t confirm whether this share key was redeemed. The key is still here. Review access before taking another action."

const shareLinkPreviewFailureMessage =
  "We couldn’t inspect this share link’s effects. Review the active links and try again."

const shareLinkRevocationFailureMessage =
  "We couldn’t confirm that this share link was revoked. Review the active links before taking another action."

const collaboratorRemovalPreviewFailureMessage =
  "We couldn’t inspect this collaborator’s access changes. Review the collaborators and try again."

const collaboratorRemovalFailureMessage =
  "We couldn’t confirm that this collaborator was removed. Review the collaborators before taking another action."

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
  const [sharingDetailsRetryClaimed, setSharingDetailsRetryClaimed] = useState(false)
  const sharingDetailsRetryClaim = useRef<{
    sawCollaboratorsLoading: boolean
    sawShareLinksLoading: boolean
  } | undefined>(undefined)

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

  useEffect(() => {
    const claim = sharingDetailsRetryClaim.current
    if (claim === undefined) return
    if (collaboratorsState.status === "loading") claim.sawCollaboratorsLoading = true
    if (shareLinksState.status === "loading") claim.sawShareLinksLoading = true
    // A refresh-key render initially retains the preceding pair of results. Keep this
    // presentation claim until both list reads visibly load, then release it only after both
    // reach terminal states.
    if (!claim.sawCollaboratorsLoading || !claim.sawShareLinksLoading) return
    if (collaboratorsState.status === "loading" || shareLinksState.status === "loading") return
    sharingDetailsRetryClaim.current = undefined
    setSharingDetailsRetryClaimed(false)
  }, [collaboratorsState.status, shareLinksState.status])

  const retrySharingDetails = useCallback(() => {
    if (
      sharingDetailsRetryClaim.current !== undefined ||
      collaboratorsState.status === "loading" ||
      shareLinksState.status === "loading"
    ) return
    sharingDetailsRetryClaim.current = { sawCollaboratorsLoading: false, sawShareLinksLoading: false }
    setSharingDetailsRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [collaboratorsState.status, shareLinksState.status])

  const isRetryingSharingDetails =
    sharingDetailsRetryClaimed || collaboratorsState.status === "loading" || shareLinksState.status === "loading"

  // --- Add collaborator ---------------------------------------------------------------------
  const [addEmail, setAddEmail] = useState("")
  const [addRole, setAddRole] = useState<Role>("use")
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const isAddingCollaboratorRef = useRef(false)

  const handleAddCollaborator = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = addEmail.trim().toLowerCase()
    if (trimmed.length === 0 || isAddingCollaboratorRef.current) return
    isAddingCollaboratorRef.current = true
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
      isAddingCollaboratorRef.current = false
      setAddBusy(false)
      if (Exit.isSuccess(exit)) {
        setAddEmail("")
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setAddError(addCollaboratorFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  // --- Create share link ---------------------------------------------------------------------
  const [linkRole, setLinkRole] = useState<Role>("use")
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [mintedKey, setMintedKey] = useState<string | null>(null)
  const isCreatingShareLinkRef = useRef(false)

  const handleCreateShareLink = () => {
    if (isCreatingShareLinkRef.current) return
    isCreatingShareLinkRef.current = true
    setLinkBusy(true)
    setLinkError(null)
    setMintedKey(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.createShareLink(new CreateShareLinkInput({ workspaceId, role: linkRole })))
      )
    )
    fiber.addObserver((exit) => {
      isCreatingShareLinkRef.current = false
      setLinkBusy(false)
      if (Exit.isSuccess(exit)) {
        setMintedKey(exit.value.key)
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setLinkError(shareLinkCreationFailureMessage)
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
  const isRedeemingShareLinkRef = useRef(false)

  const handleRedeem = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = redeemKey.trim()
    if (trimmed.length === 0 || isRedeemingShareLinkRef.current) return
    isRedeemingShareLinkRef.current = true
    setRedeemBusy(true)
    setRedeemError(null)
    setRedeemSuccess(false)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.redeemShareLink(new RedeemShareLinkInput({ workspaceId, key: trimmed })))
      )
    )
    fiber.addObserver((exit) => {
      isRedeemingShareLinkRef.current = false
      setRedeemBusy(false)
      if (Exit.isSuccess(exit)) {
        setRedeemKey("")
        setRedeemSuccess(true)
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setRedeemError(shareKeyRedemptionFailureMessage)
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
  const [removalPreviewingProfileId, setRemovalPreviewingProfileId] = useState<string | null>(null)
  const isPreviewingRemovalRef = useRef(false)
  const isRemovingCollaboratorRef = useRef(false)

  const startPreviewRemoval = (profileId: string) => {
    if (isPreviewingRemovalRef.current || isRemovingCollaboratorRef.current) return
    isPreviewingRemovalRef.current = true
    setRemovalPreviewingProfileId(profileId)
    setRemovalError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.previewRemoveCollaborator(new PreviewRemoveCollaboratorInput({ workspaceId, profileId: profileId as Email }))
        )
      )
    )
    fiber.addObserver((exit) => {
      isPreviewingRemovalRef.current = false
      setRemovalPreviewingProfileId(null)
      if (Exit.isSuccess(exit)) {
        setPendingRemoval({ profileId, affected: exit.value.affected })
      } else if (!Exit.isInterrupted(exit)) {
        setRemovalError(collaboratorRemovalPreviewFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  const confirmRemoval = () => {
    if (pendingRemoval === null || isRemovingCollaboratorRef.current) return
    isRemovingCollaboratorRef.current = true
    setRemovalBusy(true)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.removeCollaborator(new RemoveCollaboratorInput({ workspaceId, profileId: pendingRemoval.profileId as Email }))
        )
      )
    )
    fiber.addObserver((exit) => {
      isRemovingCollaboratorRef.current = false
      setRemovalBusy(false)
      setPendingRemoval(null)
      if (Exit.isSuccess(exit)) {
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setRemovalError(collaboratorRemovalFailureMessage)
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
  const [revokePreviewingLinkId, setRevokePreviewingLinkId] = useState<string | null>(null)
  const isPreviewingRevokeRef = useRef(false)
  const isRevokingShareLinkRef = useRef(false)

  const startPreviewRevoke = (linkId: string) => {
    if (isPreviewingRevokeRef.current || isRevokingShareLinkRef.current) return
    isPreviewingRevokeRef.current = true
    setRevokePreviewingLinkId(linkId)
    setRevokeError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.previewRevokeShareLink(new PreviewRevokeShareLinkInput({ workspaceId, linkId: linkId as ShareKeyHash }))
        )
      )
    )
    fiber.addObserver((exit) => {
      isPreviewingRevokeRef.current = false
      setRevokePreviewingLinkId(null)
      if (Exit.isSuccess(exit)) {
        setPendingRevoke({ linkId, affected: exit.value.affected })
      } else if (!Exit.isInterrupted(exit)) {
        setRevokeError(shareLinkPreviewFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  const confirmRevoke = () => {
    if (pendingRevoke === null || isRevokingShareLinkRef.current) return
    isRevokingShareLinkRef.current = true
    setRevokeBusy(true)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.revokeShareLink(new RevokeShareLinkInput({ workspaceId, linkId: pendingRevoke.linkId as ShareKeyHash }))
        )
      )
    )
    fiber.addObserver((exit) => {
      isRevokingShareLinkRef.current = false
      setRevokeBusy(false)
      setPendingRevoke(null)
      if (Exit.isSuccess(exit)) {
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setRevokeError(shareLinkRevocationFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  const collaborators: ReadonlyArray<CollaboratorInfo> =
    collaboratorsState.status === "success" ? collaboratorsState.value.collaborators : []
  const shareLinks: ReadonlyArray<ShareLink> = shareLinksState.status === "success" ? shareLinksState.value.shareLinks : []
  const collaboratorsUnavailable = collaboratorsState.status === "failure"
  const shareLinksUnavailable = shareLinksState.status === "failure"
  const sharingDetailsUnavailable = collaboratorsUnavailable || shareLinksUnavailable
  const sharingDetailsLabel = collaboratorsUnavailable && shareLinksUnavailable
    ? "Collaborators and share links could not be loaded."
    : collaboratorsUnavailable
      ? "Collaborators could not be loaded."
      : "Share links could not be loaded."

  return (
    <section className="share-panel">
      <h2>Sharing</h2>

      {sharingDetailsUnavailable && (
        <section className="share-load-state" role="alert">
          <div>
            <h3>Sharing details are unavailable</h3>
            <p>{sharingDetailsLabel} Nothing has been changed. Retry to check the current details.</p>
          </div>
          <button type="button" onClick={retrySharingDetails} disabled={isRetryingSharingDetails}>
            {isRetryingSharingDetails ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}

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
        {addError !== null && <p className="error" role="alert">{addError}</p>}
      </div>

      <div className="share-section">
        <h3>Share link</h3>
        <div className="share-form">
          <RoleSelect value={linkRole} onChange={setLinkRole} />
          <button type="button" onClick={handleCreateShareLink} disabled={linkBusy}>
            {linkBusy ? "Creating…" : "Create share link"}
          </button>
        </div>
        {linkError !== null && <p className="error" role="alert">{linkError}</p>}
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
        {redeemError !== null && <p className="error" role="alert">{redeemError}</p>}
        {redeemSuccess && <p className="share-redeem-success">Redeemed — you now have access to this workspace.</p>}
      </div>

      <div className="share-section">
        <h3>Collaborators</h3>
        {collaboratorsState.status === "loading" && (
          <p role="status" aria-live="polite" aria-atomic="true">
            Loading collaborators…
          </p>
        )}
        {collaboratorsState.status === "success" && collaborators.length === 0 && (
          <p className="share-empty">No collaborators yet.</p>
        )}
        {removalError !== null && <p className="error" role="alert">{removalError}</p>}
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
                <button
                  type="button"
                  onClick={() => startPreviewRemoval(collaborator.profileId)}
                  disabled={removalPreviewingProfileId !== null || removalBusy}
                >
                  {removalPreviewingProfileId === collaborator.profileId ? "Checking…" : "Remove"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="share-section">
        <h3>Share links</h3>
        {shareLinksState.status === "loading" && (
          <p role="status" aria-live="polite" aria-atomic="true">
            Loading share links…
          </p>
        )}
        {shareLinksState.status === "success" && shareLinks.length === 0 && (
          <p className="share-empty">No active share links.</p>
        )}
        {revokeError !== null && <p className="error" role="alert">{revokeError}</p>}
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
                <button
                  type="button"
                  onClick={() => startPreviewRevoke(link.id)}
                  disabled={revokePreviewingLinkId !== null || revokeBusy}
                >
                  {revokePreviewingLinkId === link.id ? "Checking…" : "Revoke"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
