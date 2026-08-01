import EnchiridionCore
import SwiftUI
import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
final class PageReferenceTextFormattingTests: XCTestCase {
  func testPageReferenceReceivesSemanticForegroundAndUnderline() {
    var text = AttributedString("Read Atlas today")
    let referenceRange = try! XCTUnwrap(text.range(of: "Atlas"))
    text[referenceRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]

    let palette = PageReferencePalette(contrast: .standard)
    let formatted = format(text, palette: palette)

    XCTAssertEqual(formatted[referenceRange].foregroundColor, palette.foregroundColor)
    XCTAssertEqual(formatted[referenceRange].underlineStyle, .single)
  }

  func testUnmarkedTextReceivesNoFormatterOwnedAttributes() {
    let text = AttributedString("Read Atlas today")

    let formatted = format(text, palette: PageReferencePalette(contrast: .standard))

    XCTAssertNil(formatted[formatted.startIndex..<formatted.endIndex].foregroundColor)
    XCTAssertNil(formatted[formatted.startIndex..<formatted.endIndex].underlineStyle)
  }

  func testReferenceFormattingCoexistsWithCodeAndStrongEmphasis() {
    var text = AttributedString("Atlas code")
    let referenceRange = try! XCTUnwrap(text.range(of: "Atlas"))
    let codeRange = try! XCTUnwrap(text.range(of: "code"))
    text[referenceRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]
    text[referenceRange].inlinePresentationIntent = [.stronglyEmphasized, .code]
    text[codeRange].inlinePresentationIntent = [.code]

    let formatted = format(text, palette: PageReferencePalette(contrast: .standard))

    XCTAssertEqual(
      formatted[referenceRange].inlinePresentationIntent,
      [.stronglyEmphasized, .code]
    )
    XCTAssertEqual(formatted[codeRange].inlinePresentationIntent, [.code])
    XCTAssertEqual(formatted[referenceRange].underlineStyle, .single)
  }

  func testEmojiBoundariesFormatOnlyTheReferenceRun() {
    var text = AttributedString("🪶 Atlas 🌊")
    let referenceRange = try! XCTUnwrap(text.range(of: "Atlas"))
    let leadingEmojiRange = try! XCTUnwrap(text.range(of: "🪶"))
    let trailingEmojiRange = try! XCTUnwrap(text.range(of: "🌊"))
    text[referenceRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]

    let formatted = format(text, palette: PageReferencePalette(contrast: .standard))

    XCTAssertNotNil(formatted[referenceRange].foregroundColor)
    XCTAssertEqual(formatted[referenceRange].underlineStyle, .single)
    XCTAssertNil(formatted[leadingEmojiRange].foregroundColor)
    XCTAssertNil(formatted[leadingEmojiRange].underlineStyle)
    XCTAssertNil(formatted[trailingEmojiRange].foregroundColor)
    XCTAssertNil(formatted[trailingEmojiRange].underlineStyle)
  }

  func testHighContrastPaletteUsesDistinctSemanticForeground() {
    let standard = PageReferencePalette(contrast: .standard)
    let increased = PageReferencePalette(contrast: .increased)

    XCTAssertNotEqual(standard, increased)
  }

  private var referenceMark: PageRichTextMark {
    PageRichTextMark(
      name: PageDocument.pageReferenceMark,
      value: .string("page-identifier")
    )
  }

  private func format(
    _ text: AttributedString,
    palette: PageReferencePalette
  ) -> AttributedString {
    var formatted = text
    PageReferenceTextFormattingDefinition(palette: palette).constrain(&formatted)
    return formatted
  }
}
