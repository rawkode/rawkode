import XCTest
@testable import AthenaeumDomain

final class StandupPublicationTests: XCTestCase {
    func testPublicProjectionRoundTripsAndUsesWireStatus() throws {
        let ref = StandupPublicationReference(kind: "job", id: "daily-standup", version: "v1")
        let publication = StandupPublication(
            id: try EntityId(validating: "00000000-0000-0000-8000-000000000001"), civilDate: "2026-08-28",
            microEmployeeLabel: "Executive", jobLabel: "Daily standup", workflowLabel: "Standup", scheduleLabel: "Weekdays",
            microEmployee: StandupPublicationReference(kind: "microEmployee", id: "executive", version: "v1"), job: ref,
            workflow: StandupPublicationReference(kind: "workflow", id: "standup", version: "v1"), schedule: StandupPublicationReference(kind: "schedule", id: "weekdays", version: "v1"), councilRefs: [StandupPublicationReference(kind: "council", id: "council", version: "v1")],
            originalText: "Done\\r\\nNext", publishedAt: try IsoDateTimeString(validating: "2026-08-28T09:00:00.000Z"), childNodeId: try EntityId(validating: "00000000-0000-8000-8000-000000000002"), companionStatus: .verifiedOriginal
        )
        let encoded = try JSONEncoder().encode(ListStandupPublicationsOutput(publications: [publication]))
        let raw = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        let item = (raw?["publications"] as? [[String: Any]])?.first
        XCTAssertEqual(item?["companionStatus"] as? String, "verified-original")
        XCTAssertEqual(item?["originalText"] as? String, "Done\\r\\nNext")
        XCTAssertNotNil(try JSONDecoder().decode(ListStandupPublicationsOutput.self, from: encoded))
    }
}
