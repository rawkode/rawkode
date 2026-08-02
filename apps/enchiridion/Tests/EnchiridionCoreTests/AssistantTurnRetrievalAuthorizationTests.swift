import Foundation
import XCTest

@testable import EnchiridionCore

final class AssistantTurnRetrievalAuthorizationTests: XCTestCase {
  func testDefaultResponsesRequestExposesNoLocalToolsOrContext() throws {
    let request = AssistantConversationRequest(
      utterance: "Find my private launch notes",
      priorTurns: [],
      locale: Locale(identifier: "en_GB"),
      now: Date(timeIntervalSince1970: 1_753_891_200)
    )

    let body = try OpenAIResponsesRequestBuilder.makeBody(
      request: AssistantModelRequestSanitizer.sanitize(request),
      modelID: "gpt-5.6-terra",
      continuationItems: []
    )
    let object = try XCTUnwrap(
      try JSONDecoder().decode(OpenAIJSONValue.self, from: body).objectValue
    )

    XCTAssertEqual(object["tools"], .array([]))
    XCTAssertEqual(object["tool_choice"], .string("none"))
    XCTAssertFalse(String(decoding: body, as: UTF8.self).contains("Launch notes"))
  }

  func testExplicitApprovalExposesOnlyBoundedNoteSearchSchema() throws {
    let authorization = AssistantTurnRetrievalAuthorization(
      noteSearch: try AssistantNoteSearchAuthorization(
        query: try AssistantApprovedQuery(originalQuery: "Launch"),
        maximumResults: 1
      )
    )
    let request = AssistantConversationRequest(
      utterance: "Find my launch notes",
      priorTurns: [],
      locale: .current,
      now: Date()
    )

    let body = try OpenAIResponsesRequestBuilder.makeBody(
      request: AssistantModelRequestSanitizer.sanitize(request),
      modelID: "gpt-5.6-terra",
      continuationItems: [],
      retrievalAuthorization: authorization
    )
    let object = try XCTUnwrap(
      try JSONDecoder().decode(OpenAIJSONValue.self, from: body).objectValue
    )
    let tools = try XCTUnwrap(object["tools"]?.arrayValue)
    let tool = try XCTUnwrap(tools.first?.objectValue)
    let parameters = try XCTUnwrap(tool["parameters"]?.objectValue)
    let properties = try XCTUnwrap(parameters["properties"]?.objectValue)

    XCTAssertEqual(tools.count, 1)
    XCTAssertEqual(tool["name"], .string("searchNotes"))
    XCTAssertEqual(properties["query"]?.objectValue?["enum"], .array([.string("Launch")]))
    XCTAssertEqual(properties["limit"]?.objectValue?["maximum"], .number(1))
  }

  func testExecutorAllowsOnlyExplicitlyApprovedBoundedRead() async throws {
    let repository = try makeRepository()
    _ = try await repository.createFreePage(title: "Launch notes")
    _ = try await repository.createFreePage(title: "Launch plan")
    let authorization = AssistantTurnRetrievalAuthorization(
      noteSearch: try AssistantNoteSearchAuthorization(
        query: try AssistantApprovedQuery(originalQuery: "Launch"),
        maximumResults: 1
      )
    )
    let executor = OpenAILocalToolExecutor(repository: repository)

    let result = try await executor.execute(
      OpenAILocalToolCall(
        name: "searchNotes",
        callID: "call_allowed",
        arguments: "{\"query\":\"Launch\",\"limit\":1}"
      ),
      now: Date(),
      eligibleCalendarSourceIDs: [],
      authorization: authorization
    )

    XCTAssertEqual(result.sources.count, 1)
    XCTAssertEqual(result.facts.count, 1)
  }

  func testExecutorFailsClosedForMissingOrTamperedAuthorizationArguments() async throws {
    let repository = try makeRepository()
    let executor = OpenAILocalToolExecutor(repository: repository)
    let noteAuthorization = AssistantTurnRetrievalAuthorization(
      noteSearch: try AssistantNoteSearchAuthorization(
        query: try AssistantApprovedQuery(originalQuery: "Launch"),
        maximumResults: 1
      )
    )
    let taskAuthorization = AssistantTurnRetrievalAuthorization(
      taskSearch: try AssistantTaskSearchAuthorization(
        scope: .today,
        query: try AssistantApprovedQuery(originalQuery: ""),
        maximumResults: 1
      )
    )
    let now = Date(timeIntervalSince1970: 1_753_891_200)
    let calendarAuthorization = AssistantTurnRetrievalAuthorization(
      calendarSearch: try AssistantCalendarSearchAuthorization(
        query: try AssistantApprovedQuery(originalQuery: ""),
        start: now,
        end: now.addingTimeInterval(3_600),
        maximumResults: 1,
        includeOngoing: false
      )
    )
    let calls: [(OpenAILocalToolCall, AssistantTurnRetrievalAuthorization?)] = [
      (
        OpenAILocalToolCall(
          name: "searchNotes", callID: "missing", arguments: "{\"query\":\"Launch\",\"limit\":1}"
        ), nil
      ),
      (
        OpenAILocalToolCall(
          name: "searchNotes", callID: "query", arguments: "{\"query\":\"Other\",\"limit\":1}"
        ), noteAuthorization
      ),
      (
        OpenAILocalToolCall(
          name: "searchNotes", callID: "limit", arguments: "{\"query\":\"Launch\",\"limit\":2}"
        ), noteAuthorization
      ),
      (
        OpenAILocalToolCall(
          name: "searchTasks", callID: "scope", arguments: "{\"scope\":\"all\",\"query\":\"\",\"limit\":1}"
        ), taskAuthorization
      ),
      (
        OpenAILocalToolCall(
          name: "findCalendarEvents", callID: "dates", arguments: calendarArguments(
            start: now,
            end: now.addingTimeInterval(7_200)
          )
        ), calendarAuthorization
      ),
    ]

    for (call, authorization) in calls {
      await XCTAssertThrowsErrorAsync(
        try await executor.execute(
          call,
          now: now,
          eligibleCalendarSourceIDs: [],
          authorization: authorization
        ),
        "\(call.callID) should fail before reading local data"
      ) { error in
        XCTAssertEqual(error as? OpenAIResponsesAssistantError, .invalidResponse)
      }
    }
  }

  func testDiagnosticRequestContainsNoHistoryToolsOrLocalContent() throws {
    let body = try OpenAIResponsesRequestBuilder.makeDiagnosticBody(modelID: "gpt-5.6-terra")
    let object = try XCTUnwrap(
      try JSONDecoder().decode(OpenAIJSONValue.self, from: body).objectValue
    )

    XCTAssertEqual(object["tools"], .array([]))
    XCTAssertEqual(object["tool_choice"], .string("none"))
    XCTAssertEqual(object["store"], .bool(false))
    XCTAssertEqual(object["max_output_tokens"], .number(32))
    XCTAssertNil(object["instructions"])
    XCTAssertNil(object["previous_response_id"])
    XCTAssertNil(object["include"])
    XCTAssertFalse(String(decoding: body, as: UTF8.self).contains("Enchiridion"))
  }

  private func makeRepository() throws -> LibraryRepository {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-retrieval-auth-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return try LibraryRepository(path: directory.appendingPathComponent("library.sqlite").path)
  }

  private func calendarArguments(start: Date, end: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return "{\"query\":\"\",\"start\":\"\(formatter.string(from: start))\",\"end\":\"\(formatter.string(from: end))\",\"limit\":1,\"includeOngoing\":false}"
  }
}

private func XCTAssertThrowsErrorAsync<T>(
  _ expression: @autoclosure () async throws -> T,
  _ message: @autoclosure () -> String = "",
  _ errorHandler: (Error) -> Void = { _ in }
) async {
  do {
    _ = try await expression()
    XCTFail(message())
  } catch {
    errorHandler(error)
  }
}
