import EnchiridionCore
import SwiftUI
import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
final class PageReferenceTextFormattingTests: XCTestCase {
  func testEditFormatterAppliesSemanticForegroundWithoutUnderline() {
    var text = AttributedString("Read Atlas today")
    let referenceRange = try! XCTUnwrap(text.range(of: "Atlas"))
    text[referenceRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]

    let palette = PageReferencePalette(contrast: .standard)
    let formatted = format(text, palette: palette)

    XCTAssertEqual(formatted[referenceRange].foregroundColor, palette.foregroundColor)
    XCTAssertNil(formatted[referenceRange].underlineStyle)
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
    XCTAssertNil(formatted[referenceRange].underlineStyle)
  }

  func testEmojiBoundariesFormatOnlyTheReferenceRun() {
    var text = AttributedString("🪶 Atlas 🌊")
    let referenceRange = try! XCTUnwrap(text.range(of: "Atlas"))
    let leadingEmojiRange = try! XCTUnwrap(text.range(of: "🪶"))
    let trailingEmojiRange = try! XCTUnwrap(text.range(of: "🌊"))
    text[referenceRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]

    let formatted = format(text, palette: PageReferencePalette(contrast: .standard))

    XCTAssertNotNil(formatted[referenceRange].foregroundColor)
    XCTAssertNil(formatted[referenceRange].underlineStyle)
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

  func testBrowseProjectionAddsTransientLinkOnlyForLiveSemanticReference() throws {
    var text = AttributedString("Read 🪶 Atlas today")
    let referenceRange = try XCTUnwrap(text.range(of: "Atlas"))
    text[referenceRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]

    let projection = PageReferenceBrowseProjection.make(
      from: text,
      vaultID: vaultID,
      palette: PageReferencePalette(contrast: .standard),
      isDestinationLive: { $0 == targetPageID }
    )

    XCTAssertNil(text[referenceRange].link)
    let link = try XCTUnwrap(projection[referenceRange].link)
    XCTAssertEqual(
      PageReferenceBrowseLink.destination(from: link),
      .init(vaultID: vaultID, pageID: targetPageID)
    )
    XCTAssertEqual(projection[referenceRange].underlineStyle, .single)
  }

  func testBrowseProjectionRejectsMalformedAndWrongMarks() throws {
    var malformed = AttributedString("Atlas")
    let malformedRange = try XCTUnwrap(malformed.range(of: "Atlas"))
    malformed[malformedRange][PageRichTextAttributes.AutomergeMarks.self] = [
      PageRichTextMark(name: PageDocument.pageReferenceMark, value: .string("not-json"))
    ]

    var wrongMark = AttributedString("Orion")
    let wrongRange = try XCTUnwrap(wrongMark.range(of: "Orion"))
    wrongMark[wrongRange][PageRichTextAttributes.AutomergeMarks.self] = [
      PageRichTextMark(name: "other-mark", value: .string("page_atlas"))
    ]

    let palette = PageReferencePalette(contrast: .standard)
    let malformedProjection = PageReferenceBrowseProjection.make(
      from: malformed,
      vaultID: vaultID,
      palette: palette,
      isDestinationLive: { _ in true }
    )
    let wrongProjection = PageReferenceBrowseProjection.make(
      from: wrongMark,
      vaultID: vaultID,
      palette: palette,
      isDestinationLive: { _ in true }
    )

    XCTAssertNil(malformedProjection[malformedRange].link)
    XCTAssertNil(wrongProjection[wrongRange].link)
  }

  func testBrowseProjectionStripsPreexistingExternalLinks() throws {
    var text = AttributedString("Atlas")
    let range = try XCTUnwrap(text.range(of: "Atlas"))
    text[range].link = try XCTUnwrap(URL(string: "https://example.com"))

    let projection = PageReferenceBrowseProjection.make(
      from: text,
      vaultID: vaultID,
      palette: PageReferencePalette(contrast: .standard),
      isDestinationLive: { _ in true }
    )

    XCTAssertNil(projection[range].link)
  }

  func testBrowseLinkParserRejectsNonInternalAndMalformedURLs() throws {
    XCTAssertNil(PageReferenceBrowseLink.destination(from: try XCTUnwrap(URL(string: "https://example.com"))))
    XCTAssertNil(
      PageReferenceBrowseLink.destination(
        from: try XCTUnwrap(URL(string: "enchiridion-reference://page?vault=bad&page=not_valid!"))
      )
    )
    XCTAssertNil(
      PageReferenceBrowseLink.destination(
        from: try XCTUnwrap(URL(string: "enchiridion-reference://page?vault=dmF1bHQ"))
      )
    )
  }

  private var referenceMark: PageRichTextMark {
    try! PageDocument.pageReferenceMark(to: targetPageID, label: "Atlas")
  }

  private var vaultID: VaultID { VaultID(rawValue: "vault_personal") }
  private var targetPageID: PageID { PageID(rawValue: "page_atlas") }

  private func format(
    _ text: AttributedString,
    palette: PageReferencePalette
  ) -> AttributedString {
    var formatted = text
    PageReferenceTextFormattingDefinition(palette: palette).constrain(&formatted)
    return formatted
  }
}
