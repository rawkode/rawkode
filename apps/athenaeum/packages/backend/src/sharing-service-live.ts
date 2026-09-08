// `SharingService` — the real port of cloudflare-os's `SharingManager`
// (`workshop-backend/src/sharing.ts`) onto workspaces, per docs/sharing.md. `gadget` -> `workspace`,
// `profile.id` -> `Email` (this codebase's sole account key, per `domain/src/auth.ts`'s header
// comment), `CollaboratorRecord`/`ShareLinkRecord`/`ShareKeyAliasRecord` -> the `domain/src/
// sharing.ts` schema classes the prerequisite stage already built (`Collaborator`, `ShareLink`,
// `ShareKeyRecord`). Backend-internal (not a domain `Context.Tag`), same placement rationale as
// `GraphService`/`NotesService`: real business logic — the fixed-point role-propagation algorithm,
// HMAC share-key hashing — that has no home in `domain`'s zero-CF, storage-agnostic package.
//
// Built once per `WorkspaceDurableObject` construction (`workspace-durable-object.ts`'s instance `Layer`),
// closing over that DO's own `SharingCollections` and `Singleton<WorkspaceMeta>` — mirrors every other
// `make*ServiceLive` in this package.
//
// Every method below cites the specific docs/sharing.md section/cloudflare-os method it ports;
// `computeEffectiveRoles` in particular is close to a line-by-line translation of `SharingManager
// .computeEffectiveRoles()` (see that method's own doc comment above its body).

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  AffectedCollaborator,
  Collaborator,
  CollaboratorInfo,
  Email,
  IsoDateTimeString,
  Role,
  ShareKeyHash,
  ShareLink,
  ShareKeyRecord,
  ShareLinkEdge,
  Unauthorized,
  UnexpectedError,
  UserEdge,
  ValidationError,
  WorkspaceAccessDenied,
  WorkspaceNotFound,
  type EntityId
} from "@athenaeum/domain"
import type { Singleton } from "@athenaeum/typed-storage-effect"
import {
  reviveCollaborator,
  reviveShareKeyRecord,
  reviveShareLink,
  toUnexpectedError,
  type SharingCollections
} from "./sharing-collections.js"
import type { WorkspaceMeta } from "./workspace-ownership.js"

// --- Role ordering (docs/sharing.md: "Roles are totally ordered: build > use.") ---------------

export const roleRank = (role: Role): number => (role === "build" ? 2 : 1)
export const maxRole = (a: Role, b: Role): Role => (roleRank(a) >= roleRank(b) ? a : b)
export const minRole = (a: Role, b: Role): Role => (roleRank(a) <= roleRank(b) ? a : b)

/** Per-call caller identity, mirroring cloudflare-os's own `SharingCaller` (`sharing.ts`:
 *  "profileId: the caller's profile.id (username/email)... isOwner: true if the caller is the
 *  gadget owner"). Resolved fresh, per call, via `SharingServiceApi#resolveCaller` — never cached
 *  across calls, since ownership/collaborator status can change between them. */
export interface SharingCaller {
  readonly email: Email
  readonly isOwner: boolean
}

/** The hypothetical-change inputs `computeEffectiveRoles` accepts, verbatim from docs/sharing.md
 *  §Effective-role algorithm's "Inputs (all optional; used to model a hypothetical change in
 *  preview)". */
export interface EffectiveRolesOptions {
  readonly removedUser?: Email
  readonly removedEdge?: { readonly target: Email; readonly sharer: Email }
  readonly revokedLinkId?: ShareKeyHash
  readonly overrides?: ReadonlyMap<Email, Role>
}

export interface SharingServiceApi {
  /** `null` if this workspace has never had `WorkspaceDurableObject#initializeOwner` called — docs/
   *  sharing.md's "an uninitialized or deleted gadget" case (§Authorization model). */
  readonly getOwnerEmail: Effect.Effect<Email | null, UnexpectedError>

  /** docs/sharing.md §Effective-role algorithm, verbatim (see this file's header comment). */
  readonly computeEffectiveRoles: (
    opts?: EffectiveRolesOptions
  ) => Effect.Effect<ReadonlyMap<Email, Role>, UnexpectedError>

  /** "The effective role of profileId... or undefined if the user has no access. The owner
   *  always has 'build'." (`SharingManager#getEffectiveRole`). */
  readonly getEffectiveRole: (email: Email) => Effect.Effect<Role | undefined, UnexpectedError>

  /**
   * Resolves `email`'s `SharingCaller` for THIS workspace — the real "who is this connection, for
   * sharing purposes" step docs/sharing.md's §Authorization model describes for `open()`: fails
   * `WorkspaceNotFound` if the workspace was never initialized, `WorkspaceAccessDenied` if it exists
   * but `email` has no reachable role in the graph and is not the owner. On success, the returned
   * `SharingCaller` is exactly what every collaborator-management method below expects.
   */
  readonly resolveCaller: (
    email: Email
  ) => Effect.Effect<SharingCaller, WorkspaceNotFound | WorkspaceAccessDenied | UnexpectedError>

  /**
   * The `use`/`build` capability gate (task item 7): fails `WorkspaceNotFound`/
   * `WorkspaceAccessDenied` exactly like `resolveCaller`, and additionally `Unauthorized` if
   * `email`'s effective role is strictly lower than `minRole`. Callers that want the
   * "anonymous/ungoverned workspace stays fully open" backward-compatibility carve-out (see
   * `workspace-durable-object.ts`'s `requireRoleForGovernedWorkspace`) check `getOwnerEmail`/anonymity
   * themselves before reaching for this — this method itself always enforces strictly.
   */
  readonly requireMinimumRole: (
    email: Email,
    minRole: Role
  ) => Effect.Effect<void, WorkspaceNotFound | WorkspaceAccessDenied | Unauthorized | UnexpectedError>

  /** docs/sharing.md §Adding collaborators / Direct add + §Collaborators ("A caller may never
   *  grant a role higher than their own effective role"). */
  readonly addCollaborator: (
    caller: SharingCaller,
    profileId: Email,
    role: Role,
    note?: string
  ) => Effect.Effect<CollaboratorInfo, ValidationError | Unauthorized | UnexpectedError>

  /** docs/sharing.md §Preview and confirm: "previewRemoveCollaborator()... returns the
   *  AffectedCollaborators whose access would change" — no storage mutation. */
  readonly previewRemoveCollaborator: (
    caller: SharingCaller,
    profileId: Email
  ) => Effect.Effect<ReadonlyArray<AffectedCollaborator>, UnexpectedError>

  /** docs/sharing.md §Lazy revocation ("Removing a collaborator... The owner severs all incoming
   *  edges to the target; a non-owner severs only their own user edge") + §keepUsers. */
  readonly removeCollaborator: (
    caller: SharingCaller,
    profileId: Email,
    keepUsers: ReadonlyArray<Email>
  ) => Effect.Effect<ReadonlyArray<AffectedCollaborator>, ValidationError | Unauthorized | UnexpectedError>

  /** docs/sharing.md §Collaborator management: currently-reachable collaborators only. */
  readonly listCollaborators: Effect.Effect<ReadonlyArray<CollaboratorInfo>, UnexpectedError>

  /** docs/sharing.md §Adding collaborators / Share link: mints the link's first key. Returns the
   *  raw key ONCE (never persisted — see `#mintKey`'s doc comment) alongside the stored `ShareLink`. */
  readonly createShareLink: (
    caller: SharingCaller,
    role: Role,
    note?: string
  ) => Effect.Effect<{ readonly key: string; readonly link: ShareLink }, Unauthorized | UnexpectedError>

  /**
   * docs/sharing.md §Adding collaborators / Share link ("redeemShareKey"): hashes `rawKey`, looks
   * up its link, and mints a `ShareLinkEdge` for `email` (creating their `Collaborator` record if
   * new). Deliberately collapses "unknown key" / "revoked link" / (already covered by the no-op
   * dedupe below) into the SAME `Unauthorized` failure — see `sharing-rpc.ts`'s
   * `RedeemShareLinkInput` doc comment: distinguishing them would leak whether a given key/link
   * ever existed to a caller who has no business knowing.
   */
  readonly redeemShareLink: (
    email: Email,
    rawKey: string
  ) => Effect.Effect<CollaboratorInfo, Unauthorized | UnexpectedError>

  /** docs/sharing.md §Preview and confirm, the share-link counterpart. */
  readonly previewRevokeShareLink: (
    caller: SharingCaller,
    linkId: ShareKeyHash
  ) => Effect.Effect<ReadonlyArray<AffectedCollaborator>, UnexpectedError>

  /** docs/sharing.md §Lazy revocation ("Revoking a share link sets the link's revoked flag... The
   *  link's copies are deleted outright"). */
  readonly revokeShareLink: (
    caller: SharingCaller,
    linkId: ShareKeyHash,
    keepUsers: ReadonlyArray<Email>
  ) => Effect.Effect<ReadonlyArray<AffectedCollaborator>, ValidationError | Unauthorized | UnexpectedError>

  /** docs/sharing.md §Share link management: active (non-revoked) links only. */
  readonly listShareLinks: Effect.Effect<ReadonlyArray<ShareLink>, UnexpectedError>
}

export class SharingService extends Context.Tag("@athenaeum/backend/SharingService")<
  SharingService,
  SharingServiceApi
>() {}

// --- Share-key HMAC hashing (docs/sharing.md §Adding collaborators / Share link's "Share key
// security" paragraph, `sharing.ts#hashShareKey`) --------------------------------------------
//
// "The server generates a random 128-bit key and stores only its HMAC-SHA-256 hash (using a fixed
// domain-separation constant)... the server cannot reconstruct share links from its stored data,
// and a database leak does not expose valid share keys." Reuses the exact `crypto.subtle`
// primitives `dev-auth.ts` already established as this codebase's HMAC discipline
// (`importKey("raw", ..., {name:"HMAC", hash:"SHA-256"}, false, [usage])`), applied here to a
// hash (not a signature): the raw key never crosses back out of this module except as the
// freshly-minted return value of `mintKey`, and NOTHING derived from stored state (a `ShareLink`
// or `ShareKeyRecord` row) can ever be run backward through this function to recover it — see
// `test/sharing-service.test.ts`'s "raw key is not reconstructible from stored state" suite for
// the empirical proof.
//
// This constant is a domain-separation value, not a secret (cloudflare-os's own comment on its
// identical constant: "Not secret -- it only provides personalization"). A fresh, Athenaeum-local
// 32-byte constant, deliberately distinct from cloudflare-os's own bytes and from `dev-auth.ts`'s
// signing secret (which IS secret, and configured per-deployment) — this one is safe to be a
// literal in source because its only job is namespacing this hash from any other HMAC use in this
// codebase, never keeping anything confidential.
const SHARE_KEY_HMAC_KEY = new Uint8Array([
  0x41, 0x74, 0x68, 0x65, 0x6e, 0x61, 0x65, 0x75, 0x6d, 0x2d, 0x73, 0x68, 0x61, 0x72, 0x65, 0x2d,
  0x6b, 0x65, 0x79, 0x2d, 0x68, 0x6d, 0x61, 0x63, 0x2d, 0x76, 0x31, 0x2d, 0xc0, 0xff, 0xee, 0x42
])

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const hexToBytes = (hex: string): Uint8Array => {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("not a valid hex string")
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

const importShareKeyHmacKey = (usage: "sign"): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", SHARE_KEY_HMAC_KEY, { name: "HMAC", hash: "SHA-256" }, false, [usage])

/** Computes the storage id (HMAC-SHA-256 hex) for a raw share key. The raw key is never stored —
 *  only this hash is (see this section's own header comment). Also the one place a malformed
 *  (non-hex) raw key is caught — `redeemShareLink` maps this failure to the same `Unauthorized`
 *  it uses for "unknown key", so a syntactically-invalid key behaves identically to a merely
 *  unrecognized one from the caller's point of view. */
const hashShareKey = (rawKeyHex: string): Effect.Effect<ShareKeyHash, UnexpectedError> =>
  Effect.tryPromise({
    try: async () => {
      const key = await importShareKeyHmacKey("sign")
      const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, hexToBytes(rawKeyHex)))
      return Schema.decodeUnknownSync(ShareKeyHash)(bytesToHex(signature))
    },
    catch: (cause) => new UnexpectedError({ message: `failed to hash share key: ${String(cause)}` })
  })

/** Generates a fresh random 128-bit raw key (hex-encoded, so it round-trips cleanly through the
 *  `Schema.String` wire type `sharing-rpc.ts#CreateShareLinkOutput.key` uses — see `ShareKeyHash`'s
 *  own doc comment for why the raw key never gets a domain schema of its own) and its hash. The
 *  caller decides whether the returned hash keys a link (`createShareLink`) or an alias
 *  (`newShareLinkKey`, not built this stage — no "copy an existing link" RPC method was requested,
 *  only mint-first-key/redeem/revoke; the `shareKeys.byLinkId` alias-index machinery is still real
 *  and tested via direct collection use in `test/sharing-service.test.ts`, ready for that method
 *  to be added later without any storage-shape change). */
const mintKey = (): Effect.Effect<{ readonly key: string; readonly hash: ShareKeyHash }, UnexpectedError> =>
  Effect.gen(function* () {
    const rawBytes = new Uint8Array(16)
    crypto.getRandomValues(rawBytes)
    const key = bytesToHex(rawBytes)
    const hash = yield* hashShareKey(key)
    return { key, hash }
  })

// --- Live implementation -------------------------------------------------------------------

const nowIso = (): IsoDateTimeString => Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())

const toUnexpectedFromStorageError = (error: { readonly message: string }): UnexpectedError =>
  new UnexpectedError({ message: error.message })

export const makeSharingServiceLive = (
  collections: SharingCollections,
  workspaceMeta: Singleton<WorkspaceMeta>,
  workspaceId: EntityId
): Layer.Layer<SharingService> =>
  Layer.succeed(SharingService, {
    get getOwnerEmail(): Effect.Effect<Email | null, UnexpectedError> {
      return workspaceMeta.get().pipe(
        Effect.mapError(toUnexpectedFromStorageError),
        Effect.flatMap((meta) =>
          meta.ownerEmail === null
            ? Effect.succeed(null)
            : Schema.decodeUnknown(Email)(meta.ownerEmail).pipe(
                Effect.mapError(
                  () => new UnexpectedError({ message: `corrupt stored workspace owner email: ${meta.ownerEmail}` })
                )
              )
        )
      )
    },

    computeEffectiveRoles(
      opts: EffectiveRolesOptions = {}
    ): Effect.Effect<ReadonlyMap<Email, Role>, UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const ownerEmail = yield* self.getOwnerEmail
        const removedUser = opts.removedUser
        const removedEdge = opts.removedEdge
        const revokedLinkId = opts.revokedLinkId

        // Step 2 (docs/sharing.md §Effective-role algorithm): linkId -> {creator, role}, skipping
        // revoked links (persisted OR the hypothetical `revokedLinkId`).
        const rawLinks = yield* collections.shareLinks.list().pipe(Effect.mapError(toUnexpectedError))
        const links = yield* Effect.forEach(rawLinks, reviveShareLink)
        const linkInfo = new Map<ShareKeyHash, { creator: Email; role: Role }>()
        for (const link of links) {
          if (link.id === revokedLinkId || link.revoked) continue
          linkInfo.set(link.id, { creator: link.creatorId, role: link.role })
        }

        // Step 1: all collaborators except the (hypothetically) removed user.
        const rawCollabs = yield* collections.collaborators.list().pipe(Effect.mapError(toUnexpectedError))
        const collabRecords = yield* Effect.forEach(rawCollabs, reviveCollaborator)
        const allCollabs = new Map<Email, Collaborator>()
        for (const record of collabRecords) {
          if (record.profileId !== removedUser) allCollabs.set(record.profileId, record)
        }

        // Step 3: initialize with overrides.
        const eff = new Map<Email, Role>(opts.overrides ?? [])

        // The owner is the implicit root at "build" (§The owner as root); any other id's current
        // known role, or undefined if not yet reached.
        const sharerRole = (id: Email): Role | undefined => (id === ownerEmail ? "build" : eff.get(id))

        // Step 4-5: fixed-point iteration. Roles only ever increase, so this converges.
        let changed = true
        while (changed) {
          changed = false
          for (const [id, record] of allCollabs) {
            let best = eff.get(id)
            for (const edge of record.edges) {
              let granted: Role | undefined
              if (edge.type === "shareLink") {
                const info = linkInfo.get(edge.linkId)
                if (info === undefined) continue // link revoked or unknown
                const creatorRole = sharerRole(info.creator)
                if (creatorRole === undefined) continue
                granted = minRole(info.role, creatorRole)
              } else {
                // Skip the specifically-removed edge (the `previewRemoveCollaborator`
                // non-owner-caller hypothetical).
                if (removedEdge !== undefined && id === removedEdge.target && edge.sharerId === removedEdge.sharer) {
                  continue
                }
                if (edge.sharerId === removedUser) continue
                const upstream = sharerRole(edge.sharerId)
                if (upstream === undefined) continue
                granted = minRole(edge.role, upstream)
              }
              if (granted !== undefined && (best === undefined || roleRank(granted) > roleRank(best))) {
                best = granted
              }
            }
            if (best !== undefined && best !== eff.get(id)) {
              eff.set(id, best)
              changed = true
            }
          }
        }

        // Step 6.
        return eff
      })
    },

    getEffectiveRole(email: Email): Effect.Effect<Role | undefined, UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const ownerEmail = yield* self.getOwnerEmail
        if (email === ownerEmail) return "build" as Role
        const roles = yield* self.computeEffectiveRoles()
        return roles.get(email)
      })
    },

    resolveCaller(
      email: Email
    ): Effect.Effect<SharingCaller, WorkspaceNotFound | WorkspaceAccessDenied | UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const ownerEmail = yield* self.getOwnerEmail
        if (ownerEmail === null) return yield* Effect.fail(new WorkspaceNotFound({ workspaceId }))
        if (email === ownerEmail) return { email, isOwner: true }
        const roles = yield* self.computeEffectiveRoles()
        if (roles.get(email) === undefined) return yield* Effect.fail(new WorkspaceAccessDenied({ workspaceId }))
        return { email, isOwner: false }
      })
    },

    requireMinimumRole(
      email: Email,
      minRole_: Role
    ): Effect.Effect<void, WorkspaceNotFound | WorkspaceAccessDenied | Unauthorized | UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const caller = yield* self.resolveCaller(email)
        if (caller.isOwner) return
        const role = yield* self.getEffectiveRole(email)
        // `resolveCaller` already guarantees `role !== undefined` for a non-owner at this point.
        if (role !== undefined && roleRank(role) < roleRank(minRole_)) {
          return yield* Effect.fail(
            new Unauthorized({ message: `This action requires "${minRole_}" access; you have "${role}".` })
          )
        }
      })
    },

    addCollaborator(
      caller: SharingCaller,
      profileId: Email,
      role: Role,
      note?: string
    ): Effect.Effect<CollaboratorInfo, ValidationError | Unauthorized | UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const ownerEmail = yield* self.getOwnerEmail
        // "Don't add the owner as a collaborator" (SharingManager#addCollaborator).
        if (profileId === ownerEmail) {
          return yield* Effect.fail(
            new ValidationError({ message: "Cannot add the workspace owner as a collaborator." })
          )
        }

        const callerRole = yield* requireCallerRole(self, caller)
        if (roleRank(role) > roleRank(callerRole)) {
          return yield* Effect.fail(new Unauthorized({ message: "You cannot grant a role higher than your own." }))
        }

        const existingRaw = yield* collections.collaborators.get(profileId).pipe(Effect.mapError(toUnexpectedError))
        const timestamp = nowIso()

        let edges: ReadonlyArray<Collaborator["edges"][number]>
        if (existingRaw !== undefined) {
          const existing = yield* reviveCollaborator(existingRaw)
          const existingEdgeIndex = existing.edges.findIndex(
            (edge) => edge.type === "user" && edge.sharerId === caller.email
          )
          if (existingEdgeIndex >= 0) {
            // Upgrade in place — never silently downgrade an existing edge's role.
            const existingEdge = existing.edges[existingEdgeIndex] as UserEdge
            const upgraded = new UserEdge({
              type: "user",
              sharerId: caller.email,
              role: maxRole(existingEdge.role, role),
              timestamp: existingEdge.timestamp,
              note: note ?? existingEdge.note
            })
            edges = existing.edges.map((edge, index) => (index === existingEdgeIndex ? upgraded : edge))
          } else {
            edges = [...existing.edges, new UserEdge({ type: "user", sharerId: caller.email, role, timestamp, note })]
          }
        } else {
          edges = [new UserEdge({ type: "user", sharerId: caller.email, role, timestamp, note })]
        }

        const record = new Collaborator({ profileId, workspaceId, edges })
        yield* collections.collaborators.put(record).pipe(Effect.mapError(toUnexpectedError))

        const roles = yield* self.computeEffectiveRoles()
        return new CollaboratorInfo({ profileId, workspaceId, edges, role: roles.get(profileId) ?? role })
      })
    },

    previewRemoveCollaborator(
      caller: SharingCaller,
      profileId: Email
    ): Effect.Effect<ReadonlyArray<AffectedCollaborator>, UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const existingRaw = yield* collections.collaborators.get(profileId).pipe(Effect.mapError(toUnexpectedError))
        if (existingRaw === undefined) return []

        const baseline = yield* self.computeEffectiveRoles()
        const modified = caller.isOwner
          ? yield* self.computeEffectiveRoles({ removedUser: profileId })
          : yield* self.computeEffectiveRoles({ removedEdge: { target: profileId, sharer: caller.email } })
        return yield* computeAffected(collections, workspaceId, baseline, modified)
      })
    },

    removeCollaborator(
      caller: SharingCaller,
      profileId: Email,
      keepUsers: ReadonlyArray<Email>
    ): Effect.Effect<ReadonlyArray<AffectedCollaborator>, ValidationError | Unauthorized | UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const existingRaw = yield* collections.collaborators.get(profileId).pipe(Effect.mapError(toUnexpectedError))
        if (existingRaw === undefined) {
          return yield* Effect.fail(new ValidationError({ message: "User is not a collaborator." }))
        }
        const existing = yield* reviveCollaborator(existingRaw)

        // Permission check (§Non-owner removal): owner removes anyone; a non-owner only their own edge.
        if (!caller.isOwner) {
          const hasEdgeFromCaller = existing.edges.some(
            (edge) => edge.type === "user" && edge.sharerId === caller.email
          )
          if (!hasEdgeFromCaller) {
            return yield* Effect.fail(new Unauthorized({ message: "You can only remove users that you added." }))
          }
        }

        const baseline = yield* self.computeEffectiveRoles()

        // §Lazy revocation: sever only the edges granting access, retain the record.
        const newEdges = caller.isOwner
          ? []
          : existing.edges.filter((edge) => !(edge.type === "user" && edge.sharerId === caller.email))
        yield* collections.collaborators
          .put(new Collaborator({ profileId, workspaceId, edges: newEdges }))
          .pipe(Effect.mapError(toUnexpectedError))

        yield* reRootKeptUsers(self, collections, workspaceId, caller, baseline, new Set(keepUsers))

        const after = yield* self.computeEffectiveRoles()
        return yield* computeAffected(collections, workspaceId, baseline, after)
      })
    },

    get listCollaborators(): Effect.Effect<ReadonlyArray<CollaboratorInfo>, UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const roles = yield* self.computeEffectiveRoles()
        const rawCollabs = yield* collections.collaborators.list().pipe(Effect.mapError(toUnexpectedError))
        const records = yield* Effect.forEach(rawCollabs, reviveCollaborator)
        const result: Array<CollaboratorInfo> = []
        for (const record of records) {
          const role = roles.get(record.profileId)
          if (role === undefined) continue // not currently reachable from the owner
          result.push(new CollaboratorInfo({ profileId: record.profileId, workspaceId, edges: record.edges, role }))
        }
        return result
      })
    },

    createShareLink(
      caller: SharingCaller,
      role: Role,
      note?: string
    ): Effect.Effect<{ readonly key: string; readonly link: ShareLink }, Unauthorized | UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const callerRole = yield* requireCallerRole(self, caller)
        if (roleRank(role) > roleRank(callerRole)) {
          return yield* Effect.fail(new Unauthorized({ message: "You cannot grant a role higher than your own." }))
        }

        const { key, hash } = yield* mintKey()
        const link = new ShareLink({
          id: hash,
          workspaceId,
          creatorId: caller.email,
          role,
          revoked: false,
          createdAt: nowIso()
        })
        yield* collections.shareLinks.put(link).pipe(Effect.mapError(toUnexpectedError))
        yield* collections.shareKeys
          .put(new ShareKeyRecord({ hash, linkId: hash, alias: false }))
          .pipe(Effect.mapError(toUnexpectedError))
        // `note` is accepted (matches `CreateShareLinkInput`) but has no storage field on
        // `ShareLink` in this task's requested schema shape (sharing.ts's own `ShareLink` class
        // carries no `note` — unlike cloudflare-os's `ShareLinkRecord.note`); silently unused
        // rather than a schema change out of this stage's scope.
        void note
        return { key, link }
      })
    },

    redeemShareLink(email: Email, rawKey: string): Effect.Effect<CollaboratorInfo, Unauthorized | UnexpectedError> {
      const self = this as SharingServiceApi
      const invalidKey = new Unauthorized({ message: "Invalid or revoked share key." })
      return Effect.gen(function* () {
        const hash = yield* hashShareKey(rawKey).pipe(Effect.mapError(() => invalidKey))
        const keyRecordRaw = yield* collections.shareKeys.get(hash).pipe(Effect.mapError(toUnexpectedError))
        if (keyRecordRaw === undefined) return yield* Effect.fail(invalidKey)
        const keyRecord = yield* reviveShareKeyRecord(keyRecordRaw)

        const linkRaw = yield* collections.shareLinks.get(keyRecord.linkId).pipe(Effect.mapError(toUnexpectedError))
        if (linkRaw === undefined) return yield* Effect.fail(invalidKey)
        const link = yield* reviveShareLink(linkRaw)
        if (link.revoked) return yield* Effect.fail(invalidKey)

        const existingRaw = yield* collections.collaborators.get(email).pipe(Effect.mapError(toUnexpectedError))
        const timestamp = nowIso()

        let edges: ReadonlyArray<Collaborator["edges"][number]>
        if (existingRaw !== undefined) {
          const existing = yield* reviveCollaborator(existingRaw)
          const alreadyHasEdge = existing.edges.some((edge) => edge.type === "shareLink" && edge.linkId === link.id)
          edges = alreadyHasEdge
            ? existing.edges
            : [...existing.edges, new ShareLinkEdge({ type: "shareLink", linkId: link.id, timestamp })]
          if (!alreadyHasEdge) {
            yield* collections.collaborators
              .put(new Collaborator({ profileId: email, workspaceId, edges }))
              .pipe(Effect.mapError(toUnexpectedError))
          }
        } else {
          edges = [new ShareLinkEdge({ type: "shareLink", linkId: link.id, timestamp })]
          yield* collections.collaborators
            .put(new Collaborator({ profileId: email, workspaceId, edges }))
            .pipe(Effect.mapError(toUnexpectedError))
        }

        const roles = yield* self.computeEffectiveRoles()
        return new CollaboratorInfo({ profileId: email, workspaceId, edges, role: roles.get(email) ?? link.role })
      })
    },

    previewRevokeShareLink(
      caller: SharingCaller,
      linkId: ShareKeyHash
    ): Effect.Effect<ReadonlyArray<AffectedCollaborator>, UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const linkRaw = yield* collections.shareLinks.get(linkId).pipe(Effect.mapError(toUnexpectedError))
        if (linkRaw === undefined) return []
        const link = yield* reviveShareLink(linkRaw)
        if (!caller.isOwner && link.creatorId !== caller.email) return []
        if (link.revoked) return []

        const baseline = yield* self.computeEffectiveRoles()
        const modified = yield* self.computeEffectiveRoles({ revokedLinkId: linkId })
        return yield* computeAffected(collections, workspaceId, baseline, modified)
      })
    },

    revokeShareLink(
      caller: SharingCaller,
      linkId: ShareKeyHash,
      keepUsers: ReadonlyArray<Email>
    ): Effect.Effect<ReadonlyArray<AffectedCollaborator>, ValidationError | Unauthorized | UnexpectedError> {
      const self = this as SharingServiceApi
      return Effect.gen(function* () {
        const linkRaw = yield* collections.shareLinks.get(linkId).pipe(Effect.mapError(toUnexpectedError))
        if (linkRaw === undefined) return yield* Effect.fail(new ValidationError({ message: "Share link not found." }))
        const link = yield* reviveShareLink(linkRaw)
        if (!caller.isOwner && link.creatorId !== caller.email) {
          return yield* Effect.fail(
            new Unauthorized({ message: "You can only revoke share links that you created." })
          )
        }

        const baseline = yield* self.computeEffectiveRoles()

        yield* collections.shareLinks
          .put(new ShareLink({ ...link, revoked: true }))
          .pipe(Effect.mapError(toUnexpectedError))
        // "The link's copies are deleted outright, since no edge ever references an alias."
        yield* collections.shareKeys.byLinkId.delete(linkId).pipe(Effect.mapError(toUnexpectedError))

        yield* reRootKeptUsers(self, collections, workspaceId, caller, baseline, new Set(keepUsers))

        const after = yield* self.computeEffectiveRoles()
        return yield* computeAffected(collections, workspaceId, baseline, after)
      })
    },

    get listShareLinks(): Effect.Effect<ReadonlyArray<ShareLink>, UnexpectedError> {
      return Effect.gen(function* () {
        const rawLinks = yield* collections.shareLinks.list().pipe(Effect.mapError(toUnexpectedError))
        const links = yield* Effect.forEach(rawLinks, reviveShareLink)
        return links.filter((link) => !link.revoked)
      })
    }
  })

// --- Shared helpers (module-private; mirror `SharingManager`'s own private methods) -----------

/** "The caller's effective role, throwing if the caller has no access at all" (`SharingManager
 *  #requireCallerRole`) — a `SharingCaller` is only ever constructed by `resolveCaller`, which
 *  already guarantees a non-owner caller has SOME role, so this failure path is a defensive
 *  belt-and-braces re-check, not the primary gate. */
const requireCallerRole = (
  self: SharingServiceApi,
  caller: SharingCaller
): Effect.Effect<Role, Unauthorized | UnexpectedError> =>
  caller.isOwner
    ? Effect.succeed("build" as Role)
    : self.computeEffectiveRoles().pipe(
        Effect.flatMap((roles) => {
          const role = roles.get(caller.email)
          return role === undefined
            ? Effect.fail(new Unauthorized({ message: "You do not have permission to share this workspace." }))
            : Effect.succeed(role)
        })
      )

/** `SharingManager#computeAffected`: diffs two effective-role maps, returning the collaborators
 *  whose access changed (lost entirely, `newRole: null`, or downgraded). Reads current storage
 *  for each affected id's `edges` — the same snapshot `listCollaborators` reads from. */
const computeAffected = (
  collections: SharingCollections,
  workspaceId: EntityId,
  baseline: ReadonlyMap<Email, Role>,
  modified: ReadonlyMap<Email, Role>
): Effect.Effect<ReadonlyArray<AffectedCollaborator>, UnexpectedError> =>
  Effect.gen(function* () {
    const result: Array<AffectedCollaborator> = []
    for (const [id, oldRole] of baseline) {
      const newRole = modified.get(id) ?? null
      if (newRole !== null && roleRank(newRole) >= roleRank(oldRole)) continue // unchanged/upgraded
      const raw = yield* collections.collaborators.get(id).pipe(Effect.mapError(toUnexpectedError))
      if (raw === undefined) continue
      const record = yield* reviveCollaborator(raw)
      result.push(new AffectedCollaborator({ profileId: id, workspaceId, edges: record.edges, oldRole, newRole }))
    }
    return result
  })

/** `SharingManager#reRootKeptUsers`: optional `keepUsers` re-rooting sugar (§keepUsers). Must run
 *  AFTER the edge/key has already been severed in storage — reads `baseline` (captured before the
 *  severance) to know each kept user's PRIOR role, and the post-severance graph to know who
 *  actually needs rescuing. */
const reRootKeptUsers = (
  self: SharingServiceApi,
  collections: SharingCollections,
  workspaceId: EntityId,
  caller: SharingCaller,
  baseline: ReadonlyMap<Email, Role>,
  keepSet: ReadonlySet<Email>
): Effect.Effect<void, Unauthorized | UnexpectedError> =>
  Effect.gen(function* () {
    if (keepSet.size === 0) return

    const callerRole = yield* requireCallerRole(self, caller)
    const afterSever = yield* self.computeEffectiveRoles()

    for (const id of keepSet) {
      const prior = baseline.get(id)
      if (prior === undefined) continue // had no access to begin with

      const now = afterSever.get(id)
      if (now !== undefined && roleRank(now) >= roleRank(prior)) continue // not dropped

      const raw = yield* collections.collaborators.get(id).pipe(Effect.mapError(toUnexpectedError))
      if (raw === undefined) continue
      const record = yield* reviveCollaborator(raw)
      const edges = [
        ...record.edges,
        new UserEdge({
          type: "user",
          sharerId: caller.email,
          role: minRole(prior, callerRole),
          timestamp: nowIso()
        })
      ]
      yield* collections.collaborators
        .put(new Collaborator({ profileId: id, workspaceId, edges }))
        .pipe(Effect.mapError(toUnexpectedError))
    }
  })
