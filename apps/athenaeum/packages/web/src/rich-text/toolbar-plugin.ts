import { Plugin, PluginKey, TextSelection } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import type { MarkType, Schema } from "prosemirror-model"
import { buildCommands, isMarkActive } from "./commands.js"

// Floating (bubble) toolbar for inline marks — shown above a non-empty text selection, following
// the same "hand-managed floating DOM, not a React portal" rationale as the slash menu
// (`slash-menu-plugin.ts`'s header comment). Bold/italic/strikethrough/code/link, per the task's
// required inline-mark set.

export const toolbarPluginKey = new PluginKey("rich-text-toolbar")

interface ToolbarButton {
  readonly label: string
  readonly mark: MarkType
  readonly title: string
}

export const toolbarPlugin = (schema: Schema): Plugin => {
  const commands = buildCommands(schema)
  const buttons: ToolbarButton[] = [
    { label: "B", mark: schema.marks.strong, title: "Bold (Mod-B)" },
    { label: "I", mark: schema.marks.em, title: "Italic (Mod-I)" },
    { label: "S", mark: schema.marks.strike, title: "Strikethrough" },
    { label: "</>", mark: schema.marks.code, title: "Inline code" }
  ]

  return new Plugin({
    key: toolbarPluginKey,
    view(editorView) {
      const bar = document.createElement("div")
      bar.className = "rich-toolbar"
      bar.style.display = "none"
      editorView.dom.parentElement?.appendChild(bar)

      const markButtons = buttons.map((button) => {
        const el = document.createElement("button")
        el.type = "button"
        el.className = "rich-toolbar-button"
        el.textContent = button.label
        el.title = button.title
        el.addEventListener("mousedown", (event) => {
          event.preventDefault()
          const command =
            button.mark === schema.marks.strong
              ? commands.toggleBold
              : button.mark === schema.marks.em
                ? commands.toggleItalic
                : button.mark === schema.marks.strike
                  ? commands.toggleStrike
                  : commands.toggleCode
          command(editorView.state, editorView.dispatch, editorView)
          editorView.focus()
        })
        bar.appendChild(el)
        return { button, el }
      })

      const linkButton = document.createElement("button")
      linkButton.type = "button"
      linkButton.className = "rich-toolbar-button"
      linkButton.textContent = "Link"
      linkButton.title = "Add link"
      linkButton.addEventListener("mousedown", (event) => {
        event.preventDefault()
        const existingHref = currentLinkHref(editorView, schema)
        const href = window.prompt("Link URL", existingHref ?? "https://")
        if (href === null) return
        if (href.trim().length === 0) {
          commands.removeLink(editorView.state, editorView.dispatch, editorView)
        } else {
          commands.toggleLink(href.trim())(editorView.state, editorView.dispatch, editorView)
        }
        editorView.focus()
      })
      bar.appendChild(linkButton)

      const update = (view: EditorView) => {
        const { selection } = view.state
        const hasSelection = selection instanceof TextSelection && !selection.empty
        if (!hasSelection) {
          bar.style.display = "none"
          return
        }
        for (const { button, el } of markButtons) {
          el.classList.toggle("is-active", isMarkActive(view.state, button.mark))
        }
        linkButton.classList.toggle("is-active", isMarkActive(view.state, schema.marks.link))

        const { from, to } = selection
        const start = view.coordsAtPos(from)
        const end = view.coordsAtPos(to)
        const parentRect = editorView.dom.parentElement?.getBoundingClientRect()
        const left = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2 - (parentRect?.left ?? 0)
        const top = Math.min(start.top, end.top) - (parentRect?.top ?? 0)
        bar.style.display = "flex"
        bar.style.position = "absolute"
        bar.style.left = `${left}px`
        bar.style.top = `${top}px`
        bar.style.transform = "translate(-50%, calc(-100% - 8px))"
      }

      update(editorView)
      return { update, destroy: () => bar.remove() }
    }
  })
}

const currentLinkHref = (view: EditorView, schema: Schema): string | undefined => {
  const { from, to } = view.state.selection
  let href: string | undefined
  view.state.doc.nodesBetween(from, to, (node) => {
    const mark = schema.marks.link.isInSet(node.marks)
    if (mark) href = mark.attrs.href as string
  })
  return href
}
