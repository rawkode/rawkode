import { LoroDoc, LoroList, LoroMap, LoroText, VersionVector } from "loro-crdt"
import { LoroSyncPlugin, type LoroDocType } from "loro-prosemirror"
import { EditorState, type Transaction } from "prosemirror-state"
import type { Node as PMNode } from "prosemirror-model"
import { LORO_PAGE_META_CONTAINER, LORO_PAGE_SCHEMA_VERSION, LORO_PROSEMIRROR_CONTAINER } from "@athenaeum/domain"
import { richTextSchemaAdapter } from "./rich-text/schema.js"

/** Provisional until NLE-00-C proves the scalar unit at the native bridge. */
export const NATIVE_PLAIN_LORO_SCALAR_UNIT = "provisional-unicode-scalar"
export const NATIVE_PLAIN_LORO_PEER_ID = "424242"

export interface NativePlainLoroShape {
  readonly rootAttributes: { readonly isAmgBlock: false }
  readonly blocks: readonly [{ readonly nodeName: "paragraph"; readonly attributes: { readonly isAmgBlock: false }; readonly text: string }]
  readonly namedRootContainers: readonly ["athenaeum-page-meta-v1", "athenaeum-prosemirror-v1"]
}

export interface NativePlainLoroCase {
  readonly id: string
  readonly valid: true
  readonly initialSnapshotBase64: string
  readonly initialSnapshotSHA256?: string
  readonly acceptedBaseVVBase64: string
  readonly acceptedBaseVVSHA256?: string
  readonly originalText: string
  readonly replacement: { readonly rangeStart: number; readonly rangeLength: number; readonly value: string }
  readonly expectedText: string
  readonly initialShape: NativePlainLoroShape
  readonly expectedFinalShape: NativePlainLoroShape
}

export interface NativePlainLoroNegative {
  readonly id: string
  readonly valid: false
  readonly capability: "rejected-newline" | "missing-attribute" | "true-attribute" | "extra-attribute" | "mark" | "extra-block" | "extra-container"
  readonly expectedFailure: "closed-world-plain-loro-v1"
  readonly snapshotBase64: string
  readonly replacement?: { readonly originalText: string; readonly rangeStart: number; readonly rangeLength: number; readonly value: string }
  readonly probeReplacement: { readonly originalText: string; readonly rangeStart: number; readonly rangeLength: number; readonly value: string }
}

export interface NativePlainLoroV1Corpus {
  readonly format: "athenaeum-native-plain-loro-v1-corpus"
  readonly corpusVersion: 1
  readonly scalarUnit: typeof NATIVE_PLAIN_LORO_SCALAR_UNIT
  readonly generator: { readonly loroCrdt: "1.14.1"; readonly loroProsemirror: "0.4.4"; readonly schema: "athenaeum-rich-text-v1"; readonly peerId: "424242" }
  readonly cases: readonly NativePlainLoroCase[]
  readonly eligibility: { readonly id: "canonical-empty-document"; readonly snapshotBase64: string; readonly expectedShape: NativePlainLoroShape }
  readonly negatives: readonly NativePlainLoroNegative[]
}

const base64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const bytes = (encoded: string): Uint8Array => Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
const schema = richTextSchemaAdapter.schema
const paragraph = (value: string): PMNode => schema.nodes.paragraph.create(null, value ? schema.text(value) : undefined)
const document = (value: string): PMNode => schema.nodes.doc.create(null, [paragraph(value)])
export const nativePlainLoroScalarOffset = (value: string, scalarIndex: number): number => Array.from(value).slice(0, scalarIndex).join("").length

const page = (): { doc: LoroDoc; root: LoroMap } => {
  const doc = new LoroDoc()
  doc.setPeerId(NATIVE_PLAIN_LORO_PEER_ID)
  const meta = doc.getMap(LORO_PAGE_META_CONTAINER)
  meta.set("schemaVersion", LORO_PAGE_SCHEMA_VERSION)
  doc.configTextStyle(Object.fromEntries(Object.keys(schema.marks).map((name) => [name, { expand: "after" }])))
  return { doc, root: doc.getMap(LORO_PROSEMIRROR_CONTAINER) }
}

const applyPluginTransaction = (doc: LoroDoc, root: LoroMap, source: PMNode, target: PMNode, edit: (state: EditorState) => Transaction): EditorState => {
  const initialDoc = schema.topNodeType.createAndFill()
  if (!initialDoc) throw new Error("rich-text schema cannot create an empty document")
  const initial = EditorState.create({ schema, doc: initialDoc, plugins: [LoroSyncPlugin({ doc: doc as unknown as LoroDocType, containerId: root.id })] })
  const seeded = initial.doc.eq(source) ? initial : initial.apply(initial.tr.replaceWith(0, initial.doc.content.size, source.content))
  const transaction = edit(seeded)
  if (!transaction.docChanged && !seeded.doc.eq(target)) throw new Error("native plain corpus transaction must be docChanged")
  const applied = seeded.apply(transaction)
  if (!applied.doc.eq(target)) throw new Error("plugin transaction did not produce expected PM state")
  doc.commit()
  return applied
}

const snapshot = (doc: LoroDoc): string => base64(doc.export({ mode: "snapshot" }))
const version = (doc: LoroDoc): string => base64(doc.version().encode())

/** Closed-world structural reader used by the native bridge and corpus tests. */
export const inspectNativePlainLoroV1 = (snapshotBase64: string): NativePlainLoroShape => {
  const doc = new LoroDoc()
  doc.import(bytes(snapshotBase64))
  doc.setHideEmptyRootContainers(false)
  const roots = Object.keys(doc.toJSON()).sort()
  if (roots.join(",") !== `${LORO_PAGE_META_CONTAINER},${LORO_PROSEMIRROR_CONTAINER}`) throw new Error("unexpected Loro root container")
  const meta = doc.getMap(LORO_PAGE_META_CONTAINER)
  if (JSON.stringify(meta.toJSON()) !== JSON.stringify({ schemaVersion: LORO_PAGE_SCHEMA_VERSION })) throw new Error("invalid page metadata")
  const root = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
  if (Object.keys(root.toJSON()).sort().join(",") !== "attributes,children,nodeName") throw new Error("invalid root shape")
  const rootAttrs = root.get("attributes")
  if (!(rootAttrs instanceof LoroMap) || rootAttrs.size !== 1 || rootAttrs.get("isAmgBlock") !== false) throw new Error("invalid root attributes")
  const children = root.get("children")
  if (!(children instanceof LoroList) || children.length !== 1) throw new Error("plain corpus requires one block")
  const block = children.get(0)
  if (!(block instanceof LoroMap) || block.get("nodeName") !== "paragraph") throw new Error("plain corpus requires a paragraph")
  if (Object.keys(block.toJSON()).sort().join(",") !== "attributes,children,nodeName") throw new Error("invalid paragraph shape")
  const attrs = block.get("attributes")
  if (!(attrs instanceof LoroMap) || attrs.size !== 1 || attrs.get("isAmgBlock") !== false) throw new Error("invalid paragraph attributes")
  const content = block.get("children")
  if (!(content instanceof LoroList) || content.length > 1 || (content.length === 1 && !(content.get(0) instanceof LoroText))) throw new Error("plain corpus requires zero or one text container")
  const textValue = content.length === 0 ? "" : (content.get(0) as LoroText).toString()
  if (content.length === 1 && (content.get(0) as LoroText).toDelta().some((part) => part.attributes && Object.keys(part.attributes).length > 0)) throw new Error("marks are not valid in plain corpus")
  return { rootAttributes: { isAmgBlock: false }, blocks: [{ nodeName: "paragraph", attributes: { isAmgBlock: false }, text: textValue }], namedRootContainers: [LORO_PAGE_META_CONTAINER, LORO_PROSEMIRROR_CONTAINER] }
}

const validCase = (id: string, originalText: string, rangeStart: number, rangeLength: number, value: string): NativePlainLoroCase => {
  const scalars = Array.from(originalText)
  const expectedText = scalars.slice(0, rangeStart).join("") + value + scalars.slice(rangeStart + rangeLength).join("")
  const { doc, root } = page()
  const initial = document(originalText)
  const initialState = rangeStart === 0 && rangeLength === 0 && value === ""
    ? (() => {
      const empty = schema.topNodeType.createAndFill()
      if (!empty) throw new Error("rich-text schema cannot create an empty document")
      const state = EditorState.create({ schema, doc: empty, plugins: [LoroSyncPlugin({ doc: doc as unknown as LoroDocType, containerId: root.id })] })
      const insert = state.tr.insertText("_", 1)
      if (!insert.docChanged) throw new Error("empty eligibility probe did not change PM state")
      const inserted = state.apply(insert)
      const remove = inserted.tr.delete(1, 2)
      if (!remove.docChanged || !inserted.apply(remove).doc.eq(empty)) throw new Error("empty eligibility probe did not restore PM state")
      doc.commit()
      return inserted.apply(remove)
    })()
    : applyPluginTransaction(doc, root, schema.topNodeType.createAndFill()!, initial, (state) => state.tr.replaceWith(0, state.doc.content.size, initial.content))
  const baseSnapshot = snapshot(doc)
  const baseVV = version(doc)
  const finalTarget = document(expectedText)
  if (!(rangeStart === 0 && rangeLength === 0 && value === "")) {
    const start = nativePlainLoroScalarOffset(originalText, rangeStart)
    const end = nativePlainLoroScalarOffset(originalText, rangeStart + rangeLength)
    applyPluginTransaction(doc, root, initial, finalTarget, (state) => state.tr.insertText(value, 1 + start, 1 + end))
  }
  const initialShape = inspectNativePlainLoroV1(baseSnapshot)
  const expectedFinalShape = inspectNativePlainLoroV1(snapshot(doc))
  if (expectedFinalShape.blocks[0].text !== expectedText || !initialState.doc.eq(initial)) throw new Error(`invalid generated case ${id}`)
  // Keep the base values in the fixture; final state is deliberately not part of the bridge input.
  return { id, valid: true, initialSnapshotBase64: baseSnapshot, acceptedBaseVVBase64: baseVV, originalText, replacement: { rangeStart, rangeLength, value }, expectedText, initialShape, expectedFinalShape }
}

const negative = (id: string, capability: NativePlainLoroNegative["capability"], mutate: (doc: LoroDoc, root: LoroMap) => void, sourceText = "seed"): NativePlainLoroNegative => {
  const { doc, root } = page()
  const empty = schema.topNodeType.createAndFill()!
  applyPluginTransaction(doc, root, empty, document(sourceText), (state) => state.tr.replaceWith(0, state.doc.content.size, document(sourceText).content))
  mutate(doc, root)
  doc.commit()
  return { id, valid: false, capability, expectedFailure: "closed-world-plain-loro-v1", snapshotBase64: snapshot(doc), probeReplacement: { originalText: sourceText, rangeStart: 0, rangeLength: 0, value: "!" } }
}

const negatives: readonly NativePlainLoroNegative[] = [
  { ...negative("negative-newline-rejected", "rejected-newline", () => {}, "plain"), replacement: { originalText: "plain", rangeStart: 5, rangeLength: 0, value: "line\nbreak" }, probeReplacement: { originalText: "plain", rangeStart: 5, rangeLength: 0, value: "line\nbreak" } },
  negative("negative-missing-is-amg-block", "missing-attribute", (_doc, root) => (root.get("attributes") as LoroMap).delete("isAmgBlock")),
  negative("negative-true-is-amg-block", "true-attribute", (_doc, root) => (root.get("attributes") as LoroMap).set("isAmgBlock", true)),
  negative("negative-extra-attribute", "extra-attribute", (_doc, root) => (root.get("attributes") as LoroMap).set("extra", true)),
  negative("negative-extra-root-property", "extra-container", (_doc, root) => root.set("extra", true)),
  negative("negative-extra-paragraph-property", "extra-attribute", (_doc, root) => ((root.get("children") as LoroList).get(0) as LoroMap).set("extra", true)),
  negative("negative-mark", "mark", (_doc, root) => { const paragraph = (root.get("children") as LoroList).get(0) as LoroMap; const text = paragraph.get("children") as LoroList; (text.get(0) as LoroText).mark({ start: 0, end: 1 }, "strong", true) }),
  negative("negative-extra-block", "extra-block", (_doc, root) => (root.get("children") as LoroList).insertContainer(1, new LoroMap())),
  negative("negative-extra-container", "extra-container", (doc) => doc.getMap("unexpected-root").set("x", true))
]

export const buildNativePlainLoroV1Corpus = (): NativePlainLoroV1Corpus => {
  const empty = validCase("canonical-empty-document", "", 0, 0, "")
  return {
  format: "athenaeum-native-plain-loro-v1-corpus",
  corpusVersion: 1,
  scalarUnit: NATIVE_PLAIN_LORO_SCALAR_UNIT,
  generator: { loroCrdt: "1.14.1", loroProsemirror: "0.4.4", schema: "athenaeum-rich-text-v1", peerId: NATIVE_PLAIN_LORO_PEER_ID },
  cases: [
    validCase("empty-to-text", "", 0, 0, "hello"),
    validCase("text-to-empty", "hello", 0, 5, ""),
    validCase("prefix-replacement", "hello world", 0, 5, "goodbye"),
    validCase("middle-replacement", "hello world", 6, 5, "Loro"),
    validCase("suffix-replacement", "hello world", 6, 5, "there"),
    validCase("ascii", "plain text", 5, 4, "Loro"),
    validCase("emoji-surrogate-boundary", "A🦜B", 1, 1, "X"),
    validCase("combining-sequence", "café", 4, 1, "X")
  ],
  eligibility: { id: "canonical-empty-document", snapshotBase64: empty.initialSnapshotBase64, expectedShape: empty.initialShape },
  negatives
  }
}

export const decodeNativePlainLoroBaseVV = (encoded: string): VersionVector => VersionVector.decode(bytes(encoded))
