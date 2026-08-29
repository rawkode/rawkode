import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AgentJobMutationAttribution,
  AddFactLedgerCommand,
  AddFactLedgerPayload,
  AssignTagLedgerCommand,
  AssignTagLedgerPayload,
  CreateEdgeLedgerCommand,
  CreateEdgeLedgerPayload,
  CreateRelationDefinitionLedgerCommand,
  CreateRelationDefinitionLedgerPayload,
  CreateBookmarkLedgerTitle,
  AppendTranscriptSegmentLedgerSpeaker,
  StartMeetingLedgerCommand,
  StartMeetingLedgerPayload,
  CreateTagLedgerCommand,
  CreateTagLedgerPayload,
  DefineTagFieldLedgerCommand,
  DefineTagFieldLedgerPayload,
  ApplySupertagLedgerCommand,
  ApplySupertagLedgerFieldValue,
  ApplySupertagLedgerPayload,
  HumanUiMutationAttribution,
  LedgerCommand,
  MutationAttribution,
  SystemMutationAttribution,
  UnassignTagLedgerCommand,
  UnassignTagLedgerPayload,
  SyncNoteReferencesLedgerCommand,
  SyncNoteReferencesLedgerPayload,
  SyncNoteReferencesLedgerEdge,
  applySupertagCommitMessage,
  addFactCommitMessage,
  assignTagCommitMessage,
  createEdgeCommitMessage,
  createRelationDefinitionCommitMessage,
  createTagCommitMessage,
  defineTagFieldCommitMessage,
  createNodeCommitMessage,
  normalizeCreateNodeTitle,
  normalizeCreateTagName,
  unassignTagCommitMessage,
  syncNoteReferencesCommitMessage,
  startMeetingCommitMessage
} from "./ledger.js"
import { EntityId } from "./node.js"
import { normalizeTagFieldName } from "./tag-field-definition.js"

describe("transitional ledger domain contract", () => {
  it("requires bookmark title presence and value to agree", () => {
    expect(() => Schema.decodeUnknownSync(CreateBookmarkLedgerTitle)({ present: false, value: "secret" })).toThrow()
    expect(() => Schema.decodeUnknownSync(CreateBookmarkLedgerTitle)({ present: true, value: null })).toThrow()
    expect(Schema.decodeUnknownSync(CreateBookmarkLedgerTitle)({ present: false, value: null })).toEqual({ present: false, value: null })
    expect(Schema.decodeUnknownSync(CreateBookmarkLedgerTitle)({ present: true, value: "" })).toEqual({ present: true, value: "" })
  })
  it("requires transcript speaker presence and value to agree", () => {
    const speakerId = "00000000-0000-4000-8000-000000000008"
    expect(() => Schema.decodeUnknownSync(AppendTranscriptSegmentLedgerSpeaker)({ present: false, value: speakerId })).toThrow()
    expect(() => Schema.decodeUnknownSync(AppendTranscriptSegmentLedgerSpeaker)({ present: true, value: null })).toThrow()
    expect(Schema.decodeUnknownSync(AppendTranscriptSegmentLedgerSpeaker)({ present: false, value: null })).toEqual({ present: false, value: null })
    expect(Schema.decodeUnknownSync(AppendTranscriptSegmentLedgerSpeaker)({ present: true, value: speakerId })).toEqual({ present: true, value: speakerId })
  })
  it("derives the versioned human message from a normalized title", () => {
    expect(normalizeCreateNodeTitle("  A\n  node  ")).toBe("A node")
    expect(createNodeCommitMessage("  A\n  node  ")).toBe("Create node to record A node.")
  })

  it("normalizes public Supertag names once and preserves a fixed public activity message", () => {
    expect(normalizeCreateTagName("  Project\n  Alpha  ")).toBe("Project Alpha")
    expect(createTagCommitMessage()).toBe("Created a Supertag definition.")
  })

  it("keeps exact meeting titles private while requiring a strict start command", () => {
    const workspaceId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001")
    const command = new StartMeetingLedgerCommand({
      version: "athenaeum.workspace-ledger.v1",
      requestId: "start-meeting-1",
      fingerprint: "fingerprint-1",
      type: "startMeeting",
      workspaceId,
      principal: "operator@example.com",
      capability: "build",
      policy: "governed-role-v1",
      messageDerivationVersion: "start-meeting.v1",
      message: startMeetingCommitMessage(),
      payload: new StartMeetingLedgerPayload({
        meetingId: "00000000-0000-4000-8000-000000000002" as any,
        title: "  Exact title  ",
        startedAt: new Date().toISOString() as any,
        commitMessage: "Start the meeting.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos"
        })
      }),
      createdAt: new Date().toISOString()
    })
    expect(Schema.decodeUnknownSync(StartMeetingLedgerCommand)(Schema.encodeSync(StartMeetingLedgerCommand)(command))).toEqual(command)
    expect(command.message).toBe("Started a meeting.")
  })

  it("normalizes public field names once and keeps field rationale private", () => {
    expect(normalizeTagFieldName("  daily\n  status  ")).toBe("daily status")
    expect(defineTagFieldCommitMessage()).toBe("Added a field to a Supertag definition.")
  })

  it("rejects malformed immutable command records", () => {
    expect(() => Schema.decodeUnknownSync(LedgerCommand)({ version: "wrong" })).toThrow()
  })

  it("requires rationale and provenance for an agent change decision", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001"
    const proposalId = "00000000-0000-4000-8000-000000000002"
    const valid = {
      version: "athenaeum.workspace-ledger.v1",
      requestId: "request-1",
      fingerprint: "fingerprint-1",
      type: "agentChangeDecision",
      workspaceId,
      proposalId,
      decision: "accept",
      principal: "operator@example.com",
      provenance: "employee:enrichment/job:attendee/run:1",
      capability: "build",
      policy: "governed-role-v1",
      messageDerivationVersion: "caller-rationale.v1",
      message: "Promote the verified enrichment.",
      payload: { proposalId, decision: "accept" },
      createdAt: new Date().toISOString()
    }
    expect(Schema.decodeUnknownSync(LedgerCommand)(valid)).toMatchObject({ type: "agentChangeDecision" })
    expect(() => Schema.decodeUnknownSync(LedgerCommand)({ ...valid, message: "" })).toThrow()
    expect(() => Schema.decodeUnknownSync(LedgerCommand)({ ...valid, provenance: "" })).toThrow()
  })

  it("accepts only bounded, typed mutation attribution variants", () => {
    expect(Schema.decodeUnknownSync(MutationAttribution)(new HumanUiMutationAttribution({
      version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor"
    }))).toMatchObject({ kind: "humanUi" })
    expect(Schema.decodeUnknownSync(MutationAttribution)(new HumanUiMutationAttribution({
      version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-backlinks"
    }))).toMatchObject({ kind: "humanUi", surface: "web-backlinks" })
    expect(Schema.decodeUnknownSync(MutationAttribution)(new AgentJobMutationAttribution({
      version: "athenaeum.mutation-attribution.v1", kind: "agentJob", jobId: "employee-1", runId: "run-1"
    }))).toMatchObject({ kind: "agentJob" })
    expect(Schema.decodeUnknownSync(MutationAttribution)(new SystemMutationAttribution({
      version: "athenaeum.mutation-attribution.v1", kind: "system", source: "calendar-sync"
    }))).toMatchObject({ kind: "system" })
    expect(() => Schema.decodeUnknownSync(MutationAttribution)({ version: "wrong", kind: "humanUi", surface: "rich-text-editor" })).toThrow()
    expect(() => Schema.decodeUnknownSync(MutationAttribution)({ version: "athenaeum.mutation-attribution.v1", kind: "agentJob", jobId: "", runId: "run-1" })).toThrow()
    expect(() => Schema.decodeUnknownSync(MutationAttribution)({ version: "athenaeum.mutation-attribution.v1", kind: "agentJob", jobId: "x".repeat(201), runId: "run-1" })).toThrow()
  })

  it("round-trips the private applySupertag command with a deterministic public message", () => {
    const workspaceId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001")
    const nodeId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000002")
    const tagId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000003")
    const fieldId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000004")
    const command = new ApplySupertagLedgerCommand({
      version: "athenaeum.workspace-ledger.v1",
      requestId: "apply-1",
      fingerprint: "fingerprint-1",
      type: "applySupertag",
      workspaceId,
      principal: "operator@example.com",
      capability: "build",
      policy: "governed-role-v1",
      messageDerivationVersion: "apply-supertag.v1",
      message: applySupertagCommitMessage(),
      payload: new ApplySupertagLedgerPayload({
        nodeId,
        tagId,
        fieldValues: [new ApplySupertagLedgerFieldValue({ fieldId, value: "Ada" })],
        commitMessage: "Record the person context from the note.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor"
        })
      }),
      createdAt: new Date().toISOString()
    })
    expect(Schema.decodeUnknownSync(ApplySupertagLedgerCommand)(Schema.encodeSync(ApplySupertagLedgerCommand)(command))).toEqual(command)
    expect(command.message).toBe("Applied Supertag to a workspace node.")
  })

  it("round-trips the private addFact command and keeps the public message deterministic", () => {
    const workspaceId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001")
    const nodeId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000002")
    const factId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000003")
    const command = new AddFactLedgerCommand({
      version: "athenaeum.workspace-ledger.v1",
      requestId: "add-fact-1",
      fingerprint: "fingerprint-1",
      type: "addFact",
      workspaceId,
      principal: "operator@example.com",
      capability: "build",
      policy: "governed-role-v1",
      messageDerivationVersion: "add-fact.v1",
      message: addFactCommitMessage(),
      payload: new AddFactLedgerPayload({
        nodeId,
        predicateId: "status",
        value: "done",
        factId,
        commitMessage: "Record the current status.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-supertag-field-editor"
        })
      }),
      createdAt: new Date().toISOString()
    })
    expect(Schema.decodeUnknownSync(AddFactLedgerCommand)(Schema.encodeSync(AddFactLedgerCommand)(command))).toEqual(command)
    expect(command.message).toBe("Updated a workspace fact.")
  })

  it("round-trips the private createEdge command without exposing caller rationale", () => {
    const workspaceId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001")
    const relationDefinitionId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000002")
    const sourceNodeId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000003")
    const targetNodeId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000004")
    const command = new CreateEdgeLedgerCommand({
      version: "athenaeum.workspace-ledger.v1",
      requestId: "create-edge-1",
      fingerprint: "fingerprint-1",
      type: "createEdge",
      workspaceId,
      principal: "operator@example.com",
      capability: "build",
      policy: "governed-role-v1",
      messageDerivationVersion: "create-edge.v1",
      message: createEdgeCommitMessage(),
      payload: new CreateEdgeLedgerPayload({
        relationDefinitionId,
        sourceNodeId,
        targetNodeId,
        commitMessage: "Link the person to the project for the meeting context.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-backlinks"
        })
      }),
      createdAt: new Date().toISOString()
    })
    expect(Schema.decodeUnknownSync(CreateEdgeLedgerCommand)(Schema.encodeSync(CreateEdgeLedgerCommand)(command))).toEqual(command)
    expect(command.message).toBe("Created a relationship between workspace nodes.")
    expect(command.message).not.toContain("meeting context")
  })

  it("round-trips the private relation-definition command with exact names and private rationale", () => {
    const workspaceId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001")
    const sourceTagId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000002")
    const targetTagId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000003")
    const relationDefinitionId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000004")
    const command = new CreateRelationDefinitionLedgerCommand({
      version: "athenaeum.workspace-ledger.v1",
      requestId: "create-relation-definition-1",
      fingerprint: "fingerprint-1",
      type: "createRelationDefinition",
      workspaceId,
      principal: "operator@example.com",
      capability: "build",
      policy: "governed-role-v1",
      messageDerivationVersion: "create-relation-definition.v1",
      message: createRelationDefinitionCommitMessage(),
      payload: new CreateRelationDefinitionLedgerPayload({
        relationDefinitionId,
        forwardName: " works with ",
        inverseName: "worked with",
        sourceTagId,
        targetTagId,
        cardinality: "many-to-many",
        commitMessage: "Preserve the exact relation names from the graph editor.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-graph-view"
        })
      }),
      createdAt: new Date().toISOString()
    })
    expect(Schema.decodeUnknownSync(CreateRelationDefinitionLedgerCommand)(Schema.encodeSync(CreateRelationDefinitionLedgerCommand)(command))).toEqual(command)
    expect(command.message).toBe("Created a relation definition.")
    expect(command.message).not.toContain("exact relation names")
    expect(command.payload.forwardName).toBe(" works with ")
  })

  it("round-trips the private createTag command with ordered parents and private rationale", () => {
    const workspaceId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001")
    const parentId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000002")
    const secondParentId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000003")
    const command = new CreateTagLedgerCommand({
      version: "athenaeum.workspace-ledger.v1",
      requestId: "create-tag-1",
      fingerprint: "fingerprint-1",
      type: "createTag",
      workspaceId,
      principal: "operator@example.com",
      capability: "build",
      policy: "governed-role-v1",
      messageDerivationVersion: "create-tag.v1",
      message: createTagCommitMessage(),
      payload: new CreateTagLedgerPayload({
        name: "Project Alpha",
        parentIds: [parentId, secondParentId],
        commitMessage: "Keep project profiles strongly typed.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-supertags-manager"
        })
      }),
      createdAt: new Date().toISOString()
    })
    expect(Schema.decodeUnknownSync(CreateTagLedgerCommand)(Schema.encodeSync(CreateTagLedgerCommand)(command))).toEqual(command)
    expect(command.message).toBe("Created a Supertag definition.")
    expect(command.message).not.toContain("strongly typed")
  })

  it("round-trips the private defineTagField command with a fixed public label", () => {
    const workspaceId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001")
    const tagId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000002")
    const command = new DefineTagFieldLedgerCommand({
      version: "athenaeum.workspace-ledger.v1",
      requestId: "define-field-1",
      fingerprint: "fingerprint-1",
      type: "defineTagField",
      workspaceId,
      principal: "operator@example.com",
      capability: "build",
      policy: "governed-role-v1",
      messageDerivationVersion: "define-tag-field.v1",
      message: defineTagFieldCommitMessage(),
      payload: new DefineTagFieldLedgerPayload({
        tagId,
        name: "daily status",
        valueKind: "text",
        sortOrder: 5,
        commitMessage: "Keep the daily brief schema useful.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-supertags-manager"
        })
      }),
      createdAt: new Date().toISOString()
    })
    expect(Schema.decodeUnknownSync(DefineTagFieldLedgerCommand)(Schema.encodeSync(DefineTagFieldLedgerCommand)(command))).toEqual(command)
    expect(command.message).toBe("Added a field to a Supertag definition.")
    expect(command.message).not.toContain("daily brief")
  })

  it("round-trips tag-membership commands with fixed public labels and private rationale", () => {
    const workspaceId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001")
    const nodeId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000002")
    const tagId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000003")
    const attribution = new HumanUiMutationAttribution({
      version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-graph-view"
    })
    const common = {
      version: "athenaeum.workspace-ledger.v1" as const,
      requestId: "membership-1",
      fingerprint: "fingerprint-1",
      workspaceId,
      principal: "operator@example.com",
      capability: "build" as const,
      policy: "governed-role-v1",
      createdAt: new Date().toISOString()
    }
    const assign = new AssignTagLedgerCommand({
      ...common,
      type: "assignTag",
      messageDerivationVersion: "assign-tag.v1",
      message: assignTagCommitMessage(),
      payload: new AssignTagLedgerPayload({
        nodeId, tagId, commitMessage: "Keep the relationship context.", attribution
      })
    })
    expect(Schema.decodeUnknownSync(AssignTagLedgerCommand)(Schema.encodeSync(AssignTagLedgerCommand)(assign))).toEqual(assign)
    expect(assign.message).toBe("Requested a Supertag membership.")
    expect(assign.message).not.toContain("relationship context")

    const unassign = new UnassignTagLedgerCommand({
      ...common,
      requestId: "membership-2",
      type: "unassignTag",
      messageDerivationVersion: "unassign-tag.v1",
      message: unassignTagCommitMessage(),
      payload: new UnassignTagLedgerPayload({
        nodeId, tagId, commitMessage: "Remove it after the relationship ends.", attribution
      })
    })
    expect(Schema.decodeUnknownSync(UnassignTagLedgerCommand)(Schema.encodeSync(UnassignTagLedgerCommand)(unassign))).toEqual(unassign)
    expect(unassign.message).toBe("Requested removal of a Supertag membership.")
    expect(unassign.message).not.toContain("relationship ends")
  })

  it("round-trips the private note-reference journal command", () => {
    const workspaceId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000001")
    const nodeId = Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000002")
    const edge = new SyncNoteReferencesLedgerEdge({
      id: "00000000-0000-4000-8000-000000000003" as any,
      relationDefinitionId: "00000000-0000-4000-8000-000000000004" as any,
      sourceNodeId: nodeId,
      targetNodeId: "00000000-0000-4000-8000-000000000005" as any
    })
    const command = new SyncNoteReferencesLedgerCommand({
      version: "athenaeum.workspace-ledger.v1",
      requestId: "sync-note-references-1",
      fingerprint: "fingerprint-1",
      type: "syncNoteReferences",
      workspaceId,
      principal: "operator@example.com",
      capability: "build",
      policy: "governed-role-v1",
      messageDerivationVersion: "sync-note-references.v1",
      message: syncNoteReferencesCommitMessage(),
      payload: new SyncNoteReferencesLedgerPayload({
        nodeId,
        referencedNodeIds: [edge.targetNodeId],
        created: [edge],
        removed: [],
        commitMessage: "Keep note mentions current.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor"
        })
      }),
      createdAt: new Date().toISOString()
    })
    expect(Schema.decodeUnknownSync(SyncNoteReferencesLedgerCommand)(Schema.encodeSync(SyncNoteReferencesLedgerCommand)(command))).toEqual(command)
    expect(command.message).toBe("Reconciled note mentions.")
  })
})
