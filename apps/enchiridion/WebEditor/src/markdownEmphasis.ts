import { InputRule, undoInputRule } from "prosemirror-inputrules"
import { keymap } from "prosemirror-keymap"
import type { MarkType, Schema } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"

type EmphasisRule = {
  delimiter: "**" | "__" | "*" | "_" | "~~"
  mark: MarkType
  pattern: RegExp
}

const meaningfulContent = /[\p{L}\p{N}]/u

export const reversibleMarkdownKeymap = keymap({
  "Backspace": undoInputRule,
})

export function markdownEmphasisInputRules(schema: Schema): InputRule[] {
  return [
    emphasisRule({
      delimiter: "**",
      mark: schema.marks.strong!,
      pattern: /(^|[\s([{"'“‘])(\*\*)([^*\s](?:[^*\n]*?[^*\s])?)\*\*$/u,
    }),
    emphasisRule({
      delimiter: "__",
      mark: schema.marks.strong!,
      pattern: /(^|[\s([{"'“‘])(__)([^_\s](?:[^_\n]*?[^_\s])?)__$/u,
    }),
    emphasisRule({
      delimiter: "*",
      mark: schema.marks.em!,
      pattern: /(^|[\s([{"'“‘])(\*)([^*\s](?:[^*\n]*?[^*\s])?)\*$/u,
    }),
    emphasisRule({
      delimiter: "_",
      mark: schema.marks.em!,
      pattern: /(^|[\s([{"'“‘])(_)([^_\s](?:[^_\n]*?[^_\s])?)_$/u,
    }),
    emphasisRule({
      delimiter: "~~",
      mark: schema.marks.strike!,
      pattern: /(^|[\s([{"'“‘])(~~)([^~\s](?:[^~\n]*?[^~\s])?)~~$/u,
    }),
  ]
}

function emphasisRule({ delimiter, mark, pattern }: EmphasisRule): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const boundary = match[1] ?? ""
    const openingDelimiter = match[2]
    const content = match[3]
    if (
      !state.selection.empty
      || state.selection.from !== end
      || openingDelimiter !== delimiter
      || !content
      || !meaningfulContent.test(content)
    ) return null

    const openingFrom = start + boundary.length
    const contentFrom = openingFrom + delimiter.length
    const contentTo = contentFrom + content.length
    if (contentTo > end || end - contentTo > delimiter.length) return null
    if (state.doc.textBetween(openingFrom, contentFrom) !== delimiter) return null
    if (state.doc.textBetween(contentFrom, contentTo) !== content) return null

    const existingClosingDelimiter = state.doc.textBetween(contentTo, end)
    if (existingClosingDelimiter !== delimiter.slice(0, existingClosingDelimiter.length)) return null

    const markedFrom = openingFrom
    const markedTo = markedFrom + content.length
    const transaction = state.tr
      .delete(contentTo, end)
      .delete(openingFrom, contentFrom)
      .addMark(markedFrom, markedTo, mark.create())
    transaction.setSelection(TextSelection.create(transaction.doc, markedTo))
    return transaction.removeStoredMark(mark)
  }, { inCodeMark: false })
}
