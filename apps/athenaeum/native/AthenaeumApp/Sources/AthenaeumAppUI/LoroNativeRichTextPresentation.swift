import Foundation
import AthenaeumCore

/// A deterministic, value-only presentation plan for the native rich editor.
///
/// The codec remains the only representation that can be decoded or submitted. This plan is
/// derived from a canonical document and the codec's controlled, marker-only render, then gives
/// each platform enough UTF-16 topology to add temporary typography without putting fonts,
/// colours, or paragraph styles in semantic storage.
enum LoroNativeRichTextPresentation {
    enum BlockRole: Equatable, Sendable {
        case paragraph
        case heading(Int)
        case task
    }

    enum ReferenceKind: Equatable, Sendable {
        case entity
        case supertag
    }

    struct ContentSpan: Equatable, Sendable {
        let range: NSRange
        let marks: [LoroCanonicalSemanticValueV1.Mark]
        let reference: ReferenceKind?
    }

    struct Block: Equatable, Sendable {
        /// The top-level semantic block index. Task-list items share their list's index.
        let index: Int
        /// The item index is present only for a task-list item.
        let itemIndex: Int?
        let role: BlockRole
        /// Content only. Separators are never included in an inline span or a non-empty block.
        let contentRange: NSRange
        /// The range that owns paragraph-level temporary presentation. For non-empty blocks this
        /// is content; for empty blocks it is one uniquely-owned separator/newline.
        let presentationRange: NSRange
        /// The block's following separator, or the terminal marker-bearing newline for a sole
        /// empty heading/task item. This is topology only; adapters style presentationRange.
        let separatorRange: NSRange?
    }

    struct Plan: Equatable, Sendable {
        let blocks: [Block]
        let spans: [ContentSpan]
        let renderedUTF16Length: Int
    }

    /// The adapters apply these roles in this order: block typography, combined marks, then
    /// typed-reference decoration. The metadata is useful to tests and documents the contract;
    /// the plan itself contains no platform presentation objects.
    static let metadataPrecedence: [String] = ["block", "marks", "reference"]

    private struct LogicalBlock {
        let index: Int
        let itemIndex: Int?
        let role: BlockRole
        let runs: [LoroCanonicalSemanticValueV1.TextRun]
    }

    /// Build only from the canonical value and the controlled codec render. A failable result is
    /// intentional: malformed levels or a future codec topology change must fail closed rather
    /// than produce a range that could decorate a neighbouring block.
    static func make(for document: LoroNativeRichDocumentV1) -> Plan? {
        guard let rendered = try? LoroNativeRichTextCodec.attributedString(for: document),
              !document.semantic.blocks.isEmpty else { return nil }

        var logicalBlocks: [LogicalBlock] = []
        for (index, block) in document.semantic.blocks.enumerated() {
            switch block {
            case let .paragraph(runs):
                logicalBlocks.append(.init(index: index, itemIndex: nil, role: .paragraph, runs: runs))
            case let .heading(level, runs):
                guard (1...3).contains(level) else { return nil }
                logicalBlocks.append(.init(index: index, itemIndex: nil, role: .heading(level), runs: runs))
            case let .taskList(items):
                guard !items.isEmpty else { return nil }
                for (itemIndex, item) in items.enumerated() {
                    logicalBlocks.append(.init(index: index, itemIndex: itemIndex, role: .task, runs: item.runs))
                }
            }
        }
        guard !logicalBlocks.isEmpty else { return nil }

        var blocks: [Block] = []
        var spans: [ContentSpan] = []
        var cursor = 0

        for (logicalIndex, logical) in logicalBlocks.enumerated() {
            let start = cursor
            for run in logical.runs {
                let length = run.text.utf16.count
                guard length > 0,
                      let range = Range(NSRange(location: cursor, length: length), in: rendered.string),
                      String(rendered.string[range]) == run.text else { return nil }
                let reference: ReferenceKind? = switch run.reference?.kind {
                case .entity: .entity
                case .supertag: .supertag
                case nil: nil
                }
                spans.append(.init(range: NSRange(location: cursor, length: length), marks: run.marks, reference: reference))
                cursor += length
            }

            let contentRange = NSRange(location: start, length: cursor - start)
            let followingSeparator: NSRange?
            if logicalIndex < logicalBlocks.index(before: logicalBlocks.endIndex) {
                guard cursor < rendered.length,
                      rendered.string.utf16[rendered.string.utf16.index(rendered.string.utf16.startIndex, offsetBy: cursor)] == 10 else {
                    return nil
                }
                followingSeparator = NSRange(location: cursor, length: 1)
                cursor += 1
            } else {
                followingSeparator = nil
            }

            // A content-less block owns one adjacent separator. Prefer the following separator;
            // a trailing empty block instead owns its preceding separator. For the codec's sole
            // empty heading/task encoding, the terminal marker-bearing newline is the only range.
            let terminalSeparator: NSRange? = logical.runs.isEmpty && logicalBlocks.count == 1 && rendered.length == 1
                ? NSRange(location: start, length: 1)
                : nil
            let precedingSeparator: NSRange? = logicalIndex > logicalBlocks.startIndex
                ? NSRange(location: start - 1, length: 1)
                : nil
            let presentationRange: NSRange
            let separatorRange: NSRange?
            if contentRange.length > 0 {
                presentationRange = contentRange
                separatorRange = followingSeparator
            } else if let followingSeparator {
                presentationRange = followingSeparator
                separatorRange = followingSeparator
            } else if let precedingSeparator {
                // A trailing empty block can be adjacent to another empty block. The preceding
                // newline may already belong to that earlier block's following separator, so do
                // not let two blocks claim one character. The first block remains the stable
                // owner and this trailing block falls back to a zero-length presentation range.
                let alreadyClaimed = blocks.contains {
                    NSIntersectionRange($0.presentationRange, precedingSeparator).length > 0
                }
                presentationRange = alreadyClaimed
                    ? .init(location: start, length: 0)
                    : precedingSeparator
                separatorRange = precedingSeparator
            } else if let terminalSeparator {
                presentationRange = terminalSeparator
                separatorRange = terminalSeparator
                cursor += 1
            } else if logicalBlocks.count == 1, rendered.length == 0, logical.role == .paragraph {
                // A single empty paragraph has no storage character to decorate. It is still a
                // valid canonical document; the view-wide body font supplies its caret surface.
                presentationRange = .init(location: 0, length: 0)
                separatorRange = nil
            } else {
                return nil
            }
            blocks.append(.init(index: logical.index, itemIndex: logical.itemIndex, role: logical.role,
                                contentRange: contentRange, presentationRange: presentationRange,
                                separatorRange: separatorRange))
        }

        guard cursor == rendered.length else { return nil }
        guard spans == spans.sorted(by: { $0.range.location < $1.range.location }) else { return nil }
        var previousEnd = 0
        for span in spans {
            guard span.range.location >= previousEnd,
                  span.range.location >= 0,
                  span.range.length > 0,
                  NSMaxRange(span.range) <= rendered.length else { return nil }
            previousEnd = NSMaxRange(span.range)
        }
        for block in blocks {
            guard block.contentRange.location >= 0,
                  block.contentRange.length >= 0,
                  NSMaxRange(block.contentRange) <= rendered.length,
                  block.presentationRange.location >= 0,
                  block.presentationRange.length > 0 || block.contentRange.length == 0,
                  NSMaxRange(block.presentationRange) <= rendered.length else { return nil }
            if let separator = block.separatorRange {
                guard separator.length == 1,
                      separator.location >= 0,
                      NSMaxRange(separator) <= rendered.length else { return nil }
            }
        }
        for firstIndex in blocks.indices {
            for secondIndex in blocks.indices where secondIndex > firstIndex {
                guard NSIntersectionRange(
                    blocks[firstIndex].presentationRange,
                    blocks[secondIndex].presentationRange
                ).length == 0 else { return nil }
            }
        }
        return .init(blocks: blocks, spans: spans, renderedUTF16Length: rendered.length)
    }
}

private extension String.UTF16View {
    subscript(at offset: Int) -> UInt16 {
        self[index(startIndex, offsetBy: offset)]
    }
}
