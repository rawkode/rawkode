import { InputRule, inputRules, wrappingInputRule, textblockTypeInputRule } from "prosemirror-inputrules"
import type { MarkType, NodeType, Schema } from "prosemirror-model"

// Markdown shortcuts (task requirement: "markdown shortcuts"). Block-level rules reuse
// `prosemirror-inputrules`' own `wrappingInputRule`/`textblockTypeInputRule` helpers (the same
// primitives `prosemirror-example-setup` builds its own markdown shortcuts from) against this
// app's schema node names; inline-mark rules are a small hand-written `markInputRule` helper (not
// vendored from anywhere — this is a short, well-known ProseMirror recipe, not upstream-owned
// integration surface the way `@automerge/prosemirror` is, so it doesn't carry that module's
// vendoring discipline).
//
// Delimiter choice deliberately avoids the classic `*`/`**` collision (a naive single-`*`-italic
// rule matches inside `**bold**` the moment the closing `**` is typed, since "*bold*" is a valid
// substring of "**bold**"): bold uses `**`, italic uses `_`, strikethrough uses `~~`, code uses
// `` ` `` — four delimiter families that never overlap with each other.

const markInputRule = (regexp: RegExp, markType: MarkType): InputRule =>
  new InputRule(regexp, (state, match, start, end) => {
    const captured = match[1]
    if (!captured) return null
    const { tr } = state
    const textStart = start + match[0].indexOf(captured)
    const textEnd = textStart + captured.length
    if (textEnd < end) tr.delete(textEnd, end)
    if (textStart > start) tr.delete(start, textStart)
    const markEnd = start + captured.length
    tr.addMark(start, markEnd, markType.create())
    tr.removeStoredMark(markType)
    return tr
  })

const headingRule = (nodeType: NodeType, maxLevel: number): InputRule =>
  textblockTypeInputRule(new RegExp(`^(#{1,${maxLevel}})\\s$`), nodeType, (match) => ({
    level: match[1].length
  }))

const hrRule = (nodeType: NodeType): InputRule =>
  new InputRule(/^(?:---|___|\*\*\*)$/, (state, _match, start, end) => {
    return state.tr.replaceRangeWith(start, end, nodeType.create())
  })

export const buildInputRules = (schema: Schema) =>
  inputRules({
    rules: [
      headingRule(schema.nodes.heading, 3),
      wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
      textblockTypeInputRule(/^```$/, schema.nodes.code_block),
      wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        schema.nodes.ordered_list,
        (match) => ({ order: Number(match[1]) }),
        (match, node) => node.childCount + node.attrs.order === Number(match[1])
      ),
      // `task_list` itself carries no attrs — `checked` lives on the auto-wrapped `task_item`
      // `findWrapping` inserts, always defaulting to unchecked; toggled afterward via the checkbox
      // `TaskItemView` node view renders (see `task-item-node-view.ts`).
      wrappingInputRule(/^\s*\[\s?\]\s$/, schema.nodes.task_list),
      hrRule(schema.nodes.horizontal_rule),
      markInputRule(/\*\*([^*]+)\*\*$/, schema.marks.strong),
      markInputRule(/_([^_]+)_$/, schema.marks.em),
      markInputRule(/~~([^~]+)~~$/, schema.marks.strike),
      markInputRule(/`([^`]+)`$/, schema.marks.code)
    ]
  })
