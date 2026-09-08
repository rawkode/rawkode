import * as Automerge from "@automerge/automerge"
import type { PageDoc } from "../automerge-page.js"
import { RICH_TEXT_PATH, RICH_TEXT_SCHEMA_VERSION } from "./schema.js"

// Migration path (task item 3 / `docs/rich-text-editor-decisions.md` §4): opening an existing
// flat-Text note in the rich editor must convert it into the new schema's single-paragraph form
// without data loss, as one real tracked Automerge change on the *same*, already-synced document —
// never a fresh `Automerge.from`/`Automerge.init` genesis. That exact failure mode is documented
// (and was a real, found-and-fixed bug) in `automerge-page.ts`'s `emptyPageDoc` doc comment: an
// independently-created `text` object has no causal link to the server's real lineage, and merges
// via last-writer-wins on the map key rather than character-by-character, so it can silently
// discard the server's real content. `ensureRichTextSchema` below only ever calls `Automerge.change`
// on the exact `doc` value it was handed (itself the result of a real `syncPageWithServer` round
// trip), so the migration commit's causal parent is always the note's real prior history.

const hasBlockMarkers = (doc: Automerge.Doc<PageDoc>): boolean =>
  Automerge.spans(doc, RICH_TEXT_PATH).some((span) => span.type === "block")

/**
 * Returns `doc` unchanged (same reference — callers can rely on `===` to detect "no migration was
 * needed") if the note's `text` field already has block structure, which covers two cases:
 *
 * 1. A note already written by this editor (or any Automerge-block-aware writer) — nothing to do.
 * 2. A brand-new page (`createPage`'s server-side `Automerge.from<PageDoc>({text: ""})`, an empty,
 *    zero-span text field) — deliberately left as-is rather than eagerly inserting an empty
 *    paragraph block marker, since the first real edit made through this editor creates that block
 *    naturally via ordinary ProseMirror -> Automerge sync (`syncPlugin`'s `appendTransaction`), and
 *    an empty note has no content whose loss migration needs to guard against in the first place.
 *
 * Otherwise (non-empty flat text, no block markers — a genuine pre-rich-text note), wraps the
 * existing text in one paragraph block via `Automerge.splitBlock` at index 0 — proven end-to-end
 * against the real backend (`packages/backend/test/rich-text-migration-spike.test.ts`, per the
 * decisions doc): content is preserved exactly, real block structure is now present, and every
 * pre-migration change hash survives in `Automerge.getAllChanges()` — a genuine in-place extension
 * of the same document lineage, not a replacement.
 *
 * The caller is responsible for pushing the resulting doc through the existing sync protocol
 * (`syncPageWithServer`) exactly like any other local edit — this function only produces the local
 * Automerge change, it never talks to the network itself.
 *
 * **Adversarial-review fix:** this migration commit now also stamps `schemaVersion =
 * RICH_TEXT_SCHEMA_VERSION` at the document root, in the same `Automerge.change` call as the
 * `splitBlock` — see `schema.ts`'s doc comment on that constant for the gap this closes. This
 * covers the case a bare `LocalDocHandle.change` stamp alone would miss: a genuinely pre-rich-text
 * note that gets migrated but never subsequently edited through `RichNoteEditor` in this session
 * (e.g. opened, migrated, immediately navigated away from) would otherwise sync back to the server
 * carrying real block structure but no primary signal, relying solely on native's block-marker
 * structural-scan fallback.
 */
export const ensureRichTextSchema = (doc: Automerge.Doc<PageDoc>): Automerge.Doc<PageDoc> => {
  if (hasBlockMarkers(doc)) return doc
  if (doc.text.length === 0) return doc

  return Automerge.change(doc, (draft) => {
    Automerge.splitBlock(draft, RICH_TEXT_PATH, 0, {
      type: new Automerge.ImmutableString("paragraph"),
      parents: [],
      attrs: {},
      isEmbed: false
    })
    draft.schemaVersion = RICH_TEXT_SCHEMA_VERSION
  })
}
