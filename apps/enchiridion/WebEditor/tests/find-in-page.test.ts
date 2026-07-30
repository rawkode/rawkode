import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { next as A } from "@automerge/automerge"
import { pmDocFromSpans, pmNodeToSpans, SchemaAdapter } from "@automerge/prosemirror"
import { history, undoDepth } from "prosemirror-history"
import { Schema } from "prosemirror-model"
import { EditorState } from "prosemirror-state"
import {
  createFindInPagePlugin,
  findBodyMatches,
  findDecorationTransaction,
  findInPagePluginKey,
  findLiteralRanges,
  findPageMatches,
  moveFindSelection,
} from "../src/findInPage"

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block" },
    hard_break: { inline: true, group: "inline", atom: true },
    inline_embed: { inline: true, group: "inline", atom: true, attrs: { hiddenLabel: {} } },
    bookmark: { group: "block", atom: true, attrs: { title: {}, summary: {} } },
    text: { group: "inline" },
  },
  marks: {
    strong: {},
    em: {},
    link: { attrs: { href: {}, title: { default: null } } },
    page_reference: { attrs: { pageID: {}, label: {} } },
  },
})

describe("literal find matcher", () => {
  test("matches repeated text case-insensitively and never overlaps", () => {
    expect(findLiteralRanges("Find FIND find", "find")).toEqual([
      { from: 0, to: 4 },
      { from: 5, to: 9 },
      { from: 10, to: 14 },
    ])
    expect(findLiteralRanges("aaaa", "aa")).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ])
    expect(findLiteralRanges("a+b a.b", "a+b")).toEqual([{ from: 0, to: 3 }])
  })

  test("uses Unicode-aware simple case folding without weakening accent identity", () => {
    expect(findLiteralRanges("CAFÉ café cafe", "café")).toEqual([
      { from: 0, to: 4 },
      { from: 5, to: 9 },
    ])
    expect(findLiteralRanges("Kelvin K k", "k")).toEqual([
      { from: 0, to: 1 },
      { from: 7, to: 8 },
      { from: 9, to: 10 },
    ])
  })

  test("joins visible text across inline mark boundaries", () => {
    const paragraph = schema.nodes.paragraph!.create(null, [
      schema.text("fi", [schema.marks.strong!.create()]),
      schema.text("nd", [schema.marks.em!.create()]),
      schema.text(" this"),
    ])
    const doc = schema.nodes.doc!.create(null, paragraph)
    expect(findBodyMatches(doc, "find")).toEqual([{ from: 1, to: 5 }])
  })

  test("never crosses blocks, soft breaks, or embeds, and ignores hidden metadata", () => {
    const link = schema.marks.link!.create({ href: "https://hidden.example/needle" })
    const reference = schema.marks.page_reference!.create({ pageID: "needle", label: "hidden needle" })
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, schema.text("block end")),
      schema.nodes.paragraph!.create(null, schema.text("start block")),
      schema.nodes.paragraph!.create(null, [
        schema.text("soft"),
        schema.nodes.hard_break!.create(),
        schema.text("break"),
      ]),
      schema.nodes.paragraph!.create(null, [
        schema.text("inline"),
        schema.nodes.inline_embed!.create({ hiddenLabel: "needle" }),
        schema.text("embed"),
      ]),
      schema.nodes.paragraph!.create(null, [
        schema.text("visible link", [link]),
        schema.text(" and reference", [reference]),
      ]),
      schema.nodes.bookmark!.create({ title: "needle", summary: "hidden needle" }),
    ])

    for (const query of ["endstart", "softbreak", "inlineembed", "needle"]) {
      expect(findBodyMatches(doc, query)).toEqual([])
    }
    expect(findBodyMatches(doc, "VISIBLE LINK")).toHaveLength(1)
  })

  test("orders title matches before body matches", () => {
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, schema.text("Needle body one")),
      schema.nodes.heading!.create(null, schema.text("needle body two")),
    ])
    expect(findPageMatches("Needle title", doc, "needle").map(match => match.source)).toEqual([
      "title",
      "body",
      "body",
    ])
  })

  test("wraps previous and next navigation", () => {
    expect(moveFindSelection(-1, 3, 1)).toBe(0)
    expect(moveFindSelection(-1, 3, -1)).toBe(2)
    expect(moveFindSelection(2, 3, 1)).toBe(0)
    expect(moveFindSelection(0, 3, -1)).toBe(2)
    expect(moveFindSelection(0, 0, 1)).toBe(-1)
  })
})

describe("find decoration plugin", () => {
  test("recomputes ranges safely after edits while preserving UI-only decoration state", () => {
    const doc = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, schema.text("one needle")))
    let state = EditorState.create({ doc, plugins: [history(), createFindInPagePlugin()] })
    state = state.apply(findDecorationTransaction(state, "needle", 0))
    expect(findInPagePluginKey.getState(state)?.ranges).toEqual([{ from: 5, to: 11 }])

    state = state.apply(state.tr.insertText(" needle", 11))
    expect(findInPagePluginKey.getState(state)?.ranges).toEqual([
      { from: 5, to: 11 },
      { from: 12, to: 18 },
    ])
    expect(findInPagePluginKey.getState(state)?.decorations.find()).toHaveLength(2)
  })

  test("query, navigation, and decorations create no durable mutation side effects", () => {
    const adapter = new SchemaAdapter({
      nodes: {
        doc: { content: "block+" },
        paragraph: {
          automerge: { block: "paragraph" },
          content: "text*",
          group: "block",
          toDOM: () => ["p", 0],
        },
        unknownBlock: {
          automerge: { unknownBlock: true },
          content: "block+",
          group: "block",
          toDOM: () => ["div", 0],
        },
        text: { group: "inline" },
      },
      marks: {
        unknownMark: { automerge: { markName: "__unknown__" } },
      },
    })
    const pmDoc = adapter.schema.nodes.doc!.create(null,
      adapter.schema.nodes.paragraph!.create(null, adapter.schema.text("needle needle")))
    const baseline = A.from({ body: "" })
    const automergeDocument = A.change(baseline, document => {
      A.updateSpans(document, ["body"], pmNodeToSpans(adapter, pmDoc), adapter.updateSpansConfig())
    })
    const loadedDoc = pmDocFromSpans(adapter, A.spans(automergeDocument, ["body"]))
    const headsBefore = A.getHeads(automergeDocument)
    let recoveryJournalEntries = 0
    let nativeCommitNotifications = 0
    let state = EditorState.create({ doc: loadedDoc, plugins: [history(), createFindInPagePlugin()] })
    const documentBefore = state.doc.toJSON()

    for (const activeBodyIndex of [0, 1, 0, -1]) {
      const transaction = findDecorationTransaction(state, "needle", activeBodyIndex)
      expect(transaction.docChanged).toBeFalse()
      state = state.apply(transaction)
      if (transaction.docChanged) {
        recoveryJournalEntries += 1
        nativeCommitNotifications += 1
      }
    }

    expect(state.doc.toJSON()).toEqual(documentBefore)
    expect(undoDepth(state)).toBe(0)
    expect(A.getHeads(automergeDocument)).toEqual(headsBefore)
    expect(recoveryJournalEntries).toBe(0)
    expect(nativeCommitNotifications).toBe(0)
  })
})

describe("find lifecycle integration", () => {
  const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")
  const nativeSource = readFileSync(
    new URL("../../Sources/SharedUI/EntryEditorView.swift", import.meta.url),
    "utf8",
  )
  const styleSource = readFileSync(new URL("../src/style.css", import.meta.url), "utf8")
  const editorHTML = readFileSync(new URL("../index.html", import.meta.url), "utf8")

  test("resets on page load and closes transient palettes before opening", () => {
    expect(mainSource).toMatch(/closeFindInPage\(false\)[\s\S]*?view\?\.destroy\(\)/)
    expect(mainSource).toMatch(/function closeTransientPalettesForFind[\s\S]*?closeSlashPalette\(\)[\s\S]*?pageMenu\.hidden = true[\s\S]*?closeLinkEditor\(false\)/)
  })

  test("uses explicit decorations and never delegates to the browser finder", () => {
    expect(mainSource).toContain("createFindInPagePlugin()")
    expect(mainSource).toContain("findDecorationTransaction")
    expect(mainSource).not.toContain("window.find")
  })

  test("registers and unregisters one native-to-web find command without a commit message", () => {
    expect(nativeSource).toContain("findController.register(findRegistrationID)")
    expect(nativeSource).toContain("findController.unregister(findRegistrationID)")
    expect(nativeSource).toContain('webView.evaluateJavaScript("window.EnchiridionEditor?.find()")')
    expect(nativeSource).toContain('Label("Find in Page", systemImage: "magnifyingglass")')
    const bridgeCommand = nativeSource.match(/private func openFind\(in webView: WKWebView\) \{([\s\S]*?)\n  \}/)?.[1] ?? ""
    expect(bridgeCommand).not.toContain("commit")
    expect(bridgeCommand).not.toContain("flush")
  })

  test("keeps the shared iPhone surface touch, keyboard, focus, and VoiceOver safe", () => {
    expect(nativeSource.match(/Label\("Find in Page", systemImage: "magnifyingglass"\)/g)).toHaveLength(2)
    expect(styleSource).toMatch(/\.find-bar input[\s\S]*?min-height: 2\.75rem/)
    expect(styleSource).toMatch(/\.find-bar button[\s\S]*?min-height: 2\.75rem/)
    expect(mainSource).toContain('window.visualViewport?.addEventListener("resize", positionFindBar)')
    expect(mainSource).toContain("bookmark: target.bookmark.map(transaction.mapping)")
    expect(mainSource).toContain("active.restoreTarget.bookmark.resolve(view.state.doc)")
    expect(mainSource).toContain('announcement.setAttribute("aria-live", "polite")')
    expect(editorHTML).toContain('role="search" aria-label="Find in page"')
  })
})
