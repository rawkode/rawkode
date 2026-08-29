import XCTest
@testable import AthenaeumDomain

/// Unit tests for the branded-scalar validators (`EntityId`, `IsoDateTimeString`, `WorkspaceEpoch`) —
/// mirrors `packages/domain/src/node.ts`'s own validation rules (see that file's `ulidPattern`/
/// `uuidPattern`) directly, not via a fixture (there's nothing to encode: these are pure
/// validation-boundary tests, the Swift-side analog of what `Schema.decodeUnknown(EntityId)`
/// rejecting a malformed string tests on the TS side).
final class ScalarValidationTests: XCTestCase {
    func testEntityIdAcceptsUUID() throws {
        let id = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e5f")
        XCTAssertEqual(id.rawValue, "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e5f")
    }

    func testEntityIdAcceptsULID() throws {
        // A syntactically valid ULID: Crockford base32, first char 0-7, 26 chars total.
        let id = try EntityId(validating: "01ARZ3NDEKTSV4RRFFQ69G5FAV")
        XCTAssertEqual(id.rawValue, "01ARZ3NDEKTSV4RRFFQ69G5FAV")
    }

    func testEntityIdRejectsGarbage() {
        XCTAssertThrowsError(try EntityId(validating: "not-an-id"))
        XCTAssertThrowsError(try EntityId(validating: ""))
        // ULID pattern excludes I/L/O/U — this string uses 'I', which must fail even though it's
        // otherwise 26 chars, matching `ulidPattern`'s excluded-letter set exactly.
        XCTAssertThrowsError(try EntityId(validating: "I1ARZ3NDEKTSV4RRFFQ69G5FA"))
    }

    func testEntityIdDecodingFromJSONRejectsGarbage() {
        let json = Data(#""not-an-id""#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(EntityId.self, from: json))
    }

    func testIsoDateTimeStringAcceptsRFC3339() throws {
        let value = try IsoDateTimeString(validating: "2026-08-20T12:34:56.000Z")
        XCTAssertEqual(value.rawValue, "2026-08-20T12:34:56.000Z")
    }

    func testIsoDateTimeStringRejectsGarbage() {
        XCTAssertThrowsError(try IsoDateTimeString(validating: "not-a-date"))
    }

    func testWorkspaceEpochRejectsEmpty() {
        XCTAssertThrowsError(try WorkspaceEpoch(validating: ""))
    }

    func testWorkspaceEpochAcceptsNonEmpty() throws {
        let epoch = try WorkspaceEpoch(validating: "epoch-abc123")
        XCTAssertEqual(epoch.rawValue, "epoch-abc123")
    }

    func testLocalDateAcceptsRealDatesAndRejectsImpossibleDates() throws {
        XCTAssertEqual(try LocalDate(validating: "2026-02-28").rawValue, "2026-02-28")
        XCTAssertThrowsError(try LocalDate(validating: "2026-02-30"))
        XCTAssertThrowsError(try LocalDate(validating: "2026-2-28"))
    }

    func testIanaTimeZoneAcceptsKnownZoneAndRejectsUnknownZone() throws {
        XCTAssertEqual(try IanaTimeZone(validating: "Europe/London").rawValue, "Europe/London")
        XCTAssertThrowsError(try IanaTimeZone(validating: "Not/AZone"))
    }

    func testTodayBriefPersonDecodingMatchesOptionalContract() throws {
        let decoder = JSONDecoder()
        let missing = try decoder.decode(TodayBriefPerson.self, from: Data("{}".utf8))
        XCTAssertNil(missing.displayName)
        XCTAssertThrowsError(try decoder.decode(TodayBriefPerson.self, from: Data(#"{"displayName":null}"#.utf8)))
        XCTAssertThrowsError(try decoder.decode(TodayBriefPerson.self, from: Data(#"{"displayName":""}"#.utf8)))
        XCTAssertNil(try decoder.decode(TodayBriefPerson.self, from: JSONEncoder().encode(missing)).displayName)
    }
}
