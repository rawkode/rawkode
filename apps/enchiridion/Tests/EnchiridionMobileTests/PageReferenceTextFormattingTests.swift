import EnchiridionCore
import SwiftUI
import UIKit
import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
final class PageReferenceTextFormattingTests: XCTestCase {
  func testCommandContextRoundTripsSelectedRange() throws {
    let body = AttributedString("Before 🪶 Atlas after")
    let range = try XCTUnwrap(body.range(of: "Atlas"))
    let context = try XCTUnwrap(
      NativeRichEditorCommandContext.capture(
        pageID: targetPageID,
        loadGeneration: 7,
        bodyRevision: 11,
        selection: AttributedTextSelection(range: range),
        in: body
      )
    )

    let restored = try XCTUnwrap(
      context.validatedSelection(
        in: body,
        pageID: targetPageID,
        loadGeneration: 7,
        bodyRevision: 11
      )
    )

    XCTAssertEqual(String(body[restored].characters), "Atlas")
  }

  func testCommandContextRejectsWrongDocumentIdentity() throws {
    let body = AttributedString("Atlas")
    let range = try XCTUnwrap(body.range(of: "Atlas"))
    let context = try XCTUnwrap(
      NativeRichEditorCommandContext.capture(
        pageID: targetPageID,
        loadGeneration: 7,
        bodyRevision: 11,
        selection: AttributedTextSelection(range: range),
        in: body
      )
    )

    XCTAssertNil(
      context.validatedSelection(
        in: body,
        pageID: PageID(rawValue: "page_other"),
        loadGeneration: 7,
        bodyRevision: 11
      )
    )
    XCTAssertNil(
      context.validatedSelection(
        in: body,
        pageID: targetPageID,
        loadGeneration: 8,
        bodyRevision: 11
      )
    )
    XCTAssertNil(
      context.validatedSelection(
        in: body,
        pageID: targetPageID,
        loadGeneration: 7,
        bodyRevision: 12
      )
    )
  }

  func testCommandContextCapturesSelectedTextSemantics() throws {
    let body = AttributedString("Atlas")
    let range = try XCTUnwrap(body.range(of: "Atlas"))
    let selectedContext = try XCTUnwrap(
      NativeRichEditorCommandContext.capture(
        pageID: targetPageID,
        loadGeneration: 1,
        bodyRevision: 2,
        selection: AttributedTextSelection(range: range),
        in: body
      )
    )
    let caretContext = try XCTUnwrap(
      NativeRichEditorCommandContext.capture(
        pageID: targetPageID,
        loadGeneration: 1,
        bodyRevision: 2,
        selection: AttributedTextSelection(insertionPoint: body.startIndex),
        in: body
      )
    )

    XCTAssertTrue(selectedContext.hasSelectedText)
    XCTAssertFalse(caretContext.hasSelectedText)
  }

  func testCommandContextRestoresTheCapturedFormattingTarget() throws {
    let body = AttributedString("Before Atlas after")
    let range = try XCTUnwrap(body.range(of: "Atlas"))
    let context = try XCTUnwrap(
      NativeRichEditorCommandContext.capture(
        pageID: targetPageID,
        loadGeneration: 5,
        bodyRevision: 9,
        selection: AttributedTextSelection(range: range),
        in: body
      )
    )
    var candidate = body
    var restored = try XCTUnwrap(
      context.validatedSelection(
        in: candidate,
        pageID: targetPageID,
        loadGeneration: 5,
        bodyRevision: 9
      )
    )

    candidate.transformAttributes(in: &restored) { attributes in
      attributes.inlinePresentationIntent = [.stronglyEmphasized]
    }

    let selectedRange = try XCTUnwrap(candidate.range(of: "Atlas"))
    let beforeRange = try XCTUnwrap(candidate.range(of: "Before"))
    XCTAssertEqual(candidate[selectedRange].inlinePresentationIntent, [.stronglyEmphasized])
    XCTAssertNil(candidate[beforeRange].inlinePresentationIntent)
  }

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

  func testBrowseRenderPlanUsesRenamedLiveLabelsAndPreservesMultilineRTLSegments() throws {
    var source = AttributedString("Read Atlas\nثم Orion")
    let atlasRange = try XCTUnwrap(source.range(of: "Atlas"))
    let orionRange = try XCTUnwrap(source.range(of: "Orion"))
    source[atlasRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]
    source[orionRange][PageRichTextAttributes.AutomergeMarks.self] = [
      try PageDocument.pageReferenceMark(to: PageID(rawValue: "page_orion"), label: "Orion")
    ]

    let plan = PageReferenceBrowseRenderPlan.resolve(
      from: source,
      vaultID: vaultID,
      liveTarget: { pageID in
        switch pageID {
        case self.targetPageID:
          self.liveTarget(
            pageID: pageID,
            title: "Marissa Flanagan",
            supertags: [self.supertag("person", "Person", "person.crop.circle", builtIn: true)]
          )
        case PageID(rawValue: "page_orion"):
          self.liveTarget(
            pageID: pageID,
            title: "Orion Renamed",
            supertags: [self.supertag("project", "Project", "folder", builtIn: true)]
          )
        default:
          nil
        }
      }
    )

    XCTAssertEqual(plan.segments.count, 4)
    XCTAssertEqual(reference(at: 1, in: plan).label, "Marissa Flanagan")
    XCTAssertEqual(reference(at: 1, in: plan).symbolName, "person.crop.circle")
    XCTAssertEqual(reference(at: 3, in: plan).label, "Orion Renamed")
    XCTAssertEqual(reference(at: 3, in: plan).symbolName, "folder")
    XCTAssertEqual(text(at: 2, in: plan), "\nثم ")
  }

  func testBrowseRenderPlanUsesStoredFallbackForDeletedAndMalformedReferences() throws {
    var source = AttributedString("Atlas broken")
    let atlasRange = try XCTUnwrap(source.range(of: "Atlas"))
    let brokenRange = try XCTUnwrap(source.range(of: "broken"))
    source[atlasRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]
    source[brokenRange][PageRichTextAttributes.AutomergeMarks.self] = [
      PageRichTextMark(name: PageDocument.pageReferenceMark, value: .string("not-json"))
    ]

    let plan = PageReferenceBrowseRenderPlan.resolve(
      from: source,
      vaultID: vaultID,
      liveTarget: { _ in nil }
    )

    let missing = reference(at: 0, in: plan)
    XCTAssertEqual(missing.label, "Atlas")
    XCTAssertEqual(missing.fallbackLabel, "Atlas")
    XCTAssertNil(missing.url)
    XCTAssertNil(missing.symbolName)
    XCTAssertEqual(text(at: 1, in: plan), " broken")
  }

  func testBrowseRenderPlanStripsExternalLinksBeforeProducingNativeText() throws {
    var text = AttributedString("Visit Atlas")
    let visitRange = try XCTUnwrap(text.range(of: "Visit"))
    let atlasRange = try XCTUnwrap(text.range(of: "Atlas"))
    text[visitRange].link = try XCTUnwrap(URL(string: "https://example.com"))
    text[atlasRange][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]

    let plan = PageReferenceBrowseRenderPlan.resolve(
      from: text,
      vaultID: vaultID,
      liveTarget: { pageID in
        pageID == self.targetPageID
          ? self.liveTarget(pageID: pageID, title: "Atlas", supertags: [])
          : nil
      }
    )
    let projection = plan.attributedString(palette: PageReferencePalette(contrast: .standard))

    let projectedVisitRange = try XCTUnwrap(projection.range(of: "Visit"))
    let projectedAtlasRange = try XCTUnwrap(projection.range(of: "Atlas"))
    XCTAssertNil(projection[projectedVisitRange].link)
    XCTAssertEqual(
      PageReferenceBrowseLink.destination(from: try XCTUnwrap(projection[projectedAtlasRange].link)),
      .init(vaultID: vaultID, pageID: targetPageID)
    )
  }

  func testPrimaryPresentationSupertagUsesBuiltInPriorityThenCustomID() {
    XCTAssertEqual(
      PageReferenceBrowseRenderPlan.primaryPresentationSupertag(
        in: [
          supertag("project", "Project", "folder", builtIn: true),
          supertag("person", "Person", "person.crop.circle", builtIn: true),
        ]
      )?.id,
      BuiltInSupertags.person
    )
    XCTAssertEqual(
      PageReferenceBrowseRenderPlan.primaryPresentationSupertag(
        in: [
          supertag("zeta", "Zeta", "z.circle", builtIn: false),
          supertag("alpha", "Alpha", "a.circle", builtIn: false),
        ]
      )?.id,
      SupertagID(rawValue: "alpha")
    )
    XCTAssertNil(PageReferenceBrowseRenderPlan.primaryPresentationSupertag(in: []))
  }

  func testNativeBrowseTextSeparatesSymbolAttachmentFromLinkLabelAndRoutesOnlyInternalURLs() throws {
    var text = AttributedString("Atlas")
    let range = try XCTUnwrap(text.range(of: "Atlas"))
    text[range][PageRichTextAttributes.AutomergeMarks.self] = [referenceMark]
    let plan = PageReferenceBrowseRenderPlan.resolve(
      from: text,
      vaultID: vaultID,
      liveTarget: { pageID in
        self.liveTarget(
          pageID: pageID,
          title: "Marissa Flanagan",
          supertags: [self.supertag("person", "Person", "person.crop.circle", builtIn: true)]
        )
      }
    )
    let native = PageReferenceBrowseNativeText.make(
      from: plan,
      palette: PageReferencePalette(contrast: .standard)
    )
    let attachmentRange = try XCTUnwrap(
      attributeRange(.attachment, matching: { $0 is NSTextAttachment }, in: native)
    )
    let linkRange = try XCTUnwrap(
      attributeRange(.link, matching: { $0 is URL }, in: native)
    )

    XCTAssertLessThan(attachmentRange.location, linkRange.location)
    XCTAssertNil(native.attribute(.link, at: attachmentRange.location, effectiveRange: nil))
    XCTAssertEqual(
      native.string[Range(NSRange(location: linkRange.location, length: linkRange.length), in: native.string)!],
      "Marissa Flanagan"
    )

    var routed: URL?
    let internalURL = try XCTUnwrap(native.attribute(.link, at: linkRange.location, effectiveRange: nil) as? URL)
    XCTAssertTrue(PageReferenceBrowseLinkRouter.route(internalURL) { routed = $0 })
    XCTAssertEqual(routed, internalURL)
    XCTAssertFalse(
      PageReferenceBrowseLinkRouter.route(try XCTUnwrap(URL(string: "https://example.com"))) { _ in
        XCTFail("External URLs must not cross the browse callback boundary")
      }
    )
  }

  private var referenceMark: PageRichTextMark {
    try! PageDocument.pageReferenceMark(to: targetPageID, label: "Atlas")
  }

  private var vaultID: VaultID { VaultID(rawValue: "vault_personal") }
  private var targetPageID: PageID { PageID(rawValue: "page_atlas") }

  private func liveTarget(
    pageID: PageID,
    title: String,
    supertags: [PageReferenceBrowseSupertag]
  ) -> PageReferenceBrowseLiveTarget {
    .init(pageID: pageID, displayTitle: title, supertags: supertags)
  }

  private func supertag(
    _ id: String,
    _ name: String,
    _ symbol: String,
    builtIn: Bool
  ) -> PageReferenceBrowseSupertag {
    .init(
      id: SupertagID(rawValue: id),
      name: name,
      symbolName: symbol,
      isBuiltIn: builtIn
    )
  }

  private func reference(
    at index: Int,
    in plan: PageReferenceBrowseRenderPlan
  ) -> PageReferenceBrowsePresentation {
    guard case .reference(let value) = plan.segments[index] else {
      XCTFail("Expected reference segment at index \(index)")
      fatalError("Expected reference segment")
    }
    return value.presentation
  }

  private func text(at index: Int, in plan: PageReferenceBrowseRenderPlan) -> String {
    guard case .text(let value) = plan.segments[index] else {
      XCTFail("Expected text segment at index \(index)")
      fatalError("Expected text segment")
    }
    return String(value.characters)
  }

  private func attributeRange(
    _ key: NSAttributedString.Key,
    matching predicate: (Any) -> Bool,
    in text: NSAttributedString
  ) -> NSRange? {
    var result: NSRange?
    text.enumerateAttribute(key, in: NSRange(location: 0, length: text.length)) { value, range, stop in
      guard let value, predicate(value) else { return }
      result = range
      stop.pointee = true
    }
    return result
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
