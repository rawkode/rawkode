import type { Node as PMNode, NodeType, Schema } from "prosemirror-model"

/**
 * The smallest useful morning plan that is losslessly editable on every Athenaeum client.
 * Keep this manifest deliberately boring: it uses only the paragraph/heading subset admitted by
 * the native Loro editor, so choosing the starter cannot strand a note in a web-only shape.
 */
export const PLAN_TODAY_STARTER = {
  focusHeading: "Focus",
  priorities: ["Priority 1", "Priority 2", "Priority 3"],
  notesHeading: "Notes"
} as const

/** A new Loro page is canonical-empty only when it is exactly one empty paragraph. */
export const isCanonicalEmptyPlanTodayDocument = (document: PMNode): boolean =>
  document.childCount === 1 &&
  document.firstChild?.type.name === "paragraph" &&
  document.firstChild.childCount === 0

export const createPlanTodayStarterNodes = (schema: Schema): PMNode[] => {
  const heading = schema.nodes.heading
  const paragraph = schema.nodes.paragraph
  if (heading === undefined || paragraph === undefined) {
    throw new Error("Plan today starter requires paragraph and heading nodes")
  }
  const text = (value: string): PMNode => paragraph.create(null, schema.text(value))
  return [
    heading.create({ level: 2 }, schema.text(PLAN_TODAY_STARTER.focusHeading)),
    ...PLAN_TODAY_STARTER.priorities.map(text),
    heading.create({ level: 2 }, schema.text(PLAN_TODAY_STARTER.notesHeading)),
    paragraph.create()
  ]
}

/** Position at the start of the first priority paragraph in a freshly-created PM document. */
export const firstPlanTodayPriorityPosition = (document: PMNode): number => {
  if (document.childCount < 2) throw new Error("Plan today starter is missing its first priority")
  const firstBlock = document.child(0)
  return firstBlock.nodeSize + 1
}

/** Keep the unused NodeType import honest for consumers that want a narrow schema seam in tests. */
export type PlanTodayStarterNodeTypes = { readonly heading: NodeType; readonly paragraph: NodeType }
