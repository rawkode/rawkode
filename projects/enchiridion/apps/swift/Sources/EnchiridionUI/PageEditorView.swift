// PageEditorView.swift
// EnchiridionUI
//
// Task point 2/3: title field + body `TextEditor`, a formatting toolbar
// matching `LoroEngine.MarkStyle`'s vocabulary exactly (bold/italic/
// underline/strikethrough/code — no more, no fewer), inline `[[`
// page-reference insertion with a distinct visual style and tap/click
// navigation (stubbed via `onNavigateToReference`, per the task — real
// routing is a separate future task).
//
// This file is genuinely unverified beyond compiling — see the P1 report
// for the full list (no simulator/device run happened in this sandbox).
// The interaction pieces most likely to need correction on a real run:
// `AttributedTextSelection` <-> `PageEditorAttributes`'s scalar-offset
// bridge (selection.swift below), and the `[[` trigger picker's dismiss
// timing.
//
// PLATFORM DIFFERENCES: macOS now uses the window toolbar where a writer
// expects formatting controls, while iOS keeps a reachable bottom accessory.
// Both platforms share the same text/selection/controller path, so this is
// presentation divergence only — never a second editing or sync model.

import EnchiridionBlobs
import EnchiridionCanvas
import EnchiridionCore
import EnchiridionSync
import SwiftUI

public struct PageEditorView: View {
  @Bindable private var controller: PageEditorController
  private let onNavigateToReference: (PageID) -> Void
  private let suggestPages: (String) -> [PageSuggestion]
  /// Task #85 (P7 integration wave) addition — backs the "Insert Canvas"
  /// toolbar action and the attachment thumbnail strip's downloads.
  /// Defaulted (not a required parameter) specifically so this file's
  /// existing call sites in OTHER P7 tracks' protected files
  /// (`DayPageView.swift`, `TaskDetailEditorSheet.swift` — this task must
  /// not modify either) keep compiling unchanged against the OLD 3-argument
  /// call shape; they simply get a real, working default `BlobCache`
  /// (`BlobCache.appDefault()`, PageCanvasEmbedding.swift) rather than a
  /// second, differently-configured one — see that extension's doc comment
  /// for the "one instance per `PageEditorView`, not a shared singleton"
  /// tradeoff this implies.
  private let blobCache: BlobCache

  @State private var selection = AttributedTextSelection()
  /// Formatting explicitly armed at a bare insertion caret. Loro cannot
  /// retain a zero-length mark, so this is deliberately view-local until
  /// the next text insertion turns it into a real styled range.
  @State private var typingStyles: Set<LoroEngine.MarkStyle> = []
  /// Text entry normally moves the selection. Preserve the explicitly armed
  /// styles through that synthetic move; a later deliberate caret move reads
  /// the formatting at the new location instead.
  @State private var preserveTypingStylesThroughNextSelectionChange = false
  @State private var activeTrigger: PageReferenceTriggerMatch?
  @State private var canvasSheetContext: PageCanvasSheetContext?

  public init(
    controller: PageEditorController,
    onNavigateToReference: @escaping (PageID) -> Void,
    suggestPages: @escaping (String) -> [PageSuggestion] = { _ in [] },
    blobCache: BlobCache = .appDefault()
  ) {
    self.controller = controller
    self.onNavigateToReference = onNavigateToReference
    self.suggestPages = suggestPages
    self.blobCache = blobCache
  }

  public var body: some View {
    platformEditor
      .onDisappear {
        Task { await controller.flush() }
        controller.invalidate()
      }
      .sheet(item: $canvasSheetContext) { context in
        PageAttachmentCanvasSheet(
          context: context, blobCache: blobCache,
          onSave: { reference, canvasSize in handleCanvasSaved(context: context, reference: reference, canvasSize: canvasSize) },
          onCancel: { canvasSheetContext = nil }
        )
      }
  }

  private var editorContent: some View {
    VStack(alignment: .leading, spacing: 0) {
      titleEditor

      Divider()

      PageEditorAttachmentStrip(attachmentRuns: controller.body.attachmentRuns) { run in
        canvasSheetContext = .existing(run)
      }

      writingSurface
    }
  }

  @ViewBuilder
  private var platformEditor: some View {
#if os(macOS)
    editorContent
      .toolbar {
        ToolbarItemGroup(placement: .primaryAction) {
          formattingButton(.bold, title: "Bold", systemImage: "bold", shortcut: "b")
          formattingButton(.italic, title: "Italic", systemImage: "italic", shortcut: "i")
          formattingButton(.underline, title: "Underline", systemImage: "underline", shortcut: "u")
          formattingButton(.strikethrough, title: "Strikethrough", systemImage: "strikethrough", shortcut: nil)
          formattingButton(.code, title: "Inline Code", systemImage: "chevron.left.forwardslash.chevron.right", shortcut: "e")

          Menu {
            Button("Link Page", systemImage: "link", action: insertReferenceFromToolbar)
            Button("Insert Canvas", systemImage: "scribble.variable", action: insertCanvasFromToolbar)
          } label: {
            Label("Insert", systemImage: "plus")
          }
          .help("Insert a page reference or canvas")

          editorSaveState
        }
      }
#else
    editorContent
      .safeAreaInset(edge: .bottom, spacing: 0) {
        formattingToolbar
      }
#endif
  }

  private var titleEditor: some View {
    HStack(spacing: 0) {
      Spacer(minLength: 20)
      TextField(
        "Untitled",
        text: Binding(get: { controller.title }, set: { controller.setTitle($0) })
      )
      .font(.system(size: 30, weight: .bold))
      .textFieldStyle(.plain)
      .accessibilityLabel("Note title")
      .frame(maxWidth: 820, alignment: .leading)
      Spacer(minLength: 20)
    }
    .padding(.top, 22)
    .padding(.bottom, 12)
  }

  private var writingSurface: some View {
    HStack(spacing: 0) {
      Spacer(minLength: 20)
      ZStack(alignment: .bottomLeading) {
        TextEditor(text: attributedBodyBinding, selection: $selection)
          .font(.body)
          .scrollContentBackground(.hidden)
          .padding(.vertical, 12)
          .accessibilityLabel("Note body")
          .onChange(of: selection) { _, _ in handleSelectionChange() }

        if controller.body.text.isEmpty {
          Text("Start writing…")
            .foregroundStyle(.tertiary)
            .padding(.leading, 6)
            .padding(.top, 17)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .allowsHitTesting(false)
        }

        if let trigger = activeTrigger {
          referencePicker(for: trigger)
        }
      }
      .frame(maxWidth: 820, maxHeight: .infinity, alignment: .topLeading)
      Spacer(minLength: 20)
    }
  }

  // MARK: - Canvas embedding (task #85)

  /// Task #92 (adversarial-review finding, HIGH) fix — was `-> Void` and
  /// unconditionally set `canvasSheetContext = nil`, i.e. it dismissed the
  /// sheet as a successful save no matter what
  /// `PageEditorController.updateAttachment` actually did. That method
  /// deliberately no-ops (returns `false`, since task #92's controller-
  /// level change) when the caller-supplied `AttachmentRun` no longer
  /// matches `body.attachmentRuns` — e.g. the page's text shifted under
  /// the open canvas sheet from a local edit elsewhere or a CRDT merge
  /// landing mid-draw. By the time that guard fires,
  /// `CanvasBlobStore.upload` has ALREADY put the new bytes on the
  /// server — dismissing the sheet anyway would tell the user their edit
  /// saved when the page still points at the OLD blob and the new one is
  /// now unreferenced by anything.
  ///
  /// Now returns `Bool`, matching `PageAttachmentCanvasSheet.onSave`'s
  /// updated shape: `false` means the sheet stays open (via
  /// `canvasSheetContext` staying non-nil) and that sheet shows a real
  /// error instead, so the user can retry rather than unknowingly losing
  /// the edit. `.new` inserts unconditionally (there is no existing run
  /// to go stale) and always succeeds.
  ///
  /// The actual "what should happen" decision is delegated to
  /// `CanvasSaveOutcome.from(didPersist:)` below rather than inlined here,
  /// specifically so it's independently unit-testable — this method's own
  /// `@State` write (`canvasSheetContext = nil`) is, empirically, NOT
  /// reliably observable from a `PageEditorView` constructed outside a
  /// live SwiftUI host in this test environment (confirmed directly: a
  /// `@State` write and an immediate readback on a freshly-constructed,
  /// never-hosted view instance do not round-trip here), matching this
  /// package's existing "gesture/View-hosting wiring is exercised by
  /// compilation only" convention (see `CanvasEditorView.swift`'s header).
  /// This method's Bool RETURN VALUE has no such limitation — it's a
  /// plain computed result, not state — and is exactly what
  /// `PageAttachmentCanvasSheet.onSave` (the real caller) uses to decide
  /// whether to show its own error, so it's real, caller-visible behavior
  /// `PageEditorCanvasSaveOutcomeTests` tests directly.
  func handleCanvasSaved(context: PageCanvasSheetContext, reference: BlobReference, canvasSize: CanvasSize) -> Bool {
    switch context {
    case .new(let position):
      controller.insertAttachment(
        placeholder: CanvasEmbed.placeholder, kind: CanvasAttachmentKind.canvas, blobID: reference.id.rawValue,
        width: canvasSize.width, height: canvasSize.height, mimeType: reference.metadata.mimeType, at: position)
      canvasSheetContext = nil
      return true
    case .existing(let run):
      let didPersist = controller.updateAttachment(
        run, blobID: reference.id.rawValue, width: canvasSize.width, height: canvasSize.height,
        mimeType: reference.metadata.mimeType)
      switch CanvasSaveOutcome.from(didPersist: didPersist) {
      case .dismissSheet:
        canvasSheetContext = nil
        return true
      case .keepSheetOpen:
        return false
      }
    }
  }

  // MARK: - Body <-> AttributedString

  private var attributedBodyBinding: Binding<AttributedString> {
    Binding(
      get: { controller.body.attributedString },
      set: { newValue in
        let newPlainText = newValue.plainTextRepresentation
        guard newPlainText != controller.body.text,
          let replacement = TextDiff.replacement(from: controller.body.text, to: newPlainText)
        else { return }
        if !replacement.replacement.isEmpty {
          preserveTypingStylesThroughNextSelectionChange = true
        }
        controller.applyBodyReplacement(replacement, formattingStyles: formattingStylesForIncomingText())
      }
    )
  }

  /// The caret/selection expressed in `PageEditorBody`'s Unicode Scalar
  /// offsets — `nil` for anything AttributedTextSelection reports that
  /// doesn't reduce to a single position or single contiguous range (a
  /// discontiguous multi-range selection has no single meaningful
  /// mark-toggle/insertion point).
  private var currentOffsetRange: Range<Int>? {
    let attributed = controller.body.attributedString
    switch selection.indices(in: attributed) {
    case .insertionPoint(let index):
      let offset = attributed.scalarOffset(of: index)
      return offset..<offset
    case .ranges(let ranges):
      guard ranges.ranges.count == 1, let range = ranges.ranges.first else { return nil }
      return attributed.scalarOffset(of: range.lowerBound)..<attributed.scalarOffset(of: range.upperBound)
    @unknown default:
      return nil
    }
  }

  private func formattingStylesForIncomingText() -> Set<LoroEngine.MarkStyle> {
    guard let range = currentOffsetRange else { return typingStyles }
    guard !range.isEmpty else { return typingStyles }
    return inlineStyles(in: range)
  }

  private func inlineStyles(in range: Range<Int>) -> Set<LoroEngine.MarkStyle> {
    Set(
      LoroEngine.MarkStyle.allCases.filter {
        $0.isInlineFormatting && MarkToggleEngine.state(of: $0, in: range, runs: controller.body.markRuns) == .on
      })
  }

  private func handleSelectionChange() {
    updateActiveTrigger()
    guard let range = currentOffsetRange, range.isEmpty else {
      preserveTypingStylesThroughNextSelectionChange = false
      return
    }
    if preserveTypingStylesThroughNextSelectionChange {
      preserveTypingStylesThroughNextSelectionChange = false
    } else {
      typingStyles = inlineStyles(in: range)
    }
  }

  // MARK: - Formatting controls

  private var formattingToolbar: some View {
    HStack(spacing: 4) {
      formattingButton(.bold, title: "Bold", systemImage: "bold", shortcut: "b")
      formattingButton(.italic, title: "Italic", systemImage: "italic", shortcut: "i")
      formattingButton(.underline, title: "Underline", systemImage: "underline", shortcut: "u")
      formattingButton(.strikethrough, title: "Strikethrough", systemImage: "strikethrough", shortcut: nil)
      formattingButton(.code, title: "Inline Code", systemImage: "chevron.left.forwardslash.chevron.right", shortcut: "e")
      Spacer()
      editorSaveState
      Button {
        insertReferenceFromToolbar()
      } label: {
        Label("Link Page", systemImage: "link")
      }
      .buttonStyle(.borderless)
      .help("Insert a page reference")

      Button {
        insertCanvasFromToolbar()
      } label: {
        Label("Insert Canvas", systemImage: "scribble.variable")
      }
      .buttonStyle(.borderless)
      .help("Insert a drawing canvas")
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .background(.bar)
  }

  private func formattingButton(
    _ style: LoroEngine.MarkStyle,
    title: String,
    systemImage: String,
    shortcut: Character?
  ) -> some View {
    let isOn = isFormattingEnabled(style)
    return Button {
      toggleFormatting(style)
    } label: {
      Image(systemName: systemImage)
        .foregroundStyle(isOn ? Color.accentColor : Color.primary)
    }
    .buttonStyle(.borderless)
    .modifier(OptionalKeyboardShortcut(character: shortcut))
    .disabled(currentOffsetRange == nil)
    .accessibilityLabel(title)
    .accessibilityValue(isOn ? "On" : "Off")
    .help(shortcut.map { "\(title) (Command-\($0.uppercased()))" } ?? title)
  }

  private func isFormattingEnabled(_ style: LoroEngine.MarkStyle) -> Bool {
    guard let range = currentOffsetRange else { return false }
    if range.isEmpty { return typingStyles.contains(style) }
    return MarkToggleEngine.state(of: style, in: range, runs: controller.body.markRuns) == .on
  }

  private func toggleFormatting(_ style: LoroEngine.MarkStyle) {
    guard let range = currentOffsetRange else { return }
    if range.isEmpty {
      if typingStyles.contains(style) {
        typingStyles.remove(style)
      } else {
        typingStyles.insert(style)
      }
    } else {
      controller.toggleMark(style, over: range)
    }
  }

  @ViewBuilder
  private var editorSaveState: some View {
    if let error = controller.lastFlushError {
      Image(systemName: "exclamationmark.circle.fill")
        .foregroundStyle(.red)
        .help("Couldn't save: \(error)")
        .accessibilityLabel("Couldn't save note")
    } else if controller.isFlushing {
      ProgressView()
        .controlSize(.small)
        .help("Saving note")
        .accessibilityLabel("Saving note")
    } else if controller.isDirty {
      Image(systemName: "arrow.triangle.2.circlepath")
        .foregroundStyle(.secondary)
        .help("Saving note")
        .accessibilityLabel("Saving note")
    } else {
      Image(systemName: "checkmark")
        .foregroundStyle(.secondary)
        .help("All changes saved")
        .accessibilityLabel("All changes saved")
    }
  }

  // MARK: - "[[" page-reference trigger + insertion (task point 2)

  private func updateActiveTrigger() {
    guard let range = currentOffsetRange, range.isEmpty else {
      activeTrigger = nil
      return
    }
    activeTrigger = PageReferenceTrigger.match(in: controller.body.text, cursor: range.lowerBound)
  }

  private func referencePicker(for trigger: PageReferenceTriggerMatch) -> some View {
    let suggestions = suggestPages(trigger.query)
    return VStack(alignment: .leading, spacing: 0) {
      if suggestions.isEmpty {
        Text("No matching pages")
          .foregroundStyle(.secondary)
          .padding(8)
      } else {
        ForEach(suggestions.prefix(6)) { suggestion in
          Button {
            chooseReference(suggestion, for: trigger)
          } label: {
            Text(suggestion.title)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.borderless)
          .padding(.horizontal, 8)
          .padding(.vertical, 4)
        }
      }
    }
    .background(.regularMaterial)
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .shadow(radius: 4)
    .padding(.leading, 8)
    .padding(.bottom, 4)
    .frame(maxWidth: 260)
  }

  private func chooseReference(_ suggestion: PageSuggestion, for trigger: PageReferenceTriggerMatch) {
    let plan = PageReferenceInsertion.plan(replacing: trigger.range, with: suggestion.title, pageID: suggestion.pageID)
    controller.insertPageReference(plan)
    activeTrigger = nil
  }

  private func insertReferenceFromToolbar() {
    // Toolbar-invoked insertion (no `[[` typed): replace the current
    // caret/selection, if any, with a picker anchored at that same point.
    // A full free-standing picker sheet is out of scope here — the `[[`
    // flow above is the primary path; this affordance exists so the
    // capability isn't keyboard-shortcut-only, matching PRODUCT.md's "one
    // coherent native vocabulary" (a toolbar button should do *something*
    // for every capability the editor advertises).
    guard let range = currentOffsetRange else { return }
    activeTrigger = PageReferenceTriggerMatch(range: range, query: "")
  }

  /// Task #85 addition — opens the "insert canvas" sheet
  /// (`PageAttachmentCanvasSheet`) at the current caret position, falling
  /// back to the end of the body when there's no active caret/selection
  /// (mirrors `insertReferenceFromToolbar`'s own "toolbar-invoked, no
  /// interior position required" posture). Nothing is written to the
  /// document until the sheet's own Save action succeeds — see
  /// `handleCanvasSaved(context:reference:canvasSize:)`.
  private func insertCanvasFromToolbar() {
    let position = currentOffsetRange?.lowerBound ?? controller.body.length
    canvasSheetContext = .new(position: position)
  }
}

/// `.keyboardShortcut` only accepts a non-optional `KeyEquivalent`;
/// strikethrough has no assigned shortcut in this editor (matches the old
/// app's omission — strikethrough is toolbar/menu-only), so this lets
/// `formattingButton` stay one shared implementation instead of branching.
private struct OptionalKeyboardShortcut: ViewModifier {
  let character: Character?

  func body(content: Content) -> some View {
    if let character {
      content.keyboardShortcut(KeyEquivalent(character), modifiers: .command)
    } else {
      content
    }
  }
}
