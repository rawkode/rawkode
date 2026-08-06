// ShareExtensionContextParsingTests.swift
// EnchiridionShareKitTests
//
// See `ShareExtensionContextParsing.swift`'s header: unlike WidgetKit's
// `TimelineProviderContext`, `NSItemProvider` has genuine non-extension-only
// initializers, so this exercises the REAL `loadItem(forTypeIdentifier:)`
// round trip against real providers — not a mock of the parsing logic.

import Foundation
import UniformTypeIdentifiers
import XCTest

@testable import EnchiridionShareKit

final class ShareExtensionContextParsingTests: XCTestCase {
  func testInputExtractsAURLFromAURLItemProvider() async {
    let url = URL(string: "https://example.com/page")!
    let provider = NSItemProvider(object: url as NSURL)

    let input = await ShareExtensionContextParsing.input(from: [provider])

    XCTAssertEqual(input.url, url)
    XCTAssertNil(input.text)
  }

  func testInputExtractsPlainTextFromATextItemProvider() async {
    let provider = NSItemProvider(object: "Shared note contents" as NSString)

    let input = await ShareExtensionContextParsing.input(from: [provider])

    XCTAssertEqual(input.text, "Shared note contents")
    XCTAssertNil(input.url)
  }

  func testInputCombinesURLAndTextFromTwoSeparateProviders() async {
    let url = URL(string: "https://example.com")!
    let urlProvider = NSItemProvider(object: url as NSURL)
    let textProvider = NSItemProvider(object: "Selected passage" as NSString)

    let input = await ShareExtensionContextParsing.input(from: [urlProvider, textProvider])

    XCTAssertEqual(input.url, url)
    XCTAssertEqual(input.text, "Selected passage")
  }

  func testInputReturnsEmptyWhenGivenNoProviders() async {
    let input = await ShareExtensionContextParsing.input(from: [])

    XCTAssertNil(input.url)
    XCTAssertNil(input.text)
    XCTAssertTrue(input.isEmpty)
  }

  func testInputPassesThroughAnExplicitPageTitleUnchanged() async {
    let input = await ShareExtensionContextParsing.input(from: [], pageTitle: "Explicit Title")

    XCTAssertEqual(input.pageTitle, "Explicit Title")
  }

  func testInputTakesTheFirstSuccessfullyLoadedValueOfEachKindAcrossMultipleProviders() async {
    let firstURL = URL(string: "https://first.example.com")!
    let secondURL = URL(string: "https://second.example.com")!
    let providers = [
      NSItemProvider(object: firstURL as NSURL),
      NSItemProvider(object: secondURL as NSURL),
    ]

    let input = await ShareExtensionContextParsing.input(from: providers)

    XCTAssertEqual(input.url, firstURL)
  }

  // MARK: - The `Data` decode branch specifically

  // `ShareExtensionContextParsing.loadURL`/`loadText`'s header explains
  // WHY the `Data` case exists: it's what `NSItemProvider(object:)`
  // actually delivers for a plain `URL`/`String` payload, not a re-decoded
  // `NSURL`/`NSString`. The tests above already exercise that path
  // indirectly (via `NSItemProvider(object:)`) but never pin down that the
  // `Data` branch itself — as opposed to the `URL`/`NSURL`/`String`/
  // `NSString` branches — is what's actually firing, since all branches
  // converge on the same asserted result. These two build a provider whose
  // `loadItem` completion is guaranteed to hand back raw `Data` (via
  // `NSItemProvider(item:typeIdentifier:)`, which stores the item exactly
  // as given, unlike `NSItemProvider(object:)`'s `NSItemProviderWriting`
  // round trip), so a regression that deletes the `Data` case specifically
  // — as opposed to any other branch — has a test that would actually
  // catch it.

  func testInputDecodesAURLFromAProviderThatDeliversRawUTF8Data() async {
    let url = URL(string: "https://example.com/from-raw-data")!
    let provider = NSItemProvider(
      item: Data(url.absoluteString.utf8) as NSData, typeIdentifier: UTType.url.identifier)

    let input = await ShareExtensionContextParsing.input(from: [provider])

    XCTAssertEqual(input.url, url)
  }

  func testInputDecodesTextFromAProviderThatDeliversRawUTF8Data() async {
    let text = "Raw data plain text"
    let provider = NSItemProvider(
      item: Data(text.utf8) as NSData, typeIdentifier: UTType.plainText.identifier)

    let input = await ShareExtensionContextParsing.input(from: [provider])

    XCTAssertEqual(input.text, text)
  }

  func testInputReturnsNilURLForDataThatIsNotAValidURLString() async {
    // Not valid UTF-8 (a lone continuation byte) — must not crash or
    // produce a garbage URL.
    let provider = NSItemProvider(
      item: Data([0xFF, 0xFE]) as NSData, typeIdentifier: UTType.url.identifier)

    let input = await ShareExtensionContextParsing.input(from: [provider])

    XCTAssertNil(input.url)
  }
}
