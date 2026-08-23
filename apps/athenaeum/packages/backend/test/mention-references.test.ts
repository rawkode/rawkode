// Rich-text-editor pass, entity-reference-to-edge projection (`docs/rich-text-editor-decisions.md`
// §5): verifies `syncNoteReferences` reconciles a note's `@`-mention set into real "mentions"
// `Edge` rows, and — the specific thing this task asked to confirm — that `listBacklinks` on a
// mentioned node picks up the mentioning note as a backlink.

import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  CreateNodeInput,
  CreateNodeOutput,
  ListBacklinksInput,
  ListBacklinksOutput,
  ListTagClosureInput,
  ListTagClosureOutput,
  MentionRelationId,
  SyncNoteReferencesInput,
  SyncNoteReferencesOutput
} from "@athenaeum/domain"
import { connectToWorkspace, freshWorkspaceId, rejectionToDomainError } from "./support.js"

describe("Mention relation seeding", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("the fixed 'mentions' relation exists on a fresh workspace and is not a Base Tag closure entry", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    // The relation definition itself has no closure entry (it's a RelationDefinition, not a Tag)
    // — this just confirms seeding didn't leak into the tag closure while we're here; the real
    // "does the relation exist" proof is `syncNoteReferences` succeeding below, since it fails
    // closed (RelationDefinitionNotFound) if the seed never ran.
    const closure = Schema.decodeUnknownSync(ListTagClosureOutput)(
      await workspaceStub.listTagClosure(Schema.encodeSync(ListTagClosureInput)(new ListTagClosureInput({ workspaceId })))
    ).entries
    expect(closure.some((e) => e.ancestorId === MentionRelationId || e.descendantId === MentionRelationId)).toBe(false)
  })
})

describe("syncNoteReferences: reconciliation into real 'mentions' edges", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  const createNode = async (workspaceId: ReturnType<typeof freshWorkspaceId>, title: string) =>
    Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub!.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title })))
    ).node

  it("creates a 'mentions' edge per referenced node, and listBacklinks on the mentioned node sees the mentioning note", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const note = await createNode(workspaceId, "Daily Note")
    const mentioned = await createNode(workspaceId, "Project Athenaeum")

    const syncOutput = Schema.decodeUnknownSync(SyncNoteReferencesOutput)(
      await workspaceStub.syncNoteReferences(
        Schema.encodeSync(SyncNoteReferencesInput)(
          new SyncNoteReferencesInput({ workspaceId, nodeId: note.id, referencedNodeIds: [mentioned.id] })
        )
      )
    )
    expect(syncOutput.edges).toHaveLength(1)
    expect(syncOutput.edges[0]!.relationDefinitionId).toBe(MentionRelationId)
    expect(syncOutput.edges[0]!.sourceNodeId).toBe(note.id)
    expect(syncOutput.edges[0]!.targetNodeId).toBe(mentioned.id)

    // The thing this task specifically asked to confirm: the mentioned node's backlinks include
    // the mentioning note.
    const backlinks = Schema.decodeUnknownSync(ListBacklinksOutput)(
      await workspaceStub.listBacklinks(
        Schema.encodeSync(ListBacklinksInput)(new ListBacklinksInput({ workspaceId, nodeId: mentioned.id }))
      )
    ).edges
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]!.sourceNodeId).toBe(note.id)
    expect(backlinks[0]!.relationDefinitionId).toBe(MentionRelationId)
  })

  it("is idempotent: calling again with the identical set creates no new edges and keeps the same edge id", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const note = await createNode(workspaceId, "Daily Note")
    const mentioned = await createNode(workspaceId, "Project Athenaeum")

    const first = Schema.decodeUnknownSync(SyncNoteReferencesOutput)(
      await workspaceStub.syncNoteReferences(
        Schema.encodeSync(SyncNoteReferencesInput)(
          new SyncNoteReferencesInput({ workspaceId, nodeId: note.id, referencedNodeIds: [mentioned.id] })
        )
      )
    )
    const second = Schema.decodeUnknownSync(SyncNoteReferencesOutput)(
      await workspaceStub.syncNoteReferences(
        Schema.encodeSync(SyncNoteReferencesInput)(
          new SyncNoteReferencesInput({ workspaceId, nodeId: note.id, referencedNodeIds: [mentioned.id] })
        )
      )
    )
    expect(second.edges).toHaveLength(1)
    expect(second.edges[0]!.id).toBe(first.edges[0]!.id)

    const backlinks = Schema.decodeUnknownSync(ListBacklinksOutput)(
      await workspaceStub.listBacklinks(
        Schema.encodeSync(ListBacklinksInput)(new ListBacklinksInput({ workspaceId, nodeId: mentioned.id }))
      )
    ).edges
    expect(backlinks).toHaveLength(1)
  })

  it("a repeated id in referencedNodeIds reconciles to exactly one edge, not a duplicate", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const note = await createNode(workspaceId, "Daily Note")
    const mentioned = await createNode(workspaceId, "Project Athenaeum")

    const output = Schema.decodeUnknownSync(SyncNoteReferencesOutput)(
      await workspaceStub.syncNoteReferences(
        Schema.encodeSync(SyncNoteReferencesInput)(
          new SyncNoteReferencesInput({ workspaceId, nodeId: note.id, referencedNodeIds: [mentioned.id, mentioned.id] })
        )
      )
    )
    expect(output.edges).toHaveLength(1)
  })

  it("removing a reference from a later call deletes the stale edge, and the backlink disappears", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const note = await createNode(workspaceId, "Daily Note")
    const keep = await createNode(workspaceId, "Kept Reference")
    const drop = await createNode(workspaceId, "Dropped Reference")

    await workspaceStub.syncNoteReferences(
      Schema.encodeSync(SyncNoteReferencesInput)(
        new SyncNoteReferencesInput({ workspaceId, nodeId: note.id, referencedNodeIds: [keep.id, drop.id] })
      )
    )

    const reconciled = Schema.decodeUnknownSync(SyncNoteReferencesOutput)(
      await workspaceStub.syncNoteReferences(
        Schema.encodeSync(SyncNoteReferencesInput)(
          new SyncNoteReferencesInput({ workspaceId, nodeId: note.id, referencedNodeIds: [keep.id] })
        )
      )
    )
    expect(reconciled.edges).toHaveLength(1)
    expect(reconciled.edges[0]!.targetNodeId).toBe(keep.id)

    const keptBacklinks = Schema.decodeUnknownSync(ListBacklinksOutput)(
      await workspaceStub.listBacklinks(
        Schema.encodeSync(ListBacklinksInput)(new ListBacklinksInput({ workspaceId, nodeId: keep.id }))
      )
    ).edges
    expect(keptBacklinks).toHaveLength(1)

    const droppedBacklinks = Schema.decodeUnknownSync(ListBacklinksOutput)(
      await workspaceStub.listBacklinks(
        Schema.encodeSync(ListBacklinksInput)(new ListBacklinksInput({ workspaceId, nodeId: drop.id }))
      )
    ).edges
    expect(droppedBacklinks).toHaveLength(0)
  })

  it("an empty referencedNodeIds list removes every existing mention edge from that note", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const note = await createNode(workspaceId, "Daily Note")
    const mentioned = await createNode(workspaceId, "Project Athenaeum")

    await workspaceStub.syncNoteReferences(
      Schema.encodeSync(SyncNoteReferencesInput)(
        new SyncNoteReferencesInput({ workspaceId, nodeId: note.id, referencedNodeIds: [mentioned.id] })
      )
    )
    const cleared = Schema.decodeUnknownSync(SyncNoteReferencesOutput)(
      await workspaceStub.syncNoteReferences(
        Schema.encodeSync(SyncNoteReferencesInput)(
          new SyncNoteReferencesInput({ workspaceId, nodeId: note.id, referencedNodeIds: [] })
        )
      )
    )
    expect(cleared.edges).toHaveLength(0)

    const backlinks = Schema.decodeUnknownSync(ListBacklinksOutput)(
      await workspaceStub.listBacklinks(
        Schema.encodeSync(ListBacklinksInput)(new ListBacklinksInput({ workspaceId, nodeId: mentioned.id }))
      )
    ).edges
    expect(backlinks).toHaveLength(0)
  })

  it("referencing a node id that doesn't exist fails closed as NodeNotFound and writes nothing", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const note = await createNode(workspaceId, "Daily Note")
    const bogusTarget = "00000000-0000-0000-0000-0000000000ff"

    const error = await rejectionToDomainError(
      workspaceStub.syncNoteReferences(
        Schema.encodeSync(SyncNoteReferencesInput)(
          new SyncNoteReferencesInput({ workspaceId, nodeId: note.id, referencedNodeIds: [bogusTarget as any] })
        )
      )
    )
    expect(error._tag).toBe("NodeNotFound")

    const backlinks = Schema.decodeUnknownSync(ListBacklinksOutput)(
      await workspaceStub.listBacklinks(
        Schema.encodeSync(ListBacklinksInput)(new ListBacklinksInput({ workspaceId, nodeId: bogusTarget as any }))
      )
    ).edges
    expect(backlinks).toHaveLength(0)
  })
})
