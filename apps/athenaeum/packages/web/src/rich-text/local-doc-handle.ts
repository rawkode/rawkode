import * as Automerge from "@automerge/automerge"
import type { PageDoc } from "../automerge-page.js"
import type { DocHandle, DocHandleChangePayload } from "../vendor/automerge-prosemirror/DocHandle.js"
import { RICH_TEXT_SCHEMA_VERSION } from "./schema.js"

// The adapter point `docs/rich-text-editor-decisions.md` §1 identified as the actual integration
// shape: `@automerge/prosemirror`'s `syncPlugin` needs a small, automerge-repo-independent 4-method
// `DocHandle<T>` (`doc()`/`change()`/`on()`/`off()`) — it never touches network transport itself.
// This class implements exactly that against the *same* closure-owned mutable `Automerge.Doc`
// reference pattern `automerge-page.ts` already uses, so the existing `startPageSync`/
// `pageSyncMessage`/`syncPageWithServer` protocol is reused completely unchanged: this class is
// fed the doc `syncPageWithServer` returns, and hands back the doc `syncPageWithServer`'s next call
// should send, but never calls `startPageSync`/`pageSyncMessage`/any RPC itself.

type ChangeListener = (payload: DocHandleChangePayload<PageDoc>) => void

export class LocalDocHandle implements DocHandle<PageDoc> {
  #doc: Automerge.Doc<PageDoc>
  readonly #listeners = new Set<ChangeListener>()

  constructor(initialDoc: Automerge.Doc<PageDoc>) {
    this.#doc = initialDoc
  }

  doc(): Automerge.Doc<PageDoc> {
    return this.#doc
  }

  /** Called by `syncPlugin`'s `appendTransaction` for every local ProseMirror edit (`pmToAm`
   *  applies the transaction's steps inside this callback). Emits the same "change" event a remote
   *  update would (see `setRemoteDoc` below) — safe to do unconditionally because `syncPlugin`
   *  guards its own remote-patch listener with an `ignoreTr` flag that is `true` for the entire
   *  duration of the `handle.change(...)` call this method backs, so the plugin never re-applies a
   *  transaction it just produced. This mirrors real `automerge-repo`'s own `DocHandle.change()`
   *  semantics (which likewise fires "change" for every mutation, local or remote) rather than
   *  inventing a local-only code path.
   *
   *  **Adversarial-review fix (native read-only-detection gap):** every commit this method produces
   *  also stamps `schemaVersion = RICH_TEXT_SCHEMA_VERSION` at the document root, in the *same*
   *  `Automerge.change` call as `fn`'s own content mutation — this is the one and only place a
   *  local rich-editor edit is ever committed (`LocalDocHandle` is instantiated exclusively by
   *  `RichNoteEditor.tsx`; the earlier plain-textarea editing path is gone), so this is the correct
   *  choke point to guarantee the marker native's `PageDocumentStore.isRichTextNote` checks first is
   *  always present by the time any rich content exists — including the very first keystroke typed
   *  into a brand-new note, before that edit could possibly have produced a block marker for the
   *  structural-scan fallback to catch instead. See `rich-text/schema.ts`'s doc comment on
   *  `RICH_TEXT_SCHEMA_VERSION` for the full gap this closes. Stamped unconditionally (not only when
   *  absent/stale) — an Automerge scalar register write is idempotent and cheap, and unconditional
   *  is simpler to reason about than adding a read-before-write branch here. */
  change(fn: (doc: PageDoc) => void): void {
    const before = this.#doc
    const headsBefore = Automerge.getHeads(before)
    const after = Automerge.change(before, (draft) => {
      fn(draft)
      draft.schemaVersion = RICH_TEXT_SCHEMA_VERSION
    })
    this.#doc = after
    this.#emitDiff(before, after, headsBefore, "change")
  }

  /**
   * Not part of the `DocHandle<T>` contract — the other half of the bridge, called by
   * `RichNoteEditor` after a real `syncPageWithServer` round trip returns a doc that may contain
   * content this handle didn't already have (content from another replica, or the migration
   * change applied before the first sync). Computes the diff the same way `syncPlugin`'s own
   * `appendTransaction` does (`Automerge.diff(next, headsBefore, headsAfter)`) and fires "change"
   * listeners with `source: "receiveSyncMessage"` — this is what actually drives `syncPlugin`'s
   * `view: view => { handle.on("change", onPatch) }` path, turning remote Automerge patches into a
   * ProseMirror transaction dispatched against the live `EditorView`.
   */
  setRemoteDoc(next: Automerge.Doc<PageDoc>): void {
    const before = this.#doc
    const headsBefore = Automerge.getHeads(before)
    this.#doc = next
    this.#emitDiff(before, next, headsBefore, "receiveSyncMessage")
  }

  on(_event: "change", callback: ChangeListener): void {
    this.#listeners.add(callback)
  }

  off(_event: "change", callback: ChangeListener): void {
    this.#listeners.delete(callback)
  }

  #emitDiff(
    before: Automerge.Doc<PageDoc>,
    after: Automerge.Doc<PageDoc>,
    headsBefore: Automerge.Heads,
    source: Automerge.PatchSource
  ): void {
    const headsAfter = Automerge.getHeads(after)
    if (headsBefore.length === headsAfter.length && headsBefore.every((h, i) => h === headsAfter[i])) {
      // No real change (e.g. a sync round trip that only confirmed we're already caught up) —
      // nothing for `syncPlugin` to reconcile into the ProseMirror view.
      return
    }
    const patches = Automerge.diff(after as Automerge.Doc<unknown>, headsBefore, headsAfter)
    if (patches.length === 0) return
    const payload: DocHandleChangePayload<PageDoc> = {
      handle: this,
      doc: after,
      patches,
      patchInfo: { before, after, source }
    }
    for (const listener of this.#listeners) listener(payload)
  }
}
