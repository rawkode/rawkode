import { redoDepth, undoDepth } from "prosemirror-history"
import type { MarkType, Node as PMNode, ResolvedPos } from "prosemirror-model"
import type { EditorState } from "prosemirror-state"

export type CommandBarCommand =
  | "undo"
  | "redo"
  | "blocks"
  | "bold"
  | "italic"
  | "inline-code"
  | "bullet-list"
  | "link-reference"
  | "dismiss-keyboard"

export type CommandBarItemState = {
  command: CommandBarCommand
  label: string
  disabled: boolean
  pressed?: boolean
}

export type CommandBarState = {
  visible: boolean
  items: CommandBarItemState[]
}

export type CommandBarContext = {
  editorState: EditorState | undefined
  titleFocused: boolean
  bodyFocused: boolean
  composing: boolean
}

type BlockStyle = "Text" | "Heading 1" | "Heading 2" | "Heading 3" | "Quote" | "Code" | "Mixed"

export function deriveCommandBarState(context: CommandBarContext): CommandBarState {
  const state = context.editorState
  const bodyDisabled = !state || context.titleFocused
  const structuralDisabled = bodyDisabled || context.composing
  const blockStyle = state ? uniformBlockStyle(state) : "Text"
  const mark = (name: string): boolean => {
    const markType = state?.schema.marks[name]
    return Boolean(state && markType && isMarkUniformlyActive(state, markType))
  }
  const linkOrReference = state
    ? [state.schema.marks.link, state.schema.marks.page_reference]
        .filter((markType): markType is MarkType => Boolean(markType))
        .some(markType => isMarkUniformlyActive(state, markType))
    : false

  return {
    visible: context.titleFocused || context.bodyFocused,
    items: [
      { command: "undo", label: "Undo", disabled: structuralDisabled || !state || undoDepth(state) === 0 },
      { command: "redo", label: "Redo", disabled: structuralDisabled || !state || redoDepth(state) === 0 },
      {
        command: "blocks",
        label: `Block style, ${blockStyle}`,
        disabled: structuralDisabled,
        pressed: blockStyle !== "Text" && blockStyle !== "Mixed",
      },
      { command: "bold", label: "Bold", disabled: bodyDisabled, pressed: mark("strong") },
      { command: "italic", label: "Italic", disabled: bodyDisabled, pressed: mark("em") },
      { command: "inline-code", label: "Inline code", disabled: bodyDisabled, pressed: mark("code") },
      {
        command: "bullet-list",
        label: "Bulleted list",
        disabled: structuralDisabled,
        pressed: Boolean(state && isSelectionUniformlyInNode(state, "bullet_list")),
      },
      {
        command: "link-reference",
        label: "Link or reference",
        disabled: structuralDisabled,
        pressed: linkOrReference,
      },
      { command: "dismiss-keyboard", label: "Dismiss keyboard", disabled: false },
    ],
  }
}

export function isMarkUniformlyActive(state: EditorState, markType: MarkType): boolean {
  const { selection } = state
  if (selection.empty) {
    return Boolean(markType.isInSet(state.storedMarks ?? selection.$from.marks()))
  }

  let sawText = false
  let uniformlyActive = true
  state.doc.nodesBetween(selection.from, selection.to, (node, position) => {
    if (!node.isText) return
    const overlapFrom = Math.max(selection.from, position)
    const overlapTo = Math.min(selection.to, position + node.nodeSize)
    if (overlapFrom >= overlapTo) return
    sawText = true
    if (!markType.isInSet(node.marks)) uniformlyActive = false
  })
  return sawText && uniformlyActive
}

export function isSelectionUniformlyInNode(state: EditorState, nodeName: string): boolean {
  const { selection } = state
  if (selection.empty) return hasAncestor(selection.$from, nodeName)

  let sawTextBlock = false
  let uniformlyInside = true
  forSelectedTextBlocks(state, $position => {
    sawTextBlock = true
    if (!hasAncestor($position, nodeName)) uniformlyInside = false
  })
  return sawTextBlock && uniformlyInside
}

function uniformBlockStyle(state: EditorState): BlockStyle {
  if (state.selection.empty) return blockStyleAt(state.selection.$from)
  const styles = new Set<BlockStyle>()
  forSelectedTextBlocks(state, $position => styles.add(blockStyleAt($position)))
  return styles.size === 1 ? [...styles][0]! : "Mixed"
}

function forSelectedTextBlocks(state: EditorState, visit: ($position: ResolvedPos) => void): void {
  const { from, to } = state.selection
  state.doc.nodesBetween(from, to, (node: PMNode, position: number) => {
    if (!node.isTextblock) return
    const contentFrom = position + 1
    const contentTo = contentFrom + node.content.size
    if (from >= contentTo || to <= contentFrom) return
    visit(state.doc.resolve(contentFrom))
  })
}

function blockStyleAt($position: ResolvedPos): BlockStyle {
  for (let depth = $position.depth; depth >= 0; depth -= 1) {
    const node = $position.node(depth)
    if (node.type.name === "code_block") return "Code"
    if (node.type.name === "heading") return `Heading ${node.attrs.level}` as BlockStyle
    if (node.type.name === "blockquote") return "Quote"
  }
  return "Text"
}

function hasAncestor($position: ResolvedPos, nodeName: string): boolean {
  for (let depth = $position.depth; depth >= 0; depth -= 1) {
    if ($position.node(depth).type.name === nodeName) return true
  }
  return false
}
