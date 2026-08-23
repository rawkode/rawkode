// Real, end-to-end coverage for the Phase 4 `SharingService` stage — the docs/sharing.md port
// (see `sharing-service-live.ts`'s own header comment). Every test here exercises real code: real
// `POST /api/dev/sign-in` round trips for distinct authenticated identities, real
// `UserDurableObject#createWorkspace` (so the workspace under test has a REAL initialized owner — see
// `workspace-durable-object.ts`'s `requireRoleForGovernedWorkspace` doc comment for why that matters),
// real Cap'n Web RPC over real WebSocket sessions against `WorkspaceDurableObject`, and real
// `crypto.subtle` HMAC hashing for share keys — nothing mocked.

import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AddCollaboratorInput,
  AddCollaboratorOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreateShareLinkInput,
  CreateShareLinkOutput,
  CreateTagInput,
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
  ListCollaboratorsOutput,
  ListNodesInput,
  ListNodesOutput,
  ListShareLinksOutput,
  PreviewRemoveCollaboratorInput,
  PreviewRemoveCollaboratorOutput,
  PreviewRevokeShareLinkInput,
  PreviewRevokeShareLinkOutput,
  RedeemShareLinkInput,
  RedeemShareLinkOutput,
  RemoveCollaboratorInput,
  RemoveCollaboratorOutput,
  RevokeShareLinkInput,
  RevokeShareLinkOutput,
  RunViewInput,
  RunViewOutput,
  ViewSpec,
  type EntityId
} from "@athenaeum/domain"
import {
  connectToUserAs,
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub,
  type WorkspaceApi
} from "./support.js"
import type { RpcStub } from "capnweb"

const freshEmail = (label: string): string => `sharing-${label}-${crypto.randomUUID()}@rawkode.academy`

/** Signs in a fresh account and creates a brand-new, non-default workspace it owns via the real
 *  `UserDurableObject#createWorkspace` round trip — a REAL initialized owner (`initializeOwner` was
 *  really called), which is what makes this workspace "governed" per `requireRoleForGovernedWorkspace`'s
 *  own doc comment (distinct from a bare `freshWorkspaceId()` workspace, which stays fully open/ungoverned
 *  — see this file's own "backward compatibility" suite below). */
const createGovernedWorkspace = async (
  ownerEmail: string
): Promise<{ workspaceId: EntityId; ownerCredential: string }> => {
  const { credential } = await devSignIn(ownerEmail)
  const { stub, socket } = await connectToUserAs(credential)
  try {
    const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
      await stub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title: "Shared workspace" })))
    )
    return { workspaceId: created.workspace.workspaceId, ownerCredential: credential }
  } finally {
    stub[Symbol.dispose]()
    socket.close()
  }
}

const addCollaborator = async (
  stub: RpcStub<WorkspaceApi>,
  workspaceId: EntityId,
  profileId: string,
  role: "build" | "use",
  note?: string
) =>
  Schema.decodeUnknownSync(AddCollaboratorOutput)(
    await stub.addCollaborator(
      Schema.encodeSync(AddCollaboratorInput)(new AddCollaboratorInput({ workspaceId, profileId: profileId as never, role, note }))
    )
  )

const listCollaborators = async (stub: RpcStub<WorkspaceApi>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(ListCollaboratorsOutput)(await stub.listCollaborators({ workspaceId })).collaborators

const previewRemoveCollaborator = async (stub: RpcStub<WorkspaceApi>, workspaceId: EntityId, profileId: string) =>
  Schema.decodeUnknownSync(PreviewRemoveCollaboratorOutput)(
    await stub.previewRemoveCollaborator(
      Schema.encodeSync(PreviewRemoveCollaboratorInput)(
        new PreviewRemoveCollaboratorInput({ workspaceId, profileId: profileId as never })
      )
    )
  ).affected

const removeCollaborator = async (
  stub: RpcStub<WorkspaceApi>,
  workspaceId: EntityId,
  profileId: string,
  keepUsers?: ReadonlyArray<string>
) =>
  Schema.decodeUnknownSync(RemoveCollaboratorOutput)(
    await stub.removeCollaborator(
      Schema.encodeSync(RemoveCollaboratorInput)(
        new RemoveCollaboratorInput({ workspaceId, profileId: profileId as never, keepUsers: keepUsers as never })
      )
    )
  ).affected

describe("SharingService: Bob/Carol lazy revocation (docs/sharing.md's own worked example)", () => {
  it(
    "owner shares with Bob, Bob shares with Carol; removing Bob makes Carol unreachable with " +
      "ZERO explicit cleanup, and re-adding Bob restores Carol's access with ZERO extra steps",
    async () => {
      const ownerEmail = freshEmail("owner")
      const bobEmail = freshEmail("bob")
      const carolEmail = freshEmail("carol")

      const { workspaceId, ownerCredential } = await createGovernedWorkspace(ownerEmail)
      const { credential: bobCredential } = await devSignIn(bobEmail)

      const owner = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
      try {
        // Owner directly adds Bob at "build".
        const bobAdd = await addCollaborator(owner.stub, workspaceId, bobEmail, "build")
        expect(bobAdd.collaborator.role).toBe("build")
        expect(listNamesOf(await listCollaborators(owner.stub, workspaceId))).toEqual([bobEmail])

        // Bob (now a real build collaborator) adds Carol.
        const bob = await connectToWorkspaceWithSocketAs(workspaceId, bobCredential)
        try {
          const carolAdd = await addCollaborator(bob.stub, workspaceId, carolEmail, "build")
          expect(carolAdd.collaborator.role).toBe("build")
        } finally {
          bob.stub[Symbol.dispose]()
          bob.socket.close()
        }

        // Both Bob and Carol are now reachable from the owner.
        let names = listNamesOf(await listCollaborators(owner.stub, workspaceId))
        expect(names.sort()).toEqual([bobEmail, carolEmail].sort())

        // Preview: removing Bob would ALSO cut off Carol (docs/sharing.md §Preview and confirm).
        const preview = await previewRemoveCollaborator(owner.stub, workspaceId, bobEmail)
        const previewNames = preview.map((a) => a.profileId).sort()
        expect(previewNames).toEqual([bobEmail, carolEmail].sort())
        for (const affected of preview) {
          expect(affected.newRole).toBeNull()
        }

        // Confirm: owner removes Bob. This severs ONLY the owner->Bob edge — Bob's own
        // Bob->Carol edge is never touched (docs/sharing.md §Lazy revocation: "the edges where
        // the target is the sharer of access to others are left untouched").
        const affected = await removeCollaborator(owner.stub, workspaceId, bobEmail)
        expect(affected.map((a) => a.profileId).sort()).toEqual([bobEmail, carolEmail].sort())

        // Carol is unreachable now — ZERO explicit cleanup of the Bob->Carol edge was needed.
        names = listNamesOf(await listCollaborators(owner.stub, workspaceId))
        expect(names).toEqual([])

        // Re-adding Bob restores BOTH Bob and Carol — ZERO extra steps for Carol.
        await addCollaborator(owner.stub, workspaceId, bobEmail, "build")
        names = listNamesOf(await listCollaborators(owner.stub, workspaceId))
        expect(names.sort()).toEqual([bobEmail, carolEmail].sort())
      } finally {
        owner.stub[Symbol.dispose]()
        owner.socket.close()
      }
    }
  )
})

const listNamesOf = (collaborators: ReadonlyArray<{ readonly profileId: string }>): ReadonlyArray<string> =>
  collaborators.map((c) => c.profileId)

describe("SharingService: share keys are never reconstructible from stored state", () => {
  it(
    "the raw share key returned once at mint time never appears anywhere in the server's " +
      "persisted rows, and a byte-flipped guess of it is rejected",
    async () => {
      const ownerEmail = freshEmail("owner")
      const { workspaceId, ownerCredential } = await createGovernedWorkspace(ownerEmail)
      const owner = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
      try {
        const created = Schema.decodeUnknownSync(CreateShareLinkOutput)(
          await owner.stub.createShareLink(
            Schema.encodeSync(CreateShareLinkInput)(new CreateShareLinkInput({ workspaceId, role: "use" }))
          )
        )
        const rawKey = created.key
        const linkId = created.link.id

        // Structural sanity: a 128-bit raw key (32 hex chars) is a different shape entirely from
        // a SHA-256 hash (64 hex chars) — the two could never be confused for each other.
        expect(rawKey).toMatch(/^[0-9a-f]{32}$/)
        expect(linkId).toMatch(/^[0-9a-f]{64}$/)

        // The real proof: dump every row the server actually persisted for share keys and
        // confirm the raw key is NOT among them, in any field, anywhere — only its hash is.
        const rows = await workspaceDurableObjectStub(workspaceId).debugListShareKeyRows()
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
          expect(row.hash).not.toBe(rawKey)
          expect(row.linkId).not.toBe(rawKey)
          expect(row.hash.includes(rawKey)).toBe(false)
          expect(row.linkId.includes(rawKey)).toBe(false)
        }
        // And the link's own stored metadata carries no trace of the raw key either.
        const linkRow = rows.find((r) => r.hash === linkId)
        expect(linkRow).toBeDefined()
        expect(linkRow?.alias).toBe(false)

        // The real key redeems successfully...
        const bobEmail = freshEmail("bob")
        const { credential: bobCredential } = await devSignIn(bobEmail)
        const bob = await connectToWorkspaceWithSocketAs(workspaceId, bobCredential)
        try {
          const redeemed = Schema.decodeUnknownSync(RedeemShareLinkOutput)(
            await bob.stub.redeemShareLink(
              Schema.encodeSync(RedeemShareLinkInput)(new RedeemShareLinkInput({ workspaceId, key: rawKey }))
            )
          )
          expect(redeemed.collaborator.role).toBe("use")
        } finally {
          bob.stub[Symbol.dispose]()
          bob.socket.close()
        }

        // ...but a guessed key that merely LOOKS similar (one hex character flipped) does not —
        // proving the check is a real cryptographic hash comparison, not a prefix/substring test.
        const flippedChar = rawKey[0] === "0" ? "1" : "0"
        const guessedKey = flippedChar + rawKey.slice(1)
        const strangerEmail = freshEmail("stranger")
        const { credential: strangerCredential } = await devSignIn(strangerEmail)
        const stranger = await connectToWorkspaceWithSocketAs(workspaceId, strangerCredential)
        try {
          const error = await rejectionToDomainError(
            stranger.stub.redeemShareLink(
              Schema.encodeSync(RedeemShareLinkInput)(new RedeemShareLinkInput({ workspaceId, key: guessedKey }))
            )
          )
          expect(error._tag).toBe("Unauthorized")
        } finally {
          stranger.stub[Symbol.dispose]()
          stranger.socket.close()
        }
      } finally {
        owner.stub[Symbol.dispose]()
        owner.socket.close()
      }
    }
  )
})

describe("SharingService: share link lazy revocation + preview", () => {
  it("revoking a share link denies future redemption and cuts off everyone who redeemed it", async () => {
    const ownerEmail = freshEmail("owner")
    const { workspaceId, ownerCredential } = await createGovernedWorkspace(ownerEmail)
    const owner = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
    try {
      const created = Schema.decodeUnknownSync(CreateShareLinkOutput)(
        await owner.stub.createShareLink(
          Schema.encodeSync(CreateShareLinkInput)(new CreateShareLinkInput({ workspaceId, role: "use" }))
        )
      )

      const daveEmail = freshEmail("dave")
      const { credential: daveCredential } = await devSignIn(daveEmail)
      const dave = await connectToWorkspaceWithSocketAs(workspaceId, daveCredential)
      try {
        await dave.stub.redeemShareLink(
          Schema.encodeSync(RedeemShareLinkInput)(new RedeemShareLinkInput({ workspaceId, key: created.key }))
        )
      } finally {
        dave.stub[Symbol.dispose]()
        dave.socket.close()
      }

      expect(listNamesOf(await listCollaborators(owner.stub, workspaceId))).toEqual([daveEmail])

      const preview = Schema.decodeUnknownSync(PreviewRevokeShareLinkOutput)(
        await owner.stub.previewRevokeShareLink(
          Schema.encodeSync(PreviewRevokeShareLinkInput)(
            new PreviewRevokeShareLinkInput({ workspaceId, linkId: created.link.id })
          )
        )
      ).affected
      expect(preview.map((a) => a.profileId)).toEqual([daveEmail])

      const revoked = Schema.decodeUnknownSync(RevokeShareLinkOutput)(
        await owner.stub.revokeShareLink(
          Schema.encodeSync(RevokeShareLinkInput)(new RevokeShareLinkInput({ workspaceId, linkId: created.link.id }))
        )
      ).affected
      expect(revoked.map((a) => a.profileId)).toEqual([daveEmail])
      expect(revoked[0]?.newRole).toBeNull()

      // Dave is unreachable now, with zero explicit cleanup beyond the `revoked` flag flip.
      expect(listNamesOf(await listCollaborators(owner.stub, workspaceId))).toEqual([])

      // The revoked link's key can no longer be redeemed at all.
      const strangerEmail = freshEmail("stranger")
      const { credential: strangerCredential } = await devSignIn(strangerEmail)
      const stranger = await connectToWorkspaceWithSocketAs(workspaceId, strangerCredential)
      try {
        const error = await rejectionToDomainError(
          stranger.stub.redeemShareLink(
            Schema.encodeSync(RedeemShareLinkInput)(new RedeemShareLinkInput({ workspaceId, key: created.key }))
          )
        )
        expect(error._tag).toBe("Unauthorized")
      } finally {
        stranger.stub[Symbol.dispose]()
        stranger.socket.close()
      }

      // Active (non-revoked) share links no longer include the revoked one.
      const activeLinks = Schema.decodeUnknownSync(ListShareLinksOutput)(await owner.stub.listShareLinks({ workspaceId }))
        .shareLinks
      expect(activeLinks.some((l) => l.id === created.link.id)).toBe(false)
    } finally {
      owner.stub[Symbol.dispose]()
      owner.socket.close()
    }
  })
})

describe("SharingService: use/build role gating on representative pre-existing RPC methods", () => {
  it("a use-role collaborator can listNodes/runView but is denied createNode (Unauthorized)", async () => {
    const ownerEmail = freshEmail("owner")
    const useEmail = freshEmail("use-role")
    const { workspaceId, ownerCredential } = await createGovernedWorkspace(ownerEmail)

    const owner = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
    try {
      await addCollaborator(owner.stub, workspaceId, useEmail, "use")
    } finally {
      owner.stub[Symbol.dispose]()
      owner.socket.close()
    }

    const { credential: useCredential } = await devSignIn(useEmail)
    const useConn = await connectToWorkspaceWithSocketAs(workspaceId, useCredential)
    try {
      // Allowed: `use` meets the `use` minimum.
      const listed = Schema.decodeUnknownSync(ListNodesOutput)(
        await useConn.stub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
      )
      expect(listed.nodes).toEqual([])

      const viewSpec = new ViewSpec({ view: "table", visibleColumns: ["id", "name", "builtin"], rowLimit: 50 })
      const ran = Schema.decodeUnknownSync(RunViewOutput)(
        await useConn.stub.runView(
          Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_tags", viewSpec }))
        )
      )
      expect(Array.isArray(ran.rows)).toBe(true)

      // Denied: `use` does not meet the `build` minimum `createNode` requires.
      const error = await rejectionToDomainError(
        useConn.stub.createNode(
          Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "should be denied" }))
        )
      )
      expect(error._tag).toBe("Unauthorized")
    } finally {
      useConn.stub[Symbol.dispose]()
      useConn.socket.close()
    }
  })

  it(
    "adversarial-review fix: a use-role collaborator is ALSO denied on RPC methods outside the " +
      "original 4-method slice (createTag) — previously only createNode/addFact/listNodes/" +
      "runView were gated at all, so this exact call used to succeed unchecked",
    async () => {
      const ownerEmail = freshEmail("owner")
      const useEmail = freshEmail("use-role-2")
      const { workspaceId, ownerCredential } = await createGovernedWorkspace(ownerEmail)

      const owner = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
      try {
        await addCollaborator(owner.stub, workspaceId, useEmail, "use")
      } finally {
        owner.stub[Symbol.dispose]()
        owner.socket.close()
      }

      const { credential: useCredential } = await devSignIn(useEmail)
      const useConn = await connectToWorkspaceWithSocketAs(workspaceId, useCredential)
      try {
        const error = await rejectionToDomainError(
          useConn.stub.createTag(
            Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "should be denied", parentIds: [] }))
          )
        )
        expect(error._tag).toBe("Unauthorized")
      } finally {
        useConn.stub[Symbol.dispose]()
        useConn.socket.close()
      }
    }
  )

  it("a build-role collaborator (and the owner) can createNode", async () => {
    const ownerEmail = freshEmail("owner")
    const { workspaceId, ownerCredential } = await createGovernedWorkspace(ownerEmail)
    const owner = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
    try {
      const created = Schema.decodeUnknownSync(CreateNodeOutput)(
        await owner.stub.createNode(
          Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "owner can build" }))
        )
      )
      expect(created.node.title).toBe("owner can build")
    } finally {
      owner.stub[Symbol.dispose]()
      owner.socket.close()
    }
  })

  it(
    "adversarial-review fix: an ANONYMOUS connection (no Bearer credential at all) to a " +
      "GOVERNED workspace is denied Unauthorized, for both a read (use) and a write (build) method " +
      "— previously this bypassed every role check unconditionally",
    async () => {
      const ownerEmail = freshEmail("owner")
      const { workspaceId } = await createGovernedWorkspace(ownerEmail)

      // No Authorization header at all — this used to be treated as "skip the check," giving an
      // anonymous caller full build-level access to a workspace it was never shared into.
      const anonymous = await connectToWorkspace(workspaceId)
      try {
        const writeError = await rejectionToDomainError(
          anonymous.createNode(
            Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "should be denied" }))
          )
        )
        expect(writeError._tag).toBe("Unauthorized")

        const readError = await rejectionToDomainError(
          anonymous.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
        )
        expect(readError._tag).toBe("Unauthorized")
      } finally {
        anonymous[Symbol.dispose]()
      }
    }
  )

  it(
    "adversarial-review fix: a collaborator whose access was just revoked cannot regain access " +
      "by dropping their credential and reconnecting anonymously (the exact exploit reproduced " +
      "in the review: credentialed reconnect was already denied, but anonymous reconnect used " +
      "to bypass the check entirely and succeed at full write access)",
    async () => {
      const ownerEmail = freshEmail("owner")
      const { workspaceId, ownerCredential } = await createGovernedWorkspace(ownerEmail)
      const bobEmail = freshEmail("bob")

      const owner = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
      try {
        await addCollaborator(owner.stub, workspaceId, bobEmail, "build")
        const affected = await removeCollaborator(owner.stub, workspaceId, bobEmail)
        expect(affected.map((a) => a.profileId)).toContain(bobEmail)
      } finally {
        owner.stub[Symbol.dispose]()
        owner.socket.close()
      }

      // Confirm the credentialed path is denied (this half already worked before the fix).
      const { credential: bobCredential } = await devSignIn(bobEmail)
      const bobConn = await connectToWorkspaceWithSocketAs(workspaceId, bobCredential)
      try {
        const credentialedError = await rejectionToDomainError(
          bobConn.stub.createNode(
            Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "should be denied (credentialed)" }))
          )
        )
        expect(credentialedError._tag).toBe("WorkspaceAccessDenied")
      } finally {
        bobConn.stub[Symbol.dispose]()
        bobConn.socket.close()
      }

      // The actual exploit: drop the (now-invalid) credential entirely and reconnect anonymously.
      // Before the fix, this regained full build-level access.
      const anonymousBob = await connectToWorkspace(workspaceId)
      try {
        const anonymousError = await rejectionToDomainError(
          anonymousBob.createNode(
            Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "should be denied (anonymous)" }))
          )
        )
        expect(anonymousError._tag).toBe("Unauthorized")
      } finally {
        anonymousBob[Symbol.dispose]()
      }
    }
  )

  it(
    "backward compatibility: a credentialed connection to an UNGOVERNED workspace (never " +
      "initialized via createWorkspace) stays fully open, exactly like every pre-Phase-4 test workspace",
    async () => {
      const workspaceId = freshWorkspaceId()
      const { credential } = await devSignIn(freshEmail("ungoverned"))
      const conn = await connectToWorkspaceWithSocketAs(workspaceId, credential)
      try {
        const created = Schema.decodeUnknownSync(CreateNodeOutput)(
          await conn.stub.createNode(
            Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "ungoverned still works" }))
          )
        )
        expect(created.node.title).toBe("ungoverned still works")
      } finally {
        conn.stub[Symbol.dispose]()
        conn.socket.close()
      }
    }
  )

  it("an authenticated stranger with no collaborator record is denied WorkspaceAccessDenied on a governed workspace", async () => {
    const ownerEmail = freshEmail("owner")
    const strangerEmail = freshEmail("stranger")
    const { workspaceId } = await createGovernedWorkspace(ownerEmail)
    const { credential: strangerCredential } = await devSignIn(strangerEmail)
    const stranger = await connectToWorkspaceWithSocketAs(workspaceId, strangerCredential)
    try {
      const error = await rejectionToDomainError(
        stranger.stub.createNode(
          Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "should be denied" }))
        )
      )
      expect(error._tag).toBe("WorkspaceAccessDenied")
    } finally {
      stranger.stub[Symbol.dispose]()
      stranger.socket.close()
    }
  })
})

describe("SharingService: keepUsers re-rooting sugar", () => {
  it("removing a sharer while keeping a dependent grants the dependent a fresh direct edge", async () => {
    const ownerEmail = freshEmail("owner")
    const bobEmail = freshEmail("bob")
    const carolEmail = freshEmail("carol")
    const { workspaceId, ownerCredential } = await createGovernedWorkspace(ownerEmail)
    const { credential: bobCredential } = await devSignIn(bobEmail)

    const owner = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)
    try {
      await addCollaborator(owner.stub, workspaceId, bobEmail, "build")
      const bob = await connectToWorkspaceWithSocketAs(workspaceId, bobCredential)
      try {
        await addCollaborator(bob.stub, workspaceId, carolEmail, "use")
      } finally {
        bob.stub[Symbol.dispose]()
        bob.socket.close()
      }

      // Remove Bob, but keep Carol — Carol should survive this time.
      const affected = await removeCollaborator(owner.stub, workspaceId, bobEmail, [carolEmail])
      expect(affected.map((a) => a.profileId)).toEqual([bobEmail])

      const names = listNamesOf(await listCollaborators(owner.stub, workspaceId))
      expect(names).toEqual([carolEmail])
    } finally {
      owner.stub[Symbol.dispose]()
      owner.socket.close()
    }
  })
})

describe("SharingService: WorkspaceNotFound for an ungoverned workspace's sharing methods", () => {
  it("addCollaborator against a workspace with no initialized owner fails WorkspaceNotFound", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(freshEmail("caller"))
    const conn = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const error = await rejectionToDomainError(
        conn.stub.addCollaborator(
          Schema.encodeSync(AddCollaboratorInput)(
            new AddCollaboratorInput({ workspaceId, profileId: freshEmail("target") as never, role: "use" })
          )
        )
      )
      expect(error._tag).toBe("WorkspaceNotFound")
    } finally {
      conn.stub[Symbol.dispose]()
      conn.socket.close()
    }
  })
})
