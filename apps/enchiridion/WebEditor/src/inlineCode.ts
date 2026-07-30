import { InputRule } from "prosemirror-inputrules"
import type { MarkType, Schema } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"

const inlineCodePattern = /(^|[^`])(`)([^`\n]+)`$/u
const literalQuotePattern = /(["'])$/u

export function inlineCodeInputRules(schema: Schema): InputRule[] {
  return [
    preserveLiteralQuoteInsideUnmatchedBackticks(),
    inlineCodeRule(schema.marks.code!),
  ]
}

function preserveLiteralQuoteInsideUnmatchedBackticks(): InputRule {
  return new InputRule(literalQuotePattern, (state, match, _start, end) => {
    if (
      !state.selection.empty
      || state.selection.from !== end
      || !match[1]
      || !isInsideUnmatchedBackticks(state.selection.$from.parent.textBetween(
        0,
        state.selection.$from.parentOffset,
      ))
    ) return null

    return state.tr.insertText(match[1], end, end)
  }, { undoable: false, inCode: false, inCodeMark: false })
}

function inlineCodeRule(mark: MarkType): InputRule {
  return new InputRule(inlineCodePattern, (state, match, start, end) => {
    const boundary = match[1] ?? ""
    const openingDelimiter = match[2]
    const content = match[3]
    if (
      !state.selection.empty
      || state.selection.from !== end
      || openingDelimiter !== "`"
      || !content
      || !/\S/u.test(content)
      || hasOddTrailingBackslashes(content)
    ) return null

    const openingFrom = start + boundary.length
    const contentFrom = openingFrom + 1
    const contentTo = contentFrom + content.length
    if (contentTo > end || end - contentTo > 1) return null
    if (state.doc.textBetween(openingFrom, contentFrom) !== "`") return null
    if (state.doc.textBetween(contentFrom, contentTo) !== content) return null

    const $end = state.doc.resolve(end)
    const parentStart = end - $end.parentOffset
    const textBeforeOpening = $end.parent.textBetween(0, openingFrom - parentStart)
    if (hasOddTrailingBackslashes(textBeforeOpening)) return null
    if (unescapedBacktickCount(textBeforeOpening) % 2 !== 0) return null

    const existingClosingDelimiter = state.doc.textBetween(contentTo, end)
    if (existingClosingDelimiter !== "`".slice(0, existingClosingDelimiter.length)) return null

    const markedFrom = openingFrom
    const markedTo = markedFrom + content.length
    const transaction = state.tr
      .delete(contentTo, end)
      .delete(openingFrom, contentFrom)
      .addMark(markedFrom, markedTo, mark.create())
    transaction.setSelection(TextSelection.create(transaction.doc, markedTo))
    return transaction.removeStoredMark(mark)
  }, { inCode: false, inCodeMark: false })
}

function isInsideUnmatchedBackticks(text: string): boolean {
  return unescapedBacktickCount(text) % 2 !== 0
}

function unescapedBacktickCount(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "`" && !isEscapedAt(text, index)) count += 1
  }
  return count
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 !== 0
}

function hasOddTrailingBackslashes(text: string): boolean {
  let count = 0
  for (let index = text.length - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    count += 1
  }
  return count % 2 !== 0
}
