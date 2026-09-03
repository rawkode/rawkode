import XCTest
@testable import AthenaeumDomain

final class ChangesMessageTests: XCTestCase {
    private let appId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"

    func testAppSummaryExtensionsRoundTripWithTheClosedTypeShape() throws {
        let app = try EntityId(validating: appId)
        let created = try CreatedAppSummary(appId: app, title: "Meeting brief")
        let updated = try UpdatedAppCodeSummary(appId: app, kind: .server, version: 2)
        let message = ChangesMessage(
            chatId: app,
            sequence: 4,
            createdApps: [created],
            updatedAppCode: [updated]
        )

        try assertRoundTrips(message)
        XCTAssertEqual(message.createdApps?.first?.title, "Meeting brief")
        XCTAssertEqual(message.updatedAppCode?.first?.kind, .server)
        XCTAssertEqual(message.updatedAppCode?.first?.version, 2)
    }

    func testAppSummaryExtensionsRejectValuesOutsideTheTypeScriptSchema() throws {
        let invalid = [
            #"{"chatId":"\#(appId)","sequence":1,"createdApps":[{"appId":"\#(appId)","title":""}]}"#,
            #"{"chatId":"\#(appId)","sequence":1,"updatedAppCode":[{"appId":"\#(appId)","kind":"worker","version":1}]}"#,
            #"{"chatId":"\#(appId)","sequence":1,"updatedAppCode":[{"appId":"\#(appId)","kind":"client","version":0}]}"#,
            #"{"chatId":"\#(appId)","sequence":1,"updatedAppCode":[{"appId":"\#(appId)","kind":"server","version":-1}]}"#
        ]

        for json in invalid {
            XCTAssertThrowsError(
                try JSONDecoder().decode(ChangesMessage.self, from: Data(json.utf8)),
                json
            )
        }

        XCTAssertThrowsError(try CreatedAppSummary(appId: try EntityId(validating: appId), title: ""))
        XCTAssertThrowsError(try UpdatedAppCodeSummary(appId: try EntityId(validating: appId), kind: .client, version: 0))
    }
}
