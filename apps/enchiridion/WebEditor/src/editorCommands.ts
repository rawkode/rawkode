import { next as A } from "@automerge/automerge"
import { pmNodeToSpans, type DocHandle, type SchemaAdapter } from "@automerge/prosemirror"
import { exitCode } from "prosemirror-commands"
import type { Attrs, MarkType } from "prosemirror-model"
import { TextSelection, type Command, type EditorState } from "prosemirror-state"

export function showsEditorCommandBar(editorHasFocus: boolean): boolean {
  return editorHasFocus
}

export function markSelectedText(
  markType: MarkType,
  attrs?: Attrs,
  range?: { from: number; to: number },
): Command {
  return (state, dispatch) => {
    const from = range?.from ?? state.selection.from
    const to = range?.to ?? state.selection.to
    if (from === to || from < 0 || to > state.doc.content.size) return false
    dispatch?.(state.tr.addMark(from, to, markType.create(attrs)).scrollIntoView())
    return true
  }
}

export function persistSelectedMark<Document>(
  handle: Pick<DocHandle<Document>, "change">,
  path: A.Prop[],
  adapter: SchemaAdapter,
  state: EditorState,
  markType: MarkType,
  attrs?: Attrs,
  range?: { from: number; to: number },
): boolean {
  const from = range?.from ?? state.selection.from
  const to = range?.to ?? state.selection.to
  if (from === to || from < 0 || to > state.doc.content.size) return false

  const markedDocument = state.tr.addMark(from, to, markType.create(attrs)).doc
  const spans = pmNodeToSpans(adapter, markedDocument)
  handle.change(document => {
    A.updateSpans(document as A.Doc<Document>, path, spans, adapter.updateSpansConfig())
  })
  return true
}

export const exitCodeBlockOnEmptyLine: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.type.spec.code) return false
  if ($from.parentOffset !== $from.parent.content.size) return false

  const lineStart = $from.parent.textContent.lastIndexOf("\n") + 1
  if ($from.parent.textContent.slice(lineStart).length > 0) return false
  return exitCode(state, dispatch)
}

export const moveBelowCodeBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.type.spec.code) return false
  if ($from.parentOffset !== $from.parent.content.size) return false

  const after = $from.after()
  const nextBlock = state.doc.nodeAt(after)
  if (nextBlock?.isTextblock) {
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, after + 1)).scrollIntoView())
    return true
  }
  return exitCode(state, dispatch)
}
