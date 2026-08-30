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

    func testDecodesNamedEmployeeAndNodeTarget() throws {
        let value = CapnWebValue.object([
            "occurredAt": .string("2026-08-26T09:30:00.000Z"),
            "type": .string("commitLoroPageContent"),
            "actor": .string("workspace-member"),
            "actorDetail": .object(["kind": .string("employee"), "label": .string("Executive Assistant")]),
            "target": .object(["kind": .string("node"), "id": .string("00000000-0000-4000-8000-000000000001")]),
            "message": .string("Capture the meeting outcome in the daily note.")
        ])
        let entry = try RPCLedgerActivityEntry(value)
        XCTAssertEqual(entry.type.displayName, "Updated a note")
        XCTAssertEqual(entry.actorDetail?.kind, .employee)
        XCTAssertEqual(entry.actorDetail?.label, "Executive Assistant")
        XCTAssertEqual(entry.target?.id.rawValue, "00000000-0000-4000-8000-000000000001")
    }

    func testMalformedOptionalFieldsFallBackToLegacyActivity() throws {
        let value = CapnWebValue.object([
            "occurredAt": .string("2026-08-26T09:30:00.000Z"),
            "type": .string("ensureLoroPage"),
            "actor": .string("workspace-member"),
            "actorDetail": .object(["kind": .string("unknown"), "label": .string("Someone")]),
            "target": .object(["kind": .string("node"), "id": .string("not-an-entity-id")]),
            "message": .string("Prepare the note.")
        ])
        let entry = try RPCLedgerActivityEntry(value)
        XCTAssertNil(entry.actorDetail)
        XCTAssertNil(entry.target)
        XCTAssertEqual(entry.actor.displayName, "Workspace member")
    }
}
