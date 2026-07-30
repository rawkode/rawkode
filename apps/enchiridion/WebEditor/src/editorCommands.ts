import { next as A } from "@automerge/automerge"
import { pmNodeToSpans, type DocHandle, type SchemaAdapter } from "@automerge/prosemirror"
import { chainCommands, exitCode } from "prosemirror-commands"
import type { Attrs, Mark, MarkType, NodeType, ResolvedPos } from "prosemirror-model"
import { splitListItemKeepMarks } from "prosemirror-schema-list"
import { TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state"

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

export type LinkEditTarget = {
  kind: "add" | "edit"
  from: number
  to: number
  href?: string
}

export type LinkEditResolution =
  | { ok: true; target: LinkEditTarget }
  | {
    ok: false
    reason: "selection-required" | "non-text-selection" | "identity-mark" | "ambiguous-link-range"
  }

export type HTTPURLValidation =
  | { ok: true; href: string }
  | { ok: false; message: string }

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

export function validateHTTPURL(value: string): HTTPURLValidation {
  const href = value.trim()
  if (!href) return { ok: false, message: "Enter a web address." }
  try {
    const url = new URL(href)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
      return { ok: false, message: "Use a complete http:// or https:// address." }
    }
    return { ok: true, href }
  } catch {
    return { ok: false, message: "Use a complete http:// or https:// address." }
  }
}

export function resolveLinkEditTarget(
  state: EditorState,
  linkType: MarkType,
  identityMarkTypes: readonly MarkType[] = [],
): LinkEditResolution {
  const { selection } = state
  if (!selection.empty) {
    if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) {
      return { ok: false, reason: "non-text-selection" }
    }

    let sawText = false
    let sawLink = false
    let sawIdentity = false
    state.doc.nodesBetween(selection.from, selection.to, (node, position) => {
      if (!node.isText) return
      const overlapFrom = Math.max(selection.from, position)
      const overlapTo = Math.min(selection.to, position + node.nodeSize)
      if (overlapFrom >= overlapTo) return
      sawText = true
      sawLink ||= Boolean(linkType.isInSet(node.marks))
      sawIdentity ||= identityMarkTypes.some(markType => Boolean(markType.isInSet(node.marks)))
    })

    if (!sawText) return { ok: false, reason: "non-text-selection" }
    if (sawIdentity) return { ok: false, reason: "identity-mark" }
    if (sawLink) return { ok: false, reason: "ambiguous-link-range" }
    return {
      ok: true,
      target: { kind: "add", from: selection.from, to: selection.to },
    }
  }

  const link = linkType.isInSet(selection.$from.marks())
  if (!link) return { ok: false, reason: "selection-required" }
  if (identityMarkTypes.some(markType => Boolean(markType.isInSet(selection.$from.marks())))) {
    return { ok: false, reason: "identity-mark" }
  }
  const range = contiguousMarkRange(selection.$from, link)
  if (!range) return { ok: false, reason: "ambiguous-link-range" }

  let sawIdentity = false
  state.doc.nodesBetween(range.from, range.to, node => {
    if (!node.isText) return
    sawIdentity ||= identityMarkTypes.some(markType => Boolean(markType.isInSet(node.marks)))
  })
  if (sawIdentity) return { ok: false, reason: "identity-mark" }
  return {
    ok: true,
    target: {
      kind: "edit",
      from: range.from,
      to: range.to,
      href: typeof link.attrs.href === "string" ? link.attrs.href : "",
    },
  }
}

export function linkEditTransaction(
  state: EditorState,
  target: LinkEditTarget,
  linkType: MarkType,
  href?: string,
): Transaction | undefined {
  if (target.from < 0 || target.from >= target.to || target.to > state.doc.content.size) return undefined
  const transaction = state.tr.removeMark(target.from, target.to, linkType)
  if (href !== undefined) transaction.addMark(target.from, target.to, linkType.create({ href }))
  return transaction.scrollIntoView()
}

export function showsEditorCommandBar(editorHasFocus: boolean): boolean {
  return editorHasFocus
}

function contiguousMarkRange($position: ResolvedPos, mark: Mark): { from: number; to: number } | undefined {
  const parent = $position.parent
  let seed = parent.childAfter($position.parentOffset)
  if (!seed.node || !mark.isInSet(seed.node.marks)) seed = parent.childBefore($position.parentOffset)
  if (!seed.node || !mark.isInSet(seed.node.marks)) return undefined

  let startIndex = seed.index
  let endIndex = seed.index + 1
  let from = $position.start() + seed.offset
  let to = from + seed.node.nodeSize
  while (startIndex > 0 && mark.isInSet(parent.child(startIndex - 1).marks)) {
    const previous = parent.child(--startIndex)
    from -= previous.nodeSize
  }
  while (endIndex < parent.childCount && mark.isInSet(parent.child(endIndex).marks)) {
    to += parent.child(endIndex++).nodeSize
  }
  return { from, to }
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

export function editorReturnCommand(listItemType: NodeType): Command {
  return chainCommands(exitCodeBlockOnEmptyLine, splitListItemKeepMarks(listItemType))
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
