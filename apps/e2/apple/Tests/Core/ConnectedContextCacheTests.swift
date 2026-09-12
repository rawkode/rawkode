import Foundation
import XCTest
@testable import ApsidesCore

final class ConnectedContextCacheTests: XCTestCase {
    func testFullConnectedDaySurvivesRestartWithoutNetwork() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = VaultPersistence(url: directory.appendingPathComponent("notebook.json"))
        let fetchedAt = Date(timeIntervalSince1970: 1_000)
        let context = ConnectedContext(
            snapshot: ContextSnapshot(day: "2026-09-12", fetchedAt: fetchedAt, events: []),
            people: [ContextPerson(id: "person", name: "Ada", emails: ["ada@example.com"])],
            activity: [RepositoryActivity(id: "activity", repository: "owner/repo", title: "Fix startup", kind: "pull_request", actor: "ada", action: "opened", date: fetchedAt, url: URL(string: "https://github.com/owner/repo/pull/1"), summary: "Load saved context", number: 1)],
            partial: true)
        var vault = Vault()
        vault.accountID = "account"
        vault.context = context.snapshot
        vault.connectedContext = context
        try disk.save(vault)
        let restored = try disk.load()
        XCTAssertEqual(restored.connectedContext, context)
        XCTAssertEqual(restored.connectedContext?.snapshot.fetchedAt, fetchedAt, "Loading from disk must not make old data look fresh")
        XCTAssertEqual(restored.accountID, "account")
    }

    func testLegacyVaultKeepsCalendarWhenFullContextIsMissing() throws {
        var original = Vault()
        original.accountID = "account"
        original.context = ContextSnapshot(day: "2026-09-12", fetchedAt: Date(timeIntervalSince1970: 1_000), events: [])
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        legacy.removeValue(forKey: "connectedContext")
        let restored = try JSONDecoder().decode(Vault.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertEqual(restored.context, original.context)
        XCTAssertNil(restored.connectedContext)
    }
}
