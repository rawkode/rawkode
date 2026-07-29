import { next as A } from "@automerge/automerge"
import { Repo, type DocHandle } from "@automerge/automerge-repo"
import { init, SchemaAdapter } from "@automerge/prosemirror"
import type { MappedMarkSpec, MappedNodeSpec } from "@automerge/prosemirror"
import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands"
import { history, redo, undo } from "prosemirror-history"
import { inputRules, smartQuotes, textblockTypeInputRule, wrappingInputRule, type InputRule } from "prosemirror-inputrules"
import { keymap } from "prosemirror-keymap"
import type { DOMOutputSpec, Node as PMNode, Schema } from "prosemirror-model"
import { liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list"
import { EditorState, Plugin } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import {
  exitCodeBlockOnEmptyLine,
  moveBelowCodeBlock,
  persistSelectedMark,
  showsMobileCommandBar,
} from "./editorCommands"
import { createSerializedPageLoader, navigateAfterFlush } from "./editorLifecycle"
import "./style.css"

const PROTOCOL_VERSION = 2
const PAGE_REFERENCE_MARK = "__ext__dev.rawkode.enchiridion.page-reference"

type PageDoc = {
  format: string
  schemaVersion: number
  pageID: string
  title: string
  body: string
}

type LoadRequest = {
  protocolVersion: number
  pageID: string
  loadGeneration: number
  snapshotBase64: string
  context?: EditorPageContext
}

type EditorPageAction = { pageID: string; label: string }
type EditorOccurrenceLink = EditorPageAction & { detail?: string }
type EditorPageContext = {
  kind: "occurrence" | "series"
  primary: string
  secondary?: string
  warning?: string
  action?: EditorPageAction
  occurrences?: EditorOccurrenceLink[]
}

type PageSuggestion = { pageID: string; title: string; subtitle?: string }
type DateSuggestion = { dateISO: string; title: string; subtitle?: string }
type ReferenceSuggestion = PageSuggestion | DateSuggestion
type SupertagSuggestion = { id: string; name: string; symbol?: string }
type PageReferenceTarget =
  | { kind: "insert"; position: number; trigger?: "[[" | "@" }
  | { kind: "selection"; from: number; to: number; query: string }
type CommitReply = { ok: boolean; journalID?: string; message?: string }
type MetadataReply = { ok: boolean; title?: string; summary?: string; imageURL?: string }
type PaletteItem = { label: string; detail?: string; action: () => void }
type PaletteGroup = { label: string; items: PaletteItem[] }

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        enchiridion?: { postMessage: (message: unknown) => Promise<unknown> }
      }
    }
    EnchiridionEditor: {
      load: (request: LoadRequest) => Promise<void>
      focus: () => void
      flush: () => Promise<void>
    }
  }
}

const repo = new Repo({ network: [] })
const titleInput = requiredElement<HTMLTextAreaElement>("title")
const editorElement = requiredElement<HTMLDivElement>("editor")
const statusElement = requiredElement<HTMLDivElement>("status")
const contextElement = requiredElement<HTMLElement>("page-context")
const slashMenu = requiredElement<HTMLDivElement>("slash-menu")
const pageMenu = requiredElement<HTMLDivElement>("page-menu")
const selectionToolbar = requiredElement<HTMLDivElement>("selection-toolbar")
const mobileCommandBar = requiredElement<HTMLDivElement>("mobile-command-bar")

let handle: DocHandle<PageDoc> | undefined
let view: EditorView | undefined
let pageID = ""
let loadGeneration = 0
let durableDoc: A.Doc<PageDoc> | undefined
let commitCompletion: Promise<boolean> | undefined
let loading = false
let commitTimer: number | undefined
let recoveredJournalIDs: string[] = []

const schemaAdapter = new SchemaAdapter({
  nodes: {
    doc: { content: "block+" },
    paragraph: mappedTextBlock("paragraph", "p"),
    heading: {
      automerge: {
        block: "heading",
        attrParsers: {
          fromAutomerge: block => ({ level: Number(block.attrs.level ?? 1) }),
          fromProsemirror: node => ({ level: node.attrs.level }),
        },
      },
      attrs: { level: { default: 1 } },
      content: "inline*",
      group: "block",
      defining: true,
      parseDOM: [1, 2, 3].map(level => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: node => [`h${node.attrs.level}`, 0],
    },
    blockquote: {
      automerge: { block: "blockquote" },
      content: "block+",
      group: "block",
      defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0],
    },
    code_block: {
      automerge: { block: "code-block" },
      content: "text*",
      marks: "",
      group: "block",
      code: true,
      defining: true,
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      toDOM: () => ["pre", ["code", 0]],
    },
    bullet_list: {
      content: "list_item+",
      group: "block",
      parseDOM: [{ tag: "ul" }],
      toDOM: () => ["ul", 0],
    },
    ordered_list: {
      content: "list_item+",
      group: "block",
      attrs: { order: { default: 1 } },
      parseDOM: [{ tag: "ol" }],
      toDOM: node => node.attrs.order === 1 ? ["ol", 0] : ["ol", { start: node.attrs.order }, 0],
    },
    list_item: {
      automerge: {
        block: { within: { bullet_list: "unordered-list-item", ordered_list: "ordered-list-item" } },
      },
      content: "paragraph block*",
      defining: true,
      parseDOM: [{ tag: "li" }],
      toDOM: () => ["li", 0],
    },
    horizontal_rule: {
      automerge: { block: "horizontal-rule", isEmbed: true },
      group: "block",
      atom: true,
      parseDOM: [{ tag: "hr" }],
      toDOM: () => ["hr"],
    },
    bookmark: embedNode("bookmark", "article", ["url", "title", "summary", "imageURL"]),
    youtube: embedNode("youtube", "figure", ["videoID", "url", "title"]),
    unknownBlock: {
      automerge: { unknownBlock: true },
      group: "block",
      content: "block+",
      parseDOM: [{ tag: "div[data-unknown-block]" }],
      toDOM: () => ["div", { "data-unknown-block": "true" }, 0],
    },
    unknownLeaf: {
      automerge: { unknownBlock: true },
      inline: true,
      group: "inline",
      atom: true,
      parseDOM: [{ tag: "span[data-unknown-leaf]" }],
      toDOM: () => ["span", { "data-unknown-leaf": "true" }, "Unsupported content"],
    },
    text: { group: "inline" },
  },
  marks: {
    strong: mappedMark("strong", "strong"),
    em: mappedMark("em", "em"),
    strike: mappedMark("strike", "s"),
    code: mappedMark("code", "code"),
    link: {
      automerge: {
        markName: "link",
        parsers: {
          fromAutomerge: value => parseJSONAttributes(value, { href: "", title: null }),
          fromProsemirror: mark => JSON.stringify(mark.attrs),
        },
      },
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: node => ({ href: (node as HTMLElement).getAttribute("href") }) }],
      toDOM: mark => ["a", { href: mark.attrs.href, rel: "noreferrer" }, 0],
    },
    page_reference: {
      automerge: {
        markName: PAGE_REFERENCE_MARK,
        parsers: {
          fromAutomerge: value => parseJSONAttributes(value, { pageID: "", label: "" }),
          fromProsemirror: mark => JSON.stringify(mark.attrs),
        },
      },
      attrs: { pageID: {}, label: { default: "" } },
      inclusive: false,
      parseDOM: [{ tag: "span[data-page-id]", getAttrs: node => ({ pageID: (node as HTMLElement).dataset.pageId }) }],
      toDOM: mark => ["span", { class: "page-reference", "data-page-id": mark.attrs.pageID }, 0],
    },
    unknownMark: {
      automerge: { markName: "__unknown__" },
      parseDOM: [{ tag: "span[data-unknown-mark]" }],
      toDOM: () => ["span", { "data-unknown-mark": "true" }, 0],
    },
  },
})

const loadPage = createSerializedPageLoader(flushPendingChanges, loadDocument)

window.EnchiridionEditor = {
  load: loadPage,
  focus: () => view?.focus(),
  flush: flushPendingChanges,
}

void notifyNative({ type: "ready", protocolVersion: PROTOCOL_VERSION }).catch(showError)

async function loadDocument(request: LoadRequest): Promise<void> {
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new Error("Unsupported editor protocol")
  if (commitTimer !== undefined) {
    window.clearTimeout(commitTimer)
    commitTimer = undefined
  }
  loading = true
  setStatus("Opening…")
  pageID = request.pageID
  loadGeneration = request.loadGeneration
  view?.destroy()
  view = undefined
  handle = undefined

  let document = A.load<PageDoc>(fromBase64(request.snapshotBase64))
  const pending = await journalEntries(pageID)
  recoveredJournalIDs = pending.map(entry => entry.journalID)
  for (const entry of pending) {
    try {
      ;[document] = A.applyChanges(document, entry.changesBase64.map(fromBase64))
    } catch {
      await removeJournal(entry.journalID)
    }
  }

  durableDoc = A.load<PageDoc>(fromBase64(request.snapshotBase64))
  handle = repo.import<PageDoc>(A.save(document))
  await handle.whenReady()
  const binding = init(handle, ["body"], { schemaAdapter })
  const plugins = [
    binding.plugin,
    history(),
    inputRules({ rules: editorInputRules(binding.schema) }),
    keymap({
      "Enter": exitCodeBlockOnEmptyLine,
      "ArrowDown": moveBelowCodeBlock,
      "Mod-z": undo,
      "Shift-Mod-z": redo,
      "Mod-y": redo,
      "Mod-b": toggleMark(binding.schema.marks.strong!),
      "Mod-i": toggleMark(binding.schema.marks.em!),
      "Mod-k": openLinkEditor,
      "Mod-Shift-7": wrapInList(binding.schema.nodes.ordered_list!),
      "Mod-Shift-8": wrapInList(binding.schema.nodes.bullet_list!),
      "Tab": sinkListItem(binding.schema.nodes.list_item!),
      "Shift-Tab": liftListItem(binding.schema.nodes.list_item!),
    }),
    keymap(baseKeymap),
    interactionPlugin(),
  ]

  view = new EditorView(editorElement, {
    state: EditorState.create({ schema: binding.schema, doc: binding.pmDoc, plugins }),
    dispatchTransaction(transaction) {
      if (!view) return
      view.updateState(view.state.apply(transaction))
      updateSelectionToolbar()
    },
  })
  view.dom.addEventListener("focusin", updateMobileCommandBar)
  view.dom.addEventListener("focusout", () => window.setTimeout(updateMobileCommandBar, 0))
  titleInput.disabled = false
  titleInput.value = A.toJS(handle.doc()).title.toString()
  resizeTitle()
  renderPageContext(request.context)
  handle.on("change", onDocumentChange)
  loading = false
  setStatus(pending.length > 0 ? "Recovering local edits…" : "Saved locally")
  if (pending.length > 0) scheduleCommit(0)
}

function renderPageContext(context?: EditorPageContext): void {
  contextElement.replaceChildren()
  contextElement.hidden = !context
  if (!context) return

  const summary = document.createElement("div")
  summary.className = "page-context-summary"
  const copy = document.createElement("div")
  const primary = document.createElement("div")
  primary.className = "page-context-primary"
  primary.textContent = context.primary
  copy.append(primary)
  if (context.secondary) {
    const secondary = document.createElement("div")
    secondary.className = "page-context-secondary"
    secondary.textContent = context.secondary
    copy.append(secondary)
  }
  summary.append(copy)
  if (context.action) summary.append(pageActionButton(context.action))
  contextElement.append(summary)

  if (context.warning) {
    const warning = document.createElement("div")
    warning.className = "page-context-warning"
    warning.textContent = context.warning
    contextElement.append(warning)
  }

  if (context.kind === "series" && context.occurrences?.length) {
    const heading = document.createElement("div")
    heading.className = "page-context-list-heading"
    heading.textContent = "Occurrence notes"
    const list = document.createElement("div")
    list.className = "page-context-list"
    for (const occurrence of context.occurrences) {
      const item = pageActionButton(occurrence)
      item.classList.add("page-context-occurrence")
      if (occurrence.detail) {
        const detail = document.createElement("span")
        detail.className = "page-context-occurrence-detail"
        detail.textContent = occurrence.detail
        item.append(detail)
      }
      list.append(item)
    }
    contextElement.append(heading, list)
  }
}

function pageActionButton(action: EditorPageAction): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "page-context-action"
  const label = document.createElement("span")
  label.textContent = action.label
  button.append(label)
  button.addEventListener("click", () => {
    void openNativePage(action.pageID)
  })
  return button
}

titleInput.addEventListener("input", () => {
  resizeTitle()
  handle?.change(doc => A.updateText(doc, ["title"], titleInput.value))
})

titleInput.addEventListener("keydown", event => {
  if (event.key !== "Enter") return
  event.preventDefault()
  view?.focus()
})

window.addEventListener("resize", resizeTitle)

for (const commandButton of mobileCommandBar.querySelectorAll<HTMLButtonElement>("button[data-command]")) {
  commandButton.addEventListener("pointerdown", event => event.preventDefault())
  commandButton.addEventListener("click", () => runMobileCommand(commandButton.dataset.command ?? ""))
}

function runMobileCommand(command: string): void {
  if (!view) return
  switch (command) {
  case "blocks":
    showSlashMenu(view)
    break
  case "reference":
    void showPageMenu(view, { kind: "insert", position: view.state.selection.from })
    break
  case "bold":
    toggleMark(view.state.schema.marks.strong!)(view.state, view.dispatch, view)
    view.focus()
    break
  case "bullet-list":
    wrapInList(view.state.schema.nodes.bullet_list!)(view.state, view.dispatch, view)
    view.focus()
    break
  case "dismiss-keyboard":
    view.dom.blur()
    mobileCommandBar.hidden = true
    break
  }
}

function updateMobileCommandBar(): void {
  const usesCompactLayout = window.matchMedia("(max-width: 640px)").matches
  const hasTextSelection = view != null && !view.state.selection.empty
  mobileCommandBar.hidden = !showsMobileCommandBar(
    usesCompactLayout,
    view?.hasFocus() == true,
    hasTextSelection,
  )
}

function onDocumentChange(): void {
  if (!handle || loading) return
  const current = handle.doc()
  const currentTitle = A.toJS(current).title.toString()
  if (titleInput.value !== currentTitle && document.activeElement !== titleInput) {
    titleInput.value = currentTitle
    resizeTitle()
  }
  scheduleCommit(180)
}

function resizeTitle(): void {
  titleInput.style.height = "0px"
  titleInput.style.height = `${titleInput.scrollHeight}px`
}

function scheduleCommit(delay: number): void {
  if (commitTimer !== undefined) window.clearTimeout(commitTimer)
  commitTimer = window.setTimeout(() => {
    commitTimer = undefined
    void flushCommit()
  }, delay)
}

async function flushCommit(): Promise<boolean> {
  if (commitCompletion) {
    return commitCompletion
  }
  const operation = persistPendingChanges()
  commitCompletion = operation
  try {
    return await operation
  } finally {
    if (commitCompletion === operation) commitCompletion = undefined
    if (handle && durableDoc && A.getChanges(durableDoc, handle.doc()).length > 0) scheduleCommit(0)
  }
}

async function flushPendingChanges(): Promise<void> {
  if (commitTimer !== undefined) {
    window.clearTimeout(commitTimer)
    commitTimer = undefined
  }
  while (handle && durableDoc) {
    const saved = await flushCommit()
    if (!saved) return
    if (!commitCompletion && A.getChanges(durableDoc, handle.doc()).length === 0) return
  }
}

async function openNativePage(destinationPageID: string): Promise<void> {
  try {
    await navigateAfterFlush(
      flushPendingChanges,
      async () => { await notifyNative({ type: "openPage", pageID: destinationPageID }) },
    )
  } catch (error) {
    showError(error)
  }
}

async function persistPendingChanges(): Promise<boolean> {
  if (!handle || !durableDoc) return true
  const current = handle.doc()
  const changes = A.getChanges(durableDoc, current)
  if (changes.length === 0) {
    await clearRecoveredJournals()
    setStatus("Saved locally")
    return true
  }
  const encodedChanges = concatenateChanges(changes)
  const journalID = crypto.randomUUID()
  const submitted = A.clone(current)
  const advertisedHeads = A.getHeads(submitted)
  await putJournal({
    journalID,
    pageID,
    loadGeneration,
    encodedChangesBase64: toBase64(encodedChanges),
    changesBase64: changes.map(toBase64),
    advertisedHeads,
    createdAt: new Date().toISOString(),
  })

  setStatus("Saving…")
  try {
    const reply = await notifyNative({
      type: "commit",
      protocolVersion: PROTOCOL_VERSION,
      pageID,
      loadGeneration,
      journalID,
      encodedChangesBase64: toBase64(encodedChanges),
      advertisedHeads,
    }) as CommitReply
    if (!reply.ok) throw new Error(reply.message ?? "Native persistence rejected the edit")
    durableDoc = submitted
    await removeJournal(journalID)
    await clearRecoveredJournals()
    setStatus("Saved locally")
    return true
  } catch (error) {
    setStatus("Saved in recovery journal")
    console.error(error)
    return false
  }
}

async function clearRecoveredJournals(): Promise<void> {
  const journalIDs = recoveredJournalIDs
  recoveredJournalIDs = []
  await Promise.all(journalIDs.map(removeJournal))
}

function interactionPlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(editorView, from, _to, text) {
        if (text === "/" && editorView.state.doc.resolve(from).parent.textContent.length === 0) {
          window.setTimeout(() => showSlashMenu(editorView), 0)
        }
        if (text === "[" && editorView.state.doc.textBetween(Math.max(0, from - 1), from) === "[") {
          window.setTimeout(() => void showPageMenu(editorView, {
            kind: "insert",
            position: from + 1,
            trigger: "[[",
          }), 0)
        }
        const precedingCharacter = editorView.state.doc.textBetween(Math.max(0, from - 1), from)
        if (text === "@" && (from <= 1 || /\s/.test(precedingCharacter))) {
          window.setTimeout(() => void showPageMenu(editorView, {
            kind: "insert",
            position: from + 1,
            trigger: "@",
          }), 0)
        }
        return false
      },
      handlePaste(editorView, event) {
        const text = event.clipboardData?.getData("text/plain").trim()
        if (!text || !isURL(text) || !editorView.state.selection.empty) return false
        const parent = editorView.state.selection.$from.parent
        if (parent.textContent.length > 0) return false
        event.preventDefault()
        showURLChoices(editorView, text)
        return true
      },
      handleClick(editorView, _position, event) {
        const target = event.target as HTMLElement
        const reference = target.closest<HTMLElement>("[data-page-id]")
        if (reference?.dataset.pageId) {
          void openNativePage(reference.dataset.pageId)
          return true
        }
        return false
      },
    },
  })
}

function showSlashMenu(editorView: EditorView): void {
  const run = (command: ReturnType<typeof setBlockType>): (() => void) => () => {
    removeSlashTrigger(editorView)
    command(editorView.state, editorView.dispatch, editorView)
    editorView.focus()
  }
  const insertDivider = () => {
    removeSlashTrigger(editorView)
    const divider = editorView.state.schema.nodes.horizontal_rule!.create()
    editorView.dispatch(editorView.state.tr.replaceSelectionWith(divider).scrollIntoView())
    editorView.focus()
  }
  const mention = () => {
    removeSlashTrigger(editorView)
    void showPageMenu(editorView, { kind: "insert", position: editorView.state.selection.from })
  }
  const groups: PaletteGroup[] = [
    {
      label: "Text Style",
      items: [
        { label: "Text", detail: "Plain paragraph", action: run(setBlockType(editorView.state.schema.nodes.paragraph!)) },
        { label: "Heading 1", detail: "Page section", action: run(setBlockType(editorView.state.schema.nodes.heading!, { level: 1 })) },
        { label: "Heading 2", detail: "Subsection", action: run(setBlockType(editorView.state.schema.nodes.heading!, { level: 2 })) },
        { label: "Heading 3", detail: "Small heading", action: run(setBlockType(editorView.state.schema.nodes.heading!, { level: 3 })) },
        { label: "Quote", detail: "Quoted passage", action: run(wrapIn(editorView.state.schema.nodes.blockquote!)) },
        { label: "Code", detail: "Code block", action: run(setBlockType(editorView.state.schema.nodes.code_block!)) },
      ],
    },
    {
      label: "List",
      items: [
        { label: "Bulleted list", detail: "Unordered items", action: run(wrapInList(editorView.state.schema.nodes.bullet_list!)) },
        { label: "Numbered list", detail: "Ordered items", action: run(wrapInList(editorView.state.schema.nodes.ordered_list!)) },
      ],
    },
    {
      label: "Indentation",
      items: [
        { label: "Indent", detail: "Move list item inward", action: run(sinkListItem(editorView.state.schema.nodes.list_item!)) },
        { label: "Outdent", detail: "Move list item outward", action: run(liftListItem(editorView.state.schema.nodes.list_item!)) },
      ],
    },
    {
      label: "Insert",
      items: [
        { label: "Page or date", detail: "Create a native reference", action: mention },
        { label: "Divider", detail: "Separate sections", action: insertDivider },
      ],
    },
  ]
  renderGroupedPalette(slashMenu, groups)
}

function removeSlashTrigger(editorView: EditorView): void {
  const { from } = editorView.state.selection
  const before = editorView.state.doc.textBetween(Math.max(0, from - 1), from)
  if (before === "/") editorView.dispatch(editorView.state.tr.delete(from - 1, from))
}

async function showPageMenu(editorView: EditorView, target: PageReferenceTarget): Promise<void> {
  selectionToolbar.hidden = true
  pageMenu.hidden = false
  pageMenu.replaceChildren()
  const input = document.createElement("input")
  input.placeholder = "Find a page or date…"
  input.setAttribute("aria-label", "Find a page or date")
  input.value = target.kind === "selection" ? target.query : ""
  pageMenu.append(input)
  const results = document.createElement("div")
  pageMenu.append(results)
  const update = async () => {
    const reply = await notifyNative({ type: "suggestPages", query: input.value }) as { suggestions?: ReferenceSuggestion[] }
    const suggestions = reply.suggestions ?? []
    const choices = suggestions.map(suggestion => ({
      label: suggestion.title || "Untitled",
      detail: suggestion.subtitle ?? "",
      action: () => {
        if ("dateISO" in suggestion) {
          void resolveAndInsertDateReference(editorView, target, suggestion)
        } else {
          insertPageReference(editorView, target, suggestion)
        }
      },
    }))
    const title = input.value.trim()
    const exactMatch = suggestions.some(suggestion => suggestion.title.localeCompare(title, undefined, { sensitivity: "accent" }) === 0)
    if (title && !exactMatch) {
      choices.unshift({
        label: `Create “${title}”`,
        detail: "New page",
        action: () => { void createAndInsertPageReference(editorView, target, title) },
      })
    }
    renderPalette(results, choices, false)
  }
  input.addEventListener("input", () => void update())
  input.addEventListener("keydown", event => {
    if (event.key !== "Escape") return
    pageMenu.hidden = true
    editorView.focus()
    updateSelectionToolbar()
  })
  await update()
  input.focus()
}

async function showSupertagMenu(editorView: EditorView, target: Extract<PageReferenceTarget, { kind: "selection" }>): Promise<void> {
  selectionToolbar.hidden = true
  pageMenu.hidden = false
  pageMenu.replaceChildren()
  const heading = document.createElement("div")
  heading.className = "palette-heading"
  heading.textContent = `Tag “${target.query}” as…`
  const results = document.createElement("div")
  pageMenu.append(heading, results)
  const reply = await notifyNative({ type: "listSupertags" }) as { supertags?: SupertagSuggestion[] }
  renderPalette(results, (reply.supertags ?? []).map(tag => ({
    label: `#${tag.name}`,
    detail: "Find or create a typed page",
    action: () => { void showTaggedPageMenu(editorView, target, tag) },
  })), false)
}

async function showTaggedPageMenu(
  editorView: EditorView,
  target: Extract<PageReferenceTarget, { kind: "selection" }>,
  tag: SupertagSuggestion,
): Promise<void> {
  pageMenu.replaceChildren()
  const input = document.createElement("input")
  input.placeholder = `Find a ${tag.name.toLowerCase()}…`
  input.setAttribute("aria-label", `Find a ${tag.name}`)
  input.value = target.query
  const results = document.createElement("div")
  pageMenu.append(input, results)
  const update = async () => {
    const reply = await notifyNative({
      type: "suggestTaggedPages",
      query: input.value,
      supertagID: tag.id,
    }) as { suggestions?: PageSuggestion[] }
    const suggestions = reply.suggestions ?? []
    const choices = suggestions.map(suggestion => ({
      label: suggestion.title || "Untitled",
      detail: `Existing #${tag.name}`,
      action: () => insertPageReference(editorView, target, suggestion),
    }))
    const title = input.value.trim()
    const exactMatch = suggestions.some(suggestion =>
      suggestion.title.localeCompare(title, undefined, { sensitivity: "accent" }) === 0)
    if (title && !exactMatch) choices.unshift({
      label: `Create “${title}” as #${tag.name}`,
      detail: "New typed page",
      action: () => { void createAndInsertTaggedPage(editorView, target, title, tag) },
    })
    renderPalette(results, choices, false)
  }
  input.addEventListener("input", () => void update())
  input.addEventListener("keydown", event => {
    if (event.key !== "Escape") return
    pageMenu.hidden = true
    editorView.focus()
    updateSelectionToolbar()
  })
  await update()
  input.focus()
}

async function createAndInsertTaggedPage(
  editorView: EditorView,
  target: Extract<PageReferenceTarget, { kind: "selection" }>,
  title: string,
  tag: SupertagSuggestion,
): Promise<void> {
  const reply = await notifyNative({ type: "createTaggedPage", title, supertagID: tag.id }) as {
    ok?: boolean
    pageID?: string
    title?: string
    message?: string
  }
  if (!reply.ok || !reply.pageID) {
    setStatus(reply.message ?? `Could not create #${tag.name}`)
    return
  }
  insertPageReference(editorView, target, { pageID: reply.pageID, title: reply.title ?? title })
}

async function createAndInsertPageReference(
  editorView: EditorView,
  target: PageReferenceTarget,
  title: string,
): Promise<void> {
  const reply = await notifyNative({ type: "createPage", title }) as {
    ok?: boolean
    pageID?: string
    title?: string
    message?: string
  }
  if (!reply.ok || !reply.pageID) {
    setStatus(reply.message ?? "Could not create page")
    return
  }
  insertPageReference(editorView, target, {
    pageID: reply.pageID,
    title: reply.title ?? title,
  })
}

function insertPageReference(editorView: EditorView, target: PageReferenceTarget, suggestion: PageSuggestion): void {
  const state = editorView.state
  const mark = state.schema.marks.page_reference!.create({ pageID: suggestion.pageID, label: suggestion.title })
  if (target.kind === "selection") {
    if (!handle) return
    persistSelectedMark(
      handle,
      ["body"],
      schemaAdapter,
      state,
      state.schema.marks.page_reference!,
      mark.attrs,
      { from: target.from, to: target.to },
    )
  } else {
    const triggerLength = target.trigger?.length ?? 0
    const candidateFrom = Math.max(0, target.position - triggerLength)
    const current = state.doc.textBetween(candidateFrom, target.position)
    const from = target.trigger && current === target.trigger ? candidateFrom : target.position
    editorView.dispatch(state.tr.replaceWith(from, target.position, state.schema.text(suggestion.title, [mark])))
  }
  pageMenu.hidden = true
  editorView.focus()
}

async function resolveAndInsertDateReference(
  editorView: EditorView,
  target: PageReferenceTarget,
  suggestion: DateSuggestion,
): Promise<void> {
  const reply = await notifyNative({ type: "resolveDailyPage", dateISO: suggestion.dateISO }) as {
    ok?: boolean
    pageID?: string
    title?: string
    message?: string
  }
  if (!reply.ok || !reply.pageID) {
    setStatus(reply.message ?? "Could not open that daily note")
    return
  }
  insertPageReference(editorView, target, {
    pageID: reply.pageID,
    title: reply.title ?? suggestion.title,
  })
}

function showURLChoices(editorView: EditorView, url: string): void {
  const videoID = youtubeVideoID(url)
  const choices = [
    { label: "Keep as link", action: () => insertLink(editorView, url) },
    { label: "Bookmark card", action: () => void insertBookmark(editorView, url) },
  ]
  if (videoID) choices.unshift({ label: "Embed YouTube", action: () => insertYouTube(editorView, url, videoID) })
  renderPalette(slashMenu, choices)
}

function insertLink(editorView: EditorView, url: string): void {
  const mark = editorView.state.schema.marks.link!.create({ href: url })
  editorView.dispatch(editorView.state.tr.replaceSelectionWith(editorView.state.schema.text(url, [mark])))
  editorView.focus()
}

async function insertBookmark(editorView: EditorView, url: string): Promise<void> {
  const metadata = await notifyNative({ type: "fetchLinkMetadata", url }) as MetadataReply
  const node = editorView.state.schema.nodes.bookmark!.create({
    url,
    title: metadata.title ?? url,
    summary: metadata.summary ?? "",
    imageURL: metadata.imageURL ?? "",
  })
  editorView.dispatch(editorView.state.tr.replaceSelectionWith(node))
  editorView.focus()
}

function insertYouTube(editorView: EditorView, url: string, videoID: string): void {
  const node = editorView.state.schema.nodes.youtube!.create({ videoID, url, title: "YouTube video" })
  editorView.dispatch(editorView.state.tr.replaceSelectionWith(node))
  editorView.focus()
}

function updateSelectionToolbar(): void {
  if (!view || view.state.selection.empty) {
    selectionToolbar.hidden = true
    updateMobileCommandBar()
    return
  }
  const buttons = [
    ["Bold", view.state.schema.marks.strong!],
    ["Italic", view.state.schema.marks.em!],
    ["Strike", view.state.schema.marks.strike!],
    ["Code", view.state.schema.marks.code!],
  ] as const
  selectionToolbar.hidden = false
  selectionToolbar.replaceChildren(...buttons.map(([label, mark]) => button(label, () => {
    toggleMark(mark)(view!.state, view!.dispatch, view)
    view!.focus()
  })))
  selectionToolbar.append(button("Reference", () => {
    if (!view || view.state.selection.empty) return
    const { from, to } = view.state.selection
    const query = view.state.doc.textBetween(from, to, " ").trim()
    void showPageMenu(view, { kind: "selection", from, to, query })
  }))
  selectionToolbar.append(button("Supertag", () => {
    if (!view || view.state.selection.empty) return
    const { from, to } = view.state.selection
    const query = view.state.doc.textBetween(from, to, " ").trim()
    void showSupertagMenu(view, { kind: "selection", from, to, query })
  }))
  selectionToolbar.append(button("Link", () => openLinkEditor(view!.state, view!.dispatch, view)))
  updateMobileCommandBar()
}

function openLinkEditor(state: EditorState, dispatch?: EditorView["dispatch"], editorView?: EditorView): boolean {
  if (!dispatch || !editorView || state.selection.empty) return false
  const href = window.prompt("Link URL")
  if (!href) return false
  dispatch(state.tr.addMark(state.selection.from, state.selection.to, state.schema.marks.link!.create({ href })))
  editorView.focus()
  return true
}

function editorInputRules(schema: Schema): InputRule[] {
  return [
    ...smartQuotes,
    textblockTypeInputRule(/^#\s$/, schema.nodes.heading!, { level: 1 }),
    textblockTypeInputRule(/^##\s$/, schema.nodes.heading!, { level: 2 }),
    textblockTypeInputRule(/^###\s$/, schema.nodes.heading!, { level: 3 }),
    textblockTypeInputRule(/^```$/, schema.nodes.code_block!),
    wrappingInputRule(/^>\s$/, schema.nodes.blockquote!),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
    wrappingInputRule(/^\s*(\d+)\.\s$/, schema.nodes.ordered_list!, match => ({ order: Number(match[1]) })),
  ]
}

function renderGroupedPalette(container: HTMLElement, groups: PaletteGroup[]): void {
  container.replaceChildren(...groups.map(group => {
    const section = document.createElement("section")
    section.className = "palette-group"
    const heading = document.createElement("div")
    heading.className = "palette-group-label"
    heading.textContent = group.label
    const items = document.createElement("div")
    items.replaceChildren(...group.items.map(item => button(item.label, item.action, item.detail)))
    section.append(heading, items)
    return section
  }))
  container.hidden = false
}

function mappedTextBlock(block: string, tag: string): MappedNodeSpec {
  return {
    automerge: { block }, content: "inline*", group: "block",
    parseDOM: [{ tag }], toDOM: () => [tag, 0] as DOMOutputSpec,
  }
}

function mappedMark(name: string, tag: string): MappedMarkSpec {
  return {
    automerge: { markName: name },
    parseDOM: [{ tag }],
    toDOM: () => [tag, 0] as DOMOutputSpec,
  }
}

function embedNode(block: string, tag: string, attributes: string[]): MappedNodeSpec {
  const attrs = Object.fromEntries(attributes.map(name => [name, { default: "" }]))
  return {
    automerge: {
      block,
      isEmbed: true,
      attrParsers: {
        fromAutomerge: (marker: { attrs: Record<string, unknown> }) => Object.fromEntries(attributes.map(name => [name, String(marker.attrs[name] ?? "")])),
        fromProsemirror: (node: PMNode) => Object.fromEntries(attributes.map(name => [name, String(node.attrs[name] ?? "")])),
      },
    },
    attrs,
    group: "block",
    atom: true,
    draggable: true,
    parseDOM: [{ tag: `${tag}[data-${block}]` }],
    toDOM: (node: PMNode) => {
      if (block === "youtube") {
        return ["figure", { class: "embed youtube", "data-youtube": node.attrs.videoID },
          ["iframe", { src: `https://www.youtube-nocookie.com/embed/${node.attrs.videoID}`, title: node.attrs.title, allowfullscreen: "true" }],
          ["figcaption", node.attrs.title || "YouTube video"]]
      }
      const children: DOMOutputSpec[] = [["strong", node.attrs.title || node.attrs.url]]
      if (node.attrs.summary) children.push(["p", node.attrs.summary])
      return ["article", { class: "embed bookmark", "data-bookmark": node.attrs.url }, ...children] as DOMOutputSpec
    },
  }
}

function parseJSONAttributes(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (typeof value !== "string") return fallback
  try { return { ...fallback, ...JSON.parse(value) } } catch { return fallback }
}

function renderPalette(container: HTMLElement, items: PaletteItem[], reveal = true): void {
  const nodes = items.map(item => button(item.label, item.action, item.detail))
  container.replaceChildren(...nodes)
  if (reveal) container.hidden = false
}

function button(label: string, action: () => void, detail?: string): HTMLButtonElement {
  const element = document.createElement("button")
  element.type = "button"
  if (detail) {
    const title = document.createElement("span")
    title.className = "palette-title"
    title.textContent = label
    const subtitle = document.createElement("span")
    subtitle.className = "palette-subtitle"
    subtitle.textContent = detail
    element.replaceChildren(title, subtitle)
  } else {
    element.textContent = label
  }
  element.addEventListener("click", () => {
    slashMenu.hidden = true
    action()
  })
  return element
}

async function notifyNative(message: unknown): Promise<unknown> {
  const bridge = window.webkit?.messageHandlers?.enchiridion
  if (!bridge) throw new Error("Native editor bridge is unavailable")
  return bridge.postMessage(message)
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}

function setStatus(message: string): void {
  statusElement.textContent = message
  statusElement.dataset.state = message.toLowerCase().replaceAll(" ", "-")
}

function showError(error: unknown): void {
  setStatus(error instanceof Error ? error.message : String(error))
}

function isURL(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol) } catch { return false }
}

function youtubeVideoID(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.hostname === "youtu.be") return url.pathname.slice(1) || undefined
    if (url.hostname.endsWith("youtube.com")) return url.searchParams.get("v") ?? url.pathname.match(/^\/shorts\/([^/]+)/)?.[1]
  } catch { return undefined }
  return undefined
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function toBase64(value: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function concatenateChanges(changes: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(changes.reduce((length, change) => length + change.length, 0))
  let offset = 0
  for (const change of changes) { result.set(change, offset); offset += change.length }
  return result
}

type JournalEntry = {
  journalID: string
  pageID: string
  loadGeneration: number
  encodedChangesBase64: string
  changesBase64: string[]
  advertisedHeads: string[]
  createdAt: string
}

function journalDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("enchiridion-editor", 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("commits", { keyPath: "journalID" })
      store.createIndex("pageID", "pageID")
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function putJournal(entry: JournalEntry): Promise<void> {
  const database = await journalDatabase()
  await idbRequest(database.transaction("commits", "readwrite").objectStore("commits").put(entry))
  database.close()
}

async function removeJournal(journalID: string): Promise<void> {
  const database = await journalDatabase()
  await idbRequest(database.transaction("commits", "readwrite").objectStore("commits").delete(journalID))
  database.close()
}

async function journalEntries(forPageID: string): Promise<JournalEntry[]> {
  const database = await journalDatabase()
  const request = database.transaction("commits").objectStore("commits").index("pageID").getAll(forPageID)
  const entries = await idbRequest<JournalEntry[]>(request)
  database.close()
  return entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
