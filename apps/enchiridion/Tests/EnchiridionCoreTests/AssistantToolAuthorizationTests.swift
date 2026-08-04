import Foundation
import XCTest

@testable import EnchiridionCore

final class AssistantToolAuthorizationTests: XCTestCase {
  func testNeutralExecutorIsWireEquivalentToOpenAIAdapter() async throws {
    let repository = try makeRepository()
    _ = try await repository.createFreePage(title: "Launch notes")
    let authorization = AssistantTurnRetrievalAuthorization(noteSearch: try AssistantNoteSearchAuthorization(query: try AssistantApprovedQuery(originalQuery: "Launch"), maximumResults: 1))
    let arguments = "{\"query\":\"Launch\",\"limit\":1}"
    let openAI = try await OpenAILocalToolExecutor(repository: repository).execute(OpenAILocalToolCall(name: "searchNotes", callID: "one", arguments: arguments), now: Date(), eligibleCalendarSourceIDs: [], authorization: authorization)
    let neutral = try await AssistantLocalToolExecutor(repository: repository).execute(AssistantLocalToolCall(name: .searchNotes, callID: .init(rawValue: "one"), arguments: arguments), now: Date(), eligibleCalendarSourceIDs: [], authorization: authorization)
    XCTAssertEqual(neutral.output, openAI.output)
    XCTAssertEqual(neutral.sources, openAI.sources)
    XCTAssertEqual(neutral.facts, openAI.facts)
  }

  func testProposalConfirmationIsOneShotAndArgumentsStayImmutable() async throws {
    let ledger = AssistantTaskMutationProposalLedger()
    let call = AssistantToolCallID(rawValue: "create")
    let proposal = AssistantTaskMutationProposal.create(callID: call, draft: TaskDraft(title: "Keep exact"))
    let firstRecord = await ledger.record(proposal)
    let secondRecord = await ledger.record(proposal)
    let beforeConfirmation = await ledger.consumeConfirmed(call)
    let confirmed = await ledger.confirm(call)
    let consumed = await ledger.consumeConfirmed(call)
    let replay = await ledger.consumeConfirmed(call)
    let confirmAgain = await ledger.confirm(call)
    XCTAssertTrue(firstRecord)
    XCTAssertFalse(secondRecord)
    XCTAssertNil(beforeConfirmation)
    XCTAssertTrue(confirmed)
    XCTAssertEqual(consumed, proposal)
    XCTAssertNil(replay)
    XCTAssertFalse(confirmAgain)
    let rejectedCall = AssistantToolCallID(rawValue: "rejected")
    let rejectedRecorded = await ledger.record(.create(callID: rejectedCall, draft: TaskDraft(title: "Never write")))
    let rejected = await ledger.reject(rejectedCall)
    let rejectedConsumed = await ledger.consumeConfirmed(rejectedCall)
    XCTAssertTrue(rejectedRecorded)
    XCTAssertTrue(rejected)
    XCTAssertNil(rejectedConsumed)
  }

  func testConditionalTaskWritesRequireCurrentHeadsAndDirtyGeneration() async throws {
    let repository = try makeRepository()
    let coordinator = TaskMutationCoordinator(
      repository: repository,
      effects: TaskMutationEffectExecutor { _ in .applied }
    )
    let created = try await unwrapSuccess(
      coordinator.create(TaskDraft(title: "CAS task"))
    )
    let original = TaskPageVersion(created.value)
    var updatedData = try XCTUnwrap(created.value.taskData)
    updatedData.priority = .high
    let updated = try await unwrapSuccess(
      coordinator.update(pageID: created.value.id, data: updatedData, expectedVersion: original)
    )
    XCTAssertEqual(updated.value.taskData?.priority, .high)

    let staleHeads = await coordinator.complete(created.value.id, expectedVersion: original)
    XCTAssertEqual(staleHeads, .failure(TaskMutationFailure(operation: .complete, reason: .clarificationStale)))
    let afterStaleHeads = try await repository.page(id: created.value.id)
    XCTAssertEqual(afterStaleHeads?.taskData?.state, .active)

    let current = TaskPageVersion(updated.value)
    let staleGeneration = TaskPageVersion(id: current.id, heads: current.heads, dirtyGeneration: current.dirtyGeneration + 1)
    let staleDirty = await coordinator.complete(created.value.id, expectedVersion: staleGeneration)
    XCTAssertEqual(staleDirty, .failure(TaskMutationFailure(operation: .complete, reason: .clarificationStale)))
    let afterStaleDirty = try await repository.page(id: created.value.id)
    XCTAssertEqual(afterStaleDirty?.taskData?.state, .active)
  }

  private func makeRepository() throws -> LibraryRepository {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("enchiridion-neutral-tools-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return try LibraryRepository(path: directory.appendingPathComponent("library.sqlite").path)
  }

  private func unwrapSuccess<Value>(
    _ result: TaskMutationResult<Value>, file: StaticString = #filePath, line: UInt = #line
  ) throws -> TaskMutationSuccess<Value> {
    guard case .success(let value) = result else { XCTFail("Expected success", file: file, line: line); throw NSError(domain: "test", code: 1) }
    return value
  }
}
