// `loro-prosemirror` imports the package root.  Its containers must be created by the
// same module instance: mixing this with `loro-crdt/bundler` is observable under Bun's
// WASM loader and faults when the plugin attaches its child containers.
import { LoroDoc, LoroList, LoroMap } from "loro-crdt"
import { LoroSyncPlugin, type LoroDocType } from "loro-prosemirror"
import { EditorState } from "prosemirror-state"
import type { Mark, Node as PMNode } from "prosemirror-model"
import {
  LORO_PAGE_META_CONTAINER,
  LORO_PAGE_SCHEMA_VERSION,
  LORO_PROSEMIRROR_CONTAINER
} from "@athenaeum/domain"
import { richTextSchemaAdapter } from "./rich-text/schema.js"

/**
 * Source of truth for the checked-in native Loro compatibility corpus.
 *
 * Positive fixtures deliberately pass through the same `richTextSchemaAdapter` and official
 * `loro-prosemirror` sync plugin used by the web editor. The deterministic peer id makes the exported
 * snapshots reproducible; the checked-in JSON is generated from this module, not hand-authored
 * container data. Negative fixtures are intentionally adversarial wire data and are not claimed
 * to be web-editor output.
 */
/** Only these sanitized mark semantics may cross the native projection boundary. */
export type LoroProjectionMarkExpectation = "strong" | "emphasis" | "code" | "link" | "unsupported"

export interface LoroProjectionExpectation {
  readonly kind: "document" | "paragraph" | "heading" | "text"
  readonly text?: string
  readonly level?: number
  readonly marks?: readonly LoroProjectionMarkExpectation[]
  readonly children?: readonly LoroProjectionExpectation[]
}

export interface LoroCompatibilityCorpusFixture {
  readonly id: string
  readonly origin: "official-web-schema-plugin" | "adversarial-wire"
  readonly valid: boolean
  readonly snapshotBase64: string
  readonly expectedProjection?: LoroProjectionExpectation
  readonly expectedFailure?: "malformed-known-content"
}

export interface LoroCompatibilityCorpus {
  readonly format: "athenaeum-loro-prosemirror-v1-corpus"
  readonly corpusVersion: 1
  readonly generator: {
    readonly loroCrdt: "1.14.1"
    readonly loroProsemirror: "0.4.4"
    readonly schema: "athenaeum-rich-text-v1"
  }
  readonly fixtures: readonly LoroCompatibilityCorpusFixture[]
}

const PEER_ID = "424242"

const base64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const newPage = (): { readonly doc: LoroDoc; readonly root: LoroMap } => {
  const doc = new LoroDoc()
  doc.setPeerId(PEER_ID)
  const metadata = doc.getMap(LORO_PAGE_META_CONTAINER)
  metadata.set("schemaVersion", LORO_PAGE_SCHEMA_VERSION)
  // Do not pre-populate the root: LoroSyncPlugin performs the initial commit before
  // installing `nodeName`, attributes, and children itself.
  const root = doc.getMap(LORO_PROSEMIRROR_CONTAINER)
  return { doc, root }
}

const snapshotOf = (doc: LoroDoc): string => {
  doc.commit()
  return base64(doc.export({ mode: "snapshot" }))
}

const mark = (name: string, attrs?: Record<string, unknown>): Mark => {
  const type = richTextSchemaAdapter.schema.marks[name]
  if (type === undefined) throw new Error(`missing corpus mark ${name}`)
  return type.create(attrs)
}

const text = (value: string, marks: readonly Mark[] = []): PMNode =>
  richTextSchemaAdapter.schema.text(value, marks)

const paragraph = (...children: readonly PMNode[]): PMNode =>
  richTextSchemaAdapter.schema.nodes.paragraph.create(null, children)

const heading = (level: number, ...children: readonly PMNode[]): PMNode =>
  richTextSchemaAdapter.schema.nodes.heading.create({ level }, children)

const configureTextStyles = (doc: LoroDoc): void => {
  doc.configTextStyle(
    Object.fromEntries(
      Object.entries(richTextSchemaAdapter.schema.marks).map(([name, type]) => [
        name,
        { expand: type.spec.inclusive === false ? "none" : "after" }
      ])
    )
  )
}

/**
 * Apply a document by creating and dispatching through the same official LoroSyncPlugin
 * configuration as LoroRichNoteEditor. This is deliberately not a direct writer call:
 * the plugin's `appendTransaction` performs the PM-to-Loro update.
 */
export const applyDocumentThroughLoroSyncPlugin = (
  doc: LoroDoc,
  root: LoroMap,
  document: PMNode
): EditorState => {
  const initialDoc = richTextSchemaAdapter.schema.topNodeType.createAndFill()
  if (initialDoc === null) throw new Error("Rich-text schema cannot create an empty document")
  const initialState = EditorState.create({
    schema: richTextSchemaAdapter.schema,
    doc: initialDoc,
    plugins: [LoroSyncPlugin({ doc: doc as unknown as LoroDocType, containerId: root.id })]
  })
  const transaction = initialState.tr.replaceWith(0, initialState.doc.content.size, document.content)
  if (!transaction.docChanged) throw new Error("corpus plugin transaction did not change the document")
  return initialState.apply(transaction)
}

const officialFixture = (
  id: string,
  document: PMNode,
  expectedProjection: LoroProjectionExpectation
): LoroCompatibilityCorpusFixture => {
  const { doc, root } = newPage()
  configureTextStyles(doc)
  applyDocumentThroughLoroSyncPlugin(doc, root, document)
  return {
    id,
    origin: "official-web-schema-plugin",
    valid: true,
    snapshotBase64: snapshotOf(doc),
    expectedProjection
  }
}

const initializedPage = (): { readonly doc: LoroDoc; readonly root: LoroMap } => {
  const { doc, root } = newPage()
  configureTextStyles(doc)
  applyDocumentThroughLoroSyncPlugin(
    doc,
    root,
    richTextSchemaAdapter.schema.nodes.doc.create(null, [richTextSchemaAdapter.schema.nodes.paragraph.create()])
  )
  return { doc, root }
}

const malformedHeadingFixture = (): LoroCompatibilityCorpusFixture => {
  const { doc, root } = initializedPage()
  const children = root.get("children")
  if (!(children instanceof LoroList)) throw new Error("corpus root children were not a list")
  const heading = children.insertContainer(0, new LoroMap()).getAttached()
  if (!(heading instanceof LoroMap)) throw new Error("corpus heading was not a map")
  heading.set("nodeName", "heading")
  const attributes = heading.getOrCreateContainer("attributes", new LoroMap())
  if (!(attributes instanceof LoroMap)) throw new Error("corpus heading attributes were not a map")
  attributes.set("level", 4)
  heading.getOrCreateContainer("children", new LoroList())
  return {
    id: "negative-heading-level-out-of-range",
    origin: "adversarial-wire",
    valid: false,
    snapshotBase64: snapshotOf(doc),
    expectedFailure: "malformed-known-content"
  }
}

const malformedKnownAttributeFixture = (): LoroCompatibilityCorpusFixture => {
  const { doc, root } = initializedPage()
  const children = root.get("children")
  if (!(children instanceof LoroList)) throw new Error("corpus root children were not a list")
  const paragraph = children.get(0)
  if (!(paragraph instanceof LoroMap)) throw new Error("corpus paragraph was not a map")
  const attributes = paragraph.get("attributes")
  if (!(attributes instanceof LoroMap)) throw new Error("corpus paragraph attributes were not a map")
  attributes.set("forbidden", true)
  return { id: "negative-known-node-forbidden-attribute", origin: "adversarial-wire", valid: false, snapshotBase64: snapshotOf(doc), expectedFailure: "malformed-known-content" }
}

const malformedInlineBlockFixture = (): LoroCompatibilityCorpusFixture => {
  const { doc, root } = initializedPage()
  const children = root.get("children")
  if (!(children instanceof LoroList)) throw new Error("corpus root children were not a list")
  const paragraph = children.get(0)
  if (!(paragraph instanceof LoroMap)) throw new Error("corpus paragraph was not a map")
  const inline = paragraph.get("children")
  if (!(inline instanceof LoroList)) throw new Error("corpus paragraph children were not a list")
  const block = inline.insertContainer(0, new LoroMap()).getAttached()
  if (!(block instanceof LoroMap)) throw new Error("corpus inline block was not a map")
  block.set("nodeName", "paragraph")
  block.getOrCreateContainer("attributes", new LoroMap())
  block.getOrCreateContainer("children", new LoroList())
  return { id: "negative-paragraph-contains-block", origin: "adversarial-wire", valid: false, snapshotBase64: snapshotOf(doc), expectedFailure: "malformed-known-content" }
}

const malformedNodeFixture = (): LoroCompatibilityCorpusFixture => {
  const { doc, root } = initializedPage()
  const children = root.get("children")
  if (!(children instanceof LoroList)) throw new Error("corpus root children were not a list")
  const node = children.insertContainer(0, new LoroMap()).getAttached()
  if (!(node instanceof LoroMap)) throw new Error("corpus node was not a map")
  node.set("nodeName", "paragraph")
  node.getOrCreateContainer("attributes", new LoroMap())
  // Deliberately omit `children`: this is a malformed known node, not a forward-compatible node.
  return {
    id: "negative-known-node-missing-children",
    origin: "adversarial-wire",
    valid: false,
    snapshotBase64: snapshotOf(doc),
    expectedFailure: "malformed-known-content"
  }
}

export const buildLoroProseMirrorV1Corpus = (): LoroCompatibilityCorpus => {
  const schema = richTextSchemaAdapter.schema
  const document = (...children: readonly PMNode[]): PMNode => schema.nodes.doc.create(null, children)
  return {
    format: "athenaeum-loro-prosemirror-v1-corpus",
    corpusVersion: 1,
    generator: {
      loroCrdt: "1.14.1",
      loroProsemirror: "0.4.4",
      schema: "athenaeum-rich-text-v1"
    },
    fixtures: [
      officialFixture(
        "official-empty-paragraph",
        document(paragraph()),
        { kind: "document", children: [{ kind: "paragraph", children: [] }] }
      ),
      officialFixture(
        "official-heading-and-paragraph",
        document(heading(2, text("Native Loro")), paragraph(text("A projected paragraph."))),
        {
          kind: "document",
          children: [
            { kind: "heading", level: 2, children: [{ kind: "text", text: "Native Loro", marks: [] }] },
            { kind: "paragraph", children: [{ kind: "text", text: "A projected paragraph.", marks: [] }] }
          ]
        }
      ),
      officialFixture(
        "official-inline-marks",
        document(paragraph(
          text("strong", [mark("strong")]),
          text(" em", [mark("em")]),
          text(" code", [mark("code")]),
          text(" link", [mark("link", { href: "https://example.com", title: "Example" })]),
          text(" entity", [mark("entityRef", { nodeId: "node-1", label: "Entity" })]),
          text(" tag", [mark("supertagRef", { tagId: "tag-1", label: "Tag" })]),
          text(" strike", [mark("strike")])
        )),
        {
          kind: "document",
          children: [{
            kind: "paragraph",
            children: [
              { kind: "text", text: "strong", marks: ["strong"] },
              { kind: "text", text: " em", marks: ["emphasis"] },
              { kind: "text", text: " code", marks: ["code"] },
              { kind: "text", text: " link", marks: ["link"] },
              { kind: "text", text: " entity", marks: ["unsupported"] },
              { kind: "text", text: " tag", marks: ["unsupported"] },
              { kind: "text", text: " strike", marks: ["unsupported"] }
            ]
          }]
        }
      ),
      malformedHeadingFixture(),
      malformedNodeFixture(),
      malformedKnownAttributeFixture(),
      malformedInlineBlockFixture()
    ]
  }
}
