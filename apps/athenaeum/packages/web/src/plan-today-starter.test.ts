import { describe, expect, it } from "vitest"
import {
  createPlanTodayStarterNodes,
  firstPlanTodayPriorityPosition,
  isCanonicalEmptyPlanTodayDocument,
  PLAN_TODAY_STARTER
} from "./plan-today-starter.js"
import { richTextSchemaAdapter } from "./rich-text/schema.js"

const schema = richTextSchemaAdapter.schema

describe("Plan today starter", () => {
  it("builds the shared focus/checklist/notes manifest", () => {
    const nodes = createPlanTodayStarterNodes(schema)
    const document = schema.topNodeType.create(null, nodes)

    expect(document.toJSON()).toMatchObject({
        type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: PLAN_TODAY_STARTER.focusHeading }] },
        {
          type: "task_list",
          content: PLAN_TODAY_STARTER.priorities.map((priority) => ({
            type: "task_item",
            attrs: { checked: false },
            content: [{ type: "paragraph", content: [{ type: "text", text: priority }] }]
          }))
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: PLAN_TODAY_STARTER.notesHeading }] },
        { type: "paragraph" }
      ]
    })
    expect(firstPlanTodayPriorityPosition(document)).toBe(nodes[0]!.nodeSize + 1)
  })

  it("only offers itself for the canonical empty paragraph", () => {
    expect(isCanonicalEmptyPlanTodayDocument(schema.topNodeType.create(null, [schema.nodes.paragraph.create()]))).toBe(true)
    expect(isCanonicalEmptyPlanTodayDocument(schema.topNodeType.create(null, [schema.nodes.heading.create({ level: 2 })]))).toBe(false)
    expect(isCanonicalEmptyPlanTodayDocument(schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, schema.text(" "))]))).toBe(false)
  })
})
