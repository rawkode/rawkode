import XCTest
@testable import AthenaeumRPC
@testable import AthenaeumDomain

final class TodayBriefTests: XCTestCase {
    func testDecodesOnlyTheTodayBriefProjection() throws {
        let value: CapnWebValue = .object([
            "localDate": .string("2026-11-01"),
            "timeZone": .string("America/New_York"),
            "from": .string("2026-11-01T04:00:00.000Z"),
            "to": .string("2026-11-02T05:00:00.000Z"),
            "calendarHistory": .object(["status": .string("found")]),
            "events": .array([
                .object([
                    "id": .string("00000000-0000-4000-8000-000000000001"),
                    "title": .string("Planning"),
                    "start": .string("2026-11-01T14:00:00.000Z"),
                    "end": .string("2026-11-01T14:30:00.000Z"),
                    "people": .array([.object(["displayName": .string("Alice")])]),
                    // Extra calendar-provider fields must not become client API surface.
                    "attendees": .array([.object(["email": .string("alice@example.test")])]),
                    "providerEventId": .string("private-provider-id")
                ])
            ])
        ])

        let brief = try RPCTodayBrief(value)
        XCTAssertEqual(brief.localDate, "2026-11-01")
        XCTAssertEqual(brief.timeZone, "America/New_York")
        XCTAssertEqual(brief.calendarHistory.status, .found)
        XCTAssertEqual(brief.events, [
            RPCTodayBriefEvent(
                id: try EntityId(validating: "00000000-0000-4000-8000-000000000001"),
                title: "Planning",
                start: try IsoDateTimeString(validating: "2026-11-01T14:00:00.000Z"),
                end: try IsoDateTimeString(validating: "2026-11-01T14:30:00.000Z"),
                people: [RPCTodayBriefPerson(displayName: "Alice")]
            )
        ])
    }

    func testRejectsUnknownHistoryStatus() throws {
        XCTAssertThrowsError(try RPCTodayBriefCalendarHistory(.object(["status": .string("not-a-status")])))
    }

    func testPersonOptionalDisplayNameDistinguishesMissingFromNull() throws {
        XCTAssertNil(try RPCTodayBriefPerson(.object([:])).displayName)

        XCTAssertThrowsError(try RPCTodayBriefPerson(.object(["displayName": .null]))) { error in
            XCTAssertEqual(error as? TodayBriefRPCError, .malformedResponse)
        }
        XCTAssertThrowsError(try RPCTodayBriefPerson(.object(["displayName": .string("")]))) { error in
            XCTAssertEqual(error as? TodayBriefRPCError, .malformedResponse)
        }
    }

    func testRejectsMalformedBrandsAndRequiredArraysWithoutEchoingWireValues() throws {
        let privateValue = "alice@example.test/provider-private-id"
        let malformed = baseBrief([
            "localDate": .string("2026-02-30"),
            "events": .object(["private": .string(privateValue)])
        ])

        XCTAssertThrowsError(try RPCTodayBrief(malformed)) { error in
            XCTAssertEqual(error as? TodayBriefRPCError, .malformedResponse)
            XCTAssertFalse(error.localizedDescription.contains(privateValue))
        }

        XCTAssertThrowsError(try RPCTodayBrief(baseBrief(["events": .object([:])])))
        XCTAssertThrowsError(try RPCTodayBrief(briefWithout("events")))

        var event: [String: CapnWebValue] = [
            "id": .string("not-an-entity-id"),
            "title": .string("Planning"),
            "start": .string("not-a-date"),
            "end": .string("2026-11-01T14:30:00.000Z"),
            "people": .object([:])
        ]
        XCTAssertThrowsError(try RPCTodayBrief(baseBrief(["events": .array([.object(event)])])))
        event.removeValue(forKey: "people")
        XCTAssertThrowsError(try RPCTodayBrief(baseBrief(["events": .array([.object(event)])])))

        XCTAssertThrowsError(try RPCTodayBrief(baseBrief(["events": .array([.object([
            "id": .string("not-an-entity-id"),
            "title": .string("Planning"),
            "start": .string("2026-11-01T14:00:00.000Z"),
            "end": .string("2026-11-01T14:30:00.000Z"),
            "people": .array([])
        ])])])))
    }

    func testRejectsEmptyDisplayNameAndMalformedOutputBrands() throws {
        let emptyName = baseBrief([
            "events": .array([.object([
                "id": .string("00000000-0000-4000-8000-000000000001"),
                "title": .string("Planning"),
                "start": .string("2026-11-01T14:00:00.000Z"),
                "end": .string("2026-11-01T14:30:00.000Z"),
                "people": .array([.object(["displayName": .string("")])])
            ])])
        ])
        XCTAssertThrowsError(try RPCTodayBrief(emptyName))
        XCTAssertThrowsError(try RPCTodayBrief(baseBrief(["timeZone": .string("Not/AZone")])))
        XCTAssertThrowsError(try RPCTodayBrief(baseBrief(["from": .string("not-a-date")])))
    }

    func testRejectsMalformedRequestScalarsBeforeTransport() async throws {
        let client = WorkspaceRPCClient(
            baseURL: try XCTUnwrap(URL(string: "http://127.0.0.1:1")),
            workspaceId: "00000000-0000-4000-8000-000000000001"
        )
        do {
            _ = try await client.getTodayBrief(localDate: "not-a-date", timeZone: "Not/AZone")
            XCTFail("Malformed request scalars must fail before an RPC call")
        } catch {
            XCTAssertTrue(error is AthenaeumDomainDecodingError)
        }
    }

    private func baseBrief(_ overrides: [String: CapnWebValue] = [:]) -> CapnWebValue {
        var fields: [String: CapnWebValue] = [
            "localDate": .string("2026-11-01"),
            "timeZone": .string("America/New_York"),
            "from": .string("2026-11-01T04:00:00.000Z"),
            "to": .string("2026-11-02T05:00:00.000Z"),
            "calendarHistory": .object(["status": .string("found")]),
            "events": .array([])
        ]
        for (key, value) in overrides { fields[key] = value }
        return .object(fields)
    }

    private func briefWithout(_ field: String) -> CapnWebValue {
        guard case .object(var fields) = baseBrief() else { fatalError("test fixture must be an object") }
        fields.removeValue(forKey: field)
        return .object(fields)
    }
}
