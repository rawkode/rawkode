import XCTest
@testable import EnchiridionCore

@MainActor final class NotePersistenceTests: XCTestCase {
    private func note(_ text: String) throws -> NoteDocument {
        try NoteDocument.decode(Data("{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"\(text)\"}]}]}".utf8))
    }
    private func path() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("draft.json")
    }

    func testOfflineCloseReopenAndRefreshNeverDiscardsConflict() async throws {
        let url = path()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let local = try note("local")
        let remote = try note("remote")
        let context = try NotePersistence(url: url, read: { throw URLError(.notConnectedToInternet) }, write: { _, _ in throw URLError(.notConnectedToInternet) })
        try context.edit(local)
        await context.save()
        let reopened = try NotePersistence(url: url, read: { NoteSnapshot(document: remote, revision: 3) }, write: { _, _ in XCTFail("Must not overwrite conflict"); return 4 })
        XCTAssertEqual(reopened.document, local)
        await reopened.refresh()
        XCTAssertTrue(reopened.conflict)
        XCTAssertEqual(reopened.document, local)
        await reopened.save()
        await reopened.refresh()
        XCTAssertEqual(reopened.document, local)
    }

    func testLostReplyReconcilesAcrossRelaunchBeforeNewWrite() async throws {
        let url = path()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let first = try note("first")
        let second = try note("second")
        var remote = NoteSnapshot(document: NoteDocument(), revision: nil)
        var offline = true
        let context = try NotePersistence(url: url, read: {
            if offline { throw URLError(.notConnectedToInternet) }
            return remote
        }, write: { document, _ in
            remote = NoteSnapshot(document: document, revision: 1)
            throw URLError(.networkConnectionLost)
        })
        try context.edit(first)
        await context.save()
        try context.edit(second)
        offline = false
        var revisions: [Int?] = []
        let reopened = try NotePersistence(url: url, read: { remote }, write: { document, revision in
            revisions.append(revision)
            remote = NoteSnapshot(document: document, revision: 2)
            return 2
        })
        await reopened.save()
        XCTAssertEqual(revisions, [1])
        XCTAssertEqual(remote.document, second)
        XCTAssertFalse(reopened.dirty)
    }

    func testLateReplyKeepsDayContextsSeparateAndSerializesTyping() async throws {
        let yesterdayURL = path(), todayURL = path()
        defer {
            try? FileManager.default.removeItem(at: yesterdayURL.deletingLastPathComponent())
            try? FileManager.default.removeItem(at: todayURL.deletingLastPathComponent())
        }
        let first = try note("first"), second = try note("second"), todayNote = try note("today")
        var continuation: CheckedContinuation<Int, Never>?
        var writes: [NoteDocument] = []
        var revisions: [Int?] = []
        let yesterday = try NotePersistence(url: yesterdayURL, read: { NoteSnapshot(document: NoteDocument(), revision: nil) }, write: { document, revision in
            writes.append(document); revisions.append(revision)
            if writes.count == 1 { return await withCheckedContinuation { continuation = $0 } }
            return 2
        })
        try yesterday.edit(first)
        let request = Task { await yesterday.save() }
        while continuation == nil { await Task.yield() }
        try yesterday.edit(second)
        await yesterday.save() // Must not start a second concurrent request.
        XCTAssertEqual(writes.count, 1)
        let today = try NotePersistence(url: todayURL, read: { NoteSnapshot(document: NoteDocument(), revision: nil) }, write: { _, _ in 1 })
        try today.edit(todayNote)
        continuation?.resume(returning: 1)
        await request.value
        XCTAssertEqual(writes, [first, second])
        XCTAssertEqual(revisions, [nil, 1])
        XCTAssertEqual(today.document, todayNote)
        XCTAssertEqual(yesterday.document, second)
        XCTAssertFalse(yesterday.dirty)
    }
    func testReopenDuringInflightSaveUsesSameWriterAndRetainsNewDraft() async throws {
        let url = path()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var reply: CheckedContinuation<Int, Never>?
        var count = 0
        let first = try NotePersistence.open(url: url, read: { NoteSnapshot(document: NoteDocument(), revision: nil) }, write: { _, _ in
            count += 1
            if count == 1 { return await withCheckedContinuation { reply = $0 } }
            throw URLError(.notConnectedToInternet)
        })
        try first.edit(note("before close"))
        let request = Task { await first.save() }
        while reply == nil { await Task.yield() }
        let reopened = try NotePersistence.open(url: url, read: { XCTFail("Must reuse owner"); throw URLError(.unknown) }, write: { _, _ in XCTFail("Must reuse owner"); return 99 })
        XCTAssertTrue(first === reopened)
        let latest = try note("after reopen")
        try reopened.edit(latest)
        reply?.resume(returning: 1)
        await request.value
        let cold = try NotePersistence(url: url, read: { throw URLError(.notConnectedToInternet) }, write: { _, _ in 1 })
        XCTAssertEqual(cold.document, latest)
    }

    func testSaveRequestedDuringRefreshDrainsAfterRead() async throws {
        let url = path()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var reply: CheckedContinuation<NoteSnapshot, Never>?
        var writes = 0
        let context = try NotePersistence(url: url, read: {
            await withCheckedContinuation { reply = $0 }
        }, write: { _, _ in writes += 1; return 1 })
        let refresh = Task { await context.refresh() }
        while reply == nil { await Task.yield() }
        try context.edit(note("typed during refresh"))
        await context.save()
        reply?.resume(returning: NoteSnapshot(document: NoteDocument(), revision: nil))
        await refresh.value
        for _ in 0..<100 where context.dirty { await Task.yield() }
        XCTAssertEqual(writes, 1)
        XCTAssertFalse(context.dirty)
    }

    func testDiskFailureRetainsConflictDraftAndRetriesWithoutNetworkWrite() async throws {
        let url = path(), local = try note("local draft"), remote = try note("other device")
        let directory = url.deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: directory) }
        // A file in place of the draft directory reliably produces a disk error.
        try Data("blocked".utf8).write(to: directory)
        let context = try NotePersistence(url: url, read: { NoteSnapshot(document: remote, revision: 1) }, write: { _, _ in
            XCTFail("A conflict must not be overwritten"); return 2
        })
        XCTAssertThrowsError(try context.edit(local))
        XCTAssertEqual(context.document, local)
        XCTAssertFalse(context.locallySaved)
        await context.refresh()
        XCTAssertTrue(context.conflict)
        XCTAssertFalse(context.locallySaved)
        try FileManager.default.removeItem(at: directory)
        await context.save() // Retries disk even though conflict blocks transport.
        XCTAssertTrue(context.locallySaved)
        XCTAssertTrue(context.conflict)
        let recovered = try NotePersistence(url: url, read: { throw URLError(.unknown) }, write: { _, _ in 2 })
        XCTAssertEqual(recovered.document, local)
    }

    func testAcknowledgedSaveRetriesDiskEvenWhenRemoteIsClean() async throws {
        let url = path(), local = try note("acknowledged")
        let directory = url.deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: directory) }
        var remote = NoteSnapshot(document: NoteDocument(), revision: nil)
        var writes = 0
        let context = try NotePersistence(url: url, read: { remote }, write: { document, _ in
            writes += 1
            remote = NoteSnapshot(document: document, revision: 1)
            try FileManager.default.removeItem(at: directory)
            try Data("blocked".utf8).write(to: directory)
            return 1
        })
        try context.edit(local)
        await context.save()
        XCTAssertFalse(context.dirty)
        XCTAssertFalse(context.locallySaved)
        try FileManager.default.removeItem(at: directory)
        await context.save()
        XCTAssertTrue(context.locallySaved)
        XCTAssertEqual(writes, 1)
        let recovered = try NotePersistence(url: url, read: { remote }, write: { _, _ in 2 })
        XCTAssertEqual(recovered.document, local)
    }

    func testFailedLocalDraftSurvivesCallerReleaseUntilDiskRetry() throws {
        let url = path(), local = try note("must survive account switch")
        let directory = url.deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("blocked".utf8).write(to: directory)
        var context: NotePersistence? = try NotePersistence.open(url: url, read: { throw URLError(.notConnectedToInternet) }, write: { _, _ in 1 })
        weak var retained = context
        XCTAssertThrowsError(try context?.edit(local))
        context = nil
        XCTAssertNotNil(retained)
        var reopened: NotePersistence? = try NotePersistence.open(url: url, read: { throw URLError(.unknown) }, write: { _, _ in 2 })
        XCTAssertEqual(reopened?.document, local)
        try FileManager.default.removeItem(at: directory)
        XCTAssertTrue(reopened?.retryLocalSave() == true)
        reopened = nil
        XCTAssertNil(retained, "Successful disk recovery must release the failure-only retention")
        let cold = try NotePersistence.open(url: url, read: { throw URLError(.notConnectedToInternet) }, write: { _, _ in 1 })
        XCTAssertEqual(cold.document, local)
    }

    func testFutureAttributesInEveryRecoveredDocumentRejectWithoutChangingFile() throws {
        let url = path()
        let directory = url.deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let valid = try JSONSerialization.jsonObject(with: note("valid").encoded())
        let future: [String: Any] = ["type": "doc", "content": [["type": "paragraph", "attrs": ["futureMeaning": "must preserve"]]]]
        for location in ["document", "base", "attempted"] {
            let payload: [String: Any] = [
                "document": location == "document" ? future : valid,
                "base": ["document": location == "base" ? future : valid, "revision": 1],
                "attempted": location == "attempted" ? future : valid,
            ]
            let original = try JSONSerialization.data(withJSONObject: payload)
            try original.write(to: url)
            XCTAssertThrowsError(try NotePersistence(url: url, read: { throw URLError(.unknown) }, write: { _, _ in 1 }), location)
            XCTAssertEqual(try Data(contentsOf: url), original)
        }
    }

}
