import { next as A } from "@automerge/automerge"
import { pmNodeToSpans, type DocHandle, type SchemaAdapter } from "@automerge/prosemirror"
import { exitCode } from "prosemirror-commands"
import type { Attrs, MarkType } from "prosemirror-model"
import { TextSelection, type Command, type EditorState } from "prosemirror-state"

export type SearchableCommand = {
  label: string
  detail?: string
  keywords?: readonly string[]
}

export type PaletteGeometry = {
  left: number
  top: number
  width: number
  height: number
}

export type CaretGeometry = Pick<PaletteGeometry, "left" | "top"> & { bottom: number }

export type SupertagIdentity = {
  id: string
  name: string
}

export type SelectedTextTaskPlan<T extends SupertagIdentity> = {
  title: string | undefined
  createLabel: string | undefined
  linkLabel: "Link existing task…"
  taskTag: T | undefined
  genericSupertags: T[]
}

export function selectedTextTaskPlan<T extends SupertagIdentity>(
  selectedText: string,
  supertags: readonly T[],
): SelectedTextTaskPlan<T> {
  const title = selectedText.trim() || undefined
  return {
    title,
    createLabel: title ? `Create task “${title}”` : undefined,
    linkLabel: "Link existing task…",
    taskTag: supertags.find(tag => tag.id === "task"),
    genericSupertags: supertags.filter(tag => tag.id !== "task"),
  }
}

export function filterCommands<T extends SearchableCommand>(commands: readonly T[], query: string): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...commands]
  return commands.filter(command => {
    const searchable = [command.label, command.detail ?? "", ...(command.keywords ?? [])]
      .join(" ")
      .toLocaleLowerCase()
    return terms.every(term => searchable.includes(term))
  })
}

export function movePaletteSelection(activeIndex: number, itemCount: number, direction: -1 | 1): number {
  if (itemCount <= 0) return -1
  if (activeIndex < 0 || activeIndex >= itemCount) return direction === 1 ? 0 : itemCount - 1
  return (activeIndex + direction + itemCount) % itemCount
}

export function slashCommandQuery(triggerAndQuery: string): string | undefined {
  return triggerAndQuery.startsWith("/") ? triggerAndQuery.slice(1) : undefined
}

export function placePalette(
  caret: CaretGeometry,
  palette: Pick<PaletteGeometry, "width" | "height">,
  viewport: PaletteGeometry,
  gap = 6,
  gutter = 8,
): Pick<PaletteGeometry, "left" | "top"> {
  const minimumLeft = viewport.left + gutter
  const maximumLeft = Math.max(minimumLeft, viewport.left + viewport.width - palette.width - gutter)
  const minimumTop = viewport.top + gutter
  const maximumTop = Math.max(minimumTop, viewport.top + viewport.height - palette.height - gutter)
  const below = caret.bottom + gap
  const above = caret.top - palette.height - gap
  return {
    left: Math.min(Math.max(caret.left, minimumLeft), maximumLeft),
    top: Math.min(Math.max(below + palette.height <= viewport.top + viewport.height - gutter ? below : above, minimumTop), maximumTop),
  }
}

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
