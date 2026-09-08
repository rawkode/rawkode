import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import type { Schema } from "prosemirror-model"
import { buildCommands } from "./commands.js"
import { placeFloatingMenu } from "./menu-position.js"

// Slash-command block insert (task requirement). Typing "/" at the start of a line (or after
// whitespace) opens a floating menu of block types; selecting one deletes the "/query" text and
// runs the matching block command at that position. Implemented as a plain ProseMirror `Plugin`
// with a hand-managed floating DOM menu (not a React portal) — ProseMirror owns `view.dom` and its
// subtree outright, so UI that must coexist with live cursor/selection state inside the editable
// region is built the same way ProseMirror's own ecosystem (`prosemirror-menu`, Tiptap's bubble
// menus) does: DOM nodes created/positioned directly against `getBoundingClientRect()` of the
// current selection, not diffed in by a separate renderer.

interface SlashItem {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly run: Command
}

interface SlashState {
  readonly active: boolean
  readonly from: number
  readonly to: number
  readonly query: string
}

const inactive: SlashState = { active: false, from: 0, to: 0, query: "" }

const computeState = (state: EditorState): SlashState => {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return inactive
  const $from = selection.$from
  if (!$from.parent.isTextblock) return inactive
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, "￼", "￼")
  const match = /(?:^|\s)\/(\w{0,32})$/.exec(textBefore)
  if (!match) return inactive
  const query = match[1] ?? ""
  const from = $from.pos - query.length - 1
  return { active: true, from, to: $from.pos, query }
}

export const slashMenuKey = new PluginKey<SlashState>("rich-text-slash-menu")

const buildItems = (schema: Schema): SlashItem[] => {
  const commands = buildCommands(schema)
  return [
    { id: "paragraph", label: "Text", hint: "Plain paragraph", run: commands.setParagraph },
    { id: "h1", label: "Heading 1", hint: "Big section heading", run: commands.setHeading(1) },
    { id: "h2", label: "Heading 2", hint: "Medium section heading", run: commands.setHeading(2) },
    { id: "h3", label: "Heading 3", hint: "Small section heading", run: commands.setHeading(3) },
    { id: "bullet", label: "Bulleted list", hint: "Simple unordered list", run: commands.toggleBulletList },
    { id: "ordered", label: "Numbered list", hint: "Ordered list", run: commands.toggleOrderedList },
    { id: "task", label: "Checklist", hint: "Track to-dos", run: commands.toggleTaskList },
    { id: "quote", label: "Quote", hint: "Blockquote callout", run: commands.setBlockquote },
    { id: "code", label: "Code block", hint: "Monospaced code", run: commands.setCodeBlock },
    { id: "divider", label: "Divider", hint: "Horizontal rule", run: commands.insertHorizontalRule }
  ]
}

export const slashMenuPlugin = (schema: Schema): Plugin<SlashState> => {
  const allItems = buildItems(schema)

  return new Plugin<SlashState>({
    key: slashMenuKey,
    state: {
      init: () => inactive,
      apply: (tr: Transaction, _old: SlashState, _oldState: EditorState, newState: EditorState) =>
        tr.getMeta(slashMenuKey) === "dismiss" ? inactive : computeState(newState)
    },
    props: {
      handleKeyDown(view, event) {
        const pluginState = slashMenuKey.getState(view.state)
        if (!pluginState?.active) return false
        if (event.key === "Escape") {
          view.dispatch(view.state.tr.setMeta(slashMenuKey, "dismiss"))
          return true
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") {
          // Handled by the floating menu's own DOM-level keydown listener (registered in
          // `view()` below) — returning true here just prevents ProseMirror's default handling
          // (e.g. `Enter` splitting the block) while the menu is open.
          const handled = menuKeyHandlers.get(view)?.(event)
          return handled ?? true
        }
        return false
      }
    },
    view(editorView) {
      const menu = document.createElement("div")
      menu.className = "rich-slash-menu"
      menu.style.display = "none"
      editorView.dom.parentElement?.appendChild(menu)

      let selectedIndex = 0
      let currentItems: SlashItem[] = []
      let currentState: SlashState = inactive

      const runItem = (item: SlashItem) => {
        const { from, to } = currentState
        let tr = editorView.state.tr.delete(from, to)
        editorView.dispatch(tr)
        item.run(editorView.state, editorView.dispatch, editorView)
        editorView.focus()
      }

      const render = () => {
        while (menu.firstChild) menu.removeChild(menu.firstChild)
        currentItems.forEach((item, index) => {
          const row = document.createElement("button")
          row.type = "button"
          row.className = "rich-slash-item" + (index === selectedIndex ? " is-selected" : "")
          const label = document.createElement("span")
          label.className = "rich-slash-item-label"
          label.textContent = item.label
          const hint = document.createElement("span")
          hint.className = "rich-slash-item-hint"
          hint.textContent = item.hint
          row.appendChild(label)
          row.appendChild(hint)
          row.addEventListener("mousedown", (event) => {
            event.preventDefault()
            runItem(item)
          })
          menu.appendChild(row)
        })
      }

      const update = (view: EditorView) => {
        const pluginState = slashMenuKey.getState(view.state)
        if (!pluginState) return
        currentState = pluginState
        if (!pluginState.active) {
          menu.style.display = "none"
          return
        }
        const query = pluginState.query.toLowerCase()
        currentItems = query.length === 0 ? allItems : allItems.filter((item) => item.label.toLowerCase().includes(query))
        if (currentItems.length === 0) {
          menu.style.display = "none"
          return
        }
        selectedIndex = Math.min(selectedIndex, currentItems.length - 1)
        render()
        // Viewport-aware placement (design-review finding #4 — see `menu-position.ts`; this menu
        // shared the identical always-below positioning code the `#`/`@` pickers had). Display is
        // set before placing so the helper can measure the rendered menu's real height.
        menu.style.display = "block"
        placeFloatingMenu(menu, editorView, pluginState.from)
      }

      menuKeyHandlers.set(editorView, (event: KeyboardEvent): boolean => {
        if (!currentState.active || currentItems.length === 0) return false
        if (event.key === "ArrowDown") {
          selectedIndex = (selectedIndex + 1) % currentItems.length
          render()
          return true
        }
        if (event.key === "ArrowUp") {
          selectedIndex = (selectedIndex - 1 + currentItems.length) % currentItems.length
          render()
          return true
        }
        if (event.key === "Enter") {
          runItem(currentItems[selectedIndex])
          return true
        }
        return false
      })

      update(editorView)

      return {
        update,
        destroy() {
          menuKeyHandlers.delete(editorView)
          menu.remove()
        }
      }
    }
  })
}

// `handleKeyDown` (a `props` callback, no access to the plugin `view()`'s closures) needs to reach
// the live menu's own keyboard-navigation state — keyed by `EditorView` instance rather than
// threaded through plugin state, since selection/render state here is transient UI state, not
// document state `apply` should own.
const menuKeyHandlers = new WeakMap<EditorView, (event: KeyboardEvent) => boolean>()
