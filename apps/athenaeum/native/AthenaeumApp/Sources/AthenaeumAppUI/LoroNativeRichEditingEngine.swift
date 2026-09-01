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
    /// Monotonic presentation generation. Structural commands capture it and the host rejects a
    /// late checkbox tap after a parent adoption or another local edit.
    private(set) var documentGeneration: Int = 1
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
                documentGeneration &+= 1
                return .acknowledged(document: document, selection: admittedSelection)
            }
            return .deferredForLocalProposal
        }
        guard document != admittedDocument else { return .unchanged }
        admittedDocument = document
        documentGeneration &+= 1
        return .adopted(document: document, selection: admittedSelection)
    }

    /// Captures the exact item value and structural location for a checkbox command. No local
    /// semantic mutation occurs here; the store must acknowledge the typed command before the
    /// adapter adopts the post-toggle document.
    mutating func makeTaskToggleCommand(
        atUTF16Offset offset: Int,
        commandID: UUID = UUID()
    ) -> LoroNativeRichTaskItemToggleCommand? {
        guard composition == nil,
              let rendered = try? LoroNativeRichTextCodec.attributedString(for: admittedDocument),
              let location = LoroNativeRichTextCodec.taskItem(atUTF16Offset: offset, in: rendered),
              location.taskListIndex >= 0,
              location.taskListIndex < admittedDocument.semantic.blocks.count,
              case let .taskList(items) = admittedDocument.semantic.blocks[location.taskListIndex],
              location.itemIndex >= 0,
              location.itemIndex < items.count
        else { return nil }
        let item = items[location.itemIndex]
        guard item.checked == location.checked else { return nil }
        return .init(
            commandID: commandID,
            editorGeneration: documentGeneration,
            taskListIndex: location.taskListIndex,
            itemIndex: location.itemIndex,
            expectedItem: item
        )
    }

    /// Captures a collapsed caret in one top-level paragraph for a store-owned checklist
    /// insertion. The absolute scalar offset is retained so the adapter can restore the caret
    /// after the paragraph is wrapped without inventing a new selection.
    mutating func makeTaskListInsertionCommand(
        atScalarOffset offset: Int,
        commandID: UUID = UUID()
    ) -> LoroNativeRichTaskListInsertionCommand? {
        guard offset >= 0 else { return nil }
        var cursor = 0
        for index in admittedDocument.semantic.blocks.indices {
            let block = admittedDocument.semantic.blocks[index]
            let blockStart = cursor
            let length: Int
            switch block {
            case let .paragraph(runs), let .heading(_, runs):
                length = runs.reduce(0) { $0 + $1.text.unicodeScalars.count }
            case let .taskList(items):
                length = items.reduce(0) { total, item in total + item.runs.reduce(0) { $0 + $1.text.unicodeScalars.count } } + max(0, items.count - 1)
            }
            guard offset <= cursor + length else {
                cursor += length + (index == admittedDocument.semantic.blocks.index(before: admittedDocument.semantic.blocks.endIndex) ? 0 : 1)
                continue
            }
            switch block {
            case .paragraph, .heading: break
            case .taskList: return nil
            }
            guard offset >= blockStart, offset <= blockStart + length else { return nil }
            return .init(
                commandID: commandID,
                editorGeneration: documentGeneration,
                topLevelBlockIndex: index,
                expectedBlock: block,
                collapsedScalarOffset: offset
            )
        }
        return nil
    }

    /// Captures a style request from the adapter's current selection. The flattened scalar
    /// witness deliberately excludes block separators, so a range can never cross a block or
    /// enter a task list.
    mutating func makeBlockStyleCommand(
        style: LoroNativeRichBlockStyle,
        selection: LoroNativeRichTextSelection,
        commandID: UUID = UUID(),
        requestToken: Int = 0
    ) -> LoroNativeRichBlockStyleCommand? {
        guard composition == nil,
              selection.location >= 0,
              selection.length >= 0,
              selection.location <= Int.max - selection.length,
              let (index, start, length, block) = blockContaining(selection.location)
        else { return nil }
        let end = selection.location + selection.length
        guard end <= start + length,
              !(selection.length == 0 && selection.location == start + length && index + 1 < admittedDocument.semantic.blocks.count),
              LoroNativeRichBlockStyle.forBlock(block) != nil
        else { return nil }
        return .init(
            commandID: commandID,
            requestToken: requestToken,
            editorGeneration: documentGeneration,
            style: style,
            selection: selection,
            topLevelBlockIndex: index,
            expectedBlock: block
        )
    }

    func blockStyleState(for selection: LoroNativeRichTextSelection) -> LoroNativeRichBlockStyleState {
        guard selection.location >= 0,
              selection.length >= 0,
              selection.location <= Int.max - selection.length,
              let (index, start, length, block) = blockContaining(selection.location),
              selection.location + selection.length <= start + length,
              !(selection.length == 0 && selection.location == start + length && index + 1 < admittedDocument.semantic.blocks.count),
              let current = LoroNativeRichBlockStyle.forBlock(block)
        else { return .disabled }
        return .init(current: current, isEnabled: composition == nil && pendingLocalDocument == nil)
    }

    /// Applies a previously captured request only when its generation, structural index, block
    /// value, and scalar witness still describe this editor. A same-style request is a semantic
    /// no-op and therefore cannot produce a second document-change callback.
    mutating func applyBlockStyle(_ command: LoroNativeRichBlockStyleCommand) -> LoroNativeRichEditingEffect {
        guard composition == nil,
              command.editorGeneration == documentGeneration,
              command.topLevelBlockIndex >= 0,
              command.topLevelBlockIndex < admittedDocument.semantic.blocks.count,
              admittedDocument.semantic.blocks[command.topLevelBlockIndex] == command.expectedBlock,
              let (index, start, length, block) = blockContaining(command.selection.location),
              index == command.topLevelBlockIndex,
              block == command.expectedBlock,
              command.selection.location + command.selection.length <= start + length,
              !(command.selection.length == 0 && command.selection.location == start + length && index + 1 < admittedDocument.semantic.blocks.count),
              LoroNativeRichBlockStyle.forBlock(block) != nil
        else { return .rejected(.invalidEdit) }

        guard let replacement = transformedBlock(command.expectedBlock, as: command.style) else {
            return .rejected(.invalidEdit)
        }
        guard replacement != command.expectedBlock else { return .noChange }
        var blocks = admittedDocument.semantic.blocks
        blocks[command.topLevelBlockIndex] = replacement
        let candidate = LoroNativeRichDocumentV1(semantic: .init(blocks: blocks))
        return admit(candidate, selection: command.selection)
    }

    private func blockContaining(_ offset: Int) -> (index: Int, start: Int, length: Int, block: LoroCanonicalSemanticValueV1.Block)? {
        guard offset >= 0 else { return nil }
        var cursor = 0
        for (index, block) in admittedDocument.semantic.blocks.enumerated() {
            let length = scalarLength(of: block)
            if offset <= cursor + length {
                return (index, cursor, length, block)
            }
            cursor += length + 1
        }
        return nil
    }

    private func scalarLength(of block: LoroCanonicalSemanticValueV1.Block) -> Int {
        switch block {
        case let .paragraph(runs), let .heading(_, runs):
            return runs.reduce(0) { $0 + $1.text.unicodeScalars.count }
        case let .taskList(items):
            return items.reduce(0) { total, item in
                total + item.runs.reduce(0) { $0 + $1.text.unicodeScalars.count }
            } + max(0, items.count - 1)
        }
    }

    private func transformedBlock(_ source: LoroCanonicalSemanticValueV1.Block, as style: LoroNativeRichBlockStyle) -> LoroCanonicalSemanticValueV1.Block? {
        switch source {
        case let .paragraph(runs):
            if let level = style.headingLevel { return .heading(level: level, runs: runs) }
            return .paragraph(runs)
        case let .heading(_, runs):
            if let level = style.headingLevel { return .heading(level: level, runs: runs) }
            return .paragraph(runs)
        case .taskList:
            return nil
        }
    }

    /// Revalidates the flattened Unicode-scalar witness before an acknowledgement can adopt a
    /// document. This keeps a forged or stale command from moving focus to a different block.
    func isValidTaskListInsertionWitness(_ command: LoroNativeRichTaskListInsertionCommand) -> Bool {
        guard command.editorGeneration == documentGeneration,
              command.topLevelBlockIndex >= 0,
              command.topLevelBlockIndex < admittedDocument.semantic.blocks.count,
              admittedDocument.semantic.blocks[command.topLevelBlockIndex] == command.expectedBlock else { return false }
        let blockStart = admittedDocument.semantic.blocks.prefix(command.topLevelBlockIndex).reduce(0) { total, block in
            let length: Int
            switch block {
            case let .paragraph(runs), let .heading(_, runs):
                length = runs.reduce(0) { $0 + $1.text.unicodeScalars.count }
            case let .taskList(items):
                length = items.reduce(0) { $0 + $1.runs.reduce(0) { $0 + $1.text.unicodeScalars.count } } + max(0, items.count - 1)
            }
            return total + length + 1
        }
        let blockLength: Int
        switch command.expectedBlock {
        case let .paragraph(runs), let .heading(_, runs):
            blockLength = runs.reduce(0) { $0 + $1.text.unicodeScalars.count }
        case .taskList: return false
        }
        return command.collapsedScalarOffset >= blockStart && command.collapsedScalarOffset <= blockStart + blockLength
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
        documentGeneration &+= 1
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
        typealias TaskItem = LoroCanonicalSemanticValueV1.TaskItem
        enum LogicalKind: Equatable {
            case paragraph
            case heading(Int)
            case task(listIndex: Int, itemIndex: Int, checked: Bool)
        }
        struct LogicalLine {
            let blockIndex: Int
            let itemIndex: Int?
            let kind: LogicalKind
            let runs: [Run]
        }
        func runs(in block: Block) -> [Run] {
            switch block {
            case let .paragraph(runs), let .heading(_, runs): return runs
            case let .taskList(items): return items.flatMap(\.runs)
            }
        }
        func scalarCount(_ runs: [Run]) -> Int { runs.reduce(0) { $0 + $1.text.unicodeScalars.count } }
        func makeLike(_ kind: LogicalKind, runs: [Run]) -> Block {
            switch kind {
            case .paragraph: return .paragraph(runs)
            case let .heading(level): return .heading(level: level, runs: runs)
            case let .task(listIndex, _, checked):
                // This branch is used only for a single-line task replacement. The caller
                // reconstructs the containing list below so adjacent items never flatten into
                // ordinary paragraphs.
                _ = listIndex
                return .taskList([.init(checked: checked, runs: runs)])
            }
        }
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

        var logicalLines: [LogicalLine] = []
        for (blockIndex, block) in document.semantic.blocks.enumerated() {
            switch block {
            case let .paragraph(runs): logicalLines.append(.init(blockIndex: blockIndex, itemIndex: nil, kind: .paragraph, runs: runs))
            case let .heading(level, runs): logicalLines.append(.init(blockIndex: blockIndex, itemIndex: nil, kind: .heading(level), runs: runs))
            case let .taskList(items):
                for (itemIndex, item) in items.enumerated() {
                    logicalLines.append(.init(blockIndex: blockIndex, itemIndex: itemIndex, kind: .task(listIndex: blockIndex, itemIndex: itemIndex, checked: item.checked), runs: item.runs))
                }
            }
        }
        guard !logicalLines.isEmpty else { return nil }
        var starts: [Int] = []; var cursor = 0
        for line in logicalLines { starts.append(cursor); cursor += scalarCount(line.runs) + 1 }
        let totalScalars = rendered.string.unicodeScalars.count
        func owningLine(for scalarOffset: Int) -> Int? {
            guard scalarOffset <= totalScalars else { return nil }
            for index in logicalLines.indices {
                let end = starts[index] + scalarCount(logicalLines[index].runs)
                if scalarOffset >= starts[index], scalarOffset <= end { return index }
            }
            return nil
        }
        let scalarEnd = scalarRange.location + scalarRange.length
        guard let lineIndex = owningLine(for: scalarRange.location), owningLine(for: scalarEnd) == lineIndex else { return nil }
        let line = logicalLines[lineIndex]
        let originalRuns = line.runs
        let localStart = scalarRange.location - starts[lineIndex]
        let localEnd = scalarEnd - starts[lineIndex]
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
            if case let .task(listIndex, itemIndex, checked) = line.kind {
                guard case let .taskList(items) = document.semantic.blocks[line.blockIndex], itemIndex < items.count else { return nil }
                var replacementItems: [TaskItem] = []
                for index in lines.indices {
                    var lineRuns = index == lines.startIndex ? prefix : []
                    if !lines[index].isEmpty { lineRuns.append(.init(text: lines[index], marks: inherited)) }
                    if index == lines.index(before: lines.endIndex) { lineRuns += suffix }
                    replacementItems.append(.init(checked: index == lines.startIndex ? checked : false, runs: coalesced(lineRuns)))
                }
                var blocks = document.semantic.blocks
                var updatedItems = items
                updatedItems.replaceSubrange(itemIndex...itemIndex, with: replacementItems)
                blocks[line.blockIndex] = .taskList(updatedItems)
                _ = listIndex
                return .init(semantic: .init(blocks: blocks))
            }
            var emitted: [Block] = []
            for index in lines.indices {
                var lineRuns = index == lines.startIndex ? prefix : []
                if !lines[index].isEmpty { lineRuns.append(.init(text: lines[index], marks: inherited)) }
                if index == lines.index(before: lines.endIndex) { lineRuns += suffix }
                emitted.append(index == lines.startIndex ? makeLike(line.kind, runs: coalesced(lineRuns)) : .paragraph(coalesced(lineRuns)))
            }
            var blocks = document.semantic.blocks
            blocks.replaceSubrange(line.blockIndex...line.blockIndex, with: emitted)
            return .init(semantic: .init(blocks: blocks))
        case let .inlineReference(reference):
            guard !reference.label.contains("\n"), !reference.label.contains("\r"), !reference.label.isEmpty else { return nil }
            let runs = coalesced(prefix + [.init(text: reference.label, reference: reference)] + suffix)
            var blocks = document.semantic.blocks
            if case let .task(_, itemIndex, checked) = line.kind,
               case let .taskList(items) = blocks[line.blockIndex], itemIndex < items.count {
                var updatedItems = items
                updatedItems[itemIndex] = .init(checked: checked, runs: runs)
                blocks[line.blockIndex] = .taskList(updatedItems)
            } else {
                blocks[line.blockIndex] = makeLike(line.kind, runs: runs)
            }
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
