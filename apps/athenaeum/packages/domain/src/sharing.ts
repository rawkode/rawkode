import * as Schema from "effect/Schema"
import { Email } from "./auth.js"
import { EntityId, IsoDateTimeString } from "./node.js"

// Phase 4 task ("Extend packages/domain/src... with sharing/observers schemas per the plan's
// 'Sharing/observers on workspaces' paragraph and cloudflare-os's docs/sharing.md"). This file is a
// direct port of docs/sharing.md's collaborator/permission-graph/share-link *shape* onto workspaces —
// schema only, per this task's explicit scope ("note the collaborators/shareKeys schema surface
// it'll attach to later" — no `SharingManager` fixed-point algorithm, no repository Context.Tags,
// no observer verification; those are the next stage's job once this schema surface exists to
// build against). `gadget` → `workspace`, `Overseer` → `WorkspaceDurableObject`, `profile.id` → `Email`
// (Athenaeum's sole account key, per auth.ts's own header comment — cloudflare-os's `profile.id`
// is likewise "username/email", so this is a direct type substitution, not a design change).
//
// Everything below cites the specific docs/sharing.md section it ports:
//
// - `Role` — "Roles are totally ordered: build > use." (§Collaborators)
// - `UserEdge`/`ShareLinkEdge`/`PermissionEdge` — "§Permission graph / Edges": "User edge: records
//   that a specific sharer... directly added this collaborator. Includes a timestamp, the granted
//   role, and an optional note." / "Share-link edge: records that this collaborator redeemed a key
//   for a specific share link (identified by keyId...). Includes a timestamp; the granted role is
//   taken from the link."
// - `Collaborator` — "§Collaborators": cloudflare-os's `CollaboratorRecord` is `{profile, addedBy:
//   PermissionEdge[]}`; ported here as `{profileId, workspaceId, edges}` per this task's exact
//   requested shape (no denormalized profile snapshot — Athenaeum has no separate profile-display
//   concept yet, `profileId` *is* the display identity for now).
// - `CollaboratorInfo` — the listing/preview-facing shape that additionally carries the *live*
//   computed effective role (cloudflare-os's `CollaboratorInfo = {profile, addedBy, role}`,
//   `SharingManager.listCollaborators()`'s own return shape) — kept distinct from the bare
//   `Collaborator` storage record because effective role is "computed live... never denormalized
//   into storage" (§Effective role) and must never be confused with a persisted field.
// - `ShareLink`/`ShareKeyRecord` — "§Adding collaborators / Share link" + "Storage shape: a link is
//   its first key. The shareKeys table holds one row per key: the row for the first key carries the
//   link's metadata and is keyed by that key's hash, which serves as the link id. Each later copy
//   stores only an alias pointing back at that id."
// - `AffectedCollaborator` — "§Removals and downgrades": "each entry is an AffectedCollaborator
//   carrying oldRole and newRole (with newRole === null meaning full removal)."
// - `WorkspaceCatalogEntry` — this task's own multi-workspace addition (no direct cloudflare-os analog,
//   since gadgets aren't grouped into a "catalog" the way Athenaeum's `UserDurableObject` groups
//   workspaces per the plan's "multi-workspace in the User DO with the fixed-identity default 'Personal'
//   workspace").

/** Collaborator access level. Totally ordered: `"build"` > `"use"` (docs/sharing.md
 *  §Collaborators). `"build"` mirrors full graph edit (owner-equivalent, minus the owner-only
 *  exceptions docs/sharing.md lists); `"use"` mirrors read + task-complete, per the plan's
 *  "`use`/`build` roles map to read+task-complete / full graph edit." */
export const Role = Schema.Literal("build", "use")
export type Role = typeof Role.Type

/** A 64-character lowercase hex SHA-256 digest — the storage id/hash shape docs/sharing.md's
 *  `hashShareKey` produces ("the server generates a random 128-bit key and stores only its
 *  HMAC-SHA-256 hash... a link is its first key... keyed by that key's hash, which serves as the
 *  link id"). Deliberately a distinct branded type from `EntityId` (ULID/UUID only) rather than a
 *  bare `Schema.String` on `ShareLink.id`/`ShareLinkEdge.linkId`/`ShareKeyRecord.hash` — a share
 *  key hash can never be mistaken for (or accidentally decoded from) an ordinary entity id. The
 *  raw key itself is never represented as a domain schema at all: per docs/sharing.md, "the raw
 *  key is shown to the creator only once at mint time and is never stored server-side", so it only
 *  ever exists as a plain wire string in the mint/redeem RPC payloads (sharing-rpc.ts), the same
 *  way this package never gives a domain type to a bearer credential (see auth.ts's
 *  `DevSignInOutput.credential: Schema.String`). */
const shareKeyHashPattern = /^[0-9a-f]{64}$/

export const ShareKeyHash = Schema.String.pipe(
  Schema.filter((value) => shareKeyHashPattern.test(value), {
    message: () => "ShareKeyHash must be a lowercase 64-character hex SHA-256 digest"
  }),
  Schema.brand("ShareKeyHash")
)
export type ShareKeyHash = typeof ShareKeyHash.Type

/** Records that `sharerId` directly added this collaborator (docs/sharing.md §Permission graph /
 *  Edges: "User edge: records that a specific sharer (identified by profile.id) directly added
 *  this collaborator. Includes a timestamp, the granted role, and an optional note."). */
export class UserEdge extends Schema.Class<UserEdge>("UserEdge")({
  type: Schema.Literal("user"),
  sharerId: Email,
  role: Role,
  timestamp: IsoDateTimeString,
  note: Schema.optional(Schema.String)
}) {}

/** Records that this collaborator redeemed a key for share link `linkId` (docs/sharing.md
 *  §Permission graph / Edges: "Share-link edge: records that this collaborator redeemed a key for
 *  a specific share link (identified by keyId, the id of the link's first key). Includes a
 *  timestamp; the granted role is taken from the link."). `linkId` is a `ShareKeyHash` (the link's
 *  first key's hash — see `ShareLink.id`'s doc comment), not an `EntityId`: a share link has no
 *  ULID/UUID identity of its own, its id *is* a key hash, per the "a link is its first key"
 *  storage discipline. */
export class ShareLinkEdge extends Schema.Class<ShareLinkEdge>("ShareLinkEdge")({
  type: Schema.Literal("shareLink"),
  linkId: ShareKeyHash,
  timestamp: IsoDateTimeString
}) {}

/** One edge in a workspace's permission graph, explaining *how* a collaborator gained access
 *  (docs/sharing.md §Permission graph: "Each collaborator has one or more permission edges
 *  explaining how they got access... A collaborator can accumulate multiple edges... The
 *  collaborator retains access as long as they have at least one valid edge."). */
export const PermissionEdge = Schema.Union(UserEdge, ShareLinkEdge)
export type PermissionEdge = typeof PermissionEdge.Type

/** A workspace's stored collaborator record — the permission-graph node for one non-owner user
 *  (docs/sharing.md §Collaborators / §Permission graph; cloudflare-os's `CollaboratorRecord`
 *  ported to this task's exact requested shape: `{profileId, workspaceId, edges}`). The owner is
 *  never represented as a `Collaborator` row — "The owner is the implicit root of the permission
 *  graph. The owner is never stored in the collaborators table and cannot be removed."
 *  (§The owner as root). Deliberately carries no `role` field: effective role is "computed
 *  live... never denormalized into storage" (§Effective role) — see `CollaboratorInfo` for the
 *  listing-facing shape that does carry a (live-computed, non-persisted) role. */
export class Collaborator extends Schema.Class<Collaborator>("Collaborator")({
  profileId: Email,
  workspaceId: EntityId,
  edges: Schema.Array(PermissionEdge)
}) {}

/** A `Collaborator` plus their current live-computed effective role — the shape
 *  `listCollaborators`/the preview RPCs actually return (docs/sharing.md §Effective-role
 *  algorithm: "returning a map from profile ID to effective role... It is the single source of
 *  truth: open(), hasAnyShares(), the listing RPCs, and the preview methods all derive from it.").
 *  `role` is never persisted alongside `edges` — recomputing it live (not caching it here) is what
 *  makes lazy revocation correct (§Lazy revocation: "there is no eager cleanup whose bugs could
 *  grant access to an unreachable user"). */
export class CollaboratorInfo extends Schema.Class<CollaboratorInfo>("CollaboratorInfo")({
  profileId: Email,
  workspaceId: EntityId,
  edges: Schema.Array(PermissionEdge),
  role: Role
}) {}

/** A share link: a durable handle that owns one or more keys (docs/sharing.md §Adding
 *  collaborators / Share link: "A link is a durable handle that owns one or more keys: creating it
 *  mints its first key, and 'copying' the link later mints another key for the same link."). `id`
 *  is the HMAC-SHA-256 hash of the link's *first* key ("Storage shape: a link is its first key...
 *  keyed by that key's hash, which serves as the link id"), not a freshly-minted `EntityId` — see
 *  `ShareKeyHash`'s doc comment. `revoked` mirrors the soft-revocation flag exactly: "Revoking a
 *  share link sets the link's revoked flag instead of deleting it... the link record and all edges
 *  referencing it stay intact (no dangling references)" (§Lazy revocation). */
export class ShareLink extends Schema.Class<ShareLink>("ShareLink")({
  id: ShareKeyHash,
  workspaceId: EntityId,
  creatorId: Email,
  role: Role,
  revoked: Schema.Boolean,
  createdAt: IsoDateTimeString
}) {}

/** One row of the `shareKeys` collection: either a link's own first key, or a later copy ("alias")
 *  of an existing link (docs/sharing.md §Adding collaborators / Share link: "The shareKeys table
 *  holds one row per key: the row for the first key carries the link's metadata and is keyed by
 *  that key's hash, which serves as the link id. Each later copy stores only an alias pointing
 *  back at that id."). This task's requested shape is a single flat record (`{hash, linkId,
 *  alias: boolean}`) rather than cloudflare-os's tagged union (`ShareLinkRecord |
 *  ShareKeyAliasRecord`) — a deliberate simplification of the same storage discipline, not a
 *  behavior change: when `alias` is `false`, this row *is* a link's first key and `hash === linkId`
 *  (`ShareLink.id`'s value); when `alias` is `true`, `hash` is this specific copy's own key hash
 *  and `linkId` points at the `ShareLink` it is a copy of. Redeeming any row for a given `linkId`
 *  resolves to the same `ShareLink` and therefore the same `ShareLinkEdge` — "Any of a link's keys
 *  can be redeemed by multiple people, or the same person multiple times, until the link is
 *  revoked." A link's own metadata (creator, role, revoked, createdAt) lives on `ShareLink`, keyed
 *  by `linkId`, never duplicated onto alias rows — this record exists purely to resolve a redeemed
 *  raw key's hash to the `ShareLink` it belongs to. */
export class ShareKeyRecord extends Schema.Class<ShareKeyRecord>("ShareKeyRecord")({
  hash: ShareKeyHash,
  linkId: ShareKeyHash,
  alias: Schema.Boolean
}) {}

/** A collaborator whose effective role changed as the result of a removal/revocation, or would
 *  change under a hypothetical one (docs/sharing.md §Removals and downgrades: "removeCollaborator/
 *  revokeShareLink return the affected set by diffing the effective-role map captured before the
 *  change against the map recomputed after: each entry is an AffectedCollaborator carrying oldRole
 *  and newRole (with newRole === null meaning full removal)." — and §Preview and confirm: the same
 *  shape is what `previewRemoveCollaborator`/`previewRevokeShareLink` return before anything is
 *  actually changed). `newRole` uses `Schema.NullOr`, not `Schema.optional`, to encode "no access
 *  at all" as an explicit wire value rather than field absence — matching cloudflare-os's own
 *  `newRole === null` convention exactly instead of translating it through an `Option`-shaped
 *  optional field. */
export class AffectedCollaborator extends Schema.Class<AffectedCollaborator>(
  "AffectedCollaborator"
)({
  profileId: Email,
  workspaceId: EntityId,
  edges: Schema.Array(PermissionEdge),
  oldRole: Role,
  newRole: Schema.NullOr(Role)
}) {}

/** One row of a user's multi-workspace catalog listing — the plan's "multi-workspace in the User DO with
 *  the fixed-identity default 'Personal' workspace" (plan §Phased delivery, Phase 4), combined with
 *  this workspace's caller-specific effective `role` the same way `CollaboratorInfo` carries a
 *  live-computed role alongside a collaborator's stored edges. `isDefault` flags the fixed-identity
 *  "Personal" workspace every account is provisioned with — the one workspace a user can never leave or
 *  have removed from their own catalog, mirroring the owner-as-permanent-root discipline
 *  docs/sharing.md applies to `ownerProfileId` (§The owner as root), one level up at the
 *  catalog-entry granularity. */
export class WorkspaceCatalogEntry extends Schema.Class<WorkspaceCatalogEntry>("WorkspaceCatalogEntry")({
  workspaceId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  ownerId: Email,
  role: Role,
  isDefault: Schema.Boolean
}) {}
