/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "prosemirror-view"
import { placeFloatingMenu } from "./menu-position.js"

const originalInnerHeight = window.innerHeight
const originalClientWidth = document.documentElement.clientWidth

const setViewport = (width: number, height: number): void => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height })
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width })
}

const rect = (overrides: Partial<DOMRect> = {}): DOMRect => ({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
  ...overrides
})

const editor = (
  coords: Pick<DOMRect, "top" | "right" | "bottom" | "left">,
  parentRect = rect()
): EditorView => {
  const parentElement = document.createElement("div")
  vi.spyOn(parentElement, "getBoundingClientRect").mockReturnValue(parentRect)
  return {
    coordsAtPos: vi.fn(() => ({ ...coords, height: coords.bottom - coords.top, width: coords.right - coords.left })),
    dom: { parentElement }
  } as unknown as EditorView
}

const menu = (size: Pick<DOMRect, "width" | "height">): HTMLElement => {
  const element = document.createElement("div")
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(size))
  return element
}

afterEach(() => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight })
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: originalClientWidth })
  vi.restoreAllMocks()
})

describe("placeFloatingMenu", () => {
  it("flips a picker above a low caret when the menu would leave the viewport", () => {
    setViewport(1200, 900)
    const picker = menu({ width: 280, height: 180 })

    placeFloatingMenu(
      picker,
      editor({ top: 860, right: 620, bottom: 880, left: 600 }),
      42
    )

    expect(picker.style.top).toBe("676px")
    expect(picker.style.left).toBe("600px")
  })

  it("clamps a picker to the right viewport edge", () => {
    setViewport(1200, 900)
    const picker = menu({ width: 280, height: 180 })

    placeFloatingMenu(
      picker,
      editor({ top: 200, right: 1190, bottom: 220, left: 1100 }),
      42
    )

    expect(picker.style.left).toBe("912px")
    expect(picker.style.top).toBe("224px")
  })

  it("keeps a picker inside a tiny viewport when neither side has room", () => {
    setViewport(360, 300)
    const picker = menu({ width: 320, height: 300 })

    placeFloatingMenu(
      picker,
      editor({ top: 100, right: 124, bottom: 124, left: 100 }),
      42
    )

    expect(picker.style.left).toBe("32px")
    expect(picker.style.top).toBe("8px")
  })
})
