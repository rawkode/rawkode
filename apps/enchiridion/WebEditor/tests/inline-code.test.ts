import { describe, expect, test } from "bun:test"
import { next as A } from "@automerge/automerge"
import { pmDocFromSpans, pmNodeToSpans, SchemaAdapter } from "@automerge/prosemirror"
import { readFileSync } from "node:fs"
import { baseKeymap, toggleMark } from "prosemirror-commands"
import { history, redo, undo } from "prosemirror-history"
import { inputRules, smartQuotes } from "prosemirror-inputrules"
import { keymap } from "prosemirror-keymap"
import { type Mark, type Node as PMNode, Schema } from "prosemirror-model"
import { EditorState, TextSelection, type Transaction } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { inlineCodeInputRules } from "../src/inlineCode"
import { reversibleMarkdownKeymap } from "../src/markdownEmphasis"

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    code_block: { content: "text*", group: "block", code: true },
    text: {},
  },
  marks: {
    strong: {},
    em: {},
    code: { code: true },
    link: { attrs: { href: {} }, inclusive: false },
    page_reference: {
      attrs: { pageID: {}, label: { default: "" } },
      inclusive: false,
    },
  },
})

type EditorHarness = {
  state: () => EditorState
  type: (text: string) => boolean
  pressBackspace: () => boolean
  pressInlineCodeShortcut: () => boolean
}

function editorHarness(doc: PMNode, customSchema = schema, selection = TextSelection.atEnd(doc)): EditorHarness {
  const rules = inputRules({ rules: [
    ...inlineCodeInputRules(customSchema),
    ...smartQuotes,
  ] })
  let state = EditorState.create({
    schema: customSchema,
    doc,
    selection,
    plugins: [
      history(),
      rules,
      reversibleMarkdownKeymap,
      keymap({ "Shift-Mod-j": toggleMark(customSchema.marks.code!) }),
      keymap(baseKeymap),
    ],
  })
  const view = {
    get state() { return state },
    composing: false,
    dispatch: (transaction: Transaction) => { state = state.apply(transaction) },
  } as unknown as EditorView

  function press(event: KeyboardEvent): boolean {
    return state.plugins.some(plugin => plugin.props.handleKeyDown?.(view, event) === true)
  }

  return {
    state: () => state,
    type(text) {
      const { from, to } = state.selection
      const handled = rules.props.handleTextInput?.(
        view,
        from,
        to,
        text,
        () => state.tr.insertText(text, from, to),
      ) === true
      if (!handled) view.dispatch(state.tr.insertText(text, from, to))
      return handled
    },
    pressBackspace: () => press({
      key: "Backspace",
      keyCode: 8,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    } as KeyboardEvent),
    pressInlineCodeShortcut: () => press({
      key: "J",
      keyCode: 74,
      altKey: false,
      ctrlKey: false,
      metaKey: true,
      shiftKey: true,
    } as KeyboardEvent),
  }
}

function paragraph(text: string, marks: readonly Mark[] = [], customSchema = schema): PMNode {
  return customSchema.nodes.doc!.create(
    null,
    customSchema.nodes.paragraph!.create(null, text ? customSchema.text(text, marks) : undefined),
  )
}

describe("inline code authoring", () => {
  test("converts a closing single backtick, removes delimiters, and leaves the caret after code", () => {
    const editor = editorHarness(paragraph("Use `launch"))

    expect(editor.type("`")).toBeTrue()

    const state = editor.state()
    expect(state.doc.textContent).toBe("Use launch")
    expect(state.doc.rangeHasMark(5, 11, schema.marks.code!)).toBeTrue()
    expect(state.selection.from).toBe(11)
    expect(schema.marks.code!.isInSet(state.storedMarks ?? [])).toBeUndefined()
  })

  test("preserves compatible marks without carrying link or identity marks past the code", () => {
    const strong = schema.marks.strong!.create()
    const link = schema.marks.link!.create({ href: "https://example.com" })
    const reference = schema.marks.page_reference!.create({ pageID: "page:one", label: "One" })
    const block = schema.nodes.paragraph!.create(null, [
      schema.text("`"),
      schema.text("linked", [strong, link, reference]),
    ])
    const editor = editorHarness(schema.nodes.doc!.create(null, block))

    expect(editor.type("`")).toBeTrue()

    const state = editor.state()
    for (const mark of [schema.marks.strong!, schema.marks.link!, schema.marks.page_reference!, schema.marks.code!]) {
      expect(state.doc.rangeHasMark(1, 7, mark)).toBeTrue()
    }
    expect(schema.marks.strong!.isInSet(state.storedMarks ?? [])).toBeDefined()
    expect(schema.marks.code!.isInSet(state.storedMarks ?? [])).toBeUndefined()
    expect(schema.marks.link!.isInSet(state.storedMarks ?? [])).toBeUndefined()
    expect(schema.marks.page_reference!.isInSet(state.storedMarks ?? [])).toBeUndefined()
  })

  test("immediate Backspace restores the exact literal backticks", () => {
    const editor = editorHarness(paragraph("Before `code"))
    expect(editor.type("`")).toBeTrue()
    expect(editor.state().doc.textContent).toBe("Before code")

    expect(editor.pressBackspace()).toBeTrue()

    const state = editor.state()
    expect(state.doc.textContent).toBe("Before `code`")
    expect(state.doc.rangeHasMark(1, state.doc.content.size, schema.marks.code!)).toBeFalse()
    expect(state.selection.$from.parentOffset).toBe("Before `code`".length)
  })

  test("history undo and redo keep the conversion coherent", () => {
    const editor = editorHarness(paragraph("`code"))
    expect(editor.type("`")).toBeTrue()
    let state = editor.state()

    expect(undo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.textContent).toBe("`code")
    expect(redo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.textContent).toBe("code")
    expect(state.doc.rangeHasMark(1, 5, schema.marks.code!)).toBeTrue()
  })

  test("Shift-Mod-J toggles the existing code mark", () => {
    const doc = paragraph("select me")
    const editor = editorHarness(doc, schema, TextSelection.create(doc, 1, 10))

    expect(editor.pressInlineCodeShortcut()).toBeTrue()
    expect(editor.state().doc.rangeHasMark(1, 10, schema.marks.code!)).toBeTrue()
    expect(editor.pressInlineCodeShortcut()).toBeTrue()
    expect(editor.state().doc.rangeHasMark(1, 10, schema.marks.code!)).toBeFalse()
  })

  test("persists and reloads the Automerge code mark", () => {
    const adapter = persistenceAdapter()
    const editor = editorHarness(paragraph("`durable", [], adapter.schema), adapter.schema)
    expect(editor.type("`")).toBeTrue()

    let document = A.from({ body: "" })
    document = A.change(document, draft => {
      A.updateSpans(draft, ["body"], pmNodeToSpans(adapter, editor.state().doc), adapter.updateSpansConfig())
    })
    const saved = A.load(A.save(document))
    const reloaded = pmDocFromSpans(adapter, A.spans(saved, ["body"]))

    expect(A.marks(saved, ["body"]).find(candidate => candidate.name === "code")?.value).toBe(true)
    expect(reloaded.textContent).toBe("durable")
    expect(reloaded.rangeHasMark(1, 8, adapter.schema.marks.code!)).toBeTrue()
  })

  test("keeps ASCII quotes literal while a backtick remains unmatched", () => {
    const doubleQuote = editorHarness(paragraph("`say "))
    expect(doubleQuote.type("\"")).toBeTrue()
    expect(doubleQuote.state().doc.textContent).toBe('`say "')

    const singleQuote = editorHarness(paragraph("`it"))
    expect(singleQuote.type("'")).toBeTrue()
    expect(singleQuote.state().doc.textContent).toBe("`it'")
  })

  test("does not match across block boundaries", () => {
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, schema.text("`first")),
      schema.nodes.paragraph!.create(null, schema.text("second")),
    ])
    const editor = editorHarness(doc)

    expect(editor.type("`")).toBeFalse()
    expect(editor.state().doc.child(0).textContent).toBe("`first")
    expect(editor.state().doc.child(1).textContent).toBe("second`")
  })

  test("does not convert in code blocks or existing inline code", () => {
    const codeBlock = schema.nodes.doc!.create(null, schema.nodes.code_block!.create(null, schema.text("`code")))
    const blockEditor = editorHarness(codeBlock)
    expect(blockEditor.type("`")).toBeFalse()
    expect(blockEditor.state().doc.textContent).toBe("`code`")

    const code = schema.marks.code!.create()
    const inlineEditor = editorHarness(paragraph("`code", [code]))
    expect(inlineEditor.type("`")).toBeFalse()
    expect(inlineEditor.state().doc.textContent).toBe("`code`")
  })

  for (const example of [
    { label: "empty spans", before: "`", typed: "`", after: "``" },
    { label: "whitespace-only spans", before: "` \t", typed: "`", after: "` \t`" },
    { label: "escaped opening delimiters", before: "\\`code", typed: "`", after: "\\`code`" },
    { label: "escaped closing delimiters", before: "`code\\", typed: "`", after: "`code\\`" },
    { label: "unmatched delimiters", before: "`code", typed: "!", after: "`code!" },
    { label: "multiline content", before: "`first\nsecond", typed: "`", after: "`first\nsecond`" },
    { label: "nested backticks", before: "`outer `inner", typed: "`", after: "`outer `inner`" },
  ]) {
    test(`leaves ${example.label} literal`, () => {
      const editor = editorHarness(paragraph(example.before))
      expect(editor.type(example.typed)).toBeFalse()
      expect(editor.state().doc.textContent).toBe(example.after)
    })
  }

  test("uses restrained semantic inline styling without styling pre code", () => {
    const style = readFileSync(new URL("../src/style.css", import.meta.url), "utf8")
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")

    expect(style).toContain(".ProseMirror :not(pre) > code")
    expect(style).toContain("CanvasText")
    expect(style).toContain("var(--accent)")
    expect(style).not.toMatch(/\.ProseMirror\s+code\s*\{/)
    expect(source).toContain('"Shift-Mod-j": toggleMark(binding.schema.marks.code!)')
  })
})

function persistenceAdapter(): SchemaAdapter {
  return new SchemaAdapter({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        automerge: { block: "paragraph" },
        content: "inline*",
        group: "block",
        toDOM: () => ["p", 0],
      },
      unknownBlock: {
        automerge: { unknownBlock: true },
        content: "block+",
        group: "block",
        toDOM: () => ["div", 0],
      },
      unknownLeaf: {
        automerge: { unknownBlock: true },
        inline: true,
        group: "inline",
        atom: true,
        toDOM: () => ["span", "Unsupported content"],
      },
      text: { group: "inline" },
    },
    marks: {
      code: { automerge: { markName: "code" }, code: true },
      unknownMark: {
        automerge: { markName: "__unknown__" },
        attrs: { unknownMarks: { default: {} } },
      },
    },
  })
}
