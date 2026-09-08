import * as Automerge from "@automerge/automerge"
import { LoroDoc } from "loro-crdt/bundler"
import { updateLoroToPmState, type LoroDocType } from "loro-prosemirror"
import { EditorState } from "prosemirror-state"
import type { Node as PMNode } from "prosemirror-model"
import type { PageDoc } from "../automerge-page.js"
import {
  createLoroPage,
  inspectLoroPage,
  type LoroPageDocument
} from "../loro-page.js"
import { pmDocFromSpans } from "../vendor/automerge-prosemirror/traversal.js"
import {
  RICH_TEXT_PATH,
  richTextSchemaAdapter
} from "./schema.js"

const emptyRichTextDocument = (): PMNode => {
  const doc = richTextSchemaAdapter.schema.topNodeType.createAndFill()
  if (doc === null) throw new Error("Rich-text schema cannot create an empty document")
  return doc
}

/** Derive the existing PM document from the Automerge rich-text spans. */
export const pmDocumentFromAutomergePage = (doc: Automerge.Doc<PageDoc>): PMNode => {
  const spans = Automerge.spans(doc, RICH_TEXT_PATH)
  return spans.length === 0 ? emptyRichTextDocument() : pmDocFromSpans(richTextSchemaAdapter, spans)
}

/**
 * Convert an Automerge page into the named-root structure consumed by the official
 * loro-prosemirror plugin. The plugin performs the PM-to-Loro traversal, including marks.
 */
export const loroPageFromAutomergePage = (doc: Automerge.Doc<PageDoc>): LoroPageDocument => {
  const page = createLoroPage()
  page.doc.configTextStyle(
    Object.fromEntries(
      Object.entries(richTextSchemaAdapter.schema.marks).map(([markName, markType]) => [
        markName,
        { expand: markType.spec.inclusive === false ? "none" : "after" }
      ])
    )
  )
  const pmDocument = pmDocumentFromAutomergePage(doc)
  const editorState = EditorState.create({ schema: richTextSchemaAdapter.schema, doc: pmDocument })

  updateLoroToPmState(
    page.doc as unknown as LoroDocType,
    new Map(),
    editorState,
    page.pmRoot.id
  )
  return inspectLoroPage(page.doc)
}

/** Construct a Loro page from an already-exported snapshot. */
export const loroPageFromSnapshot = (snapshot: Uint8Array): LoroPageDocument => {
  const doc = new LoroDoc()
  doc.import(snapshot)
  return inspectLoroPage(doc)
}
