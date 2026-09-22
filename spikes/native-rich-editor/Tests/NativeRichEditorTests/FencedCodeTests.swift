import Foundation
import XCTest
@testable import NativeRichEditor

final class FencedCodeTests: XCTestCase {
    func testDiagramFenceExtractsSourceAndLeavesFollowingNewline() {
        let text = "Before\n```d2\na -> b\n```\nAfter"
        let blocks = FencedCode.parseCompleted(in: text)
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks.first?.language, "d2")
        XCTAssertEqual(blocks.first?.source, "a -> b")
        XCTAssertEqual(blocks.first?.range, (text as NSString).range(of: "```d2\na -> b\n```"))
    }

    func testCRLFPreservesInternalBlankLinesAndSourceIndentation() {
        let text = "```mermaid\r\nflowchart LR\r\n\r\n  A --> B\r\n```\r\n"
        let block = FencedCode.parseCompleted(in: text).first
        XCTAssertEqual(block?.source, "flowchart LR\r\n\r\n  A --> B")
        XCTAssertEqual(block?.range, NSRange(location: 0, length: (text as NSString).length - 2))
    }

    func testUnicodeProducesUTF16ReplacementRange() {
        let prefix = "Sketch 👩🏽‍💻 and café\n"
        let fenced = "```d2\n火 -> 💡\n```"
        let text = prefix + fenced + "\nThen write"
        let block = FencedCode.parseCompleted(in: text).first
        XCTAssertEqual(block?.range, NSRange(location: (prefix as NSString).length,
                                             length: (fenced as NSString).length))
        XCTAssertEqual(block?.source, "火 -> 💡")
        if let range = block?.range {
            XCTAssertEqual((text as NSString).replacingCharacters(in: range, with: "[diagram]"),
                           prefix + "[diagram]\nThen write")
        }
    }

    func testLanguageUsesLowercasedFirstToken() {
        let block = FencedCode.parseCompleted(in: "  ```  MeRmAiD title=Example\nA --> B\n   ``` \t").first
        XCTAssertEqual(block?.language, "mermaid")
        XCTAssertEqual(block?.source, "A --> B")
        XCTAssertEqual(block?.range.location, 0)
    }

    func testOrdinaryAndUnlabelledCodeRemainIdentifiable() {
        let text = "```swift\nlet answer = 42\n```\n\n```\nplain code\n```"
        let blocks = FencedCode.parseCompleted(in: text)
        XCTAssertEqual(blocks.map(\.language), ["swift", ""])
        XCTAssertEqual(blocks.map(\.source), ["let answer = 42", "plain code"])
    }

    func testIncompleteFenceAndTooShortBackticksDoNotMatch() {
        for text in ["```d2", "```d2\na -> b", "```d2\na -> b\n``", "``d2\na -> b\n``"] {
            XCTAssertTrue(FencedCode.parseCompleted(in: text).isEmpty, text)
        }
    }

    func testFenceMustBeginLineWithinThreeSpaces() {
        for text in [
            "text ```d2\na -> b\n```",
            "\"```d2\"\na -> b\n```",
            "    ```d2\na -> b\n    ```",
            "\t```d2\na -> b\n\t```",
        ] {
            XCTAssertTrue(FencedCode.parseCompleted(in: text).isEmpty, text)
        }
        XCTAssertEqual(FencedCode.parseCompleted(in: "   ```d2\na -> b\n ```").count, 1)
    }

    func testLongerOuterFencePreservesNestedShorterFences() {
        let text = "````markdown\n```d2\na -> b\n```\n````"
        let blocks = FencedCode.parseCompleted(in: text)
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks.first?.language, "markdown")
        XCTAssertEqual(blocks.first?.source, "```d2\na -> b\n```")
    }

    func testLongerClosingFenceIsAccepted() {
        let block = FencedCode.parseCompleted(in: "```d2\na -> b\n`````\n").first
        XCTAssertEqual(block?.source, "a -> b")
    }

    func testClosingFenceWithContentIsSourceUntilValidClose() {
        let text = "```d2\na -> b\n```not-a-close\n```` also-not-a-close\n```"
        let block = FencedCode.parseCompleted(in: text).first
        XCTAssertEqual(block?.source, "a -> b\n```not-a-close\n```` also-not-a-close")
    }

    func testOpeningInfoCannotContainBackticks() {
        let text = "```d2 `inline`\na -> b\n```"
        XCTAssertTrue(FencedCode.parseCompleted(in: text).isEmpty)
    }

    func testEmptySourceAndFinalBlankSourceLine() {
        XCTAssertEqual(FencedCode.parseCompleted(in: "```d2\n```").first?.source, "")
        XCTAssertEqual(FencedCode.parseCompleted(in: "```d2\na -> b\n\n```").first?.source, "a -> b\n")
    }
}
