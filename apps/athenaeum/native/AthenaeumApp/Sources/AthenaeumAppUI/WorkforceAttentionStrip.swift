import AthenaeumDomain
import AthenaeumRPC
import SwiftUI

/// Stable, value-only anchors shared by the compact Today cue, the lower standup rows, and the
/// command-center scroll containers. Wrapping the durable publication id prevents it from being
/// confused with a route id or a user-authored fragment.
public enum WorkforceAttentionAnchor: Hashable, Sendable {
    case standup
    case publication(EntityId)
}

/// A deliberately small, value-only Today summary. It never retains source publication text,
/// workflow/schedule data, reference IDs, or diagnostics. The publication id is the durable,
/// privacy-safe identity needed to review the exact lower row; it is never rendered or exposed to
/// VoiceOver.
enum WorkforceAttentionPresentation {
    static let maximumVisible = 3
    static let failureMessage = "Employee updates couldn’t be loaded."
    static let failureRetryLabel = "Retry"
    static let failureRetryHint = "Retries the employee update feed."

    enum Outcome: String, Equatable, Sendable {
        case blocked = "Blocked"
        case failed = "Failed"
    }

    struct Disclosure: Equatable, Sendable {
        let outcome: Outcome
        let employee: String
        let job: String
        let publicationId: EntityId

        /// Review targets the publication row itself, so it remains available when the companion
        /// page is missing or temporarily unavailable.
        var isReviewAvailable: Bool { true }
    }

    struct Snapshot: Equatable, Sendable {
        let totalAttention: Int
        let routineCount: Int
        let displayed: [Disclosure]
        let remainder: Int

        var isClear: Bool { totalAttention == 0 }
    }

    /// Keeps the visual hierarchy honest: routine work is a calm status, while blocked or failed
    /// work is an interruption that deserves an urgent treatment. The same distinction is already
    /// present in the web strip; keeping it as a value contract makes native parity testable.
    enum Treatment: Equatable, Sendable {
        case calm
        case urgent
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

    static func treatment(for snapshot: Snapshot) -> Treatment {
        snapshot.isClear ? .calm : .urgent
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
        return .init(
            outcome: outcome,
            employee: publication.microEmployeeLabel,
            job: publication.jobLabel,
            publicationId: publication.id
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

    /// Models `ViewThatFits`'s width decision for a constrained-layout regression. The renderer
    /// supplies that intrinsic measurement by fixing the entire inline candidate horizontally.
    static func requiresStackedFallback(availableWidth: CGFloat, intrinsicInlineWidth: CGFloat) -> Bool {
        intrinsicInlineWidth > availableWidth
    }

    static func reviewAccessibilityLabel(for disclosure: WorkforceAttentionPresentation.Disclosure) -> String {
        "Review \(disclosure.outcome.rawValue) update from \(disclosure.employee) for \(disclosure.job)"
    }

    static let reviewStandupTitle = "Review standup"
}

struct WorkforceAttentionStrip: View {
    @ObservedObject var model: DailyStandupViewModel
    let onReviewStandup: (() -> Void)?
    let onReviewPublication: ((EntityId, WorkforceSnapshotIdentity) -> Void)?
    let onRetry: (() -> Void)?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        model: DailyStandupViewModel,
        onReviewStandup: (() -> Void)? = nil,
        onReviewPublication: ((EntityId, WorkforceSnapshotIdentity) -> Void)? = nil,
        onRetry: (() -> Void)? = nil
    ) {
        self.model = model
        self.onReviewStandup = onReviewStandup
        self.onReviewPublication = onReviewPublication
        self.onRetry = onRetry
    }

    var body: some View {
        switch model.employeeState {
        case .failed:
            failureContent
        case .loaded(let publications) where !publications.isEmpty:
            let snapshot = WorkforceAttentionPresentation.snapshot(publications)
            loadedContent(snapshot)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(WorkforceAttentionPresentation.summary(totalAttention: snapshot.totalAttention, routineCount: snapshot.routineCount))
        default:
            EmptyView()
        }
    }

    private var failureContent: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Label(WorkforceAttentionPresentation.failureMessage, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let onRetry {
                Button(WorkforceAttentionPresentation.failureRetryLabel, action: onRetry)
                    .buttonStyle(.borderless)
                    .font(.caption.weight(.semibold))
                    .accessibilityHint(WorkforceAttentionPresentation.failureRetryHint)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(WorkforceAttentionPresentation.failureMessage)
        .accessibilityAddTraits(.updatesFrequently)
    }

    @ViewBuilder
    private func loadedContent(_ snapshot: WorkforceAttentionPresentation.Snapshot) -> some View {
        switch WorkforceAttentionPresentation.treatment(for: snapshot) {
        case .calm:
            attentionContent(snapshot)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(.secondary.opacity(0.06), in: Capsule())
                .overlay(Capsule().stroke(.secondary.opacity(0.16), lineWidth: 1))
        case .urgent:
            attentionContent(snapshot)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(.orange.opacity(0.08), in: Capsule())
        }
    }

    @ViewBuilder
    private func attentionContent(_ snapshot: WorkforceAttentionPresentation.Snapshot) -> some View {
        if WorkforceAttentionLayout.mode(isAccessibilitySize: dynamicTypeSize.isAccessibilitySize) == .stacked {
            stackedContent(snapshot)
        } else {
            ViewThatFits(in: .horizontal) {
                // Without this the HStack can accept an artificial compressed proposal and never
                // reach the readable stacked fallback. The complete candidate must advertise its
                // intrinsic horizontal width, not just each disclosure inside it.
                inlineContent(snapshot)
                    .fixedSize(horizontal: true, vertical: false)
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
            if let onReviewStandup {
                Button(WorkforceAttentionLayout.reviewStandupTitle, action: onReviewStandup)
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .accessibilityHint("Returns to the daily standup in this note.")
            }
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
            if disclosure.isReviewAvailable,
               let onReviewPublication,
               let snapshotIdentity = model.workforceSnapshotIdentity {
                Button(compact ? "Review \(index + 1)" : "Review") {
                    onReviewPublication(disclosure.publicationId, snapshotIdentity)
                }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(WorkforceAttentionLayout.reviewAccessibilityLabel(for: disclosure))
                    .accessibilityHint("Scrolls to this employee update in the current daily note.")
            }
        }
    }
}
