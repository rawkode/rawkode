// End-to-end proof that the durable page-proposal path has a stable identity,
// typed provenance, and an idempotent ledgered acceptance replay.
import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AcceptPageProposalInput,
  AcceptPageProposalOutput,
  ApplyPageEditInput,
  ApplyPageEditOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  GetPageTextInput,
  GetPageTextOutput,
  ProposePageEditInput,
  ProposePageEditOutput,
  PageProposalProvenance,
  LedgerCommand,
  type EntityId
} from "@athenaeum/domain"
import { pageProposalAcceptanceTestHook } from "../src/workspace-durable-object.js"
import { connectToWorkspace, freshWorkspaceId, rejectionToDomainError, workspaceDurableObjectStub } from "./support.js"

describe("durable page proposals", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    pageProposalAcceptanceTestHook.afterTransactionBeforePublish = undefined
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("replays acceptance by proposal identity without duplicating the ledger record", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Proposal note" })))
    ).node
    const nodeId = node.id as EntityId
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId })))
    await workspaceStub.applyPageEdit(
      Schema.encodeSync(ApplyPageEditInput)(new ApplyPageEditInput({
        workspaceId, nodeId, index: 0, deleteCount: 0, insertText: "Mainline"
      }))
    )

    const provenance = new PageProposalProvenance({
      chatId: "proposal-test-chat",
      assistantMessageId: "proposal-test-message",
      toolCallId: "proposal-test-tool",
      toolName: "append-context",
      source: "agent"
    })
    const proposed = Schema.decodeUnknownSync(ProposePageEditOutput)(
      await workspaceStub.proposePageEdit(Schema.encodeSync(ProposePageEditInput)(new ProposePageEditInput({
        workspaceId,
        nodeId,
        index: "Mainline".length,
        deleteCount: 0,
        insertText: " + proposal",
        rationale: "Record the agent's proposed context for review.",
        provenance
      })))
    )
    const acceptInput = Schema.encodeSync(AcceptPageProposalInput)(new AcceptPageProposalInput({ workspaceId, proposalId: proposed.proposal.proposalId }))

    const native = workspaceDurableObjectStub(workspaceId)
    const artifactsBefore = await native.debugGetLedgerArtifactCounts()
    const first = Schema.decodeUnknownSync(AcceptPageProposalOutput)(await workspaceStub.acceptPageProposal(acceptInput))
    const artifactsAfterFirst = await native.debugGetLedgerArtifactCounts()
    const replay = Schema.decodeUnknownSync(AcceptPageProposalOutput)(await workspaceStub.acceptPageProposal(acceptInput))

    expect(first.text).toBe("Mainline + proposal")
    expect(replay.text).toBe(first.text)
    expect(replay.page.headsHash).toBe(first.page.headsHash)
    expect(replay.commit.committedHeadsHash).toBe(first.commit.committedHeadsHash)
    expect(replay.commit.committedHeadsHash).toBe(replay.page.headsHash)

    const requestIdentity = `page-proposal:${proposed.proposal.proposalId}`
    const command = await native.debugGetLedgerCommand(requestIdentity)
    expect(Schema.decodeUnknownSync(LedgerCommand)(command)).toMatchObject({
      type: "acceptPageProposal",
      message: "Record the agent's proposed context for review.",
      payload: { provenance: { toolCallId: "proposal-test-tool" } }
    })
    const receipt = await native.debugGetLedgerReceipt(requestIdentity)
    expect(receipt).toMatchObject({ output: { headsHash: first.commit.committedHeadsHash } })
    const sideEffect = { proposalId: proposed.proposal.proposalId, nodeId }
    expect(await native.debugGetLedgerEvent(requestIdentity)).toEqual({ kind: "accept-page-proposal", payload: sideEffect })
    expect(await native.debugGetLedgerOutboxIntent(requestIdentity)).toEqual({ kind: "accept-page-proposal", payload: sideEffect })
    expect(artifactsAfterFirst.events).toBe(artifactsBefore.events + 1)
    expect(artifactsAfterFirst.outboxIntents).toBe(artifactsBefore.outboxIntents + 1)
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(artifactsAfterFirst)
  })

  it("repairs the stale doc cache from committed bytes after a post-transaction crash", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Recovery note" })))
    ).node
    const nodeId = node.id as EntityId
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId })))
    const proposed = Schema.decodeUnknownSync(ProposePageEditOutput)(
      await workspaceStub.proposePageEdit(Schema.encodeSync(ProposePageEditInput)(new ProposePageEditInput({
        workspaceId, nodeId, index: 0, deleteCount: 0, insertText: "Recovered",
        rationale: "Exercise the durable acceptance recovery path.",
        provenance: new PageProposalProvenance({ chatId: "recovery-chat", assistantMessageId: "recovery-message", toolCallId: "recovery-tool", toolName: "editNote", source: "agent" })
      })))
    )
    const acceptInput = Schema.encodeSync(AcceptPageProposalInput)(new AcceptPageProposalInput({ workspaceId, proposalId: proposed.proposal.proposalId }))

    pageProposalAcceptanceTestHook.afterTransactionBeforePublish = () => { throw new Error("simulated crash before cache publish") }
    const crash = await rejectionToDomainError(workspaceStub.acceptPageProposal(acceptInput))
    expect(crash._tag).toBe("UnexpectedError")
    pageProposalAcceptanceTestHook.afterTransactionBeforePublish = undefined

    const replay = Schema.decodeUnknownSync(AcceptPageProposalOutput)(await workspaceStub.acceptPageProposal(acceptInput))
    expect(replay.text).toBe("Recovered")
    expect(replay.page.headsHash).toBe(replay.commit.committedHeadsHash)
  })

  it("does not roll back a newer durable page edit when an old acceptance is replayed", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Newer edit note" })))
    ).node
    const nodeId = node.id as EntityId
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId })))
    const proposed = Schema.decodeUnknownSync(ProposePageEditOutput)(
      await workspaceStub.proposePageEdit(Schema.encodeSync(ProposePageEditInput)(new ProposePageEditInput({
        workspaceId, nodeId, index: 0, deleteCount: 0, insertText: "Accepted",
        rationale: "Create an accepted baseline before a later direct edit.",
        provenance: new PageProposalProvenance({ chatId: "newer-edit-chat", assistantMessageId: "newer-edit-message", toolCallId: "newer-edit-tool", toolName: "editNote", source: "agent" })
      })))
    )
    const acceptInput = Schema.encodeSync(AcceptPageProposalInput)(new AcceptPageProposalInput({ workspaceId, proposalId: proposed.proposal.proposalId }))
    const accepted = Schema.decodeUnknownSync(AcceptPageProposalOutput)(await workspaceStub.acceptPageProposal(acceptInput))
    const newer = Schema.decodeUnknownSync(ApplyPageEditOutput)(await workspaceStub.applyPageEdit(
      Schema.encodeSync(ApplyPageEditInput)(new ApplyPageEditInput({ workspaceId, nodeId, index: accepted.text.length, deleteCount: 0, insertText: " + newer" }))
    ))

    const replay = Schema.decodeUnknownSync(AcceptPageProposalOutput)(await workspaceStub.acceptPageProposal(acceptInput))
    const current = Schema.decodeUnknownSync(GetPageTextOutput)(await workspaceStub.getPageText(
      Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId }))
    ))
    expect(replay.text).toBe("Accepted + newer")
    expect(replay.page.headsHash).toBe(newer.page.headsHash)
    expect(current.text).toBe(replay.text)
    expect(current.page.headsHash).toBe(replay.page.headsHash)
  })

  it("rejects a changed command payload when chat/tool identity is replayed", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Identity note" })))
    ).node
    const nodeId = node.id as EntityId
    await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId })))
    const provenance = new PageProposalProvenance({ chatId: "identity-chat", assistantMessageId: "identity-message", toolCallId: "identity-tool", toolName: "editNote", source: "agent" })
    const input = new ProposePageEditInput({ workspaceId, nodeId, index: 0, deleteCount: 0, insertText: "first", rationale: "Record the first command.", provenance })
    await workspaceStub.proposePageEdit(Schema.encodeSync(ProposePageEditInput)(input))

    const conflict = await rejectionToDomainError(workspaceStub.proposePageEdit(Schema.encodeSync(ProposePageEditInput)(
      new ProposePageEditInput({ ...input, insertText: "changed" })
    )))
    expect(conflict._tag).toBe("ValidationError")

    const blankRationale = await rejectionToDomainError(workspaceStub.proposePageEdit(Schema.encodeSync(ProposePageEditInput)(
      new ProposePageEditInput({ ...input, rationale: "   ", provenance: new PageProposalProvenance({ ...provenance, toolCallId: "blank-rationale-tool" }) })
    )))
    expect(blankRationale._tag).toBe("ValidationError")
  })
})
