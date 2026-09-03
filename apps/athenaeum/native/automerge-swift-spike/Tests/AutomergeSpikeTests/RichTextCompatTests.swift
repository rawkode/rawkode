import XCTest
import Automerge
@testable import AutomergeSpike

/// Empirical evidence for rich-text-editor-decisions.md item 2 ("Native cross-compatibility").
/// `richDocBase64` is the exact output of
/// `native/automerge-swift-spike/scratch-block-test/make-rich-doc.mjs`, run against the SAME
/// @automerge/automerge 3.4.1 build installed in packages/web — a document containing real
/// heading/paragraph/list-item block markers (via A.splitBlock, the same primitive
/// @automerge/prosemirror's traversal.ts drives) plus one inline "strong" mark, saved with
/// `Automerge.save()`. This is what @automerge/prosemirror will actually write to the wire once
/// wired into the real editor. This test loads those exact bytes through automerge-swift 0.7.2 —
/// the unchanged native dependency — and reports, empirically, what happens.
final class RichTextCompatTests: XCTestCase {
    // swiftlint:disable:next line_length
    static let richDocBase64 = "hW9Kg3MPK14A7gQBEFU1COj5xhloZk3lMpmyIF4BrorfO+beKrOCv11P4PJA2REYa7Y2xFCLkyRr52Zc2RUHAQIDAhMKIwhABEMEVgINAQUCExEHEyUVgAEhAyM3NAZCL1YxV3qAAQOlAQwHAAcBfAHBAAYFAgZ/An+/uKHUBgYAfwAGAX8ABQEHBwAB2gAAAAHHAAEEQ39EBEkETn9RBFR/VwADxQAAABMAAQIAfwIKAX8AFgF/AAQBfwANAX8ACQF/AAUBAA1/v38ABH8AfwR0ZXh0AEdzBWF0dHJzB2lzRW1iZWQHcGFyZW50cwR0eXBlBWxldmVsBWF0dHJzB2lzRW1iZWQHcGFyZW50cwR0eXBlBWF0dHJzB2lzRW1iZWQHcGFyZW50cwR0eXBlAAF8BWF0dHJzB2lzRW1iZWQHcGFyZW50cwR0eXBlAAHbAAB9AcIAv38KAX49RBUBfjhJAwF+NUwMAX4bZggBfhhpBQECAgIBfn0FAwF/AgIBfQJ/AwIBfgJ/AUcNAQQBfgQACwF/ABYBfwcEAX8HDQF/AAkBfwAGAX0AAQICAXkAAQIBAAECAgF9AAECAgECAAsWfwAWFn8CBBZ/AA0WfwAJFn8ABhZtAAEAdhQAAQCWAQABAJYBtgEAAQCWAbYBSGVhZGluZyBPbmVGaXJzdCBwYXJhZ3JhcGgsIHdpdGggYm9sZCB0ZXh0IGluIGl0Lkl0ZW0gb25lSXRlbSB0d29oZWFkaW5nAXBhcmFncmFwaGxpc3QtaXRlbWJ1bGxldC1saXN0bGlzdC1pdGVtYnVsbGV0LWxpc3TbAAAAJH8Gc3Ryb25nADYG"

    func loadRichDoc() throws -> (doc: Document, textId: ObjId) {
        guard let bytes = Data(base64Encoded: Self.richDocBase64) else {
            XCTFail("bad base64 fixture")
            throw PageDocumentStoreErrorForTest.badFixture
        }
        let doc = try Document(bytes)
        guard case let .Object(textId, .Text) = try doc.get(obj: ObjId.ROOT, key: "text") else {
            XCTFail("expected root.text to be a Text object")
            throw PageDocumentStoreErrorForTest.badFixture
        }
        return (doc, textId)
    }

    /// FINDING 1: loading a document containing block markers + marks does NOT crash or throw —
    /// automerge-swift 0.7.2's `Document(bytes:)` is fully agnostic to what the "text" object's
    /// contents mean; it just deserializes the general-purpose CRDT structure.
    func testLoadRichDocDoesNotCrash() throws {
        XCTAssertNoThrow(try loadRichDoc())
    }

    /// FINDING 2 (the load-bearing one): `.text(obj:)` — automerge-swift 0.7.2's ONLY API for
    /// reading a Text object as a Swift String, and the API `PageDocumentStore.text(nodeId:)`
    /// (the real production code) actually calls — returns the block markers as literal U+FFFC
    /// OBJECT REPLACEMENT CHARACTER glyphs interleaved with the real text, exactly matching what
    /// @automerge/automerge's own plain `doc.text` property produced JS-side (see
    /// make-rich-doc.mjs's own printed output: `"￼Heading One￼First paragraph...`).
    /// This is neither a crash nor silent content loss — it is GARBLED TEXT: every heading/
    /// paragraph/list-item boundary becomes a visible mojibake glyph inline with real prose, and
    /// native's existing flat-text editor would render/allow-editing that garbled string as-is.
    func testTextReadIsGarbledWithReplacementCharacters() throws {
        let (doc, textId) = try loadRichDoc()
        let text = try doc.text(obj: textId)
        print("=== automerge-swift .text(obj:) output ===\n\(text)\n=== (length: \(text.count)) ===")

        let replacementCharCount = text.unicodeScalars.filter { $0.value == 0xFFFC }.count
        // 4 block markers were written (heading, paragraph, 2x list-item).
        XCTAssertEqual(replacementCharCount, 4, "expected one U+FFFC per block marker")
        XCTAssertTrue(text.contains("\u{FFFC}Heading One"))
        // The real prose content is still present and uncorrupted around the markers — this is
        // NOT data loss, it is unreadable structural noise mixed into otherwise-correct text.
        XCTAssertTrue(text.contains("bold"))
    }

    /// FINDING 3: automerge-swift 0.7.2 DOES expose a real Marks API (`doc.marks(obj:)`,
    /// confirmed present in Sources/Automerge/Marks.swift and exercised by automerge-swift's own
    /// TestMarks.swift) — but `PageDocumentStore`'s production code never calls it. A native app
    /// COULD read marks if it wanted to; today it doesn't, so from the existing flat-text editor's
    /// perspective, marks are silently invisible (not corrupting, just unreflected) — consistent
    /// with automerge-swift being ABLE to represent marks (they're a stable, mature Automerge
    /// primitive, unlike block markers) while block markers are the real gap.
    func testMarksAreReadableEvenThoughUnused() throws {
        let (doc, textId) = try loadRichDoc()
        let marks = try doc.marks(obj: textId)
        print("=== automerge-swift .marks(obj:) output ===\n\(marks)")
        XCTAssertEqual(marks.count, 1)
        XCTAssertEqual(marks.first?.name, "strong")
    }

    /// FINDING 4 (the actual corruption mechanism, proven not just asserted): a native-originated
    /// `spliceText` at an index that lands ON a block marker's position — indistinguishable from
    /// any other index to code that only ever sees the garbled flat string from Finding 2 — does
    /// not fail or throw. It silently deletes/overwrites the block-marker MAP OBJECT itself,
    /// exactly as if it were an ordinary character. This is the concrete "native local edit
    /// corrupts a rich note" failure mode item 6's defensive mechanism must prevent.
    func testNativeSpliceAcrossBlockMarkerDeletesTheMarker() throws {
        let (doc, textId) = try loadRichDoc()
        let before = try doc.text(obj: textId)
        XCTAssertTrue(before.hasPrefix("\u{FFFC}Heading"))

        // A native user places their cursor at index 0 (the very start of the document, which the
        // flat-text editor renders as being right before the mojibake glyph) and presses
        // Backspace-then-retype, or simply a leading autocorrect edit — `spliceText(start: 0,
        // delete: 1, ...)` — completely ordinary native editing, unaware anything structural sits
        // at index 0.
        try doc.spliceText(obj: textId, start: 0, delete: 1, value: "")

        let after = try doc.text(obj: textId)
        print("=== after native-style splice at index 0 ===\n\(after)")

        // The leading marker glyph is now gone from the flat text...
        XCTAssertFalse(after.hasPrefix("\u{FFFC}"))
        // ...because the underlying block marker object was deleted outright, not because the
        // marker's `type`/`attrs` were preserved and just rendered differently: `A.block()`
        // JS-side (or automerge-swift's own equivalent structural read) no longer finds a block
        // marker at that position at all once these bytes round-trip back through
        // @automerge/automerge — see this file's sibling script
        // `scratch-block-test/verify-corruption.mjs` for the JS-side confirmation of exactly this,
        // run against the bytes this test saves out.
        let corruptedBytes = doc.save()
        try corruptedBytes.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("corrupted-by-native.automerge"))
        print("=== corrupted doc bytes written to \(FileManager.default.temporaryDirectory.appendingPathComponent("corrupted-by-native.automerge").path) ===")
    }
}

enum PageDocumentStoreErrorForTest: Error {
    case badFixture
}
