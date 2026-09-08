/** A viewport-relative rectangle captured at the interaction that opened a floating surface. */
export interface FloatingAnchorRect {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
  readonly width: number
  readonly height: number
}

/** Re-reads an interaction anchor after scrolling or resizing moves it in the viewport. */
export type FloatingAnchorRectSource = () => FloatingAnchorRect | undefined

export const floatingAnchorRect = (rect: Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">): FloatingAnchorRect => ({
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
  left: rect.left,
  width: rect.width,
  height: rect.height
})

export interface FloatingPopoverPosition {
  readonly top: number
  readonly left: number
  readonly placement: "above" | "below" | "clamped"
}

interface FloatingPopoverSize {
  readonly width: number
  readonly height: number
}

interface FloatingViewport {
  readonly width: number
  readonly height: number
}

const EDGE = 16
const GAP = 10

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), Math.max(maximum, minimum))

/**
 * Calculates a fixed-position popover from the interaction that opened it.
 *
 * Below is the preferred placement. If the panel would leave the viewport, it flips above;
 * when neither side has enough room, the side with more room wins and the result is clamped.
 * Horizontal placement follows the anchor's leading edge and then clamps, which keeps a chip at
 * the right edge from pushing the panel off-screen.
 */
export const calculateFloatingPopoverPosition = (
  anchor: FloatingAnchorRect,
  size: FloatingPopoverSize,
  viewport: FloatingViewport
): FloatingPopoverPosition => {
  const fitsBelow = anchor.bottom + GAP + size.height <= viewport.height - EDGE
  const fitsAbove = anchor.top - GAP - size.height >= EDGE
  const belowSpace = Math.max(viewport.height - EDGE - anchor.bottom - GAP, 0)
  const aboveSpace = Math.max(anchor.top - EDGE - GAP, 0)
  const shouldPlaceAbove = !fitsBelow && (fitsAbove || aboveSpace > belowSpace)
  const preferredTop = shouldPlaceAbove
    ? anchor.top - GAP - size.height
    : anchor.bottom + GAP
  const top = clamp(preferredTop, EDGE, viewport.height - size.height - EDGE)
  const left = clamp(anchor.left, EDGE, viewport.width - size.width - EDGE)
  const placement = fitsBelow || fitsAbove ? (shouldPlaceAbove ? "above" : "below") : "clamped"
  return { top, left, placement }
}
