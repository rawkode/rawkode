import Foundation
import SwiftUI
import AthenaeumDomain
import AthenaeumCore
import AthenaeumRPC

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

    static func shouldShowReviewAction(
        isToday: Bool,
        hasConfiguration: Bool,
        hasResolvedDailyNote: Bool,
        hasReviewCallback: Bool
    ) -> Bool {
        isToday && hasConfiguration && hasResolvedDailyNote && hasReviewCallback
    }
}

/// The compact Today cue may ask to return to the lower standup sub-document. The request carries
/// the resolved daily-note identity so a deferred accessibility focus can never land in a note
/// selected after the action.
enum DailyNoteStandupFocusPresentation {
    struct Request: Equatable {
        let generation: Int
        let dailyNoteId: EntityId
    }

    static func request(
        generation: Int,
        dailyNoteId: EntityId?,
        isToday: Bool,
        hasResolvedDailyNote: Bool
    ) -> Request? {
        guard isToday, hasResolvedDailyNote, let dailyNoteId else { return nil }
        return .init(generation: generation, dailyNoteId: dailyNoteId)
    }

    static func mayApply(
        _ request: Request,
        currentGeneration: Int,
        currentDailyNoteId: EntityId?,
        isToday: Bool,
        hasResolvedDailyNote: Bool
    ) -> Bool {
        request.generation == currentGeneration
            && request.dailyNoteId == currentDailyNoteId
            && isToday
            && hasResolvedDailyNote
    }
}

/// A deferred workforce reveal is accepted only when both the selected note and employee lane
/// generation still match. The target is checked again against live rows before focus is assigned.
struct WorkforceReviewRequest: Equatable, Sendable {
    let snapshot: WorkforceSnapshotIdentity
    let target: WorkforceAttentionAnchor
}

enum WorkforceReviewPresentation {
    static func mayApply(
        _ request: WorkforceReviewRequest,
        currentSnapshot: WorkforceSnapshotIdentity?,
        isToday: Bool,
        hasResolvedDailyNote: Bool,
        hasTarget: Bool
    ) -> Bool {
        isToday && hasResolvedDailyNote && hasTarget && currentSnapshot == request.snapshot
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

/// A deferred native reveal is valid only for the render generation and daily-note node that
/// received the authority-backed completion. The outer ScrollViewReader performs the actual
/// visual scroll; this value-only gate keeps a late layout callback from revealing another note.
enum DailyNotePreparationFocusPresentation {
    static func mayApply(
        requestGeneration: Int,
        currentGeneration: Int,
        requestDailyNoteId: EntityId,
        currentDailyNoteId: EntityId,
        hasTarget: Bool
    ) -> Bool {
        requestGeneration == currentGeneration
            && requestDailyNoteId == currentDailyNoteId
            && hasTarget
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

/// The field form can only be reached from an editor-issued command acknowledgement.  This
/// view-level witness adds the selected-note route to the editor's immutable command identity
/// before an asynchronous schema/fact load is allowed to present UI.
private struct PendingDailyNoteInlineSupertagFieldCapture: Equatable {
    let commandID: UUID
    let generation: Int
    let utf16Range: NSRange
    let reference: LoroCanonicalSemanticValueV1.InlineReference
    let dailyNoteID: EntityId
    let date: Date
    let operationGeneration: Int
    let presentation: AthenaeumViewModel.PagePresentation

    func matches(_ acknowledgement: LoroNativeRichTextInlineReferenceInsertionAcknowledgement) -> Bool {
        acknowledgement.commandID == commandID &&
            acknowledgement.generation == generation &&
            acknowledgement.utf16Range == utf16Range &&
            acknowledgement.trigger == .supertag &&
            acknowledgement.reference == reference
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
    private let onReviewWorkforcePublication: ((WorkforceAttentionAnchor) -> Void)?
    private let onFocusMeetingPreparation: ((LoroMeetingPreparationIdentity) -> Void)?
    private let onOpenReference: ((LoroCanonicalSemanticValueV1.InlineReference) -> Void)?
    private let mentionSearchClient: WorkspaceRPCClient?
    private let standupLifecycleDriver: DailyStandupLifecycleDriver
    /// DailyNote is the sole owner; standup detail/strip are passive observers.
    @StateObject private var dailyStandupModel: DailyStandupViewModel
    @State private var preparationNotice: String?
    @AccessibilityFocusState private var focusedMeetingPreparation: LoroMeetingPreparationIdentity?
    @State private var preparationFocusGeneration = 0
    @State private var standupFocusGeneration = 0
    @AccessibilityFocusState private var isStandupHeadingFocused: Bool
    @AccessibilityFocusState private var focusedWorkforceAnchor: WorkforceAttentionAnchor?
    @State private var pendingWorkforceReview: WorkforceReviewRequest?
    @State private var hasAutofocused = false
    /// TextKit rich editing crosses the SwiftUI/AppKit boundary. A generation lets the
    /// representable honor one request after its NSTextView has actually joined a window.
    @State private var richEditorFocusGeneration = 0
    /// Rich representables own the actual responder, so this state is presentation-only and is
    /// fed by their native focus callbacks rather than the plain-text FocusState binding.
    @State private var richEditorIsFocused = false
    @State private var richEditorSelection: LoroNativeRichTextSelection?
    @FocusState private var editorFocused: Bool
    @State private var restoreEditorFocusAfterSupertagMutation = false
    @State private var supertagFocusRouteID: EntityId?
    @State private var supertagFocusPresentation: AthenaeumViewModel.PagePresentation?
    @State private var supertagFocusSelection: LoroNativeRichTextSelection?
    @State private var richEditorFocusSelection: LoroNativeRichTextSelection?
    @StateObject private var mentionSearchModel: DailyNoteMentionSearchModel
    @State private var mentionContext: LoroNativeRichTextMentionContext?
    @State private var mentionInsertion: LoroNativeRichTextMentionInsertion?
    @StateObject private var supertagSearchModel: DailyNoteInlineSupertagSearchModel
    @State private var supertagContext: LoroNativeRichTextSupertagContext?
    @State private var supertagInsertion: LoroNativeRichTextSupertagInsertion?
    @State private var supertagSelectionInFlight = false
    @State private var pendingSupertagFieldCapture: PendingDailyNoteInlineSupertagFieldCapture?
    @State private var supertagFieldCapture: DailyNoteInlineSupertagFieldCapture?
    @State private var supertagFieldCaptureLoadCommandID: UUID?
    @State private var supertagFieldCaptureFocusWitness: DailyNoteInlineSupertagFieldCaptureFocusWitness?

    public init(model: AthenaeumViewModel) {
        self.model = model
        self.standupConfiguration = nil
        self.contextualView = nil
        self.onOpenEmployeeUpdate = nil
        self.onReviewStandup = nil
        self.onReviewWorkforcePublication = nil
        self.onFocusMeetingPreparation = nil
        self.onOpenReference = nil
        self.mentionSearchClient = nil
        self.standupLifecycleDriver = .live
        _dailyStandupModel = StateObject(wrappedValue: .init(ledgerLoader: nil, employeeLoader: nil))
        _mentionSearchModel = StateObject(wrappedValue: .init(client: nil))
        _supertagSearchModel = StateObject(wrappedValue: .init(client: nil))
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
        onReviewWorkforcePublication: ((WorkforceAttentionAnchor) -> Void)? = nil,
        onFocusMeetingPreparation: ((LoroMeetingPreparationIdentity) -> Void)? = nil,
        onOpenReference: ((LoroCanonicalSemanticValueV1.InlineReference) -> Void)? = nil,
        mentionSearchClient: WorkspaceRPCClient? = nil,
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
        self.onReviewWorkforcePublication = onReviewWorkforcePublication
        self.onFocusMeetingPreparation = onFocusMeetingPreparation
        self.onOpenReference = onOpenReference
        self.mentionSearchClient = mentionSearchClient
        self.standupLifecycleDriver = standupLifecycleDriver
        _dailyStandupModel = StateObject(wrappedValue: .init(
            backendURL: standupBackendURL,
            workspaceId: standupWorkspaceId,
            bearerCredential: standupBearerCredential,
            dailyNoteId: model.dailyNoteId,
            includeLedger: true
        ))
        _mentionSearchModel = StateObject(wrappedValue: .init(client: mentionSearchClient))
        _supertagSearchModel = StateObject(wrappedValue: .init(client: mentionSearchClient))
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            noteHeader

            // Today attention is deliberately the first operational context after the note
            // heading; the full historical/publication detail remains below the editor.
            if isToday, standupConfiguration != nil {
                WorkforceAttentionStrip(
                    model: dailyStandupModel,
                    onReviewStandup: hasResolvedDailyNote ? reviewStandup : nil,
                    onReviewPublication: reviewWorkforcePublication,
                    onRetry: refreshStandup
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
                    planTodayStarter
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
                if model.isDailyNoteSupertagAssignmentEligible {
                    DailyNoteSupertagAssignmentView(
                        model: model,
                        onWillAssign: captureSupertagEditorFocus
                    )
                }
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
                        isHeadingFocused: $isStandupHeadingFocused,
                        focusedWorkforceAnchor: $focusedWorkforceAnchor,
                        onRefresh: refreshStandup
                    )
                    .id(DailyNoteStandupPresentation.anchorID)
                    .id(WorkforceAttentionAnchor.standup)
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
            if case .synced = status {
                // Keep a pending row request only while the resolved note remains current.
            } else {
                clearWorkforceReview()
            }
            switch status {
            case .loading, .error(_):
                // A note transition invalidates any deferred standup focus just as it
                // invalidates the editor focus request. Keep VoiceOver from landing on a
                // heading that no longer belongs to the resolved note.
                isStandupHeadingFocused = false
                standupFocusGeneration += 1
                preparationFocusGeneration += 1
            default:
                break
            }
            guard case .synced = status else { return }
            focusEditorIfNeeded()
        }
        .onChange(of: model.pagePresentation) { presentation in
            dismissMentionPicker(restoringSupertagFieldFocus: false)
            if presentation != .automergeEditable && presentation != .loroPlainEditable && presentation != .loroRichEditable {
                clearEditorFocus()
                hasAutofocused = false
                clearSupertagEditorFocusWitness()
                richEditorFocusSelection = nil
            } else {
                // A format transition replaces the underlying editing control. Let that control
                // receive its own first-focus request instead of retaining the prior editor's.
                hasAutofocused = false
                focusEditorIfNeeded()
            }
        }
        .onChange(of: model.selectedDate) { _ in
            clearEditorFocus()
            clearWorkforceReview()
            clearSupertagEditorFocusWitness()
            isStandupHeadingFocused = false
            standupFocusGeneration += 1
            preparationFocusGeneration += 1
            hasAutofocused = false
            preparationNotice = nil
            dismissMentionPicker(restoringSupertagFieldFocus: false)
        }
        .onChange(of: supertagFieldCapture) { capture in
            guard capture == nil else { return }
            // A click outside a platform popover can bypass the form's disabled Done button.
            // Keep the exact capture alive while it owns an ambiguous addFact retry; a new `#`
            // acknowledgement is separately rejected by the model's route-scoped custody gate.
            if let captureID = supertagFieldCaptureFocusWitness?.commandID,
               let retained = model.retainedDailyNoteInlineSupertagFieldCaptureRequiringResolution(
                captureID: captureID
               ) {
                supertagFieldCapture = retained
                return
            }
            restoreEditorFocusAfterSupertagFieldCaptureDismissal()
        }
        .onChange(of: dailyStandupModel.employeeLoadGeneration) { _ in
            // Refreshing the same note is still a new snapshot; never let an old row focus after
            // the employee lane has been invalidated.
            clearWorkforceReview()
        }
        .onChange(of: dailyStandupModel.employeeState) { state in
            switch state {
            case .loading, .failed, .idle:
                clearWorkforceReview()
            case .loaded(let publications):
                if let pendingWorkforceReview,
                   case .publication(let publicationId) = pendingWorkforceReview.target,
                   !publications.contains(where: { $0.id == publicationId }) {
                    clearWorkforceReview()
                }
            }
        }
        .onChange(of: model.isDailyNoteSupertagMutationInFlight) { inFlight in
            if inFlight {
                // The menu action captures this witness synchronously before the task starts. A
                // fallback keeps programmatic callers safe, but never replaces an already-captured
                // witness after the menu has changed responder state.
                if supertagFocusRouteID == nil {
                    captureSupertagEditorFocus()
                }
            } else {
                guard restoreEditorFocusAfterSupertagMutation,
                      supertagFocusRouteID == model.dailyNoteId,
                      supertagFocusPresentation == model.pagePresentation,
                      model.isDailyNoteSupertagAssignmentEligible else {
                    clearSupertagEditorFocusWitness()
                    return
                }
                let selection = supertagFocusSelection
                restoreEditorFocusAfterSupertagMutation = false
                richEditorFocusSelection = selection
                Task { @MainActor in
                    await Task.yield()
                    guard supertagFocusRouteID == model.dailyNoteId,
                          supertagFocusPresentation == model.pagePresentation else { return }
                    if model.pagePresentation == .loroRichEditable {
                        richEditorFocusGeneration += 1
                    } else {
                        editorFocused = true
                    }
                    clearSupertagEditorFocusWitness()
                }
            }
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

    private func reviewStandup() {
        guard let onReviewStandup else { return }
        standupFocusGeneration += 1
        guard let request = DailyNoteStandupFocusPresentation.request(
            generation: standupFocusGeneration,
            dailyNoteId: model.dailyNoteId,
            isToday: isToday,
            hasResolvedDailyNote: hasResolvedDailyNote
        ) else { return }

        // The command center scrolls synchronously. Yield once so its target is laid out before
        // VoiceOver moves to the existing standup heading.
        onReviewStandup()
        Task { @MainActor in
            await Task.yield()
            guard DailyNoteStandupFocusPresentation.mayApply(
                request,
                currentGeneration: standupFocusGeneration,
                currentDailyNoteId: model.dailyNoteId,
                isToday: isToday,
                hasResolvedDailyNote: hasResolvedDailyNote
            ) else { return }
            isStandupHeadingFocused = true
        }
    }

    private func reviewWorkforcePublication(
        publicationId: EntityId,
        snapshot: WorkforceSnapshotIdentity
    ) {
        guard let onReviewWorkforcePublication,
              let currentSnapshot = dailyStandupModel.workforceSnapshotIdentity,
              currentSnapshot == snapshot,
              isToday,
              hasResolvedDailyNote,
              case .loaded(let publications) = dailyStandupModel.employeeState,
              publications.contains(where: { $0.id == publicationId }) else {
            clearWorkforceReview()
            return
        }

        let request = WorkforceReviewRequest(
            snapshot: snapshot,
            target: .publication(publicationId)
        )
        pendingWorkforceReview = request
        onReviewWorkforcePublication(request.target)
        Task { @MainActor in
            // Let the outer ScrollViewReader perform its typed scroll before asking VoiceOver to
            // move to the exact lower row.
            await Task.yield()
            guard WorkforceReviewPresentation.mayApply(
                request,
                currentSnapshot: dailyStandupModel.workforceSnapshotIdentity,
                isToday: isToday,
                hasResolvedDailyNote: hasResolvedDailyNote,
                hasTarget: workforcePublicationIsPresent(publicationId)
            ) else {
                clearWorkforceReview()
                return
            }
            pendingWorkforceReview = nil
            focusedWorkforceAnchor = request.target
        }
    }

    private func workforcePublicationIsPresent(_ publicationId: EntityId) -> Bool {
        guard case .loaded(let publications) = dailyStandupModel.employeeState else { return false }
        return publications.contains(where: { $0.id == publicationId })
    }

    private func clearWorkforceReview() {
        pendingWorkforceReview = nil
        focusedWorkforceAnchor = nil
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
            richEditorFocusSelection = nil
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

    private func dismissMentionPicker(restoringSupertagFieldFocus: Bool = true) {
        mentionContext = nil
        mentionInsertion = nil
        supertagContext = nil
        supertagInsertion = nil
        supertagSelectionInFlight = false
        pendingSupertagFieldCapture = nil
        supertagFieldCapture = nil
        supertagFieldCaptureLoadCommandID = nil
        if !restoringSupertagFieldFocus {
            supertagFieldCaptureFocusWitness = nil
        }
    }

    /// The editor already owns the scalar selection it rendered for the inserted reference. Do
    /// not reconstruct that selection from the acknowledgement's UTF-16 range (which can split
    /// grapheme clusters); a nil selection request deliberately asks the native adapter to retain
    /// its authoritative current selection while regaining first responder.
    private func restoreEditorFocusAfterSupertagFieldCaptureDismissal() {
        guard let witness = supertagFieldCaptureFocusWitness else { return }
        supertagFieldCaptureFocusWitness = nil
        guard witness.permitsRestoration(
            hasResolvedDailyNote: hasResolvedDailyNote,
            dailyNoteID: model.dailyNoteId,
            selectedDate: model.selectedDate,
            operationGeneration: model.dailyNoteOperationGeneration,
            presentation: model.pagePresentation,
            isEditorInputDisabled: model.isEditorInputDisabled
        ) else { return }

        richEditorFocusSelection = nil
        Task { @MainActor in
            // Let the popover relinquish first responder before requesting it for the same
            // editor. Recheck the complete route witness after this suspension.
            await Task.yield()
            guard supertagFieldCapture == nil,
                  witness.permitsRestoration(
                    hasResolvedDailyNote: hasResolvedDailyNote,
                    dailyNoteID: model.dailyNoteId,
                    selectedDate: model.selectedDate,
                    operationGeneration: model.dailyNoteOperationGeneration,
                    presentation: model.pagePresentation,
                    isEditorInputDisabled: model.isEditorInputDisabled
                  ) else { return }
            richEditorFocusGeneration += 1
        }
    }

    /// Captures the editor's presentation witness before a note-level menu command can toggle
    /// `isEditable` or move first responder to the menu. Native rich adapters report their last
    /// scalar selection; their controllers keep that selection through a disabled interval and
    /// restore it when this exact route receives the focus request again.
    private func captureSupertagEditorFocus() {
        guard model.isDailyNoteSupertagAssignmentEligible else { return }
        restoreEditorFocusAfterSupertagMutation = editorFocused || richEditorIsFocused
        supertagFocusRouteID = model.dailyNoteId
        supertagFocusPresentation = model.pagePresentation
        supertagFocusSelection = richEditorSelection
    }

    private func clearSupertagEditorFocusWitness() {
        restoreEditorFocusAfterSupertagMutation = false
        supertagFocusRouteID = nil
        supertagFocusPresentation = nil
        supertagFocusSelection = nil
    }

    private func consumePreparationCompletion() {
        guard let completion = model.consumePreparationCompletion(),
              completion.dailyNoteId == model.dailyNoteId,
              let identity = LoroMeetingPreparationIdentity(
                localDate: completion.localDate.rawValue,
                occurrenceKey: completion.occurrenceKey
              )
        else { return }
        preparationNotice = DailyNotePreparationAnnouncementPresentation.message
        let expectedNodeId = model.dailyNoteId
        let expectedGeneration = preparationFocusGeneration
        if pageContainsMeetingPreparation(identity) {
            Task { @MainActor in
                await Task.yield()
                guard DailyNotePreparationFocusPresentation.mayApply(
                    requestGeneration: expectedGeneration,
                    currentGeneration: preparationFocusGeneration,
                    requestDailyNoteId: expectedNodeId,
                    currentDailyNoteId: model.dailyNoteId,
                    hasTarget: pageContainsMeetingPreparation(identity)
                ) else { return }
                onFocusMeetingPreparation?(identity)
                guard DailyNotePreparationFocusPresentation.mayApply(
                    requestGeneration: expectedGeneration,
                    currentGeneration: preparationFocusGeneration,
                    requestDailyNoteId: expectedNodeId,
                    currentDailyNoteId: model.dailyNoteId,
                    hasTarget: pageContainsMeetingPreparation(identity)
                ) else { return }
                focusedMeetingPreparation = identity
            }
        }
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
            reviewStandupButton
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
            reviewStandupButton
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

    @ViewBuilder
    private var reviewStandupButton: some View {
        if DailyNoteStandupPresentation.shouldShowReviewAction(
            isToday: isToday,
            hasConfiguration: standupConfiguration != nil,
            hasResolvedDailyNote: hasResolvedDailyNote,
            hasReviewCallback: onReviewStandup != nil
        ) {
            Button(WorkforceAttentionLayout.reviewStandupTitle, action: reviewStandup)
                .buttonStyle(.borderless)
                .accessibilityHint("Returns to the daily standup in this note.")
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
        case .meetingPreparation(let identity, let children):
            return AnyView(VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(children.enumerated()), id: \.offset) { _, child in loroProjection(child) }
            }
            .id(identity)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Prepared meeting context")
            .accessibilityFocused($focusedMeetingPreparation, equals: identity))
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

    private func pageContainsMeetingPreparation(_ identity: LoroMeetingPreparationIdentity) -> Bool {
        guard case .loroProjectedReadOnly(let state) = model.pagePresentation else { return false }
        return containsMeetingPreparation(identity, in: state.projection.root)
    }

    private func containsMeetingPreparation(_ identity: LoroMeetingPreparationIdentity, in node: LoroPageProjectionNode) -> Bool {
        switch node {
        case .meetingPreparation(let candidate, let children):
            return candidate == identity || children.contains { containsMeetingPreparation(identity, in: $0) }
        case .document(let children), .paragraph(let children), .heading(_, let children):
            return children.contains { containsMeetingPreparation(identity, in: $0) }
        case .text, .unsupported:
            return false
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
    private var planTodayStarter: some View {
        if model.isPlanTodayStarterAvailable {
            Button {
                guard model.applyPlanTodayStarter() else { return }
                dismissMentionPicker()
                richEditorFocusSelection = .init(
                    location: LoroNativePlanTodayStarter.firstPriorityScalarFocusLocation,
                    length: 0
                )
                richEditorFocusGeneration += 1
            } label: {
                Label("Plan today", systemImage: "checklist")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityHint("Adds Focus, three priorities, and Notes to this otherwise empty daily note.")
        }
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
                    focusRequestSelection: richEditorFocusSelection,
                    mentionInsertion: mentionInsertion,
                    supertagInsertion: supertagInsertion,
                    taskToggleAcknowledgement: model.loroRichTaskToggleAcknowledgement,
                    onDocumentChange: { model.handleLoroRichDocumentChange($0) },
                    onTaskToggle: { model.handleLoroRichTaskToggle($0) },
                    onSelectionChange: {
                        richEditorSelection = $0
                        model.handleLoroRichSelectionChange($0)
                    },
                    onRejectedInput: { model.handleLoroRichRejectedInput($0) },
                    onFocusChange: { richEditorIsFocused = $0 },
                    onOpenReference: { onOpenReference?($0) },
                    onMentionQueryChange: handleMentionQueryChange,
                    onSupertagQueryChange: handleSupertagQueryChange,
                    onInlineReferenceInserted: handleInlineReferenceInserted
                )
                #elseif os(iOS)
                LoroNativeRichTextEditorUIKit(
                    state: state,
                    isEditable: !model.isEditorInputDisabled,
                    focusRequestGeneration: richEditorFocusGeneration,
                    focusRequestSelection: richEditorFocusSelection,
                    mentionInsertion: mentionInsertion,
                    supertagInsertion: supertagInsertion,
                    taskToggleAcknowledgement: model.loroRichTaskToggleAcknowledgement,
                    onDocumentChange: { model.handleLoroRichDocumentChange($0) },
                    onTaskToggle: { model.handleLoroRichTaskToggle($0) },
                    onSelectionChange: {
                        richEditorSelection = $0
                        model.handleLoroRichSelectionChange($0)
                    },
                    onRejectedInput: { model.handleLoroRichRejectedInput($0) },
                    onFocusChange: { richEditorIsFocused = $0 },
                    onOpenReference: { onOpenReference?($0) },
                    onMentionQueryChange: handleMentionQueryChange,
                    onSupertagQueryChange: handleSupertagQueryChange,
                    onInlineReferenceInserted: handleInlineReferenceInserted
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
            .popover(item: $mentionContext) { context in
                DailyNoteMentionPicker(
                    context: context,
                    model: mentionSearchModel,
                    onSelect: { candidate in
                        mentionInsertion = .init(
                            generation: context.generation,
                            utf16Range: context.utf16Range,
                            reference: candidate.reference
                        )
                    },
                    onDismiss: { dismissMentionPicker() }
                )
            }
            .popover(item: $supertagContext) { context in
                DailyNoteInlineSupertagPicker(
                    context: context,
                    model: supertagSearchModel,
                    isApplying: supertagSelectionInFlight,
                    onSelect: { candidate in
                        selectInlineSupertag(candidate, context: context)
                    },
                    onDismiss: { dismissMentionPicker() }
                )
            }
            .popover(item: $supertagFieldCapture) { capture in
                DailyNoteInlineSupertagFieldCaptureView(
                    model: model,
                    capture: capture,
                    activeCapture: $supertagFieldCapture
                )
            }
        } else {
            Text("Rich-text state is unavailable. Reload this page.")
                .foregroundStyle(.secondary)
        }
    }

    private func handleMentionQueryChange(_ context: LoroNativeRichTextMentionContext?) {
        guard mentionSearchClient != nil else {
            mentionContext = nil
            mentionInsertion = nil
            return
        }
        if context == nil {
            mentionInsertion = nil
        }
        mentionContext = context
    }

    private func handleSupertagQueryChange(_ context: LoroNativeRichTextSupertagContext?) {
        guard mentionSearchClient != nil else {
            supertagContext = nil
            supertagInsertion = nil
            return
        }
        if context == nil {
            supertagInsertion = nil
        } else if pendingSupertagFieldCapture != nil {
            // A replacement trigger is a new editor command context, never a continuation of a
            // prior picker selection that merely shared a visible range.
            pendingSupertagFieldCapture = nil
        }
        supertagContext = context
    }

    /// The adapter has already rendered the typed chip and delivered the resulting semantic
    /// document. This final host fence binds that acknowledgement to the selected daily-note
    /// route before a suspended effective-field/current-fact read may surface capture UI.
    private func handleInlineReferenceInserted(
        _ acknowledgement: LoroNativeRichTextInlineReferenceInsertionAcknowledgement
    ) {
        guard supertagFieldCaptureLoadCommandID == nil,
              let pending = pendingSupertagFieldCapture,
              pending.matches(acknowledgement),
              isCurrentSupertagFieldCaptureRoute(pending)
        else { return }

        supertagInsertion = nil
        pendingSupertagFieldCapture = nil
        supertagFieldCaptureLoadCommandID = acknowledgement.commandID
        Task { @MainActor in
            let capture = await model.prepareDailyNoteInlineSupertagFieldCapture(
                acknowledgement: acknowledgement
            )
            guard supertagFieldCaptureLoadCommandID == acknowledgement.commandID else { return }
            supertagFieldCaptureLoadCommandID = nil
            guard isCurrentSupertagFieldCaptureRoute(pending),
                  let capture,
                  capture.commandID == acknowledgement.commandID,
                  capture.tagID == acknowledgement.reference.id
            else { return }
            // Empty schemas return nil from the model, which intentionally skips this popover
            // and any capture-specific focus choreography.
            supertagFieldCaptureFocusWitness = .init(
                commandID: acknowledgement.commandID,
                dailyNoteID: pending.dailyNoteID,
                date: pending.date,
                operationGeneration: pending.operationGeneration,
                presentation: pending.presentation
            )
            supertagFieldCapture = capture
        }
    }

    private func isCurrentSupertagFieldCaptureRoute(
        _ pending: PendingDailyNoteInlineSupertagFieldCapture
    ) -> Bool {
        hasResolvedDailyNote &&
            model.dailyNoteId == pending.dailyNoteID &&
            model.selectedDate == pending.date &&
            model.dailyNoteOperationGeneration == pending.operationGeneration &&
            model.pagePresentation == pending.presentation &&
            model.pagePresentation == .loroRichEditable &&
            !model.isEditorInputDisabled
    }

    /// Resolves an inline `#` reference through the same authoritative membership route as the
    /// direct note picker. The editor is temporarily disabled while an unassigned tag is applied;
    /// only the freshly republished trigger context may then receive the typed reference.
    private func selectInlineSupertag(
        _ candidate: DailyNoteInlineSupertagCandidate,
        context: LoroNativeRichTextSupertagContext
    ) {
        guard !supertagSelectionInFlight,
              context.trigger == .supertag,
              hasResolvedDailyNote,
              case .loroRichEditable = model.pagePresentation,
              !model.isEditorInputDisabled else { return }

        supertagSelectionInFlight = true
        let expectedNoteId = model.dailyNoteId
        let expectedDate = model.selectedDate
        let expectedOperationGeneration = model.dailyNoteOperationGeneration
        let expectedPresentation = model.pagePresentation
        Task { @MainActor in
            defer { supertagSelectionInFlight = false }
            guard model.dailyNoteId == expectedNoteId,
                  model.selectedDate == expectedDate,
                  model.dailyNoteOperationGeneration == expectedOperationGeneration,
                  model.pagePresentation == expectedPresentation,
                  !model.isEditorInputDisabled else { return }

            // Refresh the membership decision immediately before applying. The picker catalog is
            // intentionally independent, so a concurrent direct-picker change cannot be trusted.
            await model.refreshDailyNoteSupertags(allowDirtyRichDraft: true)
            guard model.dailyNoteId == expectedNoteId,
                  model.selectedDate == expectedDate,
                  model.dailyNoteOperationGeneration == expectedOperationGeneration,
                  model.pagePresentation == expectedPresentation,
                  let membership = model.isDailyNoteSupertagApplied(tagId: candidate.id.rawValue) else {
                model.resumeLoroRichDraftSubmissionIfNeeded()
                return
            }
            let requiresFreshGeneration = !membership

            if !membership {
                guard await model.applyDailyNoteSupertag(
                    tagId: candidate.id.rawValue,
                    allowDirtyRichDraft: true
                ) else {
                    model.resumeLoroRichDraftSubmissionIfNeeded()
                    return
                }
            }

            guard model.dailyNoteId == expectedNoteId,
                  model.selectedDate == expectedDate,
                  model.dailyNoteOperationGeneration == expectedOperationGeneration,
                  model.pagePresentation == expectedPresentation else {
                model.resumeLoroRichDraftSubmissionIfNeeded()
                return
            }

            guard let liveContext = await waitForLiveSupertagContext(
                matching: context,
                requiresFreshGeneration: requiresFreshGeneration,
                expectedNoteId: expectedNoteId,
                expectedDate: expectedDate,
                expectedOperationGeneration: expectedOperationGeneration,
                expectedPresentation: expectedPresentation
            ) else {
                model.resumeLoroRichDraftSubmissionIfNeeded()
                return
            }

            // The wait returns to the main actor, but the route can still have changed while it
            // was suspended. Recheck the complete immutable witness immediately before publishing
            // the insertion so a delayed selection fails closed instead of targeting a new note.
            guard model.dailyNoteId == expectedNoteId,
                  model.selectedDate == expectedDate,
                  model.dailyNoteOperationGeneration == expectedOperationGeneration,
                  model.pagePresentation == expectedPresentation,
                  supertagContext == liveContext else {
                model.resumeLoroRichDraftSubmissionIfNeeded()
                return
            }

            supertagContext = nil
            let insertion = LoroNativeRichTextSupertagInsertion(
                generation: liveContext.generation,
                utf16Range: liveContext.utf16Range,
                reference: candidate.reference,
                trigger: .supertag
            )
            // Do not start schema/fact reads from this picker result. The matching immutable
            // command acknowledgement arrives only after the editor has rendered/published it.
            pendingSupertagFieldCapture = .init(
                commandID: insertion.commandID,
                generation: insertion.generation,
                utf16Range: insertion.utf16Range,
                reference: insertion.reference,
                dailyNoteID: expectedNoteId,
                date: expectedDate,
                operationGeneration: expectedOperationGeneration,
                presentation: expectedPresentation
            )
            supertagInsertion = insertion
        }
    }

    private func waitForLiveSupertagContext(
        matching expected: LoroNativeRichTextSupertagContext,
        requiresFreshGeneration: Bool,
        expectedNoteId: EntityId,
        expectedDate: Date,
        expectedOperationGeneration: Int,
        expectedPresentation: AthenaeumViewModel.PagePresentation
    ) async -> LoroNativeRichTextSupertagContext? {
        for _ in 0..<80 {
            guard !Task.isCancelled,
                  hasResolvedDailyNote,
                  model.dailyNoteId == expectedNoteId,
                  model.selectedDate == expectedDate,
                  model.dailyNoteOperationGeneration == expectedOperationGeneration,
                  model.pagePresentation == expectedPresentation,
                  model.pagePresentation == .loroRichEditable else { return nil }
            if let current = supertagContext,
               current.trigger == .supertag,
               current.query == expected.query,
               current.utf16Range == expected.utf16Range,
               current.selection == expected.selection,
               (!requiresFreshGeneration || current.generation > expected.generation) {
                return current
            }
            try? await Task.sleep(nanoseconds: 12_500_000)
        }
        return nil
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
