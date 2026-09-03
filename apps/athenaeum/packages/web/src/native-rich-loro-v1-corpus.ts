import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt"
import { LoroSyncPlugin, type LoroDocType } from "loro-prosemirror"
import { EditorState } from "prosemirror-state"
import { Fragment, Node as PMNode, type Mark } from "prosemirror-model"
import { LORO_PAGE_META_CONTAINER, LORO_PAGE_SCHEMA_VERSION, LORO_PROSEMIRROR_CONTAINER } from "@athenaeum/domain"
import { richTextSchemaAdapter } from "./rich-text/schema.js"

export const NATIVE_RICH_LORO_PEER_ID = "424242"
export const NATIVE_RICH_LORO_SCALAR_UNIT = "unicode-scalar"

export type NativeRichClassification = "eligible" | "rejected"
export type NativeRichCanonicalDocument = Record<string, unknown>
export type NativeRichCanonicalBlock = Record<string, unknown>
export type NativeRichOperation =
  | { readonly kind: "insert-block"; readonly blockIndex: number; readonly block: NativeRichCanonicalBlock }
  | { readonly kind: "delete-block"; readonly blockIndex: number; readonly block: NativeRichCanonicalBlock }
  | { readonly kind: "replace-block"; readonly blockIndex: number; readonly fromBlock: NativeRichCanonicalBlock; readonly toBlock: NativeRichCanonicalBlock }
  | { readonly kind: "replace-document"; readonly document: NativeRichCanonicalDocument }
  | { readonly kind: "add-mark" | "remove-mark"; readonly blockIndex: number; readonly scalarUnit: typeof NATIVE_RICH_LORO_SCALAR_UNIT; readonly mark: "strong" | "em" | "code"; readonly from: number; readonly to: number; readonly text: string }

/**
 * These fixed v4 values are corpus fixtures, not product ids. They make the cross-client
 * reference contract testable without accepting the old placeholder ids (for example `node-1`)
 * that a strict native decoder must reject.
 */
export const NATIVE_RICH_ENTITY_REFERENCE_ID = "10000000-0000-4000-8000-000000000001"
export const NATIVE_RICH_SUPERTAG_REFERENCE_ID = "10000000-0000-4000-8000-000000000002"

export interface NativeRichLoroCase {
  readonly id: string
  readonly classification: "eligible"
  readonly baseSnapshotBase64: string
  readonly baseSnapshotSHA256?: string
  readonly baseVVSHA256?: string
  readonly baseVVBase64: string
  readonly baseDocument: NativeRichCanonicalDocument
  readonly proposedDocument: NativeRichCanonicalDocument
  readonly expectedDocument: NativeRichCanonicalDocument
  readonly operations: readonly NativeRichOperation[]
}

export interface NativeRichLoroRejection {
  readonly id: string
  readonly classification: "rejected"
  readonly reason:
    | "link"
    | "entity-ref"
    | "supertag-ref"
    | "strike"
    | "list"
    | "task-list"
    | "quote"
    | "code-block"
    | "divider"
    | "unknown-node"
    | "unknown-mark"
    | "unknown-attribute"
    | "malformed-known-shape"
    | "bounds-plus-one"
  readonly probe: Record<string, unknown>
  readonly origin: "official-web-schema-plugin" | "adversarial-wire"
  readonly baseSnapshotBase64?: string
  readonly baseVVBase64?: string
  readonly baseDocument?: NativeRichCanonicalDocument
  readonly proposedDocument?: NativeRichCanonicalDocument
  readonly adversarialSnapshotBase64?: string
  readonly adversarialBaseVVBase64?: string
}

export interface NativeRichLoroV1Corpus {
  readonly format: "athenaeum-native-rich-loro-v1-source-corpus"
  readonly corpusVersion: 1
  readonly scalarUnit: typeof NATIVE_RICH_LORO_SCALAR_UNIT
  readonly generator: { readonly loroCrdt: "1.14.1"; readonly loroProsemirror: "0.4.4"; readonly schema: "athenaeum-rich-text-v1"; readonly peerId: "424242" }
  /** R4 consumes this source artifact and joins native-emitted results separately. */
  readonly sourceContract: "web-base-only-r4-native-result-join"
  readonly sourceDigest?: string
  readonly cases: readonly NativeRichLoroCase[]
  readonly rejections: readonly NativeRichLoroRejection[]
}

export const nativeRichLoroSourceCanonicalContent = (corpus: NativeRichLoroV1Corpus): string => JSON.stringify({
  ...corpus,
  sourceDigest: undefined,
  cases: corpus.cases.map(({ baseSnapshotSHA256: _snapshot, baseVVSHA256: _vv, ...fixture }) => fixture)
})

const schema = richTextSchemaAdapter.schema
const document = (...children: readonly PMNode[]): PMNode => schema.nodes.doc.create(null, children)
const paragraph = (...children: readonly PMNode[]): PMNode => schema.nodes.paragraph.create(null, children)
const heading = (level: 1 | 2 | 3, ...children: readonly PMNode[]): PMNode => schema.nodes.heading.create({ level }, children)
const text = (value: string, marks: readonly Mark[] = []): PMNode => schema.text(value, marks)
const mark = (name: "strong" | "em" | "code"): Mark => schema.marks[name].create()
const json = (node: PMNode): Record<string, unknown> => node.toJSON() as Record<string, unknown>
const blockAt = (node: PMNode, index: number): PMNode => {
  const block = node.child(index)
  if (block === undefined) throw new Error(`missing block ${index}`)
  return block
}
const scalarOffset = (value: string, scalarIndex: number): number => Array.from(value).slice(0, scalarIndex).join("").length
const maxInlineRunsPerBlock = (node: PMNode): number => {
  let maximum = 0
  node.descendants((child) => { if (child.isTextblock) maximum = Math.max(maximum, child.childCount); return true })
  return maximum
}

const base64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const bytes = (encoded: string): Uint8Array => Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))

const newPage = (): { readonly doc: LoroDoc; readonly root: LoroMap } => {
  const doc = new LoroDoc()
  doc.setPeerId(NATIVE_RICH_LORO_PEER_ID)
  doc.getMap(LORO_PAGE_META_CONTAINER).set("schemaVersion", LORO_PAGE_SCHEMA_VERSION)
  const root = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
  // Formatting marks expand after adjacent typing; reference marks use the Web schema's
  // `inclusive: false` contract and therefore materialize with `expand: "none"`.
  doc.configTextStyle(Object.fromEntries(Object.entries(schema.marks).map(([name, type]) => [name, { expand: name === "strong" || name === "em" || name === "code" ? "after" : (type.spec.inclusive === false ? "none" : "after") }])))
  return { doc, root }
}

const snapshot = (doc: LoroDoc): string => {
  doc.commit()
  return base64(doc.export({ mode: "snapshot" }))
}
const version = (doc: LoroDoc): string => base64(doc.version().encode())

/** Seed a source state through the official plugin; this is never hand-written CRDT data. */
const sourceState = (base: PMNode): { readonly doc: LoroDoc; readonly root: LoroMap; readonly state: EditorState } => {
  const { doc, root } = newPage()
  const empty = schema.topNodeType.createAndFill()
  if (!empty) throw new Error("rich-text schema cannot create an empty document")
  const state = EditorState.create({ schema, doc: empty, plugins: [LoroSyncPlugin({ doc: doc as unknown as LoroDocType, containerId: root.id })] })
  const transaction = state.tr.replaceWith(0, state.doc.content.size, base.content)
  const applied = transaction.docChanged
    ? state.apply(transaction)
    : (() => {
      const probe = state.tr.insertText("_", 1)
      const inserted = state.apply(probe)
      const remove = inserted.tr.delete(1, 2)
      const restored = inserted.apply(remove)
      if (!restored.doc.eq(empty)) throw new Error("official plugin empty-base initialization did not restore")
      return restored
    })()
  if (!applied.doc.eq(base)) throw new Error("official plugin did not produce the canonical base document")
  return { doc, root, state: applied }
}

const eligible = (id: string, base: PMNode, proposed: PMNode, operations: readonly NativeRichOperation[]): NativeRichLoroCase => {
  const { doc } = sourceState(base)
  const baseSnapshotBase64 = snapshot(doc)
  const baseVVBase64 = version(doc)
  assertOfficialTransition(base, proposed)
  const { state } = sourceState(base)
  const transaction = state.tr.replaceWith(0, state.doc.content.size, proposed.content)
  const proposedState = transaction.docChanged ? state.apply(transaction) : state
  if (!proposedState.doc.eq(proposed)) throw new Error(`official plugin did not produce proposed document for ${id}`)
  return {
    id,
    classification: "eligible",
    baseSnapshotBase64,
    baseVVBase64,
    baseDocument: json(base),
    proposedDocument: json(proposed),
    expectedDocument: json(proposed),
    operations
  }
}

const assertOfficialTransition = (base: PMNode, proposed: PMNode): void => {
  const { state } = sourceState(base)
  const transaction = state.tr.replaceWith(0, state.doc.content.size, proposed.content)
  const applied = transaction.docChanged ? state.apply(transaction) : state
  if (!applied.doc.eq(proposed)) throw new Error("official plugin transition did not produce proposed document")
}

/** Replay the canonical operation ABI without touching Loro; R1/native can implement the same contract. */
export const replayNativeRichLoroOperations = (baseDocument: NativeRichCanonicalDocument, operations: readonly NativeRichOperation[]): NativeRichCanonicalDocument => {
  let current = PMNode.fromJSON(schema, baseDocument)
  if (current.type !== schema.nodes.doc || current.childCount === 0) throw new Error("canonical base must be a non-empty document")
  for (const operation of operations) {
    if (operation.kind === "replace-document") {
      current = PMNode.fromJSON(schema, operation.document)
      if (current.type !== schema.nodes.doc || current.childCount === 0) throw new Error("canonical replacement must be a non-empty document")
      continue
    }
    if (operation.kind === "insert-block" || operation.kind === "delete-block" || operation.kind === "replace-block") {
      const blocks = Array.from({ length: current.childCount }, (_, index) => current.child(index))
      if (!Number.isSafeInteger(operation.blockIndex) || operation.blockIndex < 0 || (operation.kind === "insert-block" ? operation.blockIndex > blocks.length : operation.blockIndex >= blocks.length)) throw new Error("block index is out of bounds")
      const parseBlock = (value: NativeRichCanonicalBlock): PMNode => {
        const parsed = PMNode.fromJSON(schema, value)
        if (!parsed.type.spec.group?.split(" ").includes("block")) throw new Error("canonical block payload is not a block")
        return parsed
      }
      if (operation.kind === "insert-block") blocks.splice(operation.blockIndex, 0, parseBlock(operation.block))
      if (operation.kind === "delete-block") {
        if (blocks.length === 1 || !blocks[operation.blockIndex]?.eq(parseBlock(operation.block))) throw new Error("delete-block payload does not match base")
        blocks.splice(operation.blockIndex, 1)
      }
      if (operation.kind === "replace-block") {
        if (!blocks[operation.blockIndex]?.eq(parseBlock(operation.fromBlock))) throw new Error("replace-block source payload does not match base")
        blocks.splice(operation.blockIndex, 1, parseBlock(operation.toBlock))
      }
      current = schema.nodes.doc.create(current.attrs, Fragment.fromArray(blocks))
      continue
    }
    if (!Number.isSafeInteger(operation.blockIndex) || operation.blockIndex < 0 || operation.blockIndex >= current.childCount) throw new Error("block index is out of bounds")
    const block = blockAt(current, operation.blockIndex)
    if (operation.scalarUnit !== NATIVE_RICH_LORO_SCALAR_UNIT || !Number.isSafeInteger(operation.from) || !Number.isSafeInteger(operation.to) || operation.from < 0 || operation.to < operation.from || operation.to > Array.from(block.textContent).length || block.textContent !== operation.text) throw new Error(`${operation.kind} range payload is invalid`)
    const preceding = Array.from({ length: operation.blockIndex }, (_, index) => current.child(index)).reduce((position, child) => position + child.nodeSize, 0)
    const from = 1 + preceding + scalarOffset(block.textContent, operation.from)
    const to = 1 + preceding + scalarOffset(block.textContent, operation.to)
    const state = EditorState.create({ schema, doc: current })
    const transaction = operation.kind === "add-mark"
      ? state.tr.addMark(from, to, mark(operation.mark))
      : state.tr.removeMark(from, to, schema.marks[operation.mark])
    current = state.apply(transaction).doc
  }
  return json(current)
}

const rejectedOfficial = (id: string, reason: NativeRichLoroRejection["reason"], base: PMNode, proposed: PMNode, probe: Record<string, unknown> = {}): NativeRichLoroRejection => {
  const { doc } = sourceState(base)
  assertOfficialTransition(base, proposed)
  return { id, classification: "rejected", reason, origin: "official-web-schema-plugin", probe, baseSnapshotBase64: snapshot(doc), baseVVBase64: version(doc), baseDocument: json(base), proposedDocument: json(proposed) }
}

const rejectedWire = (
  id: string,
  reason: NativeRichLoroRejection["reason"],
  mutate: (doc: LoroDoc, root: LoroMap) => void,
  probe: Record<string, unknown> = {}
): NativeRichLoroRejection => {
  const base = sourceState(document(paragraph(text("seed"))))
  const baseSnapshot = snapshot(base.doc)
  const baseVV = version(base.doc)
  mutate(base.doc, base.root)
  return { id, classification: "rejected", reason, origin: "adversarial-wire", probe, baseSnapshotBase64: baseSnapshot, baseVVBase64: baseVV, adversarialSnapshotBase64: snapshot(base.doc), adversarialBaseVVBase64: baseVV }
}

/**
 * Deliberately inject a raw mark value after an official base state exists. These are not
 * ProseMirror outputs: they are adversarial fixtures that pin the native decoder's closed-world
 * map-valued Loro contract for the two reference marks. The legacy Automerge mapping names
 * (`entity-ref` and `supertag-ref`) are deliberately not part of this Loro corpus.
 */
const rejectedReferenceWire = (
  id: string,
  reason: "entity-ref" | "supertag-ref",
  payload: unknown
): NativeRichLoroRejection => {
  const markName = reason === "entity-ref" ? "entityRef" : "supertagRef"
  return rejectedWire(
    id,
    reason,
    (doc, root) => {
      const block = (root.get("children") as LoroList).get(0) as LoroMap
      const children = block.get("children") as LoroList
      const content = children.get(0) as LoroText
      doc.configTextStyle({ [markName]: { expand: "none" } })
      content.mark({ start: 0, end: 4 }, markName, payload)
    },
    { markName, payload }
  )
}

export const buildNativeRichLoroV1Corpus = (): NativeRichLoroV1Corpus => {
  const strong = mark("strong")
  const em = mark("em")
  const code = mark("code")
  const entityRef = schema.marks.entityRef.create({ nodeId: NATIVE_RICH_ENTITY_REFERENCE_ID, label: "Alice" })
  const supertagRef = schema.marks.supertagRef.create({ tagId: NATIVE_RICH_SUPERTAG_REFERENCE_ID, label: "Project" })
  const empty = document(paragraph())
  const one = document(paragraph(text("one")))
  const two = document(paragraph(text("two")))
  const styled = document(paragraph(text("styled")))
  const marked = document(paragraph(text("styled", [strong, em, code])))
  const adjacent = document(paragraph(text("A", [strong]), text("B", [strong]), text("C")))
  const adjacentExpected = document(paragraph(text("ABC", [strong])))
  const block = (node: PMNode, index: number): NativeRichCanonicalBlock => json(node.child(index))
  const full = (node: PMNode): NativeRichCanonicalDocument => json(node)
  const markOp = (kind: "add-mark" | "remove-mark", markName: "strong" | "em" | "code", value: string, from: number, to: number): NativeRichOperation => ({ kind, blockIndex: 0, scalarUnit: NATIVE_RICH_LORO_SCALAR_UNIT, mark: markName, from, to, text: value })
  const cases: NativeRichLoroCase[] = [
    eligible("empty-page", empty, document(paragraph(text("Hello"))), [{ kind: "replace-document", document: full(document(paragraph(text("Hello")))) }]),
    eligible("paragraph-insertion", empty, document(paragraph(), paragraph(text("inserted"))), [{ kind: "insert-block", blockIndex: 1, block: block(document(paragraph(), paragraph(text("inserted"))), 1) }]),
    eligible("paragraph-deletion", document(paragraph(text("keep")), paragraph(text("remove"))), document(paragraph(text("keep"))), [{ kind: "delete-block", blockIndex: 1, block: block(document(paragraph(text("keep")), paragraph(text("remove"))), 1) }]),
    eligible("paragraph-replacement", one, two, [{ kind: "replace-block", blockIndex: 0, fromBlock: block(one, 0), toBlock: block(two, 0) }]),
    eligible("heading-1-to-2", document(heading(1, text("Title"))), document(heading(2, text("Title"))), [{ kind: "replace-block", blockIndex: 0, fromBlock: block(document(heading(1, text("Title"))), 0), toBlock: block(document(heading(2, text("Title"))), 0) }]),
    eligible("heading-2-to-3", document(heading(2, text("Title"))), document(heading(3, text("Title"))), [{ kind: "replace-block", blockIndex: 0, fromBlock: block(document(heading(2, text("Title"))), 0), toBlock: block(document(heading(3, text("Title"))), 0) }]),
    eligible("heading-3-to-paragraph", document(heading(3, text("Title"))), one, [{ kind: "replace-block", blockIndex: 0, fromBlock: block(document(heading(3, text("Title"))), 0), toBlock: block(one, 0) }]),
    eligible("multi-block-insert-delete", document(paragraph(text("first")), paragraph(text("old")), paragraph(text("last"))), document(paragraph(text("first")), heading(2, text("middle")), paragraph(text("last"))), [{ kind: "delete-block", blockIndex: 1, block: block(document(paragraph(text("first")), paragraph(text("old")), paragraph(text("last"))), 1) }, { kind: "insert-block", blockIndex: 1, block: block(document(paragraph(text("first")), heading(2, text("middle")), paragraph(text("last"))), 1) }]),
    eligible("strong-em-code-add", styled, marked, [markOp("add-mark", "strong", "styled", 0, 6), markOp("add-mark", "em", "styled", 0, 6), markOp("add-mark", "code", "styled", 0, 6)]),
    eligible("strong-em-code-remove", marked, styled, [markOp("remove-mark", "strong", "styled", 0, 6), markOp("remove-mark", "em", "styled", 0, 6), markOp("remove-mark", "code", "styled", 0, 6)]),
    eligible("strong-adjacency", adjacent, adjacentExpected, [markOp("add-mark", "strong", "ABC", 0, 3)]),
    eligible("emoji-combining-mark-range", document(paragraph(text("prefix")), paragraph(text("A🦜café"))), document(paragraph(text("prefix")), paragraph(text("A"), text("🦜café", [strong]))), [{ kind: "add-mark", blockIndex: 1, scalarUnit: NATIVE_RICH_LORO_SCALAR_UNIT, mark: "strong", from: 1, to: 7, text: "A🦜café" }]),
    eligible("empty-terminal-paragraph", document(paragraph(text("body"))), document(paragraph(text("body")), paragraph()), [{ kind: "insert-block", blockIndex: 1, block: block(document(paragraph(text("body")), paragraph()), 1) }]),
    eligible("emoji-and-combining", document(paragraph(text("A🦜café"))), document(paragraph(text("A🦜café"))), [{ kind: "replace-document", document: full(document(paragraph(text("A🦜café")))) }]),
    eligible("whole-document-replacement", document(heading(1, text("Old")), paragraph(text("content"))), document(heading(3, text("New")), paragraph(text("replacement")), paragraph()), [{ kind: "replace-document", document: full(document(heading(3, text("New")), paragraph(text("replacement")), paragraph())) }]),
    // Reference marks are official Web-plugin output. Each case changes only prose around the
    // reference while preserving its immutable id, snapshot label, non-expanding mark, and a
    // formatting mark that coexists on the same run.
    eligible(
      "entity-reference-surrounding-edit",
      document(paragraph(text("Met "), text("Alice", [strong, entityRef]), text(" today"))),
      document(paragraph(text("Met with "), text("Alice", [strong, entityRef]), text(" today."))),
      [{ kind: "replace-document", document: full(document(paragraph(text("Met with "), text("Alice", [strong, entityRef]), text(" today.")))) }]
    ),
    eligible(
      "supertag-reference-surrounding-edit",
      document(paragraph(text("Review "), text("Project", [em, supertagRef]), text(" scope"))),
      document(paragraph(text("Review the "), text("Project", [em, supertagRef]), text(" scope today."))),
      [{ kind: "replace-document", document: full(document(paragraph(text("Review the "), text("Project", [em, supertagRef]), text(" scope today.")))) }]
    )
  ]
  const link = document(paragraph(text("link", [schema.marks.link.create({ href: "https://example.com", title: null })])))
  const strike = document(paragraph(text("strike", [schema.marks.strike.create()])))
  const rejections: NativeRichLoroRejection[] = [
    rejectedOfficial("reject-link", "link", empty, link),
    rejectedOfficial("reject-strike", "strike", empty, strike),
    rejectedOfficial("reject-list", "list", empty, document(schema.nodes.bullet_list.create(null, [schema.nodes.list_item.create(null, [paragraph(text("item"))])]))),
    rejectedOfficial("reject-task-list", "task-list", empty, document(schema.nodes.task_list.create(null, [schema.nodes.task_item.create({ checked: false }, [paragraph(text("task"))])]))),
    rejectedOfficial("reject-quote", "quote", empty, document(schema.nodes.blockquote.create(null, [paragraph(text("quote"))]))),
    rejectedOfficial("reject-code-block", "code-block", empty, document(schema.nodes.code_block.create(null, schema.text("code")))),
    rejectedOfficial("reject-divider", "divider", empty, document(schema.nodes.horizontal_rule.create())),
    rejectedWire("reject-unknown-node", "unknown-node", (_doc, root) => { const children = root.get("children") as LoroList; const node = children.insertContainer(0, new LoroMap()).getAttached() as LoroMap; node.set("nodeName", "future-block"); node.getOrCreateContainer("children", new LoroList()) }),
    rejectedWire("reject-unknown-mark", "unknown-mark", (doc, root) => { doc.configTextStyle({ "future-mark": { expand: "after" } }); const block = (root.get("children") as LoroList).get(0) as LoroMap; const children = block.get("children") as LoroList; (children.get(0) as LoroText).mark({ start: 0, end: 1 }, "future-mark", true) }),
    rejectedWire("reject-unknown-attribute", "unknown-attribute", (_doc, root) => { const block = (root.get("children") as LoroList).get(0) as LoroMap; (block.get("attributes") as LoroMap).set("future", true) }),
    rejectedWire("reject-malformed-known-shape", "malformed-known-shape", (_doc, root) => { const block = (root.get("children") as LoroList).get(0) as LoroMap; block.set("nodeName", "heading"); (block.get("attributes") as LoroMap).set("level", 4) }),
    rejectedReferenceWire("reject-entity-reference-malformed-payload", "entity-ref", "not-a-reference-map"),
    rejectedReferenceWire("reject-entity-reference-wrong-payload", "entity-ref", { tagId: NATIVE_RICH_SUPERTAG_REFERENCE_ID, label: "Alice" }),
    rejectedReferenceWire("reject-entity-reference-extra-payload", "entity-ref", { nodeId: NATIVE_RICH_ENTITY_REFERENCE_ID, label: "Alice", extra: true }),
    rejectedReferenceWire("reject-supertag-reference-malformed-payload", "supertag-ref", "not-a-reference-map"),
    rejectedReferenceWire("reject-supertag-reference-wrong-payload", "supertag-ref", { nodeId: NATIVE_RICH_ENTITY_REFERENCE_ID, label: "Project" }),
    rejectedReferenceWire("reject-supertag-reference-extra-payload", "supertag-ref", { tagId: NATIVE_RICH_SUPERTAG_REFERENCE_ID, label: "Project", extra: true }),
    rejectedOfficial("reject-bounds-plus-one", "bounds-plus-one", one, document(paragraph(text("A"), text("B", [strong]), text("C", [em]), text("D", [code]))), { dimension: "maxInlineRunsPerBlock", bound: 3 })
  ]
  return {
    format: "athenaeum-native-rich-loro-v1-source-corpus",
    corpusVersion: 1,
    scalarUnit: NATIVE_RICH_LORO_SCALAR_UNIT,
    generator: { loroCrdt: "1.14.1", loroProsemirror: "0.4.4", schema: "athenaeum-rich-text-v1", peerId: NATIVE_RICH_LORO_PEER_ID },
    sourceContract: "web-base-only-r4-native-result-join",
    cases,
    rejections
  }
}

export const decodeNativeRichLoroBaseVV = (encoded: string) => {
  // Kept as a small source-side utility for R4's native result join.
  return bytes(encoded)
}

/** Closed-world source validator used by tests to ensure rejection entries are real inputs. */
export const inspectNativeRichLoroRejection = (entry: NativeRichLoroRejection): boolean => {
  if (entry.origin === "official-web-schema-plugin") {
    if (!entry.baseSnapshotBase64 || !entry.baseVVBase64 || !entry.baseDocument || !entry.proposedDocument) throw new Error(`${entry.id} lacks an official source state`)
    const base = PMNode.fromJSON(schema, entry.baseDocument)
    const proposed = PMNode.fromJSON(schema, entry.proposedDocument)
    if (base.type !== schema.nodes.doc || base.content.size === 0) throw new Error(`${entry.id} base is not admissible`)
    const nodes: PMNode[] = []
    proposed.descendants((node) => { nodes.push(node); return true })
    const hasMark = (name: string): boolean => nodes.some((node) => node.marks.some((candidate) => candidate.type.name === name))
    const hasNode = (name: string): boolean => nodes.some((node) => node.type.name === name)
    if (entry.reason === "link" && !hasMark("link")) return false
    if (entry.reason === "entity-ref" && !hasMark("entityRef")) return false
    if (entry.reason === "supertag-ref" && !hasMark("supertagRef")) return false
    if (entry.reason === "strike" && !hasMark("strike")) return false
    if (entry.reason === "list" && !hasNode("bullet_list") && !hasNode("ordered_list")) return false
    if (entry.reason === "task-list" && !hasNode("task_list")) return false
    if (entry.reason === "quote" && !hasNode("blockquote")) return false
    if (entry.reason === "code-block" && !hasNode("code_block")) return false
    if (entry.reason === "divider" && !hasNode("horizontal_rule")) return false
    if (entry.reason === "bounds-plus-one") {
      const bound = entry.probe.bound
      if (entry.probe.dimension !== "maxInlineRunsPerBlock" || typeof bound !== "number" || maxInlineRunsPerBlock(proposed) !== bound + 1) return false
    }
    const doc = new LoroDoc()
    doc.import(bytes(entry.baseSnapshotBase64))
    if (doc.getMap(LORO_PROSEMIRROR_CONTAINER).get("nodeName") !== "doc") return false
    return true
  }
  if (!entry.adversarialSnapshotBase64 || !entry.adversarialBaseVVBase64) throw new Error(`${entry.id} lacks adversarial wire data`)
  const doc = new LoroDoc()
  doc.import(bytes(entry.adversarialSnapshotBase64))
  const root = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
  const children = root.get("children")
  const block = children instanceof LoroList ? children.get(0) : undefined
  const nestedUnknown = children instanceof LoroList && Array.from({ length: children.length }, (_, index) => children.get(index)).some((value) => value instanceof LoroMap && value.get("nodeName") === "future-block")
  const text = block instanceof LoroMap && block.get("children") instanceof LoroList ? block.get("children")!.get(0) : undefined
  const unknownMark = text instanceof LoroText && text.toDelta().some((part) => part.attributes && Object.prototype.hasOwnProperty.call(part.attributes, "future-mark"))
  const referenceMarkName = entry.probe.markName
  const referencePayload = text instanceof LoroText && typeof referenceMarkName === "string" && entry.probe.payload !== undefined
    ? text.toDelta().some((part) => JSON.stringify(part.attributes?.[referenceMarkName]) === JSON.stringify(entry.probe.payload))
    : false
  const attrs = block instanceof LoroMap ? block.get("attributes") : undefined
  const unknownAttribute = attrs instanceof LoroMap && attrs.get("future") === true
  const malformed = block instanceof LoroMap && block.get("nodeName") === "heading" && attrs instanceof LoroMap && attrs.get("level") === 4 && block.get("children") instanceof LoroList
  return entry.adversarialSnapshotBase64 !== entry.baseSnapshotBase64 && (
    entry.reason === "unknown-node" ? nestedUnknown
      : entry.reason === "unknown-mark" ? unknownMark
        : entry.reason === "unknown-attribute" ? unknownAttribute
          : entry.reason === "malformed-known-shape" ? malformed
            : entry.reason === "entity-ref" || entry.reason === "supertag-ref" ? referencePayload
              : false
  )
}
