import AthenaeumDomain
import AthenaeumRPC
import SwiftUI

/// A deliberately small, value-only Today summary. It never renders source publication text,
/// employee/job names, identifiers, or transport diagnostics; detail remains in the standup.
enum WorkforceAttentionPresentation {
    static let maximumVisible = 3

    struct Snapshot: Equatable, Sendable {
        let totalAttention: Int
        let routineCount: Int
        let displayed: [StandupPublication]
        let remainder: Int

        var isClear: Bool { totalAttention == 0 }
    }

    static func snapshot(_ publications: [StandupPublication]) -> Snapshot {
        // `partition` preserves durable source order; only blocked/failed publications enter the
        // attention lane, while completed/skipped/nil are routine.
        let attention = EmployeeUpdatePresentation.partition(publications).needsAttention
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
                ForEach(Array(snapshot.displayed.enumerated()), id: \.offset) { index, publication in
                    if EmployeeUpdatePresentation.canOpenCompanion(status: publication.companionStatus, hasOpenAction: onOpen != nil), let onOpen {
                        Button("Review \(index + 1)") { onOpen(publication.childNodeId) }
                            .buttonStyle(.borderless)
                    }
                }
                if let remainder = WorkforceAttentionPresentation.remainderTitle(snapshot.remainder) {
                    Text(remainder).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.orange.opacity(0.08), in: Capsule())
            .accessibilityElement(children: .combine)
            .accessibilityLabel(WorkforceAttentionPresentation.summary(totalAttention: snapshot.totalAttention, routineCount: snapshot.routineCount))
        }
    }
}
