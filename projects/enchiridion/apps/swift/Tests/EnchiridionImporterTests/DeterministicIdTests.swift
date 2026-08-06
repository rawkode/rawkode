// DeterministicIdTests.swift
// EnchiridionImporterTests
//
// Asserts `PageReencoder.rederivedPageID` produces the SAME ids
// `packages/graph-core` (the TS mirror) would independently derive for the
// same logical page — using the SAME shared golden fixture file
// `Tests/EnchiridionCoreTests/GoldenIdsTests.swift` already loads
// (packages/graph-core/src/__fixtures__/golden-ids.json), not hand-copied
// literals, so this can never silently drift from the TS side's own
// assertions. This is the task brief's "deterministic IDs match what
// graph-core's derivation would independently produce for the same logical
// page" requirement, exercised through the FULL decode -> re-encode
// pipeline (a synthetic Automerge doc in, a re-derived PageID out) rather
// than calling `PageID.daily`/`.person` directly — the point is proving the
// IMPORTER's re-derivation step is wired correctly, not re-testing
// `EnchiridionCore.PageID` itself (GoldenIdsTests.swift already does that).
import Automerge
import EnchiridionCore
import Foundation
import XCTest

@testable import EnchiridionImporter

final class DeterministicIdTests: XCTestCase {

  private func loadFixture() throws -> [String: Any] {
    let thisFileDir = (#filePath as NSString).deletingLastPathComponent
    // apps/swift/Tests/EnchiridionImporterTests -> (up 4) -> projects/enchiridion
    // -> packages/graph-core/src/__fixtures__/golden-ids.json
    let fixturePath = (thisFileDir as NSString).appendingPathComponent(
      "../../../../packages/graph-core/src/__fixtures__/golden-ids.json"
    )
    let resolvedPath = (fixturePath as NSString).standardizingPath
    let data = try XCTUnwrap(
      FileManager.default.contents(atPath: resolvedPath),
      "golden-ids.json not found at \(resolvedPath) — is packages/graph-core still checked out alongside apps/swift?"
    )
    let json = try JSONSerialization.jsonObject(with: data)
    return try XCTUnwrap(json as? [String: Any])
  }

  func testDailyPageIdMatchesGoldenFixture() throws {
    let fixture = try loadFixture()
    let cases = try XCTUnwrap(fixture["dailyPageIds"] as? [[String: Any]])
    let stringInputCase = try XCTUnwrap(cases.first { ($0["input"] as? String) != nil })
    let day = try XCTUnwrap(stringInputCase["input"] as? String)
    let expectedID = try XCTUnwrap(stringInputCase["expectedId"] as? String)

    let document = SyntheticOldPageBuilder.create(
      id: "page_daily_source", kind: SyntheticOldPageBuilder.kindJSON(daily: day), title: "",
      createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let decoded = try OldPageDocumentDecoder.decode(document.save())
    let reencoded = try PageReencoder.reencode(decoded)

    XCTAssertEqual(reencoded.pageID.rawValue, expectedID)
  }

  func testPersonPageIdMatchesGoldenFixtureForEachCase() throws {
    let fixture = try loadFixture()
    let cases = try XCTUnwrap(fixture["personPageIds"] as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty)

    for (index, testCase) in cases.enumerated() {
      let email = try XCTUnwrap(testCase["input"] as? String, "case \(index)")
      let expectedID = try XCTUnwrap(testCase["expectedId"] as? String, "case \(index)")

      // Old app creates person pages with `id: PageID.person(email:)` but
      // `kind: .free` (LibraryRepository.swift's calendar-attendee
      // ingestion path) — the old page's OWN stored id is deliberately
      // something else here, to prove `PageReencoder` re-derives from the
      // decoded `person`/`email` content rather than merely copying
      // whatever id the source row happened to have.
      let document = SyntheticOldPageBuilder.create(
        id: "page_person_source_\(index)", kind: SyntheticOldPageBuilder.freeKindJSON, title: "A Contact",
        createdAt: Date(timeIntervalSince1970: 1_700_000_000)
      )
      SyntheticOldPageBuilder.addSupertag(document, "person")
      SyntheticOldPageBuilder.setScalarProperty(
        document, supertagID: "person", fieldID: "email", jsonValues: [SyntheticSupertagValue.email(email)]
      )

      let decoded = try OldPageDocumentDecoder.decode(document.save())
      let reencoded = try PageReencoder.reencode(decoded)

      XCTAssertEqual(reencoded.pageID.rawValue, expectedID, "case \(index): \(email)")
      XCTAssertNotEqual(
        reencoded.pageID.rawValue, "page_person_source_\(index)",
        "case \(index): re-derivation must not just copy the old page's own id"
      )
    }
  }

  /// A `.free` page with no deterministic scheme applicable — the old id
  /// is carried forward verbatim, which IS the correct, idempotency-
  /// preserving behavior (see PageReencoder.swift's doc comment), not a
  /// gap this test is pointing out.
  func testPlainFreePageCarriesOldIdForward() throws {
    let document = SyntheticOldPageBuilder.create(
      id: "page_random_abc123", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Random note",
      createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let decoded = try OldPageDocumentDecoder.decode(document.save())
    let reencoded = try PageReencoder.reencode(decoded)
    XCTAssertEqual(reencoded.pageID, PageID(rawValue: "page_random_abc123"))
  }
}
