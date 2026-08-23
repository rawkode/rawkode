import XCTest
import Automerge
import AthenaeumDomain
@testable import AthenaeumCore

/// Pure Automerge unit tests — no network, no `LocalWorkspaceStore`. Proves the CRDT primitives
/// `WorkspaceSyncClient` composes into the real sync loop (`WorkspaceSyncClientLiveTests`) behave
/// correctly in isolation first.
final class PageDocumentStoreTests: XCTestCase {
    private func nodeId() throws -> EntityId {
        try EntityId(validating: UUID().uuidString.lowercased())
    }

    func testEmptyDocHasNoTextUntilSynced() async throws {
        let store = PageDocumentStore()
        let id = try nodeId()
        await store.loadEmpty(nodeId: id)

        // No local edit is accepted before real content has synced in — the safety rail this
        // file's `PageDocumentStore` doc comment describes (never invent a genesis locally).
        do {
            _ = try await store.applyLocalSplice(nodeId: id, index: 0, deleteCount: 0, insertText: "oops")
            XCTFail("expected textNotYetSynced")
        } catch PageDocumentStoreError.textNotYetSynced(let failedId) {
            XCTAssertEqual(failedId, id)
        }

        // Reading text on a not-yet-synced empty doc is well-defined as "" (not an error) —
        // matches `web/src/DailyNote.tsx` rendering an empty textarea before the initial sync
        // resolves.
        let text = try await store.text(nodeId: id)
        XCTAssertEqual(text, "")
    }

    func testLoadFromSnapshotThenLocalSpliceRoundTrips() async throws {
        // Build a "server-shaped" snapshot exactly the way `notes-service-live.ts` does:
        // `Automerge.from<PageDoc>({text: ""})` then splice — reproduced here via
        // automerge-swift's explicit Text-object API, matching this package's own documented
        // wire-compatibility claim.
        let serverDoc = Document()
        let textId = try serverDoc.putObject(obj: ObjId.ROOT, key: "text", ty: .Text)
        try serverDoc.spliceText(obj: textId, start: 0, delete: 0, value: "Hello")
        let snapshotBytes = serverDoc.save()

        let store = PageDocumentStore()
        let id = try nodeId()
        let loadedText = try await store.loadFromSnapshot(nodeId: id, bytes: snapshotBytes)
        XCTAssertEqual(loadedText, "Hello")

        let afterEdit = try await store.applyLocalSplice(nodeId: id, index: 5, deleteCount: 0, insertText: " CRDT")
        XCTAssertEqual(afterEdit, "Hello CRDT")
        let rereadText = try await store.text(nodeId: id)
        XCTAssertEqual(rereadText, "Hello CRDT")

        let resaved = try await store.snapshotBytes(nodeId: id)
        XCTAssertFalse(resaved.isEmpty)

        let headsHash = try await store.headsHash(nodeId: id)
        XCTAssertFalse(headsHash.isEmpty)
    }

    /// Proves the exact generate/receive primitive pair `WorkspaceSyncClient.syncPage` composes into
    /// its network loop, entirely offline (two in-process `PageDocumentStore`s standing in for
    /// "client" and "server").
    func testGenerateAndReceiveSyncMessageConverge() async throws {
        let serverStore = PageDocumentStore()
        let clientStore = PageDocumentStore()
        let id = try nodeId()

        let serverDoc = Document()
        let textId = try serverDoc.putObject(obj: ObjId.ROOT, key: "text", ty: .Text)
        try serverDoc.spliceText(obj: textId, start: 0, delete: 0, value: "from server")
        _ = try await serverStore.loadFromSnapshot(nodeId: id, bytes: serverDoc.save())
        await clientStore.loadEmpty(nodeId: id)

        let serverState = SyncState()
        let clientState = SyncState()

        var serverMessage = try await serverStore.generateSyncMessage(nodeId: id, state: serverState)
        for _ in 0..<10 {
            if let serverMessage {
                try await clientStore.receiveSyncMessage(nodeId: id, state: clientState, message: serverMessage)
            }
            guard let clientMessage = try await clientStore.generateSyncMessage(nodeId: id, state: clientState) else {
                break
            }
            try await serverStore.receiveSyncMessage(nodeId: id, state: serverState, message: clientMessage)
            serverMessage = try await serverStore.generateSyncMessage(nodeId: id, state: serverState)
        }

        let convergedText = try await clientStore.text(nodeId: id)
        XCTAssertEqual(convergedText, "from server")
    }
}
