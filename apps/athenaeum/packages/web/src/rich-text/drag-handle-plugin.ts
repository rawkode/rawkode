import { Plugin, PluginKey } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"

// Drag-to-reorder top-level blocks (task requirement). A small gutter handle rendered before every
// direct child of `doc` via a `Decoration.widget` — widgets get a live `view`/`getPos` in their
// `toDOM` factory (unlike the plain `decorations(state)` prop signature, which has no view access),
// which is what lets the handle's own drag events build and dispatch a real move transaction
// without any extra plugin-level view() hook.
//
// Reordering is HTML5 drag-and-drop between handles (not mouse-delta dragging of the block itself)
// — simpler to make reliable inside a `contenteditable` region, and standard/native drag affordance
// users already know from file managers and most block editors' own gutter handles.

export const dragHandlePluginKey = new PluginKey("rich-text-drag-handle")

export const dragHandlePlugin = (): Plugin => {
  // Shared across every handle this plugin instance renders — sourced from the handle that started
  // the drag (`dragstart`), consumed by whichever handle receives the `drop`.
  let dragSourcePos: number | null = null

  return new Plugin({
    key: dragHandlePluginKey,
    props: {
      decorations(state) {
        const decorations: Decoration[] = []
        state.doc.forEach((_node, offset) => {
          decorations.push(
            Decoration.widget(
              offset + 1,
              (view, getPos) => {
                const handle = document.createElement("span")
                handle.className = "rich-drag-handle"
                handle.draggable = true
                handle.contentEditable = "false"
                handle.title = "Drag to reorder"
                // The widget lives INSIDE the block element it reorders, so without this the
                // handle's text ("⠿" + the title above) is concatenated into the block's own
                // accessible name — a heading literally announced as "Drag to reorder Heading …"
                // (confirmed in a live accessibility snapshot). Mouse-only affordance (HTML5
                // drag-and-drop, no keyboard path), so removing it from the a11y tree is the
                // correct separation, not a loss of function.
                handle.setAttribute("aria-hidden", "true")
                // Inner glyph span: the OUTER handle inherits the block's font-size/line-height so
                // CSS can size it to exactly the block's first line box (`height: 1lh`) for
                // correct vertical alignment; the glyph itself stays a fixed, small size.
                const glyph = document.createElement("span")
                glyph.className = "rich-drag-handle-glyph"
                glyph.textContent = "⠿"
                handle.appendChild(glyph)

                handle.addEventListener("dragstart", (event) => {
                  const pos = getPos()
                  if (pos === undefined) return
                  dragSourcePos = pos - 1
                  event.dataTransfer?.setData("text/plain", "")
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                })

                handle.addEventListener("dragover", (event) => {
                  if (dragSourcePos === null) return
                  event.preventDefault()
                  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
                })

                handle.addEventListener("drop", (event) => {
                  event.preventDefault()
                  const targetAnchor = getPos()
                  if (dragSourcePos === null || targetAnchor === undefined) return
                  const sourcePos = dragSourcePos
                  dragSourcePos = null

                  const sourceNode = view.state.doc.nodeAt(sourcePos)
                  if (!sourceNode) return
                  const targetPos = targetAnchor - 1
                  if (targetPos === sourcePos) return

                  let tr = view.state.tr
                  tr = tr.delete(sourcePos, sourcePos + sourceNode.nodeSize)
                  const mappedTarget = tr.mapping.map(targetPos)
                  tr = tr.insert(mappedTarget, sourceNode)
                  view.dispatch(tr)
                })

                handle.addEventListener("dragend", () => {
                  dragSourcePos = null
                })

                return handle
              },
              { side: -1, key: `drag-handle-${offset}` }
            )
          )
        })
        return DecorationSet.create(state.doc, decorations)
      }
    }
  })
}
