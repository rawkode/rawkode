// Adversarial-review fix regeneration: builds a real Automerge doc matching exactly what the REAL
// rich-text web editor produces for the most common note shape — one paragraph, no second block,
// with one bold-marked run (e.g. an entityRef-style mention would be structurally identical: a
// mark, no block) — AFTER the fix (`packages/web/src/rich-text/local-doc-handle.ts`'s
// `LocalDocHandle.change` now stamps `schemaVersion = RICH_TEXT_SCHEMA_VERSION` in the SAME
// `Automerge.change`/commit as the content mutation).
//
// Previously (the version of this script the adversarial review used) this only did the raw
// `A.splice`/`A.mark` ops with no `schemaVersion` write at all, reproducing the gap: a real
// single-paragraph rich note was indistinguishable from legacy flat text. This version mirrors the
// real fixed `LocalDocHandle.change` exactly: content mutation and the `schemaVersion` root-scalar
// write happen inside ONE `A.change` call, matching that one real ProseMirror transaction (insert
// text + add the bold mark, dispatched together, exactly as `EditorState.apply` batches them) maps
// to exactly one Automerge commit carrying both.
//
// Uses the same @automerge/automerge 3.4.1 build installed in packages/web, same genesis path
// (`A.from({text: ""})`) `notes-service-live.ts`'s real `createPage` uses.
import * as A from "../../../packages/web/node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_node.js"
import { writeFileSync } from "node:fs"

// Mirrors `packages/web/src/rich-text/schema.ts`'s `RICH_TEXT_SCHEMA_VERSION` constant — kept in
// sync manually here since this script intentionally has no build-time dependency on packages/web's
// TypeScript source (it only borrows its installed `@automerge/automerge` copy).
const RICH_TEXT_SCHEMA_VERSION = 2

let doc = A.from({ text: "" })
doc = A.change(doc, (d) => {
  // One real ProseMirror transaction — insertText + addMark, dispatched together — becomes one
  // `LocalDocHandle.change` call, i.e. one Automerge commit carrying the content mutation AND the
  // schemaVersion stamp. Splitting these into separate `A.change` calls (as the pre-fix version of
  // this script did for the content ops) would understate how atomic the real fix's write is.
  A.splice(d, ["text"], 0, 0, "Shipped the daily-note MVP today.")
  // "daily-note MVP" starts at index 13 ("Shipped the ".length), 14 chars long.
  A.mark(d, ["text"], { start: 13, end: 27, expand: "none" }, "strong", true)
  d.schemaVersion = RICH_TEXT_SCHEMA_VERSION
})

console.log("=== plain text field ===")
console.log(JSON.stringify(doc.text))
console.log("=== spans ===")
console.log(JSON.stringify(A.spans(doc, ["text"]), null, 2))
console.log("=== any block spans? ===", A.spans(doc, ["text"]).some((s) => s.type === "block"))
console.log("=== root keys ===", Object.keys(doc))
console.log("=== schemaVersion ===", doc.schemaVersion)

const bytes = A.save(doc)
writeFileSync(new URL("./single-paragraph-doc.b64", import.meta.url), Buffer.from(bytes).toString("base64"))
console.log("=== saved bytes length ===", bytes.length)
console.log("=== base64 ===")
console.log(Buffer.from(bytes).toString("base64"))
