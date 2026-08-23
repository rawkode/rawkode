import { baseKeymap, chainCommands, setBlockType, toggleMark, wrapIn } from "prosemirror-commands"
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list"
import { keymap } from "prosemirror-keymap"
import { history, redo, undo } from "prosemirror-history"
import type { Command, EditorState } from "prosemirror-state"
import type { MarkType, Schema } from "prosemirror-model"

// Editing commands + keymap. `prosemirror-schema-list`'s `splitListItem`/`liftListItem`/
// `sinkListItem` are schema-agnostic (take a `NodeType`, not a hardcoded schema) — used against
// both `list_item` and `task_item` via `chainCommands` (tries `list_item`'s version first, falls
// through to `task_item`'s if the selection isn't inside a bullet/ordered list).

export const isMarkActive = (state: EditorState, markType: MarkType): boolean => {
  const { from, $from, to, empty } = state.selection
  if (empty) return !!markType.isInSet(state.storedMarks || $from.marks())
  return state.doc.rangeHasMark(from, to, markType)
}

export interface RichTextCommands {
  readonly toggleBold: Command
  readonly toggleItalic: Command
  readonly toggleStrike: Command
  readonly toggleCode: Command
  readonly toggleLink: (href: string) => Command
  readonly removeLink: Command
  readonly setParagraph: Command
  readonly setHeading: (level: 1 | 2 | 3) => Command
  readonly setBlockquote: Command
  readonly setCodeBlock: Command
  readonly toggleBulletList: Command
  readonly toggleOrderedList: Command
  readonly toggleTaskList: Command
  readonly insertHorizontalRule: Command
}

export const buildCommands = (schema: Schema): RichTextCommands => ({
  toggleBold: toggleMark(schema.marks.strong),
  toggleItalic: toggleMark(schema.marks.em),
  toggleStrike: toggleMark(schema.marks.strike),
  toggleCode: toggleMark(schema.marks.code),
  toggleLink: (href) => toggleMark(schema.marks.link, { href, title: null }),
  removeLink: (state, dispatch) => {
    const { from, to } = state.selection
    if (!state.doc.rangeHasMark(from, to, schema.marks.link)) return false
    dispatch?.(state.tr.removeMark(from, to, schema.marks.link))
    return true
  },
  setParagraph: setBlockType(schema.nodes.paragraph),
  setHeading: (level) => setBlockType(schema.nodes.heading, { level }),
  setBlockquote: wrapIn(schema.nodes.blockquote),
  setCodeBlock: setBlockType(schema.nodes.code_block),
  toggleBulletList: wrapInList(schema.nodes.bullet_list),
  toggleOrderedList: wrapInList(schema.nodes.ordered_list),
  toggleTaskList: wrapInList(schema.nodes.task_list),
  insertHorizontalRule: (state, dispatch) => {
    dispatch?.(state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()))
    return true
  }
})

export const buildKeymapPlugins = (schema: Schema) => {
  const listEnter = chainCommands(
    splitListItem(schema.nodes.list_item),
    splitListItem(schema.nodes.task_item)
  )
  const listIndent = chainCommands(sinkListItem(schema.nodes.list_item), sinkListItem(schema.nodes.task_item))
  const listOutdent = chainCommands(
    liftListItem(schema.nodes.list_item),
    liftListItem(schema.nodes.task_item)
  )

  return [
    history(),
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Mod-Shift-z": redo,
      "Mod-b": toggleMark(schema.marks.strong),
      "Mod-i": toggleMark(schema.marks.em),
      "Mod-Shift-x": toggleMark(schema.marks.strike),
      "Mod-e": toggleMark(schema.marks.code),
      Enter: listEnter,
      "Shift-Tab": listOutdent,
      Tab: listIndent
    }),
    keymap(baseKeymap)
  ]
}
