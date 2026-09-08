import { describe, expect, it } from "vitest"
import { calculateFloatingPopoverPosition, type FloatingAnchorRect } from "./floating-popover-position.js"

const anchor = (overrides: Partial<FloatingAnchorRect> = {}): FloatingAnchorRect => ({
  top: 200,
  right: 260,
  bottom: 224,
  left: 200,
  width: 60,
  height: 24,
  ...overrides
})

describe("calculateFloatingPopoverPosition", () => {
  it("keeps a popover below its invoking chip when there is room", () => {
    expect(calculateFloatingPopoverPosition(anchor(), { width: 320, height: 180 }, { width: 1200, height: 900 })).toEqual({
      top: 234,
      left: 200,
      placement: "below"
    })
  })

  it("flips above a chip near the bottom edge", () => {
    expect(calculateFloatingPopoverPosition(anchor({ top: 700, bottom: 724 }), { width: 320, height: 180 }, { width: 1200, height: 900 })).toEqual({
      top: 510,
      left: 200,
      placement: "above"
    })
  })

  it("clamps horizontally when the invoking chip is near the right edge", () => {
    expect(calculateFloatingPopoverPosition(anchor({ left: 1120 }), { width: 320, height: 180 }, { width: 1200, height: 900 })).toEqual({
      top: 234,
      left: 864,
      placement: "below"
    })
  })

  it("chooses the roomier side and clamps in a small viewport", () => {
    expect(calculateFloatingPopoverPosition(anchor({ top: 100, bottom: 124 }), { width: 320, height: 300 }, { width: 360, height: 360 })).toEqual({
      top: 44,
      left: 24,
      placement: "clamped"
    })
  })
})
