import Foundation
import XCTest

@testable import EnchiridionCore

final class AssistantRealtimeToolCoordinatorTests: XCTestCase {
  func testStrictDecoderRejectsUnknownAndExtraKeys() async throws {
    let fixture = try Fixture()
    let coordinator = fixture.coordinator
    await assertThrows(try await coordinator.receive(.init(name: "searchNotes", callID: .init(rawValue: "extra"), arguments: #"{"query":"x","limit":1,"extra":true}"#), authorization: .none))
    await assertThrows(try await coordinator.receive(.init(name: "unknown", callID: .init(rawValue: "unknown"), arguments: "{}"), authorization: .none))
  }

  func testReadUsesTurnAuthorizationAndCalendarBriefCannotEscapeSameTurnResults() async throws {
    let fixture = try Fixture()
    let noteAuth = AssistantTurnRetrievalAuthorization(noteSearch: try .init(query: .init(originalQuery: "Launch"), maximumResults: 1))
    _ = try await fixture.repository.createFreePage(title: "Launch plan")
    let result = try await fixture.coordinator.receive(.init(name: "searchNotes", callID: .init(rawValue: "read"), arguments: #"{"query":"Launch","limit":1}"#), authorization: noteAuth)
    guard case .terminal(let output) = result else { return XCTFail("Expected terminal output") }
    XCTAssertTrue(output.json.contains("Launch plan"))

    let sourceID = "calendar:" + Data("forged".utf8).base64EncodedString()
    let briefAuth = AssistantTurnRetrievalAuthorization(calendarBrief: try .init(allowedSourceIDs: [sourceID], maximumPeople: 1))
    await assertThrows(try await fixture.coordinator.receive(.init(name: "briefCalendarEvent", callID: .init(rawValue: "brief"), arguments: "{\"sourceID\":\"\(sourceID)\",\"peopleLimit\":1}"), authorization: briefAuth))
  }

  func testWriteWaitsForConfirmationThenRejectsReplay() async throws {
    let fixture = try Fixture()
    let callID = AssistantToolCallID(rawValue: "create")
    let arguments = #"{"title":"Confirmed task","notes":"","data":{"state":"active","placement":"inbox","scheduleGranularity":"date-time","priority":"none","tags":[],"estimatedMinutes":null}}"#
    let disposition = try await fixture.coordinator.receive(.init(name: "create_task", callID: callID, arguments: arguments), authorization: .none)
    guard case .confirmation = disposition else { return XCTFail("Expected confirmation") }
    let before = try await fixture.repository.pages(with: BuiltInSupertags.task)
    XCTAssertTrue(before.isEmpty)
    let terminal = await fixture.coordinator.confirm(callID)
    XCTAssertTrue(terminal.json.contains("success"))
    let after = try await fixture.repository.pages(with: BuiltInSupertags.task)
    XCTAssertEqual(after.count, 1)
    let replay = await fixture.coordinator.confirm(callID)
    XCTAssertTrue(replay.json.contains("rejected"))
  }

  func testStaleConditionalMutationReturnsConflictAndRejectIsTerminal() async throws {
    let fixture = try Fixture()
    let created = try await fixture.repository.createTask(TaskDraft(title: "Versioned"))
    let stale = TaskPageVersion(created)
    let taskAuthorization = AssistantTurnRetrievalAuthorization(
      taskSearch: try .init(
        scope: .all,
        query: .init(originalQuery: ""),
        maximumResults: 5
      )
    )
    _ = try await fixture.coordinator.receive(
      .init(
        name: "searchTasks",
        callID: .init(rawValue: "find-versioned"),
        arguments: #"{"scope":"all","query":"","limit":5}"#
      ),
      authorization: taskAuthorization
    )
    var changed = try XCTUnwrap(created.taskData); changed.priority = .high
    _ = try await fixture.repository.updateTask(pageID: created.id, data: changed)
    let callID = AssistantToolCallID(rawValue: "complete")
    let arguments = try json(CompleteArgs(pageID: created.id, version: stale))
    _ = try await fixture.coordinator.receive(.init(name: "complete_task", callID: callID, arguments: arguments), authorization: .none)
    let conflict = await fixture.coordinator.confirm(callID)
    XCTAssertTrue(conflict.json.contains("conflict"))
    let afterConflict = try await fixture.repository.page(id: created.id)
    XCTAssertEqual(afterConflict?.taskData?.state, .active)

    let rejectID = AssistantToolCallID(rawValue: "reject")
    let create = #"{"title":"Rejected","notes":"","data":{"state":"active","placement":"inbox","scheduleGranularity":"date-time","priority":"none","tags":[],"estimatedMinutes":null}}"#
    _ = try await fixture.coordinator.receive(.init(name: "create_task", callID: rejectID, arguments: create), authorization: .none)
    let rejected = await fixture.coordinator.reject(rejectID)
    XCTAssertTrue(rejected.json.contains("rejected"))
    let rejectedConfirm = await fixture.coordinator.confirm(rejectID)
    XCTAssertTrue(rejectedConfirm.json.contains("rejected"))
  }

  private struct CompleteArgs: Encodable { let pageID: PageID; let version: TaskPageVersion }
  private func json(_ value: some Encodable) throws -> String { String(decoding: try JSONEncoder().encode(value), as: UTF8.self) }

  private func assertThrows<T>(_ value: @autoclosure () async throws -> T) async {
    do { _ = try await value(); XCTFail("Expected error") } catch {}
  }

  private final class Fixture {
    let repository: LibraryRepository
    let coordinator: AssistantRealtimeToolCoordinator
    init() throws {
      let path = FileManager.default.temporaryDirectory.appendingPathComponent("assistant-tool-coordinator-\(UUID().uuidString).sqlite").path
      repository = try LibraryRepository(path: path)
      coordinator = AssistantRealtimeToolCoordinator(repository: repository, mutations: TaskMutationCoordinator(repository: repository, effects: .init { _ in .applied }))
    }
  }
}
