// Phase 4 exit-criterion verification, run for real against a live workerd backend
// (`@cloudflare/vitest-pool-workers`, same real Miniflare/workerd instance every other suite in
// this package uses — real `WorkspaceDurableObject`/`UserDurableObject`, real Cap'n Web RPC over real
// WebSocket sessions, real `POST /api/dev/sign-in` HMAC credentials) using THREE distinct real
// dev-signed-in identities (Alice, Bob, Carol) throughout — never one identity pretending to be
// three. This file exists specifically to prove the plan's own three Phase 4 deliverables in ONE
// connected scenario, rather than trusting that the separate `sharing-service.test.ts`/
// `revocation-eviction.test.ts`/`user-workspace-catalog.test.ts` suites cover the combination:
//
// 1. Multi-workspace: each identity's own deterministic "Personal" workspace, plus a correctly-scoped
//    extra workspace.
// 2. The sharing graph reproduced from docs/sharing.md's own worked example: Alice shares with
//    Bob (build), Bob shares with Carol (use); Carol's effective role is "use" — the min of the
//    chain, NOT Bob's own "build" — and Carol can read but a use-gated write is rejected.
// 3. Lazy revocation + LIVE-session eviction: with Carol's WebSocket session open and idle,
//    Alice removes Bob; Carol's live connection is force-closed by the server (not merely denied
//    on her next call) with ZERO explicit cleanup of Carol's own collaborator record; re-adding
//    Bob restores Carol's access with ZERO extra steps naming Carol.

import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AddCollaboratorInput,
  AddCollaboratorOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
  ListCollaboratorsOutput,
  ListNodesInput,
  ListNodesOutput,
  ListWorkspacesOutput,
  RemoveCollaboratorInput,
  RemoveCollaboratorOutput,
  RunViewInput,
  RunViewOutput,
  ViewSpec,
  type EntityId
} from "@athenaeum/domain"
import {
  connectToUserAs,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  rejectionToDomainError,
  waitUntil,
  type WorkspaceApi
} from "./support.js"
import type { RpcStub } from "capnweb"

const freshEmail = (label: string): string => `phase4-${label}-${crypto.randomUUID()}@rawkode.academy`

const listWorkspaces = async (credential: string) => {
  const { stub, socket } = await connectToUserAs(credential)
  try {
    return Schema.decodeUnknownSync(ListWorkspacesOutput)(await stub.listWorkspaces({})).workspaces
  } finally {
    stub[Symbol.dispose]()
    socket.close()
  }
}

const createWorkspace = async (credential: string, title: string): Promise<EntityId> => {
  const { stub, socket } = await connectToUserAs(credential)
  try {
    const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
      await stub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title })))
    )
    return created.workspace.workspaceId
  } finally {
    stub[Symbol.dispose]()
    socket.close()
  }
}

const addCollaborator = async (
  stub: RpcStub<WorkspaceApi>,
  workspaceId: EntityId,
  profileId: string,
  role: "build" | "use"
) =>
  Schema.decodeUnknownSync(AddCollaboratorOutput)(
    await stub.addCollaborator(
      Schema.encodeSync(AddCollaboratorInput)(new AddCollaboratorInput({ workspaceId, profileId: profileId as never, role }))
    )
  )

const listCollaborators = async (stub: RpcStub<WorkspaceApi>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(ListCollaboratorsOutput)(await stub.listCollaborators({ workspaceId })).collaborators

const removeCollaborator = async (stub: RpcStub<WorkspaceApi>, workspaceId: EntityId, profileId: string) =>
  Schema.decodeUnknownSync(RemoveCollaboratorOutput)(
    await stub.removeCollaborator(
      Schema.encodeSync(RemoveCollaboratorInput)(new RemoveCollaboratorInput({ workspaceId, profileId: profileId as never }))
    )
  ).affected

const readWorkspace = async (stub: RpcStub<WorkspaceApi>, workspaceId: EntityId) => {
  const listed = Schema.decodeUnknownSync(ListNodesOutput)(
    await stub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
  )
  const viewSpec = new ViewSpec({ view: "table", visibleColumns: ["id", "name", "builtin"], rowLimit: 50 })
  const ran = Schema.decodeUnknownSync(RunViewOutput)(
    await stub.runView(Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_tags", viewSpec })))
  )
  return { nodes: listed.nodes, viewRows: ran.rows }
}

const attemptWrite = (stub: RpcStub<WorkspaceApi>, workspaceId: EntityId, title: string) =>
  stub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title })))

describe("Phase 4 exit criterion 1: multi-workspace", () => {
  it("each identity gets its own deterministic 'Personal' workspace, and an extra workspace is created and scoped correctly", async () => {
    const aliceEmail = freshEmail("alice-mv")
    const bobEmail = freshEmail("bob-mv")

    const alice1 = await devSignIn(aliceEmail)
    const alice2 = await devSignIn(aliceEmail) // same email, second sign-in
    const bob = await devSignIn(bobEmail)

    const aliceWorkspacesFirst = await listWorkspaces(alice1.credential)
    expect(aliceWorkspacesFirst).toHaveLength(1)
    expect(aliceWorkspacesFirst[0]?.title).toBe("Personal")
    expect(aliceWorkspacesFirst[0]?.ownerId).toBe(aliceEmail)
    expect(aliceWorkspacesFirst[0]?.isDefault).toBe(true)

    // Deterministic: signing in again for the SAME email yields the SAME default workspace id.
    const aliceWorkspacesSecond = await listWorkspaces(alice2.credential)
    expect(aliceWorkspacesSecond).toHaveLength(1)
    expect(aliceWorkspacesSecond[0]?.workspaceId).toBe(aliceWorkspacesFirst[0]?.workspaceId)

    // A distinct identity gets a DIFFERENT default workspace.
    const bobWorkspaces = await listWorkspaces(bob.credential)
    expect(bobWorkspaces).toHaveLength(1)
    expect(bobWorkspaces[0]?.workspaceId).not.toBe(aliceWorkspacesFirst[0]?.workspaceId)

    // Creating an extra workspace works, and is correctly scoped: it shows up in Alice's own
    // catalog only, never Bob's.
    const extraWorkspaceId = await createWorkspace(alice1.credential, "Alice's Second Workspace")
    const aliceWorkspacesAfterCreate = await listWorkspaces(alice1.credential)
    expect(aliceWorkspacesAfterCreate).toHaveLength(2)
    expect(aliceWorkspacesAfterCreate.map((v) => v.workspaceId).sort()).toEqual(
      [aliceWorkspacesFirst[0]?.workspaceId, extraWorkspaceId].sort()
    )
    const extraEntry = aliceWorkspacesAfterCreate.find((v) => v.workspaceId === extraWorkspaceId)
    expect(extraEntry?.title).toBe("Alice's Second Workspace")
    expect(extraEntry?.isDefault).toBe(false)

    const bobWorkspacesAfterAliceCreate = await listWorkspaces(bob.credential)
    expect(bobWorkspacesAfterAliceCreate).toHaveLength(1)
    expect(bobWorkspacesAfterAliceCreate.map((v) => v.workspaceId)).not.toContain(extraWorkspaceId)
  })
})

describe("Phase 4 exit criteria 2 & 3: the sharing graph + lazy revocation + live-session eviction, combined", () => {
  it(
    "Alice shares with Bob (build), Bob shares with Carol (use); Carol's effective role is the " +
      "chain minimum ('use'); Carol can read but a use-gated write is rejected; with Carol's " +
      "session LIVE, removing Bob disconnects Carol's socket AND denies her next call with ZERO " +
      "explicit cleanup of her own record; re-adding Bob restores her with ZERO extra steps",
    async () => {
      const aliceEmail = freshEmail("alice")
      const bobEmail = freshEmail("bob")
      const carolEmail = freshEmail("carol")

      const alice = await devSignIn(aliceEmail)
      const bob = await devSignIn(bobEmail)
      const carol = await devSignIn(carolEmail)

      // Alice's real, governed workspace (a real initializeOwner round trip via createWorkspace) — the
      // default "Personal" workspace would work identically, but a fresh named workspace keeps this test
      // isolated from workspace #1's assertions.
      const workspaceId = await createWorkspace(alice.credential, "Alice's shareable workspace")

      const aliceConn = await connectToWorkspaceWithSocketAs(workspaceId, alice.credential)
      try {
        // --- Build the chain: Alice -> Bob (build), Bob -> Carol (use). ---
        const bobAdd = await addCollaborator(aliceConn.stub, workspaceId, bobEmail, "build")
        expect(bobAdd.collaborator.role).toBe("build")

        const bobConn = await connectToWorkspaceWithSocketAs(workspaceId, bob.credential)
        try {
          const carolAdd = await addCollaborator(bobConn.stub, workspaceId, carolEmail, "use")
          // The edge Bob->Carol is itself "use" — asserted here as the input, distinct from
          // Carol's chain-computed EFFECTIVE role asserted below via listCollaborators.
          expect(carolAdd.collaborator.role).toBe("use")
        } finally {
          bobConn.stub[Symbol.dispose]()
          bobConn.socket.close()
        }

        // Carol's LIVE, still-open session for the rest of this test — opened now, deliberately
        // BEFORE the revocation below, so the eviction assertion is against a genuinely live
        // connection, not a fresh one opened after the fact.
        const carolConn = await connectToWorkspaceWithSocketAs(workspaceId, carol.credential)
        try {
          // --- Exit criterion 2: effective role is the chain MINIMUM, not Bob's own role. ---
          // min(edge Bob->Carol = "use", Bob's own effective role = "build") = "use".
          const collaborators = await listCollaborators(aliceConn.stub, workspaceId)
          const carolInfo = collaborators.find((c) => c.profileId === carolEmail)
          const bobInfo = collaborators.find((c) => c.profileId === bobEmail)
          expect(bobInfo?.role).toBe("build")
          expect(carolInfo?.role).toBe("use")

          // Carol can read: listNodes + a read-only graph view both succeed.
          const read = await readWorkspace(carolConn.stub, workspaceId)
          expect(read.nodes).toEqual([])
          expect(Array.isArray(read.viewRows)).toBe(true)

          // Carol CANNOT perform a use-gated write: createNode requires "build".
          const writeError = await rejectionToDomainError(attemptWrite(carolConn.stub, workspaceId, "carol's write"))
          expect(writeError._tag).toBe("Unauthorized")

          // Sanity: Bob, at "build", CAN write — confirms the rejection above is role-specific,
          // not some blanket failure.
          const bobConn2 = await connectToWorkspaceWithSocketAs(workspaceId, bob.credential)
          try {
            const bobWrite = Schema.decodeUnknownSync(CreateNodeOutput)(await attemptWrite(bobConn2.stub, workspaceId, "bob's write"))
            expect(bobWrite.node.title).toBe("bob's write")
          } finally {
            bobConn2.stub[Symbol.dispose]()
            bobConn2.socket.close()
          }

          // --- Exit criterion 3: lazy revocation + LIVE-session eviction. ---
          // Alice removes ONLY Bob. She never touches Carol's record at all — "ZERO explicit
          // cleanup" is enforced structurally here: the RemoveCollaboratorInput below names only
          // bobEmail.
          const affected = await removeCollaborator(aliceConn.stub, workspaceId, bobEmail)
          expect(affected.map((a) => a.profileId).sort()).toEqual([bobEmail, carolEmail].sort())
          for (const a of affected) expect(a.newRole).toBeNull()

          // Carol's LIVE socket — opened before the revocation, never touched since — is force-
          // closed by the server's revocation-eviction mechanism, NOT merely left open with future
          // calls silently failing.
          await waitUntil(() => carolConn.socket.readyState === WebSocket.READY_STATE_CLOSED, 5_000)
          expect(carolConn.socket.readyState).toBe(WebSocket.READY_STATE_CLOSED)

          // Carol is now unreachable via the sharing graph too: listCollaborators from Alice's
          // workspace no longer lists her (or Bob) — again, with zero explicit action naming Carol.
          const namesAfter = (await listCollaborators(aliceConn.stub, workspaceId)).map((c) => c.profileId)
          expect(namesAfter).toEqual([])

          // And a FRESH connection attempt by Carol (simulating her reconnecting after the forced
          // disconnect) is correctly denied WorkspaceAccessDenied — not just "the old socket died",
          // but "she genuinely has no path to this workspace anymore."
          const carolRetry = await connectToWorkspaceWithSocketAs(workspaceId, carol.credential)
          try {
            const deniedError = await rejectionToDomainError(readWorkspaceNodes(carolRetry.stub, workspaceId))
            expect(deniedError._tag).toBe("WorkspaceAccessDenied")
          } finally {
            carolRetry.stub[Symbol.dispose]()
            carolRetry.socket.close()
          }

          // --- Re-adding Bob restores Carol's access with ZERO extra steps naming Carol. ---
          await addCollaborator(aliceConn.stub, workspaceId, bobEmail, "build")
          const namesRestored = (await listCollaborators(aliceConn.stub, workspaceId)).map((c) => c.profileId)
          expect(namesRestored.sort()).toEqual([bobEmail, carolEmail].sort())

          const carolReconnected = await connectToWorkspaceWithSocketAs(workspaceId, carol.credential)
          try {
            const restoredRead = await readWorkspace(carolReconnected.stub, workspaceId)
            // Bob's write from earlier is visible — proves this is the same real workspace, real
            // restored read access, not a fresh empty workspace.
            expect(restoredRead.nodes.some((n) => n.title === "bob's write")).toBe(true)
          } finally {
            carolReconnected.stub[Symbol.dispose]()
            carolReconnected.socket.close()
          }
        } finally {
          // carolConn's socket was already force-closed by the server; disposing the stub against
          // an already-dead transport is a harmless no-op (same pattern as revocation-eviction.
          // test.ts's own cleanup).
          carolConn.stub[Symbol.dispose]()
        }
      } finally {
        aliceConn.stub[Symbol.dispose]()
        aliceConn.socket.close()
      }
    }
  )
})

const readWorkspaceNodes = (stub: RpcStub<WorkspaceApi>, workspaceId: EntityId) =>
  stub.listNodes(Schema.encodeSync(ListNodesInput)(new ListNodesInput({ workspaceId })))
