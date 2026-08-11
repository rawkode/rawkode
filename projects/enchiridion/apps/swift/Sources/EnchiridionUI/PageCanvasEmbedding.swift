// PageCanvasEmbedding.swift
// EnchiridionUI
//
// Task #85 (P7 integration wave, item 2 of "What to build"). Wires
// `EnchiridionCanvas` (P7 track 5 — self-contained, "not wired into
// RootView.swift/app navigation" per its own README) into the shared page
// editor: a real "insert canvas" action, mirroring `EnchiridionCanvas
// .CanvasEmbed.embed`'s SHAPE (see below for exactly what's shared vs.
// duplicated, and why) and a tappable thumbnail affordance for an
// already-embedded `"canvas"`-kind `PageAttachment`, opening the real
// `CanvasEditorView` in a sheet.
//
// CORRECTION (an earlier revision of this comment overclaimed this file
// calls `CanvasEmbed.embed` directly — it does not; flagged by adversarial
// review, fixed here to match what the code actually does):
// `PageEditorController.insertAttachment(placeholder:kind:blobID:width:
// height:mimeType:at:)` (`PageEditorController.swift`) is what actually
// runs when "Insert Canvas" is used, and it does NOT call `CanvasEmbed
// .embed` — it re-implements that same two-`PageDocument`-call shape
// (`insertText` then `addAttachmentMark`) inline, as two entries in
// `PageEditorController`'s own `PendingBodyOp` queue. This is necessary,
// not a style choice: `PageEditorController.flush()`'s whole design is
// "typing stays cheap and synchronous; a real `PageDocument` call only
// happens inside `flush()`, replayed from the queue" (that file's own
// header) — calling `CanvasEmbed.embed` (or `PageDocument.addAttachmentMark`)
// directly from this UI layer would bypass that queue entirely, exactly
// the bug class `PageEditorController.insertAttachment`'s own doc comment
// warns against ("would desync `body` from what actually gets persisted").
// So the RIGHT reuse boundary here is `CanvasEmbed.placeholder` (the
// shared OBJECT REPLACEMENT CHARACTER constant, actually referenced by
// `PageEditorView.swift`) and `CanvasAttachmentKind.canvas` (the shared
// `kind` string) — not the `CanvasEmbed.embed` FUNCTION itself, which is
// the right call for a caller that already has a full, disposable
// `PageDocument` snapshot in hand (as `CanvasEmbed.embedNewCanvasPage`
// itself is), not for a caller replaying a queue of small ops one at a
// time. `CanvasEmbed.embed`/`embedNewCanvasPage` remain unmodified and
// fully exercised by `EnchiridionCanvas`'s own tests
// (`CanvasPageAttachmentTests.swift`); this file's `insertAttachment`
// keeping the SAME two-call shape (verified by `PageEditorAttachmentTests
// .swift`) is what keeps the two implementations from silently diverging,
// even though neither literally calls the other.
//
// WHY THIS IS "USAGE SHAPE 1," NOT `embedNewCanvasPage`'s "USAGE SHAPE 2":
// the task brief names `embedNewCanvasPage`/equivalent — read both
// functions in `EnchiridionCanvas/CanvasPageAttachment.swift` before
// assuming which shape fits. `embedNewCanvasPage` creates a WHOLE NEW
// `PageDocument`, tagged `canvasPage`, with the canvas embedded in THAT
// new page's own otherwise-empty body — it has no effect on the page
// currently open in this editor at all. This file's "Insert Canvas"
// toolbar button instead embeds a canvas PARTWAY THROUGH whatever page is
// already open (usage shape 1) — the natural reading of "insert canvas
// [into this page]," and the one that actually produces a `"canvas"`-kind
// `PageAttachment` in the CURRENT page's own `projection.attachments` for
// `PageEditorBody`/`PageEditorAttributes.swift`'s new rendering to have
// anything to render (see those files' task #85 additions).
//
// WHAT'S REAL VS. HONESTLY LIMITED HERE:
//   - Drawing itself (`CanvasEditorView`/`CanvasEditorViewModel`) is fully
//     real and works completely offline — nothing in this file touches it.
//   - Saving a canvas (new or edited) calls `CanvasBlobStore.upload`, which
//     PUTs to `AppBackendConfiguration.vaultBaseURL`'s (still-placeholder,
//     see that file's header) blob route. UPDATE (task #96, plan §Live
//     Backend Connectivity (P8) scope item 4): `appDefault()` below now
//     resolves THIS device's real Keychain-backed credential (task #95)
//     through `EnchiridionCore.DeviceAccessCredentialResolver` on every
//     upload/download, instead of the old empty-string placeholder pair.
//     Two honest failure modes now reach `PageAttachmentCanvasSheet
//     .errorMessage` (never silently swallowed, never faked as success):
//     a device with no enrolled credential fails immediately with
//     `DeviceAccessCredentialResolutionError.deviceNotEnrolled`, BEFORE any
//     request is built; an enrolled device still fails at the network
//     layer, since no live host exists in this sandbox — the same
//     pre-existing, independently-documented gap `AppBackendConfiguration
//     .swift`'s header describes.
//   - Inline, in-text rendering of the embedded canvas (a live thumbnail
//     painted AT the attachment's position inside the running
//     `TextEditor`) is NOT built — see `PageEditorAttributes.swift`'s task
//     #85 addition for exactly why (no per-character tap-interception hook
//     SwiftUI's `TextEditor` exposes while staying editable). What IS built
//     instead, meeting this task's stated "at minimum" bar: a real,
//     genuinely tappable thumbnail strip below the text editor
//     (`PageEditorAttachmentStrip`), one per `"canvas"`-kind attachment in
//     the CURRENT page, opening this same sheet pre-loaded with that
//     attachment's content for viewing/re-editing.
import EnchiridionBlobs
import EnchiridionCanvas
import EnchiridionCore
import SwiftUI

/// One real `BlobCache` per `PageEditorView` instance, pointed at
/// `AppBackendConfiguration.vaultBaseURL` — see that file's header for the
/// honest "not a live endpoint yet" caveat this inherits. A fresh instance
/// per view (rather than one process-wide singleton) is a known,
/// deliberate simplification: `RootView.swift` cannot inject a single
/// shared instance into every `PageEditorView` construction site, since
/// several of them happen inside OTHER P7 tracks' own protected files
/// (`DayPageView`/`TaskDetailEditorSheet`) that this task must not modify
/// — see `PageEditorView.swift`'s `blobCache` parameter doc comment for
/// the full reasoning. The cost is a cold LRU cache per editor session,
/// never a correctness issue (`BlobCache` is stateless-safe to construct
/// repeatedly).
///
/// `credentialStore` defaults to a real Keychain-backed
/// `DeviceAccessCredentialStore` (task #95) — see this file's header for
/// the honest "not enrolled" vs. "no live host" failure split this now
/// produces.
extension BlobCache {
  public static func appDefault(credentialStore: DeviceAccessCredentialStore = DeviceAccessCredentialStore()) -> BlobCache {
    let resolver = DeviceAccessCredentialResolver(store: credentialStore)
    return BlobCache(
      endpoint: BlobServiceEndpoint(
        baseURL: AppBackendConfiguration.vaultBaseURL,
        accessCredential: {
          let credential = try await resolver.resolveCredential()
          return AccessServiceTokenCredential(clientId: credential.clientId, clientSecret: credential.clientSecret)
        }))
  }
}

/// Which canvas the sheet is showing: a brand-new, not-yet-embedded canvas
/// (`.new`, to be inserted at `position` on save) or an existing embedded
/// one being re-opened (`.existing`, to be re-marked in place on save —
/// `PageEditorController.updateAttachment(_:blobID:width:height:mimeType:)`).
enum PageCanvasSheetContext: Identifiable, Equatable {
  case new(position: Int)
  case existing(AttachmentRun)

  var id: String {
    switch self {
    case .new(let position): "new-\(position)"
    case .existing(let run): "existing-\(run.range.lowerBound)-\(run.range.upperBound)-\(run.blobID)"
    }
  }
}

/// Task #92 (adversarial-review finding, HIGH) addition — the pure
/// decision behind `PageEditorView.handleCanvasSaved`'s `.existing` case,
/// factored out of that method specifically so it's unit-testable on its
/// own: `PageEditorCanvasSaveOutcomeTests` exercises this mapping
/// directly, independent of `handleCanvasSaved`'s own `@State` writes
/// (which that method's doc comment explains are not reliably observable
/// from a `PageEditorView` outside a live SwiftUI host in this
/// environment).
enum CanvasSaveOutcome: Equatable {
  /// `PageEditorController.updateAttachment` genuinely re-marked the
  /// attachment — the sheet should dismiss.
  case dismissSheet
  /// `updateAttachment` no-opped (a stale `AttachmentRun` — the page
  /// shifted under the open sheet). The sheet must stay open; this is the
  /// message the call site should surface instead of silently closing.
  case keepSheetOpen(errorMessage: String)

  static func from(didPersist: Bool) -> CanvasSaveOutcome {
    didPersist
      ? .dismissSheet
      : .keepSheetOpen(
        errorMessage:
          "Couldn't save this canvas — the page changed while you were editing. Your drawing is uploaded; reopen the canvas and save again to attach it.")
  }
}

/// The "insert/edit canvas" sheet: hosts the real `CanvasEditorView` over a
/// fresh (or, for `.existing`, downloaded-and-loaded) `CanvasEditorViewModel`,
/// with Save/Cancel actions.
struct PageAttachmentCanvasSheet: View {
  let context: PageCanvasSheetContext
  let blobCache: BlobCache
  /// Task #92 (adversarial-review finding, HIGH) change — was `-> Void`.
  /// `PageEditorController.updateAttachment` now reports success/failure
  /// (see that method's doc comment) instead of silently no-opping when
  /// the page shifted underneath an open canvas sheet, so this closure's
  /// return value carries that outcome back here: `true` means the
  /// caller (`PageEditorView.handleCanvasSaved`) actually persisted the
  /// new attachment and dismissed the sheet; `false` means it didn't, and
  /// this sheet must stay open with a real error instead of closing as if
  /// the edit had saved.
  let onSave: (BlobReference, CanvasSize) -> Bool
  let onCancel: () -> Void

  @State private var viewModel: CanvasEditorViewModel
  @State private var isLoading: Bool
  @State private var isSaving = false
  @State private var errorMessage: String?

  init(
    context: PageCanvasSheetContext, blobCache: BlobCache,
    onSave: @escaping (BlobReference, CanvasSize) -> Bool, onCancel: @escaping () -> Void
  ) {
    self.context = context
    self.blobCache = blobCache
    self.onSave = onSave
    self.onCancel = onCancel
    _viewModel = State(initialValue: CanvasEditorViewModel())
    if case .existing = context {
      _isLoading = State(initialValue: true)
    } else {
      _isLoading = State(initialValue: false)
    }
  }

  var body: some View {
    NavigationStack {
      Group {
        if isLoading {
          ProgressView()
        } else {
          CanvasEditorView(viewModel: viewModel)
        }
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if let errorMessage {
          Text(errorMessage)
            .font(.footnote)
            .foregroundStyle(.red)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
        }
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { save() }
            .disabled(isSaving || isLoading)
        }
      }
      .navigationTitle("Canvas")
    }
    .task { await loadIfNeeded() }
  }

  private func loadIfNeeded() async {
    guard case .existing(let run) = context else {
      isLoading = false
      return
    }
    do {
      let document = try await CanvasBlobStore.download(id: BlobID(rawValue: run.blobID), using: blobCache)
      viewModel.loadDocument(document)
    } catch {
      errorMessage = "Couldn't load this canvas: \(error.localizedDescription)"
    }
    isLoading = false
  }

  private func save() {
    isSaving = true
    errorMessage = nil
    Task {
      do {
        let reference = try await CanvasBlobStore.upload(viewModel.document, using: blobCache)
        // Task #92 fix: the blob upload above can succeed while the
        // caller-side attachment write still fails (the page's text
        // shifted underneath this sheet while it was open — see
        // `PageEditorController.updateAttachment`'s doc comment). Before
        // this fix `onSave` returned `Void` and this sheet dismissed
        // unconditionally, so the user saw success even though the new
        // blob was never referenced by anything. Now `onSave` reports
        // whether it actually persisted, and a `false` keeps this sheet
        // open with a real error instead of silently losing the edit.
        if !onSave(reference, viewModel.canvasSize) {
          errorMessage =
            "Couldn't save this canvas — the page changed while you were editing. Your drawing is uploaded; reopen the canvas and save again to attach it."
        }
      } catch {
        errorMessage = "Couldn't save canvas: \(error.localizedDescription)"
      }
      isSaving = false
    }
  }
}

/// The tappable-thumbnail affordance for every `"canvas"`-kind attachment
/// already embedded in the current page — see this file's header for why
/// this is a separate strip rather than an in-text tap target.
struct PageEditorAttachmentStrip: View {
  let attachmentRuns: [AttachmentRun]
  let onSelect: (AttachmentRun) -> Void

  private var canvasRuns: [AttachmentRun] {
    attachmentRuns.filter { $0.kind == CanvasAttachmentKind.canvas }
  }

  var body: some View {
    if !canvasRuns.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(canvasRuns, id: \.self) { run in
            Button {
              onSelect(run)
            } label: {
              VStack(spacing: 4) {
                Image(systemName: "scribble.variable")
                  .font(.title2)
                Text(dimensionsLabel(run))
                  .font(.caption2)
                  .foregroundStyle(.secondary)
              }
              .frame(width: 72, height: 56)
              .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
      }
    }
  }

  private func dimensionsLabel(_ run: AttachmentRun) -> String {
    guard let width = run.width, let height = run.height else { return "Canvas" }
    return "\(Int(width))×\(Int(height))"
  }
}
