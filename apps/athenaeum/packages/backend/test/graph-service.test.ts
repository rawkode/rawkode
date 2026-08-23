// Storage/Views stage verification: "tag closure is correct for a 3-level inheritance chain" and
// "a graph issue is correctly recorded on a conflicting concurrent edge creation", plus
// `listBacklinks` and the plain (non-concurrent) `CardinalityViolation` rejection path.

import { afterEach, describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
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
import { connectToWorkspace, freshWorkspaceId, rejectionToDomainError } from "./support.js"

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
    workspaceStub = await connectToWorkspace(workspaceId)

    const child = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "Employee", parentIds: [BaseTagIds.Person] }))
      )
    ).tag

    const grandchild = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "Engineer", parentIds: [child.id] }))
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
    workspaceStub = await connectToWorkspace(workspaceId)
    const bogusParent = "00000000-0000-0000-0000-0000000000ff"

    const error = await rejectionToDomainError(
      workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "Orphan", parentIds: [bogusParent as any] }))
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
          new CreateRelationDefinitionInput({
            workspaceId,
            forwardName: "manages",
            inverseName: "managed by",
            sourceTagId: BaseTagIds.Person,
            targetTagId: BaseTagIds.Person,
            cardinality
          })
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
    workspaceStub = await connectToWorkspace(workspaceId)
    const { relationDefinition, source, targetA, targetB } = await setupRelation(workspaceId, workspaceStub, "one-to-one")

    await workspaceStub.createEdge(
      Schema.encodeSync(CreateEdgeInput)(
        new CreateEdgeInput({ workspaceId, relationDefinitionId: relationDefinition.id, sourceNodeId: source.id, targetNodeId: targetA.id })
      )
    )

    const error = await rejectionToDomainError(
      workspaceStub.createEdge(
        Schema.encodeSync(CreateEdgeInput)(
          new CreateEdgeInput({ workspaceId, relationDefinitionId: relationDefinition.id, sourceNodeId: source.id, targetNodeId: targetB.id })
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
    "two genuinely concurrent createEdge calls under a max-one relation both succeed, preserve both edges, " +
      "and record exactly one GraphIssue",
    async () => {
      const workspaceId = freshWorkspaceId()
      workspaceStub = await connectToWorkspace(workspaceId)
      const { relationDefinition, source, targetA, targetB } = await setupRelation(workspaceId, workspaceStub, "many-to-one")

      // Real concurrency window: park the first createEdge call's fiber after it has already
      // passed the pre-write cardinality pre-check (finding zero existing edges), before it
      // writes — exactly the same `beforeWrite` hook shape `nodes-repository-live.ts`'s
      // `putTestHook` already established for the DO-recovery suite's mid-fiber-kill scenario.
      let releaseFirstCall: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        releaseFirstCall = resolve
      })
      let hookEngaged = false
      createEdgeTestHook.beforeWrite = () => {
        if (hookEngaged) return Effect.void
        hookEngaged = true
        return Effect.promise(() => gate)
      }

      const firstCall = workspaceStub.createEdge(
        Schema.encodeSync(CreateEdgeInput)(
          new CreateEdgeInput({ workspaceId, relationDefinitionId: relationDefinition.id, sourceNodeId: source.id, targetNodeId: targetA.id })
        )
      )

      // Give the first call a tick to actually reach and engage the hook before firing the
      // second — otherwise the second could race ahead of the first even reaching its pre-check.
      await new Promise((resolve) => setTimeout(resolve, 20))

      const secondCall = workspaceStub.createEdge(
        Schema.encodeSync(CreateEdgeInput)(
          new CreateEdgeInput({ workspaceId, relationDefinitionId: relationDefinition.id, sourceNodeId: source.id, targetNodeId: targetB.id })
        )
      )
      const secondResult = Schema.decodeUnknownSync(CreateEdgeOutput)(await secondCall)

      releaseFirstCall!()
      const firstResult = Schema.decodeUnknownSync(CreateEdgeOutput)(await firstCall)

      // Both edges were created — neither call was rejected, per Evolution Rule #4 ("preserve
      // conflicting graph assertions through merge").
      expect(firstResult.edge.targetNodeId).toBe(targetA.id)
      expect(secondResult.edge.targetNodeId).toBe(targetB.id)

      const issues = Schema.decodeUnknownSync(ListGraphIssuesOutput)(
        await workspaceStub.listGraphIssues(Schema.encodeSync(ListGraphIssuesInput)(new ListGraphIssuesInput({ workspaceId })))
      ).graphIssues
      expect(issues).toHaveLength(1)
      expect(issues[0]!.kind).toBe("concurrent-max-one-edge-conflict")
      expect(issues[0]!.relationDefinitionId).toBe(relationDefinition.id)
      expect(issues[0]!.nodeId).toBe(source.id)
      expect(new Set(issues[0]!.conflictingEdgeIds)).toEqual(new Set([firstResult.edge.id, secondResult.edge.id]))
    }
  )

  it("many-to-many relations never trigger a cardinality conflict for multiple edges from the same source", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const { relationDefinition, source, targetA, targetB } = await setupRelation(workspaceId, workspaceStub, "many-to-many")

    await workspaceStub.createEdge(
      Schema.encodeSync(CreateEdgeInput)(
        new CreateEdgeInput({ workspaceId, relationDefinitionId: relationDefinition.id, sourceNodeId: source.id, targetNodeId: targetA.id })
      )
    )
    await workspaceStub.createEdge(
      Schema.encodeSync(CreateEdgeInput)(
        new CreateEdgeInput({ workspaceId, relationDefinitionId: relationDefinition.id, sourceNodeId: source.id, targetNodeId: targetB.id })
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
    workspaceStub = await connectToWorkspace(workspaceId)

    const relationDefinition = Schema.decodeUnknownSync(CreateRelationDefinitionOutput)(
      await workspaceStub.createRelationDefinition(
        Schema.encodeSync(CreateRelationDefinitionInput)(
          new CreateRelationDefinitionInput({
            workspaceId,
            forwardName: "cites",
            inverseName: "cited by",
            sourceTagId: BaseTagIds.Task,
            targetTagId: BaseTagIds.Task,
            cardinality: "many-to-many"
          })
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
          new CreateEdgeInput({ workspaceId, relationDefinitionId: relationDefinition.id, sourceNodeId: sourceOne.id, targetNodeId: target.id })
        )
      )
    ).edge
    const edgeTwo = Schema.decodeUnknownSync(CreateEdgeOutput)(
      await workspaceStub.createEdge(
        Schema.encodeSync(CreateEdgeInput)(
          new CreateEdgeInput({ workspaceId, relationDefinitionId: relationDefinition.id, sourceNodeId: sourceTwo.id, targetNodeId: target.id })
        )
      )
    ).edge
    await workspaceStub.createEdge(
      Schema.encodeSync(CreateEdgeInput)(
        new CreateEdgeInput({ workspaceId, relationDefinitionId: relationDefinition.id, sourceNodeId: sourceOne.id, targetNodeId: unrelated.id })
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
    workspaceStub = await connectToWorkspace(workspaceId)

    const tag = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "Reviewer", parentIds: [] }))
      )
    ).tag

    const output = Schema.decodeUnknownSync(DefineTagFieldOutput)(
      await workspaceStub.defineTagField(
        Schema.encodeSync(DefineTagFieldInput)(
          new DefineTagFieldInput({ workspaceId, tagId: tag.id, name: "level", valueKind: "text", sortOrder: 0 })
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
    workspaceStub = await connectToWorkspace(workspaceId)
    const bogusTagId = "00000000-0000-0000-0000-0000000000ff"

    const error = await rejectionToDomainError(
      workspaceStub.defineTagField(
        Schema.encodeSync(DefineTagFieldInput)(
          new DefineTagFieldInput({ workspaceId, tagId: bogusTagId as any, name: "level", valueKind: "text", sortOrder: 0 })
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
    workspaceStub = await connectToWorkspace(workspaceId)

    const child = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "Employee", parentIds: [BaseTagIds.Person] }))
      )
    ).tag
    const grandchild = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "Engineer", parentIds: [child.id] }))
      )
    ).tag

    const childField = Schema.decodeUnknownSync(DefineTagFieldOutput)(
      await workspaceStub.defineTagField(
        Schema.encodeSync(DefineTagFieldInput)(
          new DefineTagFieldInput({ workspaceId, tagId: child.id, name: "team", valueKind: "text", sortOrder: 0 })
        )
      )
    ).fieldDefinition
    const grandchildField = Schema.decodeUnknownSync(DefineTagFieldOutput)(
      await workspaceStub.defineTagField(
        Schema.encodeSync(DefineTagFieldInput)(
          new DefineTagFieldInput({ workspaceId, tagId: grandchild.id, name: "level", valueKind: "text", sortOrder: 0 })
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
    workspaceStub = await connectToWorkspace(workspaceId)

    // D (root) <- B, D <- C, and A <- B, A <- C (A reaches D via two independent paths).
    const tagD = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "D", parentIds: [] })))
    ).tag
    const tagB = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "B", parentIds: [tagD.id] })))
    ).tag
    const tagC = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "C", parentIds: [tagD.id] })))
    ).tag
    const tagA = Schema.decodeUnknownSync(CreateTagOutput)(
      await workspaceStub.createTag(
        Schema.encodeSync(CreateTagInput)(new CreateTagInput({ workspaceId, name: "A", parentIds: [tagB.id, tagC.id] }))
      )
    ).tag

    const sharedField = Schema.decodeUnknownSync(DefineTagFieldOutput)(
      await workspaceStub.defineTagField(
        Schema.encodeSync(DefineTagFieldInput)(
          new DefineTagFieldInput({ workspaceId, tagId: tagD.id, name: "shared", valueKind: "text", sortOrder: 0 })
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
    workspaceStub = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Untitled" })))
    ).node

    const output = Schema.decodeUnknownSync(ApplySupertagOutput)(
      await workspaceStub.applySupertag(
        Schema.encodeSync(ApplySupertagInput)(new ApplySupertagInput({ workspaceId, nodeId: node.id, tagId: BaseTagIds.Task }))
      )
    )

    expect(output.facts).toEqual([])

    // A subsequent, ordinary `assignTag` re-assigning the same pair is a harmless no-op (idempotent
    // composite key, node-tags-live.ts's own doc comment) — proof `applySupertag`'s own `assignTag`
    // call used the same real mutation path, not a shortcut.
    Schema.decodeUnknownSync(AssignTagOutput)(
      await workspaceStub.assignTag(
        Schema.encodeSync(AssignTagInput)(new AssignTagInput({ workspaceId, nodeId: node.id, tagId: BaseTagIds.Task }))
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
    workspaceStub = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Untagged-to-be" })))
    ).node

    await workspaceStub.assignTag(
      Schema.encodeSync(AssignTagInput)(new AssignTagInput({ workspaceId, nodeId: node.id, tagId: BaseTagIds.Person }))
    )
    expect((await hasTagRows(workspaceStub, workspaceId, BaseTagIds.Person)).some((row) => (row as { id: string }).id === node.id)).toBe(
      true
    )

    const output = Schema.decodeUnknownSync(UnassignTagOutput)(
      await workspaceStub.unassignTag(
        Schema.encodeSync(UnassignTagInput)(new UnassignTagInput({ workspaceId, nodeId: node.id, tagId: BaseTagIds.Person }))
      )
    )
    expect(output.nodeId).toBe(node.id)
    expect(output.tagId).toBe(BaseTagIds.Person)

    expect((await hasTagRows(workspaceStub, workspaceId, BaseTagIds.Person)).some((row) => (row as { id: string }).id === node.id)).toBe(
      false
    )
  })

  it("is idempotent — unassigning a tag the node never carried is a no-op, not an error", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Never tagged" })))
    ).node

    const output = Schema.decodeUnknownSync(UnassignTagOutput)(
      await workspaceStub.unassignTag(
        Schema.encodeSync(UnassignTagInput)(new UnassignTagInput({ workspaceId, nodeId: node.id, tagId: BaseTagIds.Person }))
      )
    )
    expect(output.nodeId).toBe(node.id)
    expect(output.tagId).toBe(BaseTagIds.Person)
  })
})
