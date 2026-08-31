import Foundation
import AthenaeumCore

/// The platform-neutral authority for lossless semantic editing. AppKit and UIKit are adapters:
/// they may display text and collect intent, but all admission, mark toggling, scalar conversion,
/// pending-parent acknowledgement, and composition recovery happens here.
struct LoroNativeRichEditingEngine {
    private enum Replacement {
        case plainText(String)
        case inlineReference(LoroCanonicalSemanticValueV1.InlineReference)

        var utf16Count: Int {
            switch self {
            case let .plainText(text): text.utf16.count
            case let .inlineReference(reference): reference.label.utf16.count
            }
        }

        var permitsReferenceDeletion: Bool {
            if case let .plainText(text) = self { return text.isEmpty }
            return false
        }
    }

    private struct Composition: Equatable, Sendable {
        let base: LoroNativeRichDocumentV1
        let range: NSRange
        var replacement: String
        var finalized: Bool
    }

    private(set) var admittedDocument: LoroNativeRichDocumentV1
    private(set) var admittedSelection: LoroNativeRichTextSelection
    private(set) var pendingLocalDocument: LoroNativeRichDocumentV1?
    private(set) var compositionState: LoroNativeRichTextCompositionState = .idle
    private var composition: Composition?
    private var compositionGeneration = 0

    init(document: LoroNativeRichDocumentV1, selection: LoroNativeRichTextSelection = .init(location: 0, length: 0)) {
        admittedDocument = document
        admittedSelection = selection
    }

    mutating func setSelection(_ selection: LoroNativeRichTextSelection) {
        admittedSelection = selection
    }

    mutating func receiveParentDocument(_ document: LoroNativeRichDocumentV1) -> LoroNativeRichParentUpdateDisposition {
        guard composition == nil else { return .deferredForComposition }
        if let pendingLocalDocument {
            if document == pendingLocalDocument {
                self.pendingLocalDocument = nil
                admittedDocument = document
                return .acknowledged(document: document, selection: admittedSelection)
            }
            return .deferredForLocalProposal
        }
        guard document != admittedDocument else { return .unchanged }
        admittedDocument = document
        return .adopted(document: document, selection: admittedSelection)
    }

    mutating func replace(utf16Range: NSRange, withPlainText replacement: String) -> LoroNativeRichEditingEffect {
        replace(in: admittedDocument, utf16Range: utf16Range, withPlainText: replacement)
    }

    /// Replaces an explicit UTF-16 range with an already-resolved typed reference. The reference
    /// remains a single semantic run, so later text input cannot split or mutate its identity.
    mutating func insert(
        reference: LoroCanonicalSemanticValueV1.InlineReference,
        replacingUTF16Range utf16Range: NSRange
    ) -> LoroNativeRichEditingEffect {
        guard composition == nil else { return .rejected(.invalidEdit) }
        return replace(in: admittedDocument, utf16Range: utf16Range, with: .inlineReference(reference))
    }

    mutating func toggle(mark: LoroCanonicalSemanticValueV1.Mark, utf16Range: NSRange) -> LoroNativeRichEditingEffect {
        guard utf16Range.length > 0,
              let rendered = try? LoroNativeRichTextCodec.attributedString(for: admittedDocument),
              utf16Range.location >= 0,
              NSMaxRange(utf16Range) <= rendered.length
        else { return .rejected(.invalidEdit) }
        let candidate = NSMutableAttributedString(attributedString: rendered)
        let marksKey = NSAttributedString.Key("dev.athenaeum.rich.marks.v1")
        let existing = candidate.attribute(marksKey, at: utf16Range.location, effectiveRange: nil) as? String ?? ""
        var marks = existing.isEmpty ? [] : existing.split(separator: ",").map(String.init)
        if let index = marks.firstIndex(of: mark.rawValue) { marks.remove(at: index) } else { marks.append(mark.rawValue) }
        let canonical = ["code", "emphasis", "strong"].filter(marks.contains).joined(separator: ",")
        if canonical.isEmpty { candidate.removeAttribute(marksKey, range: utf16Range) }
        else { candidate.addAttribute(marksKey, value: canonical, range: utf16Range) }
        guard let decoded = try? LoroNativeRichTextCodec.decode(candidate),
              let selection = try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: utf16Range, in: candidate)
        else { return .rejected(.invalidEdit) }
        return admit(decoded, selection: selection)
    }

    mutating func beginComposition(utf16Range: NSRange) -> LoroNativeRichEditingEffect {
        guard composition == nil,
              let rendered = try? LoroNativeRichTextCodec.attributedString(for: admittedDocument),
              utf16Range.location >= 0,
              utf16Range.length >= 0,
              NSMaxRange(utf16Range) <= rendered.length
        else { return .rejected(.invalidEdit) }
        compositionGeneration &+= 1
        composition = .init(base: admittedDocument, range: utf16Range, replacement: "", finalized: false)
        compositionState = .composing(generation: compositionGeneration)
        return .noChange
    }

    mutating func updateComposition(_ replacement: String) {
        guard var composition, !composition.finalized else { return }
        composition.replacement = replacement
        self.composition = composition
    }

    mutating func finalizeComposition(_ replacement: String) {
        guard var composition else { return }
        composition.replacement = replacement
        composition.finalized = true
        self.composition = composition
    }

    func compositionReplacement() -> String? { composition?.replacement }

    /// Commits exactly once from the captured semantic base. Calling it after cancellation or an
    /// earlier commit is a no-op, which makes host callbacks safe in either unmark/insert order.
    mutating func commitComposition() -> LoroNativeRichEditingEffect {
        guard let composition else { return .noChange }
        self.composition = nil
        compositionState = .idle
        return replace(in: composition.base, utf16Range: composition.range, withPlainText: composition.replacement)
    }

    /// Cancellation restores the last admitted semantic document and invalidates every queued
    /// host flush via a new generation.
    mutating func cancelComposition() -> LoroNativeRichEditingEffect {
        compositionGeneration &+= 1
        composition = nil
        compositionState = .idle
        return .restore(document: admittedDocument, selection: admittedSelection)
    }

    private mutating func replace(
        in document: LoroNativeRichDocumentV1,
        utf16Range: NSRange,
        withPlainText replacement: String
    ) -> LoroNativeRichEditingEffect {
        replace(in: document, utf16Range: utf16Range, with: .plainText(replacement))
    }

    private mutating func replace(
        in document: LoroNativeRichDocumentV1,
        utf16Range: NSRange,
        with replacement: Replacement
    ) -> LoroNativeRichEditingEffect {
        guard let candidate = Self.semanticSplice(document, utf16Range: utf16Range, replacement: replacement),
              let rendered = try? LoroNativeRichTextCodec.attributedString(for: candidate),
              let selection = try? LoroNativeRichTextCodec.scalarSelection(
                forUTF16Range: NSRange(location: utf16Range.location + replacement.utf16Count, length: 0),
                in: rendered
              )
        else { return .rejected(.invalidEdit) }
        return admit(candidate, selection: selection)
    }

    private mutating func admit(
        _ candidate: LoroNativeRichDocumentV1,
        selection: LoroNativeRichTextSelection
    ) -> LoroNativeRichEditingEffect {
        guard let canonical = try? LoroNativeRichTextCodec.attributedString(for: candidate),
              (try? LoroNativeRichTextCodec.decode(canonical)) == candidate
        else { return .rejected(.invalidEdit) }
        admittedDocument = candidate
        admittedSelection = selection
        pendingLocalDocument = candidate
        return .publish(document: candidate, selection: selection)
    }

    private static func semanticSplice(
        _ document: LoroNativeRichDocumentV1,
        utf16Range: NSRange,
        replacement: Replacement
    ) -> LoroNativeRichDocumentV1? {
        guard let rendered = try? LoroNativeRichTextCodec.attributedString(for: document),
              let scalarRange = try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: utf16Range, in: rendered)
        else { return nil }

        typealias Block = LoroCanonicalSemanticValueV1.Block
        typealias Run = LoroCanonicalSemanticValueV1.TextRun
        func runs(in block: Block) -> [Run] { switch block { case let .paragraph(r), let .heading(_, r): return r } }
        func scalarCount(_ runs: [Run]) -> Int { runs.reduce(0) { $0 + $1.text.unicodeScalars.count } }
        func makeLike(_ block: Block, runs: [Run]) -> Block { if case let .heading(level, _) = block { return .heading(level: level, runs: runs) }; return .paragraph(runs) }
        func split(_ runs: [Run], at scalarOffset: Int) -> ([Run], [Run]) {
            var prefix: [Run] = []; var suffix: [Run] = []; var remaining = scalarOffset
            for run in runs {
                let count = run.text.unicodeScalars.count
                if remaining <= 0 { suffix.append(run) }
                else if remaining >= count { prefix.append(run); remaining -= count }
                else {
                    let scalars = run.text.unicodeScalars
                    let splitIndex = scalars.index(scalars.startIndex, offsetBy: remaining)
                    prefix.append(.init(text: String(scalars[..<splitIndex]), marks: run.marks, reference: run.reference))
                    suffix.append(.init(text: String(scalars[splitIndex...]), marks: run.marks, reference: run.reference))
                    remaining = 0
                }
            }
            return (coalesced(prefix), coalesced(suffix))
        }

        var starts: [Int] = []; var cursor = 0
        for block in document.semantic.blocks { starts.append(cursor); cursor += scalarCount(runs(in: block)) + 1 }
        let totalScalars = rendered.string.unicodeScalars.count
        func owningBlock(for scalarOffset: Int) -> Int? {
            guard scalarOffset <= totalScalars else { return nil }
            for index in document.semantic.blocks.indices {
                let end = starts[index] + scalarCount(runs(in: document.semantic.blocks[index]))
                if scalarOffset >= starts[index], scalarOffset <= end { return index }
            }
            return nil
        }
        let scalarEnd = scalarRange.location + scalarRange.length
        guard let blockIndex = owningBlock(for: scalarRange.location), owningBlock(for: scalarEnd) == blockIndex else { return nil }
        let original = document.semantic.blocks[blockIndex]
        let originalRuns = runs(in: original)
        let localStart = scalarRange.location - starts[blockIndex]
        let localEnd = scalarEnd - starts[blockIndex]
        // References are semantic atoms: edge insertion stays ordinary prose, but a span cannot
        // be split or replaced.  Deleting its whole span is the one destructive operation that
        // is meaningful without dereferencing its immutable id/label snapshot.
        var referenceStart = 0
        for run in originalRuns {
            let referenceEnd = referenceStart + run.text.unicodeScalars.count
            defer { referenceStart = referenceEnd }
            guard run.reference != nil else { continue }
            if localStart == localEnd {
                guard !(referenceStart < localStart && localStart < referenceEnd) else { return nil }
            } else if localStart < referenceEnd && localEnd > referenceStart {
                guard replacement.permitsReferenceDeletion, localStart <= referenceStart, localEnd >= referenceEnd else { return nil }
            }
        }
        let prefix = split(originalRuns, at: localStart).0
        let suffix = split(originalRuns, at: localEnd).1
        var traversed = 0
        let inherited = originalRuns.first { run in
            defer { traversed += run.text.unicodeScalars.count }
            return localStart < traversed + run.text.unicodeScalars.count
        }?.marks ?? originalRuns.last?.marks ?? []
        switch replacement {
        case let .plainText(text):
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            var emitted: [Block] = []
            for index in lines.indices {
                var lineRuns = index == lines.startIndex ? prefix : []
                if !lines[index].isEmpty { lineRuns.append(.init(text: lines[index], marks: inherited)) }
                if index == lines.index(before: lines.endIndex) { lineRuns += suffix }
                emitted.append(index == lines.startIndex ? makeLike(original, runs: coalesced(lineRuns)) : .paragraph(coalesced(lineRuns)))
            }
            var blocks = document.semantic.blocks
            blocks.replaceSubrange(blockIndex...blockIndex, with: emitted)
            return .init(semantic: .init(blocks: blocks))
        case let .inlineReference(reference):
            guard !reference.label.contains("\n"), !reference.label.contains("\r"), !reference.label.isEmpty else { return nil }
            let runs = coalesced(prefix + [.init(text: reference.label, reference: reference)] + suffix)
            var blocks = document.semantic.blocks
            blocks[blockIndex] = makeLike(original, runs: runs)
            return .init(semantic: .init(blocks: blocks))
        }
    }

    private static func coalesced(_ runs: [LoroCanonicalSemanticValueV1.TextRun]) -> [LoroCanonicalSemanticValueV1.TextRun] {
        runs.reduce(into: []) { result, run in
            guard !run.text.isEmpty else { return }
            if let last = result.last, last.reference == nil, run.reference == nil, last.marks == run.marks {
                result[result.count - 1] = .init(text: last.text + run.text, marks: last.marks)
            } else {
                result.append(run)
            }
        }
    }
}
