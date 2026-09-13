import XCTest
@testable import ApsidesCore

final class NoteShortcutsTests: XCTestCase {
    func testBlockPrefixesMatchTheWebInputRules() {
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "# "), .heading(1))
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "### "), .heading(3))
        XCTAssertNil(NoteShortcuts.blockShortcut(prefix: "#### "))
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "> "), .quote)
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "- "), .bullet)
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "* "), .bullet)
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "12. "), .ordered(start: 12))
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "[] "), .task(checked: false))
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "[ ] "), .task(checked: false))
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "[x] "), .task(checked: true))
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "```swift "), .code(language: "swift"))
        XCTAssertEqual(NoteShortcuts.blockShortcut(prefix: "``` "), .code(language: nil))
        XCTAssertNil(NoteShortcuts.blockShortcut(prefix: "#"))
        XCTAssertNil(NoteShortcuts.blockShortcut(prefix: "hello "))
        XCTAssertEqual(NoteShortcuts.fenceLanguage(paragraphText: "```Mermaid"), .some("mermaid"))
        XCTAssertEqual(NoteShortcuts.fenceLanguage(paragraphText: "```"), .some(nil))
        XCTAssertNil(NoteShortcuts.fenceLanguage(paragraphText: "``` not a fence"))
    }

    func testInlineDelimitersFormatTheEnclosedText() throws {
        let bold = try XCTUnwrap(NoteShortcuts.inlineShortcut(before: "say **hello**"))
        XCTAssertEqual(bold, .init(range: 4..<13, text: "hello", mark: .bold))
        let italic = try XCTUnwrap(NoteShortcuts.inlineShortcut(before: "an *idea*"))
        XCTAssertEqual(italic, .init(range: 3..<9, text: "idea", mark: .italic))
        XCTAssertNil(NoteShortcuts.inlineShortcut(before: "2*3*"))
        let strike = try XCTUnwrap(NoteShortcuts.inlineShortcut(before: "~~gone~~"))
        XCTAssertEqual(strike.mark, .strike)
        let code = try XCTUnwrap(NoteShortcuts.inlineShortcut(before: "run `swift test`"))
        XCTAssertEqual(code, .init(range: 4..<16, text: "swift test", mark: .code))
        XCTAssertNil(NoteShortcuts.inlineShortcut(before: "unfinished **bold"))
        XCTAssertNil(NoteShortcuts.inlineShortcut(before: "****"))
        let underscore = try XCTUnwrap(NoteShortcuts.inlineShortcut(before: "__b__"))
        XCTAssertEqual(underscore.mark, .bold)
    }

    func testSlashAndEntityTriggers() throws {
        XCTAssertEqual(NoteShortcuts.slashTrigger(before: "/"), .init(character: "/", range: 0..<1, query: ""))
        XCTAssertEqual(NoteShortcuts.slashTrigger(before: "/hea"), .init(character: "/", range: 0..<4, query: "hea"))
        XCTAssertNil(NoteShortcuts.slashTrigger(before: "a /hea"))
        XCTAssertNil(NoteShortcuts.slashTrigger(before: "/" + String(repeating: "a", count: 31)))
        let mention = try XCTUnwrap(NoteShortcuts.entityTrigger(before: "ping @Ada Lo"))
        XCTAssertEqual(mention, .init(character: "@", range: 5..<12, query: "Ada Lo"))
        let link = try XCTUnwrap(NoteShortcuts.entityTrigger(before: "#eng"))
        XCTAssertEqual(link.character, "#")
        XCTAssertEqual(link.range, 0..<4)
        XCTAssertNil(NoteShortcuts.entityTrigger(before: "email@example"))
        XCTAssertEqual(NoteShortcuts.newlineSplit("ab\ncd")?.before, "ab")
        XCTAssertEqual(NoteShortcuts.newlineSplit("ab\ncd")?.after, "cd")
        XCTAssertNil(NoteShortcuts.newlineSplit("abcd"))
    }
}
