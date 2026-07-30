import { describe, expect, test } from "bun:test"
import { next as A } from "@automerge/automerge"
import { pmDocFromSpans, pmNodeToSpans, SchemaAdapter } from "@automerge/prosemirror"
import { readFileSync } from "node:fs"
import { baseKeymap } from "prosemirror-commands"
import { history, redo, undo } from "prosemirror-history"
import { inputRules } from "prosemirror-inputrules"
import { keymap } from "prosemirror-keymap"
import { type MarkType, type Node as PMNode, Schema } from "prosemirror-model"
import { EditorState, TextSelection, type Transaction } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { markdownEmphasisInputRules, reversibleMarkdownKeymap } from "../src/markdownEmphasis"

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
    strike: {},
    link: { attrs: { href: {} }, inclusive: false },
    code: { code: true },
  },
})

type EditorHarness = {
  state: () => EditorState
  type: (text: string) => boolean
  pressBackspace: () => boolean
}

function editorHarness(doc: PMNode, customSchema = schema): EditorHarness {
  const rules = inputRules({ rules: markdownEmphasisInputRules(customSchema) })
  const plugins = [history(), rules, reversibleMarkdownKeymap, keymap(baseKeymap)]
  let state = EditorState.create({
    schema: customSchema,
    doc,
    selection: TextSelection.atEnd(doc),
    plugins,
  })
  const view = {
    get state() { return state },
    composing: false,
    dispatch: (transaction: Transaction) => { state = state.apply(transaction) },
  } as unknown as EditorView

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
    pressBackspace() {
      const event = {
        key: "Backspace",
        keyCode: 8,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      } as KeyboardEvent
      return state.plugins.some(plugin => plugin.props.handleKeyDown?.(view, event) === true)
    },
  }
}

function paragraph(text: string, marks = [] as ReturnType<MarkType["create"]>[]): PMNode {
  return schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, schema.text(text, marks)))
}

describe("inline Markdown emphasis input", () => {
  test("installs Backspace reversal after input rules and before baseKeymap", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")
    const inputRulesIndex = source.indexOf("inputRules({ rules: editorInputRules(binding.schema) })")
    const reversalIndex = source.indexOf("    reversibleMarkdownKeymap,")
    const baseKeymapIndex = source.indexOf("keymap(baseKeymap)")

    expect(inputRulesIndex).toBeGreaterThan(-1)
    expect(reversalIndex).toBeGreaterThan(inputRulesIndex)
    expect(baseKeymapIndex).toBeGreaterThan(reversalIndex)
  })

  for (const example of [
    { markdown: "**bold**", mark: "strong" },
    { markdown: "__bold__", mark: "strong" },
    { markdown: "*italic*", mark: "em" },
    { markdown: "_italic_", mark: "em" },
    { markdown: "~~strikethrough~~", mark: "strike" },
  ] as const) {
    test(`converts ${example.mark} from ${example.markdown}`, () => {
      const content = example.markdown.replace(/^\*\*|\*\*$|^__|__$|^\*|\*$|^_|_$|^~~|~~$/g, "")
      const editor = editorHarness(paragraph(example.markdown.slice(0, -1)))

      expect(editor.type(example.markdown.slice(-1))).toBeTrue()

      const state = editor.state()
      const mark = state.schema.marks[example.mark]!
      expect(state.doc.textContent).toBe(content)
      expect(state.doc.rangeHasMark(1, 1 + content.length, mark)).toBeTrue()
      expect(state.selection.from).toBe(1 + content.length)
      expect(state.storedMarks).toEqual([])
    })
  }

  test("removes only delimiters and preserves a compatible existing link mark", () => {
    const link = schema.marks.link!.create({ href: "https://example.com" })
    const block = schema.nodes.paragraph!.create(null, [
      schema.text("**"),
      schema.text("linked", [link]),
      schema.text("*"),
    ])
    const editor = editorHarness(schema.nodes.doc!.create(null, block))

    expect(editor.type("*")).toBeTrue()

    const state = editor.state()
    expect(state.doc.textContent).toBe("linked")
    expect(state.doc.rangeHasMark(1, 7, schema.marks.strong!)).toBeTrue()
    expect(state.doc.rangeHasMark(1, 7, schema.marks.link!)).toBeTrue()
    expect(schema.marks.link!.isInSet(state.doc.nodeAt(1)!.marks)?.attrs.href)
      .toBe("https://example.com")
  })

  test("immediate Backspace runs undoInputRule before baseKeymap and restores exact Markdown", () => {
    const editor = editorHarness(paragraph("Before **bold*"))
    expect(editor.type("*")).toBeTrue()
    expect(editor.state().doc.textContent).toBe("Before bold")

    expect(editor.pressBackspace()).toBeTrue()

    const state = editor.state()
    expect(state.doc.textContent).toBe("Before **bold**")
    expect(state.doc.rangeHasMark(1, state.doc.content.size, schema.marks.strong!)).toBeFalse()
    expect(state.selection.$from.parentOffset).toBe("Before **bold**".length)
  })

  test("history undo and redo treat the conversion as one coherent transaction", () => {
    const editor = editorHarness(paragraph("**bold*"))
    expect(editor.type("*")).toBeTrue()
    let state = editor.state()
    expect(state.doc.textContent).toBe("bold")

    expect(undo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.textContent).toBe("**bold*")
    expect(redo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.textContent).toBe("bold")
    expect(state.doc.rangeHasMark(1, 5, schema.marks.strong!)).toBeTrue()
  })

  test("persists and reloads the existing Automerge strong mark", () => {
    const adapter = persistenceAdapter()
    const source = adapter.schema.nodes.doc!.create(
      null,
      adapter.schema.nodes.paragraph!.create(null, adapter.schema.text("**durable*")),
    )
    const editor = editorHarness(source, adapter.schema)
    expect(editor.type("*")).toBeTrue()

    let document = A.from({ body: "" })
    document = A.change(document, draft => {
      A.updateSpans(draft, ["body"], pmNodeToSpans(adapter, editor.state().doc), adapter.updateSpansConfig())
    })
    const saved = A.load(A.save(document))
    const mark = A.marks(saved, ["body"]).find(candidate => candidate.name === "strong")
    const reloaded = pmDocFromSpans(adapter, A.spans(saved, ["body"]))

    expect(mark?.value).toBe(true)
    expect(reloaded.textContent).toBe("durable")
    expect(reloaded.rangeHasMark(1, 8, adapter.schema.marks.strong!)).toBeTrue()
  })

  test("does not convert in code blocks or inline code marks", () => {
    const codeBlock = schema.nodes.doc!.create(
      null,
      schema.nodes.code_block!.create(null, schema.text("**bold*")),
    )
    const blockEditor = editorHarness(codeBlock)
    expect(blockEditor.type("*")).toBeFalse()
    expect(blockEditor.state().doc.textContent).toBe("**bold**")

    const code = schema.marks.code!.create()
    const inlineEditor = editorHarness(paragraph("**bold*", [code]))
    expect(inlineEditor.type("*")).toBeFalse()
    expect(inlineEditor.state().doc.textContent).toBe("**bold**")
    expect(inlineEditor.state().doc.rangeHasMark(1, 9, schema.marks.strong!)).toBeFalse()
  })

  test("does not match emphasis across block boundaries", () => {
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, schema.text("**bold")),
      schema.nodes.paragraph!.create(null, schema.text("*")),
    ])
    const editor = editorHarness(doc)

    expect(editor.type("*")).toBeFalse()
    expect(editor.state().doc.child(0).textContent).toBe("**bold")
    expect(editor.state().doc.child(1).textContent).toBe("**")
  })

  for (const example of [
    { label: "escaped delimiters", before: "\\**bold*", typed: "*", after: "\\**bold**" },
    { label: "whitespace-only spans", before: "**   *", typed: "*", after: "**   **" },
    { label: "snake_case underscores", before: "snake_case", typed: "_", after: "snake_case_" },
    { label: "in-word asterisks", before: "word*italic", typed: "*", after: "word*italic*" },
    { label: "unmatched delimiters", before: "**bold", typed: "*", after: "**bold*" },
    { label: "punctuation-only spans", before: "**---*", typed: "*", after: "**---**" },
    { label: "unsafe punctuation boundaries", before: "path/**bold*", typed: "*", after: "path/**bold**" },
    { label: "triple-delimiter ambiguity", before: "***bold**", typed: "*", after: "***bold***" },
  ]) {
    test(`leaves ${example.label} literal`, () => {
      const editor = editorHarness(paragraph(example.before))
      expect(editor.type(example.typed)).toBeFalse()
      expect(editor.state().doc.textContent).toBe(example.after)
    })
  }
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
      strong: { automerge: { markName: "strong" } },
      em: { automerge: { markName: "em" } },
      strike: { automerge: { markName: "strike" } },
      unknownMark: {
        automerge: { markName: "__unknown__" },
        attrs: { unknownMarks: { default: {} } },
      },
    },
  })
}
