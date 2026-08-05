import EnchiridionCore
import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The Event-page representation of the transcript resource. This deliberately
/// renders the durable JSON projection rather than an audio recording: audio is
/// never read from, or retained by, the page UI.
struct MeetingTranscriptResourceView: View {
  let resource: MeetingTranscriptResource
  let event: CalendarEventSnapshot?
  let store: LibraryStore
  let openPage: (PageID) -> Void

  @State private var isTranscriptExpanded = false
  @State private var isUpdatingAssignment = false
  @State private var isUndoing = false
  @State private var errorMessage: String?

  private var clusters: [String] {
    Array(Set(resource.segments.map(\.speakerClusterID))).sorted()
  }

  var body: some View {
    GroupBox {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .firstTextBaseline) {
          Label("Meeting transcript", systemImage: "text.quote")
            .font(.headline)
          Spacer()
          stateLabel
        }

        Text("Transcript-only resource. Meeting audio is not kept.")
          .font(.footnote)
          .foregroundStyle(.secondary)

        processingStatus

        if !resource.segments.isEmpty {
          speakerAssignments
          DisclosureGroup("Transcript (\(resource.segments.count) segments)", isExpanded: $isTranscriptExpanded) {
            transcriptRows
          }
          .accessibilityIdentifier("meeting-transcript-disclosure")
        }

        analysisSection
        semanticOutcomeSection
        if let operationID = resource.semanticReceipt?.operationID {
          Button(role: .destructive) {
            undo(operationID)
          } label: {
            if isUndoing { ProgressView() }
            else { Label("Undo meeting links", systemImage: "arrow.uturn.backward") }
          }
          .disabled(isUndoing)
          .accessibilityLabel("Conditionally undo meeting-created links")
        }

        HStack {
          if MeetingTranscriptionRuntime.shared.isActive(eventPageID: resource.eventPageID) {
            Button(role: .destructive) {
              MeetingTranscriptionRuntime.shared.stopActiveSession()
            } label: {
              Label("Stop transcription", systemImage: "stop.circle")
            }
            .accessibilityLabel("Stop meeting transcription and process transcript")
          }
          Button {
            copyJSON()
          } label: {
            Label("Copy JSON", systemImage: "doc.on.doc")
          }
          .accessibilityLabel("Copy meeting transcript JSON")

        }

        if let errorMessage {
          Label(errorMessage, systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.red)
            .accessibilityLabel("Meeting transcript error: \(errorMessage)")
        }
        if overallState == .failed || overallState == .resourceLimit,
          let runtimeFailure = MeetingTranscriptionRuntime.shared.failureMessage
        {
          Label(runtimeFailure, systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.red)
            .accessibilityLabel("Meeting processing failure: \(runtimeFailure)")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } label: {
      Text("Meeting resource")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("meeting-transcript-resource")
  }

  @ViewBuilder
  private var processingStatus: some View {
    VStack(alignment: .leading, spacing: 6) {
      statusRow("Transcript", state: resource.transcriptState)
      statusRow("Summary and action items", state: resource.analysisState)
      statusRow("Super Tag links", state: resource.semanticState)
    }
  }

  private func statusRow(_ title: String, state: MeetingProcessingState) -> some View {
    HStack(spacing: 8) {
      Image(systemName: symbol(for: state))
        .accessibilityHidden(true)
      Text("\(title): \(description(for: state))")
        .font(.footnote)
    }
    .accessibilityLabel("\(title): \(description(for: state))")
  }

  private var stateLabel: some View {
    Label(description(for: overallState), systemImage: symbol(for: overallState))
      .font(.footnote.weight(.medium))
      .accessibilityLabel("Meeting transcript \(description(for: overallState))")
  }

  private var overallState: MeetingProcessingState {
    if resource.transcriptState == .failed || resource.analysisState == .failed || resource.semanticState == .failed { return .failed }
    if resource.transcriptState == .resourceLimit || resource.analysisState == .resourceLimit || resource.semanticState == .resourceLimit { return .resourceLimit }
    if resource.transcriptState == .inProgress || resource.analysisState == .inProgress || resource.semanticState == .inProgress { return .inProgress }
    if resource.transcriptState == .incomplete || resource.analysisState == .incomplete || resource.semanticState == .incomplete { return .incomplete }
    return resource.transcriptState
  }

  private var speakerAssignments: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Speakers")
        .font(.subheadline.weight(.semibold))
      ForEach(clusters, id: \.self) { clusterID in
        HStack(spacing: 10) {
          Text(genericSpeakerName(clusterID))
            .font(.subheadline)
          Spacer()
          Menu {
            if personName(for: clusterID) != nil {
              Button("Use generic speaker") { assign(clusterID, to: nil) }
              Divider()
            }
            ForEach(store.taskPeople(includingOtherPeople: true)) { person in
              Button(store.personDisplayName(for: person)) { assign(clusterID, to: person.id) }
            }
          } label: {
            Label(personName(for: clusterID) ?? "Assign person", systemImage: "person.crop.circle.badge.plus")
          }
          .disabled(event == nil || isUpdatingAssignment)
          .accessibilityLabel("Assign \(genericSpeakerName(clusterID)) to a person page")
        }
      }
    }
  }

  private var transcriptRows: some View {
    LazyVStack(alignment: .leading, spacing: 10) {
      ForEach(resource.segments) { segment in
        VStack(alignment: .leading, spacing: 3) {
          Text("\(speakerName(for: segment)) · \(timestamp(segment.startTime))")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
          Text(segment.text)
            .font(.body)
            .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.top, 8)
  }

  @ViewBuilder
  private var analysisSection: some View {
    if let analysis = resource.analysis {
      VStack(alignment: .leading, spacing: 10) {
        Text("Summary")
          .font(.subheadline.weight(.semibold))
        Text(analysis.summary)
          .textSelection(.enabled)

        if !analysis.decisions.isEmpty {
          Text("Decisions")
            .font(.subheadline.weight(.semibold))
          ForEach(Array(analysis.decisions.enumerated()), id: \.offset) { _, decision in
            Label(decision, systemImage: "checkmark.circle")
              .font(.body)
          }
        }

        if !analysis.actionItems.isEmpty {
          Text("Action items")
            .font(.subheadline.weight(.semibold))
          ForEach(analysis.actionItems) { item in
            Label(item.title, systemImage: "checklist")
              .font(.body)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var semanticOutcomeSection: some View {
    if let receipt = resource.semanticReceipt, !receipt.entityOutcomes.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        Text("Created and linked")
          .font(.subheadline.weight(.semibold))
        ForEach(receipt.entityOutcomes) { outcome in
          Button {
            openPage(outcome.pageID)
          } label: {
            Label(entityOutcomeLabel(outcome), systemImage: "arrowshape.turn.up.right")
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Open \(entityOutcomeLabel(outcome))")
        }
      }
    }
  }

  private func entityOutcomeLabel(_ outcome: MeetingSemanticEntityOutcome) -> String {
    let title = store.page(id: outcome.pageID)?.displayTitle ?? "Linked entity"
    return "\(title) (\(outcome.disposition.rawValue))"
  }

  private func personName(for clusterID: String) -> String? {
    resource.segments.first(where: { $0.speakerClusterID == clusterID })?.speakerPageID.flatMap(store.personDisplayName(for:))
  }

  private func genericSpeakerName(_ clusterID: String) -> String {
    if clusterID == MeetingSpeakerAssignment.unknownClusterID { return "Unknown speaker" }
    let ordinal = (clusters.firstIndex(of: clusterID) ?? 0) + 1
    return "Speaker \(ordinal)"
  }

  private func speakerName(for segment: MeetingTranscriptSegment) -> String {
    segment.speakerPageID.flatMap(store.personDisplayName(for:))
      ?? genericSpeakerName(segment.speakerClusterID)
  }

  private func timestamp(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds.rounded()))
    return String(format: "%d:%02d", total / 60, total % 60)
  }

  private func description(for state: MeetingProcessingState) -> String {
    switch state {
    case .pending: "Waiting"
    case .inProgress: "Processing"
    case .complete: "Complete"
    case .incomplete: "Incomplete"
    case .resourceLimit: "Resource limit reached"
    case .failed: "Needs attention"
    }
  }

  private func symbol(for state: MeetingProcessingState) -> String {
    switch state {
    case .pending: "clock"
    case .inProgress: "arrow.triangle.2.circlepath"
    case .complete: "checkmark.circle"
    case .incomplete: "exclamationmark.circle"
    case .resourceLimit: "externaldrive.badge.exclamationmark"
    case .failed: "exclamationmark.triangle"
    }
  }

  private func assign(_ clusterID: String, to personID: PageID?) {
    guard let event else { return }
    Task { @MainActor in
      isUpdatingAssignment = true
      defer { isUpdatingAssignment = false }
      var updated = resource
      let affected = updated.segments.indices.filter {
        updated.segments[$0].speakerClusterID == clusterID
      }
      let revision = affected.map {
        updated.segments[$0].speakerAssignmentRevision ?? 0
      }.max().map { $0 &+ 1 } ?? 1
      let operationID = UUID().uuidString.lowercased()
      for index in affected {
        updated.segments[index].speakerPageID = personID
        updated.segments[index].speakerAssignmentRevision = revision
        updated.segments[index].speakerAssignmentOperationID = operationID
      }
      do {
        _ = try await store.upsertMeetingTranscript(updated, for: event)
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  private func copyJSON() {
    guard let data = try? JSONEncoder().encode(resource),
      let string = String(data: data, encoding: .utf8)
    else { return }
    #if os(macOS)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(string, forType: .string)
    #else
      UIPasteboard.general.string = string
    #endif
  }

  private func undo(_ operationID: String) {
    Task { @MainActor in
      isUndoing = true
      defer { isUndoing = false }
      do {
        let result = try await store.undoMeetingSemanticMutation(
          eventPageID: resource.eventPageID,
          operationID: operationID
        )
        if !result.preservedEntityIDs.isEmpty {
          errorMessage = "Some linked entities were kept because they were edited after this meeting."
        }
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }
}
