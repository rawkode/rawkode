import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"
import type { Node as PMNode } from "prosemirror-model"

export type FindTextRange = {
  from: number
  to: number
}

export type FindMatch = FindTextRange & {
  source: "title" | "body"
  bodyIndex?: number
}

type FindDecorationState = {
  query: string
  ranges: FindTextRange[]
  activeBodyIndex: number
  decorations: DecorationSet
}

type FindDecorationMeta = {
  query: string
  activeBodyIndex: number
}

export const findInPagePluginKey = new PluginKey<FindDecorationState>("find-in-page")

/** Literal, case-insensitive search with JavaScript's Unicode-aware simple case folding. */
export function findLiteralRanges(text: string, query: string): FindTextRange[] {
  if (!query) return []
  const expression = new RegExp(escapeRegularExpression(query), "giu")
  return Array.from(text.matchAll(expression), match => ({
    from: match.index,
    to: match.index + match[0].length,
  }))
}

/**
 * Searches visible text in each ProseMirror text block independently. Adjacent
 * text nodes are joined so formatting marks do not split a match. Inline atoms,
 * including soft breaks, split searchable segments; block/embed attributes are
 * never inspected.
 */
export function findBodyMatches(doc: PMNode, query: string): FindTextRange[] {
  if (!query) return []
  const matches: FindTextRange[] = []
  doc.descendants((node, position) => {
    if (!node.isTextblock) return !node.isAtom

    let segment = ""
    let segmentStart = position + 1
    const appendSegmentMatches = () => {
      for (const match of findLiteralRanges(segment, query)) {
        matches.push({
          from: segmentStart + match.from,
          to: segmentStart + match.to,
        })
      }
      segment = ""
    }

    node.forEach((child, offset) => {
      if (child.isText) {
        if (!segment) segmentStart = position + 1 + offset
        segment += child.text ?? ""
      } else {
        appendSegmentMatches()
      }
    })
    appendSegmentMatches()
    return false
  })
  return matches
}

export function findPageMatches(title: string, doc: PMNode, query: string): FindMatch[] {
  const titleMatches = findLiteralRanges(title, query).map(match => ({
    ...match,
    source: "title" as const,
  }))
  const bodyMatches = findBodyMatches(doc, query).map((match, bodyIndex) => ({
    ...match,
    source: "body" as const,
    bodyIndex,
  }))
  return [...titleMatches, ...bodyMatches]
}

export function moveFindSelection(
  activeIndex: number,
  matchCount: number,
  direction: -1 | 1,
): number {
  if (matchCount <= 0) return -1
  if (activeIndex < 0 || activeIndex >= matchCount) return direction === 1 ? 0 : matchCount - 1
  return (activeIndex + direction + matchCount) % matchCount
}

export function createFindInPagePlugin(): Plugin<FindDecorationState> {
  return new Plugin<FindDecorationState>({
    key: findInPagePluginKey,
    state: {
      init: (_, state) => decorationState(state.doc, "", -1),
      apply(transaction, current, _oldState, newState) {
        const meta = transaction.getMeta(findInPagePluginKey) as FindDecorationMeta | undefined
        const query = meta?.query ?? current.query
        const activeBodyIndex = meta?.activeBodyIndex ?? current.activeBodyIndex
        if (!meta && !transaction.docChanged) return current
        return decorationState(newState.doc, query, activeBodyIndex)
      },
    },
    props: {
      decorations(state) {
        return findInPagePluginKey.getState(state)?.decorations ?? DecorationSet.empty
      },
    },
  })
}

/** Creates a UI-only transaction: no document change and no history entry. */
export function findDecorationTransaction(
  state: EditorState,
  query: string,
  activeBodyIndex: number,
): Transaction {
  return state.tr
    .setMeta(findInPagePluginKey, { query, activeBodyIndex } satisfies FindDecorationMeta)
    .setMeta("addToHistory", false)
}

function decorationState(doc: PMNode, query: string, activeBodyIndex: number): FindDecorationState {
  const ranges = findBodyMatches(doc, query)
  const decorations = DecorationSet.create(doc, ranges.map((range, index) => Decoration.inline(
    range.from,
    range.to,
    {
      class: index === activeBodyIndex ? "find-match is-active" : "find-match",
      ...(index === activeBodyIndex ? { "data-find-active": "true" } : {}),
    },
    { findMatchIndex: index },
  )))
  return { query, ranges, activeBodyIndex, decorations }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
