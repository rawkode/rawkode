import Foundation
import XCTest
@testable import EnchiridionCore

final class NoteInlineTextTests: XCTestCase {
    private func normalized(_ inline: [NoteNode]) -> [NoteNode] {
        var result: [NoteNode] = []
        for var node in inline {
            node.marks = node.marks?.sorted { $0.type.rawValue < $1.type.rawValue }
            if node.type == .text, let last = result.last, last.type == .text, last.marks == node.marks {
                result[result.count - 1].text = (last.text ?? "") + (node.text ?? "")
            } else {
                result.append(node)
            }
        }
        return result
    }

    func testEveryFixtureBlockProjectsAndReadsBackLosslessly() throws {
        let document = try NoteFixture.document()
        var checked = 0
        for block in document.blocks where block.node.type != .codeBlock {
            let text = NoteInlineText.attributed(block.node.children)
            XCTAssertEqual(normalized(NoteInlineText.inline(text)), normalized(block.node.children), "block \(block.path)")
            checked += 1
        }
        XCTAssertGreaterThan(checked, 8)
        let all = Data(NoteFixture.canonicalEntityNote.utf8)
        let entities = try NoteDocument.decode(all).content[0].children
        XCTAssertEqual(NoteInlineText.inline(NoteInlineText.attributed(entities)), entities)
    }

    func testHardBreaksAndLiteralSeparatorsStayDistinct() throws {
        let inline: [NoteNode] = [.text("a"), .hardBreak(marks: [.bold]), .text("é\u{2028}literal"), .text("x\u{FFFC}y")]
        let text = NoteInlineText.attributed(inline)
        XCTAssertEqual(String(text.characters), "a\u{2028}é\u{2028}literalx\u{FFFC}y")
        XCTAssertEqual(NoteInlineText.inline(text), [.text("a"), .hardBreak(marks: [.bold]), .text("é\u{2028}literalx\u{FFFC}y")])
        var typed = AttributedString("one\ntwo")
        typed.noteItalic = true
        XCTAssertEqual(NoteInlineText.inline(typed), [.text("one", marks: [.italic]), .hardBreak(marks: [.italic]), .text("two", marks: [.italic])])
    }

    func testSegmentsSplitAtComponentsWithATrailingCaretSegment() throws {
        let document = try NoteFixture.document()
        let paragraph = try XCTUnwrap(document.node(at: NotePath(7)))
        let segments = NoteInlineText.segments(NoteInlineText.attributed(paragraph.children))
        XCTAssertEqual(segments.count, 7)
        guard case .text(let head, let headRange) = segments[0], case .component(let first, let offset) = segments[1],
              case .text(let tail, let tailRange) = segments[6] else { return XCTFail("unexpected segments") }
        XCTAssertEqual(String(head.characters), "Before ")
        XCTAssertEqual(headRange, 0..<7)
        XCTAssertEqual(first.kind, .diagram)
        XCTAssertEqual(offset, 7)
        XCTAssertEqual(String(tail.characters), " after.")
        XCTAssertEqual(tailRange, 12..<19)

        let ending = NoteInlineText.segments(NoteInlineText.attributed([.text("x"), .component(.default(.link))]))
        XCTAssertEqual(ending.count, 3)
        guard case .text(let empty, let range) = ending[2] else { return XCTFail("no trailing segment") }
        XCTAssertTrue(empty.characters.isEmpty)
        XCTAssertEqual(range, 2..<2)
        XCTAssertEqual(NoteInlineText.segments(AttributedString()).count, 1)
    }

    func testEditingATextSegmentReplacesOnlyThatRange() throws {
        let document = try NoteFixture.document()
        let paragraph = try XCTUnwrap(document.node(at: NotePath(7)))
        var edited = AttributedString("Before ")
        edited += AttributedString("bold", attributes: NoteInlineText.attributes([.bold]))
        edited += AttributedString(" ")
        let result = NoteInlineText.replacing(paragraph.children, characters: 0..<7, with: edited)
        XCTAssertEqual(result.prefix(3), [.text("Before "), .text("bold", marks: [.bold]), .text(" ")])
        XCTAssertEqual(result.filter { $0.type == .component }.count, 5)
        XCTAssertEqual(result.last, .text(" after."))
    }

    func testAtomsAreDeletedWholeWhenTheirTextIsAltered() throws {
        let entity = EntityReference.canonical(id: NoteIdentifier.new(), label: "Ada", trigger: "@")
        var text = NoteInlineText.attributed([.text("Hi "), .entity(entity), .text("!")])
        let start = NoteInlineText.index(in: text, offset: 3)
        text.characters.remove(at: text.characters.index(start, offsetBy: 1))
        XCTAssertEqual(String(text.characters), "Hi @da!")
        XCTAssertEqual(NoteInlineText.inline(NoteInlineText.reconciled(text)), [.text("Hi !")])

        var untouched = NoteInlineText.attributed([.entity(entity), .entity(entity)])
        XCTAssertEqual(NoteInlineText.inline(NoteInlineText.reconciled(untouched)), [.entity(entity), .entity(entity)])
        untouched.characters.append("x")
        XCTAssertEqual(NoteInlineText.inline(NoteInlineText.reconciled(untouched)).last, .text("x"))

        var container = AttributeContainer()
        container.noteComponent = .default(.drawing)
        let broken = AttributedString("\u{FFFC}z", attributes: container)
        XCTAssertEqual(NoteInlineText.inline(NoteInlineText.reconciled(broken)), [])
        XCTAssertEqual(NoteInlineText.inline(NoteInlineText.reconciled(NoteInlineText.attributed([.component(.default(.drawing))]) + AttributedString("z"))).last, .text("z"))
    }

    func testMarkTogglingOverRangesAndFontClearing() throws {
        var text = AttributedString("hello world")
        let ranges = [text.characters.index(text.startIndex, offsetBy: 0)..<text.characters.index(text.startIndex, offsetBy: 5)]
        NoteInlineText.toggle(.bold, in: &text, ranges: ranges)
        XCTAssertEqual(NoteInlineText.state(of: .bold, in: text, ranges: ranges), .all)
        XCTAssertEqual(NoteInlineText.inline(text), [.text("hello", marks: [.bold]), .text(" world")])
        NoteInlineText.setLink("https://example.com", in: &text, ranges: ranges)
        NoteInlineText.updateTextStyle(in: &text, ranges: ranges) { $0.fontSize = "17px"; $0.color = "#336699" }
        let node = NoteInlineText.inline(text)[0]
        XCTAssertEqual(node.mark(.link)?.attrs?.href, "https://example.com")
        XCTAssertEqual(node.mark(.textStyle)?.attrs?.fontSize, "17px")
        let cleared = NoteInlineText.clearingFonts([node])[0]
        XCTAssertNil(cleared.mark(.textStyle)?.attrs?.fontSize)
        XCTAssertEqual(cleared.mark(.textStyle)?.attrs?.color, "#336699")
        XCTAssertEqual(cleared.mark(.textStyle)?.attrs?.nullFields, ["fontFamily", "fontSize", "backgroundColor"])
        NoteInlineText.toggle(.bold, in: &text, ranges: ranges)
        XCTAssertEqual(NoteInlineText.state(of: .bold, in: text, ranges: ranges), .none)
        let (before, after) = NoteInlineText.split([.text("ab"), .entity(EntityReference.canonical(id: NoteIdentifier.new(), label: "Ada", trigger: "#"))], at: 1)
        XCTAssertEqual(before, [.text("a")])
        XCTAssertEqual(after.first, .text("b"))
        XCTAssertEqual(after.count, 2)
    }
}
