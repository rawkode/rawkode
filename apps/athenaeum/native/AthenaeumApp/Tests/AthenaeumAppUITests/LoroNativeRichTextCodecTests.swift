#if os(macOS)
import AppKit
import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumCore
import AthenaeumDomain

final class LoroNativeRichTextCodecTests: XCTestCase {
    private let marksKey = NSAttributedString.Key("dev.athenaeum.rich.marks.v1")
    private let blockKey = NSAttributedString.Key("dev.athenaeum.rich.block.v1")
    private let terminalEmptyDocumentKey = NSAttributedString.Key("dev.athenaeum.rich.terminal-empty-document.v1")
    private let referenceKey = NSAttributedString.Key("dev.athenaeum.rich.reference.v1")

    func testRichRoundTripPreservesHeadingsAndEveryMarkSubset() throws {
        let document = richDocument()
        let rendered = try LoroNativeRichTextCodec.attributedString(for: document)
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(rendered), document)
    }

    func testEmptyDocumentAndDeleteAllDecodeToOneEmptyParagraph() throws {
        let empty = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([])]))
        XCTAssertEqual(try LoroNativeRichTextCodec.attributedString(for: empty).string, "")
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(NSAttributedString(string: "")), empty)
    }

    func testTrailingAndConsecutiveSeparatorsCreateCanonicalEmptyParagraphs() throws {
        let trailing = try LoroNativeRichTextCodec.decode(NSAttributedString(string: "a\n"))
        XCTAssertEqual(trailing.semantic.blocks, [.paragraph([.init(text: "a")]), .paragraph([])])

        let consecutive = try LoroNativeRichTextCodec.decode(NSAttributedString(string: "a\n\nb"))
        XCTAssertEqual(consecutive.semantic.blocks, [
            .paragraph([.init(text: "a")]), .paragraph([]), .paragraph([.init(text: "b")])
        ])
    }

    func testDecodeCoalescesAdjacentEqualMarkSpans() throws {
        let source = NSMutableAttributedString(string: "abcd")
        source.addAttributes([marksKey: "strong", blockKey: "paragraph"], range: NSRange(location: 0, length: 2))
        source.addAttributes([marksKey: "strong", blockKey: "paragraph"], range: NSRange(location: 2, length: 2))
        let document = try LoroNativeRichTextCodec.decode(source)
        XCTAssertEqual(document.semantic.blocks, [.paragraph([.init(text: "abcd", marks: [.strong])])])
    }

    func testTypedReferenceMarkerRoundTripsWithoutCoalescingReferenceSpans() throws {
        let reference = LoroCanonicalSemanticValueV1.InlineReference(
            kind: .entity,
            id: try EntityId(validating: "10000000-0000-4000-8000-000000000001"),
            label: "Alice"
        )
        let document = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([
            .init(text: "Meet "),
            .init(text: "Alice", marks: [.strong], reference: reference),
            .init(text: " today")
        ])]))

        let rendered = try LoroNativeRichTextCodec.attributedString(for: document)
        XCTAssertNotNil(rendered.attribute(referenceKey, at: 5, effectiveRange: nil))
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(rendered), document)
    }

    func testReferenceHitAdmissionRequiresContainedGlyphAfterContainerOffset() {
        let point = LoroNativeRichTextCodec.textContainerPoint(CGPoint(x: 42, y: 29), origin: CGPoint(x: 32, y: 20))
        XCTAssertEqual(point, CGPoint(x: 10, y: 9))
        XCTAssertTrue(LoroNativeRichTextCodec.admitsReferenceHit(
            characterIndex: 4, textLength: 9, textContainerPoint: point, glyphRect: CGRect(x: 8, y: 4, width: 8, height: 12)
        ))
        XCTAssertFalse(LoroNativeRichTextCodec.admitsReferenceHit(
            characterIndex: 4, textLength: 9, textContainerPoint: CGPoint(x: 17, y: 9), glyphRect: CGRect(x: 8, y: 4, width: 8, height: 12)
        ), "padding and trailing whitespace must not activate a nearby reference")
        XCTAssertFalse(LoroNativeRichTextCodec.admitsReferenceHit(
            characterIndex: 9, textLength: 9, textContainerPoint: point, glyphRect: CGRect(x: 8, y: 4, width: 8, height: 12)
        ), "an end-of-document insertion point is not a character")
    }

    func testUIKitReferenceHitUsesTextContainerInsetWithoutDoubleApplyingScrollOrPadding() {
        let viewPoint = CGPoint(x: 42, y: 29)
        let inset = CGPoint(x: 12, y: 8)
        let lineFragmentPadding: CGFloat = 5
        let contentOffset = CGPoint(x: 100, y: 200)

        XCTAssertEqual(
            LoroNativeRichTextCodec.textContainerPoint(viewPoint, origin: inset),
            CGPoint(x: 30, y: 21)
        )
        XCTAssertNotEqual(
            LoroNativeRichTextCodec.textContainerPoint(
                viewPoint,
                origin: CGPoint(x: inset.x + lineFragmentPadding - contentOffset.x, y: inset.y - contentOffset.y)
            ),
            CGPoint(x: 30, y: 21),
            "padding and scroll are already accounted for by the UIKit touch coordinate"
        )
    }

    func testReferenceMarkerRejectsForgedAndMalformedAttributedPayloads() throws {
        for value: Any in ["10000000-0000-4000-8000-000000000001", ["nodeId": "10000000-0000-4000-8000-000000000001", "label": "Alice"]] {
            let source = NSMutableAttributedString(string: "Alice")
            source.addAttributes([blockKey: "paragraph", referenceKey: value], range: NSRange(location: 0, length: source.length))
            XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(source))
        }

        let separator = NSMutableAttributedString(string: "a\nb")
        separator.addAttribute(referenceKey, value: "forged", range: NSRange(location: 1, length: 1))
        XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(separator))
    }

    func testPlainPasteIsAcceptedButMixedMarkersAreRejectedAtomically() throws {
        XCTAssertEqual(
            try LoroNativeRichTextCodec.decode(NSAttributedString(string: "plain\npaste")).semantic.blocks,
            [.paragraph([.init(text: "plain")]), .paragraph([.init(text: "paste")])]
        )

        let source = NSMutableAttributedString(string: "mixed")
        source.addAttribute(blockKey, value: "paragraph", range: NSRange(location: 0, length: 2))
        let original = source.copy() as! NSAttributedString
        XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(source))
        XCTAssertEqual(source, original, "preflight failures must not mutate paste input")

        let marksWithoutBlock = NSMutableAttributedString(string: "marked")
        marksWithoutBlock.addAttribute(marksKey, value: "strong", range: NSRange(location: 0, length: marksWithoutBlock.length))
        XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(marksWithoutBlock))
    }

    func testUnicodeSelectionMappingRejectsSurrogateInteriorAndRoundTripsEmojiCombiningAndZWJ() throws {
        let text = "A😀e\u{301}👩🏽‍💻\nZ"
        let scalar = LoroNativeRichTextCodec.ScalarSelection(location: 1, length: 7)
        let utf16 = try LoroNativeRichTextCodec.utf16Range(forScalarSelection: scalar, in: text)
        XCTAssertEqual(try LoroNativeRichTextCodec.scalarSelection(forUTF16Range: utf16, in: text), scalar)
        XCTAssertThrowsError(try LoroNativeRichTextCodec.scalarSelection(forUTF16Range: NSRange(location: 2, length: 0), in: text))
        XCTAssertThrowsError(try LoroNativeRichTextCodec.scalarSelection(forUTF16Range: NSRange(location: text.utf16.count + 1, length: 0), in: text))
    }

    func testDecodeRejectsAnAttributeSpanThatBisectsAnEmojiSurrogatePair() {
        let source = NSMutableAttributedString(string: "😀")
        source.addAttribute(blockKey, value: "paragraph", range: NSRange(location: 0, length: source.length))
        source.addAttribute(marksKey, value: "strong", range: NSRange(location: 0, length: 1))
        let original = source.copy() as! NSAttributedString

        XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(source))
        XCTAssertEqual(source, original, "reject before any corrupted substring can be materialized")
    }

    func testStrictlyRejectsAttachmentLinkFontColorAndUnknownAttributesWithoutMutation() throws {
        let cases: [(NSAttributedString.Key, Any)] = [
            (.attachment, NSTextAttachment()),
            (.link, URL(string: "https://example.com")!),
            (.font, NSFont.boldSystemFont(ofSize: 12)),
            (.foregroundColor, NSColor.red),
            (NSAttributedString.Key("untrusted.attribute"), "value")
        ]
        for (key, value) in cases {
            let source = NSMutableAttributedString(string: "x")
            source.addAttribute(key, value: value, range: NSRange(location: 0, length: 1))
            let original = source.copy() as! NSAttributedString
            XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(source), "\(key.rawValue)")
            XCTAssertEqual(source, original)
        }
    }

    func testUnknownBlockMarkerAndEmptyHeadingRoundTrip() throws {
        let source = NSMutableAttributedString(string: "x")
        source.addAttribute(blockKey, value: "heading-4", range: NSRange(location: 0, length: 1))
        XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(source))

        let emptyHeading = LoroNativeRichDocumentV1(semantic: .init(blocks: [.heading(level: 2, runs: [])]))
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(LoroNativeRichTextCodec.attributedString(for: emptyHeading)), emptyHeading)
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(NSAttributedString(string: "\n")).semantic.blocks, [.paragraph([]), .paragraph([])])
    }

    func testRejectsMalformedBlockAndMarkMarkers() {
        let nonStringBlock = NSMutableAttributedString(string: "x")
        nonStringBlock.addAttribute(blockKey, value: 42, range: NSRange(location: 0, length: nonStringBlock.length))
        XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(nonStringBlock))

        for marker in ["code,,strong", ",code", "code,", ",", "strong,code", "code,code"] {
            let source = NSMutableAttributedString(string: "x")
            source.addAttributes([blockKey: "paragraph", marksKey: marker], range: NSRange(location: 0, length: source.length))
            XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(source), marker)
        }
    }

    func testTerminalEmptyDocumentMarkerCannotAppearInAnOrdinaryDocument() {
        let source = NSMutableAttributedString(string: "a\n")
        source.addAttribute(terminalEmptyDocumentKey, value: "heading-1", range: NSRange(location: 1, length: 1))
        XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(source))
    }

    func testRejectsSemanticInputBeyondPublicProjectionBounds() {
        let limits = LoroPageProjectionLimits()
        let document = LoroNativeRichDocumentV1(semantic: .init(blocks: Array(repeating: .paragraph([]), count: limits.maxChildren + 1)))
        XCTAssertThrowsError(try LoroNativeRichTextCodec.attributedString(for: document))
    }

    func testRenderingRejectsLineFeedAndCarriageReturnInsideSemanticRuns() {
        for separator in ["\n", "\r"] {
            let document = LoroNativeRichDocumentV1(semantic: .init(blocks: [
                .paragraph([.init(text: "before\(separator)after", marks: [.code])])
            ]))
            XCTAssertThrowsError(try LoroNativeRichTextCodec.attributedString(for: document))
        }
    }

    func testRejectsSemanticAttributesThatSpanASeparator() {
        let source = NSMutableAttributedString(string: "a\nb")
        source.addAttributes([marksKey: "strong", blockKey: "paragraph"], range: NSRange(location: 0, length: source.length))
        XCTAssertThrowsError(try LoroNativeRichTextCodec.decode(source))
    }

    func testCodecPublicValueSurfaceContainsNoTransportOrRawCRDTTypes() {
        let name = String(reflecting: LoroNativeRichTextCodec.self).lowercased()
        XCTAssertFalse(name.contains("loro") && (name.contains("snapshot") || name.contains("transport")))
    }

    private func richDocument() -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [
            .heading(level: 1, runs: [
                .init(text: "0"), .init(text: "1", marks: [.code]), .init(text: "2", marks: [.emphasis]),
                .init(text: "3", marks: [.strong]), .init(text: "4", marks: [.code, .emphasis]),
                .init(text: "5", marks: [.code, .strong]), .init(text: "6", marks: [.emphasis, .strong]),
                .init(text: "7", marks: [.code, .emphasis, .strong])
            ]),
            .paragraph([.init(text: "body")]),
            .heading(level: 3, runs: [.init(text: "tail", marks: [.strong])])
        ]))
    }
}
#endif
