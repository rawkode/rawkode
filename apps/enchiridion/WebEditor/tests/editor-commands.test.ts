import { describe, expect, test } from "bun:test"
import { next as A } from "@automerge/automerge"
import { SchemaAdapter } from "@automerge/prosemirror"
import { Schema } from "prosemirror-model"
import { EditorState, TextSelection } from "prosemirror-state"
import {
  exitCodeBlockOnEmptyLine,
  filterCommands,
  markSelectedText,
  movePaletteSelection,
  moveBelowCodeBlock,
  placePalette,
  persistSelectedMark,
  showsEditorCommandBar,
  slashCommandQuery,
} from "../src/editorCommands"

const referenceMarkName = "__ext__dev.rawkode.enchiridion.page-reference"

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    code_block: { content: "text*", group: "block", code: true },
    text: {},
  },
  marks: {
    page_reference: {
      attrs: { pageID: {}, label: { default: "" } },
    },
  },
})

describe("unified editor chrome", () => {
  test("shows the unified command bar while the editor is focused", () => {
    expect(showsEditorCommandBar(true)).toBeTrue()
  })

  test("stays hidden while the editor is not focused", () => {
    expect(showsEditorCommandBar(false)).toBeFalse()
  })
})

describe("slash command palette", () => {
  const commands = [
    { label: "Heading 1", detail: "Page section", keywords: ["h1", "title"] },
    { label: "Bulleted list", detail: "Unordered items", keywords: ["bullet"] },
    { label: "Divider", detail: "Separate sections", keywords: ["horizontal rule"] },
  ]

  test("filters across labels, details, and keywords", () => {
    expect(filterCommands(commands, "heading").map(command => command.label)).toEqual(["Heading 1"])
    expect(filterCommands(commands, "unordered").map(command => command.label)).toEqual(["Bulleted list"])
    expect(filterCommands(commands, "HORIZONTAL rule").map(command => command.label)).toEqual(["Divider"])
  })

  test("keeps all commands for an empty query", () => {
    expect(filterCommands(commands, "  ")).toEqual(commands)
  })

  test("moves the active option with wraparound", () => {
    expect(movePaletteSelection(0, 3, -1)).toBe(2)
    expect(movePaletteSelection(2, 3, 1)).toBe(0)
    expect(movePaletteSelection(-1, 3, 1)).toBe(0)
    expect(movePaletteSelection(-1, 3, -1)).toBe(2)
    expect(movePaletteSelection(0, 0, 1)).toBe(-1)
  })

  test("reads only text following the slash trigger", () => {
    expect(slashCommandQuery("/heading")).toBe("heading")
    expect(slashCommandQuery("heading")).toBeUndefined()
  })

  test("places the palette below the caret when space is available", () => {
    expect(placePalette(
      { left: 100, top: 80, bottom: 100 },
      { width: 240, height: 180 },
      { left: 0, top: 0, width: 800, height: 600 },
    )).toEqual({ left: 100, top: 106 })
  })

  test("places the palette above and clamps it inside a narrow viewport", () => {
    expect(placePalette(
      { left: 360, top: 500, bottom: 520 },
      { width: 280, height: 240 },
      { left: 0, top: 0, width: 390, height: 600 },
    )).toEqual({ left: 102, top: 254 })
  })
})

describe("selected text supertags", () => {
  test("marks the selection without replacing its visible text", () => {
    const paragraph = schema.nodes.paragraph!.create(null, schema.text("Personal training"))
    const doc = schema.nodes.doc!.create(null, paragraph)
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 9),
    })

    const command = markSelectedText(schema.marks.page_reference!, {
      pageID: "page:training",
      label: "Training",
    })
    expect(command(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.textContent).toBe("Personal training")
    expect(state.doc.rangeHasMark(1, 9, schema.marks.page_reference!)).toBeTrue()
    expect(state.doc.nodeAt(1)?.marks[0]?.attrs.pageID).toBe("page:training")
  })

  test("does nothing without selected text", () => {
    const paragraph = schema.nodes.paragraph!.create(null, schema.text("Personal training"))
    const doc = schema.nodes.doc!.create(null, paragraph)
    const state = EditorState.create({ doc, selection: TextSelection.atEnd(doc) })

    expect(markSelectedText(schema.marks.page_reference!)(state)).toBeFalse()
  })

  test("persists the entity identity as an Automerge mark", () => {
    const adapter = new SchemaAdapter({
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
        page_reference: {
          automerge: {
            markName: referenceMarkName,
            parsers: {
              fromAutomerge: value => typeof value === "string" ? JSON.parse(value) : {},
              fromProsemirror: mark => JSON.stringify(mark.attrs),
            },
          },
          attrs: { pageID: {}, label: { default: "" } },
        },
        unknownMark: {
          automerge: { markName: "__unknown__" },
          attrs: { unknownMarks: { default: {} } },
        },
      },
    })
    const paragraph = adapter.schema.nodes.paragraph!.create(null, adapter.schema.text("Dr. Rosbottom"))
    const doc = adapter.schema.nodes.doc!.create(null, paragraph)
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 14) })
    let automergeDocument = A.from({ body: "" })
    const handle = {
      change: (change: (document: { body: string }) => void) => {
        automergeDocument = A.change(automergeDocument, change)
      },
    }

    expect(persistSelectedMark(
      handle,
      ["body"],
      adapter,
      state,
      adapter.schema.marks.page_reference!,
      { pageID: "person:rossbottom", label: "Dr. Rosbottom" },
    )).toBeTrue()

    const mark = A.marks(automergeDocument, ["body"]).find(candidate => candidate.name === referenceMarkName)
    expect(mark).toBeDefined()
    expect(mark?.value).toBe(JSON.stringify({ pageID: "person:rossbottom", label: "Dr. Rosbottom" }))
  })
})

describe("code block keyboard behavior", () => {
  test("Enter on an empty final code line creates a paragraph below", () => {
    const code = schema.nodes.code_block!.create(null, schema.text("let answer = 42\n"))
    const doc = schema.nodes.doc!.create(null, code)
    let state = EditorState.create({ doc, selection: TextSelection.atEnd(doc) })

    expect(exitCodeBlockOnEmptyLine(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.childCount).toBe(2)
    expect(state.doc.child(1).type).toBe(schema.nodes.paragraph)
    expect(state.selection.$from.parent.type).toBe(schema.nodes.paragraph)
  })

  test("Enter after code text remains inside the code block", () => {
    const code = schema.nodes.code_block!.create(null, schema.text("let answer = 42"))
    const doc = schema.nodes.doc!.create(null, code)
    const state = EditorState.create({ doc, selection: TextSelection.atEnd(doc) })

    expect(exitCodeBlockOnEmptyLine(state)).toBeFalse()
  })

  test("Down Arrow at the end creates a paragraph below the code block", () => {
    const code = schema.nodes.code_block!.create(null, schema.text("let answer = 42"))
    const doc = schema.nodes.doc!.create(null, code)
    let state = EditorState.create({ doc, selection: TextSelection.atEnd(doc) })

    expect(moveBelowCodeBlock(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.childCount).toBe(2)
    expect(state.selection.$from.parent.type).toBe(schema.nodes.paragraph)
  })

  test("Down Arrow moves into an existing paragraph without adding another", () => {
    const code = schema.nodes.code_block!.create(null, schema.text("let answer = 42"))
    const paragraph = schema.nodes.paragraph!.create(null, schema.text("Existing paragraph"))
    const doc = schema.nodes.doc!.create(null, [code, paragraph])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, code.nodeSize - 1),
    })

    expect(moveBelowCodeBlock(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(state.doc.childCount).toBe(2)
    expect(state.selection.$from.parent.type).toBe(schema.nodes.paragraph)
    expect(state.selection.$from.parentOffset).toBe(0)
  })
})
