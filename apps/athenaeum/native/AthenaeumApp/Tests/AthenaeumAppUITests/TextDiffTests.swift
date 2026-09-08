import XCTest
@testable import AthenaeumAppUI

/// Offline unit tests for `diffText` — the app layer's own port of `web/src/automerge-page.ts`'s
/// `diffText`, re-verified here against UTF-16 semantics specifically (see `TextDiff.swift`'s top
/// doc comment for why grapheme-cluster indexing would be wrong for this call site).
final class TextDiffTests: XCTestCase {
    func testIdenticalStringsReturnNil() {
        XCTAssertNil(diffText(before: "hello", after: "hello"))
    }

    func testPureInsertionAtEnd() {
        let edit = diffText(before: "one", after: "one two")
        XCTAssertEqual(edit, TextEdit(index: 3, deleteCount: 0, insertText: " two"))
    }

    func testPureInsertionAtStart() {
        let edit = diffText(before: "world", after: "hello world")
        XCTAssertEqual(edit, TextEdit(index: 0, deleteCount: 0, insertText: "hello "))
    }

    func testPureDeletion() {
        let edit = diffText(before: "hello world", after: "hello")
        XCTAssertEqual(edit, TextEdit(index: 5, deleteCount: 6, insertText: ""))
    }

    func testMiddleReplacement() {
        let edit = diffText(before: "the cat sat", after: "the dog sat")
        XCTAssertEqual(edit, TextEdit(index: 4, deleteCount: 3, insertText: "dog"))
    }

    func testEntireStringReplaced() {
        let edit = diffText(before: "abc", after: "xyz")
        XCTAssertEqual(edit, TextEdit(index: 0, deleteCount: 3, insertText: "xyz"))
    }

    func testEmptyToNonEmpty() {
        let edit = diffText(before: "", after: "hello")
        XCTAssertEqual(edit, TextEdit(index: 0, deleteCount: 0, insertText: "hello"))
    }

    /// The load-bearing case per this file's top doc comment: a multi-UTF-16-code-unit grapheme
    /// (an emoji, here U+1F600 "😀", 2 UTF-16 code units) inserted after plain ASCII text — proves
    /// indices are counted in UTF-16 code units, matching `PageDocumentStore.applyLocalSplice`'s
    /// documented contract, not Swift's default `Character`-based (grapheme-cluster) indexing.
    func testHandlesSurrogatePairCorrectly() {
        let before = "hi 😀"
        let after = "hi 😀!"
        let edit = diffText(before: before, after: after)
        // "hi " = 3 UTF-16 units, 😀 = 2 UTF-16 units -> insertion point is UTF-16 index 5.
        XCTAssertEqual(edit, TextEdit(index: 5, deleteCount: 0, insertText: "!"))
    }
}
