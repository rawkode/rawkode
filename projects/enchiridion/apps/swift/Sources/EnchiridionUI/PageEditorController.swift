// PageEditorController.swift
// EnchiridionUI
//
// The commit-boundary controller (task point 1) — adapted from the old
// app's `EditorPersistenceSession`/`EditorFlushController`
// (apps/enchiridion/Sources/{EnchiridionCore/EditorPersistenceSession,
// SharedUI/EditorFlushController}.swift) to `PageDocument`'s
// snapshot-in/snapshot-out shape (EnchiridionSync/PageDocument.swift).
//
// THE DESIGN PROBLEM: `PageDocument` has no live, mutable, held-open
// document — every call (`insertText`, `mark`, ...) takes a full `Data`
// snapshot and returns a new one. Calling it once per keystroke would put a
// full Loro decode/apply/encode round trip on the input path, which
// PRODUCT.md's "capture must always work with zero friction" rules out as
// the steady-state design (occasional latency is one thing; a decode/encode
// on every character is another). This controller's answer: typing only
// ever touches cheap, synchronous, in-memory state (`body: PageEditorBody`
// and a queue of `PendingBodyOp`s already expressed as exact `PageDocument`
// call parameters); a `PageDocument` call only happens inside `flush()`,
// which runs off the keystroke path (debounced, or invoked explicitly at a
// natural boundary — navigation, backgrounding, an explicit save).
//
// WHAT "BATCHING" ACTUALLY BUYS HERE — worth stating plainly because it's
// easy to overclaim: `PageDocument`'s public API is one call per operation
// (`insertText`, `mark`, ...), each already a full mutate-and-commit; there
// is no multi-op-single-commit entry point to batch *into*. `flush()` still
// makes one `PageDocument` call per queued op, replayed in order against the
// evolving snapshot. The win is real but narrower than "fewer CRDT calls":
// (1) none of that work happens synchronously while the user is typing —
// it's entirely off the interaction path; (2) this controller's
// `@Observable` state (`durableDocument`/`durableVersion`/`projection`)
// updates exactly once per flush instead of once per keystroke, so anything
// observing this controller (a page list showing live word counts, etc.)
// re-renders once per flush window, not once per character.
//
// FLUSH IS APPEND-ONLY REPLAY, NOT A SINGLE DIFF: unlike the old
// Automerge-backed session (which computed one `encodedChanges` delta from
// current heads), each pending op here is already a `PageDocument` call
// with its own position, expressed in the coordinate space that call will
// see once every *earlier* queued op has been replayed ahead of it — the
// same coordinate space `body: PageEditorBody` is kept in sync with as each
// op is queued (see `insertText`/`deleteText`/`toggleMark` below). That's
// what makes replaying the queue in order against `durableDocument`
// reproduce exactly what typing looked like locally.
//
// REMOTE UPDATES DURING AN ACTIVE (DIRTY) EDIT: `applyRemoteUpdate(_:)`
// mirrors the old session's clean-adopts/dirty-defers split (see
// `EditorPersistenceSession.receive(_:)`), but with a known, documented gap
// — see that method's doc comment below. No `VaultSyncClient` is wired to
// this controller in this task (no running sync transport exists yet); the
// method exists as a tested, ready extension point for whichever P1+ task
// does that wiring.
//
// TASK #78 ADDITION — DURABLE LOCAL PERSISTENCE: before this task,
// `durableDocument` above was exactly what its doc comment still says and
// nothing more — an in-memory `Data` property, never written anywhere
// durable. Every relaunch of the app silently started every page from
// scratch (or, worse, from `PageDocument.create`, discarding any prior
// session's real edit history). This controller now has an optional
// `store: LocalGraphStore?` (nil by default, preserving `create(...)`'s
// existing pure-in-memory behavior for tests and the odd caller that
// genuinely wants a throwaway session): when a `store` is present,
// `open(pageID:kind:title:createdAt:store:)` loads a persisted CRDT
// snapshot if one exists (falling back to `PageDocument.create` only for a
// genuinely new page — never the reverse), and every successful `flush()`
// persists the new `durableDocument`/`durableVersion` into that same store
// before publishing them, so a crash or relaunch immediately after a flush
// can never observe in-memory state that's ahead of disk. `applyRemoteUpdate`'s
// `adopt(_:)` path is deliberately NOT wired to persist here — it has no
// production caller yet (see that method's own doc comment: it's a tested,
// ready extension point for the still-unbuilt `VaultSyncClient` consumer
// loop), and wiring it is exactly the "sync reprojection" work this task's
// brief keeps out of scope.

import EnchiridionCore
import EnchiridionStore
import EnchiridionSync
import Foundation
import Observation

/// One queued local edit, already expressed as the exact `PageDocument`
/// call it will become at flush time — see this file's header.
enum PendingBodyOp: Equatable {
  case insertText(container: PageTextContainer, position: UInt32, text: String)
  case deleteText(container: PageTextContainer, position: UInt32, length: UInt32)
  case mark(container: PageTextContainer, range: Range<UInt32>, style: LoroEngine.MarkStyle, value: CRDTValue?)
  case addPageReference(pageID: PageID, label: String, range: Range<UInt32>)
  /// Task #85 (P7 integration wave) addition — the "insert canvas"/
  /// "insert attachment" op, mirroring `PageDocument.addAttachmentMark`'s
  /// parameters exactly. Reused for BOTH first-time insertion (queued
  /// right after an `.insertText` op that placed the placeholder
  /// character — see `insertAttachment(...)` below) and re-marking an
  /// EXISTING attachment's range with new content after an edit (see
  /// `updateAttachment(...)`) — `PageDocument.addAttachmentMark`'s own doc
  /// comment notes a mark call is just as valid re-applied over an
  /// already-marked range as it is over a freshly inserted one, so this
  /// needs no separate "update" op variant.
  case attachment(
    container: PageTextContainer, range: Range<UInt32>, kind: String, blobID: String, width: Double?,
    height: Double?, mimeType: String?)

  func apply(to snapshot: Data) throws -> PageDocument.MutationResult {
    switch self {
    case .insertText(let container, let position, let text):
      try PageDocument.insertText(container, at: position, text: text, in: snapshot)
    case .deleteText(let container, let position, let length):
      try PageDocument.deleteText(container, at: position, length: length, in: snapshot)
    case .mark(let container, let range, let style, let value):
      try PageDocument.mark(container, range: range, style: style, value: value, in: snapshot)
    case .addPageReference(let pageID, let label, let range):
      try PageDocument.addPageReferenceMark(to: pageID, label: label, range: range, in: snapshot)
    case .attachment(let container, let range, let kind, let blobID, let width, let height, let mimeType):
      try PageDocument.addAttachmentMark(
        kind: kind, blobID: blobID, width: width, height: height, mimeType: mimeType, range: range,
        in: container, snapshot: snapshot)
    }
  }
}

@MainActor
@Observable
public final class PageEditorController {
  public enum Failure: LocalizedError, Equatable {
    case flushFailed(String)

    public var errorDescription: String? {
      switch self {
      case .flushFailed(let message): "Couldn't save your edit: \(message)"
      }
    }
  }

  public private(set) var pageID: PageID
  public private(set) var durableDocument: Data
  public private(set) var durableVersion: PageDocumentVersion
  public private(set) var projection: PageDocumentProjection

  /// The title field's live value. Bind a `TextField` directly to this via
  /// `setTitle(_:)` (not a raw `Binding` to the stored property) so every
  /// change is tracked for the next flush.
  public private(set) var title: String
  /// The body's live value. Mutated only through this controller's methods
  /// (`insertText`, `deleteText`, `toggleMark`, `insertPageReference`) so
  /// `body` and the pending-op queue never drift apart.
  public private(set) var body: PageEditorBody

  public private(set) var isFlushing = false
  public private(set) var lastFlushError: String?

  /// `true` when there is local state not yet reflected in
  /// `durableDocument` — i.e. a `flush()` would do real work.
  public var isDirty: Bool {
    !pendingBodyOps.isEmpty || titleAtLastFlush != title || pendingRemoteUpdate != nil
  }

  /// How long `scheduleFlush()` waits for typing to pause before flushing.
  /// Exposed (not a private constant) so a host view/test can shrink it.
  public var flushDebounceInterval: Duration = .milliseconds(600)

  private var pendingBodyOps: [PendingBodyOp] = []
  private var titleAtLastFlush: String
  private var pendingRemoteUpdate: Data?
  private var flushTask: Task<Void, Never>?
  @ObservationIgnored private var remoteChangeTask: Task<Void, Never>?

  /// Task #78: when non-nil, every successful `flush()` persists the new
  /// `durableDocument` here (see this file's header). `nil` for sessions
  /// constructed via `create(...)`/the plain `init`s below — those stay
  /// exactly as pure-in-memory as they always were, which existing tests
  /// (`PageEditorControllerTests.swift`) and any other caller not yet
  /// wired to a `LocalGraphStore` depend on unchanged.
  private let store: LocalGraphStore?

  public init(
    pageID: PageID, document: Data, projection: PageDocumentProjection, store: LocalGraphStore? = nil
  ) {
    self.pageID = pageID
    self.durableDocument = document
    self.durableVersion = (try? PageDocument.currentVersion(of: document)) ?? .empty
    self.projection = projection
    self.title = projection.title
    self.titleAtLastFlush = projection.title
    self.body = PageEditorBody.from(projection: projection)
    self.store = store
    self.remoteChangeTask = nil
    if let store {
      beginObservingRemoteChanges(from: store)
    }
  }

  public convenience init(pageID: PageID, document: Data, store: LocalGraphStore? = nil) throws {
    self.init(
      pageID: pageID, document: document, projection: try PageDocument.projection(of: document), store: store)
  }

  /// Convenience matching `PageDocument.create`'s shape, for opening a
  /// brand-new page directly into an editor session. Purely in-memory — no
  /// `store`, so nothing is persisted until/unless a caller does so itself.
  /// Production callers that want durable persistence (the normal case)
  /// should use `open(pageID:kind:title:createdAt:store:)` instead; this
  /// convenience stays for tests and any genuinely throwaway session.
  public static func create(id: PageID, kind: PageKind, title: String, createdAt: Date = Date()) throws
    -> PageEditorController
  {
    let created = try PageDocument.create(id: id, kind: kind, title: title, createdAt: createdAt)
    return try PageEditorController(pageID: id, document: created.document)
  }

  /// The durable, store-backed entry point for opening a page (task #78):
  /// loads `pageID`'s persisted CRDT snapshot from `store` if one exists —
  /// a page that was edited in a prior session/before a relaunch — and
  /// only falls back to `PageDocument.create` when `store` genuinely has
  /// none yet, i.e. this is a brand-new page. This is the load-on-open half
  /// of task #78's fix; the save-on-write half is `flush()` persisting into
  /// the same `store` this controller is opened with. `kind`/`title`/
  /// `createdAt` are used only in the new-page fallback branch — an
  /// existing page's real `kind`/`title`/`createdAt` live in its persisted
  /// document, not in these parameters.
  public static func open(
    pageID: PageID,
    kind: PageKind,
    title: String,
    createdAt: Date = Date(),
    store: LocalGraphStore
  ) async throws -> PageEditorController {
    if let record = try await store.documentSnapshot(for: pageID) {
      return try PageEditorController(pageID: pageID, document: record.snapshot, store: store)
    }
    let created = try PageDocument.create(id: pageID, kind: kind, title: title, createdAt: createdAt)
    let controller = try PageEditorController(pageID: pageID, document: created.document, store: store)
    // Persist immediately, not only on the first flush — a brand-new page
    // that's opened and then immediately backgrounded/killed before any
    // edit (and therefore before any `flush()`) must still exist on disk
    // the next time `open` is called for the same `pageID`; otherwise this
    // branch would run again and silently fork a second "first" snapshot.
    try await store.saveDocumentSnapshot(
      pageID: pageID, snapshot: created.document, version: try PageDocument.currentVersion(of: created.document))
    return controller
  }

  // MARK: - Local edits (cheap, synchronous, off any CRDT path)

  public func setTitle(_ newTitle: String) {
    guard newTitle != title else { return }
    title = newTitle
    scheduleFlush()
  }

  public func insertText(_ text: String, at position: Int) {
    guard !text.isEmpty else { return }
    breakReferencesTouchingInsertPoint(at: position)
    let outcome = body.applyingInsert(text: text, at: position)
    body = outcome.body
    pendingBodyOps.append(.insertText(container: .body, position: UInt32(position), text: text))
    scheduleFlush()
  }

  public func deleteText(range: Range<Int>) {
    guard !range.isEmpty else { return }
    let outcome = body.applyingDelete(range: range)
    body = outcome.body
    pendingBodyOps.append(
      .deleteText(container: .body, position: UInt32(range.lowerBound), length: UInt32(range.count)))
    scheduleFlush()
  }

  /// Applies a `TextDiff.replacement(from:to:)` result in one step — the
  /// entry point a `TextEditor` change handler should call.
  public func applyBodyReplacement(_ replacement: TextReplacement) {
    if !replacement.range.isEmpty {
      deleteText(range: replacement.range)
    }
    if !replacement.replacement.isEmpty {
      insertText(replacement.replacement, at: replacement.range.lowerBound)
    }
  }

  public func toggleMark(_ style: LoroEngine.MarkStyle, over range: Range<Int>) {
    guard !range.isEmpty else { return }
    let enable = MarkToggleEngine.shouldEnable(style, in: range, runs: body.markRuns)
    body.markRuns = MarkToggleEngine.applying(style, enable: enable, over: range, to: body.markRuns)
    pendingBodyOps.append(
      .mark(
        container: .body, range: UInt32(range.lowerBound)..<UInt32(range.upperBound), style: style,
        value: enable ? .bool(true) : nil))
    scheduleFlush()
  }

  /// Executes a `PageReferenceInsertionPlan` (PageReferenceInsertion.swift):
  /// removes `plan.replacedRange`, inserts `plan.label`, marks the inserted
  /// span as a reference to `plan.pageID`.
  public func insertPageReference(_ plan: PageReferenceInsertionPlan) {
    if !plan.replacedRange.isEmpty {
      deleteText(range: plan.replacedRange)
    }
    let insertPosition = plan.replacedRange.lowerBound
    if !plan.label.isEmpty {
      insertText(plan.label, at: insertPosition)
    }
    let labelRange = insertPosition..<(insertPosition + plan.label.scalarCount)
    pendingBodyOps.append(
      .addPageReference(
        pageID: plan.pageID, label: plan.label,
        range: UInt32(labelRange.lowerBound)..<UInt32(labelRange.upperBound)))
    body.referenceRuns.append(ReferenceRun(range: labelRange, destination: .init(pageID: plan.pageID, label: plan.label)))
    body.referenceRuns.sort { $0.range.lowerBound < $1.range.lowerBound }
    scheduleFlush()
  }

  /// Task #85 (P7 integration wave) addition — embeds a NEW attachment
  /// (a canvas today; `kind` stays free-form per `PageAttachment`'s doc
  /// comment) at `position`: inserts `CanvasEmbed.placeholder`'s ONE
  /// OBJECT REPLACEMENT CHARACTER (the caller — `PageEditorView`'s canvas
  /// insertion sheet — passes that exact string; this method doesn't
  /// import `EnchiridionCanvas` itself, keeping this file's dependency
  /// graph exactly as narrow as before), then marks that inserted
  /// character as an attachment. Two `PageDocument` calls under the hood
  /// (mirrors `CanvasEmbed.embed`'s own "two calls, one for the caller"
  /// shape — see that method's doc comment), queued as this controller's
  /// own ops so they replay through the SAME coordinate-space-consistent
  /// `flush()` machinery every other local edit does, rather than calling
  /// `PageDocument`/`CanvasEmbed` directly and bypassing the pending-op
  /// queue (which would desync `body` from what actually gets persisted —
  /// exactly the bug class this controller's header explains the queue
  /// exists to prevent).
  public func insertAttachment(
    placeholder: String, kind: String, blobID: String, width: Double?, height: Double?, mimeType: String?,
    at position: Int
  ) {
    guard !placeholder.isEmpty else { return }
    breakReferencesTouchingInsertPoint(at: position)
    let outcome = body.applyingInsert(text: placeholder, at: position)
    body = outcome.body
    pendingBodyOps.append(.insertText(container: .body, position: UInt32(position), text: placeholder))

    let range = UInt32(position)..<UInt32(position + placeholder.scalarCount)
    body.attachmentRuns.append(
      AttachmentRun(range: Int(range.lowerBound)..<Int(range.upperBound), kind: kind, blobID: blobID, width: width, height: height, mimeType: mimeType))
    body.attachmentRuns.sort { $0.range.lowerBound < $1.range.lowerBound }
    pendingBodyOps.append(
      .attachment(
        container: .body, range: range, kind: kind, blobID: blobID, width: width, height: height,
        mimeType: mimeType))
    scheduleFlush()
  }

  /// Task #85 addition — re-marks an EXISTING attachment's range (found by
  /// its current `range`/`blobID` — both must match exactly, so a stale
  /// caller holding an out-of-date `AttachmentRun` can't accidentally
  /// clobber a different attachment that has since shifted into that same
  /// range) with new content — the "save my edits back to this embedded
  /// canvas" path. No text insertion needed (the placeholder character is
  /// already there from the original `insertAttachment` call); only the
  /// mark itself changes.
  ///
  /// Task #92 (adversarial-review finding, HIGH) addition — returns
  /// `Bool` (`true` on a real re-mark, `false` for the deliberate no-op
  /// below) instead of `Void`. The no-op itself is intentional and stays
  /// exactly as it was (see `PageEditorAttachmentTests
  /// .testUpdateAttachmentIsANoOpWhenTheSuppliedRunNoLongerMatches`) — what
  /// changed is that this method's ONE caller,
  /// `PageEditorView.handleCanvasSaved`, previously had no way to tell the
  /// no-op happened at all and unconditionally dismissed the canvas sheet
  /// as if the save had succeeded, even though `CanvasBlobStore.upload`
  /// had already put new bytes on the server that nothing would ever
  /// reference again. Returning `Bool` lets that call site actually react.
  @discardableResult
  public func updateAttachment(
    _ existing: AttachmentRun, blobID: String, width: Double?, height: Double?, mimeType: String?
  ) -> Bool {
    guard let index = body.attachmentRuns.firstIndex(where: { $0.range == existing.range && $0.blobID == existing.blobID })
    else { return false }
    body.attachmentRuns[index].blobID = blobID
    body.attachmentRuns[index].width = width
    body.attachmentRuns[index].height = height
    body.attachmentRuns[index].mimeType = mimeType
    let range = UInt32(existing.range.lowerBound)..<UInt32(existing.range.upperBound)
    pendingBodyOps.append(
      .attachment(
        container: .body, range: range, kind: existing.kind, blobID: blobID, width: width, height: height,
        mimeType: mimeType))
    scheduleFlush()
    return true
  }

  /// Typing strictly inside an existing reference's text breaks it back to
  /// literal, editable text — see PageEditorBody.swift's header and
  /// `applyingInsert`'s doc comment. Unlike a delete (where the marked
  /// characters are simply gone), the reference's characters here are
  /// untouched, so an explicit unmark op is queued *before* the insert op
  /// so the flushed document matches this session's local preview instead
  /// of silently keeping the old document's mark alive underneath a
  /// visually-unmarked run.
  private func breakReferencesTouchingInsertPoint(at position: Int) {
    for run in body.referenceRuns where run.range.lowerBound < position && position < run.range.upperBound {
      pendingBodyOps.append(
        .mark(
          container: .body, range: UInt32(run.range.lowerBound)..<UInt32(run.range.upperBound),
          style: PageDocument.pageReferenceMark, value: nil))
    }
  }

  // MARK: - Flush (the commit boundary)

  private func scheduleFlush() {
    flushTask?.cancel()
    flushTask = Task { [weak self, flushDebounceInterval] in
      try? await Task.sleep(for: flushDebounceInterval)
      guard !Task.isCancelled else { return }
      await self?.flush()
    }
  }

  /// Adopts a remotely committed snapshot from the same durable store. The
  /// store labels inbound Vault writes `.remote`, so this never reacts to the
  /// editor's own flushes or turns a local write into a feedback loop.
  private func beginObservingRemoteChanges(from store: LocalGraphStore) {
    let pageID = pageID
    remoteChangeTask = Task { [weak self, store, pageID] in
      let changes = await store.documentSnapshotChanges()
      for await change in changes where change.pageID == pageID && change.origin == .remote {
        guard let self else { return }
        guard change.version != self.durableVersion else { continue }
        do {
          try self.applyRemoteUpdate(change.snapshot)
        } catch {
          self.lastFlushError = error.localizedDescription
        }
      }
    }
  }

  /// Replays every queued title/body op against `durableDocument`, in
  /// order, then updates all published state exactly once. Safe to call
  /// re-entrantly (e.g. a debounced call landing while an explicit
  /// navigation-boundary call is already running) — a second call while one
  /// is in flight is a no-op that returns once the first completes' result
  /// is visible, since both observe `isDirty` before doing any work.
  @discardableResult
  public func flush() async -> Bool {
    guard isDirty else { return true }
    isFlushing = true
    defer { isFlushing = false }

    var snapshot = durableDocument
    do {
      if let remote = pendingRemoteUpdate {
        let merged = try PageDocument.merge(local: snapshot, remote: remote)
        snapshot = merged.document
        pendingRemoteUpdate = nil
      }

      if titleAtLastFlush != title, let replacement = TextDiff.replacement(from: titleAtLastFlush, to: title) {
        if !replacement.range.isEmpty {
          snapshot = try PageDocument.deleteText(
            .title, at: UInt32(replacement.range.lowerBound), length: UInt32(replacement.range.count),
            in: snapshot
          ).document
        }
        if !replacement.replacement.isEmpty {
          snapshot = try PageDocument.insertText(
            .title, at: UInt32(replacement.range.lowerBound), text: replacement.replacement, in: snapshot
          ).document
        }
      }

      var latestProjection: PageDocumentProjection?
      for op in pendingBodyOps {
        let result = try op.apply(to: snapshot)
        snapshot = result.document
        latestProjection = result.projection
      }

      let newVersion = try PageDocument.currentVersion(of: snapshot)
      let newProjection = try latestProjection ?? PageDocument.projection(of: snapshot)

      // Persist BEFORE publishing any new in-memory state (task #78) — if
      // this throws, the catch below leaves `durableDocument`/`durableVersion`/
      // `projection`/`pendingBodyOps` exactly as they were, matching this
      // method's existing "a failed flush must not partially update durable
      // state" contract (`PageEditorControllerTests.testFlushReportsFailureWithoutCorruptingDurableState`)
      // instead of leaving in-memory state ahead of what's actually on disk.
      if let store {
        try await store.saveDocumentSnapshot(pageID: pageID, snapshot: snapshot, version: newVersion)
      }

      durableDocument = snapshot
      durableVersion = newVersion
      projection = newProjection
      titleAtLastFlush = title
      pendingBodyOps.removeAll()
      lastFlushError = nil
      return true
    } catch {
      lastFlushError = error.localizedDescription
      return false
    }
  }

  // MARK: - Remote updates

  /// Merges an externally-produced snapshot/update (`remoteBytes`, from a
  /// future sync client) into this session.
  ///
  /// A clean session (nothing queued) adopts the merge immediately and
  /// re-derives `body`/`title` from the merged projection. A dirty session
  /// (local edits queued but not yet flushed) defers the merge: it's folded
  /// into `snapshot` at the *start* of the next `flush()`, before local
  /// pending ops replay on top of it.
  ///
  /// KNOWN LIMITATION (documented, not silently accepted): the local
  /// `body`/pending-op positions were computed against the pre-merge
  /// `durableDocument`. If the remote update changed body text length or
  /// content in a region a still-pending local op also targets, that op's
  /// position can end up describing a different span than intended once
  /// replayed against the post-merge snapshot — the same class of problem
  /// any offset-based (non-operational-transform) text merge has. This does
  /// NOT corrupt the CRDT document (Loro's merge stays commutative and
  /// convergent regardless of where an op's position lands) and does NOT
  /// lose data — the worst case is a misplaced insert/mark, not a dropped
  /// one. A full fix (rebasing pending ops against the merge, or true OT)
  /// is real, separate engineering, out of this task's scope; flagged here
  /// and in the P1 report rather than left implicit.
  public func applyRemoteUpdate(_ remoteBytes: Data) throws {
    guard isDirty else {
      let merged = try PageDocument.merge(local: durableDocument, remote: remoteBytes)
      adopt(merged)
      return
    }
    if let existing = pendingRemoteUpdate {
      pendingRemoteUpdate = try PageDocument.merge(local: existing, remote: remoteBytes).document
    } else {
      pendingRemoteUpdate = remoteBytes
    }
  }

  private func adopt(_ result: PageDocument.MutationResult) {
    durableDocument = result.document
    durableVersion = result.version
    projection = result.projection
    body = PageEditorBody.from(projection: result.projection)
    title = result.projection.title
    titleAtLastFlush = result.projection.title
  }

  /// Cancels a debounced flush that hasn't started yet. Does NOT interrupt
  /// a `flush()` already in flight (`isFlushing == true`) — that one still
  /// runs to completion, which is intentional: an in-flight flush is
  /// already past the point where cancelling it would leave local edits
  /// silently unsaved. Callers navigating away from this controller's page
  /// should `await flush()` explicitly first (see `PageEditorView`'s
  /// `onDisappear`), then call this to stop any further debounce from
  /// firing against a controller nobody is observing anymore.
  public func invalidate() {
    flushTask?.cancel()
    flushTask = nil
    remoteChangeTask?.cancel()
    remoteChangeTask = nil
  }
}
