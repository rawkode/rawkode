// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest"
import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt"
import { LoroSyncPlugin, type LoroDocType } from "loro-prosemirror"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { Node as PMNode } from "prosemirror-model"
import checkedInCorpus from "./fixtures/native-rich-loro-v1-source-corpus.json"
import { buildNativeRichLoroV1Corpus, inspectNativeRichLoroRejection, nativeRichLoroSourceCanonicalContent, replayNativeRichLoroOperations, NATIVE_RICH_ENTITY_REFERENCE_ID, NATIVE_RICH_LORO_SCALAR_UNIT, NATIVE_RICH_SUPERTAG_REFERENCE_ID, type NativeRichOperation, type NativeRichLoroV1Corpus } from "./native-rich-loro-v1-corpus.js"
import { richTextSchemaAdapter } from "./rich-text/schema.js"

const digest = async (encoded: string): Promise<string> => {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
const digestText = async (value: string): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const firstText = (doc: LoroDoc): LoroText => {
  const root = doc.getMap("athenaeum-prosemirror-v1")
  const blocks = root.get("children")
  if (!(blocks instanceof LoroList)) throw new Error("missing official block list")
  const block = blocks.get(0)
  if (!(block instanceof LoroMap)) throw new Error("missing official block")
  const children = block.get("children")
  if (!(children instanceof LoroList)) throw new Error("missing official inline list")
  const value = children.get(0)
  if (!(value instanceof LoroText)) throw new Error("missing official inline text")
  return value
}

describe("native rich Loro v1 source corpus", () => {
  const sourceCorpus = checkedInCorpus as unknown as NativeRichLoroV1Corpus
  it("is repeatable, digest checked, and explicitly source-only", async () => {
    const generated = buildNativeRichLoroV1Corpus()
    expect(generated).toEqual({
      ...checkedInCorpus,
      sourceDigest: undefined,
      cases: checkedInCorpus.cases.map(({ baseSnapshotSHA256: _snapshot, baseVVSHA256: _vv, ...fixture }) => fixture)
    })
    expect(await digestText(nativeRichLoroSourceCanonicalContent(generated))).toBe(checkedInCorpus.sourceDigest)
    expect(generated.scalarUnit).toBe(NATIVE_RICH_LORO_SCALAR_UNIT)
    expect(checkedInCorpus.sourceContract).toBe("web-base-only-r4-native-result-join")
    expect(checkedInCorpus.cases.every((fixture) => fixture.baseSnapshotBase64 && fixture.baseVVBase64)).toBe(true)
    for (const fixture of sourceCorpus.cases) {
      expect(await digest(fixture.baseVVBase64), fixture.id).toBe(fixture.baseVVSHA256)
      expect(await digest(fixture.baseSnapshotBase64), `${fixture.id} snapshot`).toBe(fixture.baseSnapshotSHA256)
      expect(fixture.proposedDocument).toEqual(fixture.expectedDocument)
      expect(replayNativeRichLoroOperations(fixture.baseDocument, fixture.operations), fixture.id).toEqual(fixture.expectedDocument)
    }
  })

  it("contains official-plugin root state in every eligible base snapshot", async () => {
    vi.useFakeTimers()
    try { for (const fixture of checkedInCorpus.cases) {
      const doc = new LoroDoc()
      doc.import(Uint8Array.from(atob(fixture.baseSnapshotBase64), (character) => character.charCodeAt(0)))
      const root = doc.getMap("athenaeum-prosemirror-v1")
      expect(root).toBeInstanceOf(LoroMap)
      expect(root.get("nodeName")).toBe("doc")
      expect(root.get("children")).toBeInstanceOf(LoroList)
      const base = PMNode.fromJSON(richTextSchemaAdapter.schema, fixture.baseDocument)
      const proposed = PMNode.fromJSON(richTextSchemaAdapter.schema, fixture.proposedDocument)
      const sentinel = richTextSchemaAdapter.schema.nodes.doc.create(null, [richTextSchemaAdapter.schema.nodes.paragraph.create(null, [richTextSchemaAdapter.schema.text("bootstrap")])])
      const state = EditorState.create({ schema: richTextSchemaAdapter.schema, doc: sentinel, plugins: [LoroSyncPlugin({ doc: doc as unknown as LoroDocType, containerId: root.id })] })
      const host = document.createElement("div")
      const view = new EditorView(host, { state })
      await vi.advanceTimersByTimeAsync(0)
      expect(view.state.doc.eq(base)).toBe(true)
      const transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, proposed.content)
      view.dispatch(transaction)
      expect(view.state.doc.eq(proposed)).toBe(true)
      view.destroy()
    } } finally { vi.useRealTimers() }
  })

  it("pins the official Loro reference wire shape separately from legacy Automerge names", () => {
    expect(richTextSchemaAdapter.schema.marks.entityRef.spec.inclusive).toBe(false)
    expect(richTextSchemaAdapter.schema.marks.supertagRef.spec.inclusive).toBe(false)
    const expected = [
      {
        fixtureId: "entity-reference-surrounding-edit",
        markName: "entityRef",
        payload: { nodeId: NATIVE_RICH_ENTITY_REFERENCE_ID, label: "Alice" }
      },
      {
        fixtureId: "supertag-reference-surrounding-edit",
        markName: "supertagRef",
        payload: { tagId: NATIVE_RICH_SUPERTAG_REFERENCE_ID, label: "Project" }
      }
    ] as const
    for (const expectation of expected) {
      const fixture = checkedInCorpus.cases.find((candidate) => candidate.id === expectation.fixtureId)
      expect(fixture, expectation.fixtureId).toBeDefined()
      const doc = new LoroDoc()
      doc.import(Uint8Array.from(atob(fixture!.baseSnapshotBase64), (character) => character.charCodeAt(0)))
      const matchingDelta = firstText(doc).toDelta().find((part) => part.attributes?.[expectation.markName] !== undefined)
      expect(matchingDelta?.attributes?.[expectation.markName]).toEqual(expectation.payload)
      expect(matchingDelta?.attributes).not.toHaveProperty(expectation.markName === "entityRef" ? "entity-ref" : "supertag-ref")
    }
  })

  it("covers the complete eligible operation matrix", () => {
    expect(checkedInCorpus.cases.map((fixture) => fixture.id)).toEqual([
      "empty-page", "paragraph-insertion", "paragraph-deletion", "paragraph-replacement",
      "heading-1-to-2", "heading-2-to-3", "heading-3-to-paragraph", "multi-block-insert-delete",
      "strong-em-code-add", "strong-em-code-remove", "strong-adjacency", "emoji-combining-mark-range", "empty-terminal-paragraph",
      "emoji-and-combining", "whole-document-replacement", "entity-reference-surrounding-edit", "supertag-reference-surrounding-edit"
    ])
    expect(checkedInCorpus.cases.flatMap((fixture) => fixture.operations.map((operation) => operation.kind))).toEqual(expect.arrayContaining([
      "insert-block", "delete-block", "replace-block", "replace-document", "add-mark", "remove-mark"
    ]))
    const marked = checkedInCorpus.cases.find((fixture) => fixture.id === "emoji-combining-mark-range")!
    const invalid: NativeRichOperation = { kind: "add-mark", blockIndex: 1, scalarUnit: NATIVE_RICH_LORO_SCALAR_UNIT, mark: "strong", from: 99, to: 100, text: "A🦜café" }
    expect(() => replayNativeRichLoroOperations(marked.baseDocument, [invalid])).toThrow("range payload")
    const invalidBlock = { ...invalid, blockIndex: 99, from: 0, to: 1, text: "" }
    expect(() => replayNativeRichLoroOperations(marked.baseDocument, [invalidBlock])).toThrow("block index is out of bounds")
    const onlyBlock = checkedInCorpus.cases.find((fixture) => fixture.id === "empty-page")!
    const only = ((onlyBlock.baseDocument["content"] as unknown[])[0]) as Record<string, unknown>
    expect(() => replayNativeRichLoroOperations(onlyBlock.baseDocument, [{ kind: "delete-block", blockIndex: 0, block: only }])).toThrow("delete-block payload")
  })

  it("classifies unsupported and malformed shapes without presenting them as plugin output", () => {
    expect(checkedInCorpus.rejections.map((entry) => entry.id)).toEqual([
      "reject-link", "reject-strike", "reject-list", "reject-task-list", "reject-quote", "reject-code-block", "reject-divider",
      "reject-unknown-node", "reject-unknown-mark", "reject-unknown-attribute", "reject-malformed-known-shape",
      "reject-entity-reference-malformed-payload", "reject-entity-reference-wrong-payload", "reject-entity-reference-extra-payload",
      "reject-supertag-reference-malformed-payload", "reject-supertag-reference-wrong-payload", "reject-supertag-reference-extra-payload",
      "reject-bounds-plus-one"
    ])
    expect(checkedInCorpus.rejections.every((entry) => entry.classification === "rejected")).toBe(true)
    for (const entry of sourceCorpus.rejections) {
      expect(inspectNativeRichLoroRejection(entry), entry.id).toBe(true)
    }
    expect(sourceCorpus.rejections.filter((entry) => entry.origin === "adversarial-wire").map((entry) => entry.id)).toEqual([
      "reject-unknown-node", "reject-unknown-mark", "reject-unknown-attribute", "reject-malformed-known-shape",
      "reject-entity-reference-malformed-payload", "reject-entity-reference-wrong-payload", "reject-entity-reference-extra-payload",
      "reject-supertag-reference-malformed-payload", "reject-supertag-reference-wrong-payload", "reject-supertag-reference-extra-payload"
    ])
  })
})
