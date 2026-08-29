import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Edge } from "./edge.js"
import { Fact } from "./fact.js"
import {
  AddFactInput,
  AddFactOutput,
  AssignTagInput,
  AssignTagOutput,
  ApplySupertagFieldValue,
  ApplySupertagInput,
  ApplySupertagOutput,
  CreateEdgeInput,
  CreateEdgeOutput,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionOutput,
  CreateTagInput,
  CreateTagOutput,
  DefineTagFieldInput,
  DefineTagFieldOutput,
  ListTagFieldsInput,
  ListTagFieldsOutput,
  ResolvedTagField,
  RunViewInput,
  RunViewOutput,
  SyncNoteReferencesInput,
  SyncNoteReferencesOutput,
  UnassignTagInput,
  UnassignTagOutput
} from "./graph-rpc.js"
import { MentionRelationId } from "./mention.js"
import { EntityId } from "./node.js"
import { HumanUiMutationAttribution } from "./ledger.js"
import { RelationDefinition } from "./relation-definition.js"
import { Tag } from "./tag.js"
import { TagFieldDefinition } from "./tag-field-definition.js"
import { ViewSpec } from "./view-spec.js"

const workspaceId = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const id1 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"
const id2 = "3fa85f64-5717-4562-b3fc-2c963f66afa8"
const id3 = "3fa85f64-5717-4562-b3fc-2c963f66afa9"

const fieldAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-supertag-field-editor"
})

const roundTrip = <A, I>(schema: Schema.Schema<A, I>, value: A) => {
  const encoded = Schema.encodeSync(schema)(value)
  expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value)
}

describe("graph RPC wire schemas", () => {
  it("round-trips CreateTagInput/Output", () => {
    roundTrip(
      CreateTagInput,
      new CreateTagInput({
        workspaceId: EntityId.make(workspaceId),
        name: "Colleague",
        parentIds: [EntityId.make(id1)],
        requestId: "graph-rpc-create-tag",
        commitMessage: "Define the Colleague Supertag.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-supertags-manager"
        })
      })
    )
    roundTrip(
      CreateTagOutput,
      new CreateTagOutput({
        tag: new Tag({ id: EntityId.make(id1), name: "Colleague", parentIds: [], builtin: false })
      })
    )
  })

  it("round-trips AddFactInput/Output", () => {
    roundTrip(
      AddFactInput,
      new AddFactInput({
        workspaceId: EntityId.make(workspaceId),
        nodeId: EntityId.make(id1),
        predicateId: "status",
        value: "done",
        requestId: "graph-rpc-test",
        commitMessage: "Record status.",
        attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-supertag-field-editor" })
      })
    )
    roundTrip(
      AddFactOutput,
      new AddFactOutput({
        fact: new Fact({
          id: EntityId.make(id1),
          nodeId: EntityId.make(id2),
          predicateId: "status",
          value: "done"
        })
      })
    )
  })

  it("round-trips CreateRelationDefinitionInput/Output", () => {
    roundTrip(
      CreateRelationDefinitionInput,
      new CreateRelationDefinitionInput({
        workspaceId: EntityId.make(workspaceId),
        forwardName: "employs",
        inverseName: "employed by",
        sourceTagId: EntityId.make(id1),
        targetTagId: EntityId.make(id2),
        cardinality: "one-to-many",
        requestId: "relation-definition-round-trip",
        commitMessage: "Define the relation for the graph test.",
        attribution: fieldAttribution()
      })
    )
    roundTrip(
      CreateRelationDefinitionOutput,
      new CreateRelationDefinitionOutput({
        relationDefinition: new RelationDefinition({
          id: EntityId.make(id1),
          forwardName: "employs",
          inverseName: "employed by",
          sourceTagId: EntityId.make(id2),
          targetTagId: EntityId.make(id3),
          cardinality: "one-to-many"
        })
      })
    )
  })

  it("round-trips CreateEdgeInput/Output", () => {
    roundTrip(
      CreateEdgeInput,
      new CreateEdgeInput({
        workspaceId: EntityId.make(workspaceId),
        relationDefinitionId: EntityId.make(id1),
        sourceNodeId: EntityId.make(id2),
        targetNodeId: EntityId.make(id3),
        requestId: "create-edge-graph-rpc",
        commitMessage: "Link the related nodes.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-backlinks"
        })
      })
    )
    roundTrip(
      CreateEdgeOutput,
      new CreateEdgeOutput({
        edge: new Edge({
          id: EntityId.make(id1),
          relationDefinitionId: EntityId.make(id2),
          sourceNodeId: EntityId.make(id3),
          targetNodeId: EntityId.make(workspaceId)
        })
      })
    )
  })

  it("round-trips authenticated, attributed tag-membership mutations", () => {
    const attribution = new HumanUiMutationAttribution({
      version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-graph-view"
    })
    const assign = new AssignTagInput({
      workspaceId: EntityId.make(workspaceId),
      nodeId: EntityId.make(id1),
      tagId: EntityId.make(id2),
      requestId: "assign-tag-graph-rpc",
      commitMessage: "Keep the person membership for relationship context.",
      attribution
    })
    roundTrip(AssignTagInput, assign)
    roundTrip(AssignTagOutput, new AssignTagOutput({
      nodeId: EntityId.make(id1), tagId: EntityId.make(id2), changed: true
    }))
    const unassign = new UnassignTagInput({
      workspaceId: EntityId.make(workspaceId),
      nodeId: EntityId.make(id1),
      tagId: EntityId.make(id2),
      requestId: "unassign-tag-graph-rpc",
      commitMessage: "Remove the person membership after the relationship ends.",
      attribution
    })
    roundTrip(UnassignTagInput, unassign)
    roundTrip(UnassignTagOutput, new UnassignTagOutput({
      nodeId: EntityId.make(id1), tagId: EntityId.make(id2), changed: false
    }))
  })

  it("round-trips RunViewInput with a viewName + full ViewSpec", () => {
    roundTrip(
      RunViewInput,
      new RunViewInput({
        workspaceId: EntityId.make(workspaceId),
        viewName: "graph_facts",
        viewSpec: new ViewSpec({
          filter: { op: "hasTag", tagId: EntityId.make(id1) },
          view: "table",
          visibleColumns: ["predicateId", "value"],
          rowLimit: 25
        })
      })
    )
  })

  it("round-trips RunViewOutput with arbitrary row shapes", () => {
    roundTrip(RunViewOutput, new RunViewOutput({ rows: [{ a: 1 }, { b: "two" }, 3, "four"] }))
  })

  it("round-trips SyncNoteReferencesInput/Output", () => {
    roundTrip(
      SyncNoteReferencesInput,
      new SyncNoteReferencesInput({
        workspaceId: EntityId.make(workspaceId),
        nodeId: EntityId.make(id1),
        referencedNodeIds: [EntityId.make(id2), EntityId.make(id3)],
        requestId: "sync-note-references-round-trip",
        commitMessage: "Keep note mentions current.",
        attribution: fieldAttribution()
      })
    )
    roundTrip(
      SyncNoteReferencesOutput,
      new SyncNoteReferencesOutput({
        edges: [
          new Edge({
            id: EntityId.make(id1),
            relationDefinitionId: MentionRelationId,
            sourceNodeId: EntityId.make(id2),
            targetNodeId: EntityId.make(id3)
          })
        ]
      })
    )
  })

  it("SyncNoteReferencesInput accepts an empty referencedNodeIds (all mentions removed)", () => {
    roundTrip(
      SyncNoteReferencesInput,
      new SyncNoteReferencesInput({
        workspaceId: EntityId.make(workspaceId),
        nodeId: EntityId.make(id1),
        referencedNodeIds: [],
        requestId: "sync-note-references-empty",
        commitMessage: "Clear stale note mentions.",
        attribution: fieldAttribution()
      })
    )
  })

  it("round-trips DefineTagFieldInput/Output", () => {
    roundTrip(
      DefineTagFieldInput,
      new DefineTagFieldInput({
        workspaceId: EntityId.make(workspaceId),
        tagId: EntityId.make(id1),
        name: "role",
        valueKind: "text",
        sortOrder: 0,
        requestId: "graph-field-round-trip",
        commitMessage: "Define the role field.",
        attribution: fieldAttribution()
      })
    )
    roundTrip(
      DefineTagFieldOutput,
      new DefineTagFieldOutput({
        fieldDefinition: new TagFieldDefinition({
          id: EntityId.make(id2),
          tagId: EntityId.make(id1),
          name: "role",
          valueKind: "text",
          sortOrder: 0,
          builtin: false
        })
      })
    )
  })

  it("rejects DefineTagFieldInput with a negative sortOrder", () => {
    const result = Schema.decodeUnknownEither(DefineTagFieldInput)({
      workspaceId,
      tagId: id1,
      name: "role",
      valueKind: "text",
      sortOrder: -1,
      requestId: "graph-field-negative",
      commitMessage: "Define the role field.",
      attribution: fieldAttribution()
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("round-trips ListTagFieldsInput/Output with own and inherited fields", () => {
    roundTrip(
      ListTagFieldsInput,
      new ListTagFieldsInput({ workspaceId: EntityId.make(workspaceId), tagId: EntityId.make(id1) })
    )
    roundTrip(
      ListTagFieldsOutput,
      new ListTagFieldsOutput({
        fields: [
          new ResolvedTagField({
            field: new TagFieldDefinition({
              id: EntityId.make(id2),
              tagId: EntityId.make(id1),
              name: "role",
              valueKind: "text",
              sortOrder: 0,
              builtin: false
            }),
            inherited: false
          }),
          new ResolvedTagField({
            field: new TagFieldDefinition({
              id: EntityId.make(id3),
              tagId: EntityId.make(workspaceId),
              name: "website",
              valueKind: "text",
              sortOrder: 0,
              builtin: true
            }),
            inherited: true
          })
        ]
      })
    )
  })

  it("round-trips ListTagFieldsOutput with an empty field list", () => {
    roundTrip(ListTagFieldsOutput, new ListTagFieldsOutput({ fields: [] }))
  })

  it("round-trips ApplySupertagInput/Output with field values", () => {
    roundTrip(
      ApplySupertagInput,
      new ApplySupertagInput({
        workspaceId: EntityId.make(workspaceId),
        nodeId: EntityId.make(id1),
        tagId: EntityId.make(id2),
        requestId: "apply-supertag-test-1",
        commitMessage: "Record the person context from this note.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1",
          kind: "humanUi",
          surface: "rich-text-editor"
        }),
        fieldValues: [new ApplySupertagFieldValue({ fieldId: EntityId.make(id3), value: "Engineer" })]
      })
    )
    roundTrip(
      ApplySupertagOutput,
      new ApplySupertagOutput({
        nodeId: EntityId.make(id1),
        tagId: EntityId.make(id2),
        facts: [
          new Fact({
            id: EntityId.make(id3),
            nodeId: EntityId.make(id1),
            predicateId: id3,
            value: "Engineer"
          })
        ]
      })
    )
  })

  it("round-trips ApplySupertagInput without fieldValues (tagging only)", () => {
    roundTrip(
      ApplySupertagInput,
      new ApplySupertagInput({
        workspaceId: EntityId.make(workspaceId),
        nodeId: EntityId.make(id1),
        tagId: EntityId.make(id2),
        requestId: "apply-supertag-test-2",
        commitMessage: "Record the tag on this note.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1",
          kind: "humanUi",
          surface: "rich-text-editor"
        })
      })
    )
  })

  it("round-trips ApplySupertagOutput with an empty facts array", () => {
    roundTrip(
      ApplySupertagOutput,
      new ApplySupertagOutput({ nodeId: EntityId.make(id1), tagId: EntityId.make(id2), facts: [] })
    )
  })
})
