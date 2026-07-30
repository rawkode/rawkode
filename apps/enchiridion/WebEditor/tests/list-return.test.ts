import { describe, expect, test } from "bun:test"
import { next as A } from "@automerge/automerge"
import { pmDocFromSpans, pmNodeToSpans, SchemaAdapter } from "@automerge/prosemirror"
import { readFileSync } from "node:fs"
import { baseKeymap } from "prosemirror-commands"
import { history, redo, undo } from "prosemirror-history"
import { keymap } from "prosemirror-keymap"
import { type Mark, type MarkType, type Node as PMNode, Schema } from "prosemirror-model"
import { EditorState, TextSelection, type Transaction } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { editorReturnCommand } from "../src/editorCommands"

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    code_block: { content: "text*", group: "block", code: true },
    bullet_list: { content: "list_item+", group: "block" },
    ordered_list: {
      content: "list_item+",
      group: "block",
      attrs: { order: { default: 1 } },
    },
    list_item: { content: "paragraph block*" },
    text: { group: "inline" },
  },
  marks: {
    strong: {},
    em: {},
    link: { attrs: { href: {} }, inclusive: false },
    page_reference: {
      attrs: { pageID: {}, label: { default: "" } },
      inclusive: false,
    },
  },
})

type ReturnHarness = {
  state: () => EditorState
  dispatchCount: () => number
  pressEnter: () => boolean
}

function returnHarness(doc: PMNode, selection: TextSelection, customSchema = schema): ReturnHarness {
  let state = EditorState.create({
    schema: customSchema,
    doc,
    selection,
    plugins: [
      history(),
      keymap({ Enter: editorReturnCommand(customSchema.nodes.list_item!) }),
      keymap(baseKeymap),
    ],
  })
  let dispatched = 0
  const view = {
    get state() { return state },
    dispatch(transaction: Transaction) {
      dispatched += 1
      state = state.apply(transaction)
    },
  } as unknown as EditorView

  return {
    state: () => state,
    dispatchCount: () => dispatched,
    pressEnter() {
      const event = {
        key: "Enter",
        keyCode: 13,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      } as KeyboardEvent
      return state.plugins.some(plugin => plugin.props.handleKeyDown?.(view, event) === true)
    },
  }
}

function paragraph(text = "", marks: readonly Mark[] = [], customSchema = schema): PMNode {
  return customSchema.nodes.paragraph!.create(
    null,
    text ? customSchema.text(text, marks) : undefined,
  )
}

function listItem(blocks: PMNode | readonly PMNode[], customSchema = schema): PMNode {
  return customSchema.nodes.list_item!.create(null, blocks)
}

function listDoc(
  listType: "bullet_list" | "ordered_list",
  items: readonly PMNode[],
  attrs?: { order: number },
  customSchema = schema,
): PMNode {
  return customSchema.nodes.doc!.create(
    null,
    customSchema.nodes[listType]!.create(attrs, items),
  )
}

function textPosition(doc: PMNode, text: string): number {
  let result: number | undefined
  doc.descendants((node, position) => {
    if (result === undefined && node.isText && node.text?.includes(text)) {
      result = position + node.text.indexOf(text)
      return false
    }
    return result === undefined
  })
  if (result === undefined) throw new Error(`Text not found: ${text}`)
  return result
}

function emptyParagraphPosition(doc: PMNode, occurrence = 0): number {
  let seen = 0
  let result: number | undefined
  doc.descendants((node, position) => {
    if (node.type.name === "paragraph" && node.content.size === 0) {
      if (seen === occurrence) {
        result = position + 1
        return false
      }
      seen += 1
    }
    return result === undefined
  })
  if (result === undefined) throw new Error(`Empty paragraph not found: ${occurrence}`)
  return result
}

function itemTexts(doc: PMNode): string[] {
  const texts: string[] = []
  doc.descendants(node => {
    if (node.type.name === "list_item") texts.push(node.textContent)
  })
  return texts
}

describe("native list Return behavior", () => {
  test("is installed ahead of baseKeymap without replacing list indentation keys", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")
    const returnIndex = source.indexOf('"Enter": editorReturnCommand(binding.schema.nodes.list_item!)')
    const baseKeymapIndex = source.indexOf("keymap(baseKeymap)")

    expect(returnIndex).toBeGreaterThan(-1)
    expect(baseKeymapIndex).toBeGreaterThan(returnIndex)
    expect(source).toContain('"Tab": sinkListItem(binding.schema.nodes.list_item!)')
    expect(source).toContain('"Shift-Tab": liftListItem(binding.schema.nodes.list_item!)')
  })

  test("splits a bullet item into a true sibling and places the caret at its start", () => {
    const doc = listDoc("bullet_list", [listItem(paragraph("Alpha beta"))])
    const splitAt = textPosition(doc, "Alpha beta") + "Alpha".length
    const editor = returnHarness(doc, TextSelection.create(doc, splitAt))

    expect(editor.pressEnter()).toBeTrue()

    const state = editor.state()
    const list = state.doc.child(0)
    expect(editor.dispatchCount()).toBe(1)
    expect(list.type).toBe(schema.nodes.bullet_list)
    expect(list.childCount).toBe(2)
    expect(list.child(0).textContent).toBe("Alpha")
    expect(list.child(1).textContent).toBe(" beta")
    expect(state.selection.$from.node(-1).type).toBe(schema.nodes.list_item)
    expect(state.selection.$from.parentOffset).toBe(0)
  })

  test("replaces a selected range once while splitting the item", () => {
    const doc = listDoc("bullet_list", [listItem(paragraph("Alpha beta"))])
    const start = textPosition(doc, "Alpha beta")
    const editor = returnHarness(doc, TextSelection.create(doc, start + 2, start + 6))

    expect(editor.pressEnter()).toBeTrue()

    expect(editor.dispatchCount()).toBe(1)
    expect(itemTexts(editor.state().doc)).toEqual(["Al", "beta"])
    expect(editor.state().selection.$from.parentOffset).toBe(0)
  })

  test("preserves an ordered list start and compatible active marks", () => {
    const strong = schema.marks.strong!.create()
    const link = schema.marks.link!.create({ href: "https://example.com" })
    const reference = schema.marks.page_reference!.create({ pageID: "page:one", label: "One" })
    const doc = listDoc("ordered_list", [
      listItem(paragraph("Bold", [strong, link, reference])),
    ], { order: 7 })
    const editor = returnHarness(
      doc,
      TextSelection.create(doc, textPosition(doc, "Bold") + "Bold".length),
    )

    expect(editor.pressEnter()).toBeTrue()

    const state = editor.state()
    expect(state.doc.child(0).attrs.order).toBe(7)
    expect(state.doc.child(0).childCount).toBe(2)
    expect(schema.marks.strong!.isInSet(state.storedMarks ?? [])).toBeDefined()
    expect(schema.marks.link!.isInSet(state.storedMarks ?? [])).toBeUndefined()
    expect(schema.marks.page_reference!.isInSet(state.storedMarks ?? [])).toBeUndefined()
  })

  test("exits an empty top-level list item to a paragraph through baseKeymap", () => {
    const doc = listDoc("bullet_list", [listItem(paragraph())])
    const editor = returnHarness(doc, TextSelection.create(doc, emptyParagraphPosition(doc)))

    expect(editor.pressEnter()).toBeTrue()

    const state = editor.state()
    expect(editor.dispatchCount()).toBe(1)
    expect(state.doc.childCount).toBe(1)
    expect(state.doc.child(0).type).toBe(schema.nodes.paragraph)
    expect(state.selection.$from.parent.type).toBe(schema.nodes.paragraph)
  })

  test("outdents an empty nested item by one list level", () => {
    const nested = schema.nodes.bullet_list!.create(null, [listItem(paragraph())])
    const doc = listDoc("bullet_list", [listItem([paragraph("Parent"), nested])])
    const editor = returnHarness(doc, TextSelection.create(doc, emptyParagraphPosition(doc)))

    expect(editor.pressEnter()).toBeTrue()

    const outerList = editor.state().doc.child(0)
    expect(editor.dispatchCount()).toBe(1)
    expect(outerList.childCount).toBe(2)
    expect(outerList.child(0).textContent).toBe("Parent")
    expect(outerList.child(1).textContent).toBe("")
    expect(editor.state().selection.$from.node(-1)).toBe(outerList.child(1))
  })

  test("keeps the split as one undoable and redoable history event", () => {
    const doc = listDoc("ordered_list", [listItem(paragraph("First item"))], { order: 4 })
    const original = doc.toJSON()
    const editor = returnHarness(
      doc,
      TextSelection.create(doc, textPosition(doc, "First item") + "First".length),
    )
    expect(editor.pressEnter()).toBeTrue()
    let state = editor.state()
    const split = state.doc.toJSON()

    expect(undo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.toJSON()).toEqual(original)
    expect(undo(state)).toBeFalse()
    expect(redo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.toJSON()).toEqual(split)
  })

  test("retains the existing two-stage code-block Enter behavior", () => {
    const exitingDoc = schema.nodes.doc!.create(
      null,
      schema.nodes.code_block!.create(null, schema.text("let answer = 42\n")),
    )
    const exiting = returnHarness(exitingDoc, TextSelection.atEnd(exitingDoc))
    expect(exiting.pressEnter()).toBeTrue()
    expect(exiting.state().selection.$from.parent.type).toBe(schema.nodes.paragraph)

    const newlineDoc = schema.nodes.doc!.create(
      null,
      schema.nodes.code_block!.create(null, schema.text("let answer = 42")),
    )
    const newline = returnHarness(newlineDoc, TextSelection.atEnd(newlineDoc))
    expect(newline.pressEnter()).toBeTrue()
    expect(newline.state().doc.child(0).type).toBe(schema.nodes.code_block)
    expect(newline.state().doc.child(0).textContent).toBe("let answer = 42\n")
  })

  test("round-trips and recovery-replays the split Automerge list document", () => {
    const adapter = persistenceAdapter()
    const strong = adapter.schema.marks.strong!.create()
    const doc = listDoc("bullet_list", [
      listItem(paragraph("Durable item", [strong], adapter.schema), adapter.schema),
    ], undefined, adapter.schema)
    const editor = returnHarness(
      doc,
      TextSelection.create(doc, textPosition(doc, "Durable item") + "Durable".length),
      adapter.schema,
    )
    expect(editor.pressEnter()).toBeTrue()

    const baseline = A.from({ body: "" })
    const edited = A.change(baseline, draft => {
      A.updateSpans(
        draft,
        ["body"],
        pmNodeToSpans(adapter, editor.state().doc),
        adapter.updateSpansConfig(),
      )
    })
    const saved = A.load(A.save(edited))
    const [recovered] = A.applyChanges(A.clone(baseline), A.getChanges(baseline, edited))
    const savedDoc = pmDocFromSpans(adapter, A.spans(saved, ["body"]))
    const recoveredDoc = pmDocFromSpans(adapter, A.spans(recovered, ["body"]))

    for (const reloaded of [savedDoc, recoveredDoc]) {
      expect(reloaded.child(0).type).toBe(adapter.schema.nodes.bullet_list)
      expect(itemTexts(reloaded)).toEqual(["Durable", " item"])
      expect(reloaded.rangeHasMark(
        textPosition(reloaded, "Durable"),
        textPosition(reloaded, "Durable") + "Durable".length,
        adapter.schema.marks.strong!,
      )).toBeTrue()
    }
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
      bullet_list: {
        content: "list_item+",
        group: "block",
        toDOM: () => ["ul", 0],
      },
      ordered_list: {
        content: "list_item+",
        group: "block",
        attrs: { order: { default: 1 } },
        toDOM: node => node.attrs.order === 1 ? ["ol", 0] : ["ol", { start: node.attrs.order }, 0],
      },
      list_item: {
        automerge: {
          block: { within: { bullet_list: "unordered-list-item", ordered_list: "ordered-list-item" } },
        },
        content: "paragraph block*",
        toDOM: () => ["li", 0],
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
      unknownMark: {
        automerge: { markName: "__unknown__" },
        attrs: { unknownMarks: { default: {} } },
      },
    },
  })
}
