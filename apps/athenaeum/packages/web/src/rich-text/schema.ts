import type { Mark, Node as PMNode } from "prosemirror-model"
import type * as Automerge from "@automerge/automerge"
import { SchemaAdapter, type MappedSchemaSpec } from "../vendor/automerge-prosemirror/schema.js"
import type { BlockMarker } from "../vendor/automerge-prosemirror/types.js"

// The rich-text ProseMirror schema (task item 1). Built fresh against the vendored
// `SchemaAdapter`/`MappedSchemaSpec` machinery (`../vendor/automerge-prosemirror/schema.ts`) rather
// than reusing `basicSchema.ts` verbatim — the required node/mark set here (heading levels 1-3
// only, a checklist/task-list variant, strikethrough, inline code, and the new `entityRef` mark) is
// close enough to upstream's `basicSchema` that copying its DOM-spec boilerplate for the nodes we
// keep (paragraph/blockquote/code_block/lists/link/em/strong) was more legible than layering
// overrides on top of it, and it lets us drop `image`/`aside` entirely (explicitly out of scope
// this pass per the task's hard constraints) instead of shipping dead schema surface.
//
// Every node/mark below either mirrors `basicSchema.ts`'s own `automerge` mapping 1:1 (paragraph,
// blockquote, code_block via `block: "code-block"`, ordered_list/bullet_list/list_item, link, em,
// strong — same block/mark names, so a document written by this schema and one written by upstream
// `basicSchema` would round-trip through the same Automerge block-marker vocabulary for the shapes
// they share) or extends the same `within`/`attrParsers` extension points `docs/rich-text-editor-
// decisions.md` §1 already identified as "one more `MappedNodeSpec`/`MappedMarkSpec` entry": task
// lists (`list_item`'s existing `within` pattern, generalized to a second list container) and the
// `entityRef` mark (a new, narrow `MappedMarkSpec`).

const pDOM = ["p", 0] as const
const blockquoteDOM = ["blockquote", 0] as const
const hrDOM = ["hr"] as const
const preDOM = ["pre", ["code", 0]] as const
const olDOM = ["ol", 0] as const
const ulDOM = ["ul", 0] as const
const liDOM = ["li", 0] as const
const emDOM = ["em", 0] as const
const strongDOM = ["strong", 0] as const
const codeDOM = ["code", 0] as const
const strikeDOM = ["s", 0] as const

/** Immutable, JSON-serialized `{nodeId, label}` payload carried by an Automerge `entity-ref` mark
 *  — mirrors `link`'s own JSON-string mark-value convention in `basicSchema.ts` (marks values are
 *  `am.MarkValue`, a scalar; a JSON string is the established way this ecosystem packs a small
 *  structured payload into one). `nodeId` is the immutable entity id (`new-notes/docs/
 *  architecture.md`: "carrying an immutable entity ID in a non-expanding mark"); `label` is a
 *  point-in-time display snapshot of the referenced node's title so the mention still reads
 *  sensibly even before the picker's `listNodes` lookup resolves it live.
 */
export interface EntityRefPayload {
  readonly nodeId: string
  readonly label: string
}

/** Same "immutable id + point-in-time label, JSON-serialized into the Automerge mark value" shape
 *  as `EntityRefPayload` above, for a `#`-typed Supertag reference instead of an `@`-typed entity
 *  mention (docs/supertag-centering-decisions.md §2's `supertagRef` mark). `tagId` is the
 *  immutable `Tag.id`; `label` is a point-in-time snapshot of the tag's name. */
export interface SupertagRefPayload {
  readonly tagId: string
  readonly label: string
}

const richTextSchemaSpec: MappedSchemaSpec = {
  nodes: {
    doc: { content: "block+" },

    paragraph: {
      automerge: { block: "paragraph" },
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => pDOM
    },

    // Required by `SchemaAdapter` — the forward-compat catch-all for block-marker types this
    // schema doesn't recognize (e.g. a future web-schema version's node types). Never produced by
    // this editor's own commands; kept exactly per upstream's `basicSchema.ts` shape.
    unknownBlock: {
      automerge: { unknownBlock: true },
      group: "block",
      content: "block+",
      parseDOM: [{ tag: "div", attrs: { "data-unknown-block": "true" } }],
      toDOM: () => ["div", { "data-unknown-block": "true" }, 0]
    },

    heading: {
      automerge: {
        block: "heading",
        attrParsers: {
          fromAutomerge: (block: BlockMarker) => ({ level: clampHeadingLevel(block.attrs.level) }),
          fromProsemirror: (node: PMNode) => ({ level: node.attrs.level })
        }
      },
      attrs: { level: { default: 1 } },
      content: "inline*",
      group: "block",
      defining: true,
      parseDOM: [
        { tag: "h1", attrs: { level: 1 } },
        { tag: "h2", attrs: { level: 2 } },
        { tag: "h3", attrs: { level: 3 } }
      ],
      toDOM: (node) => ["h" + clampHeadingLevel(node.attrs.level), 0]
    },

    blockquote: {
      automerge: { block: "blockquote" },
      content: "block+",
      group: "block",
      defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => blockquoteDOM
    },

    horizontal_rule: {
      // Block-level "leaf" (no content, like `image` in `basicSchema.ts`) — `isEmbed: true` is
      // what makes `traverseNode`'s `blockForNode` emit a block marker for it even though it never
      // carries `isAmgBlock: true` itself the way a textblock does (see the vendored `traversal.ts`
      // `blockForNode`'s `blockMapping.isEmbed` branch). Upstream's own `basicSchema.ts` omits an
      // `automerge` mapping for `horizontal_rule` entirely, which means it never round-trips
      // through Automerge at all in the stock package — a real gap this schema fixes rather than
      // inherits, since "divider" is explicitly in this pass's required block set.
      automerge: { block: "divider", isEmbed: true },
      group: "block",
      parseDOM: [{ tag: "hr" }],
      toDOM: () => hrDOM
    },

    code_block: {
      automerge: { block: "code-block" },
      content: "text*",
      marks: "",
      group: "block",
      code: true,
      defining: true,
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      toDOM: () => preDOM
    },

    text: { group: "inline" },

    ordered_list: {
      group: "block",
      content: "list_item+",
      attrs: { order: { default: 1 } },
      parseDOM: [
        {
          tag: "ol",
          getAttrs: (dom: HTMLElement) => ({
            order: dom.hasAttribute("start") ? Number(dom.getAttribute("start")) : 1
          })
        }
      ],
      toDOM: (node) => (node.attrs.order === 1 ? olDOM : ["ol", { start: node.attrs.order }, 0])
    },

    bullet_list: {
      content: "list_item+",
      group: "block",
      parseDOM: [{ tag: "ul" }],
      toDOM: () => ulDOM
    },

    list_item: {
      automerge: {
        block: {
          within: { ordered_list: "ordered-list-item", bullet_list: "unordered-list-item" }
        }
      },
      content: "paragraph block*",
      defining: true,
      parseDOM: [{ tag: "li" }],
      toDOM: () => liDOM
    },

    // --- Checklist (task list) — the one node type this schema adds beyond a straight
    // paragraph/heading/list/quote/code/divider port. Generalizes `list_item`'s own `within`
    // block-mapping pattern to a second list container, exactly as `docs/rich-text-editor-
    // decisions.md` §1 anticipated ("the existing `automerge: {within: {bullet_list: 'list-
    // item'}}` conditional-mapping shape extends directly to a task-list parent"). `checked` is a
    // plain boolean node attr, round-tripped via `attrParsers` the same way `heading`'s `level` is.
    task_list: {
      content: "task_item+",
      group: "block",
      parseDOM: [{ tag: "ul", attrs: { "data-task-list": "true" } }],
      toDOM: () => ["ul", { "data-task-list": "true" }, 0]
    },

    task_item: {
      automerge: {
        block: { within: { task_list: "task-list-item" } },
        attrParsers: {
          fromAutomerge: (block: BlockMarker) => ({ checked: block.attrs.checked === true }),
          fromProsemirror: (node: PMNode) => ({ checked: !!node.attrs.checked })
        }
      },
      attrs: { checked: { default: false } },
      content: "paragraph block*",
      defining: true,
      parseDOM: [{ tag: "li", attrs: { "data-task-item": "true" } }],
      toDOM: (node) => ["li", { "data-task-item": "true", "data-checked": String(!!node.attrs.checked) }, 0]
    }
  },
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom: HTMLElement) => ({ href: dom.getAttribute("href"), title: dom.getAttribute("title") })
        }
      ],
      toDOM: (node) => ["a", { href: node.attrs.href, title: node.attrs.title }, 0],
      automerge: {
        markName: "link",
        parsers: {
          fromAutomerge: (mark: Automerge.MarkValue) => {
            if (typeof mark === "string") {
              try {
                const value = JSON.parse(mark) as { href?: string; title?: string }
                return { href: value.href ?? "", title: value.title ?? "" }
              } catch {
                // fall through to the empty-link default below
              }
            }
            return { href: "", title: "" }
          },
          fromProsemirror: (mark: Mark) => JSON.stringify({ href: mark.attrs.href, title: mark.attrs.title })
        }
      }
    },

    em: {
      parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
      toDOM: () => emDOM,
      automerge: { markName: "em" }
    },

    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b" }, { style: "font-weight=700" }],
      toDOM: () => strongDOM,
      automerge: { markName: "strong" }
    },

    // Upstream `basicSchema.ts`'s `code` mark carries no `automerge` mapping at all (so inline code
    // never round-trips through the stock package) — added here for real since inline code is
    // explicitly in this pass's required mark set.
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: () => codeDOM,
      automerge: { markName: "code" }
    },

    strike: {
      parseDOM: [{ tag: "s" }, { tag: "del" }, { style: "text-decoration=line-through" }],
      toDOM: () => strikeDOM,
      automerge: { markName: "strike" }
    },

    // The entity-reference mark (task item 1's "new entityRef mark carrying an immutable node id").
    // Mirrors `new-notes/docs/architecture.md`'s validated design verbatim: "An entity reference
    // displays as text while carrying an immutable entity ID in a non-expanding mark." `inclusive:
    // false` is the "non-expanding" half — typing immediately after a mention does not extend the
    // mark onto the new characters (matching `link`'s own `inclusive: false`, for the same reason:
    // a reference should not silently swallow unrelated adjacent typing). The mark payload is
    // JSON-serialized into the Automerge mark value exactly like `link` above, for the same
    // "`am.MarkValue` is a scalar" reason.
    entityRef: {
      attrs: { nodeId: {}, label: { default: "" } },
      inclusive: false,
      parseDOM: [
        {
          tag: "span[data-entity-ref]",
          getAttrs: (dom: HTMLElement) => ({
            nodeId: dom.getAttribute("data-entity-ref"),
            label: dom.textContent ?? ""
          })
        }
      ],
      // Retrieval pass (design-review 2026-08-22 finding #1): the `title` tooltip advertises the
      // Cmd/Ctrl+click affordance `RichNoteEditor`'s `handleClick` implements — a DOM-rendering
      // attribute only, NOT a doc-schema change (`parseDOM`, attrs, and the Automerge mark
      // payload/serialization are byte-identical; no native-safety review needed).
      toDOM: (node) => [
        "span",
        {
          "data-entity-ref": node.attrs.nodeId,
          class: "entity-ref",
          title: "⌘/Ctrl+click to open this node"
        },
        0
      ],
      automerge: {
        markName: "entity-ref",
        parsers: {
          fromAutomerge: (mark: Automerge.MarkValue) => {
            if (typeof mark === "string") {
              try {
                const value = JSON.parse(mark) as Partial<EntityRefPayload>
                return { nodeId: value.nodeId ?? "", label: value.label ?? "" }
              } catch {
                // fall through
              }
            }
            return { nodeId: "", label: "" }
          },
          fromProsemirror: (mark: Mark) =>
            JSON.stringify({ nodeId: mark.attrs.nodeId, label: mark.attrs.label } satisfies EntityRefPayload)
        }
      }
    },

    // The Supertag-reference mark (supertag-centering pass, docs/supertag-centering-decisions.md
    // §2's "New mark: `supertagRef`"). Mechanically identical to `entityRef` above (immutable id +
    // point-in-time label, `inclusive: false` so typing right after a `#tag` chip doesn't extend
    // it) but rendered under a distinct `supertag-chip` class/data attribute — a `#Person` mention
    // reads as a typed tag, not an entity link, even though the two marks share the same "JSON
    // payload in an Automerge mark" mechanics.
    supertagRef: {
      attrs: { tagId: {}, label: { default: "" } },
      inclusive: false,
      parseDOM: [
        {
          tag: "span[data-supertag-ref]",
          getAttrs: (dom: HTMLElement) => ({
            tagId: dom.getAttribute("data-supertag-ref"),
            label: dom.textContent ?? ""
          })
        }
      ],
      toDOM: (node) => ["span", { "data-supertag-ref": node.attrs.tagId, class: "supertag-chip" }, 0],
      automerge: {
        markName: "supertag-ref",
        parsers: {
          fromAutomerge: (mark: Automerge.MarkValue) => {
            if (typeof mark === "string") {
              try {
                const value = JSON.parse(mark) as Partial<SupertagRefPayload>
                return { tagId: value.tagId ?? "", label: value.label ?? "" }
              } catch {
                // fall through
              }
            }
            return { tagId: "", label: "" }
          },
          fromProsemirror: (mark: Mark) =>
            JSON.stringify({ tagId: mark.attrs.tagId, label: mark.attrs.label } satisfies SupertagRefPayload)
        }
      }
    }
  }
}

const clampHeadingLevel = (level: unknown): number => {
  const n = typeof level === "number" ? level : 1
  return n < 1 ? 1 : n > 3 ? 3 : n
}

/** One adapter instance for the whole app — `SchemaAdapter`'s constructor does real, non-trivial
 *  work (building the ProseMirror `Schema`, node/mark mapping tables), so this is built once at
 *  module load, exactly like the vendored `basicSchema.ts` does for its own `basicSchemaAdapter`. */
export const richTextSchemaAdapter = new SchemaAdapter(richTextSchemaSpec)

/** The path, within a page's Automerge document, that this schema's content lives at — unchanged
 *  from the flat-text era (`notes-service-live.ts`'s `PageDoc.text`, `automerge-page.ts`'s
 *  `PageDoc.text`): rich content is still stored under the single top-level `text` field, just with
 *  block markers and marks now present inline in that same Automerge Text sequence. This is what
 *  keeps the backend's "Page/Automerge doc bytes are opaque" property intact (task hard constraint)
 *  — nothing about the wire/storage field name changed, only what's inside it. */
export const RICH_TEXT_PATH: Automerge.Prop[] = ["text"]

/** Root-level scalar written into every Automerge doc this schema touches (migration and every
 *  local edit — see `migration.ts`'s `ensureRichTextSchema` and `LocalDocHandle.change`) — the
 *  documented **primary signal** native's read-only guard checks first
 *  (`native/AthenaeumCore/Sources/AthenaeumCore/PageDocumentStore.swift`'s `isRichTextNote`:
 *  "`schemaVersion >= 2` means written by the rich-text editor").
 *
 *  **Adversarial-review fix:** this constant/write path did not exist before — `schemaVersion` was
 *  documented as the primary signal but never actually written anywhere in `packages/web`,
 *  `packages/backend`, or `packages/domain` (confirmed by grep), so native's detection depended
 *  solely on its defense-in-depth block-marker structural scan. That scan has nothing to detect for
 *  the single most common real note shape: one plain paragraph (even with an inline mark, e.g.
 *  bold) produces zero block-type Automerge spans (proven empirically against the real
 *  `richTextSchemaAdapter`/`pmNodeToSpans` traversal during the adversarial review that found this
 *  gap) — so that note was completely undetectable as "rich" by native, and a native-originated
 *  `applyLocalSplice` against it would succeed instead of throwing
 *  `richTextNoteReadOnlyOnNative`, silently corrupting the doc's marks/block structure for every
 *  peer. Writing this scalar in the same Automerge commit as every rich-editor-originated content
 *  change closes that gap: the first character ever typed through `RichNoteEditor` — before any
 *  block marker could possibly exist — already carries the marker native checks first. */
export const RICH_TEXT_SCHEMA_VERSION = 2
