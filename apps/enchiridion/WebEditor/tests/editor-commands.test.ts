import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { next as A } from "@automerge/automerge"
import { pmDocFromSpans, pmNodeToSpans, SchemaAdapter } from "@automerge/prosemirror"
import { baseKeymap } from "prosemirror-commands"
import { history, redo, undo } from "prosemirror-history"
import { Schema, type Node as PMNode } from "prosemirror-model"
import { EditorState, TextSelection } from "prosemirror-state"
import {
  exitCodeBlockOnEmptyLine,
  filterCommands,
  hardBreakNodeSpec,
  insertSoftLineBreak,
  linkEditTransaction,
  markSelectedText,
  movePaletteSelection,
  moveBelowCodeBlock,
  placePalette,
  persistSelectedMark,
  resolveLinkEditTarget,
  selectedTextTaskPlan,
  showsEditorCommandBar,
  SOFT_LINE_BREAK_BLOCK,
  slashCommandQuery,
  validateHTTPURL,
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
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
    },
    page_reference: {
      attrs: { pageID: {}, label: { default: "" } },
    },
  },
})

function softLineBreakAdapter(includeLineBreak = true): SchemaAdapter {
  return new SchemaAdapter({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        automerge: { block: "paragraph" },
        content: "inline*",
        group: "block",
        toDOM: () => ["p", 0],
      },
      heading: {
        automerge: { block: "heading" },
        attrs: { level: { default: 1 } },
        content: "inline*",
        group: "block",
        toDOM: node => [`h${node.attrs.level}`, 0],
      },
      blockquote: {
        automerge: { block: "blockquote" },
        content: "block+",
        group: "block",
        toDOM: () => ["blockquote", 0],
      },
      code_block: {
        automerge: { block: "code-block" },
        content: "text*",
        marks: "",
        group: "block",
        code: true,
        toDOM: () => ["pre", ["code", 0]],
      },
      bullet_list: {
        content: "list_item+",
        group: "block",
        toDOM: () => ["ul", 0],
      },
      ordered_list: {
        content: "list_item+",
        group: "block",
        toDOM: () => ["ol", 0],
      },
      list_item: {
        automerge: {
          block: { within: { bullet_list: "unordered-list-item", ordered_list: "ordered-list-item" } },
        },
        content: "paragraph block*",
        toDOM: () => ["li", 0],
      },
      ...(includeLineBreak ? { hard_break: hardBreakNodeSpec } : {}),
      unknownBlock: {
        automerge: { unknownBlock: true },
        content: "block+",
        group: "block",
        toDOM: () => ["div", 0],
      },
      text: { group: "inline" },
    },
    marks: {
      strong: { automerge: { markName: "strong" } },
      link: {
        automerge: { markName: "link" },
        attrs: { href: {} },
        inclusive: false,
      },
      page_reference: {
        automerge: { markName: referenceMarkName },
        attrs: { pageID: {} },
        inclusive: false,
      },
    },
  })
}

function firstTextPosition(doc: PMNode, offset: number): number {
  let position: number | undefined
  doc.descendants((node, nodePosition) => {
    if (!node.isText || position !== undefined) return
    position = nodePosition + offset
  })
  if (position === undefined) throw new Error("Expected text content")
  return position
}

function countNodes(doc: PMNode, nodeName: string): number {
  let count = 0
  doc.descendants(node => { if (node.type.name === nodeName) count += 1 })
  return count
}

describe("web link editing", () => {
  test("accepts only complete HTTP and HTTPS addresses", () => {
    expect(validateHTTPURL("  https://example.com/path  ")).toEqual({
      ok: true,
      href: "https://example.com/path",
    })
    expect(validateHTTPURL("http://localhost:8080").ok).toBeTrue()
    expect(validateHTTPURL("mailto:hello@example.com")).toEqual({
      ok: false,
      message: "Use a complete http:// or https:// address.",
    })
    expect(validateHTTPURL("example.com").ok).toBeFalse()
    expect(validateHTTPURL("   ")).toEqual({ ok: false, message: "Enter a web address." })
  })

  test("marks selected prose without changing its text or selection", () => {
    const paragraph = schema.nodes.paragraph!.create(null, schema.text("Read the reference"))
    const doc = schema.nodes.doc!.create(null, paragraph)
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 19) })
    const resolution = resolveLinkEditTarget(
      state,
      schema.marks.link!,
      [schema.marks.page_reference!],
    )

    expect(resolution.ok).toBeTrue()
    if (!resolution.ok) return
    const transaction = linkEditTransaction(
      state,
      resolution.target,
      schema.marks.link!,
      "https://example.com/reference",
    )
    expect(transaction).toBeDefined()
    state = state.apply(transaction!)

    expect(state.doc.textContent).toBe("Read the reference")
    expect({ from: state.selection.from, to: state.selection.to }).toEqual({ from: 1, to: 19 })
    const marks = state.doc.nodeAt(1)?.marks.filter(mark => mark.type === schema.marks.link)
    expect(marks).toHaveLength(1)
    expect(marks?.[0]?.attrs.href).toBe("https://example.com/reference")
  })

  test("finds the whole existing link from a caret inside it", () => {
    const link = schema.marks.link!.create({ href: "https://old.example" })
    const paragraph = schema.nodes.paragraph!.create(null, schema.text("Linked prose", [link]))
    const doc = schema.nodes.doc!.create(null, paragraph)
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 5) })

    expect(resolveLinkEditTarget(state, schema.marks.link!, [schema.marks.page_reference!])).toEqual({
      ok: true,
      target: {
        kind: "edit",
        from: 1,
        to: 13,
        href: "https://old.example",
      },
    })
  })

  test("updates and removes a link as one undoable transaction", () => {
    const link = schema.marks.link!.create({ href: "https://old.example" })
    const paragraph = schema.nodes.paragraph!.create(null, schema.text("Linked prose", [link]))
    const doc = schema.nodes.doc!.create(null, paragraph)
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 5),
      plugins: [history()],
    })
    const resolution = resolveLinkEditTarget(state, schema.marks.link!)
    expect(resolution.ok).toBeTrue()
    if (!resolution.ok) return

    state = state.apply(linkEditTransaction(
      state,
      resolution.target,
      schema.marks.link!,
      "https://new.example",
    )!)
    expect(schema.marks.link!.isInSet(state.doc.nodeAt(1)!.marks)?.attrs.href).toBe("https://new.example")
    expect(undo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(schema.marks.link!.isInSet(state.doc.nodeAt(1)!.marks)?.attrs.href).toBe("https://old.example")
    expect(redo(state, transaction => { state = state.apply(transaction) })).toBeTrue()

    const editAgain = resolveLinkEditTarget(state, schema.marks.link!)
    expect(editAgain.ok).toBeTrue()
    if (!editAgain.ok) return
    state = state.apply(linkEditTransaction(state, editAgain.target, schema.marks.link!)!)
    expect(schema.marks.link!.isInSet(state.doc.nodeAt(1)!.marks)).toBeUndefined()
    expect(state.doc.textContent).toBe("Linked prose")
  })

  test("rejects mixed link ranges and page-reference identity marks", () => {
    const link = schema.marks.link!.create({ href: "https://example.com" })
    const reference = schema.marks.page_reference!.create({ pageID: "page:one", label: "One" })
    const mixedParagraph = schema.nodes.paragraph!.create(null, [
      schema.text("Linked", [link]),
      schema.text(" and plain"),
    ])
    const mixedDoc = schema.nodes.doc!.create(null, mixedParagraph)
    const mixedState = EditorState.create({
      doc: mixedDoc,
      selection: TextSelection.create(mixedDoc, 1, 17),
    })
    expect(resolveLinkEditTarget(mixedState, schema.marks.link!, [schema.marks.page_reference!])).toEqual({
      ok: false,
      reason: "ambiguous-link-range",
    })

    const referenceParagraph = schema.nodes.paragraph!.create(null, schema.text("Identity", [reference]))
    const referenceDoc = schema.nodes.doc!.create(null, referenceParagraph)
    const referenceState = EditorState.create({
      doc: referenceDoc,
      selection: TextSelection.create(referenceDoc, 1, 9),
    })
    expect(resolveLinkEditTarget(referenceState, schema.marks.link!, [schema.marks.page_reference!])).toEqual({
      ok: false,
      reason: "identity-mark",
    })
  })

  test("persists links through saved snapshots and replayed recovery changes", () => {
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
        link: {
          automerge: {
            markName: "link",
            parsers: {
              fromAutomerge: value => typeof value === "string" ? JSON.parse(value) : {},
              fromProsemirror: mark => JSON.stringify(mark.attrs),
            },
          },
          attrs: { href: {}, title: { default: null } },
        },
        unknownMark: {
          automerge: { markName: "__unknown__" },
          attrs: { unknownMarks: { default: {} } },
        },
      },
    })
    const paragraph = adapter.schema.nodes.paragraph!.create(null, adapter.schema.text("Durable link"))
    const doc = adapter.schema.nodes.doc!.create(null, paragraph)
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 13) })
    const baseline = A.from({ body: "" })
    let edited = A.clone(baseline)
    const handle = {
      change: (change: (document: { body: string }) => void) => {
        edited = A.change(edited, change)
      },
    }

    expect(persistSelectedMark(
      handle,
      ["body"],
      adapter,
      state,
      adapter.schema.marks.link!,
      { href: "https://example.com/durable" },
    )).toBeTrue()

    const saved = A.load(A.save(edited))
    expect(A.marks(saved, ["body"])[0]?.value).toBe(JSON.stringify({
      href: "https://example.com/durable",
      title: null,
    }))
    const [recovered] = A.applyChanges(A.clone(baseline), A.getChanges(baseline, edited))
    expect(A.marks(recovered, ["body"])[0]?.value).toBe(JSON.stringify({
      href: "https://example.com/durable",
      title: null,
    }))
  })
})

describe("unified editor chrome", () => {
  test("shows the unified command bar while the editor is focused", () => {
    expect(showsEditorCommandBar(true)).toBeTrue()
  })

  test("stays hidden while the editor is not focused", () => {
    expect(showsEditorCommandBar(false)).toBeFalse()
  })
})

describe("soft line breaks", () => {
  const adapter = softLineBreakAdapter()
  const editorSchema = adapter.schema
  const textblock = () => editorSchema.nodes.paragraph!.create(null, editorSchema.text("BeforeAfter"))
  const cases = [
    {
      name: "paragraph",
      path: ["paragraph"],
      doc: () => editorSchema.nodes.doc!.create(null, textblock()),
    },
    {
      name: "heading",
      path: ["heading"],
      doc: () => editorSchema.nodes.doc!.create(
        null,
        editorSchema.nodes.heading!.create({ level: 2 }, editorSchema.text("BeforeAfter")),
      ),
    },
    {
      name: "quote",
      path: ["blockquote", "paragraph"],
      doc: () => editorSchema.nodes.doc!.create(
        null,
        editorSchema.nodes.blockquote!.create(null, textblock()),
      ),
    },
    {
      name: "bulleted list item",
      path: ["bullet_list", "list_item", "paragraph"],
      doc: () => editorSchema.nodes.doc!.create(
        null,
        editorSchema.nodes.bullet_list!.create(
          null,
          editorSchema.nodes.list_item!.create(null, textblock()),
        ),
      ),
    },
    {
      name: "numbered list item",
      path: ["ordered_list", "list_item", "paragraph"],
      doc: () => editorSchema.nodes.doc!.create(
        null,
        editorSchema.nodes.ordered_list!.create(
          null,
          editorSchema.nodes.list_item!.create(null, textblock()),
        ),
      ),
    },
  ]

  for (const example of cases) {
    test(`stays inside the same ${example.name}`, () => {
      const doc = example.doc()
      let state = EditorState.create({
        doc,
        selection: TextSelection.create(doc, firstTextPosition(doc, "Before".length)),
      })
      let dispatchCount = 0

      expect(insertSoftLineBreak(editorSchema.nodes.hard_break!)(state, transaction => {
        dispatchCount += 1
        state = state.apply(transaction)
      })).toBeTrue()

      const path: string[] = []
      let node = state.doc
      while (!node.isTextblock) {
        node = node.firstChild!
        path.push(node.type.name)
      }
      expect(path).toEqual(example.path)
      expect(countNodes(state.doc, "hard_break")).toBe(1)
      expect(state.doc.textContent).toBe("BeforeAfter")
      expect(dispatchCount).toBe(1)
    })
  }

  test("replaces a text selection with one break in one transaction", () => {
    const paragraph = editorSchema.nodes.paragraph!.create(
      null,
      editorSchema.text("Before selected after"),
    )
    const doc = editorSchema.nodes.doc!.create(null, paragraph)
    const from = firstTextPosition(doc, "Before ".length)
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, from, from + "selected ".length),
    })
    let dispatchCount = 0

    expect(insertSoftLineBreak(editorSchema.nodes.hard_break!)(state, transaction => {
      dispatchCount += 1
      state = state.apply(transaction)
    })).toBeTrue()

    expect(state.doc.textContent).toBe("Before after")
    expect(countNodes(state.doc, "hard_break")).toBe(1)
    expect(dispatchCount).toBe(1)
  })

  test("continues formatting but not web-link or page identity marks", () => {
    const marks = [
      editorSchema.marks.strong!.create(),
      editorSchema.marks.link!.create({ href: "https://example.com" }),
      editorSchema.marks.page_reference!.create({ pageID: "page:identity" }),
    ]
    const paragraph = editorSchema.nodes.paragraph!.create(
      null,
      editorSchema.text("Format here", marks),
    )
    const doc = editorSchema.nodes.doc!.create(null, paragraph)
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, firstTextPosition(doc, "Format".length)),
    })

    expect(insertSoftLineBreak(editorSchema.nodes.hard_break!)(state, transaction => {
      state = state.apply(transaction)
    })).toBeTrue()
    expect(state.storedMarks?.map(mark => mark.type.name)).toEqual(["strong"])

    state = state.apply(state.tr.insertText("next"))
    let inserted: PMNode | undefined
    state.doc.descendants(node => {
      if (node.isText && node.text === "next") inserted = node
    })
    expect(inserted?.marks.map(mark => mark.type.name)).toEqual(["strong"])
  })

  test("uses a literal newline in code blocks", () => {
    const code = editorSchema.nodes.code_block!.create(null, editorSchema.text("oneTWOtwo"))
    const doc = editorSchema.nodes.doc!.create(null, code)
    const from = firstTextPosition(doc, "one".length)
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, from, from + "TWO".length),
    })
    let dispatchCount = 0

    expect(insertSoftLineBreak(editorSchema.nodes.hard_break!)(state, transaction => {
      dispatchCount += 1
      state = state.apply(transaction)
    })).toBeTrue()

    expect(state.doc.textContent).toBe("one\ntwo")
    expect(countNodes(state.doc, "hard_break")).toBe(0)
    expect(state.selection.$from.parent.type).toBe(editorSchema.nodes.code_block)
    expect(dispatchCount).toBe(1)
  })

  test("undoes and redoes the break as one history event", () => {
    const paragraph = editorSchema.nodes.paragraph!.create(null, editorSchema.text("BeforeAfter"))
    const doc = editorSchema.nodes.doc!.create(null, paragraph)
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, firstTextPosition(doc, "Before".length)),
      plugins: [history()],
    })

    insertSoftLineBreak(editorSchema.nodes.hard_break!)(state, transaction => {
      state = state.apply(transaction)
    })
    expect(countNodes(state.doc, "hard_break")).toBe(1)
    expect(undo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(countNodes(state.doc, "hard_break")).toBe(0)
    expect(undo(state)).toBeFalse()
    expect(redo(state, transaction => { state = state.apply(transaction) })).toBeTrue()
    expect(countNodes(state.doc, "hard_break")).toBe(1)
  })

  test("leaves ordinary Backspace and Delete to the browser", () => {
    const paragraph = editorSchema.nodes.paragraph!.create(null, [
      editorSchema.text("a"),
      editorSchema.nodes.hard_break!.create(),
      editorSchema.text("b"),
    ])
    const doc = editorSchema.nodes.doc!.create(null, paragraph)

    for (const [key, position] of [["Backspace", 3], ["Delete", 2]] as const) {
      const state = EditorState.create({ doc, selection: TextSelection.create(doc, position) })
      expect(baseKeymap[key](state)).toBeFalse()
      expect(countNodes(state.doc, "hard_break")).toBe(1)
      expect(state.doc.textContent).toBe("ab")
    }
  })

  test("survives save/load and recovery replay", () => {
    const paragraph = editorSchema.nodes.paragraph!.create(null, [
      editorSchema.text("Before"),
      editorSchema.nodes.hard_break!.create(),
      editorSchema.text("After"),
    ])
    const pmDoc = editorSchema.nodes.doc!.create(null, paragraph)
    const baseline = A.from({ body: "" })
    const edited = A.change(baseline, document => {
      A.updateSpans(document, ["body"], pmNodeToSpans(adapter, pmDoc), adapter.updateSpansConfig())
    })

    const saved = A.load(A.save(edited))
    const reloaded = pmDocFromSpans(adapter, A.spans(saved, ["body"]))
    expect(countNodes(reloaded, "hard_break")).toBe(1)
    expect(reloaded.textContent).toBe("BeforeAfter")

    const [recovered] = A.applyChanges(A.clone(baseline), A.getChanges(baseline, edited))
    const replayed = pmDocFromSpans(adapter, A.spans(recovered, ["body"]))
    expect(countNodes(replayed, "hard_break")).toBe(1)
    expect(replayed.textContent).toBe("BeforeAfter")
  })

  test("round-trips through an older client as an unknown inline leaf without data loss", () => {
    const paragraph = editorSchema.nodes.paragraph!.create(null, [
      editorSchema.text("Before"),
      editorSchema.nodes.hard_break!.create(),
      editorSchema.text("After"),
    ])
    const pmDoc = editorSchema.nodes.doc!.create(null, paragraph)
    const current = A.change(A.from({ body: "" }), document => {
      A.updateSpans(document, ["body"], pmNodeToSpans(adapter, pmDoc), adapter.updateSpansConfig())
    })

    const legacyAdapter = softLineBreakAdapter(false)
    const legacyDoc = pmDocFromSpans(legacyAdapter, A.spans(current, ["body"]))
    expect(countNodes(legacyDoc, "unknownLeaf")).toBe(1)
    let unknownLeaf: PMNode | undefined
    legacyDoc.descendants(node => {
      if (node.type.name === "unknownLeaf") unknownLeaf = node
    })
    expect(unknownLeaf?.attrs.unknownBlock.type).toBe(SOFT_LINE_BREAK_BLOCK)

    const legacyState = EditorState.create({ doc: legacyDoc, selection: TextSelection.atEnd(legacyDoc) })
    const legacyEdited = legacyState.apply(legacyState.tr.insertText("!"))
    const resaved = A.change(current, document => {
      A.updateSpans(
        document,
        ["body"],
        pmNodeToSpans(legacyAdapter, legacyEdited.doc),
        legacyAdapter.updateSpansConfig(),
      )
    })
    const currentReload = pmDocFromSpans(
      adapter,
      A.spans(A.load(A.save(resaved)), ["body"]),
    )
    expect(countNodes(currentReload, "hard_break")).toBe(1)
    expect(currentReload.textContent).toBe("BeforeAfter!")
  })

  test("uses the same command for Shift-Enter and the Aa palette, then restores focus", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")

    expect(source).toContain('"Enter": editorReturnCommand(binding.schema.nodes.list_item!)')
    expect(source).toContain('"Shift-Enter": insertSoftLineBreak(binding.schema.nodes.hard_break!)')
    expect(source).toContain("const lineBreak = insertSoftLineBreak(editorView.state.schema.nodes.hard_break!)")
    expect(source).toContain("disabled: !lineBreak(editorView.state)")
    expect(source).toContain("action: run(lineBreak)")
    expect(source).toMatch(/command\(editorView\.state, editorView\.dispatch, editorView\)\s*\n\s*editorView\.focus\(\)/)
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
  test("puts explicit task actions before generic supertags", () => {
    const task = { id: "task", name: "Task" }
    const person = { id: "person", name: "Person" }
    const project = { id: "project", name: "Project" }

    const plan = selectedTextTaskPlan("  Book dentist\n", [person, task, project])

    expect(plan.title).toBe("Book dentist")
    expect(plan.createLabel).toBe("Create task “Book dentist”")
    expect(plan.linkLabel).toBe("Link existing task…")
    expect(plan.taskTag).toBe(task)
    expect(plan.genericSupertags).toEqual([person, project])
  })

  test("never offers task creation for whitespace-only text", () => {
    const plan = selectedTextTaskPlan(" \n\t ", [{ id: "task", name: "Task" }])

    expect(plan.title).toBeUndefined()
    expect(plan.createLabel).toBeUndefined()
    expect(plan.linkLabel).toBe("Link existing task…")
  })

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

    const reloadedDocument = A.load(A.save(automergeDocument))
    const reloadedMark = A.marks(reloadedDocument, ["body"])
      .find(candidate => candidate.name === referenceMarkName)
    expect(reloadedMark?.value).toBe(JSON.stringify({
      pageID: "person:rossbottom",
      label: "Dr. Rosbottom",
    }))
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
