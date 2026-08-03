import EnchiridionCore
import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
@MainActor
final class EditorPersistenceSessionTests: XCTestCase {
  func testFlushEncodesEditorChangesAgainstDurableHeads() async throws {
    var durable = try makeSnapshot(title: "Before", body: "")
    let originalHeads = durable.heads
    var commits: [EditorCommit] = []
    let session = EditorPersistenceSession(snapshot: durable) { commit in
      commits.append(commit)
      durable = try self.apply(commit, to: durable)
      return durable
    }

    try session.replace(title: "After", body: AttributedString("Edited"))
    let result = try await session.flush()

    XCTAssertEqual(commits.count, 1)
    XCTAssertEqual(commits[0].baseHeads, originalHeads)
    XCTAssertEqual(result.heads, durable.heads)
    XCTAssertFalse(session.isDirty)
    XCTAssertEqual(try PageDocument.richText(in: result.document).title, "After")
  }

  func testIncomingUpdateMergesInsteadOfReplacingDirtyDraft() throws {
    let original = try makeSnapshot(title: "Original", body: "Body")
    let session = EditorPersistenceSession(snapshot: original) { _ in original }
    try session.replace(title: "Local", body: AttributedString("Body"))

    let remoteResult = try PageDocument.replaceRichText(
      title: "Original",
      body: AttributedString("Remote body"),
      in: original.document
    )
    let remote = snapshot(from: remoteResult, replacing: original)

    let merged = try XCTUnwrap(session.receive(remote))
    XCTAssertTrue(session.isDirty)
    XCTAssertEqual(merged.title, "Local")
    XCTAssertEqual(String(merged.body.characters), "Remote body")
  }

  func testFlushPersistsAnEditMadeWhileThePriorCommitIsInFlight() async throws {
    var durable = try makeSnapshot(title: "Before", body: "")
    var commits: [EditorCommit] = []
    var session: EditorPersistenceSession!
    session = EditorPersistenceSession(snapshot: durable) { commit in
      commits.append(commit)
      durable = try self.apply(commit, to: durable)
      if commits.count == 1 {
        try session.replace(title: "Newest", body: AttributedString(""))
      }
      return durable
    }

    try session.replace(title: "First", body: AttributedString(""))
    let result = try await session.flush()

    XCTAssertEqual(commits.count, 2)
    XCTAssertEqual(try PageDocument.richText(in: result.document).title, "Newest")
    XCTAssertFalse(session.isDirty)
  }

  func testDirtyIncomingSnapshotIsRenderedThenLaterEditsCommitFromMergedReplica() async throws {
    var durable = try makeSnapshot(title: "Original", body: "Body")
    let session = EditorPersistenceSession(snapshot: durable) { commit in
      durable = try self.apply(commit, to: durable)
      return durable
    }
    try session.replace(title: "Local", body: AttributedString("Body"))

    let remoteResult = try PageDocument.replaceRichText(
      title: "Original",
      body: AttributedString("Remote body"),
      in: durable.document
    )
    let remote = snapshot(from: remoteResult, replacing: durable)
    let displayed = try XCTUnwrap(session.receive(remote))
    XCTAssertEqual(displayed.title, "Local")
    XCTAssertEqual(String(displayed.body.characters), "Remote body")
    // Model the repository having already adopted the incoming sync head
    // before it receives the editor's next journal append.
    durable = remote

    try session.replace(title: "Final", body: AttributedString("Remote body plus local"))
    let result = try await session.flush()
    let durableContent = try PageDocument.richText(in: result.document)
    XCTAssertEqual(durableContent.title, "Final")
    XCTAssertEqual(String(durableContent.body.characters), "Remote body plus local")
    XCTAssertFalse(session.isDirty)
  }

  func testConcurrentFlushCallersShareOneCommitLoopAndAdoptLatestDurableSnapshot() async throws {
    var durable = try makeSnapshot(title: "Before", body: "")
    let gate = CommitGate()
    var commits: [EditorCommit] = []
    let session = EditorPersistenceSession(snapshot: durable) { commit in
      commits.append(commit)
      if commits.count == 1 {
        await gate.waitForRelease()
      }
      durable = try self.apply(commit, to: durable)
      return durable
    }
    try session.replace(title: "First", body: AttributedString(""))

    let first = Task { @MainActor in try await session.flush() }
    while !(await gate.hasStarted) { await Task.yield() }
    try session.replace(title: "Final", body: AttributedString(""))
    let second = Task { @MainActor in try await session.flush() }
    await gate.release()

    let firstResult = try await first.value
    let secondResult = try await second.value
    XCTAssertEqual(commits.count, 2)
    XCTAssertEqual(Set(commits.map(\.journalID)).count, 2)
    XCTAssertEqual(firstResult.heads, secondResult.heads)
    XCTAssertEqual(try session.currentRichText().title, "Final")
    XCTAssertEqual(try PageDocument.richText(in: secondResult.document).title, "Final")
    XCTAssertFalse(session.isDirty)
  }

  private func makeSnapshot(title: String, body: String) throws -> PageSnapshot {
    let id = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000001")!)
    let createdAt = Date(timeIntervalSinceReferenceDate: 0)
    let created = try PageDocument.create(id: id, kind: .free, title: title, createdAt: createdAt)
    let result = try PageDocument.replaceRichText(
      title: title,
      body: AttributedString(body),
      in: created.document
    )
    return snapshot(from: result, id: id, createdAt: createdAt)
  }

  private func apply(_ commit: EditorCommit, to page: PageSnapshot) throws -> PageSnapshot {
    let result = try PageDocument.applyChanges(
      to: page.document,
      encodedChanges: commit.encodedChanges,
      advertisedHeads: .empty
    )
    return snapshot(from: result, replacing: page)
  }

  private func snapshot(
    from result: (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection),
    replacing previous: PageSnapshot
  ) -> PageSnapshot {
    snapshot(from: result, id: previous.id, createdAt: previous.createdAt)
  }

  private func snapshot(
    from result: (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection),
    id: PageID,
    createdAt: Date
  ) -> PageSnapshot {
    PageSnapshot(
      id: id,
      kind: .free,
      title: result.projection.title,
      plainText: result.projection.plainText,
      document: result.document,
      heads: result.heads,
      createdAt: createdAt,
      modifiedAt: createdAt,
      deletedAt: result.projection.deletedAt,
      isPinned: result.projection.isPinned,
      objectMetadata: result.projection.objectMetadata
    )
  }
}

private actor CommitGate {
  private var started = false
  private var continuation: CheckedContinuation<Void, Never>?

  var hasStarted: Bool { started }

  func waitForRelease() async {
    started = true
    await withCheckedContinuation { continuation = $0 }
  }

  func release() {
    continuation?.resume()
    continuation = nil
  }
}

