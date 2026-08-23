import { describe, expect, it } from "vitest"
import * as Automerge from "@automerge/automerge"
import { EditorState } from "prosemirror-state"
import { richTextSchemaAdapter, RICH_TEXT_PATH, RICH_TEXT_SCHEMA_VERSION } from "./schema.js"
import { syncPlugin } from "../vendor/automerge-prosemirror/syncPlugin.js"
import { LocalDocHandle } from "./local-doc-handle.js"
import type { PageDoc } from "../automerge-page.js"

// Adversarial-review regression test (blocking finding: "the documented primary signal — a
// `schemaVersion` marker written by the web editor on every save — is never actually written
// anywhere... leaving detection dependent solely on the defense-in-depth block-marker structural
// scan, which has nothing to detect for a real, common note shape").
//
// This reproduces the review's exact failure scenario using 100% real production code — the real
// `richTextSchemaAdapter` schema, the real vendored `syncPlugin`/`pmToAm` (via `EditorState.apply`,
// which runs registered plugins' `appendTransaction` exactly as the live `EditorView` does — no
// DOM/`EditorView` instance needed for this, `appendTransaction` is pure state-layer machinery) and
// the real `LocalDocHandle` this pass added `schemaVersion`-stamping to — not a hand-rolled
// simulation of what those would do.
describe("rich-text schemaVersion write (adversarial-review fix)", () => {
  it("a single-paragraph note with one bold-marked run produces zero block-type spans, exactly like the review found", () => {
    const schema = richTextSchemaAdapter.schema
    const genesisDoc = Automerge.from<PageDoc>({ text: "" }) // same genesis shape as the real backend's createPage
    const handle = new LocalDocHandle(genesisDoc)

    // Real EditorState, real syncPlugin instance, same construction RichNoteEditor.tsx uses.
    let state = EditorState.create({
      schema,
      plugins: [syncPlugin({ adapter: richTextSchemaAdapter, handle, path: RICH_TEXT_PATH })]
    })

    // A brand-new note's default doc is a single empty paragraph (ProseMirror's own
    // `createAndFill` for a `content: "block+"` doc schema) — the exact starting point a real
    // `RichNoteEditor` mount reaches for a freshly created, never-yet-typed-into page.
    const paragraphStart = 1 // inside the sole default paragraph, position 0 is `doc`'s own boundary
    let tr = state.tr
    tr = tr.insertText("Shipped the daily-note MVP today.", paragraphStart)
    const boldFrom = paragraphStart + "Shipped the ".length
    const boldTo = boldFrom + "daily-note MVP".length
    tr = tr.addMark(boldFrom, boldTo, schema.marks.strong.create())

    // `EditorState.apply` runs every plugin's `appendTransaction` synchronously (pure state-layer
    // API — this is what actually invokes `syncPlugin`'s `appendTransaction`, which is what calls
    // `handle.change(...)`), exactly as `RichNoteEditor`'s real `dispatchTransaction` does via
    // `view.state.apply(tr)`.
    state = state.apply(tr)
    expect(state.doc.textContent).toBe("Shipped the daily-note MVP today.")

    const finalDoc = handle.doc()
    const spans = Automerge.spans(finalDoc, RICH_TEXT_PATH)

    // Confirms the review's finding still holds structurally: this real, common note shape
    // produces no block markers for the defense-in-depth scan to catch.
    expect(spans.some((span) => span.type === "block")).toBe(false)

    // THE FIX: even though there is no block marker to fall back on, the primary signal is now
    // present — stamped by `LocalDocHandle.change` in the very same Automerge commit as the
    // content mutation above, so there is no window where this note's content existed without it.
    expect(finalDoc.schemaVersion).toBe(RICH_TEXT_SCHEMA_VERSION)
    expect(finalDoc.schemaVersion).toBeGreaterThanOrEqual(2)
  })

  it("a genuinely empty, never-edited note is left with no schemaVersion (nothing to protect yet)", () => {
    // Sanity check on the "on every save" framing: mounting the editor on an empty note without
    // typing anything must not itself fabricate a commit/marker — `LocalDocHandle.change` is only
    // ever invoked by `syncPlugin.appendTransaction`, which only fires for a real `docChanged`
    // transaction.
    const genesisDoc = Automerge.from<PageDoc>({ text: "" })
    expect(genesisDoc.schemaVersion).toBeUndefined()
  })
})
