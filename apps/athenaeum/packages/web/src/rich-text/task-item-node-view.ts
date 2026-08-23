import type { Node as PMNode } from "prosemirror-model"
import type { EditorView, NodeView } from "prosemirror-view"

// A clickable checkbox for `task_item` nodes (the checklist block type). ProseMirror's own
// `toDOM` can't attach a live click handler, so this is a small custom `NodeView` — the standard
// ProseMirror mechanism for "this node needs real interactive DOM," used here for exactly one
// thing (toggling `checked`) and nothing else; the node's text content is still rendered/edited by
// ProseMirror itself via the `contentDOM` this view exposes.
export class TaskItemView implements NodeView {
  readonly dom: HTMLElement
  readonly contentDOM: HTMLElement
  #node: PMNode
  readonly #checkbox: HTMLInputElement

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.#node = node

    const li = document.createElement("li")
    li.className = "rich-task-item"
    li.dataset.checked = String(!!node.attrs.checked)

    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    checkbox.className = "rich-task-checkbox"
    checkbox.checked = !!node.attrs.checked
    checkbox.contentEditable = "false"
    checkbox.addEventListener("mousedown", (event) => {
      // Prevent ProseMirror from treating this as a selection click before the toggle lands.
      event.preventDefault()
    })
    checkbox.addEventListener("change", () => {
      const pos = getPos()
      if (pos === undefined) return
      const tr = view.state.tr.setNodeAttribute(pos, "checked", checkbox.checked)
      view.dispatch(tr)
    })
    this.#checkbox = checkbox

    const content = document.createElement("div")
    content.className = "rich-task-content"

    li.appendChild(checkbox)
    li.appendChild(content)

    this.dom = li
    this.contentDOM = content
  }

  update(node: PMNode): boolean {
    if (node.type !== this.#node.type) return false
    this.#node = node
    this.dom.dataset.checked = String(!!node.attrs.checked)
    this.#checkbox.checked = !!node.attrs.checked
    return true
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }): boolean {
    // Ignore DOM mutations to the checkbox itself (its `checked` state is toggled directly, not
    // via a ProseMirror-tracked DOM change) — everything inside `contentDOM` is still tracked
    // normally.
    return mutation.target === this.#checkbox
  }
}
