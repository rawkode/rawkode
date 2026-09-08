/** @vitest-environment happy-dom */

import { describe, expect, it } from "vitest"
import { createLoroPage } from "./loro-page.js"
import { renderStaticLoroPreview } from "./loro-static-preview.js"

describe("renderStaticLoroPreview", () => {
  it("renders a validated static document without creating an editor", () => {
    const page = createLoroPage()
    const children = page.pmRoot.get("children") as { get(index: number): { get(key: string): unknown } }
    const paragraph = children.get(0)
    const text = paragraph.get("children") as { get(index: number): { insert(pos: number, text: string): void } }
    text.get(0).insert(0, "A recorded employee update")
    const result = renderStaticLoroPreview(page.doc)
    expect(result).toEqual({ kind: "content", html: "<p>A recorded employee update</p>" })
  })

  it("classifies malformed Loro pages safely", () => {
    const page = createLoroPage()
    page.meta.set("schemaVersion", 999)
    expect(renderStaticLoroPreview(page.doc)).toEqual({ kind: "unsupported" })
  })
})
