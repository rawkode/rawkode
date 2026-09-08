// Reads back the bytes RichTextCompatTests.testNativeSpliceAcrossBlockMarkerDeletesTheMarker
// wrote out (a native-originated spliceText that landed on a block-marker position) through the
// SAME @automerge/automerge build the real web editor/backend use, and shows what the "web side"
// sees after syncing a doc a native client corrupted this way.
import * as A from "../../../packages/web/node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_node.js"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const bytes = readFileSync(join(tmpdir(), "corrupted-by-native.automerge"))
const doc = A.load(bytes)

console.log("=== doc.text after native corruption (as the web client's flat fallback would see it) ===")
console.log(JSON.stringify(doc.text))

console.log("=== A.spans(doc, ['text']) after native corruption ===")
const spans = A.spans(doc, ["text"])
console.log(JSON.stringify(spans, (_k, v) => (v instanceof A.ImmutableString ? { __immutableString: v.toString() } : v), 2))

const headingBlock = spans.find((s) => s.type === "block" && String(s.value.type) === "heading")
console.log("=== heading block marker still present? ===", headingBlock !== undefined)
