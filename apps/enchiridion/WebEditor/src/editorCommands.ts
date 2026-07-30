import { next as A } from "@automerge/automerge"
import { pmNodeToSpans, type DocHandle, type MappedNodeSpec, type SchemaAdapter } from "@automerge/prosemirror"
import { chainCommands, exitCode, newlineInCode } from "prosemirror-commands"
import { Fragment, type Attrs, type Mark, type MarkType, type Node as PMNode, type NodeType, type ResolvedPos } from "prosemirror-model"
import { splitListItemKeepMarks } from "prosemirror-schema-list"
import { NodeSelection, TextSelection, type Command, type EditorState, type Selection, type Transaction } from "prosemirror-state"

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

export const SOFT_LINE_BREAK_BLOCK = "soft-line-break"

export const hardBreakNodeSpec: MappedNodeSpec = {
  automerge: { block: SOFT_LINE_BREAK_BLOCK, isEmbed: true },
  inline: true,
  group: "inline",
  selectable: false,
  parseDOM: [{ tag: "br" }],
  toDOM: () => ["br"],
}

/**
 * Inserts an inline line break, except in code blocks where Shift-Enter must
 * remain literal text. Non-inclusive identity marks intentionally stop at the
 * break while compatible formatting marks stay active for subsequent input.
 */
export function insertSoftLineBreak(hardBreakType: NodeType): Command {
  return chainCommands(newlineInCode, (state, dispatch) => {
    const { selection } = state
    if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) return false
    const parent = selection.$from.parent
    if (!parent.isTextblock || !parent.canReplaceWith(
      selection.$from.index(),
      selection.$to.index(),
      hardBreakType,
    )) return false

    if (dispatch) {
      const activeMarks = state.storedMarks
        ?? (selection.empty ? selection.$from.marks() : selection.$from.marksAcross(selection.$to))
        ?? []
      const continuingMarks = parent.type.allowedMarks(
        activeMarks.filter(mark => mark.type.spec.inclusive !== false),
      )
      const transaction = state.tr
        .replaceSelectionWith(hardBreakType.create(), false)
        .setStoredMarks(continuingMarks)
        .scrollIntoView()
      dispatch(transaction)
    }
    return true
  })
}

export type BlockMoveDirection = -1 | 1

type SiblingRange = {
  parent: PMNode
  parentStart: number
  firstIndex: number
  lastIndex: number
}

type ListItemContext = {
  parent: PMNode
  parentStart: number
  index: number
}

const movableTopLevelNodeNames = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "code_block",
  "horizontal_rule",
  "bookmark",
  "youtube",
])

/**
 * Moves the selected sibling block range without changing its contents or depth.
 * Returning false at a boundary is intentional so the browser can handle the key.
 */
export function moveBlock(direction: BlockMoveDirection): Command {
  return (state, dispatch) => {
    const range = movableSiblingRange(state)
    if (!range) return false
    if (direction === -1 && range.firstIndex === 0) return false
    if (direction === 1 && range.lastIndex === range.parent.childCount - 1) return false

    const adjacentIndex = direction === -1 ? range.firstIndex - 1 : range.lastIndex + 1
    const adjacent = range.parent.child(adjacentIndex)
    const selected = childrenBetween(range.parent, range.firstIndex, range.lastIndex)
    const firstOffset = childOffset(range.parent, range.firstIndex)
    const lastOffset = childOffset(range.parent, range.lastIndex + 1)
    const replaceFrom = range.parentStart + (direction === -1
      ? childOffset(range.parent, adjacentIndex)
      : firstOffset)
    const replaceTo = range.parentStart + (direction === -1
      ? lastOffset
      : childOffset(range.parent, adjacentIndex + 1))
    const replacement = direction === -1
      ? [...selected, adjacent]
      : [adjacent, ...selected]
    const selectionDelta = direction * adjacent.nodeSize

    if (!dispatch) return true
    const transaction = state.tr.replaceWith(replaceFrom, replaceTo, Fragment.fromArray(replacement))
    const selection = movedSelection(state.selection, transaction.doc, selectionDelta)
    if (!selection) return false
    transaction.setSelection(selection)
    if (state.storedMarks) transaction.setStoredMarks(state.storedMarks)
    dispatch(transaction.scrollIntoView())
    return true
  }
}

function movableSiblingRange(state: EditorState): SiblingRange | undefined {
  const { selection } = state
  const startListItem = listItemContext(state, selection.from, 1)
  const endListItem = listItemContext(state, selection.to, selection.empty ? 1 : -1)

  if (startListItem || endListItem) {
    if (!startListItem || !endListItem) return undefined
    if (startListItem.parent !== endListItem.parent || startListItem.parentStart !== endListItem.parentStart) {
      return undefined
    }
    return {
      parent: startListItem.parent,
      parentStart: startListItem.parentStart,
      firstIndex: Math.min(startListItem.index, endListItem.index),
      lastIndex: Math.max(startListItem.index, endListItem.index),
    }
  }

  const indices = childRangeAt(state.doc, 0, selection.from, selection.to)
  if (!indices) return undefined
  for (let index = indices.firstIndex; index <= indices.lastIndex; index += 1) {
    if (!movableTopLevelNodeNames.has(state.doc.child(index).type.name)) return undefined
  }
  return { parent: state.doc, parentStart: 0, ...indices }
}

function listItemContext(state: EditorState, position: number, bias: -1 | 1): ListItemContext | undefined {
  const $position = state.doc.resolve(position)
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    if ($position.node(depth).type.name !== "list_item") continue
    const parentDepth = depth - 1
    return {
      parent: $position.node(parentDepth),
      parentStart: $position.start(parentDepth),
      index: $position.index(parentDepth),
    }
  }

  const parent = $position.parent
  if (parent.type.name !== "bullet_list" && parent.type.name !== "ordered_list") return undefined
  const index = bias === -1 ? $position.index($position.depth) - 1 : $position.index($position.depth)
  if (index < 0 || index >= parent.childCount || parent.child(index).type.name !== "list_item") return undefined
  return { parent, parentStart: $position.start($position.depth), index }
}

function childRangeAt(
  parent: PMNode,
  parentStart: number,
  from: number,
  to: number,
): Pick<SiblingRange, "firstIndex" | "lastIndex"> | undefined {
  if (parent.childCount === 0) return undefined
  if (from === to) {
    if (from < parentStart || from > parentStart + parent.content.size) return undefined
    if (from === parentStart + parent.content.size) {
      return { firstIndex: parent.childCount - 1, lastIndex: parent.childCount - 1 }
    }
    let offset = parentStart
    for (let index = 0; index < parent.childCount; index += 1) {
      const end = offset + parent.child(index).nodeSize
      if (from >= offset && from < end) return { firstIndex: index, lastIndex: index }
      offset = end
    }
    return undefined
  }

  let firstIndex = -1
  let lastIndex = -1
  let offset = parentStart
  for (let index = 0; index < parent.childCount; index += 1) {
    const end = offset + parent.child(index).nodeSize
    if (from < end && to > offset) {
      if (firstIndex === -1) firstIndex = index
      lastIndex = index
    }
    offset = end
  }
  return firstIndex === -1 ? undefined : { firstIndex, lastIndex }
}

function childrenBetween(parent: PMNode, firstIndex: number, lastIndex: number): PMNode[] {
  const children: PMNode[] = []
  for (let index = firstIndex; index <= lastIndex; index += 1) children.push(parent.child(index))
  return children
}

function childOffset(parent: PMNode, index: number): number {
  let offset = 0
  for (let childIndex = 0; childIndex < index; childIndex += 1) offset += parent.child(childIndex).nodeSize
  return offset
}

function movedSelection(selection: Selection, doc: PMNode, delta: number): Selection | undefined {
  if (selection instanceof NodeSelection) return NodeSelection.create(doc, selection.from + delta)
  if (selection instanceof TextSelection) {
    return TextSelection.create(doc, selection.anchor + delta, selection.head + delta)
  }
  return undefined
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
