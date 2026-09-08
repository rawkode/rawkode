import * as Schema from "effect/Schema"
import { Email } from "./auth.js"
import { EntityId } from "./node.js"
import {
  AffectedCollaborator,
  CollaboratorInfo,
  Role,
  ShareKeyHash,
  ShareLink,
  WorkspaceCatalogEntry
} from "./sharing.js"

// Wire schemas for the Phase 4 sharing/multi-workspace RPC surface (plan §"Sharing/observers on
// workspaces": "port SharingManager (docs/sharing.md) as-designed onto workspaces"), following rpc.ts's/
// graph-rpc.ts's convention: one `Schema.Class` input/output pair per RPC method, decoded with
// `Schema.decodeUnknown` at the DO boundary. Schema-only, same scope note as sharing.ts's own
// header comment — no `SharingService` implementation lives here, this is the contract a future
// one is built against.
//
// Every mutating/listing method below is implicitly workspace-scoped (`workspaceId: EntityId`) except
// `createWorkspace`/`listWorkspaces`, which are user-scoped (the caller's own `UserDurableObject` catalog)
// — mirroring the plan's "multi-workspace in the User DO" placement. None of these carry an explicit
// `callerId`/`profileId` "acting as" field: per auth.ts's `CurrentUser`/`requireAuthenticatedUser`
// design, the caller's identity is supplied out-of-band via the per-connection `Effect
// .provideService(CurrentUser, ...)` context (see auth.ts's header comment and
// `workspace-durable-object.ts`'s `whoami()` reference implementation), exactly like docs/sharing.md's
// own `SharingCaller` is threaded in by the Overseer rather than accepted as an RPC argument.
//
// No `redeemShareLink` "atomic open + redeem" combination (docs/sharing.md §Adding collaborators:
// "Share key redemption and gadget opening happen atomically in a single RPC call
// (openGadget(id, shareKey))") — Athenaeum's workspace-open path is a separate, already-existing
// concern (`WorkspaceDurableObject` connection/fetch, not part of this schema surface), so
// `redeemShareLink` here is deliberately just the redemption half, per this task's own explicit
// method list.

// --- Multi-workspace catalog (User DO-scoped) ------------------------------------------------------

/** Creates a new workspace owned by the caller and adds it to their catalog. Never `isDefault` — the
 *  fixed-identity "Personal" workspace (`WorkspaceCatalogEntry.isDefault`'s doc comment) is provisioned
 *  once at account creation, not through this method. */
export class CreateWorkspaceInput extends Schema.Class<CreateWorkspaceInput>("CreateWorkspaceInput")({
  title: Schema.String.pipe(Schema.minLength(1))
}) {}

export class CreateWorkspaceOutput extends Schema.Class<CreateWorkspaceOutput>("CreateWorkspaceOutput")({
  workspace: WorkspaceCatalogEntry
}) {}

/** Lists every workspace the caller currently has access to — owned workspaces and every workspace where
 *  they hold a reachable `Collaborator` edge (docs/sharing.md §Home page behavior: "Shared
 *  [workspaces] appear in the same list as owned [workspaces] on the home page, distinguished by showing
 *  the owner's name"; `role` on each `WorkspaceCatalogEntry` is that distinguishing signal here). */
export class ListWorkspacesInput extends Schema.Class<ListWorkspacesInput>("ListWorkspacesInput")({}) {}

export class ListWorkspacesOutput extends Schema.Class<ListWorkspacesOutput>("ListWorkspacesOutput")({
  workspaces: Schema.Array(WorkspaceCatalogEntry)
}) {}

// --- Collaborator management --------------------------------------------------------------------

/** Direct-add a collaborator (docs/sharing.md §Adding collaborators / Direct add: "The owner or an
 *  existing collaborator enters a username (email address) in the Share modal... a collaborator
 *  record is created."). `role` must never exceed the caller's own effective role ("A caller may
 *  never grant a role higher than their own effective role" — §Collaborators). */
export class AddCollaboratorInput extends Schema.Class<AddCollaboratorInput>(
  "AddCollaboratorInput"
)({
  workspaceId: EntityId,
  profileId: Email,
  role: Role,
  note: Schema.optional(Schema.String)
}) {}

export class AddCollaboratorOutput extends Schema.Class<AddCollaboratorOutput>(
  "AddCollaboratorOutput"
)({
  collaborator: CollaboratorInfo
}) {}

/** Sever the caller's authority over `profileId` (docs/sharing.md §Lazy revocation: "Removing a
 *  collaborator deletes the edges that grant them access. The owner severs all incoming edges to
 *  the target; a non-owner severs only their own user edge."). `keepUsers` is the optional
 *  re-rooting sugar from §keepUsers (optional re-rooting): profile ids to spare from the resulting
 *  cascade by granting them a fresh direct edge from the caller. Returns the actually-affected set
 *  (excluding kept users), same as `previewRemoveCollaborator` returns the hypothetical one. */
export class RemoveCollaboratorInput extends Schema.Class<RemoveCollaboratorInput>(
  "RemoveCollaboratorInput"
)({
  workspaceId: EntityId,
  profileId: Email,
  keepUsers: Schema.optional(Schema.Array(Email))
}) {}

export class RemoveCollaboratorOutput extends Schema.Class<RemoveCollaboratorOutput>(
  "RemoveCollaboratorOutput"
)({
  affected: Schema.Array(AffectedCollaborator)
}) {}

/** Preview-only: runs the effective-role computation with `profileId` hypothetically removed and
 *  returns who would be affected, without changing anything (docs/sharing.md §Preview and confirm:
 *  "Before changing anything, the frontend calls previewRemoveCollaborator()... which runs the
 *  effective-role computation with the corresponding hypothetical input and returns the
 *  AffectedCollaborators whose access would change."). */
export class PreviewRemoveCollaboratorInput extends Schema.Class<PreviewRemoveCollaboratorInput>(
  "PreviewRemoveCollaboratorInput"
)({
  workspaceId: EntityId,
  profileId: Email
}) {}

export class PreviewRemoveCollaboratorOutput extends Schema.Class<
  PreviewRemoveCollaboratorOutput
>("PreviewRemoveCollaboratorOutput")({
  affected: Schema.Array(AffectedCollaborator)
}) {}

/** Currently-active collaborators only — those with a live path from the owner (docs/sharing.md
 *  §Collaborator management: "Under the lazy revocation model, removed collaborators linger in
 *  storage with no reachable role; they are omitted here (they reappear if re-added)."). */
export class ListCollaboratorsInput extends Schema.Class<ListCollaboratorsInput>(
  "ListCollaboratorsInput"
)({
  workspaceId: EntityId
}) {}

export class ListCollaboratorsOutput extends Schema.Class<ListCollaboratorsOutput>(
  "ListCollaboratorsOutput"
)({
  collaborators: Schema.Array(CollaboratorInfo)
}) {}

// --- Share links -----------------------------------------------------------------------------

/** Mints a share link's first key (docs/sharing.md §Adding collaborators / Share link: "Any
 *  collaborator (or the owner) can create a share link... creating it mints its first key. The
 *  raw key is shown to the creator only once at mint time and is never stored server-side."). The
 *  raw key is returned as a plain `Schema.String`, not a domain type — see `ShareKeyHash`'s doc
 *  comment for why a raw key never gets a schema of its own. `role` must never exceed the caller's
 *  own effective role, same ceiling as `addCollaborator`. */
export class CreateShareLinkInput extends Schema.Class<CreateShareLinkInput>(
  "CreateShareLinkInput"
)({
  workspaceId: EntityId,
  role: Role,
  note: Schema.optional(Schema.String)
}) {}

export class CreateShareLinkOutput extends Schema.Class<CreateShareLinkOutput>(
  "CreateShareLinkOutput"
)({
  key: Schema.String,
  link: ShareLink
}) {}

/** Redeems a raw share key on behalf of the calling (authenticated) user, adding a `ShareLinkEdge`
 *  if they don't already have one for this link (docs/sharing.md §Adding collaborators / Share
 *  link: "Any of a link's keys can be redeemed by multiple people, or the same person multiple
 *  times, until the link is revoked... A key whose link is revoked behaves like an unknown key.").
 *  Deliberately does not distinguish "unknown key" from "revoked link" from "already redeemed" in
 *  its output — docs/sharing.md's own `redeemShareKey` "does nothing if the key is unknown", and
 *  revealing which of those three happened would leak information about a link the caller may not
 *  be authorized to know exists. */
export class RedeemShareLinkInput extends Schema.Class<RedeemShareLinkInput>(
  "RedeemShareLinkInput"
)({
  workspaceId: EntityId,
  key: Schema.String
}) {}

export class RedeemShareLinkOutput extends Schema.Class<RedeemShareLinkOutput>(
  "RedeemShareLinkOutput"
)({
  collaborator: CollaboratorInfo
}) {}

/** Soft-revokes a share link (docs/sharing.md §Lazy revocation: "Revoking a share link sets the
 *  link's revoked flag instead of deleting it. A revoked link contributes nothing to the
 *  permission graph and none of its keys can be redeemed, but the link record and all edges
 *  referencing it stay intact... The link's copies are deleted outright, since no edge ever
 *  references an alias."). `keepUsers` mirrors `RemoveCollaboratorInput.keepUsers` exactly (same
 *  re-rooting sugar, §keepUsers). */
export class RevokeShareLinkInput extends Schema.Class<RevokeShareLinkInput>(
  "RevokeShareLinkInput"
)({
  workspaceId: EntityId,
  linkId: ShareKeyHash,
  keepUsers: Schema.optional(Schema.Array(Email))
}) {}

export class RevokeShareLinkOutput extends Schema.Class<RevokeShareLinkOutput>(
  "RevokeShareLinkOutput"
)({
  affected: Schema.Array(AffectedCollaborator)
}) {}

/** Preview-only counterpart to `revokeShareLink`, mirroring `previewRemoveCollaborator` (§Preview
 *  and confirm: "previewRevokeShareLink()... returns the AffectedCollaborators whose access would
 *  change" if the link were revoked). */
export class PreviewRevokeShareLinkInput extends Schema.Class<PreviewRevokeShareLinkInput>(
  "PreviewRevokeShareLinkInput"
)({
  workspaceId: EntityId,
  linkId: ShareKeyHash
}) {}

export class PreviewRevokeShareLinkOutput extends Schema.Class<PreviewRevokeShareLinkOutput>(
  "PreviewRevokeShareLinkOutput"
)({
  affected: Schema.Array(AffectedCollaborator)
}) {}

/** Active (non-revoked) share links only (docs/sharing.md §Share link management:
 *  "listShareLinkRecords(): Active (non-revoked) share links."). */
export class ListShareLinksInput extends Schema.Class<ListShareLinksInput>(
  "ListShareLinksInput"
)({
  workspaceId: EntityId
}) {}

export class ListShareLinksOutput extends Schema.Class<ListShareLinksOutput>(
  "ListShareLinksOutput"
)({
  shareLinks: Schema.Array(ShareLink)
}) {}
