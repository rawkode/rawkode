import * as Automerge from "@automerge/automerge"
import { describe, expect, it } from "vitest"
import { createNodeFromLoroObj, type LoroNode } from "loro-prosemirror"
import { EditorState } from "prosemirror-state"
import type { PageDoc } from "../automerge-page.js"
import { loroPageFromAutomergePage, loroPageFromSnapshot, pmDocumentFromAutomergePage } from "./loro-migration.js"
import { LocalDocHandle } from "./local-doc-handle.js"
import { RICH_TEXT_PATH, richTextSchemaAdapter } from "./schema.js"
import { syncPlugin } from "../vendor/automerge-prosemirror/syncPlugin.js"

describe("Loro rich-text migration", () => {
  it("creates an editable PM-compatible empty document and round-trips its snapshot", () => {
    const page = loroPageFromAutomergePage(Automerge.from<PageDoc>({ text: "" }))
    expect(page.meta.get("schemaVersion")).toBe(1)
    expect(page.pmRoot.get("nodeName")).toBe("doc")

    const restored = loroPageFromSnapshot(page.doc.export({ mode: "snapshot" }))
    expect(restored.pmRoot.get("nodeName")).toBe("doc")
  })

  it("preserves paragraph text and reference mark payloads", () => {
    const schema = richTextSchemaAdapter.schema
    const handle = new LocalDocHandle(Automerge.from<PageDoc>({ text: "" }))
    let state = EditorState.create({
      schema,
      plugins: [syncPlugin({ adapter: richTextSchemaAdapter, handle, path: RICH_TEXT_PATH })]
    })
    const paragraphStart = 1
    let tr = state.tr.insertText("Alice #person", paragraphStart)
    const entityFrom = paragraphStart
    const entityTo = entityFrom + "Alice".length
    const tagFrom = paragraphStart + "Alice ".length
    tr = tr.addMark(entityFrom, entityTo, schema.marks.entityRef.create({ nodeId: "node-1", label: "Alice" }))
    tr = tr.addMark(tagFrom, tagFrom + "#person".length, schema.marks.supertagRef.create({ tagId: "tag-1", label: "person" }))
    state = state.apply(tr)

    const page = loroPageFromAutomergePage(handle.doc())
    const restored = createNodeFromLoroObj(schema, page.pmRoot as LoroNode, new Map())
    expect(restored.toJSON()).toEqual(state.doc.toJSON())
    expect(pmDocumentFromAutomergePage(handle.doc()).textContent).toBe("Alice #person")
  })
})
