import Foundation
import AthenaeumDomain

/// Content-only, canonical rich text semantics accepted by the native Loro editor.  This is
/// intentionally not a projection: every member is authorable and no Loro/container metadata
/// crosses this boundary.
public struct LoroCanonicalSemanticValueV1: Sendable, Equatable {
    public enum Block: Sendable, Equatable {
        case paragraph([TextRun])
        case heading(level: Int, runs: [TextRun])
        case taskList([TaskItem])
    }

    public struct TaskItem: Sendable, Equatable {
        public let checked: Bool
        public let runs: [TextRun]

        public init(checked: Bool, runs: [TextRun]) {
            self.checked = checked
            self.runs = runs
        }
    }

    public struct TextRun: Sendable, Equatable {
        public let text: String
        public let marks: [Mark]
        /// A value-only inline reference. The snapshot label is retained alongside the immutable
        /// id so rendering never needs to dereference personal/workspace data during projection.
        public let reference: InlineReference?

        public init(text: String, marks: [Mark] = [], reference: InlineReference? = nil) {
            self.text = text
            self.marks = marks
            self.reference = reference
        }
    }

    public struct InlineReference: Sendable, Equatable {
        public enum Kind: Sendable, Equatable { case entity, supertag }
        public let kind: Kind
        public let id: EntityId
        public let label: String
        public init(kind: Kind, id: EntityId, label: String) { self.kind = kind; self.id = id; self.label = label }
    }

    public enum Mark: String, Sendable, Equatable, CaseIterable {
        case strong, emphasis, code

        static let canonicalOrder: [Self] = [.code, .emphasis, .strong]
    }

    public let blocks: [Block]
    public init(blocks: [Block]) { self.blocks = blocks }
}

/// Immutable rich editor value. It has no request identity, attributes, raw CRDT material, or
/// actor-bound state, so equal values are deterministic semantic equality.
public struct LoroNativeRichDocumentV1: Sendable, Equatable {
    public let semantic: LoroCanonicalSemanticValueV1
    public init(semantic: LoroCanonicalSemanticValueV1) { self.semantic = semantic }
}

public enum LoroNativeRichEditorError: Error, Sendable, Equatable {
    case ineligible
    case malformed
    case noChange
    case bounds
}

extension LoroCanonicalSemanticValueV1 {
    /// Reject rather than repair noncanonical caller values. In particular, adjacent equal-mark
    /// runs are not admitted merely because they could be coalesced after parsing.
    func validated() throws -> Self {
        let limits = LoroPageProjectionLimits()
        guard !blocks.isEmpty, blocks.count <= limits.maxChildren else { throw LoroNativeRichEditorError.bounds }
        var runCount = 0; var bytes = 0
        func validateRuns(_ runs: [TextRun]) throws {
            var previous: (marks: [Mark], reference: InlineReference?)?
            for run in runs {
                runCount += 1; bytes += run.text.lengthOfBytes(using: .utf8)
                if let reference = run.reference { bytes += reference.label.lengthOfBytes(using: .utf8) }
                guard !run.text.isEmpty,
                      !run.text.contains("\n"),
                      !run.text.contains("\r"),
                      run.marks == Mark.canonicalOrder.filter(run.marks.contains),
                      Set(run.marks).count == run.marks.count else { throw LoroNativeRichEditorError.malformed }
                if let reference = run.reference {
                    guard !reference.label.isEmpty, !reference.label.contains("\n"), !reference.label.contains("\r"),
                          reference.label.lengthOfBytes(using: .utf8) <= 500,
                          reference.label == run.text else { throw LoroNativeRichEditorError.malformed }
                }
                guard previous == nil || previous!.marks != run.marks || previous!.reference != run.reference else { throw LoroNativeRichEditorError.malformed }
                guard runCount <= limits.maxTextRuns, bytes <= limits.maxUTF8Bytes, run.marks.count <= limits.maxMarks else { throw LoroNativeRichEditorError.bounds }
                previous = (run.marks, run.reference)
            }
        }
        for block in blocks {
            switch block {
            case let .paragraph(runs):
                try validateRuns(runs)
            case let .heading(level, runs):
                guard (1...3).contains(level) else { throw LoroNativeRichEditorError.malformed }
                try validateRuns(runs)
            case let .taskList(items):
                guard !items.isEmpty, items.count <= limits.maxChildren else { throw LoroNativeRichEditorError.bounds }
                for item in items { try validateRuns(item.runs) }
            }
        }
        return self
    }
}
