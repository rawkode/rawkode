import type { EditorView } from "prosemirror-view"

/**
 * Keep the empty-note affordance tied to ProseMirror's document, rather than its generated DOM
 * shape. ProseMirror may add widget nodes (drag handles, trailing breaks, and plugin decorations)
 * around an empty paragraph, so a CSS-only structural selector is not a stable signal.
 */
export const updateEditorEmptyState = (view: EditorView): void => {
  const isEmpty = view.state.doc.textContent.trim().length === 0
  if (isEmpty) view.dom.dataset.empty = "true"
  else delete view.dom.dataset.empty
  view.dom.setAttribute("aria-placeholder", "Start with what matters. Use # to connect a person or project; @ to link context.")
}
