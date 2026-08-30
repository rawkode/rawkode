import AthenaeumDomain
import AthenaeumRPC
import SwiftUI

/// A deliberately small, value-only Today summary. It never retains source publication text,
/// workflow/schedule data, reference IDs, or diagnostics. The optional destination is only used
/// to enable the already-authorized Review action; it is never rendered or exposed to VoiceOver.
enum WorkforceAttentionPresentation {
    static let maximumVisible = 3

    enum Outcome: String, Equatable, Sendable {
        case blocked = "Blocked"
        case failed = "Failed"
    }

    struct Disclosure: Equatable, Sendable {
        let outcome: Outcome
        let employee: String
        let job: String
        fileprivate let destination: EntityId?

        var isReviewAvailable: Bool { destination != nil }
    }

    struct Snapshot: Equatable, Sendable {
        let totalAttention: Int
        let routineCount: Int
        let displayed: [Disclosure]
        let remainder: Int

        var isClear: Bool { totalAttention == 0 }
    }

    static func snapshot(_ publications: [StandupPublication]) -> Snapshot {
        // `compactMap` preserves durable source order; only blocked/failed publications enter
        // the attention lane, while completed/skipped/nil are routine.
        let attention = publications.compactMap(disclosure)
        return .init(
            totalAttention: attention.count,
            routineCount: publications.count - attention.count,
            displayed: Array(attention.prefix(maximumVisible)),
            remainder: max(attention.count - maximumVisible, 0)
        )
    }

    static func summary(totalAttention: Int, routineCount: Int = 0) -> String {
        guard totalAttention > 0 else {
            return "\(routineCount) \(routineCount == 1 ? "employee update" : "employee updates") · no exceptions"
        }
        return totalAttention == 1 ? "1 workforce update needs attention" : "\(totalAttention) workforce updates need attention"
    }

    static func remainderTitle(_ remainder: Int) -> String? {
        remainder > 0 ? "and \(remainder) more" : nil
    }

    private static func disclosure(_ publication: StandupPublication) -> Disclosure? {
        let outcome: Outcome
        switch publication.resultKind {
        case .blocked: outcome = .blocked
        case .failed: outcome = .failed
        default: return nil
        }
        let destination: EntityId?
        switch publication.companionStatus {
        case .verifiedOriginal, .modified: destination = publication.childNodeId
        case .missing, .unavailable: destination = nil
        }
        return .init(
            outcome: outcome,
            employee: publication.microEmployeeLabel,
            job: publication.jobLabel,
            destination: destination
        )
    }
}

struct WorkforceAttentionStrip: View {
    @ObservedObject var model: DailyStandupViewModel
    let onOpen: ((EntityId) -> Void)?

    var body: some View {
        if case .loaded(let publications) = model.employeeState, !publications.isEmpty {
            let snapshot = WorkforceAttentionPresentation.snapshot(publications)
            HStack(spacing: 10) {
                Label(snapshot.isClear ? "Clear" : "Attention", systemImage: snapshot.isClear ? "checkmark.circle" : "exclamationmark.triangle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(snapshot.isClear ? Color.secondary : Color.orange)
                Text(WorkforceAttentionPresentation.summary(totalAttention: snapshot.totalAttention, routineCount: snapshot.routineCount))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                ForEach(Array(snapshot.displayed.enumerated()), id: \.offset) { index, disclosure in
                    Text("\(disclosure.outcome.rawValue) · \(disclosure.employee) · \(disclosure.job)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if disclosure.isReviewAvailable, let destination = disclosure.destination, let onOpen {
                        Button("Review \(index + 1)") { onOpen(destination) }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Review \(disclosure.outcome.rawValue) update from \(disclosure.employee) for \(disclosure.job)")
                    }
                }
                if let remainder = WorkforceAttentionPresentation.remainderTitle(snapshot.remainder) {
                    Text(remainder).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.orange.opacity(0.08), in: Capsule())
            .accessibilityElement(children: .contain)
            .accessibilityLabel(WorkforceAttentionPresentation.summary(totalAttention: snapshot.totalAttention, routineCount: snapshot.routineCount))
        }
    }
}
