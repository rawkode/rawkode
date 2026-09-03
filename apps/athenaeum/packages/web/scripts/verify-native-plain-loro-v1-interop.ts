import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { LoroDoc, VersionVector } from "loro-crdt"
import { LoroSyncPlugin, type LoroDocType } from "loro-prosemirror"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { Window } from "happy-dom"
import corpus from "../src/fixtures/native-plain-loro-v1-corpus.json"
import { LORO_PROSEMIRROR_CONTAINER } from "@athenaeum/domain"
import { richTextSchemaAdapter } from "../src/rich-text/schema.js"
import { inspectNativePlainLoroV1, nativePlainLoroScalarOffset } from "../src/native-plain-loro-v1-corpus.js"

const rootDir = new URL("../../../", import.meta.url).pathname
const probe = join(rootDir, "native/AthenaeumCore/.build/out/Products/Debug/loro-interoperability-probe")
const decode = (v: string) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0))
const encode = (v: Uint8Array) => { let s = ""; for (const b of v) s += String.fromCharCode(b); return btoa(s) }
const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator })
const semanticallyEqualVV = (a: Uint8Array, b: Uint8Array): boolean => VersionVector.decode(a).compare(VersionVector.decode(b)) === 0

const runProbe = (dir: string, snapshot: Uint8Array, vv: Uint8Array, update: Uint8Array, text: string, start: number, length: number, incoming?: Uint8Array, label = "case") => {
  const snapshotPath = join(dir, "snapshot"), vvPath = join(dir, "server-vv"), updatePath = join(dir, "update"), clientPath = join(dir, "client-vv")
  return (async () => {
    await writeFile(snapshotPath, snapshot); await writeFile(vvPath, vv); await writeFile(updatePath, update)
    const incomingPath = incoming ? join(dir, "incoming") : undefined
    if (incomingPath) await writeFile(incomingPath, incoming)
    const args = ["--snapshot", snapshotPath, "--server-version", vvPath, ...(incomingPath ? ["--incoming-update", incomingPath] : []), "--update", updatePath, "--client-version", clientPath, "--text", text, "--operation", "replace", "--range-start", String(start), "--range-length", String(length)]
    const result = spawnSync(probe, args, { stdio: "ignore" })
    if (result.status !== 0) throw new Error(`${label}: native probe failed with exit ${result.status}`)
    return { update: await readFile(updatePath), clientVersion: await readFile(clientPath) }
  })()
}

const pluginView = async (doc: LoroDoc): Promise<EditorView> => {
  const root = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
  const empty = richTextSchemaAdapter.schema.topNodeType.createAndFill()!
  const state = EditorState.create({ schema: richTextSchemaAdapter.schema, doc: empty, plugins: [LoroSyncPlugin({ doc: doc as unknown as LoroDocType, containerId: root.id })] })
  const view = new EditorView(document.createElement("div"), { state })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  return view
}

const main = async () => {
  const dir = await mkdtemp(join(tmpdir(), "athenaeum-nle00-interop-"))
  try {
    for (const fixture of corpus.cases) {
      const base = decode(fixture.initialSnapshotBase64), vv = decode(fixture.acceptedBaseVVBase64)
      const start = fixture.replacement.rangeStart, length = fixture.replacement.rangeLength
      const native = await runProbe(dir, base, vv, new Uint8Array(), fixture.replacement.value, start, length, undefined, fixture.id)
      const nativeDoc = new LoroDoc(); nativeDoc.import(base); nativeDoc.import(native.update)
      const nativeSnapshot = nativeDoc.export({ mode: "snapshot" })
      const nativeShape = inspectNativePlainLoroV1(encode(nativeSnapshot))
      if (nativeShape.blocks[0].text !== fixture.expectedText) throw new Error(`${fixture.id}: native text mismatch (${JSON.stringify(nativeShape.blocks[0].text)} != ${JSON.stringify(fixture.expectedText)})`)
      const nativeView = await pluginView(nativeDoc)
      try { if (nativeView.state.doc.textContent !== fixture.expectedText) throw new Error(`${fixture.id}: plugin projection mismatch`) } finally { nativeView.destroy() }
      // Opposite direction: a real plugin transaction creates a web update, then native replaces one final scalar.
      const webDoc = new LoroDoc(); webDoc.import(base)
      const webView = await pluginView(webDoc)
      if (webView.state.doc.textContent !== fixture.originalText) throw new Error(`${fixture.id}: web base projection mismatch`)
      const finalText = fixture.expectedText
      const webTransaction = webView.state.tr.insertText(fixture.replacement.value, 1 + nativePlainLoroScalarOffset(fixture.originalText, start), 1 + nativePlainLoroScalarOffset(fixture.originalText, start + length))
      if (!webTransaction.docChanged) throw new Error(`${fixture.id}: web transaction was not docChanged`)
      webView.dispatch(webTransaction)
      webDoc.commit()
      const webUpdate = webDoc.export({ mode: "update", from: VersionVector.decode(vv) })
      webView.destroy()
      const further = "!"
      const nativeFurther = await runProbe(dir, base, vv, new Uint8Array(), further, Array.from(finalText).length, 0, webUpdate, `${fixture.id}-roundtrip`)
      const roundTrip = new LoroDoc(); roundTrip.import(base); roundTrip.import(webUpdate); roundTrip.import(nativeFurther.update)
      if (!semanticallyEqualVV(roundTrip.version().encode(), nativeFurther.clientVersion)) throw new Error(`${fixture.id}: version-vector mismatch`)
      const roundTripView = await pluginView(roundTrip)
      if (roundTripView.state.doc.textContent !== `${finalText}${further}`) throw new Error(`${fixture.id}: round-trip text mismatch`)
      roundTripView.destroy()
    }
    const newline = corpus.negatives.find((entry) => entry.capability === "rejected-newline")!
    const base = decode(newline.snapshotBase64), vv = decode(corpus.cases[0].acceptedBaseVVBase64)
    const newlineSnapshotPath = join(dir, "newline-snapshot"), newlineVVPath = join(dir, "newline-vv"), newlineUpdatePath = join(dir, "newline-update"), newlineClientPath = join(dir, "newline-client")
    await writeFile(newlineSnapshotPath, base); await writeFile(newlineVVPath, vv); await writeFile(newlineUpdatePath, "sentinel-update"); await writeFile(newlineClientPath, "sentinel-client")
    const inspected = inspectNativePlainLoroV1(encode(base))
    if (inspected.blocks[0].text !== newline.replacement!.originalText) throw new Error("newline base mismatch")
    const result = spawnSync(probe, ["--snapshot", newlineSnapshotPath, "--server-version", newlineVVPath, "--update", newlineUpdatePath, "--client-version", newlineClientPath, "--text", newline.replacement!.value, "--operation", "replace", "--range-start", String(newline.replacement!.rangeStart), "--range-length", String(newline.replacement!.rangeLength)], { stdio: "ignore" })
    if (result.status !== 4) throw new Error("newline probe did not reject strictly")
    if (!(await readFile(newlineUpdatePath)).equals(Buffer.from("sentinel-update")) || !(await readFile(newlineClientPath)).equals(Buffer.from("sentinel-client"))) throw new Error("newline rejection changed outputs")
    for (const entry of corpus.negatives.filter((entry) => entry.capability !== "rejected-newline")) {
      const snapshotPath = join(dir, `${entry.id}-snapshot`), vvPath = join(dir, `${entry.id}-vv`), updatePath = join(dir, `${entry.id}-update`), clientPath = join(dir, `${entry.id}-client`)
      await writeFile(snapshotPath, decode(entry.snapshotBase64)); await writeFile(vvPath, vv); await writeFile(updatePath, "sentinel-update"); await writeFile(clientPath, "sentinel-client")
      const replacement = entry.probeReplacement
      const rejected = spawnSync(probe, ["--snapshot", snapshotPath, "--server-version", vvPath, "--update", updatePath, "--client-version", clientPath, "--text", replacement.value, "--operation", "replace", "--range-start", String(replacement.rangeStart), "--range-length", String(replacement.rangeLength)], { stdio: "ignore" })
      if (rejected.status !== 4 || !(await readFile(updatePath)).equals(Buffer.from("sentinel-update")) || !(await readFile(clientPath)).equals(Buffer.from("sentinel-client"))) throw new Error(`${entry.id}: malformed structure was accepted or mutated outputs`)
    }
    console.log(`verified ${corpus.cases.length} valid cases plus newline and structural negatives`)
  } finally { await rm(dir, { recursive: true, force: true }) }
}
await main()
