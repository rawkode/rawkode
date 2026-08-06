// GoldenIdsTests.swift
// EnchiridionCoreTests
//
// Swift half of the plan's release-blocking cross-language golden test
// (Backend architecture, "Critical invariant": deterministic PageIDs
// ported byte-for-byte to TS in packages/graph-core, locked with
// cross-language golden tests in CI — divergence silently forks pages).
//
// This loads the SAME shared fixture file the TS side asserts against
// (packages/graph-core/src/__fixtures__/golden-ids.json, read by
// packages/graph-core/src/index.test.ts) directly off disk at a path
// relative to this test file's own location (via `#filePath`), rather than
// hand-copying values into Swift literals or adding an SPM test-resource
// copy step — either of those risks the two sides silently drifting apart,
// which is exactly the failure mode this test exists to prevent. Works
// both locally and in CI because `apps/swift` and `packages/graph-core`
// live side by side in the same monorepo checkout
// (`projects/enchiridion/{apps/swift,packages/graph-core}`).
//
// See Tests/GOLDEN_IDS_TODO.md for the design notes this file implements
// (that file's final "Why this file exists instead of a real Swift test"
// section is now resolved by this file existing).
//
// Each fixture case is matched to whichever REAL EnchiridionCore API
// produces that id today (Sources/EnchiridionCore/Identity.swift):
//   - dailyPageIds  -> PageID.daily(_:)
//   - personPageIds -> PageID.person(email:)
//   - eventPageIds  -> PageID.digestIdentified(prefix:canonicalKey:), fed a
//     stableKey assembled the same way TS's
//     `deriveCalendarMaterializedIdentity` + `deriveEventPageId` assemble
//     theirs (NUL-separated, see packages/graph-core/src/index.ts). There
//     is no ported `CalendarMaterializedIdentity` /
//     `CalendarEventMaterialization` type in EnchiridionCore yet (see
//     GOLDEN_IDS_TODO.md), so the NFC-normalization + full-SHA-256 steps
//     that would live inside that not-yet-ported type are done here using
//     only Foundation/CryptoKit primitives (not a fabricated call to a
//     nonexistent EnchiridionCore API) before handing the assembled key to
//     the real `PageID.digestIdentified`. This still exercises real
//     production code for the part that matters most for cross-language
//     agreement — the final digest-and-prefix step — and independently
//     verifies the NFC/trim/NUL-join normalization the fixture encodes.
//   - blobIds -> BlobID.init(contentsOf:) (EnchiridionBlobs/BlobReference.swift)
//     — the same production API BlobCache.swift uses in production. This
//     used to assert against a hand-rolled CryptoKit.SHA256 call duplicated
//     in this file, with a comment claiming no production Swift blob-ID
//     function existed; that stopped being true once BlobReference.swift
//     shipped, so this now calls the real thing (EnchiridionCoreTests
//     depends on EnchiridionBlobs for exactly this — see Package.swift).
//   - PredicateID.property(tagID:fieldID:) has no fixture entry (pure
//     string formatting, no hashing, no cross-language risk per
//     GOLDEN_IDS_TODO.md) — a couple of inline assertions mirroring TS's
//     `predicateId` unit test are enough.

import CryptoKit
import Foundation
import XCTest

@testable import EnchiridionBlobs
@testable import EnchiridionCore

final class GoldenIdsTests: XCTestCase {

  // MARK: - Fixture loading

  /// Loads `packages/graph-core/src/__fixtures__/golden-ids.json` directly
  /// off disk, resolved relative to this test file's own location so the
  /// Swift and TS sides can never read two different copies of the fixture.
  private func loadFixture() throws -> [String: Any] {
    let thisFileDir = (#filePath as NSString).deletingLastPathComponent
    // apps/swift/Tests/EnchiridionCoreTests -> (up 4) -> projects/enchiridion
    // -> packages/graph-core/src/__fixtures__/golden-ids.json
    let fixturePath = (thisFileDir as NSString).appendingPathComponent(
      "../../../../packages/graph-core/src/__fixtures__/golden-ids.json"
    )
    let resolvedPath = (fixturePath as NSString).standardizingPath

    let data = try XCTUnwrap(
      FileManager.default.contents(atPath: resolvedPath),
      """
      golden-ids.json not found at \(resolvedPath) — is packages/graph-core \
      checked out alongside apps/swift in the same projects/enchiridion tree?
      """
    )
    let json = try JSONSerialization.jsonObject(with: data)
    return try XCTUnwrap(json as? [String: Any])
  }

  // MARK: - Shared helpers (mirroring packages/graph-core/src/index.ts)

  private func fullSHA256Hex(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// Swift's NFC form, matching TS's `String.prototype.normalize("NFC")`
  /// (see index.ts `normalizeNfc`).
  private func nfc(_ value: String) -> String {
    value.precomposedStringWithCanonicalMapping
  }

  private func trimmed(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func hexToBytes(_ hex: String) -> [UInt8] {
    guard !hex.isEmpty else { return [] }
    var bytes: [UInt8] = []
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      bytes.append(UInt8(hex[index..<next], radix: 16)!)
      index = next
    }
    return bytes
  }

  private func int(_ any: Any?) -> Int? {
    if let n = any as? NSNumber { return n.intValue }
    if let i = any as? Int { return i }
    return nil
  }

  // MARK: - dailyPageIds -> PageID.daily(_:)

  func testDailyPageIds() throws {
    let fixture = try loadFixture()
    let cases = try XCTUnwrap(fixture["dailyPageIds"] as? [[String: Any]])
    XCTAssertGreaterThanOrEqual(cases.count, 3, "plan requires >= 3 daily-page fixture cases")

    for testCase in cases {
      let description = testCase["description"] as? String ?? "(no description)"
      let expectedId = try XCTUnwrap(testCase["expectedId"] as? String, description)

      let rawValue: String
      if let stringInput = testCase["input"] as? String {
        // Already zero-padded "YYYY-MM-DD" in the fixture.
        rawValue = stringInput
      } else if let objectInput = testCase["input"] as? [String: Any] {
        let year = try XCTUnwrap(int(objectInput["year"]), description)
        let month = try XCTUnwrap(int(objectInput["month"]), description)
        let day = try XCTUnwrap(int(objectInput["day"]), description)
        // Matches DayKey's own zero-padding (Identity.swift's
        // `init(date:calendar:)`) and TS's `formatDayKey`.
        rawValue = String(format: "%04d-%02d-%02d", year, month, day)
      } else {
        XCTFail("dailyPageIds case has neither a string nor {year,month,day} input: \(description)")
        continue
      }

      let pageId = PageID.daily(DayKey(rawValue: rawValue))
      XCTAssertEqual(pageId.rawValue, expectedId, description)
    }
  }

  // MARK: - personPageIds -> PageID.person(email:)

  func testPersonPageIds() throws {
    let fixture = try loadFixture()
    let cases = try XCTUnwrap(fixture["personPageIds"] as? [[String: Any]])
    XCTAssertGreaterThanOrEqual(cases.count, 3, "plan requires >= 3 person-email fixture cases")

    for testCase in cases {
      let description = testCase["description"] as? String ?? "(no description)"
      let input = try XCTUnwrap(testCase["input"] as? String, description)
      let expectedId = try XCTUnwrap(testCase["expectedId"] as? String, description)

      let pageId = PageID.person(email: input)
      XCTAssertEqual(pageId.rawValue, expectedId, description)
    }
  }

  // MARK: - eventPageIds -> PageID.digestIdentified(prefix:canonicalKey:)

  func testEventPageIds() throws {
    let fixture = try loadFixture()
    let cases = try XCTUnwrap(fixture["eventPageIds"] as? [[String: Any]])
    XCTAssertGreaterThanOrEqual(cases.count, 2, "plan requires >= 2 event fixture cases")

    for testCase in cases {
      let description = testCase["description"] as? String ?? "(no description)"
      let input = try XCTUnwrap(testCase["input"] as? [String: Any], description)
      let expectedUidDigest = try XCTUnwrap(testCase["expectedUidDigest"] as? String, description)
      let expectedSourceScopeDigest = try XCTUnwrap(
        testCase["expectedSourceScopeDigest"] as? String, description)
      let expectedOccurrenceToken = try XCTUnwrap(
        testCase["expectedOccurrenceToken"] as? String, description)
      let expectedId = try XCTUnwrap(testCase["expectedId"] as? String, description)

      // Mirrors TS's `deriveCalendarMaterializedIdentity` normalization
      // order: NFC-compose the raw UID/provider, THEN trim.
      let uid = trimmed(nfc(try XCTUnwrap(input["iCalendarUID"] as? String, description)))
      let provider = trimmed(nfc(try XCTUnwrap(input["provider"] as? String, description)))
      let uidDigest = fullSHA256Hex(uid)
      let sourceScopeDigest = fullSHA256Hex(provider)

      let isAllDay = try XCTUnwrap(input["isAllDay"] as? Bool, description)
      let occurrenceToken: String
      if isAllDay {
        let day = trimmed(try XCTUnwrap(input["originalStartCivilDay"] as? String, description))
        let zone = trimmed(try XCTUnwrap(input["timeZoneIdentifier"] as? String, description))
        occurrenceToken = "all-day\u{0}\(day)\u{0}\(zone)"
      } else {
        let epochMs = try XCTUnwrap(int(input["originalStartDateEpochMs"]), description)
        // Swift's `Int` division already truncates toward zero (for both
        // signs), matching TS's `Math.trunc(ms / 1000)`.
        let epochSeconds = epochMs / 1000
        occurrenceToken = "instant\u{0}\(epochSeconds)"
      }

      XCTAssertEqual(uidDigest, expectedUidDigest, "\(description): uidDigest")
      XCTAssertEqual(sourceScopeDigest, expectedSourceScopeDigest, "\(description): sourceScopeDigest")
      XCTAssertEqual(occurrenceToken, expectedOccurrenceToken, "\(description): occurrenceToken")

      // Mirrors TS's `calendarMaterializedStableKey` (NUL-joined,
      // "calendar-materialized-v<version>" + uidDigest + occurrenceToken +
      // sourceScopeDigest) then `deriveEventPageId` — but the final id is
      // produced by the REAL `PageID.digestIdentified` primitive.
      let stableKey = [
        "calendar-materialized-v1",
        uidDigest,
        occurrenceToken,
        sourceScopeDigest,
      ].joined(separator: "\u{0}")

      let pageId = PageID.digestIdentified(prefix: "calendar_event", canonicalKey: stableKey)
      XCTAssertEqual(pageId.rawValue, expectedId, description)
    }
  }

  // MARK: - blobIds -> BlobID.init(contentsOf:) (EnchiridionBlobs)
  //
  // `BlobID.init(contentsOf:)` (Sources/EnchiridionBlobs/BlobReference.swift)
  // is the real production API — the same one BlobCache.swift calls — for
  // the "full, un-truncated 64-hex-char SHA-256, `blob_`-prefixed" scheme
  // documented on `deriveBlobId` in packages/graph-core/src/index.ts. This
  // test asserts that REAL function against the shared fixture directly,
  // rather than a hand-rolled CryptoKit.SHA256 duplicate of its logic.

  func testBlobIds() throws {
    let fixture = try loadFixture()
    let cases = try XCTUnwrap(fixture["blobIds"] as? [[String: Any]])
    XCTAssertGreaterThanOrEqual(cases.count, 2, "plan requires >= 2 blob fixture cases")

    for testCase in cases {
      let description = testCase["description"] as? String ?? "(no description)"
      let inputHex = try XCTUnwrap(testCase["inputHex"] as? String, description)
      let expectedId = try XCTUnwrap(testCase["expectedId"] as? String, description)

      let bytes = hexToBytes(inputHex)
      let blobId = BlobID(contentsOf: Data(bytes))
      XCTAssertEqual(blobId.rawValue, expectedId, description)
    }
  }

  // MARK: - PredicateID.property(tagID:fieldID:) — no fixture entry needed

  func testPredicateIdPropertyFormatting() {
    let predicateId = PredicateID.property(
      tagID: SupertagID(rawValue: "dev.rawkode.event"),
      fieldID: SupertagFieldID(rawValue: "start")
    )
    // Mirrors packages/graph-core/src/index.test.ts's `predicateId` case.
    XCTAssertEqual(predicateId.rawValue, "property:dev.rawkode.event:start")
  }
}
