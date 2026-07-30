import { next as A } from "@automerge/automerge"
import { Repo, type DocHandle } from "@automerge/automerge-repo"
import { init, SchemaAdapter } from "@automerge/prosemirror"
import type { MappedMarkSpec, MappedNodeSpec } from "@automerge/prosemirror"
import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands"
import { history, redo, undo } from "prosemirror-history"
import { inputRules, smartQuotes, textblockTypeInputRule, wrappingInputRule, type InputRule } from "prosemirror-inputrules"
import { keymap } from "prosemirror-keymap"
import type { DOMOutputSpec, MarkType, Node as PMNode, Schema } from "prosemirror-model"
import { liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list"
import { EditorState, Plugin, type SelectionBookmark, type Transaction } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import {
  exitCodeBlockOnEmptyLine,
  editorReturnCommand,
  filterCommands,
  hardBreakNodeSpec,
  insertSoftLineBreak,
  linkEditTransaction,
  moveBlock,
  movePaletteSelection,
  moveBelowCodeBlock,
  placePalette,
  persistSelectedMark,
  resolveLinkEditTarget,
  selectedTextTaskPlan,
  showsEditorCommandBar,
  slashCommandQuery,
  validateHTTPURL,
  type LinkEditResolution,
  type LinkEditTarget,
  type SearchableCommand,
} from "./editorCommands"
import { createSerializedPageLoader, navigateAfterFlush } from "./editorLifecycle"
import {
  createFindInPagePlugin,
  findDecorationTransaction,
  findPageMatches,
  moveFindSelection,
  type FindMatch,
} from "./findInPage"
import { inlineCodeInputRules } from "./inlineCode"
import { markdownEmphasisInputRules, reversibleMarkdownKeymap } from "./markdownEmphasis"
import {
  deriveCommandBarState,
  isMarkUniformlyActive,
  isSelectionUniformlyInNode,
  type CommandBarCommand,
} from "./commandBarState"
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
  | { kind: "selection"; from: number; to: number; query: string; selectedText: string }
type CommitReply = { ok: boolean; journalID?: string; message?: string }
type MetadataReply = { ok: boolean; title?: string; summary?: string; imageURL?: string }
type PaletteItem = SearchableCommand & {
  action: () => void
  ariaLabel?: string
  disabled?: boolean
}
type PaletteGroup = { label: string; items: PaletteItem[] }
type SlashPaletteState = {
  editorView: EditorView
  triggerFrom: number | undefined
  groups: PaletteGroup[]
  visibleItems: PaletteItem[]
  activeIndex: number
  query?: string
}
type PendingTaskReference = {
  sourcePageID: string
  target: Extract<PageReferenceTarget, { kind: "selection" }>
  task: PageSuggestion
}
type LinkEditorState = {
  editorView: EditorView
  target: LinkEditTarget
  selection: EditorState["selection"]
}
type FindRestoreTarget =
  | { kind: "title"; start: number; end: number; direction: "forward" | "backward" | "none" }
  | { kind: "body"; bookmark: SelectionBookmark }
type FindInPageState = {
  queryInput: HTMLInputElement
  counter: HTMLElement
  announcement: HTMLElement
  previousButton: HTMLButtonElement
  nextButton: HTMLButtonElement
  matches: FindMatch[]
  activeIndex: number
  restoreTarget: FindRestoreTarget
}

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
      dismissKeyboard: () => void
      find: () => void
    }
  }
}

const repo = new Repo({ network: [] })
const titleInput = requiredElement<HTMLTextAreaElement>("title")
const editorElement = requiredElement<HTMLDivElement>("editor")
const statusElement = requiredElement<HTMLDivElement>("status")
const contextElement = requiredElement<HTMLElement>("page-context")
const findBar = requiredElement<HTMLElement>("find-bar")
const slashMenu = requiredElement<HTMLDivElement>("slash-menu")
const pageMenu = requiredElement<HTMLDivElement>("page-menu")
const linkMenu = requiredElement<HTMLDivElement>("link-menu")
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
let reportedEditorFocus = false
let slashPaletteState: SlashPaletteState | undefined
let pendingTaskReference: PendingTaskReference | undefined
let linkEditorState: LinkEditorState | undefined
let findInPageState: FindInPageState | undefined
let editorIsComposing = false
let mobileCommandSelection: SelectionBookmark | undefined

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
    hard_break: hardBreakNodeSpec,
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
  dismissKeyboard,
  find: openFindInPage,
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
  if (pendingTaskReference?.sourcePageID !== pageID) pendingTaskReference = undefined
  loadGeneration = request.loadGeneration
  closeSlashPalette()
  closeLinkEditor(false)
  closeFindInPage(false)
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
    interactionPlugin(),
    createFindInPagePlugin(),
    history(),
    inputRules({ rules: editorInputRules(binding.schema) }),
    reversibleMarkdownKeymap,
    keymap({
      "Enter": editorReturnCommand(binding.schema.nodes.list_item!),
      "Shift-Enter": insertSoftLineBreak(binding.schema.nodes.hard_break!),
      "Mod-Alt-ArrowUp": moveBlock(-1),
      "Mod-Alt-ArrowDown": moveBlock(1),
      "ArrowDown": moveBelowCodeBlock,
      "Mod-z": undo,
      "Shift-Mod-z": redo,
      "Mod-y": redo,
      "Mod-b": toggleMark(binding.schema.marks.strong!),
      "Mod-i": toggleMark(binding.schema.marks.em!),
      "Shift-Mod-j": toggleMark(binding.schema.marks.code!),
      "Mod-k": openLinkEditor,
      "Mod-Shift-7": wrapInList(binding.schema.nodes.ordered_list!),
      "Mod-Shift-8": wrapInList(binding.schema.nodes.bullet_list!),
      "Tab": sinkListItem(binding.schema.nodes.list_item!),
      "Shift-Tab": liftListItem(binding.schema.nodes.list_item!),
    }),
    keymap(baseKeymap),
  ]

  view = new EditorView(editorElement, {
    state: EditorState.create({ schema: binding.schema, doc: binding.pmDoc, plugins }),
    dispatchTransaction(transaction) {
      if (!view) return
      if (transaction.docChanged && linkEditorState) closeLinkEditor(false)
      view.updateState(view.state.apply(transaction))
      if (transaction.docChanged && findInPageState) {
        findInPageState.restoreTarget = mapFindRestoreTarget(findInPageState.restoreTarget, transaction)
        refreshFindInPage(false)
      }
      updateMobileCommandBar()
      updateSlashPaletteFromEditor()
    },
  })
  view.dom.addEventListener("focusin", updateEditorFocus)
  view.dom.addEventListener("focusout", () => window.setTimeout(updateEditorFocus, 0))
  view.dom.addEventListener("compositionstart", () => setEditorComposing(true))
  view.dom.addEventListener("compositionend", () => setEditorComposing(false))
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

function openFindInPage(): void {
  if (!view) return
  if (findInPageState) {
    closeTransientPalettesForFind()
    findInPageState.queryInput.focus()
    findInPageState.queryInput.select()
    return
  }

  const restoreTarget = captureFindRestoreTarget()
  closeTransientPalettesForFind()

  const queryInput = document.createElement("input")
  queryInput.id = "find-in-page-query"
  queryInput.type = "search"
  queryInput.placeholder = "Find on this page"
  queryInput.setAttribute("aria-label", "Find on this page")
  queryInput.setAttribute("autocomplete", "off")
  queryInput.setAttribute("autocapitalize", "off")
  queryInput.spellcheck = false

  const counter = document.createElement("output")
  counter.className = "find-counter"
  counter.htmlFor = queryInput.id
  counter.textContent = "0 of 0"

  const announcement = document.createElement("span")
  announcement.className = "visually-hidden"
  announcement.setAttribute("role", "status")
  announcement.setAttribute("aria-live", "polite")
  announcement.textContent = "Enter text to find."

  const previousButton = findButton("↑", "Previous match")
  const nextButton = findButton("↓", "Next match")
  const doneButton = findButton("Done", "Done finding")
  doneButton.classList.add("find-done")

  findInPageState = {
    queryInput,
    counter,
    announcement,
    previousButton,
    nextButton,
    matches: [],
    activeIndex: -1,
    restoreTarget,
  }
  findBar.replaceChildren(queryInput, counter, previousButton, nextButton, doneButton, announcement)
  findBar.hidden = false
  positionFindBar()
  updateFindControls()

  queryInput.addEventListener("input", () => refreshFindInPage(false, true))
  queryInput.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault()
      closeFindInPage()
      return
    }
    if (event.key !== "Enter") return
    event.preventDefault()
    navigateFindMatch(event.shiftKey ? -1 : 1)
  })
  previousButton.addEventListener("click", () => navigateFindMatch(-1))
  nextButton.addEventListener("click", () => navigateFindMatch(1))
  doneButton.addEventListener("click", () => closeFindInPage())

  window.requestAnimationFrame(() => {
    positionFindBar()
    queryInput.focus()
  })
}

function findButton(label: string, ariaLabel: string): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = label
  button.setAttribute("aria-label", ariaLabel)
  button.addEventListener("pointerdown", event => event.preventDefault())
  return button
}

function captureFindRestoreTarget(): FindRestoreTarget {
  if (document.activeElement === titleInput) {
    return {
      kind: "title",
      start: titleInput.selectionStart,
      end: titleInput.selectionEnd,
      direction: titleInput.selectionDirection ?? "none",
    }
  }
  const selection = linkEditorState?.selection ?? view!.state.selection
  return { kind: "body", bookmark: selection.getBookmark() }
}

function closeTransientPalettesForFind(): void {
  closeSlashPalette()
  pageMenu.hidden = true
  pageMenu.removeAttribute("aria-busy")
  pageMenu.replaceChildren()
  closeLinkEditor(false)
  updateMobileCommandBar()
}

function refreshFindInPage(selectActive: boolean, resetActive = false): void {
  const active = findInPageState
  if (!active || !view) return
  active.matches = findPageMatches(titleInput.value, view.state.doc, active.queryInput.value)
  if (resetActive) {
    active.activeIndex = active.matches.length > 0 ? 0 : -1
  } else if (active.matches.length === 0) {
    active.activeIndex = -1
  } else {
    active.activeIndex = Math.min(Math.max(active.activeIndex, 0), active.matches.length - 1)
  }
  updateFindDecorations()
  updateFindControls()
  if (selectActive) revealActiveFindMatch()
}

function navigateFindMatch(direction: -1 | 1): void {
  const active = findInPageState
  if (!active) return
  active.activeIndex = moveFindSelection(active.activeIndex, active.matches.length, direction)
  updateFindDecorations()
  updateFindControls()
  revealActiveFindMatch()
}

function updateFindDecorations(): void {
  const active = findInPageState
  if (!active || !view) return
  const match = active.matches[active.activeIndex]
  const activeBodyIndex = match?.source === "body" ? match.bodyIndex ?? -1 : -1
  view.dispatch(findDecorationTransaction(view.state, active.queryInput.value, activeBodyIndex))
}

function updateFindControls(): void {
  const active = findInPageState
  if (!active) return
  const total = active.matches.length
  const current = active.activeIndex >= 0 ? active.activeIndex + 1 : 0
  active.counter.textContent = `${current} of ${total}`
  active.previousButton.disabled = total === 0
  active.nextButton.disabled = total === 0
  active.announcement.textContent = !active.queryInput.value
    ? "Enter text to find."
    : total === 0
      ? `No matches for ${active.queryInput.value}.`
      : `${current} of ${total} matches.`
}

function revealActiveFindMatch(): void {
  const active = findInPageState
  if (!active) return
  const match = active.matches[active.activeIndex]
  if (!match) {
    active.queryInput.focus()
    return
  }
  if (match.source === "title") {
    titleInput.focus()
    titleInput.setSelectionRange(match.from, match.to)
    titleInput.scrollIntoView({ block: "nearest" })
    return
  }
  active.queryInput.focus()
  window.requestAnimationFrame(() => {
    view?.dom.querySelector<HTMLElement>("[data-find-active='true']")
      ?.scrollIntoView({ block: "center" })
  })
}

function closeFindInPage(restoreFocus = true): void {
  const active = findInPageState
  if (!active) return
  findInPageState = undefined
  findBar.hidden = true
  findBar.replaceChildren()
  findBar.style.removeProperty("top")
  findBar.style.removeProperty("right")
  if (view) view.dispatch(findDecorationTransaction(view.state, "", -1))
  if (!restoreFocus) return

  if (active.restoreTarget.kind === "title") {
    titleInput.focus()
    titleInput.setSelectionRange(
      active.restoreTarget.start,
      active.restoreTarget.end,
      active.restoreTarget.direction,
    )
  } else if (view) {
    const selection = active.restoreTarget.bookmark.resolve(view.state.doc)
    view.dispatch(view.state.tr.setSelection(selection).setMeta("addToHistory", false))
    view.focus()
  }
  updateMobileCommandBar()
}

function mapFindRestoreTarget(target: FindRestoreTarget, transaction: Transaction): FindRestoreTarget {
  if (target.kind === "title") return target
  return { kind: "body", bookmark: target.bookmark.map(transaction.mapping) }
}

function positionFindBar(): void {
  if (findBar.hidden) return
  const viewport = window.visualViewport
  const top = (viewport?.offsetTop ?? 0) + 8
  const visibleRight = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth)
  findBar.style.top = `${top}px`
  findBar.style.right = `${Math.max(8, window.innerWidth - visibleRight + 8)}px`
}

titleInput.addEventListener("input", () => {
  resizeTitle()
  handle?.change(doc => A.updateText(doc, ["title"], titleInput.value))
  if (findInPageState) refreshFindInPage(false)
})

titleInput.addEventListener("keydown", event => {
  if (event.key !== "Enter") return
  event.preventDefault()
  view?.focus()
})
titleInput.addEventListener("focusin", updateEditorFocus)
titleInput.addEventListener("focusout", () => window.setTimeout(updateEditorFocus, 0))
titleInput.addEventListener("compositionstart", () => setEditorComposing(true))
titleInput.addEventListener("compositionend", () => setEditorComposing(false))

window.addEventListener("resize", () => {
  resizeTitle()
  positionSlashPalette()
  positionLinkEditor()
  positionFindBar()
  positionMobileCommandBar()
})
window.addEventListener("scroll", () => {
  positionSlashPalette()
  positionLinkEditor()
  positionFindBar()
}, true)
window.visualViewport?.addEventListener("resize", positionFindBar)
window.visualViewport?.addEventListener("scroll", positionFindBar)
window.visualViewport?.addEventListener("resize", positionMobileCommandBar)
window.visualViewport?.addEventListener("scroll", positionMobileCommandBar)

window.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase() === "f") {
    event.preventDefault()
    event.stopPropagation()
    openFindInPage()
    return
  }
  if (event.key === "Escape" && findInPageState) {
    event.preventDefault()
    event.stopPropagation()
    closeFindInPage()
  }
}, true)

for (const commandButton of mobileCommandBar.querySelectorAll<HTMLButtonElement>("button[data-command]")) {
  commandButton.addEventListener("pointerdown", event => {
    mobileCommandSelection = view?.state.selection.getBookmark()
    if (event.pointerType !== "touch") event.preventDefault()
  })
  commandButton.addEventListener("click", () => {
    restoreMobileCommandSelection()
    runMobileCommand(commandButton.dataset.command as CommandBarCommand)
  })
}

pageMenu.addEventListener("keydown", event => {
  if (event.key !== "Escape") return
  event.preventDefault()
  pageMenu.hidden = true
  view?.focus()
  updateMobileCommandBar()
})

linkMenu.addEventListener("keydown", event => {
  if (event.key !== "Escape") return
  event.preventDefault()
  closeLinkEditor()
})

function runMobileCommand(command: CommandBarCommand): void {
  if (!view) return
  switch (command) {
  case "undo":
    undo(view.state, view.dispatch, view)
    view.focus()
    break
  case "redo":
    redo(view.state, view.dispatch, view)
    view.focus()
    break
  case "blocks":
    showSlashMenu(view)
    break
  case "bold":
    toggleCommandBarMark(view.state.schema.marks.strong!)
    break
  case "italic":
    toggleCommandBarMark(view.state.schema.marks.em!)
    break
  case "inline-code":
    toggleCommandBarMark(view.state.schema.marks.code!)
    break
  case "bullet-list":
    if (isSelectionUniformlyInNode(view.state, "bullet_list")) {
      liftListItem(view.state.schema.nodes.list_item!)(view.state, view.dispatch, view)
    } else {
      wrapInList(view.state.schema.nodes.bullet_list!)(view.state, view.dispatch, view)
    }
    view.focus()
    break
  case "link-reference": {
    const target = resolveWebLinkTarget(view.state)
    if (target.ok) openLinkEditor(view.state, view.dispatch, view)
    else openReferenceMenu(view)
    break
  }
  case "dismiss-keyboard":
    dismissKeyboard()
    break
  }
  mobileCommandSelection = undefined
}

function toggleCommandBarMark(markType: MarkType): void {
  if (!view) return
  const { state } = view
  if (state.selection.empty) {
    toggleMark(markType)(state, view.dispatch, view)
  } else {
    const transaction = isMarkUniformlyActive(state, markType)
      ? state.tr.removeMark(state.selection.from, state.selection.to, markType)
      : state.tr.addMark(state.selection.from, state.selection.to, markType.create())
    view.dispatch(transaction.scrollIntoView())
  }
  view.focus()
}

function openReferenceMenu(editorView: EditorView): void {
  if (editorView.state.selection.empty) {
    void showPageMenu(editorView, { kind: "insert", position: editorView.state.selection.from })
    return
  }
  const { from, to } = editorView.state.selection
  const selectedText = editorView.state.doc.textBetween(from, to, " ")
  void showPageMenu(editorView, {
    kind: "selection",
    from,
    to,
    query: selectedText.trim(),
    selectedText,
  })
}

function restoreMobileCommandSelection(): void {
  if (!view || !mobileCommandSelection) return
  try {
    const selection = mobileCommandSelection.resolve(view.state.doc)
    if (!selection.eq(view.state.selection)) {
      view.dispatch(view.state.tr.setSelection(selection).setMeta("addToHistory", false))
    }
  } catch {
    mobileCommandSelection = undefined
  }
}

function dismissKeyboard(): void {
  titleInput.blur()
  view?.dom.blur()
  mobileCommandBar.hidden = true
  reportEditorFocus(false)
}

function updateEditorFocus(): void {
  updateMobileCommandBar()
  positionMobileCommandBar()
  reportEditorFocus(document.activeElement === titleInput || view?.hasFocus() == true)
}

function setEditorComposing(isComposing: boolean): void {
  editorIsComposing = isComposing
  updateMobileCommandBar()
}

function reportEditorFocus(isFocused: boolean): void {
  if (reportedEditorFocus === isFocused) return
  reportedEditorFocus = isFocused
  void notifyNative({ type: "editorFocusChanged", isFocused }).catch(showError)
}

function updateMobileCommandBar(): void {
  const titleHasFocus = document.activeElement === titleInput
  const bodyHasFocus = view?.hasFocus() == true
  const state = deriveCommandBarState({
    editorState: view?.state,
    titleFocused: titleHasFocus,
    bodyFocused: bodyHasFocus,
    composing: editorIsComposing,
  })
  const itemByCommand = new Map(state.items.map(item => [item.command, item]))
  for (const commandButton of mobileCommandBar.querySelectorAll<HTMLButtonElement>("button[data-command]")) {
    const item = itemByCommand.get(commandButton.dataset.command as CommandBarCommand)
    if (!item) continue
    commandButton.disabled = item.disabled
    commandButton.setAttribute("aria-disabled", String(item.disabled))
    commandButton.setAttribute("aria-label", item.label)
    if (item.pressed !== undefined) {
      commandButton.setAttribute("aria-pressed", String(item.pressed))
      commandButton.classList.toggle("is-selected", item.pressed)
    }
  }
  mobileCommandBar.hidden = !showsEditorCommandBar(state.visible)
}

function positionMobileCommandBar(): void {
  const viewport = window.visualViewport
  const visibleBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)
  const inset = Math.max(0, window.innerHeight - visibleBottom)
  document.documentElement.style.setProperty("--editor-keyboard-inset", `${inset}px`)
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
          window.setTimeout(() => showSlashMenu(editorView, from), 0)
        }
        if (slashPaletteState) return false
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
      handleKeyDown(_editorView, event) {
        const palette = slashPaletteState
        if (!palette) return false
        if (event.key === "Escape") {
          event.preventDefault()
          closeSlashPalette()
          return true
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          const direction = event.key === "ArrowDown" ? 1 : -1
          setActiveSlashOption(movePaletteSelection(
            palette.activeIndex,
            palette.visibleItems.length,
            direction,
          ), true)
          return true
        }
        if (event.key === "Enter") {
          event.preventDefault()
          const item = palette.visibleItems[palette.activeIndex]
          if (item) executeSlashCommand(item)
          return true
        }
        return false
      },
      handlePaste(editorView, event) {
        const text = event.clipboardData?.getData("text/plain").trim()
        const url = text ? validateHTTPURL(text) : undefined
        if (!url?.ok) return false
        if (!editorView.state.selection.empty) {
          const target = resolveWebLinkTarget(editorView.state)
          event.preventDefault()
          if (!target.ok) {
            setStatus(linkTargetMessage(target))
            return true
          }
          const transaction = linkEditTransaction(
            editorView.state,
            target.target,
            editorView.state.schema.marks.link!,
            url.href,
          )
          if (!transaction) {
            setStatus("The selection changed. Reselect the text and try again.")
            return true
          }
          editorView.dispatch(transaction)
          editorView.focus()
          return true
        }
        const parent = editorView.state.selection.$from.parent
        if (parent.textContent.length > 0) return false
        event.preventDefault()
        showURLChoices(editorView, url.href)
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

function showSlashMenu(editorView: EditorView, triggerFrom?: number): void {
  const run = (command: ReturnType<typeof setBlockType>): (() => void) => () => {
    command(editorView.state, editorView.dispatch, editorView)
    editorView.focus()
  }
  const insertDivider = () => {
    const divider = editorView.state.schema.nodes.horizontal_rule!.create()
    editorView.dispatch(editorView.state.tr.replaceSelectionWith(divider).scrollIntoView())
    editorView.focus()
  }
  const lineBreak = insertSoftLineBreak(editorView.state.schema.nodes.hard_break!)
  const mention = () => {
    if (editorView.state.selection.empty) {
      void showPageMenu(editorView, { kind: "insert", position: editorView.state.selection.from })
    } else {
      const { from, to } = editorView.state.selection
      const selectedText = editorView.state.doc.textBetween(from, to, " ")
      void showPageMenu(editorView, {
        kind: "selection",
        from,
        to,
        query: selectedText.trim(),
        selectedText,
      })
    }
  }
  const applyMark = (mark: MarkType) => () => {
    toggleMark(mark)(editorView.state, editorView.dispatch, editorView)
    editorView.focus()
  }
  const move = (direction: -1 | 1, label: string): PaletteItem => {
    const command = moveBlock(direction)
    return {
      label,
      detail: "Move within this level",
      keywords: ["arrange", "reorder"],
      ariaLabel: label,
      disabled: !command(editorView.state),
      action: run(command),
    }
  }
  const groups: PaletteGroup[] = [
    {
      label: "Text Style",
      items: [
        { label: "Bold", detail: "Strong emphasis", keywords: ["weight"], action: applyMark(editorView.state.schema.marks.strong!) },
        { label: "Italic", detail: "Emphasis", keywords: ["slant"], action: applyMark(editorView.state.schema.marks.em!) },
        { label: "Strikethrough", detail: "Mark as no longer relevant", keywords: ["strike", "deleted"], action: applyMark(editorView.state.schema.marks.strike!) },
        { label: "Inline code", detail: "Technical text", keywords: ["monospace"], action: applyMark(editorView.state.schema.marks.code!) },
      ],
    },
    {
      label: "Block Style",
      items: [
        { label: "Text", detail: "Plain paragraph", keywords: ["body"], action: run(setBlockType(editorView.state.schema.nodes.paragraph!)) },
        { label: "Heading 1", detail: "Page section", keywords: ["h1", "title"], action: run(setBlockType(editorView.state.schema.nodes.heading!, { level: 1 })) },
        { label: "Heading 2", detail: "Subsection", keywords: ["h2"], action: run(setBlockType(editorView.state.schema.nodes.heading!, { level: 2 })) },
        { label: "Heading 3", detail: "Small heading", keywords: ["h3"], action: run(setBlockType(editorView.state.schema.nodes.heading!, { level: 3 })) },
        { label: "Quote", detail: "Quoted passage", keywords: ["blockquote"], action: run(wrapIn(editorView.state.schema.nodes.blockquote!)) },
        { label: "Code", detail: "Code block", keywords: ["preformatted"], action: run(setBlockType(editorView.state.schema.nodes.code_block!)) },
      ],
    },
    {
      label: "List",
      items: [
        { label: "Bulleted list", detail: "Unordered items", keywords: ["bullet"], action: run(wrapInList(editorView.state.schema.nodes.bullet_list!)) },
        { label: "Numbered list", detail: "Ordered items", keywords: ["number"], action: run(wrapInList(editorView.state.schema.nodes.ordered_list!)) },
      ],
    },
    {
      label: "Indentation",
      items: [
        { label: "Indent", detail: "Move list item inward", keywords: ["nest"], action: run(sinkListItem(editorView.state.schema.nodes.list_item!)) },
        { label: "Outdent", detail: "Move list item outward", keywords: ["unnest"], action: run(liftListItem(editorView.state.schema.nodes.list_item!)) },
      ],
    },
    {
      label: "Arrange",
      items: [
        move(-1, "Move block up"),
        move(1, "Move block down"),
      ],
    },
    {
      label: "Insert",
      items: [
        {
          label: "Line break",
          detail: "Continue within this block",
          keywords: ["soft break", "Shift Enter"],
          ariaLabel: "Line break",
          disabled: !lineBreak(editorView.state),
          action: run(lineBreak),
        },
        { label: "Page or date", detail: "Create a native reference", keywords: ["mention", "link", "@"], action: mention },
        ...(!editorView.state.selection.empty ? [{
          label: "Supertag",
          detail: "Find or create a typed page",
          action: () => {
            const { from, to } = editorView.state.selection
            const selectedText = editorView.state.doc.textBetween(from, to, " ")
            void showSupertagMenu(editorView, {
              kind: "selection",
              from,
              to,
              query: selectedText.trim(),
              selectedText,
            })
          },
        }, {
          label: "Link",
          detail: "Add a web link to the selection",
          action: () => { openLinkEditor(editorView.state, editorView.dispatch, editorView) },
        }] : []),
        { label: "Divider", detail: "Separate sections", keywords: ["horizontal rule", "separator"], action: insertDivider },
      ],
    },
  ]
  slashPaletteState = {
    editorView,
    triggerFrom,
    groups,
    visibleItems: [],
    activeIndex: -1,
  }
  slashMenu.classList.add("slash-command-palette")
  slashMenu.setAttribute("role", "listbox")
  slashMenu.setAttribute("aria-label", "Slash commands")
  editorView.dom.setAttribute("aria-controls", slashMenu.id)
  editorView.dom.setAttribute("aria-expanded", "true")
  editorView.dom.setAttribute("aria-haspopup", "listbox")
  updateSlashPaletteFromEditor(true)
}

async function showPageMenu(editorView: EditorView, target: PageReferenceTarget): Promise<void> {
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
    updateMobileCommandBar()
  })
  await update()
  input.focus()
}

async function showSupertagMenu(editorView: EditorView, target: Extract<PageReferenceTarget, { kind: "selection" }>): Promise<void> {
  setPageMenuBusy(false)
  pageMenu.hidden = false
  pageMenu.replaceChildren()
  const heading = document.createElement("div")
  heading.className = "palette-heading"
  heading.textContent = "Use selected text"
  const results = document.createElement("div")
  pageMenu.append(heading, results)
  try {
    const reply = await notifyNative({ type: "listSupertags" }) as { supertags?: SupertagSuggestion[] }
    const plan = selectedTextTaskPlan(target.selectedText, reply.supertags ?? [])
    const pending = pendingTaskFor(target)
    const taskItems: PaletteItem[] = []
    if (pending) {
      taskItems.push({
        label: "Retry task link",
        detail: `Task “${pending.task.title}” already exists in Inbox`,
        action: () => retryPendingTaskLink(editorView, pending),
      })
    } else if (plan.taskTag && plan.title && plan.createLabel) {
      taskItems.push({
        label: plan.createLabel,
        detail: "Create an active task in Inbox and link this text",
        action: () => { void createAndInsertTaggedPage(editorView, target, plan.title!, plan.taskTag!) },
      })
    }
    if (plan.taskTag) {
      taskItems.push({
        label: plan.linkLabel,
        detail: "Choose a Task page without changing the selected text",
        action: () => { void showTaggedPageMenu(editorView, target, plan.taskTag!, false) },
      })
    }
    const groups: PaletteGroup[] = [
      { label: "Task", items: taskItems },
      {
        label: "Supertags",
        items: plan.genericSupertags.map(tag => ({
          label: `#${tag.name}`,
          detail: "Find or create a typed page",
          action: () => { void showTaggedPageMenu(editorView, target, tag) },
        })),
      },
    ].filter(group => group.items.length > 0)
    renderPageMenuGroups(results, groups)
    focusFirstPageMenuControl()
  } catch (error) {
    showError(error)
  }
}

async function showTaggedPageMenu(
  editorView: EditorView,
  target: Extract<PageReferenceTarget, { kind: "selection" }>,
  tag: SupertagSuggestion,
  allowsCreation = true,
): Promise<void> {
  setPageMenuBusy(false)
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
      action: () => {
        if (!insertPageReference(editorView, target, suggestion)) {
          setStatus(`Could not link the selected text to #${tag.name}. Reselect it and try again.`)
        }
      },
    }))
    const title = input.value.trim()
    const exactMatch = suggestions.some(suggestion =>
      suggestion.title.localeCompare(title, undefined, { sensitivity: "accent" }) === 0)
    if (allowsCreation && title && !exactMatch) choices.unshift({
      label: `Create “${title}” as #${tag.name}`,
      detail: "New typed page",
      action: () => { void createAndInsertTaggedPage(editorView, target, title, tag) },
    })
    if (choices.length === 0) {
      const empty = document.createElement("div")
      empty.className = "palette-empty"
      empty.setAttribute("role", "status")
      empty.textContent = tag.id === "task" ? "No matching tasks" : `No matching #${tag.name} pages`
      results.replaceChildren(empty)
    } else {
      renderPalette(results, choices, false)
    }
  }
  input.addEventListener("input", () => void update())
  input.addEventListener("keydown", event => {
    if (event.key !== "Escape") return
    pageMenu.hidden = true
    editorView.focus()
    updateMobileCommandBar()
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
  const normalizedTitle = title.trim()
  if (!normalizedTitle) {
    setStatus(tag.id === "task"
      ? "Select text with a title before creating a task."
      : `Select text with a title before creating #${tag.name}.`)
    return
  }
  setPageMenuBusy(true)
  setStatus(tag.id === "task" ? "Creating task in Inbox…" : `Creating #${tag.name} page…`)
  let reply: { ok?: boolean; pageID?: string; title?: string; message?: string }
  try {
    reply = await notifyNative({
      type: "createTaggedPage",
      title: normalizedTitle,
      supertagID: tag.id,
    }) as typeof reply
  } catch (error) {
    setPageMenuBusy(false)
    setStatus(creationFailureMessage(tag, error))
    return
  }
  setPageMenuBusy(false)
  if (!reply.ok || !reply.pageID) {
    setStatus(creationFailureMessage(tag, reply.message))
    return
  }
  const created = { pageID: reply.pageID, title: reply.title ?? normalizedTitle }
  if (insertPageReference(editorView, target, created)) {
    if (pendingTaskReference?.task.pageID === created.pageID) pendingTaskReference = undefined
    return
  }
  if (tag.id === "task") {
    pendingTaskReference = { sourcePageID: pageID, target, task: created }
    showPendingTaskLink(editorView, pendingTaskReference)
    return
  }
  setStatus(`#${tag.name} page created, but the link was not added.`)
}

function creationFailureMessage(tag: SupertagSuggestion, error: unknown): string {
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (tag.id === "task") {
    const message = "Could not create the task in Inbox."
    return detail && detail !== "Could not create the tagged page" ? `${message} ${detail}` : message
  }
  return detail || `Could not create #${tag.name}.`
}

function pendingTaskFor(
  target: Extract<PageReferenceTarget, { kind: "selection" }>,
): PendingTaskReference | undefined {
  const pending = pendingTaskReference
  if (!pending || pending.sourcePageID !== pageID) return undefined
  return pending.target.from === target.from
    && pending.target.to === target.to
    && pending.target.selectedText === target.selectedText
    ? pending
    : undefined
}

function showPendingTaskLink(editorView: EditorView, pending: PendingTaskReference): void {
  const heading = document.createElement("div")
  heading.className = "palette-heading"
  heading.textContent = "Task link needs attention"
  const message = document.createElement("div")
  message.className = "palette-empty"
  message.setAttribute("role", "status")
  message.textContent = "Task created in Inbox, but the link was not added."
  const actions = document.createElement("div")
  renderPalette(actions, [{
    label: "Retry task link",
    detail: `Use the existing Inbox task “${pending.task.title}”`,
    action: () => retryPendingTaskLink(editorView, pending),
  }], false)
  pageMenu.replaceChildren(heading, message, actions)
  pageMenu.hidden = false
  setStatus(message.textContent)
  focusFirstPageMenuControl()
}

function retryPendingTaskLink(editorView: EditorView, pending: PendingTaskReference): void {
  if (insertPageReference(editorView, pending.target, pending.task)) {
    if (pendingTaskReference?.task.pageID === pending.task.pageID) pendingTaskReference = undefined
    return
  }
  pendingTaskReference = pending
  showPendingTaskLink(editorView, pending)
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

function insertPageReference(editorView: EditorView, target: PageReferenceTarget, suggestion: PageSuggestion): boolean {
  const state = editorView.state
  const mark = state.schema.marks.page_reference!.create({ pageID: suggestion.pageID, label: suggestion.title })
  if (target.kind === "selection") {
    if (!handle) return false
    if (target.from === target.to || target.from < 0 || target.to > state.doc.content.size) return false
    const currentText = state.doc.textBetween(target.from, target.to, " ")
    if (currentText !== target.selectedText) return false
    const marked = persistSelectedMark(
      handle,
      ["body"],
      schemaAdapter,
      state,
      state.schema.marks.page_reference!,
      mark.attrs,
      { from: target.from, to: target.to },
    )
    if (!marked) return false
  } else {
    const triggerLength = target.trigger?.length ?? 0
    const candidateFrom = Math.max(0, target.position - triggerLength)
    const current = state.doc.textBetween(candidateFrom, target.position)
    const from = target.trigger && current === target.trigger ? candidateFrom : target.position
    editorView.dispatch(state.tr.replaceWith(from, target.position, state.schema.text(suggestion.title, [mark])))
  }
  pageMenu.hidden = true
  editorView.focus()
  return true
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

function openLinkEditor(state: EditorState, dispatch?: EditorView["dispatch"], editorView?: EditorView): boolean {
  if (!dispatch || !editorView) return false
  const target = resolveWebLinkTarget(state)
  if (!target.ok) {
    setStatus(linkTargetMessage(target))
    return true
  }
  showLinkEditor(editorView, target.target)
  return true
}

function resolveWebLinkTarget(state: EditorState): LinkEditResolution {
  const identityMark = state.schema.marks.page_reference
  return resolveLinkEditTarget(state, state.schema.marks.link!, identityMark ? [identityMark] : [])
}

function linkTargetMessage(resolution: Extract<LinkEditResolution, { ok: false }>): string {
  switch (resolution.reason) {
  case "identity-mark":
    return "Page references keep their identity. Select plain text instead."
  case "ambiguous-link-range":
    return "Select one unlinked text range, or place the cursor inside one link."
  case "non-text-selection":
    return "Links can only be added within one text block."
  case "selection-required":
    return "Select text, or place the cursor inside a link."
  }
}

function showLinkEditor(editorView: EditorView, target: LinkEditTarget): void {
  closeSlashPalette()
  pageMenu.hidden = true
  closeLinkEditor(false)
  linkEditorState = { editorView, target, selection: editorView.state.selection }

  const heading = document.createElement("div")
  heading.id = "link-editor-heading"
  heading.className = "palette-heading"
  heading.textContent = target.kind === "edit" ? "Edit link" : "Add link"

  const form = document.createElement("form")
  form.className = "link-editor-form"
  const label = document.createElement("label")
  label.className = "palette-group-label"
  label.htmlFor = "link-editor-url"
  label.textContent = "Web address"
  const input = document.createElement("input")
  input.id = "link-editor-url"
  input.type = "url"
  input.inputMode = "url"
  input.setAttribute("autocomplete", "url")
  input.spellcheck = false
  input.placeholder = "https://example.com"
  input.value = target.href ?? ""
  input.setAttribute("aria-describedby", "link-editor-error")
  const error = document.createElement("div")
  error.id = "link-editor-error"
  error.className = "link-editor-error"
  error.setAttribute("role", "status")
  error.setAttribute("aria-live", "polite")

  const actions = document.createElement("div")
  actions.className = "link-editor-actions"
  if (target.kind === "edit") {
    const remove = document.createElement("button")
    remove.type = "button"
    remove.textContent = "Remove link"
    remove.addEventListener("click", () => applyLinkEditor())
    actions.append(remove)
  }
  const submit = document.createElement("button")
  submit.type = "submit"
  submit.className = "link-editor-submit"
  submit.textContent = target.kind === "edit" ? "Update link" : "Add link"
  actions.append(submit)
  form.append(label, input, error, actions)
  form.addEventListener("submit", event => {
    event.preventDefault()
    const validation = validateHTTPURL(input.value)
    if (!validation.ok) {
      input.setAttribute("aria-invalid", "true")
      error.textContent = validation.message
      input.focus()
      return
    }
    input.removeAttribute("aria-invalid")
    error.textContent = ""
    applyLinkEditor(validation.href)
  })

  linkMenu.replaceChildren(heading, form)
  linkMenu.hidden = false
  linkMenu.setAttribute("role", "dialog")
  linkMenu.setAttribute("aria-labelledby", heading.id)
  editorView.dom.setAttribute("aria-controls", linkMenu.id)
  editorView.dom.setAttribute("aria-expanded", "true")
  editorView.dom.setAttribute("aria-haspopup", "dialog")
  positionLinkEditor()
  window.requestAnimationFrame(() => {
    positionLinkEditor()
    input.focus()
    if (target.kind === "edit") input.select()
  })
}

function applyLinkEditor(href?: string): void {
  const active = linkEditorState
  if (!active) return
  const { editorView, target } = active
  const transaction = linkEditTransaction(
    editorView.state,
    target,
    editorView.state.schema.marks.link!,
    href,
  )
  if (!transaction) {
    const error = linkMenu.querySelector<HTMLElement>("#link-editor-error")
    if (error) error.textContent = "The selection changed. Reselect the text and try again."
    return
  }
  hideLinkEditor()
  editorView.dispatch(transaction)
  editorView.focus()
}

function closeLinkEditor(restoreSelection = true): void {
  const active = linkEditorState
  hideLinkEditor()
  if (!active || !restoreSelection) return
  if (!active.editorView.state.selection.eq(active.selection)) {
    active.editorView.dispatch(active.editorView.state.tr.setSelection(active.selection))
  }
  active.editorView.focus()
}

function hideLinkEditor(): void {
  const active = linkEditorState
  if (active) {
    active.editorView.dom.setAttribute("aria-expanded", "false")
    active.editorView.dom.removeAttribute("aria-controls")
    active.editorView.dom.removeAttribute("aria-haspopup")
  }
  linkEditorState = undefined
  linkMenu.hidden = true
  linkMenu.removeAttribute("role")
  linkMenu.removeAttribute("aria-labelledby")
  linkMenu.replaceChildren()
  linkMenu.style.removeProperty("left")
  linkMenu.style.removeProperty("top")
}

function positionLinkEditor(): void {
  const active = linkEditorState
  if (!active || linkMenu.hidden) return
  const caret = active.editorView.coordsAtPos(active.target.from)
  const visualViewport = window.visualViewport
  const viewport = {
    left: visualViewport?.offsetLeft ?? 0,
    top: visualViewport?.offsetTop ?? 0,
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
  }
  const position = placePalette(caret, {
    width: linkMenu.offsetWidth,
    height: linkMenu.offsetHeight,
  }, viewport)
  linkMenu.style.left = `${position.left}px`
  linkMenu.style.top = `${position.top}px`
}

function editorInputRules(schema: Schema): InputRule[] {
  return [
    ...inlineCodeInputRules(schema),
    ...smartQuotes,
    ...markdownEmphasisInputRules(schema),
    textblockTypeInputRule(/^#\s$/, schema.nodes.heading!, { level: 1 }),
    textblockTypeInputRule(/^##\s$/, schema.nodes.heading!, { level: 2 }),
    textblockTypeInputRule(/^###\s$/, schema.nodes.heading!, { level: 3 }),
    textblockTypeInputRule(/^```$/, schema.nodes.code_block!),
    wrappingInputRule(/^>\s$/, schema.nodes.blockquote!),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
    wrappingInputRule(/^\s*(\d+)\.\s$/, schema.nodes.ordered_list!, match => ({ order: Number(match[1]) })),
  ]
}

function updateSlashPaletteFromEditor(force = false): void {
  const palette = slashPaletteState
  if (!palette) return
  let query = ""
  if (palette.triggerFrom !== undefined) {
    const { from, empty, $from } = palette.editorView.state.selection
    const $trigger = palette.editorView.state.doc.resolve(palette.triggerFrom)
    if (!empty || from < palette.triggerFrom || !$trigger.sameParent($from)) {
      closeSlashPalette()
      return
    }
    const triggerAndQuery = palette.editorView.state.doc.textBetween(palette.triggerFrom, from)
    const parsedQuery = slashCommandQuery(triggerAndQuery)
    if (parsedQuery === undefined) {
      closeSlashPalette()
      return
    }
    query = parsedQuery
  }
  if (!force && query === palette.query) {
    positionSlashPalette()
    return
  }
  palette.query = query
  const groups = palette.groups
    .map(group => ({ ...group, items: filterCommands(group.items, query) }))
    .filter(group => group.items.length > 0)
  palette.visibleItems = groups.flatMap(group => group.items)
  palette.activeIndex = palette.visibleItems.length > 0 ? 0 : -1
  renderSlashPalette(groups)
  positionSlashPalette()
}

function renderSlashPalette(groups: PaletteGroup[]): void {
  const palette = slashPaletteState
  if (!palette) return
  const options: HTMLButtonElement[] = []
  const sections = groups.map((group, groupIndex) => {
    const section = document.createElement("section")
    section.className = "palette-group"
    section.setAttribute("role", "group")
    const heading = document.createElement("div")
    heading.className = "palette-group-label"
    heading.id = `slash-command-group-${groupIndex}`
    heading.textContent = group.label
    section.setAttribute("aria-labelledby", heading.id)
    const items = document.createElement("div")
    items.replaceChildren(...group.items.map(item => {
      const optionIndex = options.length
      const option = button(item, () => executeSlashCommand(item))
      option.id = `slash-command-option-${optionIndex}`
      option.setAttribute("role", "option")
      option.setAttribute("aria-selected", "false")
      option.addEventListener("pointerdown", event => event.preventDefault())
      option.addEventListener("pointerenter", () => setActiveSlashOption(optionIndex))
      options.push(option)
      return option
    }))
    section.append(heading, items)
    return section
  })
  if (sections.length === 0) {
    const empty = document.createElement("div")
    empty.className = "palette-empty"
    empty.setAttribute("role", "status")
    empty.textContent = "No matching commands"
    slashMenu.replaceChildren(empty)
  } else {
    slashMenu.replaceChildren(...sections)
  }
  slashMenu.hidden = false
  setActiveSlashOption(palette.activeIndex)
}

function setActiveSlashOption(index: number, scroll = false): void {
  const palette = slashPaletteState
  if (!palette) return
  palette.activeIndex = index
  const options = slashMenu.querySelectorAll<HTMLElement>("[role=option]")
  let active: HTMLElement | undefined
  options.forEach((option, optionIndex) => {
    const selected = optionIndex === index
    option.classList.toggle("is-selected", selected)
    option.setAttribute("aria-selected", String(selected))
    if (selected) active = option
  })
  if (active) {
    slashMenu.setAttribute("aria-activedescendant", active.id)
    palette.editorView.dom.setAttribute("aria-activedescendant", active.id)
    if (scroll) active.scrollIntoView({ block: "nearest" })
  } else {
    slashMenu.removeAttribute("aria-activedescendant")
    palette.editorView.dom.removeAttribute("aria-activedescendant")
  }
}

function executeSlashCommand(item: PaletteItem): void {
  const palette = slashPaletteState
  if (!palette || item.disabled) return
  const { editorView, triggerFrom } = palette
  closeSlashPalette()
  if (triggerFrom !== undefined) {
    const { from, empty, $from } = editorView.state.selection
    const $trigger = editorView.state.doc.resolve(triggerFrom)
    if (empty && from >= triggerFrom && $trigger.sameParent($from)) {
      const triggerAndQuery = editorView.state.doc.textBetween(triggerFrom, from)
      if (slashCommandQuery(triggerAndQuery) !== undefined) {
        editorView.dispatch(editorView.state.tr.delete(triggerFrom, from))
      }
    }
  }
  item.action()
}

function closeSlashPalette(): void {
  const palette = slashPaletteState
  if (palette) {
    palette.editorView.dom.setAttribute("aria-expanded", "false")
    palette.editorView.dom.removeAttribute("aria-activedescendant")
    palette.editorView.dom.removeAttribute("aria-controls")
    palette.editorView.dom.removeAttribute("aria-haspopup")
  }
  slashPaletteState = undefined
  slashMenu.hidden = true
  slashMenu.classList.remove("slash-command-palette")
  slashMenu.removeAttribute("role")
  slashMenu.removeAttribute("aria-label")
  slashMenu.replaceChildren()
  slashMenu.removeAttribute("aria-activedescendant")
  slashMenu.style.removeProperty("left")
  slashMenu.style.removeProperty("top")
}

function positionSlashPalette(): void {
  const palette = slashPaletteState
  if (!palette || slashMenu.hidden) return
  const selectionPosition = palette.editorView.state.selection.from
  const caret = palette.editorView.coordsAtPos(selectionPosition)
  const visualViewport = window.visualViewport
  const viewport = {
    left: visualViewport?.offsetLeft ?? 0,
    top: visualViewport?.offsetTop ?? 0,
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
  }
  const position = placePalette(caret, {
    width: slashMenu.offsetWidth,
    height: slashMenu.offsetHeight,
  }, viewport)
  slashMenu.style.left = `${position.left}px`
  slashMenu.style.top = `${position.top}px`
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

function renderPageMenuGroups(container: HTMLElement, groups: PaletteGroup[]): void {
  const sections = groups.map((group, groupIndex) => {
    const section = document.createElement("section")
    section.className = "palette-group"
    section.setAttribute("role", "group")
    const heading = document.createElement("div")
    heading.className = "palette-group-label"
    heading.id = `selected-text-group-${groupIndex}`
    heading.textContent = group.label
    section.setAttribute("aria-labelledby", heading.id)
    const items = document.createElement("div")
    renderPalette(items, group.items, false)
    section.append(heading, items)
    return section
  })
  container.replaceChildren(...sections)
}

function focusFirstPageMenuControl(): void {
  window.requestAnimationFrame(() => {
    pageMenu.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])")?.focus()
  })
}

function setPageMenuBusy(isBusy: boolean): void {
  if (isBusy) pageMenu.setAttribute("aria-busy", "true")
  else pageMenu.removeAttribute("aria-busy")
  pageMenu.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")
    .forEach(control => { control.disabled = isBusy })
}

function renderPalette(container: HTMLElement, items: PaletteItem[], reveal = true): void {
  const nodes = items.map(item => button(item))
  container.replaceChildren(...nodes)
  if (reveal) container.hidden = false
}

function button(item: PaletteItem, action = item.action): HTMLButtonElement {
  const element = document.createElement("button")
  element.type = "button"
  element.disabled = item.disabled ?? false
  if (item.ariaLabel) element.setAttribute("aria-label", item.ariaLabel)
  if (item.disabled) element.setAttribute("aria-disabled", "true")
  if (item.detail) {
    const title = document.createElement("span")
    title.className = "palette-title"
    title.textContent = item.label
    const subtitle = document.createElement("span")
    subtitle.className = "palette-subtitle"
    subtitle.textContent = item.detail
    element.replaceChildren(title, subtitle)
  } else {
    element.textContent = item.label
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
