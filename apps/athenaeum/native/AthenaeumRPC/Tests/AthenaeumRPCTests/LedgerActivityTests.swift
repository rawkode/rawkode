import XCTest
@testable import AthenaeumRPC
@testable import AthenaeumDomain

final class LedgerActivityTests: XCTestCase {
    func testDecodesPrivacySafeLedgerProjection() throws {
        let value: CapnWebValue = .object([
            "entries": .array([
                .object([
                    "occurredAt": .string("2026-08-26T09:30:00.000Z"),
                    "type": .string("applySupertag"),
                    "actor": .string("you"),
                    "message": .string("Applied Supertag to a workspace node."),
                    // Internal fields must stay outside the native projection.
                    "requestId": .string("private-request-id"),
                    "fingerprint": .string("private-fingerprint")
                ])
            ])
        ])

        let entries = try value.field("entries").arrayValue!.map(RPCLedgerActivityEntry.init)
        XCTAssertEqual(entries, [
            RPCLedgerActivityEntry(
                occurredAt: try IsoDateTimeString(validating: "2026-08-26T09:30:00.000Z"),
                type: .applySupertag,
                actor: .you,
                message: "Applied Supertag to a workspace node."
            )
        ])
    }

    func testRejectsUnknownActivityTypeAndEmptyMessage() throws {
        let unknown = CapnWebValue.object([
            "occurredAt": .string("2026-08-26T09:30:00.000Z"),
            "type": .string("privateCommand"),
            "actor": .string("you"),
            "message": .string("not public")
        ])
        XCTAssertThrowsError(try RPCLedgerActivityEntry(unknown)) { error in
            XCTAssertEqual(error as? LedgerActivityRPCError, .malformedResponse)
        }

        let emptyMessage = CapnWebValue.object([
            "occurredAt": .string("2026-08-26T09:30:00.000Z"),
            "type": .string("createNode"),
            "actor": .string("you"),
            "message": .string("")
        ])
        XCTAssertThrowsError(try RPCLedgerActivityEntry(emptyMessage)) { error in
            XCTAssertEqual(error as? LedgerActivityRPCError, .malformedResponse)
        }
    }

    func testDecodesBookmarkActivity() throws {
        let value: CapnWebValue = .object([
            "occurredAt": .string("2026-08-26T09:30:00.000Z"),
            "type": .string("createBookmark"),
            "actor": .string("you"),
            "message": .string("Captured a bookmark.")
        ])
        let entry = try RPCLedgerActivityEntry(value)
        XCTAssertEqual(entry.type, .createBookmark)
        XCTAssertEqual(entry.type.displayName, "Captured a bookmark")
    }

    func testDecodesStartMeetingActivity() throws {
        let value: CapnWebValue = .object([
            "occurredAt": .string("2026-08-26T09:30:00.000Z"),
            "type": .string("startMeeting"),
            "actor": .string("you"),
            "message": .string("Started a meeting.")
        ])
        let entry = try RPCLedgerActivityEntry(value)
        XCTAssertEqual(entry.type, .startMeeting)
        XCTAssertEqual(entry.type.displayName, "Started a meeting")
    }
}
