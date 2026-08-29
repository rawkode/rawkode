import Foundation

/// Content-only, canonical rich text semantics accepted by the native Loro editor.  This is
/// intentionally not a projection: every member is authorable and no Loro/container metadata
/// crosses this boundary.
public struct LoroCanonicalSemanticValueV1: Sendable, Equatable {
    public enum Block: Sendable, Equatable {
        case paragraph([TextRun])
        case heading(level: Int, runs: [TextRun])
    }

    public struct TextRun: Sendable, Equatable {
        public let text: String
        public let marks: [Mark]

        public init(text: String, marks: [Mark] = []) {
            self.text = text
            self.marks = marks
        }
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
        for block in blocks {
            let runs: [TextRun]
            switch block {
            case let .paragraph(value): runs = value
            case let .heading(level, value):
                guard (1...3).contains(level) else { throw LoroNativeRichEditorError.malformed }
                runs = value
            }
            var previous: [Mark]?
            for run in runs {
                runCount += 1; bytes += run.text.lengthOfBytes(using: .utf8)
                guard !run.text.isEmpty,
                      !run.text.contains("\n"),
                      !run.text.contains("\r"),
                      run.marks == Mark.canonicalOrder.filter(run.marks.contains),
                      Set(run.marks).count == run.marks.count else { throw LoroNativeRichEditorError.malformed }
                guard previous != run.marks else { throw LoroNativeRichEditorError.malformed }
                guard runCount <= limits.maxTextRuns, bytes <= limits.maxUTF8Bytes, run.marks.count <= limits.maxMarks else { throw LoroNativeRichEditorError.bounds }
                previous = run.marks
            }
        }
        return self
    }
}
