import type { EditorView } from "prosemirror-view"

// Design-review 2026-08-22 finding #4 (flows F1.2): the `#` picker rendered fully below the
// viewport when the caret sat in the bottom ~250px of the window (measured live: menu at
// top=899 in a 900px viewport — 1px visible), because every floating editor menu placed itself
// unconditionally below the caret. The `@` mention picker and the `/` slash menu shared the exact
// same `position()` code (the plugins are deliberate copies of each other — see
// `supertag-plugin.ts`'s header comment), so all three now share this one placement helper
// instead of three private copies of the bug.
//
// Behavior: prefer below the caret (unchanged default); flip above it when the menu doesn't fit
// below but does fit above; clamp to the viewport in both axes as a last resort (tiny windows
// where neither side fits). Callers must invoke this AFTER the menu's content is rendered and its
// inline `display` is no longer `none` — the flip decision measures the menu's real
// `getBoundingClientRect()` height, which is 0 for an empty or hidden menu (each plugin calls it
// once on open for a rough placement, then again after its rows render).

const CARET_GAP = 4
const VIEWPORT_EDGE = 8

export const placeFloatingMenu = (menu: HTMLElement, editorView: EditorView, anchorPos: number): void => {
  const coords = editorView.coordsAtPos(anchorPos)
  const parentRect = editorView.dom.parentElement?.getBoundingClientRect()
  const menuRect = menu.getBoundingClientRect()
  const viewportHeight = window.innerHeight
  const viewportWidth = document.documentElement.clientWidth

  const fitsBelow = coords.bottom + CARET_GAP + menuRect.height <= viewportHeight - VIEWPORT_EDGE
  const fitsAbove = coords.top - CARET_GAP - menuRect.height >= VIEWPORT_EDGE
  const preferredTop = fitsBelow || !fitsAbove ? coords.bottom + CARET_GAP : coords.top - CARET_GAP - menuRect.height
  const top = Math.min(
    Math.max(preferredTop, VIEWPORT_EDGE),
    Math.max(viewportHeight - menuRect.height - VIEWPORT_EDGE, VIEWPORT_EDGE)
  )
  const left = Math.min(coords.left, Math.max(viewportWidth - menuRect.width - VIEWPORT_EDGE, VIEWPORT_EDGE))

  menu.style.position = "absolute"
  menu.style.left = `${left - (parentRect?.left ?? 0)}px`
  menu.style.top = `${top - (parentRect?.top ?? 0)}px`
}
