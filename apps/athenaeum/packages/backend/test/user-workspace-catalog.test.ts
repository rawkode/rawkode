// Real, end-to-end coverage for the Phase 4 multi-workspace-catalog stage ("Build out
// `UserDurableObject` for real" — see `user-durable-object.ts`'s own header comment for the
// design). Every test here exercises real code: a real HTTP `POST /api/dev/sign-in` round trip,
// real `UserDurableObject`/`WorkspaceDurableObject` storage (via `ctx.exports`, never reached-into
// directly), and real Cap'n Web RPC calls (`createWorkspace`/`listWorkspaces`) over `/api/user` — not a
// mock of any of these pieces.

import { describe, expect, it } from "vitest"
import { exports } from "cloudflare:workers"
import * as Schema from "effect/Schema"
import { CreateWorkspaceInput, CreateWorkspaceOutput, ListWorkspacesOutput } from "@athenaeum/domain"
import { connectToUserAs, devSignIn, fetchUserRoute } from "./support.js"

const freshEmail = (): string => `catalog-${crypto.randomUUID()}@rawkode.academy`

// `ListWorkspacesInput` has zero fields, so `Schema.encodeSync` returns the class instance itself
// unchanged (there's nothing to transform into a plain object) rather than a plain `{}` —
// capnweb's `Devaluator` can only serialize plain data/`RpcTarget`s, not an arbitrary class
// instance, so the wire call passes a literal `{}` directly (exactly what `Schema.decodeUnknown
// (ListWorkspacesInput)` on the server expects to decode anyway) instead of round-tripping through
// `Schema.encodeSync`.
const listWorkspaces = async (stub: Awaited<ReturnType<typeof connectToUserAs>>["stub"]) =>
  Schema.decodeUnknownSync(ListWorkspacesOutput)(await stub.listWorkspaces({})).workspaces

describe("UserDurableObject: fixed-identity default 'Personal' workspace", () => {
  it("a freshly signed-in account has exactly one workspace: a default 'Personal' workspace it owns", async () => {
    const email = freshEmail()
    const { credential } = await devSignIn(email)
    const { stub, socket } = await connectToUserAs(credential)
    try {
      const workspaces = await listWorkspaces(stub)
      expect(workspaces).toHaveLength(1)
      expect(workspaces[0]?.title).toBe("Personal")
      expect(workspaces[0]?.ownerId).toBe(email)
      expect(workspaces[0]?.role).toBe("build")
      expect(workspaces[0]?.isDefault).toBe(true)
    } finally {
      stub[Symbol.dispose]()
      socket.close()
    }
  })

  it("signing in twice for the same email deterministically yields the SAME default workspace id", async () => {
    const email = freshEmail()
    const first = await devSignIn(email)
    const firstConn = await connectToUserAs(first.credential)
    let firstWorkspaceId: string
    try {
      const workspaces = await listWorkspaces(firstConn.stub)
      expect(workspaces).toHaveLength(1)
      firstWorkspaceId = workspaces[0]!.workspaceId
    } finally {
      firstConn.stub[Symbol.dispose]()
      firstConn.socket.close()
    }

    const second = await devSignIn(email)
    const secondConn = await connectToUserAs(second.credential)
    try {
      const workspaces = await listWorkspaces(secondConn.stub)
      expect(workspaces).toHaveLength(1)
      expect(workspaces[0]!.workspaceId).toBe(firstWorkspaceId)
    } finally {
      secondConn.stub[Symbol.dispose]()
      secondConn.socket.close()
    }
  })

  it("two distinct emails get two distinct default workspaces, and each WorkspaceDurableObject really knows its own owner", async () => {
    const emailA = freshEmail()
    const emailB = freshEmail()
    const { credential: credA } = await devSignIn(emailA)
    const { credential: credB } = await devSignIn(emailB)

    const connA = await connectToUserAs(credA)
    const connB = await connectToUserAs(credB)
    try {
      const workspacesA = await listWorkspaces(connA.stub)
      const workspacesB = await listWorkspaces(connB.stub)
      expect(workspacesA).toHaveLength(1)
      expect(workspacesB).toHaveLength(1)
      expect(workspacesA[0]!.workspaceId).not.toBe(workspacesB[0]!.workspaceId)

      // The workspace's OWN WorkspaceDurableObject really was told who owns it (task item 3: "implicitly,
      // as workspace owner... in the new WorkspaceDurableObject itself") — not just the catalog entry.
      const ownerA = await exports.WorkspaceDurableObject.getByName(workspacesA[0]!.workspaceId).getOwner()
      const ownerB = await exports.WorkspaceDurableObject.getByName(workspacesB[0]!.workspaceId).getOwner()
      expect(ownerA).toEqual({ ownerEmail: emailA, title: "Personal" })
      expect(ownerB).toEqual({ ownerEmail: emailB, title: "Personal" })
    } finally {
      connA.stub[Symbol.dispose]()
      connA.socket.close()
      connB.stub[Symbol.dispose]()
      connB.socket.close()
    }
  })
})

describe("UserDurableObject: createWorkspace/listWorkspaces", () => {
  it("creating an extra workspace registers it in the catalog and initializes its WorkspaceDurableObject owner", async () => {
    const email = freshEmail()
    const { credential } = await devSignIn(email)
    const { stub, socket } = await connectToUserAs(credential)
    try {
      const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
        await stub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title: "Work" })))
      )
      expect(created.workspace.title).toBe("Work")
      expect(created.workspace.ownerId).toBe(email)
      expect(created.workspace.isDefault).toBe(false)

      const workspaces = await listWorkspaces(stub)
      expect(workspaces).toHaveLength(2)
      const titles = workspaces.map((v) => v.title).sort()
      expect(titles).toEqual(["Personal", "Work"])

      const owner = await exports.WorkspaceDurableObject.getByName(created.workspace.workspaceId).getOwner()
      expect(owner).toEqual({ ownerEmail: email, title: "Work" })
    } finally {
      stub[Symbol.dispose]()
      socket.close()
    }
  })

  it("a created workspace appears ONLY in its creator's catalog, not another user's", async () => {
    const emailA = freshEmail()
    const emailB = freshEmail()
    const { credential: credA } = await devSignIn(emailA)
    const { credential: credB } = await devSignIn(emailB)

    const connA = await connectToUserAs(credA)
    try {
      await stubCreateWorkspace(connA.stub, "A's extra workspace")
    } finally {
      connA.stub[Symbol.dispose]()
      connA.socket.close()
    }

    const connB = await connectToUserAs(credB)
    try {
      const workspacesB = await listWorkspaces(connB.stub)
      // Only B's own default "Personal" workspace — never A's extra workspace.
      expect(workspacesB).toHaveLength(1)
      expect(workspacesB[0]!.title).toBe("Personal")
      expect(workspacesB.some((v) => v.title === "A's extra workspace")).toBe(false)
    } finally {
      connB.stub[Symbol.dispose]()
      connB.socket.close()
    }

    // Re-confirm A still sees both of their own workspaces, unaffected by B's session.
    const connA2 = await connectToUserAs(credA)
    try {
      const workspacesA = await listWorkspaces(connA2.stub)
      expect(workspacesA).toHaveLength(2)
    } finally {
      connA2.stub[Symbol.dispose]()
      connA2.socket.close()
    }
  })
})

const stubCreateWorkspace = (stub: Awaited<ReturnType<typeof connectToUserAs>>["stub"], title: string) =>
  stub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title })))

describe("/api/user — authentication requirements", () => {
  it("rejects a request with no credential at all", async () => {
    const response = await fetchUserRoute(
      new Request("https://athenaeum.invalid/api/user", { headers: { Upgrade: "websocket" } })
    )
    expect(response.status).toBe(401)
  })

  it("rejects a tampered/invalid credential", async () => {
    const response = await fetchUserRoute(
      new Request("https://athenaeum.invalid/api/user", {
        headers: { Upgrade: "websocket", Authorization: "Bearer not-a-real-credential" }
      })
    )
    expect(response.status).toBe(401)
  })
})
