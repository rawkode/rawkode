import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  BaseTagIds,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionLedgerCommand,
  CreateRelationDefinitionOutput,
  HumanUiMutationAttribution,
  LedgerCommand,
  ListRecentLedgerActivityOutput,
  RunViewInput,
  RunViewOutput,
  SyncFeedInput,
  SyncFeedOutput,
  ViewSpec,
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

const attribution = (surface: "web-graph-view" | "macos" = "web-graph-view") => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface
})

const input = (args: {
  readonly workspaceId: EntityId
  readonly requestId: string
  readonly forwardName?: string
  readonly inverseName?: string
  readonly sourceTagId?: EntityId
  readonly targetTagId?: EntityId
  readonly cardinality?: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many"
  readonly commitMessage?: string
  readonly attribution?: HumanUiMutationAttribution
}) => Schema.encodeSync(CreateRelationDefinitionInput)(new CreateRelationDefinitionInput({
  workspaceId: args.workspaceId,
  forwardName: args.forwardName ?? "works with",
  inverseName: args.inverseName ?? "worked with",
  sourceTagId: args.sourceTagId ?? BaseTagIds.Person,
  targetTagId: args.targetTagId ?? BaseTagIds.Project,
  cardinality: args.cardinality ?? "many-to-many",
  requestId: args.requestId,
  commitMessage: args.commitMessage ?? "Keep this graph relation useful for the daily standup.",
  attribution: args.attribution ?? attribution()
}))

const relationRows = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(RunViewOutput)(await stub.runView(Schema.encodeSync(RunViewInput)(new RunViewInput({
    workspaceId,
    viewName: "graph_relation_definitions",
    viewSpec: new ViewSpec({
      view: "table",
      visibleColumns: ["id", "forwardName", "inverseName", "sourceTagId", "targetTagId", "cardinality"],
      rowLimit: 100
    })
  })))).rows

const syncEntries = async (stub: Awaited<ReturnType<typeof connectToWorkspace>>, workspaceId: EntityId) =>
  Schema.decodeUnknownSync(SyncFeedOutput)(await stub.syncFeed(
    Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 }))
  )).entries

describe("createRelationDefinition ledger authority slice", () => {
  afterEach(() => {
    ledgerExecuteTestHook.afterMutation = undefined
  })

  it("records exact relation names and private provenance, then replays without duplicate side effects", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential, email } = await devSignIn(`relation-definition-ledger-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const first = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(await connection.stub.createRelationDefinition(input({
        workspaceId,
        requestId: "relation-definition-ledger-1",
        forwardName: " works with ",
        inverseName: "worked with",
        commitMessage: "Keep the exact names from the graph editor."
      })))
      const replay = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(await connection.stub.createRelationDefinition(input({
        workspaceId,
        requestId: "relation-definition-ledger-1",
        forwardName: " works with ",
        inverseName: "worked with",
        commitMessage: "Keep the exact names from the graph editor."
      })))
      expect(replay).toEqual(first)
      expect(first.relationDefinition.forwardName).toBe(" works with ")

      const native = workspaceDurableObjectStub(workspaceId)
      const requestIdentity = "create-relation-definition:relation-definition-ledger-1"
      const command = Schema.decodeUnknownSync(LedgerCommand)(await native.debugGetLedgerCommand(requestIdentity))
      expect(command).toMatchObject({
        type: "createRelationDefinition",
        principal: email,
        message: "Created a relation definition.",
        payload: {
          relationDefinitionId: first.relationDefinition.id,
          forwardName: " works with ",
          inverseName: "worked with",
          sourceTagId: BaseTagIds.Person,
          targetTagId: BaseTagIds.Project,
          cardinality: "many-to-many",
          commitMessage: "Keep the exact names from the graph editor.",
          attribution: { kind: "humanUi", surface: "web-graph-view" }
        }
      })
      expect(Schema.decodeUnknownSync(CreateRelationDefinitionLedgerCommand)(command).message).toBe("Created a relation definition.")
      expect(await native.debugGetLedgerReceipt(requestIdentity)).toMatchObject({
        output: { version: "athenaeum.workspace-ledger-receipt.v2", type: "createRelationDefinition" }
      })
      const sideEffect = {
        relationDefinitionId: first.relationDefinition.id,
        forwardName: " works with ",
        inverseName: "worked with",
        sourceTagId: BaseTagIds.Person,
        targetTagId: BaseTagIds.Project,
        cardinality: "many-to-many"
      }
      expect(await native.debugGetLedgerEvent(requestIdentity)).toEqual({ kind: "create-relation-definition", payload: sideEffect })
      expect(await native.debugGetLedgerOutboxIntent(requestIdentity)).toEqual({ kind: "create-relation-definition", payload: sideEffect })
      expect((await relationRows(connection.stub, workspaceId)).filter((row) => (row as { id?: string }).id === first.relationDefinition.id)).toHaveLength(1)
      expect((await syncEntries(connection.stub, workspaceId)).filter((entry) => entry.entityKind === "relationDefinition" && entry.entityId === first.relationDefinition.id)).toHaveLength(1)

      const activity = Schema.decodeUnknownSync(ListRecentLedgerActivityOutput)(await connection.stub.listRecentLedgerActivity({ workspaceId, limit: 10 }))
      expect(activity.entries.find((entry) => entry.type === "createRelationDefinition")).toEqual({
        occurredAt: expect.any(String),
        type: "createRelationDefinition",
        actor: "you",
        message: "Created a relation definition."
      })
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("treats names, tags, cardinality, rationale, and attribution as immutable request semantics", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`relation-definition-conflicts-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const cases = [
        { requestId: "relation-definition-name-conflict", changed: { forwardName: "Works with" } },
        { requestId: "relation-definition-whitespace-conflict", changed: { forwardName: "works with " } },
        { requestId: "relation-definition-cardinality-conflict", changed: { cardinality: "one-to-many" as const } },
        { requestId: "relation-definition-tags-conflict", changed: { targetTagId: BaseTagIds.Company } },
        { requestId: "relation-definition-rationale-conflict", changed: { commitMessage: "Use a different rationale." } },
        { requestId: "relation-definition-attribution-conflict", changed: { attribution: attribution("macos") } }
      ] as const

      for (const [index, testCase] of cases.entries()) {
        const first = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(await connection.stub.createRelationDefinition(input({
          workspaceId,
          requestId: testCase.requestId,
          forwardName: `relation ${index}`,
          inverseName: `inverse ${index}`
        })))
        const error = await rejectionToDomainError(connection.stub.createRelationDefinition(input({
          workspaceId,
          requestId: testCase.requestId,
          forwardName: `relation ${index}`,
          inverseName: `inverse ${index}`,
          ...testCase.changed
        })))
        expect(error._tag).toBe("ValidationError")
        expect((await relationRows(connection.stub, workspaceId)).filter((row) => (row as { id?: string }).id === first.relationDefinition.id)).toHaveLength(1)
      }

      const duplicateA = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(await connection.stub.createRelationDefinition(input({ workspaceId, requestId: "relation-definition-duplicate-a", forwardName: "same", inverseName: "same inverse" })))
      const duplicateB = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(await connection.stub.createRelationDefinition(input({ workspaceId, requestId: "relation-definition-duplicate-b", forwardName: "same", inverseName: "same inverse" })))
      expect(duplicateB.relationDefinition.id).not.toBe(duplicateA.relationDefinition.id)
    } finally {
      connection.stub[Symbol.dispose]()
    }
  })

  it("rejects anonymous and invalid-tag requests before creating a command or graph row", async () => {
    const workspaceId = freshWorkspaceId()
    const anonymous = await connectToWorkspace(workspaceId)
    const { credential } = await devSignIn(`relation-definition-invalid-${crypto.randomUUID()}@example.com`)
    const authenticated = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      expect((await rejectionToDomainError(anonymous.createRelationDefinition(input({ workspaceId, requestId: "relation-definition-anonymous" }))))._tag).toBe("Unauthorized")
      expect((await rejectionToDomainError(authenticated.stub.createRelationDefinition(input({
        workspaceId,
        requestId: "relation-definition-invalid-tag",
        sourceTagId: EntityId.make("00000000-0000-0000-0000-000000000099")
      }))))._tag).toBe("TagNotFound")
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await native.debugGetLedgerCommand("create-relation-definition:relation-definition-anonymous")).toBeNull()
      expect(await native.debugGetLedgerCommand("create-relation-definition:relation-definition-invalid-tag")).toBeNull()
      expect((await relationRows(authenticated.stub, workspaceId)).filter((row) => (row as { forwardName?: string }).forwardName === "works with")).toHaveLength(0)
    } finally {
      authenticated.stub[Symbol.dispose]()
      anonymous[Symbol.dispose]()
    }
  })

  it("rolls back the relation definition, feed, command, receipt, event, and outbox after a post-mutation failure", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`relation-definition-rollback-${crypto.randomUUID()}@example.com`)
    const connection = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const beforeRows = await relationRows(connection.stub, workspaceId)
      const beforeFeed = await syncEntries(connection.stub, workspaceId)
      ledgerExecuteTestHook.afterMutation = () => { throw new Error("createRelationDefinition ledger failpoint") }
      expect((await rejectionToDomainError(connection.stub.createRelationDefinition(input({
        workspaceId,
        requestId: "relation-definition-rollback"
      }))))._tag).toBe("UnexpectedError")
      ledgerExecuteTestHook.afterMutation = undefined
      const native = workspaceDurableObjectStub(workspaceId)
      expect(await relationRows(connection.stub, workspaceId)).toEqual(beforeRows)
      expect(await syncEntries(connection.stub, workspaceId)).toEqual(beforeFeed)
      expect(await native.debugGetLedgerCommand("create-relation-definition:relation-definition-rollback")).toBeNull()
      expect(await native.debugGetLedgerReceipt("create-relation-definition:relation-definition-rollback")).toBeNull()
      expect(await native.debugGetLedgerEvent("create-relation-definition:relation-definition-rollback")).toBeNull()
      expect(await native.debugGetLedgerOutboxIntent("create-relation-definition:relation-definition-rollback")).toBeNull()
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
      connection.stub[Symbol.dispose]()
    }
  })
})
