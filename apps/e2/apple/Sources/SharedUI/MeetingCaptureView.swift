#if os(iOS)
import ApsidesCore
import SwiftUI

struct MeetingCaptureLibraryView: View {
    @ObservedObject var store: WorkspaceStore
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @State private var selected: MeetingCaptureSelection?

    var body: some View {
        List {
            Section {
                Button {
                    selected = MeetingCaptureSelection(transcript: MeetingTranscript(), ownerID: store.vault.accountID)
                } label: {
                    Label("Capture a meeting", systemImage: "waveform")
                        .padding(.vertical, 6)
                }.accessibilityIdentifier("newMeetingCapture")
                Text("Transcribe the room through this iPhone’s microphone. Let everyone know before you start.")
                    .font(.callout).foregroundStyle(theme.secondary)
            }.listRowBackground(theme.canvas)
            Section("Saved on this device") {
                if store.meetingTranscripts.isEmpty {
                    Text("Your meeting transcripts will appear here.").foregroundStyle(theme.secondary)
                }
                ForEach(store.meetingTranscripts.sorted { $0.startedAt > $1.startedAt }, id: \.id) { transcript in
                    Button { selected = MeetingCaptureSelection(transcript: transcript, ownerID: store.vault.accountID) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(meetingTitle(transcript)).font(.headline).lineLimit(2)
                            Text(transcript.startedAt, format: .dateTime.month().day().hour().minute())
                                .font(.subheadline).foregroundStyle(theme.secondary)
                            Text(transcript.recordingState == .stopped ? "Finished" : "Ready to continue")
                                .font(.caption).foregroundStyle(theme.secondary)
                        }.padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
                    }.buttonStyle(.plain).accessibilityIdentifier("meeting-" + transcript.id.uuidString)
                        .listRowBackground(theme.canvas)
                }
            }
            if let error = store.meetingStorageError {
                Section { Text(error).font(.callout) }.listRowBackground(theme.canvas)
            }
        }
        .scrollContentBackground(.hidden).background(theme.canvas).foregroundStyle(theme.ink)
        .navigationTitle("Meeting capture")
        .sheet(item: $selected) { selection in
            MeetingCaptureView(store: store, transcript: selection.transcript, ownerID: selection.ownerID)
        }
    }
}

private struct MeetingCaptureSelection: Identifiable {
    let transcript: MeetingTranscript
    let ownerID: String?
    var id: UUID { transcript.id }
}

private struct MeetingCaptureView: View {
    @ObservedObject var store: WorkspaceStore
    @StateObject private var recorder: MeetingRecorder
    private let ownerID: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @State private var participantsInformed = false
    @State private var closing = false

    init(store: WorkspaceStore, transcript: MeetingTranscript, ownerID: String?) {
        self.store = store
        self.ownerID = ownerID
        _recorder = StateObject(wrappedValue: MeetingRecorder(transcript: transcript))
    }

    private var busy: Bool {
        recorder.state == .preparing || recorder.state == .recording || recorder.state == .finalizing
    }
    private var canStart: Bool {
        !busy && recorder.transcript.recordingState != .stopped && participantsInformed && !closing
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    recordingStatus
                    if !busy && recorder.transcript.recordingState != .stopped { preparation }
                    if let error = recorder.error {
                        Label(error, systemImage: "exclamationmark.triangle").font(.callout)
                            .accessibilityIdentifier("meetingRecordingError")
                    }
                    if let error = store.meetingStorageError {
                        VStack(alignment: .leading, spacing: 8) {
                            Label(error, systemImage: "exclamationmark.triangle").font(.callout)
                            Button("Retry saving") { persist() }
                        }.accessibilityIdentifier("meetingSaveError")
                    }
                    transcriptContent
                    notes
                    Text("Transcript and notes stay on this device. Live text may change until it is finalized. Your notes stay separate from the transcript.")
                        .font(.caption).foregroundStyle(theme.secondary)
                }.padding(24)
            }
            .background(theme.canvas).foregroundStyle(theme.ink)
            .navigationTitle("Meeting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { Task { await close() } }.disabled(closing || recorder.state == .finalizing)
                        .accessibilityIdentifier("closeMeetingCapture")
                }
            }
            .safeAreaInset(edge: .bottom) { controls.padding(.horizontal, 24).padding(.vertical, 12).background(theme.canvas) }
        }
        .tint(theme.accent).preferredColorScheme(theme.scheme)
        .interactiveDismissDisabled(busy || closing || store.meetingStorageError != nil)
        .onChange(of: recorder.transcript) { _, _ in persist() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background && busy {
                Task { await recorder.interrupt(); persist() }
            }
        }
        .onChange(of: store.vault.accountID) { _, account in
            if account != ownerID {
                Task { await recorder.interrupt(); if persist() { dismiss() } }
            }
        }
        .onDisappear {
            Task { await recorder.interrupt(); if !untouchedDraft { persist() } }
        }
    }

    private var recordingStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(statusTitle, systemImage: recorder.state == .recording ? "record.circle" : "waveform")
                .font(.system(.title2, design: .serif).weight(.semibold))
                .accessibilityIdentifier("meetingRecordingStatus")
            if recorder.state == .recording {
                Text("Microphone is on").font(.callout).foregroundStyle(theme.secondary)
            } else if recorder.state == .interrupted || recorder.transcript.recordingState == .interrupted {
                Text("Recording paused. Finalized transcript and your notes are kept. Recording resumes only when you choose.")
                    .font(.callout).foregroundStyle(theme.secondary)
            }
            if recorder.state == .preparing || recorder.state == .finalizing {
                ProgressView().accessibilityLabel(statusTitle)
                if recorder.state == .preparing {
                    Text("The speech language model may need an initial download.").font(.callout).foregroundStyle(theme.secondary)
                }
            }
        }
    }

    private var statusTitle: String {
        switch recorder.state {
        case .preparing: "Preparing microphone"
        case .recording: "Recording meeting"
        case .finalizing: "Finishing transcript"
        case .interrupted: "Recording paused"
        case .failed: "Recording unavailable"
        case .idle: recorder.transcript.recordingState == .stopped ? "Meeting finished" : "Ready when you are"
        }
    }

    private var preparation: some View {
        Toggle("Everyone knows this meeting will be transcribed", isOn: $participantsInformed)
            .font(.body).accessibilityIdentifier("meetingParticipantsInformed")
    }

    private var transcriptContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Transcript").font(.headline)
            if recorder.transcript.segments.isEmpty && recorder.liveSegment == nil {
                Text("Spoken words will appear here after recording starts.").foregroundStyle(theme.secondary)
            }
            ForEach(recorder.transcript.segments, id: \.id) { segment in
                segmentRow(segment, live: !segment.isFinal)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("meetingTranscript")
    }

    private func segmentRow(_ segment: MeetingTranscriptSegment, live: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(live ? "Live · " + timestamp(segment.start) : timestamp(segment.start))
                .font(.caption.monospacedDigit()).foregroundStyle(theme.secondary)
            Text(segment.text).font(.body).textSelection(.enabled)
                .foregroundStyle(live ? theme.secondary : theme.ink)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var notes: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your notes and corrections").font(.headline)
            TextEditor(text: Binding(get: { recorder.transcript.note }, set: { value in recorder.updateNote(value) }))
                .frame(minHeight: 140).scrollContentBackground(.hidden)
                .padding(8).background(theme.base, in: .rect(cornerRadius: 12))
                .accessibilityLabel("Meeting notes and corrections").accessibilityIdentifier("meetingNotes")
        }
    }

    @ViewBuilder private var controls: some View {
        if busy {
            HStack(spacing: 20) {
                Button("Pause", systemImage: "pause.fill") {
                    Task { await recorder.interrupt(); persist() }
                }.disabled(recorder.state != .recording)
                Spacer()
                Button("Stop", systemImage: "stop.fill") {
                    Task { await recorder.stop(); persist() }
                }.disabled(recorder.state != .recording)
            }.frame(minHeight: 44)
        } else if recorder.transcript.recordingState != .stopped {
            VStack(spacing: 12) {
                if recorder.transcript.recordingState == .interrupted {
                    Button("Finish meeting", systemImage: "checkmark") {
                        Task { await recorder.stop(); persist() }
                    }.accessibilityIdentifier("finishMeetingRecording")
                }
                Button(recorder.transcript.recordingState == .interrupted ? "Resume recording" : "Start recording", systemImage: "mic.fill") {
                    guard persist() else { return }
                    Task { await recorder.start(participantsInformed: participantsInformed); persist() }
                }.buttonStyle(.glassProminent).disabled(!canStart).frame(maxWidth: .infinity)
                    .accessibilityIdentifier("startMeetingRecording")
            }
        }
    }

    @discardableResult private func persist() -> Bool {
        store.saveMeetingTranscript(recorder.transcript, ownerID: ownerID)
    }

    private var untouchedDraft: Bool {
        recorder.transcript.recordingState == .ready && recorder.transcript.note.isEmpty && recorder.transcript.segments.isEmpty
    }

    private func close() async {
        closing = true
        defer { closing = false }
        if busy { await recorder.interrupt() }
        guard untouchedDraft || persist() else { return }
        dismiss()
    }
}

private func meetingTitle(_ transcript: MeetingTranscript) -> String {
    let firstLine = transcript.note.split(separator: "\n").first.map(String.init) ?? ""
    return firstLine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Meeting" : String(firstLine.prefix(100))
}

private func timestamp(_ seconds: TimeInterval) -> String {
    let value = max(0, Int(exactly: seconds.rounded(.down)) ?? 0)
    return String(format: "%d:%02d", value / 60, value % 60)
}
#endif
