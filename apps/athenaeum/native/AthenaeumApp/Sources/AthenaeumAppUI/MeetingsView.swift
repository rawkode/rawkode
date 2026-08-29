import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

/// Native read-only meeting review surface. Capture and transcription remain owned by the native
/// audio pipeline; this view gives the user a calm inbox for the resulting meeting records and
/// transcripts, matching the web review path without introducing another recording mechanism.
@MainActor
final class MeetingsViewModel: ObservableObject {
    struct MeetingDetail: Equatable {
        let meeting: RPCMeeting
        let segments: [RPCTranscriptSegmentRecord]
        let speakers: [RPCSpeaker]
    }

    @Published private(set) var meetings: [RPCMeeting] = []
    @Published private(set) var selectedDetail: MeetingDetail?
    @Published private(set) var isLoading = false
    @Published private(set) var hasLoadedMeetings = false
    @Published private(set) var isLoadingDetail = false
    @Published var errorMessage: String?
    @Published var detailErrorMessage: String?

    private let client: WorkspaceRPCClient

    init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
    }

    /// Test-only construction seam: production continues to resolve its workspace-scoped client
    /// above, while focused lifecycle tests exercise the exact meeting-list read protocol.
    init(client: WorkspaceRPCClient) {
        self.client = client
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await client.listMeetings()
            meetings = loaded.sorted { $0.startedAt > $1.startedAt }
            hasLoadedMeetings = true
            errorMessage = nil
        } catch {
            errorMessage = Self.meetingsLoadFailureMessage(for: error)
        }
    }

    func select(_ meetingId: String) async {
        isLoadingDetail = true
        detailErrorMessage = nil
        defer { isLoadingDetail = false }
        do {
            let detail = try await client.getMeeting(meetingId: meetingId)
            selectedDetail = MeetingDetail(meeting: detail.meeting, segments: detail.segments, speakers: detail.speakers)
        } catch {
            selectedDetail = nil
            detailErrorMessage = Self.transcriptLoadFailureMessage(for: error)
        }
    }

    /// Read failures can include backend or credential-adjacent details. Keep the existing refresh
    /// and selection controls as the safe recovery path without exposing those details.
    static func meetingsLoadFailureMessage(for _: Error) -> String {
        "Meetings couldn’t be loaded. Nothing has been changed. Refresh to check your meetings again."
    }

    static func transcriptLoadFailureMessage(for _: Error) -> String {
        "This transcript couldn’t be loaded. Nothing has been changed. Retry this transcript or refresh your meetings."
    }

    /// An empty catalog is meaningful only after a successful list read. Before the initial
    /// request resolves, or after a failed request, the user must not be directed to capture based
    /// on an unknown meeting list.
    static func shouldShowEmptyMeetings(
        isEmpty: Bool,
        hasLoadedMeetings: Bool,
        isLoading: Bool,
        errorMessage: String?
    ) -> Bool {
        isEmpty && hasLoadedMeetings && !isLoading && errorMessage == nil
    }

    /// Show a first-resolution progress state instead of the successful-empty voice-capture CTA.
    /// Later refreshes retain the current list while the existing header communicates progress.
    static func shouldShowMeetingsLoading(
        hasLoadedMeetings: Bool,
        isLoading: Bool,
        errorMessage: String?
    ) -> Bool {
        !hasLoadedMeetings && (isLoading || errorMessage == nil)
    }

    /// An inline retry is useful only after a failed list read has completed. During a refresh the
    /// existing loading state takes over, so the action cannot imply that the meeting history is
    /// empty.
    static func shouldShowMeetingsRetry(errorMessage: String?, isLoading: Bool) -> Bool {
        errorMessage != nil && !isLoading
    }

    /// A detail retry is meaningful only for an existing selected meeting and must not compete
    /// with an in-flight detail read.
    static func canRetryTranscript(meetingId: String?, isLoadingDetail: Bool) -> Bool {
        meetingId != nil && !isLoadingDetail
    }

    static func formatOffset(_ milliseconds: Int) -> String {
        let totalSeconds = max(0, milliseconds) / 1000
        return "\(totalSeconds / 60):\(String(format: "%02d", totalSeconds % 60))"
    }

    static func formatDate(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: value) ?? {
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }()
        guard let date else { return value }
        return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
    }
}

/// Transcript reads are immutable, but a rapid second selection can still publish after the
/// first. Keep that single-flight interaction state in `MeetingsView` so the transcript remains
/// aligned with the highlighted meeting without changing the read model or RPC contract.
enum MeetingTranscriptSelectionPresentation {
    static func canStartSelection(pendingMeetingId: String?) -> Bool {
        pendingMeetingId == nil
    }

    static func pendingMeetingId(afterCompleting meetingId: String, pendingMeetingId: String?) -> String? {
        pendingMeetingId == meetingId ? nil : pendingMeetingId
    }
}

/// The meeting list read remains model-owned; this claim only rejects rapid UI activations before
/// the model's asynchronous loading publication can update the view.
enum MeetingsListRefreshPresentation {
    static func canStartRefresh(isRefreshInFlight: Bool) -> Bool {
        !isRefreshInFlight
    }

    static func isLoading(isModelLoading: Bool, isRefreshInFlight: Bool) -> Bool {
        isModelLoading || isRefreshInFlight
    }
}

public struct MeetingsView: View {
    @StateObject private var model: MeetingsViewModel
    @State private var selectedMeetingId: String?
    @State private var pendingTranscriptSelectionMeetingId: String?
    @State private var isListRefreshInFlight = false
    private let onOpenVoice: (() -> Void)?

    public init(
        backendURL: URL,
        workspaceId: EntityId,
        bearerCredential: String?,
        onOpenVoice: (() -> Void)? = nil
    ) {
        self.onOpenVoice = onOpenVoice
        _model = StateObject(
            wrappedValue: MeetingsViewModel(backendURL: backendURL, workspaceId: workspaceId, bearerCredential: bearerCredential)
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Recorded work")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Meetings")
                        .font(.title2.bold())
                }
                Spacer()
                Button {
                    startListRefresh()
                } label: {
                    Label(isLoadingMeetings ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(isLoadingMeetings)
            }

            Text("Review the transcripts produced by native capture and connect the conversation back to your typed brain.")
                .font(.callout)
                .foregroundStyle(.secondary)

            if let error = model.errorMessage {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Meetings are unavailable", systemImage: "exclamationmark.triangle")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                    if MeetingsViewModel.shouldShowMeetingsRetry(
                        errorMessage: model.errorMessage,
                        isLoading: isLoadingMeetings
                    ) {
                        Button("Retry") { startListRefresh() }
                            .accessibilityHint("Retries loading your meeting history.")
                    }
                }
            }

            if MeetingsViewModel.shouldShowMeetingsLoading(
                hasLoadedMeetings: model.hasLoadedMeetings,
                isLoading: isLoadingMeetings,
                errorMessage: model.errorMessage
            ) {
                ProgressView("Loading meetings…")
                    .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
            } else if MeetingsViewModel.shouldShowEmptyMeetings(
                isEmpty: model.meetings.isEmpty,
                hasLoadedMeetings: model.hasLoadedMeetings,
                isLoading: isLoadingMeetings,
                errorMessage: model.errorMessage
            ) {
                MeetingsEmptyState(onOpenVoice: onOpenVoice)
            } else {
                HStack(alignment: .top, spacing: 20) {
                    meetingList
                        .frame(minWidth: 260, maxWidth: 340, alignment: .leading)
                    Divider()
                    transcriptDetail
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
        }
        .padding()
        .task { await refreshListOnAppear() }
    }

    private var isLoadingMeetings: Bool {
        MeetingsListRefreshPresentation.isLoading(
            isModelLoading: model.isLoading,
            isRefreshInFlight: isListRefreshInFlight
        )
    }

    private func startListRefresh() {
        guard beginListRefresh() else { return }
        Task { @MainActor in
            await completeListRefresh()
        }
    }

    private func refreshListOnAppear() async {
        guard beginListRefresh() else { return }
        await completeListRefresh()
    }

    private func beginListRefresh() -> Bool {
        guard MeetingsListRefreshPresentation.canStartRefresh(
            isRefreshInFlight: isListRefreshInFlight
        ) else {
            return false
        }
        isListRefreshInFlight = true
        return true
    }

    private func completeListRefresh() async {
        defer { isListRefreshInFlight = false }
        await model.refresh()
    }

    private var meetingList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Recent meetings")
                .font(.headline)
            ForEach(model.meetings, id: \.id) { meeting in
                let isLoadingThisMeeting = pendingTranscriptSelectionMeetingId == meeting.id
                Button {
                    selectTranscript(meeting.id)
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Image(systemName: meeting.endedAt == nil ? "record.circle" : "waveform")
                                .foregroundStyle(meeting.endedAt == nil ? .orange : .secondary)
                            Text(meeting.title)
                                .font(.body.weight(.semibold))
                                .lineLimit(2)
                        }
                        Text(MeetingsViewModel.formatDate(meeting.startedAt) + (meeting.endedAt == nil ? " · In progress" : ""))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if isLoadingThisMeeting {
                            Text("Loading…")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 7)
                    .padding(.horizontal, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!MeetingTranscriptSelectionPresentation.canStartSelection(pendingMeetingId: pendingTranscriptSelectionMeetingId))
                .background(selectedMeetingId == meeting.id ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 7))
            }
        }
    }

    @ViewBuilder
    private var transcriptDetail: some View {
        if model.isLoadingDetail {
            ProgressView("Loading transcript…")
                .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        } else if let error = model.detailErrorMessage {
            VStack(alignment: .leading, spacing: 8) {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                if let meetingId = selectedMeetingId,
                   MeetingsViewModel.canRetryTranscript(
                       meetingId: meetingId,
                       isLoadingDetail: model.isLoadingDetail
                   ) {
                    Button("Retry transcript") {
                        selectTranscript(meetingId)
                    }
                    .buttonStyle(.bordered)
                    .disabled(!MeetingTranscriptSelectionPresentation.canStartSelection(pendingMeetingId: pendingTranscriptSelectionMeetingId))
                    .accessibilityHint("Retries loading the selected meeting transcript.")
                }
            }
        } else if let detail = model.selectedDetail {
            TranscriptDetail(detail: detail)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: "text.quote")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text("Select a meeting")
                    .font(.headline)
                Text("Its transcript and speaker context will appear here.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        }
    }

    private func selectTranscript(_ meetingId: String) {
        guard MeetingTranscriptSelectionPresentation.canStartSelection(
            pendingMeetingId: pendingTranscriptSelectionMeetingId
        ) else {
            return
        }

        selectedMeetingId = meetingId
        pendingTranscriptSelectionMeetingId = meetingId
        Task {
            await model.select(meetingId)
            pendingTranscriptSelectionMeetingId = MeetingTranscriptSelectionPresentation.pendingMeetingId(
                afterCompleting: meetingId,
                pendingMeetingId: pendingTranscriptSelectionMeetingId
            )
        }
    }
}

private struct TranscriptDetail: View {
    let detail: MeetingsViewModel.MeetingDetail

    private var speakerLabels: [String: String] {
        Dictionary(uniqueKeysWithValues: detail.speakers.map { ($0.id, $0.label) })
    }

    private var segments: [RPCTranscriptSegmentRecord] {
        detail.segments.sorted { $0.startOffsetMs < $1.startOffsetMs }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(detail.meeting.title)
                .font(.title3.bold())
            Text(MeetingsViewModel.formatDate(detail.meeting.startedAt) + (detail.meeting.endedAt.map { " · ended \(MeetingsViewModel.formatDate($0))" } ?? " · In progress"))
                .font(.caption)
                .foregroundStyle(.secondary)

            if !detail.speakers.isEmpty {
                Text("Speakers: \(detail.speakers.map(\.label).joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if segments.isEmpty {
                Text("No transcript segments yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
            } else {
                ForEach(segments, id: \.id) { segment in
                    HStack(alignment: .top, spacing: 10) {
                        Text(MeetingsViewModel.formatOffset(segment.startOffsetMs))
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(width: 42, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(segment.speakerId.flatMap { speakerLabels[$0] } ?? "Unknown speaker")
                                .font(.caption.weight(.semibold))
                            Text(segment.text)
                                .textSelection(.enabled)
                        }
                        Spacer(minLength: 0)
                        Text(segment.source)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                    Divider()
                }
            }
        }
    }
}

private struct MeetingsEmptyState: View {
    let onOpenVoice: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "waveform")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("No meetings recorded yet")
                .font(.headline)
            Text("Start a native meeting capture to build a transcript here.")
                .font(.callout)
                .foregroundStyle(.secondary)
            if let onOpenVoice {
                Button("Open voice capture", systemImage: "waveform.circle") {
                    onOpenVoice()
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
    }
}
