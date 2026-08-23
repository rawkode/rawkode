import XCTest
import Automerge
@testable import AutomergeSpike

/// Empirical proof for the Athenaeum Phase 2 "Decisions" stage's Automerge-Swift question:
/// create a Text CRDT object, splice into it, read it back, and (separately) fork + merge two
/// documents to prove the CRDT merge semantics the sync protocol design depends on actually work
/// in this exact library/version, not just in automerge-swift's own upstream test suite.
final class AutomergeSpikeTests: XCTestCase {
    func testCreateSpliceAndReadTextRoundTrip() throws {
        let (doc, textId) = try AutomergeSpike.createTextDocument(initialText: "Hello")
        XCTAssertEqual(try AutomergeSpike.readText(doc: doc, textId: textId), "Hello")

        // Insert " CRDT" after "Hello" — the exact (index, delete, insertText) shape
        // `ApplyPageEditInput` (domain/src/page-rpc.ts) sends across the wire.
        try AutomergeSpike.splice(doc: doc, textId: textId, start: 5, delete: 0, insert: " CRDT")
        XCTAssertEqual(try AutomergeSpike.readText(doc: doc, textId: textId), "Hello CRDT")

        // Delete "Hello" (start 0, delete 5), leaving " CRDT".
        try AutomergeSpike.splice(doc: doc, textId: textId, start: 0, delete: 5, insert: "")
        XCTAssertEqual(try AutomergeSpike.readText(doc: doc, textId: textId), " CRDT")
    }

    func testForkAndMergeConverge() throws {
        // Proves the fork/merge primitive the plan's agent-provisional-edit design (Phase 3)
        // depends on ("Automerge branches... a chat's pending note edits are a per-chat
        // Automerge.clone fork; accept = merge fork into mainline heads") actually works.
        let (doc, textId) = try AutomergeSpike.createTextDocument(initialText: "base")
        let fork = doc.fork()

        try AutomergeSpike.splice(doc: doc, textId: textId, start: 4, delete: 0, insert: "-mainline")
        try AutomergeSpike.splice(doc: fork, textId: textId, start: 4, delete: 0, insert: "-fork")

        try doc.merge(other: fork)
        let merged = try AutomergeSpike.readText(doc: doc, textId: textId)

        // Automerge's CRDT merge is deterministic but not required to preserve either side's
        // literal ordering; the load-bearing assertion is convergence + no data loss (both
        // insertions survive), not a specific character ordering.
        XCTAssertTrue(merged.contains("mainline"))
        XCTAssertTrue(merged.contains("fork"))
        XCTAssertTrue(merged.hasPrefix("base"))
    }

    func testSyncStateGenerateAndReceiveMessage() throws {
        // Proves the actual primitive `startPageSync`/`pageSyncMessage` (sync-rpc.ts) need:
        // generateSyncMessage / receiveSyncMessage against a SyncState, the same API the backend's
        // `notes-service-live.ts` drives server-side via @automerge/automerge in TS.
        let (serverDoc, _) = try AutomergeSpike.createTextDocument(initialText: "synced")
        let clientDoc = Document()

        // `SyncState` is a reference type (class AutomergeUniffi.SyncState) — no `inout`/`&`
        // needed, matching the library's own doc-comment example in SyncState.swift.
        let serverSyncState = SyncState()
        let clientSyncState = SyncState()

        guard let msg1 = serverDoc.generateSyncMessage(state: serverSyncState) else {
            return XCTFail("expected a first sync message from a non-empty server doc")
        }
        try clientDoc.receiveSyncMessage(state: clientSyncState, message: msg1)

        // Client has nothing yet locally beyond an empty doc; it should respond with its own
        // message requesting the server's changes.
        if let msg2 = clientDoc.generateSyncMessage(state: clientSyncState) {
            try serverDoc.receiveSyncMessage(state: serverSyncState, message: msg2)
        }
        if let msg3 = serverDoc.generateSyncMessage(state: serverSyncState) {
            try clientDoc.receiveSyncMessage(state: clientSyncState, message: msg3)
        }

        guard case let .Object(clientTextId, .Text) = try clientDoc.get(obj: ObjId.ROOT, key: "text") else {
            return XCTFail("expected the synced client doc to have a Text object at root.text")
        }
        let clientText = try clientDoc.text(obj: clientTextId)
        XCTAssertEqual(clientText, "synced")
    }
}
