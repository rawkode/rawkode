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

/// Keep the ordinary strip compact, but never make a large-type user negotiate a compressed
/// multi-action row. `ViewThatFits` handles narrow windows; this mode forces the same safe
/// vertical composition for accessibility Dynamic Type before SwiftUI attempts compression.
enum WorkforceAttentionLayout {
    enum Mode: Equatable {
        case inline
        case stacked
    }

    static func mode(isAccessibilitySize: Bool) -> Mode {
        isAccessibilitySize ? .stacked : .inline
    }

    static func reviewAccessibilityLabel(for disclosure: WorkforceAttentionPresentation.Disclosure) -> String {
        "Review \(disclosure.outcome.rawValue) update from \(disclosure.employee) for \(disclosure.job)"
    }
}

struct WorkforceAttentionStrip: View {
    @ObservedObject var model: DailyStandupViewModel
    let onOpen: ((EntityId) -> Void)?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if case .loaded(let publications) = model.employeeState, !publications.isEmpty {
            let snapshot = WorkforceAttentionPresentation.snapshot(publications)
            attentionContent(snapshot)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.orange.opacity(0.08), in: Capsule())
            .accessibilityElement(children: .contain)
            .accessibilityLabel(WorkforceAttentionPresentation.summary(totalAttention: snapshot.totalAttention, routineCount: snapshot.routineCount))
        }
    }

    @ViewBuilder
    private func attentionContent(_ snapshot: WorkforceAttentionPresentation.Snapshot) -> some View {
        if WorkforceAttentionLayout.mode(isAccessibilitySize: dynamicTypeSize.isAccessibilitySize) == .stacked {
            stackedContent(snapshot)
        } else {
            ViewThatFits(in: .horizontal) {
                inlineContent(snapshot)
                stackedContent(snapshot)
            }
        }
    }

    private func inlineContent(_ snapshot: WorkforceAttentionPresentation.Snapshot) -> some View {
        HStack(spacing: 10) {
            statusSummary(snapshot)
            Spacer(minLength: 0)
            ForEach(Array(snapshot.displayed.enumerated()), id: \.offset) { index, disclosure in
                disclosureRow(disclosure, index: index, compact: true)
                    .fixedSize(horizontal: true, vertical: false)
            }
            if let remainder = WorkforceAttentionPresentation.remainderTitle(snapshot.remainder) {
                Text(remainder).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func stackedContent(_ snapshot: WorkforceAttentionPresentation.Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            statusSummary(snapshot)
            ForEach(Array(snapshot.displayed.enumerated()), id: \.offset) { index, disclosure in
                disclosureRow(disclosure, index: index, compact: false)
            }
            if let remainder = WorkforceAttentionPresentation.remainderTitle(snapshot.remainder) {
                Text(remainder).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func statusSummary(_ snapshot: WorkforceAttentionPresentation.Snapshot) -> some View {
        HStack(spacing: 8) {
            Label(snapshot.isClear ? "Clear" : "Attention", systemImage: snapshot.isClear ? "checkmark.circle" : "exclamationmark.triangle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(snapshot.isClear ? Color.secondary : Color.orange)
            Text(WorkforceAttentionPresentation.summary(totalAttention: snapshot.totalAttention, routineCount: snapshot.routineCount))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func disclosureRow(
        _ disclosure: WorkforceAttentionPresentation.Disclosure,
        index: Int,
        compact: Bool
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(disclosure.outcome.rawValue) · \(disclosure.employee) · \(disclosure.job)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: compact, vertical: false)
            if !compact { Spacer(minLength: 0) }
            if disclosure.isReviewAvailable, let destination = disclosure.destination, let onOpen {
                Button(compact ? "Review \(index + 1)" : "Review") { onOpen(destination) }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(WorkforceAttentionLayout.reviewAccessibilityLabel(for: disclosure))
                    .accessibilityHint("Opens this employee update's companion page.")
            }
        }
    }
}
