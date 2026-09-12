import { Extension, InputRule } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { EditorState, Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { defaultComponent } from '../lib/component'

export interface CompletedFence {
  /** UTF-16 offsets, matching JavaScript strings and ProseMirror positions. */
  from: number
  to: number
  language: string
  source: string
  fenceLength: number
}
interface Line { from: number; contentEnd: number; to: number; text: string }
const openingPattern = /^ {0,3}(`{3,})([^`]*)$/u
const closingPattern = /^ {0,3}(`{3,})[\t ]*$/u
const openingInputPattern = /^ {0,3}(`{3,})([^`]*?)[\t ]$/u
export const fenceAuthoringKey = new PluginKey<ReadonlyMap<number, number>>('fieldnotesFences')
type FenceAction = { open: { position: number; length: number } } | { close: number }

function lines(text: string): Line[] {
  const result: Line[] = []
  let from = 0
  for (const match of text.matchAll(/\r\n|\n|\r/gu)) {
    result.push({ from, contentEnd: match.index, to: match.index + match[0].length, text: text.slice(from, match.index) })
    from = match.index + match[0].length
  }
  result.push({ from, contentEnd: text.length, to: text.length, text: text.slice(from) })
  return result
}

/** Unmatched openings, shorter closing markers, and inline fences stay literal. */
export function parseCompletedFences(text: string): CompletedFence[] {
  const result: CompletedFence[] = []
  let opening: { line: Line; length: number; language: string } | undefined
  for (const line of lines(text)) {
    if (opening) {
      const closing = closingPattern.exec(line.text)
      if (!closing || closing[1]!.length < opening.length) continue
      result.push({
        from: opening.line.from, to: line.contentEnd, language: opening.language,
        source: text.slice(opening.line.to, line.from).replace(/(?:\r\n|\r|\n)$/u, ''),
        fenceLength: opening.length,
      })
      opening = undefined
    } else {
      const match = openingPattern.exec(line.text)
      if (match && line.to > line.contentEnd) opening = { line, length: match[1]!.length, language: match[2]!.trim() }
    }
  }
  return result
}

function fencedNode(schema: Schema, language: string, source: string): PMNode {
  const token = language.trim().split(/\s/u)[0]?.toLowerCase()
  if (token === 'd2' || token === 'mermaid') {
    const component = { ...defaultComponent(token === 'd2' ? 'diagram' : 'mermaid'), source }
    return schema.nodes.paragraph!.create(null, schema.nodes.component!.create({ component }))
  }
  return schema.nodes.codeBlock!.create({ language }, source ? schema.text(source) : undefined)
}

/** Construct editor nodes directly. Code source keeps its exact line endings. */
export function fencedTextNodes(schema: Schema, text: string): PMNode[] | undefined {
  const fences = parseCompletedFences(text)
  if (!fences.length) return undefined
  const nodes: PMNode[] = []
  let inline: PMNode[] = [], afterCode = false, cursor = 0
  const flushParagraph = () => { nodes.push(schema.nodes.paragraph!.create(null, inline)); inline = [] }
  const appendText = (value: string) => {
    for (const part of value.split(/(\r\n|\n|\r)/u)) {
      if (/^(?:\r\n|\n|\r)$/u.test(part)) {
        if (afterCode) afterCode = false
        else flushParagraph()
      } else if (part) {
        afterCode = false
        inline.push(schema.text(part))
      }
    }
  }
  for (const fence of fences) {
    appendText(text.slice(cursor, fence.from))
    const node = fencedNode(schema, fence.language, fence.source)
    if (node.type.name === 'paragraph') {
      node.forEach(child => inline.push(child))
      afterCode = false
    } else {
      if (inline.length) flushParagraph()
      nodes.push(node)
      afterCode = true
    }
    cursor = fence.to
  }
  appendText(text.slice(cursor))
  if (inline.length || !afterCode) flushParagraph()
  return nodes
}

function protectedSelection(state: EditorState): boolean {
  for (const position of [state.selection.$from, state.selection.$to]) {
    for (let depth = position.depth; depth > 0; depth--) {
      const node = position.node(depth)
      if (node.type.spec.code || node.type.name === 'component') return true
    }
  }
  return state.selection.$from.marks().some(mark => mark.type.spec.code)
}

export function createFencedPasteTransaction(state: EditorState, text: string): Transaction | undefined {
  if (protectedSelection(state)) return undefined
  const nodes = fencedTextNodes(state.schema, text)
  if (!nodes) return undefined
  const slice = new Slice(Fragment.fromArray(nodes), nodes[0]?.type.name === 'paragraph' ? 1 : 0, nodes.at(-1)?.type.name === 'paragraph' ? 1 : 0)
  return closeHistory(state.tr).replaceSelection(slice).setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView()
}

/** Enter closes only a code block opened during this editing session. */
export function createFenceEnterTransaction(state: EditorState): Transaction | undefined {
  const { $from, empty } = state.selection
  if (!empty || !$from.depth || $from.parentOffset !== $from.parent.content.size) return undefined
  const parent = $from.parent, from = $from.before()
  if (parent.type.name === 'codeBlock') {
    const length = fenceAuthoringKey.getState(state)?.get(from)
    if (!length) return undefined
    const lastLine = lines(parent.textContent).at(-1)!
    const closing = closingPattern.exec(lastLine.text)
    if (!closing || closing[1]!.length < length) return undefined
    const source = parent.textContent.slice(0, lastLine.from).replace(/(?:\r\n|\r|\n)$/u, '')
    const content = fencedNode(state.schema, String(parent.attrs.language ?? ''), source)
    const after = state.schema.nodes.paragraph!.create()
    if (!$from.node(-1).canReplace($from.index(-1), $from.indexAfter(-1), Fragment.fromArray([content, after]))) return undefined
    const transaction = closeHistory(state.tr).replaceWith(from, from + parent.nodeSize, [content, after])
      .setMeta(fenceAuthoringKey, { close: from } satisfies FenceAction)
    transaction.setSelection(TextSelection.create(transaction.doc, from + content.nodeSize + 1))
    return transaction.scrollIntoView()
  }
  if (parent.type.name !== 'paragraph' || protectedSelection(state)) return undefined
  let onlyText = true
  parent.forEach(child => { if (!child.isText) onlyText = false })
  if (!onlyText) return undefined
  const opening = openingPattern.exec(parent.textContent), type = state.schema.nodes.codeBlock
  if (!opening || !type || !$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), type)) return undefined
  const transaction = closeHistory(state.tr).replaceWith(from, from + parent.nodeSize, type.create({ language: opening[2]!.trim() }))
    .setMeta(fenceAuthoringKey, { open: { position: from, length: opening[1]!.length } } satisfies FenceAction)
  transaction.setSelection(TextSelection.create(transaction.doc, from + 1))
  return transaction.scrollIntoView()
}

/** Ownership is transient plugin state, never a document attribute or saved format. */
export function createFencedCodePlugin(): Plugin<ReadonlyMap<number, number>> {
  // History retains immutable node objects in inverse steps. Remembering those
  // identities restores ownership on undo/redo without serializing editor IDs.
  const known = new WeakMap<PMNode, number>()
  return new Plugin<ReadonlyMap<number, number>>({
    key: fenceAuthoringKey,
    state: {
      init: () => new Map(),
      apply(transaction, previous, _oldState, newState) {
        const action = transaction.getMeta(fenceAuthoringKey) as FenceAction | undefined
        if (!transaction.docChanged && !action) return previous
        for (const [position, length] of previous) {
          if (action && 'close' in action && action.close === position) continue
          const mapped = transaction.mapping.mapResult(position, 1)
          const node = mapped.deleted ? undefined : newState.doc.nodeAt(mapped.pos)
          if (node?.type.name === 'codeBlock') known.set(node, length)
        }
        if (action && 'open' in action) {
          const node = newState.doc.nodeAt(action.open.position)
          if (node?.type.name === 'codeBlock') known.set(node, action.open.length)
        }
        const next = new Map<number, number>()
        newState.doc.descendants((node, position) => {
          if (node.type.name !== 'codeBlock') return
          const length = known.get(node)
          if (length) next.set(position, length)
          return false
        })
        return next
      },
    },
    props: {
      handlePaste(view, event) {
        if (!event.clipboardData || event.clipboardData.getData('text/html')) return false
        try {
          const transaction = createFencedPasteTransaction(view.state, event.clipboardData.getData('text/plain'))
          if (!transaction) return false
          view.dispatch(transaction)
          return true
        } catch { return false /* Default paste preserves literal source if the schema cannot fit it. */ }
      },
    },
  })
}

export const FencedCodeAuthoring = Extension.create({
  name: 'fencedCodeAuthoring',
  priority: 1_100,
  addInputRules() {
    return [new InputRule({
      find: openingInputPattern,
      handler: ({ state, range, match }) => {
        const start = state.doc.resolve(range.from), type = this.editor.schema.nodes.codeBlock!
        if (start.parent.type.name !== 'paragraph' || start.parentOffset !== 0 || range.to !== start.end() || protectedSelection(state)) return null
        let onlyText = true
        start.parent.forEach(child => { if (!child.isText) onlyText = false })
        if (!onlyText || !start.node(-1).canReplaceWith(start.index(-1), start.indexAfter(-1), type)) return null
        state.tr.delete(range.from, range.to).setBlockType(range.from, range.from, type, { language: match[2]!.trim() })
          .setMeta(fenceAuthoringKey, { open: { position: start.before(), length: match[1]!.length } } satisfies FenceAction)
      },
    })]
  },
  addKeyboardShortcuts() {
    return { Enter: () => {
      const transaction = createFenceEnterTransaction(this.editor.state)
      if (!transaction) return false
      this.editor.view.dispatch(transaction)
      return true
    } }
  },
  addProseMirrorPlugins() { return [createFencedCodePlugin()] },
})
