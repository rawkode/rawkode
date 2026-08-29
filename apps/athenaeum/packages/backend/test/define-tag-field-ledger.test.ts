import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  BaseTagIds,
  DefineTagFieldInput,
  DefineTagFieldLedgerCommand,
  DefineTagFieldOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityOutput,
  ListTagFieldsInput,
  ListTagFieldsOutput,
  SyncFeedInput,
  SyncFeedOutput,
  EntityId
} from "@athenaeum/domain"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
import {
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

const managerAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-supertags-manager"
})

const editorAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-supertag-field-editor"
})

const fieldInput = (args: {
  readonly workspaceId: EntityId
  readonly tagId?: EntityId
  readonly name?: string
  readonly valueKind?: "text" | "number" | "date" | "checkbox" | "entity-ref"
  readonly sortOrder?: number
  readonly requestId: string
  readonly commitMessage?: string
  readonly attribution?: HumanUiMutationAttribution
}) => Schema.encodeSync(DefineTagFieldInput)(new DefineTagFieldInput({
  workspaceId: args.workspaceId,
  tagId: args.tagId ?? BaseTagIds.Person,
  name: args.name ?? "profile status",
  valueKind: args.valueKind ?? "text",
  sortOrder: args.sortOrder ?? 5,
  requestId: args.requestId,
  commitMessage: args.commitMessage ?? "Capture this field for the daily brief.",
  attribution: args.attribution ?? managerAttribution()
}))

const fields = async (
  stub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: EntityId,
  tagId: EntityId = BaseTagIds.Person
) => Schema.decodeUnknownSync(ListTagFieldsOutput)(await stub.listTagFields(
  Schema.encodeSync(ListTagFieldsInput)(new ListTagFieldsInput({ workspaceId, tagId }))
)).fields

const syncEntries = async (
  stub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: EntityId
) => Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
  Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 200 }))
)).entries

describe.sequential("defineTagField ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("normalizes once, records private provenance, replays exactly, and emits one schema transition", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`define-field-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const input = fieldInput({
        workspaceId,
        name: "  daily   status\n",
        requestId: "define-field-ledger-1",
        commitMessage: "Keep the daily brief schema useful.",
        attribution: editorAttribution()
      })
      const first = Schema.decodeUnknownSync(DefineTagFieldOutput)(await connection.stub.defineTagField(input))
      const equivalentReplay = Schema.decodeUnknownSync(DefineTagFieldOutput)(await connection.stub.defineTagField(fieldInput({
        workspaceId,
        name: "daily status",
        requestId: "define-field-ledger-1",
        commitMessage: "Keep the daily brief schema useful.",
        attribution: editorAttribution()
      })))
      expect(first).toEqual(equivalentReplay)
      expect(first.fieldDefinition.name).toBe("daily status")

      const native = workspaceDurableObjectStub(workspaceId)
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand("define-tag-field:define-field-ledger-1"))
      expect(command).toMatchObject({
        type: "defineTagField",
        principal: email,
        message: "Added a field to a Supertag definition.",
        payload: {
          tagId: BaseTagIds.Person,
          name: "daily status",
          valueKind: "text",
          sortOrder: 5,
          commitMessage: "Keep the daily brief schema useful.",
          attribution: { kind: "humanUi", surface: "web-supertag-field-editor" }
        }
      })
      expect((command as DefineTagFieldLedgerCommand).message).not.toContain("daily brief")
      expect(await native.debugGetLedgerReceipt("define-tag-field:define-field-ledger-1")).toMatchObject({
        output: { version: "athenaeum.workspace-ledger-receipt.v2", type: "defineTagField" }
      })
      const expectedSideEffect = {
        fieldDefinitionId: first.fieldDefinition.id,
        tagId: BaseTagIds.Person,
        name: "daily status",
        valueKind: "text",
        sortOrder: 5
      }
      expect(await native.debugGetLedgerEvent("define-tag-field:define-field-ledger-1")).toEqual({
        kind: "define-tag-field",
        payload: expectedSideEffect
      })
      expect(await native.debugGetLedgerOutboxIntent("define-tag-field:define-field-ledger-1")).toEqual({
        kind: "define-tag-field",
        payload: expectedSideEffect
      })

      expect((await fields(connection.stub, workspaceId)).filter((entry) => entry.field.id === first.fieldDefinition.id)).toHaveLength(1)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "tagFieldDefinition" && entry.entityId === first.fieldDefinition.id)).toHaveLength(1)

      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await connection.stub.listRecentLedgerActivity({ workspaceId, limit: 20 }))
      const fieldActivity = activity.entries.find((entry) => entry.type === "defineTagField")
      expect(fieldActivity).toEqual({
        occurredAt: expect.any(String),
        type: "defineTagField",
        actor: "you",
        message: "Added a field to a Supertag definition."
      })
      expect(JSON.stringify(fieldActivity)).not.toContain("daily brief")
      expect(JSON.stringify(fieldActivity)).not.toContain("web-supertag-field-editor")
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rejects changed semantic input for one request without a second definition", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`define-field-conflict-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const requestId = "define-field-conflict"
      await connection.stub.defineTagField(fieldInput({ workspaceId, requestId, name: "conflict field" }))
      const cases = [
        fieldInput({ workspaceId, requestId, name: "other field" }),
        fieldInput({ workspaceId, requestId, valueKind: "date" }),
        fieldInput({ workspaceId, requestId, sortOrder: 6 }),
        fieldInput({ workspaceId, requestId, commitMessage: "A different reason." }),
        fieldInput({ workspaceId, requestId, attribution: editorAttribution() })
      ]
      for (const changed of cases) {
        expect((await rejectionToDomainError(connection.stub.defineTagField(changed)))._tag).toBe("ValidationError")
      }
      expect((await fields(connection.stub, workspaceId)).filter((entry) => entry.field.name === "conflict field")).toHaveLength(1)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "tagFieldDefinition")).toHaveLength(1)
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand(`define-tag-field:${requestId}`)).not.toBeNull()
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("fails closed for anonymous and unknown-tag callers without ledger or sync writes", async () => {
    const workspaceId = freshWorkspaceId()
    const anonymous = await connectToWorkspace(workspaceId)
    try {
      expect((await rejectionToDomainError(anonymous.defineTagField(fieldInput({ workspaceId, requestId: "define-field-anonymous" }))))._tag).toBe("Unauthorized")
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("define-tag-field:define-field-anonymous")).toBeNull()
    } finally {
      anonymous[Symbol.dispose]()
    }

    const { credential } = await devSignIn(`define-field-unknown-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const unknownTagId = EntityId.make("00000000-0000-0000-0000-0000000000ff")
      expect((await rejectionToDomainError(connection.stub.defineTagField(fieldInput({
        workspaceId,
        tagId: unknownTagId,
        requestId: "define-field-unknown"
      }))))._tag).toBe("TagNotFound")
      expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand("define-tag-field:define-field-unknown")).toBeNull()
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "tagFieldDefinition")).toHaveLength(0)
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rolls back the field collection, sync feed, command, receipt, event, and outbox", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`define-field-rollback-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const beforeFields = await fields(connection.stub, workspaceId)
      const beforeFeed = await syncEntries(connection.stub, workspaceId)
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("defineTagField ledger failpoint") }
      expect((await rejectionToDomainError(connection.stub.defineTagField(fieldInput({
        workspaceId,
        name: "rolled back field",
        requestId: "define-field-rollback"
      }))))._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined

      expect(await fields(connection.stub, workspaceId)).toEqual(beforeFields)
      expect(await syncEntries(connection.stub, workspaceId)).toEqual(beforeFeed)
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("define-tag-field:define-field-rollback")).toBeNull()
      expect(await native.debugGetLedgerReceipt("define-tag-field:define-field-rollback")).toBeNull()
      expect(await native.debugGetLedgerEvent("define-tag-field:define-field-rollback")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("define-tag-field:define-field-rollback")).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      connection.stub[Symbol.dispose]()
    }
  })
})
