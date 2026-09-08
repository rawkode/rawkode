// Throwaway empirical test (see docs/rich-text-editor-decisions.md item 2). Builds an Automerge
// document using the SAME raw block-marker/mark primitives @automerge/prosemirror's traversal.ts
// drives (A.updateSpans / A.splitBlock / A.mark), against the SAME @automerge/automerge version
// (3.4.1) installed in packages/web — mimicking what a real rich-text edit in the web editor will
// produce, without needing @automerge/prosemirror itself installed. Content model matches
// notes-service-live.ts's PageDoc: a single top-level "text" field.
//
// Run: bun make-rich-doc.mjs
import * as A from "../../../packages/web/node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_node.js"
import { writeFileSync } from "node:fs"

// 1. Genesis exactly like the server's real createPage: Automerge.from({text: ""}).
let doc = A.from({ text: "" })

// 2. Splice in the raw text content. Includes a heading line, a paragraph, and two list items —
//    laid out as they would appear in the underlying Text sequence once block markers are
//    inserted between them (block markers occupy one index each, so text after a block marker is
//    offset by +1 per marker inserted before it, same as @automerge/prosemirror's traversal.ts
//    computes internally).
doc = A.change(doc, (d) => {
  A.splice(d, ["text"], 0, 0, "Heading OneFirst paragraph, with bold text in it.Item oneItem two")
})

// 3. Insert block markers via the real A.splitBlock primitive (same one traversal.ts's
//    pmNodeToSpans->updateSpans path ultimately relies on). Indices below account for each
//    preceding marker shifting subsequent text by 1.
doc = A.change(doc, (d) => {
  // "Heading One" is a heading (level 1) block starting at index 0.
  A.splitBlock(d, ["text"], 0, { type: new A.ImmutableString("heading"), parents: [], attrs: { level: 1 }, isEmbed: false })
})
doc = A.change(doc, (d) => {
  // "First paragraph..." starts right after "Heading One" (11 chars) + 1 marker = index 12.
  A.splitBlock(d, ["text"], 12, { type: new A.ImmutableString("paragraph"), parents: [], attrs: {}, isEmbed: false })
})
doc = A.change(doc, (d) => {
  // "Item one" starts after marker(1) + "Heading One"(11) + marker(1) + "First paragraph, with bold text in it."(39) = 1+11+1+39 = 52
  A.splitBlock(d, ["text"], 52, {
    type: new A.ImmutableString("list-item"),
    parents: [new A.ImmutableString("bullet-list")],
    attrs: {},
    isEmbed: false
  })
})
doc = A.change(doc, (d) => {
  // "Item two" starts after previous + marker(1) + "Item one"(8) = 52+1+1+8 = 62
  A.splitBlock(d, ["text"], 62, {
    type: new A.ImmutableString("list-item"),
    parents: [new A.ImmutableString("bullet-list")],
    attrs: {},
    isEmbed: false
  })
})

// 4. Add an inline bold mark over "bold" within the paragraph (real doc.mark call, same primitive
//    automerge-swift's Marks API and @automerge/automerge's A.mark share at the CRDT level).
doc = A.change(doc, (d) => {
  const spansBefore = A.spans(d, ["text"])
  // Recompute the live index of "bold" by searching the current plain text via A.spans (avoids
  // hand-counting through 4 splitBlock calls' cumulative offsets).
  let idx = 0
  let boldStart = -1
  for (const span of spansBefore) {
    if (span.type === "text") {
      const pos = span.value.indexOf("bold")
      if (pos !== -1 && boldStart === -1) boldStart = idx + pos
      idx += span.value.length
    } else {
      idx += 1
    }
  }
  if (boldStart === -1) throw new Error("could not locate 'bold' in spans")
  A.mark(d, ["text"], { start: boldStart, end: boldStart + 4, expand: "none" }, "strong", true)
})

const bytes = A.save(doc)
writeFileSync(new URL("./rich-doc.automerge", import.meta.url), bytes)

console.log("=== Saved", bytes.length, "bytes to rich-doc.automerge ===")
console.log("=== A.spans(doc, ['text']) ===")
console.log(JSON.stringify(A.spans(doc, ["text"]), (_k, v) => (v instanceof A.ImmutableString ? { __immutableString: v.toString() } : v), 2))
console.log("=== plain text field (doc.text, the flat string a native reader would see) ===")
// The underlying text object is still a Text/string field readable the old flat way too —
// Automerge.js exposes it directly as doc.text when read as a plain JS value.
console.log(JSON.stringify(doc.text))
console.log("=== doc.text.length ===", doc.text.length)
