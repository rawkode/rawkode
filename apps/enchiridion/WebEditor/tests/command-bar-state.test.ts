import { describe, expect, test } from "bun:test"
import { history, redo, undo } from "prosemirror-history"
import { Schema, type Mark, type Node as PMNode } from "prosemirror-model"
import { EditorState, TextSelection } from "prosemirror-state"
import {
  deriveCommandBarState,
  type CommandBarCommand,
  type CommandBarItemState,
} from "../src/commandBarState"

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    heading: { attrs: { level: { default: 1 } }, content: "text*", group: "block" },
    code_block: { content: "text*", marks: "", group: "block", code: true },
    blockquote: { content: "block+", group: "block" },
    bullet_list: { content: "list_item+", group: "block" },
    ordered_list: { content: "list_item+", group: "block" },
    list_item: { content: "paragraph block*" },
    text: {},
  },
  marks: {
    strong: {},
    em: {},
    code: {},
    link: { attrs: { href: {} }, inclusive: false },
    page_reference: { attrs: { pageID: {} }, inclusive: false },
  },
})

function paragraph(text: string, marks: readonly Mark[] = []): PMNode {
  return schema.nodes.paragraph!.create(null, schema.text(text, marks))
}

function editorState(doc: PMNode, from = 1, to = from): EditorState {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
    plugins: [history()],
  })
}

function stateFor(
  state: EditorState,
  overrides: Partial<{ titleFocused: boolean; bodyFocused: boolean; composing: boolean }> = {},
) {
  return deriveCommandBarState({
    editorState: state,
    titleFocused: overrides.titleFocused ?? false,
    bodyFocused: overrides.bodyFocused ?? true,
    composing: overrides.composing ?? false,
  })
}

function item(state: ReturnType<typeof deriveCommandBarState>, command: CommandBarCommand): CommandBarItemState {
  const result = state.items.find(candidate => candidate.command === command)
  if (!result) throw new Error(`Missing ${command}`)
  return result
}

describe("selection-aware command bar state", () => {
  test("uses caret stored marks and exact accessible command labels", () => {
    const doc = schema.nodes.doc!.create(null, paragraph("Draft"))
    let state = editorState(doc, 3)
    state = state.apply(state.tr.setStoredMarks([
      schema.marks.strong!.create(),
      schema.marks.code!.create(),
    ]))
    const bar = stateFor(state)

    expect(bar.visible).toBeTrue()
    expect(item(bar, "bold")).toMatchObject({ label: "Bold", pressed: true, disabled: false })
    expect(item(bar, "italic").pressed).toBeFalse()
    expect(item(bar, "inline-code")).toMatchObject({ label: "Inline code", pressed: true })
    expect(item(bar, "link-reference").label).toBe("Link or reference")
    expect(item(bar, "dismiss-keyboard")).toEqual({
      command: "dismiss-keyboard",
      label: "Dismiss keyboard",
      disabled: false,
    })
  })

  test("reports only uniformly marked selections as pressed", () => {
    const strong = schema.marks.strong!.create()
    const doc = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, [
      schema.text("Bold", [strong]),
      schema.text(" and plain"),
    ]))

    expect(item(stateFor(editorState(doc, 1, 5)), "bold").pressed).toBeTrue()
    expect(item(stateFor(editorState(doc, 1, 15)), "bold").pressed).toBeFalse()
  })

  test("derives uniform list and block styles without claiming mixed state", () => {
    const list = schema.nodes.bullet_list!.create(null, [
      schema.nodes.list_item!.create(null, paragraph("One")),
      schema.nodes.list_item!.create(null, paragraph("Two")),
    ])
    const listDoc = schema.nodes.doc!.create(null, list)
    const listBar = stateFor(editorState(listDoc, 3, 10))
    expect(item(listBar, "bullet-list").pressed).toBeTrue()
    expect(item(listBar, "blocks").label).toBe("Block style, Text")

    const heading = schema.nodes.heading!.create({ level: 2 }, schema.text("Heading"))
    const mixedDoc = schema.nodes.doc!.create(null, [heading, paragraph("Body")])
    expect(item(stateFor(editorState(mixedDoc, 2)), "blocks")).toMatchObject({
      label: "Block style, Heading 2",
      pressed: true,
    })
    expect(item(stateFor(editorState(mixedDoc, 1, 14)), "blocks")).toMatchObject({
      label: "Block style, Mixed",
      pressed: false,
    })
    expect(item(stateFor(editorState(mixedDoc, 1, 14)), "bullet-list").pressed).toBeFalse()
  })

  test("tracks undo and redo history transitions", () => {
    const doc = schema.nodes.doc!.create(null, paragraph("Draft"))
    let state = editorState(doc, 6)
    expect(item(stateFor(state), "undo").disabled).toBeTrue()
    expect(item(stateFor(state), "redo").disabled).toBeTrue()

    state = state.apply(state.tr.insertText("!"))
    expect(item(stateFor(state), "undo").disabled).toBeFalse()
    expect(item(stateFor(state), "redo").disabled).toBeTrue()

    expect(undo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(item(stateFor(state), "undo").disabled).toBeTrue()
    expect(item(stateFor(state), "redo").disabled).toBeFalse()

    expect(redo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(item(stateFor(state), "undo").disabled).toBeFalse()
    expect(item(stateFor(state), "redo").disabled).toBeTrue()
  })

  test("disables body commands for title focus and structural commands during composition", () => {
    const doc = schema.nodes.doc!.create(null, paragraph("Draft"))
    const state = editorState(doc, 3).apply(editorState(doc, 3).tr.insertText("!"))
    const titleBar = stateFor(state, { titleFocused: true, bodyFocused: false })
    for (const command of titleBar.items) {
      expect(command.disabled).toBe(command.command !== "dismiss-keyboard")
    }

    const composingBar = stateFor(state, { composing: true })
    for (const command of ["undo", "redo", "blocks", "bullet-list", "link-reference"] as const) {
      expect(item(composingBar, command).disabled).toBeTrue()
    }
    for (const command of ["bold", "italic", "inline-code"] as const) {
      expect(item(composingBar, command).disabled).toBeFalse()
    }
  })
})
