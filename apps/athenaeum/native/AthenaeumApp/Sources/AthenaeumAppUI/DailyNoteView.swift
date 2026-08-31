import Foundation
import SwiftUI
import AthenaeumDomain
import AthenaeumCore

/// The native reader intentionally has no entity/tag/link interaction surface.  This small,
/// value-free policy is testable without exposing projection attributes to the UI layer.
public struct LoroProjectionTextPresentation: Equatable, Sendable {
    public let allowsTextSelection: Bool
    public let accessibilityLabel: String?
    public let visibleSuffix: String?

    public init(marks: [LoroPageProjectionMark]) {
        let unsupported = marks.contains(.unsupported)
        self.allowsTextSelection = !unsupported
        self.accessibilityLabel = unsupported ? "Text with unsupported formatting" : nil
        self.visibleSuffix = unsupported ? " · unsupported formatting" : nil
    }
}

/// Route, edit, and sync catches retain their raw diagnostic in the view model, but that text can
/// contain transport or credential-adjacent detail. The canvas presents one safe recovery message.
enum DailyNoteFailurePresentation {
    static let title = "Daily note is unavailable"
    static let retryLabel = "Retry loading this note"

    static func message(for _: String) -> String {
        "We couldn’t resolve this daily note. Retry to continue loading this date safely."
    }

    static func accessibilityLabel(for rawMessage: String) -> String {
        "\(title). \(message(for: rawMessage))"
    }
}

/// Recorded work is scoped to the current calendar day. Historical Daily Notes retain their own
/// document and backlinks, but must not embed the current day's standup activity.
enum DailyNoteStandupPresentation {
    static let anchorID = "athenaeum.daily-note.standup"

    static func shouldShow(isToday: Bool, hasConfiguration: Bool) -> Bool {
        isToday && hasConfiguration
    }

    static func shouldShowEmployeeUpdates(hasConfiguration: Bool) -> Bool {
        hasConfiguration
    }
}

/// Navigation already waits at the view-model's durable-before-navigation boundary. This is only
/// a contextual presentation of that existing state, so disabled date controls never feel inert.
enum DailyNoteNavigationProgressPresentation {
    static func message(
        isNavigating: Bool,
        status: AthenaeumViewModel.SyncStatus
    ) -> String? {
        guard isNavigating else { return nil }
        switch status {
        case .syncing, .pending(_):
            return "Saving this note before changing days…"
        default:
            return "Opening the selected daily note…"
        }
    }
}

enum DailyNotePreparationAnnouncementPresentation {
    static let message = "Meeting prepared in this daily note."

    static func shouldFocus(pagePresentation: AthenaeumViewModel.PagePresentation) -> Bool {
        pagePresentation == .loroPlainEditable || pagePresentation == .loroRichEditable
    }
}

/// The settled note should recede into the background. Only active saving or an actionable
/// exception earns a persistent status line; the editor itself keeps a modest writing floor
/// instead of occupying dashboard-sized empty space.
enum DailyNoteWritingPresentation {
    static let minimumEditorHeight: CGFloat = 180

    static func borderOpacity(isFocused: Bool) -> Double {
        isFocused ? 0.35 : 0.12
    }

    static func borderLineWidth(isFocused: Bool) -> CGFloat {
        isFocused ? 1.5 : 1
    }

    static func showsStatus(_ status: AthenaeumViewModel.SyncStatus) -> Bool {
        switch status {
        case .syncing, .pending, .conflict, .error:
            return true
        case .idle, .loading, .synced:
            return false
        }
    }

    static func accessibilityLabel(for status: AthenaeumViewModel.SyncStatus) -> String? {
        switch status {
        case .syncing:
            return "Syncing daily note."
        case .pending:
            return "A local change is pending."
        case .conflict:
            return "Local changes need resolution."
        case .error:
            return "Daily note sync needs attention."
        case .idle, .loading, .synced:
            return nil
        }
    }
}

/// Native mirror of `web/src/DailyNote.tsx`: resolves/creates today's note (via
/// `AthenaeumViewModel.start()`), then routes active Loro pages to the native plain-text editor
/// and explicit legacy descriptors to a server-owned, read-only projection. It also owns the sync
/// status line and nested `BacklinksView`, matching the composition used by `DailyNote.tsx`.
public struct DailyNoteView: View {
    @ObservedObject var model: AthenaeumViewModel
    @Environment(\.scenePhase) private var scenePhase
    private let standupConfiguration: StandupConfiguration?
    /// A single contextual projection (currently the calendar brief) can be inserted after the
    /// note/editor content on compact surfaces. The command center owns the projection's
    /// client/model; this type-erased slot only controls composition and never fetches data.
    private let contextualView: AnyView?
    private let onOpenEmployeeUpdate: ((EntityId) -> Void)?
    private let onReviewStandup: (() -> Void)?
    private let onOpenReference: ((LoroCanonicalSemanticValueV1.InlineReference) -> Void)?
    private let standupLifecycleDriver: DailyStandupLifecycleDriver
    /// DailyNote is the sole owner; standup detail/strip are passive observers.
    @StateObject private var dailyStandupModel: DailyStandupViewModel
    @State private var preparationNotice: String?
    @State private var hasAutofocused = false
    /// TextKit rich editing crosses the SwiftUI/AppKit boundary. A generation lets the
    /// representable honor one request after its NSTextView has actually joined a window.
    @State private var richEditorFocusGeneration = 0
    /// Rich representables own the actual responder, so this state is presentation-only and is
    /// fed by their native focus callbacks rather than the plain-text FocusState binding.
    @State private var richEditorIsFocused = false
    @FocusState private var editorFocused: Bool

    public init(model: AthenaeumViewModel) {
        self.model = model
        self.standupConfiguration = nil
        self.contextualView = nil
        self.onOpenEmployeeUpdate = nil
        self.onReviewStandup = nil
        self.onOpenReference = nil
        self.standupLifecycleDriver = .live
        _dailyStandupModel = StateObject(wrappedValue: .init(ledgerLoader: nil, employeeLoader: nil))
    }

    /// Keeps secondary daily-note documents inside the note's own composition. The command
    /// center uses this for the standup so it cannot drift into a competing dashboard panel.
    public init(
        model: AthenaeumViewModel,
        standupBackendURL: URL,
        standupWorkspaceId: EntityId,
        standupBearerCredential: String?,
        contextualView: AnyView? = nil,
        onOpenEmployeeUpdate: ((EntityId) -> Void)? = nil,
        onReviewStandup: (() -> Void)? = nil,
        onOpenReference: ((LoroCanonicalSemanticValueV1.InlineReference) -> Void)? = nil,
        standupLifecycleDriver: DailyStandupLifecycleDriver = .live
    ) {
        self.model = model
        self.standupConfiguration = StandupConfiguration(
            backendURL: standupBackendURL,
            workspaceId: standupWorkspaceId,
            bearerCredential: standupBearerCredential
        )
        self.contextualView = contextualView
        self.onOpenEmployeeUpdate = onOpenEmployeeUpdate
        self.onReviewStandup = onReviewStandup
        self.onOpenReference = onOpenReference
        self.standupLifecycleDriver = standupLifecycleDriver
        _dailyStandupModel = StateObject(wrappedValue: .init(
            backendURL: standupBackendURL,
            workspaceId: standupWorkspaceId,
            bearerCredential: standupBearerCredential,
            dailyNoteId: model.dailyNoteId,
            includeLedger: true
        ))
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            noteHeader

            // Today attention is deliberately the first operational context after the note
            // heading; the full historical/publication detail remains below the editor.
            if isToday, standupConfiguration != nil {
                WorkforceAttentionStrip(
                    model: dailyStandupModel,
                    onOpen: onOpenEmployeeUpdate,
                    onReviewStandup: hasResolvedDailyNote ? onReviewStandup : nil
                )
            }

            switch model.status {
            case .loading:
                ProgressView("Resolving \(isToday ? "today’s note" : "the daily note")…")
            case .error(let message):
                dailyNoteFailureCard(message)
            default:
                switch model.pagePresentation {
                case .loroProjectedReadOnly(let state):
                    loroProjection(state.projection.root)
                    loroRecoveryControls
                case .loroReadOnly(let projection):
                    loroReadOnlyCard(projection)
                    loroRecoveryControls
                case .loroPlainEditable:
                    loroPlainEditor
                    loroRecoveryControls
                case .loroRichEditable:
                    loroRichEditor
                    loroRecoveryControls
                case .retainedLocalChangeConflict(let message):
                    conflictCard(message)
                    loroRecoveryControls
                case .automergeRichTextReadOnly:
                    richTextBanner
                    editor
                case .legacyMigrationRequired(let content):
                    legacyMigrationRequiredCard(content)
                case .automergeEditable:
                    editor
                case .unavailable:
                    ProgressView("Preparing daily note…")
                }
                statusLine
                if let preparationNotice {
                    Text(preparationNotice)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityAddTraits(.updatesFrequently)
                        .accessibilityLabel(preparationNotice)
                }
            }

            // Keep this projection mounted while a note is loading or recovering. It owns an
            // independent TodayBrief model, so placing it outside the status switch prevents
            // transient note state from hiding or remounting the calendar context.
            if let contextualView {
                contextualView
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if hasResolvedDailyNote {
                if DailyNoteStandupPresentation.shouldShowEmployeeUpdates(
                    hasConfiguration: standupConfiguration != nil
                ), standupConfiguration != nil {
                    DailyStandupView(
                        model: dailyStandupModel,
                        dailyNoteId: model.dailyNoteId,
                        includeLedger: isToday,
                        onOpenEmployeeUpdate: onOpenEmployeeUpdate,
                        onRefresh: refreshStandup
                    )
                    .id(DailyNoteStandupPresentation.anchorID)
                }
                BacklinksView(model: model)
            }
        }
        .padding()
        .task {
            focusEditorIfNeeded()
            consumePreparationCompletion()
        }
        .onChange(of: model.status) { status in
            guard case .synced = status else { return }
            focusEditorIfNeeded()
        }
        .onChange(of: model.pagePresentation) { presentation in
            if presentation != .automergeEditable && presentation != .loroPlainEditable && presentation != .loroRichEditable {
                clearEditorFocus()
                hasAutofocused = false
            } else {
                // A format transition replaces the underlying editing control. Let that control
                // receive its own first-focus request instead of retaining the prior editor's.
                hasAutofocused = false
                focusEditorIfNeeded()
            }
        }
        .onChange(of: model.selectedDate) { _ in
            clearEditorFocus()
            hasAutofocused = false
            preparationNotice = nil
        }
        .onChange(of: model.preparationCompletionGeneration) { _ in
            consumePreparationCompletion()
        }
        .onChange(of: model.acceptedHumanEditGeneration) { _ in
            preparationNotice = nil
        }
        .task(id: standupSnapshotIdentity) {
            guard standupConfiguration != nil, hasResolvedDailyNote else { return }
            let window = DailyStandupDayWindow(now: standupLifecycleDriver.now())
            dailyStandupModel.update(dailyNoteId: model.dailyNoteId, includeLedger: isToday, dayWindow: window)
            await dailyStandupModel.refresh(window: window)
        }
        .task(id: standupLifecycleIdentity) {
            guard standupConfiguration != nil, isToday, hasResolvedDailyNote else { return }
            // Keep the owner alive across more than one midnight while the app remains open.
            // The task is cancelled automatically when the selected date, resolution state, or
            // configuration changes, and each rollover clears the previous snapshot first.
            while !Task.isCancelled {
                let nextMidnight = DailyStandupLifecyclePresentation.nextLocalMidnight(after: standupLifecycleDriver.now())
                do { try await standupLifecycleDriver.sleepUntil(nextMidnight) }
                catch { return }
                guard !Task.isCancelled, isToday, hasResolvedDailyNote else { return }
                let now = standupLifecycleDriver.now()
                let window = DailyStandupDayWindow(now: now)
                dailyStandupModel.update(dailyNoteId: model.dailyNoteId, includeLedger: true, dayWindow: window)
                await dailyStandupModel.refresh(window: window)
            }
        }
        .onChange(of: scenePhase) { phase in
            guard phase == .active, standupConfiguration != nil, isToday, hasResolvedDailyNote else { return }
            refreshStandup()
        }
    }

    private var hasResolvedDailyNote: Bool {
        switch model.status {
        case .loading, .error(_):
            return false
        default:
            return true
        }
    }

    private var standupSnapshotIdentity: String {
        "\(model.dailyNoteId.rawValue):\(isToday):\(hasResolvedDailyNote)"
    }

    private var standupLifecycleIdentity: String {
        "\(standupSnapshotIdentity):\(standupConfiguration != nil)"
    }

    private func refreshStandup() {
        let window = DailyStandupDayWindow(now: standupLifecycleDriver.now())
        dailyStandupModel.update(dailyNoteId: model.dailyNoteId, includeLedger: isToday, dayWindow: window)
        Task { @MainActor in await dailyStandupModel.refresh(window: window) }
    }

    private func dailyNoteFailureCard(_ rawMessage: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(DailyNoteFailurePresentation.title, systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.primary)
            Text(DailyNoteFailurePresentation.message(for: rawMessage))
                .foregroundStyle(.secondary)
            Button(DailyNoteFailurePresentation.retryLabel) {
                clearEditorFocus()
                hasAutofocused = false
                model.retryCurrentNote()
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isLoroRecoveryInProgress)
            .accessibilityHint("Retries loading the selected daily note.")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(.orange.opacity(0.35), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(DailyNoteFailurePresentation.accessibilityLabel(for: rawMessage))
    }

    private func focusEditorIfNeeded() {
        guard !hasAutofocused,
              (model.pagePresentation == .automergeEditable || model.pagePresentation == .loroPlainEditable || model.pagePresentation == .loroRichEditable)
        else { return }
        guard case .synced = model.status else { return }
        hasAutofocused = true
        if model.pagePresentation == .loroRichEditable {
            clearEditorFocus()
            richEditorFocusGeneration += 1
        } else {
            richEditorIsFocused = false
            editorFocused = true
        }
    }

    private func clearEditorFocus() {
        editorFocused = false
        richEditorIsFocused = false
    }

    private func consumePreparationCompletion() {
        guard model.consumePreparationCompletion() != nil else { return }
        preparationNotice = DailyNotePreparationAnnouncementPresentation.message
        if DailyNotePreparationAnnouncementPresentation.shouldFocus(pagePresentation: model.pagePresentation) {
            hasAutofocused = false
            focusEditorIfNeeded()
        }
        // A clean read-only projection can truthfully confirm the committed preparation, but
        // must never promise an editor focus it cannot provide.
    }

    private var noteHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            // On compact screens the date and navigation cannot share one row without
            // reducing the date to an unreadable, punctuation-breaking column. The first
            // candidate keeps the desktop command-center rhythm; ViewThatFits selects the
            // stacked composition when the available width is too narrow.
            ViewThatFits(in: .horizontal) {
                wideNoteHeaderRow
                compactNoteHeader
            }
        }
    }

    private var wideNoteHeaderRow: some View {
        HStack(alignment: .center, spacing: 8) {
            noteTitle
            formatBadge
            Spacer(minLength: 8)
            dayNavigation
        }
    }

    private var compactNoteHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            // A long legacy badge and a large accessibility date should never compete for
            // the same line. Keep the usual compact rhythm when it fits, then stack the badge
            // below the title before either element is clipped.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    noteTitle
                    Spacer(minLength: 0)
                    formatBadge
                }
                VStack(alignment: .leading, spacing: 4) {
                    noteTitle
                    formatBadge
                }
            }
            dayNavigation
        }
    }

    private var noteTitle: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !isToday {
                Text("Daily note")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                    .tracking(1.2)
            }
            Text(noteDateDisplayLabel)
                .font(.system(.largeTitle, design: .serif).weight(.semibold))
                .lineLimit(2)
                .minimumScaleFactor(0.72)
                .allowsTightening(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Daily note for \(noteDateLabel)")
    }

    private var noteDateLabel: String {
        model.selectedDateLabel
    }

    /// Keep the comma attached to the day when the localized full date needs a compact wrap.
    /// The spoken/accessibility label deliberately remains the ordinary localized string.
    private var noteDateDisplayLabel: String {
        guard let separator = noteDateLabel.range(of: ", ") else { return noteDateLabel }
        return noteDateLabel.replacingCharacters(in: separator, with: ",\u{00a0}")
    }

    private var isToday: Bool {
        model.isSelectedDateToday
    }

    @ViewBuilder
    private var formatBadge: some View {
        switch model.pagePresentation {
        case .loroReadOnly, .loroProjectedReadOnly, .loroPlainEditable, .loroRichEditable, .retainedLocalChangeConflict:
            // Loro is the ordinary editing path; implementation detail stays out of the calm
            // header. Recovery controls and sync status still expose actionable custody state.
            EmptyView()
        case .automergeEditable, .automergeRichTextReadOnly, .legacyMigrationRequired:
            Label("Legacy Automerge", systemImage: "archivebox")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
                .help("This page is still using the legacy Automerge compatibility lane.")
                .accessibilityLabel("Legacy Automerge. This page is still using the legacy Automerge compatibility lane.")
        case .unavailable:
            EmptyView()
        }
    }

    private var dayNavigation: some View {
        ViewThatFits(in: .horizontal) {
            dayNavigationRow
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    previousDayButton
                    nextDayButton
                    Spacer(minLength: 0)
                    todayButton
                }
                selectedDatePicker
            }
        }
    }

    private var dayNavigationRow: some View {
        HStack(spacing: 4) {
            previousDayButton
            selectedDatePicker
            nextDayButton
            todayButton
        }
    }

    private var previousDayButton: some View {
        Button {
            clearEditorFocus()
            model.showPreviousDay()
        } label: {
            Image(systemName: "chevron.left")
        }
        .buttonStyle(.borderless)
        .disabled(model.isNavigating || model.isLoroRecoveryInProgress)
        .accessibilityLabel("Previous day")
        .help("Previous day")
    }

    private var selectedDatePicker: some View {
        DatePicker(
            "Jump to date",
            selection: Binding(
                get: { model.selectedDate },
                set: { newDate in
                    clearEditorFocus()
                    model.showDate(newDate)
                }
            ),
            displayedComponents: .date
        )
        .labelsHidden()
        .disabled(model.isNavigating || model.isLoroRecoveryInProgress)
        .accessibilityLabel("Selected daily note date")
    }

    private var nextDayButton: some View {
        Button {
            clearEditorFocus()
            model.showNextDay()
        } label: {
            Image(systemName: "chevron.right")
        }
        .buttonStyle(.borderless)
        .disabled(model.isNavigating || model.isLoroRecoveryInProgress)
        .accessibilityLabel("Next day")
        .help("Next day")
    }

    @ViewBuilder
    private var todayButton: some View {
        if !isToday {
            Button("Today") {
                clearEditorFocus()
                model.showToday()
            }
            .buttonStyle(.borderless)
            .disabled(model.isNavigating || model.isLoroRecoveryInProgress)
            .accessibilityHint("Return to today’s daily note")
        }
    }

    /// Legacy pages are displayed through the server-owned projection boundary. The native app
    /// deliberately does not decode or mutate the Automerge snapshot; migration must happen on
    /// the server before the page can return to the Loro editor.
    private var richTextBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "text.badge.xmark").foregroundStyle(.orange)
            Text("Legacy page — read-only until it is migrated to Loro.")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(.orange.opacity(0.12)))
    }

    /// This is deliberately a card rather than a disabled text editor. A rich or oversized
    /// Automerge page has no lossless native projection, so displaying a replacement character
    /// or truncated text here would falsely claim the content is safe to read.
    private func legacyMigrationRequiredCard(_ content: LegacyPageProjectionContent) -> some View {
        let detail: String
        switch content {
        case .plainText:
            detail = "This legacy page needs migration before native editing is available."
        case .richTextUnsupported:
            detail = "This legacy page contains rich formatting that native cannot represent safely. Migrate it on the server or open it in the web app."
        case .tooLarge:
            detail = "This legacy page is too large for a safe native projection. Migrate it on the server or open it in the web app."
        }
        return VStack(alignment: .leading, spacing: 8) {
            Label("Migration required", systemImage: "arrow.triangle.2.circlepath")
                .font(.headline)
                .foregroundStyle(.orange)
            Text(detail)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(.orange.opacity(0.12)))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Legacy page migration required. \(detail)")
    }

    private func loroReadOnlyCard(_ projection: DailyNoteLoroReadOnlyState) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "doc.text.magnifyingglass").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("Native Loro page")
                    .font(.headline)
                Text("This page is synchronized, but native rich-text viewing and editing are not available yet.")
                    .foregroundStyle(.secondary)
                Text("Schema \(projection.schemaVersion)\(projection.isDirty ? " · local changes pending" : "")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(.secondary.opacity(0.10)))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Native Loro page. Read-only. Native rich-text viewing and editing are not available yet.")
    }

    private func loroProjection(_ node: LoroPageProjectionNode) -> AnyView {
        switch node {
        case .document(let children):
            return AnyView(VStack(alignment: .leading, spacing: 10) { ForEach(Array(children.enumerated()), id: \.offset) { _, child in loroProjection(child) } }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Read-only Loro page"))
        case .paragraph(let children):
            return AnyView(HStack(spacing: 0) { ForEach(Array(children.enumerated()), id: \.offset) { _, child in loroProjection(child) } })
        case .heading(_, let children):
            return AnyView(HStack(spacing: 0) { ForEach(Array(children.enumerated()), id: \.offset) { _, child in loroProjection(child) } }
                .font(.title3.weight(.semibold)))
        case .text(let value, let marks):
            return loroText(value, marks: marks)
        case .unsupported:
            return AnyView(Text("Unsupported content")
                .foregroundStyle(.secondary)
                .italic()
                .accessibilityLabel("Unsupported read-only content"))
        }
    }

    /// Projection marks intentionally carry only safe presentation semantics. This is text, not
    /// a `Link`: no URL, entity identifier, or action escapes Core or becomes interactive here.
    private func loroText(_ value: String, marks: [LoroPageProjectionMark]) -> AnyView {
        var rendered = Text(value)
        if marks.contains(.strong) { rendered = rendered.bold() }
        if marks.contains(.emphasis) { rendered = rendered.italic() }
        if marks.contains(.code) { rendered = rendered.font(.system(.body, design: .monospaced)) }
        if marks.contains(.link) { rendered = rendered.foregroundColor(.accentColor).underline() }
        let presentation = LoroProjectionTextPresentation(marks: marks)
        return AnyView(HStack(spacing: 0) {
            loroSelectableText(rendered, enabled: presentation.allowsTextSelection)
            if let suffix = presentation.visibleSuffix { Text(suffix).foregroundStyle(.secondary) }
        }.accessibilityLabel(presentation.accessibilityLabel ?? value))
    }

    @ViewBuilder
    private func loroSelectableText(_ text: Text, enabled: Bool) -> some View {
        if enabled { text.textSelection(.enabled) }
        else { text.textSelection(.disabled) }
    }

    private func conflictCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Local changes need resolution").font(.headline)
            Text(message).foregroundStyle(.secondary)
            Button("Retry loading this note") { model.retryCurrentNote() }
                .buttonStyle(.bordered)
                .disabled(model.isLoroRecoveryInProgress)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(.orange.opacity(0.12)))
    }

    @ViewBuilder
    private var loroRecoveryControls: some View {
        if let notice = model.loroNotice { Text(notice).font(.caption).foregroundStyle(.secondary) }
        if let action = model.loroRecoveryAction {
            Button(loroActionTitle(action)) { model.performLoroRecoveryAction() }
                .buttonStyle(.bordered)
                .disabled(model.isLoroRecoveryInProgress)
            if model.isLoroRecoveryInProgress {
                ProgressView("Recovering saved change…")
                    .controlSize(.small)
            }
        }
    }

    private func loroActionTitle(_ action: AthenaeumViewModel.LoroRecoveryAction) -> String {
        switch action {
        case .continueRecovery: return "Continue recovery"
        case .retrySavedChange: return "Retry saved change"
        case .recoverSavedEditableVersion: return "Try to recover a saved editable version"
        case .recoverSavedRichEditableVersion: return "Try to recover a saved editable rich-text version"
        case .reloadEditor: return "Reload editor"
        case .discardRichDraftAndReload: return "Discard rich draft and reload"
        }
    }

    private var editor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: Binding(
                get: { model.text },
                set: { model.handleTextChange($0) }
            ))
            .font(.system(.body, design: .serif))
            .lineSpacing(6)
            .scrollContentBackground(.hidden)
            .focused($editorFocused)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            // Belt-and-braces alongside `AthenaeumViewModel.handleTextChange`'s own guard: a
            // rich note's `TextEditor` is never interactable at all, not just rejected on commit
            // — no garbled U+FFFC glyphs are ever exposed to a real editing cursor.
            .disabled(model.isEditorInputDisabled)
            .opacity(model.isEditorInputDisabled ? 0.6 : 1)
            .accessibilityLabel("Daily note")
            .accessibilityHint(
                model.isRichTextReadOnly
                    ? "Read-only. Edit this note on the web app."
                    : "Write what is worth remembering today."
            )

            if model.text.isEmpty && !model.isRichTextReadOnly {
                Text(LoroNativeRichEmptyStatePresentation.promptText)
                    .font(.system(.body, design: .serif).italic())
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 19)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .writingSurface(isFocused: editorFocused)
    }

    private var loroPlainEditor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: Binding(
                get: { model.loroPlainDraft },
                set: { model.handleLoroPlainTextChange($0) }
            ))
            .font(.system(.body, design: .serif))
            .lineSpacing(6)
            .scrollContentBackground(.hidden)
            .focused($editorFocused)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .disabled(model.isEditorInputDisabled)
            .opacity(model.isEditorInputDisabled ? 0.6 : 1)
            .accessibilityLabel("Native Loro plain-text daily note")
            .accessibilityHint("Plain-text editing is available only while the saved Loro state remains current.")

            if model.loroPlainDraft.isEmpty {
                Text(LoroNativeRichEmptyStatePresentation.promptText)
                    .font(.system(.body, design: .serif).italic())
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 19)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .writingSurface(isFocused: editorFocused)
    }

    @ViewBuilder
    private var loroRichEditor: some View {
        if let state = model.loroRichEditorState {
            ZStack(alignment: .topLeading) {
                #if os(macOS)
                LoroNativeRichTextEditor(
                    state: state,
                    isEditable: !model.isEditorInputDisabled,
                    focusRequestGeneration: richEditorFocusGeneration,
                    onDocumentChange: { model.handleLoroRichDocumentChange($0) },
                    onSelectionChange: { model.handleLoroRichSelectionChange($0) },
                    onRejectedInput: { model.handleLoroRichRejectedInput($0) },
                    onFocusChange: { richEditorIsFocused = $0 },
                    onOpenReference: { onOpenReference?($0) }
                )
                #elseif os(iOS)
                LoroNativeRichTextEditorUIKit(
                    state: state,
                    isEditable: !model.isEditorInputDisabled,
                    focusRequestGeneration: richEditorFocusGeneration,
                    onDocumentChange: { model.handleLoroRichDocumentChange($0) },
                    onSelectionChange: { model.handleLoroRichSelectionChange($0) },
                    onRejectedInput: { model.handleLoroRichRejectedInput($0) },
                    onFocusChange: { richEditorIsFocused = $0 },
                    onOpenReference: { onOpenReference?($0) }
                )
                #endif
                if let prompt = LoroNativeRichEmptyStatePresentation(
                    baseDocument: state.document,
                    liveDraft: model.loroRichDraft
                ).prompt {
                    Text(prompt)
                        .font(.system(.body, design: .serif).italic())
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 19)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .writingSurface(isFocused: richEditorIsFocused)
            .accessibilityLabel("Native Loro rich-text daily note")
        } else {
            Text("Rich-text state is unavailable. Reload this page.")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        if let navigationMessage = DailyNoteNavigationProgressPresentation.message(
            isNavigating: model.isNavigating,
            status: model.status
        ) {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text(navigationMessage)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(navigationMessage)
            .accessibilityAddTraits(.updatesFrequently)
        } else if DailyNoteWritingPresentation.showsStatus(model.status), let accessibilityLabel = DailyNoteWritingPresentation.accessibilityLabel(for: model.status) {
            HStack(spacing: 6) {
                switch model.status {
                case .syncing:
                    ProgressView().controlSize(.small)
                    Text("Syncing…")
                case .pending(let message):
                    Label(message, systemImage: "clock.arrow.circlepath")
                        .foregroundStyle(.orange)
                case .conflict:
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text("Local changes need resolution")
                case .error(let message):
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(DailyNoteFailurePresentation.message(for: message))
                case .idle, .loading, .synced:
                    EmptyView()
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAddTraits(.updatesFrequently)
        }
    }
}

private extension View {
    func writingSurface(isFocused: Bool) -> some View {
        self
            .frame(minHeight: DailyNoteWritingPresentation.minimumEditorHeight)
            .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(
                        .secondary.opacity(DailyNoteWritingPresentation.borderOpacity(isFocused: isFocused)),
                        lineWidth: DailyNoteWritingPresentation.borderLineWidth(isFocused: isFocused)
                    )
            )
            .animation(.easeOut(duration: 0.18), value: isFocused)
    }
}

private struct StandupConfiguration {
    let backendURL: URL
    let workspaceId: EntityId
    let bearerCredential: String?
}
