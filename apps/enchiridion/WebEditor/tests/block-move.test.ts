import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { next as A } from "@automerge/automerge"
import { pmDocFromSpans, pmNodeToSpans, SchemaAdapter } from "@automerge/prosemirror"
import { history, redo, undo } from "prosemirror-history"
import { Schema, type Mark, type Node as PMNode } from "prosemirror-model"
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state"
import { moveBlock, type BlockMoveDirection } from "../src/editorCommands"

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: { attrs: { level: { default: 1 } }, content: "inline*", group: "block" },
    blockquote: { content: "block+", group: "block" },
    code_block: { content: "text*", marks: "", group: "block", code: true },
    bullet_list: { content: "list_item+", group: "block" },
    ordered_list: { attrs: { order: { default: 1 } }, content: "list_item+", group: "block" },
    list_item: { content: "paragraph block*" },
    horizontal_rule: { group: "block", atom: true },
    bookmark: {
      attrs: {
        url: { default: "" },
        title: { default: "" },
        summary: { default: "" },
        imageURL: { default: "" },
      },
      group: "block",
      atom: true,
    },
    youtube: {
      attrs: { videoID: { default: "" }, url: { default: "" }, title: { default: "" } },
      group: "block",
      atom: true,
    },
    text: { group: "inline" },
  },
  marks: {
    strong: {},
    link: { attrs: { href: {}, title: { default: null } }, inclusive: false },
    page_reference: { attrs: { pageID: {}, label: { default: "" } }, inclusive: false },
  },
})

describe("structural block movement", () => {
  test("moves every supported top-level block type without changing its identity", () => {
    const strong = schema.marks.strong!.create()
    const link = schema.marks.link!.create({ href: "https://example.com", title: "Reference" })
    const pageReference = schema.marks.page_reference!.create({ pageID: "page:identity", label: "Identity" })
    const candidates = [
      paragraph("Marked paragraph", [strong, link]),
      schema.nodes.heading!.create({ level: 3 }, schema.text("Identity heading", [strong, pageReference])),
      schema.nodes.blockquote!.create(null, paragraph("Quoted detail", [link])),
      schema.nodes.code_block!.create(null, schema.text("let preserved = true")),
      schema.nodes.horizontal_rule!.create(),
      schema.nodes.bookmark!.create({
        url: "https://example.com/story",
        title: "Story",
        summary: "Preserved summary",
        imageURL: "https://example.com/image.png",
      }),
      schema.nodes.youtube!.create({
        videoID: "video-123",
        url: "https://youtube.com/watch?v=video-123",
        title: "Preserved video",
      }),
    ]

    for (const candidate of candidates) {
      const doc = schema.nodes.doc!.create(null, [paragraph("Before"), candidate, paragraph("After")])
      const selection = candidate.isAtom
        ? NodeSelection.create(doc, topLevelStart(doc, 1))
        : TextSelection.create(doc, textPosition(doc, candidate.textContent) + 1)
      const result = applyMove(EditorState.create({ doc, selection }), -1)

      expect(result.handled).toBeTrue()
      expect(result.transactions).toBe(1)
      expect(result.state.doc.childCount).toBe(3)
      expect(result.state.doc.child(0).eq(candidate)).toBeTrue()
      expect(result.state.doc.child(1).textContent).toBe("Before")
      expect(result.state.doc.child(2).textContent).toBe("After")
    }
  })

  test("moves a consecutive top-level selection together and preserves its direction", () => {
    const doc = schema.nodes.doc!.create(null, [
      paragraph("Alpha"),
      schema.nodes.heading!.create({ level: 2 }, schema.text("Bravo")),
      schema.nodes.blockquote!.create(null, paragraph("Charlie")),
      schema.nodes.code_block!.create(null, schema.text("Delta")),
    ])
    const anchor = textPosition(doc, "Charlie") + 3
    const head = textPosition(doc, "Bravo") + 2
    const selection = TextSelection.create(doc, anchor, head)
    const delta = doc.child(3).nodeSize
    const result = applyMove(EditorState.create({ doc, selection }), 1)

    expect(result.handled).toBeTrue()
    expect(topLevelTexts(result.state.doc)).toEqual(["Alpha", "Delta", "Bravo", "Charlie"])
    expect(result.state.selection.anchor).toBe(anchor + delta)
    expect(result.state.selection.head).toBe(head + delta)
    expect(result.state.doc.childCount).toBe(doc.childCount)
  })

  test("moves ordered-list items only among their siblings and preserves starts and nesting", () => {
    const nested = list("bullet_list", [listItem("Inner A"), listItem("Inner B")])
    const second = schema.nodes.list_item!.create(null, [paragraph("Second"), nested])
    const ordered = list("ordered_list", [listItem("First"), second, listItem("Third")], { order: 7 })
    const doc = schema.nodes.doc!.create(null, ordered)
    const caret = textPosition(doc, "Second") + 3
    const beforeOffset = EditorState.create({ doc, selection: TextSelection.create(doc, caret) })
      .selection.$from.parentOffset
    const result = applyMove(EditorState.create({ doc, selection: TextSelection.create(doc, caret) }), -1)
    const movedList = result.state.doc.child(0)

    expect(result.handled).toBeTrue()
    expect(movedList.type).toBe(schema.nodes.ordered_list)
    expect(movedList.attrs.order).toBe(7)
    expect(listItemTexts(movedList)).toEqual(["SecondInner AInner B", "First", "Third"])
    expect(movedList.child(0).child(1).type).toBe(schema.nodes.bullet_list)
    expect(listItemTexts(movedList.child(0).child(1))).toEqual(["Inner A", "Inner B"])
    expect(result.state.selection.$from.parentOffset).toBe(beforeOffset)
  })

  test("moves a nested item inside its own list without moving or reparenting the outer item", () => {
    const nested = list("bullet_list", [listItem("Inner A"), listItem("Inner B")])
    const outer = list("ordered_list", [
      schema.nodes.list_item!.create(null, [paragraph("Outer"), nested]),
      listItem("Outer sibling"),
    ], { order: 3 })
    const doc = schema.nodes.doc!.create(null, outer)
    const result = applyMove(EditorState.create({
      doc,
      selection: TextSelection.create(doc, textPosition(doc, "Inner B") + 2),
    }), -1)
    const movedOuter = result.state.doc.child(0)

    expect(result.handled).toBeTrue()
    expect(movedOuter.attrs.order).toBe(3)
    expect(movedOuter.childCount).toBe(2)
    expect(movedOuter.child(0).child(0).textContent).toBe("Outer")
    expect(listItemTexts(movedOuter.child(0).child(1))).toEqual(["Inner B", "Inner A"])
    expect(movedOuter.child(1).textContent).toBe("Outer sibling")
  })

  test("moves consecutive list items as one group", () => {
    const items = ["Alpha", "Bravo", "Charlie", "Delta"].map(text => listItem(text))
    const doc = schema.nodes.doc!.create(null, list("bullet_list", items))
    const anchor = textPosition(doc, "Bravo") + 1
    const head = textPosition(doc, "Charlie") + 3
    const delta = items[3]!.nodeSize
    const result = applyMove(EditorState.create({
      doc,
      selection: TextSelection.create(doc, anchor, head),
    }), 1)

    expect(result.handled).toBeTrue()
    expect(listItemTexts(result.state.doc.child(0))).toEqual(["Alpha", "Delta", "Bravo", "Charlie"])
    expect(result.state.selection.anchor).toBe(anchor + delta)
    expect(result.state.selection.head).toBe(head + delta)
  })

  test("rejects cross-list, cross-parent, and mixed top-level ranges", () => {
    const nested = list("bullet_list", [listItem("Nested")])
    const separateLists = schema.nodes.doc!.create(null, [
      list("bullet_list", [listItem("First list")]),
      list("bullet_list", [listItem("Second list")]),
    ])
    const crossList = EditorState.create({
      doc: separateLists,
      selection: TextSelection.create(
        separateLists,
        textPosition(separateLists, "First list") + 1,
        textPosition(separateLists, "Second list") + 1,
      ),
    })
    expectUnchanged(crossList, 1)

    const nestedDoc = schema.nodes.doc!.create(null, list("bullet_list", [
      schema.nodes.list_item!.create(null, [paragraph("Outer"), nested]),
      listItem("Sibling"),
    ]))
    const crossParent = EditorState.create({
      doc: nestedDoc,
      selection: TextSelection.create(
        nestedDoc,
        textPosition(nestedDoc, "Outer") + 1,
        textPosition(nestedDoc, "Nested") + 1,
      ),
    })
    expectUnchanged(crossParent, 1)

    const mixedDoc = schema.nodes.doc!.create(null, [
      paragraph("Before list"),
      list("bullet_list", [listItem("List item")]),
      paragraph("After list"),
      paragraph("Tail"),
    ])
    const mixed = EditorState.create({
      doc: mixedDoc,
      selection: TextSelection.create(
        mixedDoc,
        textPosition(mixedDoc, "Before list") + 1,
        textPosition(mixedDoc, "After list") + 1,
      ),
    })
    expectUnchanged(mixed, 1)
  })

  test("returns false without a transaction at top-level and list boundaries", () => {
    const top = schema.nodes.doc!.create(null, [paragraph("First"), paragraph("Last")])
    expectUnchanged(EditorState.create({
      doc: top,
      selection: TextSelection.create(top, textPosition(top, "First") + 1),
    }), -1)
    expectUnchanged(EditorState.create({
      doc: top,
      selection: TextSelection.create(top, textPosition(top, "Last") + 1),
    }), 1)

    const listDoc = schema.nodes.doc!.create(null, list("bullet_list", [listItem("Only")]))
    const listState = EditorState.create({
      doc: listDoc,
      selection: TextSelection.create(listDoc, textPosition(listDoc, "Only") + 1),
    })
    expectUnchanged(listState, -1)
    expectUnchanged(listState, 1)
  })

  test("records exactly one undoable and redoable history event", () => {
    const doc = schema.nodes.doc!.create(null, [paragraph("Alpha"), paragraph("Bravo"), paragraph("Charlie")])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, textPosition(doc, "Bravo") + 2),
      plugins: [history()],
    })

    expect(moveBlock(1)(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(topLevelTexts(state.doc)).toEqual(["Alpha", "Charlie", "Bravo"])
    expect(undo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.eq(doc)).toBeTrue()
    expect(undo(state, transaction => { state = state.apply(transaction) })).toBeFalse()
    expect(redo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(topLevelTexts(state.doc)).toEqual(["Alpha", "Charlie", "Bravo"])
  })

  test("round-trips moved order and identity marks through save and recovery replay", () => {
    const adapter = persistenceAdapter()
    const identity = adapter.schema.marks.page_reference!.create({ pageID: "page:durable", label: "Durable" })
    const strong = adapter.schema.marks.strong!.create()
    const source = adapter.schema.nodes.doc!.create(null, [
      adapter.schema.nodes.paragraph!.create(null, adapter.schema.text("First")),
      adapter.schema.nodes.paragraph!.create(null, adapter.schema.text("Durable", [identity, strong])),
      adapter.schema.nodes.paragraph!.create(null, adapter.schema.text("Last")),
    ])
    const moved = applyMove(EditorState.create({
      doc: source,
      selection: TextSelection.create(source, textPosition(source, "Durable") + 2),
    }), -1).state.doc

    let baseline = A.from({ body: "" })
    baseline = A.change(baseline, draft => {
      A.updateSpans(draft, ["body"], pmNodeToSpans(adapter, source), adapter.updateSpansConfig())
    })
    const edited = A.change(A.clone(baseline), draft => {
      A.updateSpans(draft, ["body"], pmNodeToSpans(adapter, moved), adapter.updateSpansConfig())
    })
    const saved = A.load(A.save(edited))
    const [recovered] = A.applyChanges(A.clone(baseline), A.getChanges(baseline, edited))

    for (const document of [saved, recovered]) {
      const reloaded = pmDocFromSpans(adapter, A.spans(document, ["body"]))
      expect(topLevelTexts(reloaded)).toEqual(["Durable", "First", "Last"])
      const from = textPosition(reloaded, "Durable")
      expect(reloaded.rangeHasMark(from, from + "Durable".length, adapter.schema.marks.strong!)).toBeTrue()
      expect(adapter.schema.marks.page_reference!.isInSet(reloaded.nodeAt(from)!.marks)?.attrs).toEqual({
        pageID: "page:durable",
        label: "Durable",
      })
    }
  })

  test("uses the command itself for palette availability and action, then restores focus", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")
    const style = readFileSync(new URL("../src/style.css", import.meta.url), "utf8")

    expect(source).toContain('"Mod-Alt-ArrowUp": moveBlock(-1)')
    expect(source).toContain('"Mod-Alt-ArrowDown": moveBlock(1)')
    expect(source).toContain("const command = moveBlock(direction)")
    expect(source).toContain("disabled: !command(editorView.state)")
    expect(source).toContain("action: run(command)")
    expect(source).toMatch(/command\(editorView\.state, editorView\.dispatch, editorView\)\s*\n\s*editorView\.focus\(\)/)
    expect(source).toContain('move(-1, "Move block up")')
    expect(source).toContain('move(1, "Move block down")')
    expect(style).toContain(".palette button:disabled")
    expect(style).not.toContain("cursor: grab")
    expect(style).not.toContain('content: "⠿"')
  })
})

function paragraph(text: string, marks: readonly Mark[] = [], customSchema = schema): PMNode {
  return customSchema.nodes.paragraph!.create(null, text ? customSchema.text(text, marks) : undefined)
}

function listItem(text: string, customSchema = schema): PMNode {
  return customSchema.nodes.list_item!.create(null, paragraph(text, [], customSchema))
}

function list(
  type: "bullet_list" | "ordered_list",
  items: readonly PMNode[],
  attrs?: { order: number },
  customSchema = schema,
): PMNode {
  return customSchema.nodes[type]!.create(attrs, items)
}

function applyMove(state: EditorState, direction: BlockMoveDirection): {
  state: EditorState
  handled: boolean
  transactions: number
} {
  let transactions = 0
  const handled = moveBlock(direction)(state, transaction => {
    transactions += 1
    state = state.apply(transaction)
  })
  return { state, handled, transactions }
}

function expectUnchanged(state: EditorState, direction: BlockMoveDirection): void {
  const originalDoc = state.doc
  const originalSelection = state.selection
  const result = applyMove(state, direction)
  expect(result.handled).toBeFalse()
  expect(result.transactions).toBe(0)
  expect(result.state.doc.eq(originalDoc)).toBeTrue()
  expect(result.state.selection.eq(originalSelection)).toBeTrue()
}

function topLevelStart(doc: PMNode, index: number): number {
  let position = 0
  for (let childIndex = 0; childIndex < index; childIndex += 1) position += doc.child(childIndex).nodeSize
  return position
}

function textPosition(doc: PMNode, text: string): number {
  let result = -1
  doc.descendants((node, position) => {
    if (result !== -1 || !node.isText) return result === -1
    const index = node.text?.indexOf(text) ?? -1
    if (index !== -1) result = position + index
    return result === -1
  })
  if (result === -1) throw new Error(`Missing text: ${text}`)
  return result
}

function topLevelTexts(doc: PMNode): string[] {
  return Array.from({ length: doc.childCount }, (_, index) => doc.child(index).textContent)
}

function listItemTexts(listNode: PMNode): string[] {
  return Array.from({ length: listNode.childCount }, (_, index) => listNode.child(index).textContent)
}

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
      page_reference: {
        automerge: {
          markName: "__ext__dev.rawkode.enchiridion.page-reference",
          parsers: {
            fromAutomerge: value => typeof value === "string" ? JSON.parse(value) : {},
            fromProsemirror: mark => JSON.stringify(mark.attrs),
          },
        },
        attrs: { pageID: {}, label: { default: "" } },
        inclusive: false,
      },
      unknownMark: {
        automerge: { markName: "__unknown__" },
        attrs: { unknownMarks: { default: {} } },
      },
    },
  })
}
