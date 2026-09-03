// Storage/Views stage verification: "tag closure is correct for a 3-level inheritance chain" and
// "a graph issue is correctly recorded on a conflicting concurrent edge creation", plus
// `listBacklinks` and the plain (non-concurrent) `CardinalityViolation` rejection path.

import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  ApplySupertagFieldValue,
  ApplySupertagInput,
  ApplySupertagOutput,
  AssignTagInput,
  AssignTagOutput,
  BaseTagFieldIds,
  BaseTagIds,
  BASE_TAGS,
  BASE_TAG_FIELD_DEFINITIONS,
  CreateEdgeInput,
  CreateEdgeOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionOutput,
  CreateTagInput,
  CreateTagOutput,
  DefineTagFieldInput,
  DefineTagFieldOutput,
  HumanUiMutationAttribution,
  ListBacklinksInput,
  ListBacklinksOutput,
  ListGraphIssuesInput,
  ListGraphIssuesOutput,
  ListTagClosureInput,
  ListTagClosureOutput,
  ListTagFieldsInput,
  ListTagFieldsOutput,
  RunViewInput,
  RunViewOutput,
  UnassignTagInput,
  UnassignTagOutput,
  ViewSpec,
  type EntityId
} from "@athenaeum/domain"
import { createEdgeTestHook } from "../src/graph-service-live.js"
import { connectToWorkspace, connectToWorkspaceWithSocketAs, devSignIn, freshWorkspaceId, rejectionToDomainError } from "./support.js"

const edgeAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-backlinks"
})

const edgeInput = (workspaceId: EntityId, relationDefinitionId: EntityId, sourceNodeId: EntityId, targetNodeId: EntityId, requestId: string) =>
  new CreateEdgeInput({
    workspaceId,
    relationDefinitionId,
    sourceNodeId,
    targetNodeId,
    requestId,
    commitMessage: "Link the related workspace nodes.",
    attribution: edgeAttribution()
  })

const relationInput = (args: { readonly workspaceId: EntityId; readonly forwardName: string; readonly inverseName: string; readonly sourceTagId: EntityId; readonly targetTagId: EntityId; readonly cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many"; readonly requestId: string }) =>
  new CreateRelationDefinitionInput({
    ...args,
    commitMessage: `Define ${args.forwardName} for this graph test.`,
    attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-graph-view" })
  })

const tagAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-supertags-manager"
})

const tagInput = (workspaceId: EntityId, name: string, parentIds: ReadonlyArray<EntityId>, requestId: string) =>
  new CreateTagInput({
    workspaceId,
    name,
    parentIds,
    requestId,
    commitMessage: `Define the ${name} Supertag for this test.`,
    attribution: tagAttribution()
  })

const fieldAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-supertags-manager"
})

const fieldInput = (workspaceId: EntityId, tagId: EntityId, name: string, requestId: string) =>
  new DefineTagFieldInput({
    workspaceId,
    tagId,
    name,
    valueKind: "text",
    sortOrder: 0,
    requestId,
    commitMessage: `Define the ${name} field for this test.`,
    attribution: fieldAttribution()
  })

const membershipAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-graph-view"
})

const assignInput = (workspaceId: EntityId, nodeId: EntityId, tagId: EntityId, requestId: string) => new AssignTagInput({
  workspaceId, nodeId, tagId, requestId,
  commitMessage: "Assign the Supertag for this graph test.", attribution: membershipAttribution()
})

const unassignInput = (workspaceId: EntityId, nodeId: EntityId, tagId: EntityId, requestId: string) => new UnassignTagInput({
  workspaceId, nodeId, tagId, requestId,
  commitMessage: "Remove the Supertag for this graph test.", attribution: membershipAttribution()
})

const authenticatedWorkspace = async (workspaceId: EntityId, label: string) => {
  const { credential } = await devSignIn(`graph-${label}-${crypto.randomUUID()}@example.com`)
  return (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub
}

describe("Base Tag seeding", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("every fresh workspace DO has all 8 Base Tags present (reflexively) in its closure, idempotently", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const closure = Schema.decodeUnknownSync(ListTagClosureOutput)(
      await workspaceStub.listTagClosure(Schema.encodeSync(ListTagClosureInput)(new ListTagClosureInput({ workspaceId })))
    ).entries

    for (const baseTag of BASE_TAGS) {
      expect(closure.some((e) => e.ancestorId === baseTag.id && e.descendantId === baseTag.id)).toBe(true)
    }
    expect(closure.length).toBe(BASE_TAGS.length)

    // A second connection to the same workspace (same DO instance across reconnects) sees the exact
    // same closure — proof seeding didn't duplicate anything on a second "construction".
    const secondStub = await connectToWorkspace(workspaceId)
    try {
      const closureAgain = Schema.decodeUnknownSync(ListTagClosureOutput)(
        await secondStub.listTagClosure(Schema.encodeSync(ListTagClosureInput)(new ListTagClosureInput({ workspaceId })))
      ).entries
      expect(closureAgain.length).toBe(BASE_TAGS.length)
    } finally {
      secondStub[Symbol.dispose]()
    }
  })
})

describe("tag closure: correct for a 3-level inheritance chain", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("Grandchild -> Child -> Parent(=Person base tag): closure includes every level, transitively", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await authenticatedWorkspace(workspaceId, "closure")

    const child = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(tagInput(workspaceId, "Employee", [BaseTagIds.Person], "graph-closure-employee"))
      )
    ).tag

    const grandchild = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(tagInput(workspaceId, "Engineer", [child.id], "graph-closure-engineer"))
      )
    ).tag

    const closure = Schema.decodeUnknownSync(ListTagClosureOutput)(
      await workspaceStub.listTagClosure(Schema.encodeSync(ListTagClosureInput)(new ListTagClosureInput({ workspaceId })))
    ).entries

    const hasEntry = (ancestorId: string, descendantId: string) =>
      closure.some((e) => e.ancestorId === ancestorId && e.descendantId === descendantId)

    // Reflexive self-membership at every level.
    expect(hasEntry(grandchild.id, grandchild.id)).toBe(true)
    expect(hasEntry(child.id, child.id)).toBe(true)
    expect(hasEntry(BaseTagIds.Person, BaseTagIds.Person)).toBe(true)

    // Direct parent links.
    expect(hasEntry(child.id, grandchild.id)).toBe(true)
    expect(hasEntry(BaseTagIds.Person, child.id)).toBe(true)

    // The transitive (2-hop) link: Grandchild inherits from Person, its grandparent — this is
    // the entry that a naive "only record direct parentIds" implementation would miss.
    expect(hasEntry(BaseTagIds.Person, grandchild.id)).toBe(true)

    // And nothing unrelated: Grandchild is not, e.g., its own ancestor's descendant-of-a-sibling.
    expect(hasEntry(grandchild.id, BaseTagIds.Person)).toBe(false)
    expect(hasEntry(grandchild.id, child.id)).toBe(false)
  })

  it("createTag with an unknown parentId fails closed as TagNotFound", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await authenticatedWorkspace(workspaceId, "unknown-parent")
    const bogusParent = "00000000-0000-0000-0000-0000000000ff"

    const error = await rejectionToDomainError(
      workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(tagInput(workspaceId, "Orphan", [bogusParent as any], "graph-unknown-parent"))
      )
    )
    expect(error._tag).toBe("TagNotFound")
  })
})

describe("createEdge: cardinality enforcement and concurrent-conflict GraphIssue recording", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    createEdgeTestHook.beforeWrite = undefined
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  const setupRelation = async (
    workspaceId: ReturnType<typeof freshWorkspaceId>,
    stub: NonNullable<typeof workspaceStub>,
    cardinality: "one-to-one" | "many-to-one" | "one-to-many" | "many-to-many"
  ) => {
    const relationDefinition = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(
      await stub.createRelationDefinition(
        Schema.encodeSync(CreateRelationDefinitionInput)(
          relationInput({ workspaceId, forwardName: "manages", inverseName: "managed by", sourceTagId: BaseTagIds.Person, targetTagId: BaseTagIds.Person, cardinality, requestId: `graph-manages-${cardinality}` })
        )
      )
    ).relationDefinition

    const source = Schema.decodeUnknownSync(CreateNodeOutput)(
      await stub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Manager" })))
    ).node
    const targetA = Schema.decodeUnknownSync(CreateNodeOutput)(
      await stub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Report A" })))
    ).node
    const targetB = Schema.decodeUnknownSync(CreateNodeOutput)(
      await stub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Report B" })))
    ).node

    return { relationDefinition, source, targetA, targetB }
  }

  it("a plain sequential second edge under a max-one relation is rejected as CardinalityViolation, not silently allowed", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`graph-edge-sequential-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub
    const { relationDefinition, source, targetA, targetB } = await setupRelation(workspaceId, workspaceStub, "one-to-one")

    await workspaceStub.createEdge(
      Schema.encodeSync(CreateEdgeInput)(
        edgeInput(workspaceId, relationDefinition.id, source.id, targetA.id, "graph-edge-sequential-first")
      )
    )

    const error = await rejectionToDomainError(
      workspaceStub.createEdge(
        Schema.encodeSync(CreateEdgeInput)(
          edgeInput(workspaceId, relationDefinition.id, source.id, targetB.id, "graph-edge-sequential-second")
        )
      )
    )
    expect(error._tag).toBe("CardinalityViolation")

    const issues = Schema.decodeUnknownSync(ListGraphIssuesOutput)(
      await workspaceStub.listGraphIssues(Schema.encodeSync(ListGraphIssuesInput)(new ListGraphIssuesInput({ workspaceId })))
    ).graphIssues
    // The rejected path must NOT also record a GraphIssue — that's reserved for the genuinely
    // concurrent case (errors.ts's own doc comment distinguishes the two explicitly).
    expect(issues).toHaveLength(0)
  })

  it(
    "a persisted max-one conflict after the pre-check preserves both edges and records exactly one GraphIssue",
    async () => {
      const workspaceId = freshWorkspaceId()
      const { credential } = await devSignIn(`graph-edge-conflict-${crypto.randomUUID()}@example.com`)
      workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub
      const { relationDefinition, source, targetA, targetB } = await setupRelation(workspaceId, workspaceStub, "many-to-one")

      let injectedEdgeId: string | undefined
      createEdgeTestHook.beforeWrite = ({ insertConflictingEdge }) => {
        injectedEdgeId = insertConflictingEdge(targetB.id).id
      }

      const firstCall = workspaceStub.createEdge(
        Schema.encodeSync(CreateEdgeInput)(
          edgeInput(workspaceId, relationDefinition.id, source.id, targetA.id, "graph-edge-conflict-candidate")
        )
      )
      const firstResult = Schema.decodeUnknownSync(CreateEdgeOutput)(await firstCall)

      // Both edges were persisted — neither conflicting assertion was silently dropped, per
      // Evolution Rule #4 ("preserve conflicting graph assertions through merge").
      expect(firstResult.edge.targetNodeId).toBe(targetA.id)
      expect(injectedEdgeId).toBeDefined()

      const issues = Schema.decodeUnknownSync(ListGraphIssuesOutput)(
        await workspaceStub.listGraphIssues(Schema.encodeSync(ListGraphIssuesInput)(new ListGraphIssuesInput({ workspaceId })))
      ).graphIssues
      expect(issues).toHaveLength(1)
      expect(issues[0]!.kind).toBe("concurrent-max-one-edge-conflict")
      expect(issues[0]!.relationDefinitionId).toBe(relationDefinition.id)
      expect(issues[0]!.nodeId).toBe(source.id)
      expect(new Set(issues[0]!.conflictingEdgeIds)).toEqual(new Set([firstResult.edge.id, injectedEdgeId]))
    }
  )

  it("many-to-many relations never trigger a cardinality conflict for multiple edges from the same source", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`graph-edge-many-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub
    const { relationDefinition, source, targetA, targetB } = await setupRelation(workspaceId, workspaceStub, "many-to-many")

    await workspaceStub.createEdge(
      Schema.encodeSync(CreateEdgeInput)(
        edgeInput(workspaceId, relationDefinition.id, source.id, targetA.id, "graph-edge-many-a")
      )
    )
    await workspaceStub.createEdge(
      Schema.encodeSync(CreateEdgeInput)(
        edgeInput(workspaceId, relationDefinition.id, source.id, targetB.id, "graph-edge-many-b")
      )
    )

    const issues = Schema.decodeUnknownSync(ListGraphIssuesOutput)(
      await workspaceStub.listGraphIssues(Schema.encodeSync(ListGraphIssuesInput)(new ListGraphIssuesInput({ workspaceId })))
    ).graphIssues
    expect(issues).toHaveLength(0)
  })
})

describe("listBacklinks: via the edges-by-target index", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("returns every edge pointing at a node, and only those", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`graph-edge-backlinks-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    const relationDefinition = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(
      await workspaceStub.createRelationDefinition(
        Schema.encodeSync(CreateRelationDefinitionInput)(
          relationInput({ workspaceId, forwardName: "cites", inverseName: "cited by", sourceTagId: BaseTagIds.Task, targetTagId: BaseTagIds.Task, cardinality: "many-to-many", requestId: "graph-cites-1" })
        )
      )
    ).relationDefinition

    const target = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Cited" })))
    ).node
    const sourceOne = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Citer 1" })))
    ).node
    const sourceTwo = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Citer 2" })))
    ).node
    const unrelated = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Unrelated" })))
    ).node

    const edgeOne = Schema.decodeUnknownSync(CreateEdgeOutput)(
      await workspaceStub.createEdge(
        Schema.encodeSync(CreateEdgeInput)(
          edgeInput(workspaceId, relationDefinition.id, sourceOne.id, target.id, "graph-edge-backlink-one")
        )
      )
    ).edge
    const edgeTwo = Schema.decodeUnknownSync(CreateEdgeOutput)(
      await workspaceStub.createEdge(
        Schema.encodeSync(CreateEdgeInput)(
          edgeInput(workspaceId, relationDefinition.id, sourceTwo.id, target.id, "graph-edge-backlink-two")
        )
      )
    ).edge
    await workspaceStub.createEdge(
      Schema.encodeSync(CreateEdgeInput)(
        edgeInput(workspaceId, relationDefinition.id, sourceOne.id, unrelated.id, "graph-edge-backlink-unrelated")
      )
    )

    const backlinks = Schema.decodeUnknownSync(ListBacklinksOutput)(
      await workspaceStub.listBacklinks(Schema.encodeSync(ListBacklinksInput)(new ListBacklinksInput({ workspaceId, nodeId: target.id })))
    ).edges

    expect(new Set(backlinks.map((e) => e.id))).toEqual(new Set([edgeOne.id, edgeTwo.id]))
  })
})

// Supertag-centering pass (docs/supertag-centering-decisions.md §1/§2): field definitions +
// closure-based field resolution + one-call tag application.

describe("Base Tag field seeding", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("every fresh workspace's Base Tags already have their seeded default fields, idempotently", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const personFields = Schema.decodeUnknownSync(ListTagFieldsOutput)(
      await workspaceStub.listTagFields(
        Schema.encodeSync(ListTagFieldsInput)(new ListTagFieldsInput({ workspaceId, tagId: BaseTagIds.Person }))
      )
    ).fields

    expect(personFields.map((f) => f.field.name).sort()).toEqual(["company", "email", "role"])
    expect(personFields.every((f) => f.field.builtin === true)).toBe(true)
    expect(personFields.every((f) => f.inherited === false)).toBe(true)
    expect(personFields.find((f) => f.field.name === "company")!.field.valueKind).toBe("entity-ref")

    const taskFields = Schema.decodeUnknownSync(ListTagFieldsOutput)(
      await workspaceStub.listTagFields(
        Schema.encodeSync(ListTagFieldsInput)(new ListTagFieldsInput({ workspaceId, tagId: BaseTagIds.Task }))
      )
    ).fields
    expect(taskFields.map((f) => f.field.name).sort()).toEqual(["dueDate", "priority", "status"])

    // A second connection to the same workspace (same DO instance) sees the exact same fields —
    // proof seeding didn't duplicate on a second "construction", mirroring the "Base Tag seeding"
    // suite's own idempotency check above.
    const secondStub = await connectToWorkspace(workspaceId)
    try {
      const again = Schema.decodeUnknownSync(ListTagFieldsOutput)(
        await secondStub.listTagFields(
          Schema.encodeSync(ListTagFieldsInput)(new ListTagFieldsInput({ workspaceId, tagId: BaseTagIds.Person }))
        )
      ).fields
      expect(again.length).toBe(3)
      expect(new Set(again.map((f) => f.field.id))).toEqual(
        new Set([BaseTagFieldIds.PersonRole, BaseTagFieldIds.PersonEmail, BaseTagFieldIds.PersonCompany])
      )
    } finally {
      secondStub[Symbol.dispose]()
    }

    // Every seeded field is present somewhere, exactly once total across all 8 Base Tags.
    let total = 0
    for (const tagId of Object.values(BaseTagIds)) {
      const fields = Schema.decodeUnknownSync(ListTagFieldsOutput)(
        await workspaceStub.listTagFields(Schema.encodeSync(ListTagFieldsInput)(new ListTagFieldsInput({ workspaceId, tagId })))
      ).fields
      total += fields.filter((f) => !f.inherited).length
    }
    expect(total).toBe(BASE_TAG_FIELD_DEFINITIONS.length)
  })
})

describe("defineTagField", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("adds a new, non-builtin field to an existing tag", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await authenticatedWorkspace(workspaceId, "define-field")

    const tag = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(tagInput(workspaceId, "Reviewer", [], "graph-define-field-reviewer"))
      )
    ).tag

    const output = Schema.decodeUnknownSync(DefineTagFieldOutput)(
      await workspaceStub.defineTagField(
        Schema.encodeSync(DefineTagFieldInput)(
          fieldInput(workspaceId, tag.id, "level", "graph-fields-level")
        )
      )
    ).fieldDefinition

    expect(output.name).toBe("level")
    expect(output.tagId).toBe(tag.id)
    expect(output.valueKind).toBe("text")
    expect(output.builtin).toBe(false)

    const fields = Schema.decodeUnknownSync(ListTagFieldsOutput)(
      await workspaceStub.listTagFields(Schema.encodeSync(ListTagFieldsInput)(new ListTagFieldsInput({ workspaceId, tagId: tag.id })))
    ).fields
    expect(fields.map((f) => f.field.id)).toEqual([output.id])
  })

  it("against an unknown tagId fails closed as TagNotFound", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await authenticatedWorkspace(workspaceId, "unknown-field")
    const bogusTagId = "00000000-0000-0000-0000-0000000000ff"

    const error = await rejectionToDomainError(
      workspaceStub.defineTagField(
        Schema.encodeSync(DefineTagFieldInput)(
          fieldInput(workspaceId, bogusTagId as any, "level", "graph-fields-unknown")
        )
      )
    )
    expect(error._tag).toBe("TagNotFound")
  })
})

describe("listTagFields: closure-based inheritance", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("multi-level: Grandchild -> Child -> Person sees its own field plus every ancestor's, correctly flagged", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await authenticatedWorkspace(workspaceId, "list-fields")

    const child = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(tagInput(workspaceId, "Employee", [BaseTagIds.Person], "graph-fields-employee"))
      )
    ).tag
    const grandchild = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(tagInput(workspaceId, "Engineer", [child.id], "graph-fields-engineer"))
      )
    ).tag

    const childField = Schema.decodeUnknownSync(DefineTagFieldOutput)(
      await workspaceStub.defineTagField(
        Schema.encodeSync(DefineTagFieldInput)(
          fieldInput(workspaceId, child.id, "team", "graph-fields-team")
        )
      )
    ).fieldDefinition
    const grandchildField = Schema.decodeUnknownSync(DefineTagFieldOutput)(
      await workspaceStub.defineTagField(
        Schema.encodeSync(DefineTagFieldInput)(
          fieldInput(workspaceId, grandchild.id, "level", "graph-fields-level-grandchild")
        )
      )
    ).fieldDefinition

    const resolved = Schema.decodeUnknownSync(ListTagFieldsOutput)(
      await workspaceStub.listTagFields(
        Schema.encodeSync(ListTagFieldsInput)(new ListTagFieldsInput({ workspaceId, tagId: grandchild.id }))
      )
    ).fields

    // Its own field (level) plus Child's (team) plus every one of Person's 3 seeded defaults —
    // 5 total, none duplicated, exactly the "own fields first, then ancestors'" ordering rule.
    expect(resolved.length).toBe(5)
    expect(resolved[0]!.field.id).toBe(grandchildField.id)
    expect(resolved[0]!.inherited).toBe(false)

    const byId = new Map(resolved.map((r) => [r.field.id, r]))
    expect(byId.get(childField.id)!.inherited).toBe(true)
    expect(byId.get(BaseTagFieldIds.PersonRole)!.inherited).toBe(true)
    expect(byId.get(BaseTagFieldIds.PersonEmail)!.inherited).toBe(true)
    expect(byId.get(BaseTagFieldIds.PersonCompany)!.inherited).toBe(true)
  })

  it("diamond: a common grandparent's field is inherited exactly once, not once per path", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await authenticatedWorkspace(workspaceId, "diamond")

    // D (root) <- B, D <- C, and A <- B, A <- C (A reaches D via two independent paths).
    const tagD = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(Schema.encodeSync(CreateTagInput)(tagInput(workspaceId, "D", [], "graph-diamond-d")))
    ).tag
    const tagB = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(Schema.encodeSync(CreateTagInput)(tagInput(workspaceId, "B", [tagD.id], "graph-diamond-b")))
    ).tag
    const tagC = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(Schema.encodeSync(CreateTagInput)(tagInput(workspaceId, "C", [tagD.id], "graph-diamond-c")))
    ).tag
    const tagA = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(tagInput(workspaceId, "A", [tagB.id, tagC.id], "graph-diamond-a"))
      )
    ).tag

    const sharedField = Schema.decodeUnknownSync(DefineTagFieldOutput)(
      await workspaceStub.defineTagField(
        Schema.encodeSync(DefineTagFieldInput)(
          fieldInput(workspaceId, tagD.id, "shared", "graph-fields-shared")
        )
      )
    ).fieldDefinition

    const resolved = Schema.decodeUnknownSync(ListTagFieldsOutput)(
      await workspaceStub.listTagFields(Schema.encodeSync(ListTagFieldsInput)(new ListTagFieldsInput({ workspaceId, tagId: tagA.id })))
    ).fields

    // D's field appears exactly once, despite A reaching D via both B and C.
    const matches = resolved.filter((r) => r.field.id === sharedField.id)
    expect(matches.length).toBe(1)
    expect(matches[0]!.inherited).toBe(true)
  })
})

describe("applySupertag: tags a node and seeds field values in one call", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("assigns the tag and creates one Fact per supplied field value, atomically from the caller's perspective", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Ada Lovelace" })))
    ).node

    const output = Schema.decodeUnknownSync(ApplySupertagOutput)(
      await workspaceStub.applySupertag(
        Schema.encodeSync(ApplySupertagInput)(
          new ApplySupertagInput({
            workspaceId,
            nodeId: node.id,
            tagId: BaseTagIds.Person,
            requestId: "apply-supertag-person-1",
            commitMessage: "Record the person details from the note.",
            attribution: new HumanUiMutationAttribution({
              version: "athenaeum.mutation-attribution.v1",
              kind: "humanUi",
              surface: "rich-text-editor"
            }),
            fieldValues: [
              new ApplySupertagFieldValue({ fieldId: BaseTagFieldIds.PersonRole, value: "Mathematician" }),
              new ApplySupertagFieldValue({ fieldId: BaseTagFieldIds.PersonEmail, value: "ada@example.com" })
            ]
          })
        )
      )
    )

    expect(output.nodeId).toBe(node.id)
    expect(output.tagId).toBe(BaseTagIds.Person)
    expect(output.facts.length).toBe(2)
    expect(new Set(output.facts.map((f) => f.predicateId))).toEqual(
      new Set([BaseTagFieldIds.PersonRole, BaseTagFieldIds.PersonEmail])
    )
    expect(output.facts.every((f) => f.nodeId === node.id)).toBe(true)
    expect(output.facts.every((f) => f.pending === undefined)).toBe(true)

    // The tag assignment itself is real — provable independently via the read-model's `hasTag`
    // filter (views-search.test.ts's own established pattern), not just by trusting the RPC's
    // echoed-back `tagId`.
    const spec = new ViewSpec({
      filter: { op: "hasTag", tagId: BaseTagIds.Person },
      view: "table",
      visibleColumns: ["id"],
      rowLimit: 50
    })
    const rows = Schema.decodeUnknownSync(RunViewOutput)(
      await workspaceStub.runView(Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_nodes", viewSpec: spec })))
    ).rows
    expect(rows.some((row) => (row as { id: string }).id === node.id)).toBe(true)
  })

  it("with no fieldValues just tags the node — an equally valid, empty-facts application", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await authenticatedWorkspace(workspaceId, "apply-empty")

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Untitled" })))
    ).node

    const output = Schema.decodeUnknownSync(ApplySupertagOutput)(
      await workspaceStub.applySupertag(
        Schema.encodeSync(ApplySupertagInput)(new ApplySupertagInput({
          workspaceId,
          nodeId: node.id,
          tagId: BaseTagIds.Task,
          requestId: "apply-supertag-task-1",
          commitMessage: "Record the task context from the note.",
          attribution: new HumanUiMutationAttribution({
            version: "athenaeum.mutation-attribution.v1",
            kind: "humanUi",
            surface: "rich-text-editor"
          })
        }))
      )
    )

    expect(output.facts).toEqual([])

    // A subsequent, ordinary `assignTag` re-assigning the same pair is a harmless no-op (idempotent
    // composite key, node-tags-live.ts's own doc comment) — proof `applySupertag`'s own `assignTag`
    // call used the same real mutation path, not a shortcut.
    Schema.decodeUnknownSync(AssignTagOutput)(
      await workspaceStub.assignTag(
        Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, node.id, BaseTagIds.Task, "graph-apply-empty-reassign"))
      )
    )
  })
})

// `assignTag`'s missing symmetric counterpart (supertag-centering pass §2 — the real gap the
// inline `#`-chip removal path needs: "removing a `#tag` chip from the note's text must actually
// untag the note, and no removal path exists today"). Proven the same way `applySupertag`'s own
// tag assignment is proven above: independently, via a `hasTag` `runView` filter, not by trusting
// an echoed-back RPC output alone.
describe("unassignTag: assignTag's delete counterpart", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  const hasTagRows = async (
    stub: Awaited<ReturnType<typeof connectToWorkspace>>,
    workspaceId: EntityId,
    tagId: EntityId
  ) => {
    const spec = new ViewSpec({
      filter: { op: "hasTag", tagId },
      view: "table",
      visibleColumns: ["id"],
      rowLimit: 50
    })
    return Schema.decodeUnknownSync(RunViewOutput)(
      await stub.runView(
        Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName: "graph_nodes", viewSpec: spec }))
      )
    ).rows
  }

  it("removes the node's tag membership — provable via a hasTag runView filter, not just the echoed output", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await authenticatedWorkspace(workspaceId, "unassign")

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Untagged-to-be" })))
    ).node

    await workspaceStub.assignTag(
      Schema.encodeSync(AssignTagInput)(assignInput(workspaceId, node.id, BaseTagIds.Person, "graph-unassign-assign"))
    )
    expect((await hasTagRows(workspaceStub, workspaceId, BaseTagIds.Person)).some((row) => (row as { id: string }).id === node.id)).toBe(
      true
    )

    const output = Schema.decodeUnknownSync(UnassignTagOutput)(
      await workspaceStub.unassignTag(
        Schema.encodeSync(UnassignTagInput)(unassignInput(workspaceId, node.id, BaseTagIds.Person, "graph-unassign-remove"))
      )
    )
    expect(output.nodeId).toBe(node.id)
    expect(output.tagId).toBe(BaseTagIds.Person)
    expect(output.changed).toBe(true)

    expect((await hasTagRows(workspaceStub, workspaceId, BaseTagIds.Person)).some((row) => (row as { id: string }).id === node.id)).toBe(
      false
    )
  })

  it("is idempotent — unassigning a tag the node never carried is a no-op, not an error", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await authenticatedWorkspace(workspaceId, "unassign-noop")

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Never tagged" })))
    ).node

    const output = Schema.decodeUnknownSync(UnassignTagOutput)(
      await workspaceStub.unassignTag(
        Schema.encodeSync(UnassignTagInput)(unassignInput(workspaceId, node.id, BaseTagIds.Person, "graph-unassign-noop"))
      )
    )
    expect(output.nodeId).toBe(node.id)
    expect(output.tagId).toBe(BaseTagIds.Person)
    expect(output.changed).toBe(false)
  })
})
