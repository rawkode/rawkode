import XCTest
@testable import ApsidesCore

final class DailyNotePreviewTests: XCTestCase {
    func testNormalizesExcerptAndRemovesStandaloneTitle() {
        let preview = DailyNotePreview(accountID: "alice", day: "2026-09-12", editorText: "\n Today \n\n Plan\t the day\nCall Ada")
        XCTAssertEqual(preview?.text, "Plan the day Call Ada")
        XCTAssertEqual(DailyNotePreview(accountID: "alice", day: "2026-09-12", editorText: " Today \n")?.text, "")
        XCTAssertEqual(DailyNotePreview(accountID: "alice", day: "2026-09-12", editorText: "Today was productive")?.text, "Today was productive")
    }
    func testBoundsUnicodeCharactersWithoutBreakingEmoji() {
        let emoji = "👨‍👩‍👧‍👦"
        let preview = DailyNotePreview(accountID: "alice", day: "2026-09-12", editorText: String(repeating: emoji, count: 200))
        XCTAssertEqual(preview?.text.count, 160)
        XCTAssertEqual(preview?.text.last.map(String.init), emoji)
    }
    func testAccountAndDayPreventReusingAnotherNote() {
        let preview = DailyNotePreview(accountID: "alice", day: "2026-09-12", editorText: "Private note")!
        XCTAssertTrue(preview.matches(accountID: "alice", day: "2026-09-12"))
        XCTAssertFalse(preview.matches(accountID: "bob", day: "2026-09-12"))
        XCTAssertFalse(preview.matches(accountID: nil, day: "2026-09-12"))
        XCTAssertFalse(preview.matches(accountID: "alice", day: "2026-09-13"))
    }
    func testVaultPreviewRoundTripAndLegacyDecoding() throws {
        var vault = Vault()
        vault.accountID = "alice"
        vault.dailyNotePreview = DailyNotePreview(accountID: "alice", day: "2026-09-12", editorText: "Plan tomorrow")
        let encoded = try JSONEncoder().encode(vault)
        XCTAssertEqual(try JSONDecoder().decode(Vault.self, from: encoded), vault)
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        legacy.removeValue(forKey: "dailyNotePreview")
        let restored = try JSONDecoder().decode(Vault.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertNil(restored.dailyNotePreview)
        XCTAssertEqual(restored.accountID, "alice")
    }

    func testVerifiedEmptyPreviewReplacesCachedExcerpt() throws {
        var vault = Vault()
        vault.accountID = "alice"
        vault.dailyNotePreview = DailyNotePreview(accountID: "alice", day: "2026-09-12", editorText: "Old excerpt")
        vault.dailyNotePreview = try XCTUnwrap(DailyNotePreview(accountID: "alice", day: "2026-09-12", editorText: "  \n"))
        let restored = try JSONDecoder().decode(Vault.self, from: JSONEncoder().encode(vault))
        XCTAssertEqual(restored.dailyNotePreview?.text, "")
        XCTAssertTrue(restored.dailyNotePreview?.matches(accountID: "alice", day: "2026-09-12") == true)
    }

}
