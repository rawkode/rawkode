import XCTest
@testable import AthenaeumRPC
@testable import AthenaeumDomain

final class StandupPublicationTests: XCTestCase {
    func testResultKindDecodesAllSupportedValuesAndMissingAsNil() throws {
        let values: [(String, StandupPublicationResultKind)] = [
            ("completed", .completed),
            ("blocked", .blocked),
            ("failed", .failed),
            ("skipped", .skipped)
        ]

        for (rawValue, expected) in values {
            let publication = try decodeStandupPublication(basePublication(resultKind: .string(rawValue)))
            XCTAssertEqual(publication.resultKind, expected, "resultKind (rawValue) should decode")
        }

        let missing = try decodeStandupPublication(basePublication())
        XCTAssertNil(missing.resultKind)
        let explicitNull = try decodeStandupPublication(basePublication(resultKind: .null))
        XCTAssertNil(explicitNull.resultKind)
    }

    func testUnknownResultKindIsPrivacySafeMalformedResponse() throws {
        let privateWireValue = "future-result-with-private-details"

        XCTAssertThrowsError(try decodeStandupPublication(basePublication(resultKind: .string(privateWireValue)))) { error in
            XCTAssertEqual(error as? StandupPublicationRPCError, .malformedResponse)
            XCTAssertFalse(error.localizedDescription.contains(privateWireValue))
        }
    }

    func testRecordedWorkDecodesAsCollapsedSafeProjection() throws {
        var fields = try XCTUnwrap(basePublication().objectValue)
        fields["recordedWork"] = .object([
            "version": .string("athenaeum.standup-recorded-work.v1"),
            "state": .string("available"),
            "items": .array([
                .object([
                    "operation": .string("createdNode"),
                    "commitMessage": .string("Create a person note."),
                    "target": .object(["kind": .string("note"), "label": .string("Alice")])
                ])
            ]),
            "remainingCount": .number(1)
        ])
        let publication = try decodeStandupPublication(.object(fields))
        guard case .available(let items, let remainingCount)? = publication.recordedWork else {
            return XCTFail("expected available recorded work")
        }
        XCTAssertEqual(items.first?.operation, .createdNode)
        XCTAssertEqual(items.first?.target?.label, "Alice")
        XCTAssertEqual(remainingCount, 1)
    }

    func testRecordedWorkRejectsUnknownOperationAndPrivateKeys() throws {
        var unknownOperation = try XCTUnwrap(basePublication().objectValue)
        unknownOperation["recordedWork"] = .object([
            "version": .string("athenaeum.standup-recorded-work.v1"), "state": .string("available"),
            "items": .array([.object(["operation": .string("futureOperation"), "commitMessage": .string("future")])]),
            "remainingCount": .number(0)
        ])
        XCTAssertThrowsError(try decodeStandupPublication(.object(unknownOperation))) { error in
            XCTAssertEqual(error as? StandupPublicationRPCError, .malformedResponse)
        }

        var privateKey = try XCTUnwrap(basePublication().objectValue)
        privateKey["recordedWork"] = .object([
            "version": .string("athenaeum.standup-recorded-work.v1"), "state": .string("unavailable"),
            "grantId": .string("should-never-cross")
        ])
        XCTAssertThrowsError(try decodeStandupPublication(.object(privateKey))) { error in
            XCTAssertEqual(error as? StandupPublicationRPCError, .malformedResponse)
            XCTAssertFalse(error.localizedDescription.contains("should-never-cross"))
        }
    }

    private func basePublication(resultKind: CapnWebValue? = nil) -> CapnWebValue {
        var fields: [String: CapnWebValue] = [
            "id": .string("00000000-0000-4000-8000-000000000001"),
            "civilDate": .string("2026-08-28"),
            "microEmployeeLabel": .string("Executive"),
            "jobLabel": .string("Daily standup"),
            "workflowLabel": .string("Standup"),
            "scheduleLabel": .string("Weekdays"),
            "microEmployee": reference(kind: "microEmployee", id: "executive"),
            "job": reference(kind: "job", id: "daily-standup"),
            "workflow": reference(kind: "workflow", id: "standup"),
            "schedule": reference(kind: "schedule", id: "weekdays"),
            "councilRefs": .array([]),
            "originalText": .string("Done"),
            "publishedAt": .string("2026-08-28T09:00:00.000Z"),
            "childNodeId": .string("00000000-0000-4000-8000-000000000002"),
            "companionStatus": .string("verified-original")
        ]
        if let resultKind {
            fields["resultKind"] = resultKind
        }
        return .object(fields)
    }

    private static func reference(kind: String, id: String) -> CapnWebValue {
        .object(["kind": .string(kind), "id": .string(id), "version": .string("v1")])
    }

    private func reference(kind: String, id: String) -> CapnWebValue {
        Self.reference(kind: kind, id: id)
    }
}
