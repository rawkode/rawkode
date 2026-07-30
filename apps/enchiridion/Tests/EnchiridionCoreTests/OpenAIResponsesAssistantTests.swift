import Foundation
import XCTest

@testable import EnchiridionCore

final class OpenAIResponsesAssistantTests: XCTestCase {
  func testGoldenRequestUsesStatelessStreamingStrictResponsesContract() throws {
    let localTurn = AssistantConversationTurn(
      utterance: "What is on my calendar?",
      answer: "PRIVATE LOCAL ANSWER",
      status: .answered,
      provenance: .localDataDerived,
      metadata: openAIMetadata()
    )
    let request = AssistantConversationRequest(
      utterance: "Hi, how are you?",
      priorTurns: [localTurn],
      locale: Locale(identifier: "en_GB"),
      now: Date(timeIntervalSince1970: 0)
    )

    let body = try OpenAIResponsesRequestBuilder.makeBody(
      request: AssistantModelRequestSanitizer.sanitize(request),
      modelID: "gpt-5.6-terra",
      continuationItems: []
    )
    let object = try XCTUnwrap(
      try JSONDecoder().decode(OpenAIJSONValue.self, from: body).objectValue
    )

    XCTAssertEqual(object["model"]?.stringValue, "gpt-5.6-terra")
    XCTAssertEqual(object["store"], .bool(false))
    XCTAssertEqual(object["stream"], .bool(true))
    XCTAssertEqual(object["background"], .bool(false))
    XCTAssertEqual(object["truncation"]?.stringValue, "disabled")
    XCTAssertEqual(object["parallel_tool_calls"], .bool(false))
    XCTAssertNil(object["previous_response_id"])
    XCTAssertNil(object["conversation"])
    XCTAssertNil(object["metadata"])
    XCTAssertEqual(object["tools"]?.arrayValue?.count, 4)
    XCTAssertEqual(
      object["reasoning"]?.objectValue?["context"]?.stringValue,
      "current_turn"
    )
    let serialized = String(decoding: body, as: UTF8.self)
    XCTAssertFalse(serialized.contains("PRIVATE LOCAL ANSWER"))
    XCTAssertTrue(
      serialized.contains(AssistantModelRequestSanitizer.locallyDerivedAnswerPlaceholder))
  }

  func testSSEParserHandlesFragmentationCommentsCRLFAndMultilineData() throws {
    var parser = OpenAIResponsesSSEParser()
    var events: [Data] = []
    let chunks = [
      Data(": keepalive\r\nda".utf8),
      Data("ta: {\"type\":\r\ndata: \"response.completed\"}\r\n\r".utf8),
      Data("\ndata: [DONE]\n\n".utf8),
    ]
    for chunk in chunks {
      events.append(contentsOf: try parser.feed(chunk))
    }
    events.append(contentsOf: try parser.finish())

    XCTAssertEqual(events.count, 2)
    XCTAssertEqual(
      String(decoding: events[0], as: UTF8.self), "{\"type\":\n\"response.completed\"}")
    XCTAssertEqual(String(decoding: events[1], as: UTF8.self), "[DONE]")
  }

  func testSSEParserRejectsOversizedUnterminatedEvent() {
    var parser = OpenAIResponsesSSEParser()
    let oversized = Data(repeating: 0x61, count: OpenAIResponsesSSEParser.maximumEventBytes + 1)

    XCTAssertThrowsError(try parser.feed(oversized)) { error in
      XCTAssertEqual(error as? OpenAIResponsesSSEError, .eventTooLarge)
    }
  }

  func testTerminalResponsesDoNotRequireChatCompletionsDoneSentinel() throws {
    let terminal = completedEvent(output: [messageOutput(answer: "Hello", factIDs: [])])

    let decoded = try OpenAIResponsesCodec.terminalResponse(from: [terminal])

    XCTAssertEqual(decoded.status, .completed)
    XCTAssertEqual(decoded.model, "gpt-5.6-terra")
  }

  func testNativeTransportBuildsExactPrivateRequestAndParsesRealisticSSELifecycle() async throws {
    let terminal = completedEvent(
      output: [messageOutput(answer: "Hello", factIDs: [])],
      usage: usage(input: 2, cached: 1, output: 3, reasoning: 0)
    )
    let stream = Data("data: ".utf8) + terminal + Data("\n\ndata: [DONE]\n\n".utf8)
    let loader = RecordingOpenAIHTTPLoader(
      exchange: OpenAIResponsesHTTPExchange(
        finalURL: NativeOpenAIResponsesTransport.endpoint,
        statusCode: 200,
        headers: [
          "content-type": "text/event-stream; charset=utf-8",
          "x-request-id": "req_native",
        ],
        chunks: stride(from: 0, to: stream.count, by: 7).map {
          stream.subdata(in: $0..<min($0 + 7, stream.count))
        }
      )
    )
    let transport = NativeOpenAIResponsesTransport(loader: loader)

    let result = try await transport.send(
      body: Data("{\"model\":\"gpt-5.6-terra\"}".utf8),
      credential: "credential-fixture"
    )
    let recordedRequest = await loader.lastRequest
    let request = try XCTUnwrap(recordedRequest)

    XCTAssertEqual(request.url, URL(string: "https://api.openai.com/v1/responses"))
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer credential-fixture")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
    XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
    XCTAssertEqual(result.requestID, "req_native")
    XCTAssertEqual(result.events, [terminal, Data("[DONE]".utf8)])
  }

  func testNativeTransportUsesEphemeralNoCredentialCookieOrCachePolicy() {
    let configuration = OpenAIResponsesURLSessionPolicy.makeConfiguration()

    XCTAssertNil(configuration.urlCache)
    XCTAssertNil(configuration.httpCookieStorage)
    XCTAssertNil(configuration.urlCredentialStorage)
    XCTAssertFalse(configuration.httpShouldSetCookies)
    XCTAssertFalse(configuration.waitsForConnectivity)
    XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
  }

  func testNativeTransportBlocksRedirectedFinalURL() async throws {
    let loader = RecordingOpenAIHTTPLoader(
      exchange: OpenAIResponsesHTTPExchange(
        finalURL: URL(string: "https://example.com/redirected")!,
        statusCode: 200,
        headers: ["content-type": "text/event-stream"],
        chunks: []
      )
    )

    do {
      _ = try await NativeOpenAIResponsesTransport(loader: loader).send(
        body: Data(), credential: "credential-fixture")
      XCTFail("Redirect must be rejected")
    } catch {
      XCTAssertEqual(error as? OpenAIResponsesTransportError, .redirectBlocked)
    }
  }

  func testNativeSessionDelegateDeclinesRedirectBeforeFollowingIt() throws {
    let originalURL = NativeOpenAIResponsesTransport.endpoint
    let redirectedURL = URL(string: "https://example.com/redirected")!
    let response = try XCTUnwrap(
      HTTPURLResponse(
        url: originalURL,
        statusCode: 302,
        httpVersion: "HTTP/1.1",
        headerFields: ["Location": redirectedURL.absoluteString]
      )
    )
    let session = URLSession(configuration: .ephemeral)
    let task = session.dataTask(with: originalURL)
    var acceptedRedirect: URLRequest? = URLRequest(url: redirectedURL)

    OpenAIResponsesSessionDelegate().urlSession(
      session,
      task: task,
      willPerformHTTPRedirection: response,
      newRequest: URLRequest(url: redirectedURL)
    ) { acceptedRedirect = $0 }

    XCTAssertNil(acceptedRedirect)
    task.cancel()
    session.invalidateAndCancel()
  }

  func testNativeTransportSanitizesRetryAfterAndErrorBody() async throws {
    let errorBody = Data(
      "{\"error\":{\"code\":\"project_spend_limit_exceeded\",\"message\":\"PRIVATE RAW BODY\"}}"
        .utf8)
    let loader = RecordingOpenAIHTTPLoader(
      exchange: OpenAIResponsesHTTPExchange(
        finalURL: NativeOpenAIResponsesTransport.endpoint,
        statusCode: 429,
        headers: ["retry-after": "17", "x-request-id": "req_limit"],
        chunks: [errorBody]
      )
    )

    let result = try await NativeOpenAIResponsesTransport(loader: loader).send(
      body: Data(), credential: "credential-fixture")

    XCTAssertEqual(result.retryAfterSeconds, 17)
    XCTAssertEqual(result.requestID, "req_limit")
    XCTAssertEqual(result.errorCode, "project_spend_limit_exceeded")
    XCTAssertTrue(result.events.isEmpty)

    let unsafeLoader = RecordingOpenAIHTTPLoader(
      exchange: OpenAIResponsesHTTPExchange(
        finalURL: NativeOpenAIResponsesTransport.endpoint,
        statusCode: 400,
        headers: [:],
        chunks: [Data("{\"error\":{\"code\":\"unsafe\\ncode\"}}".utf8)]
      )
    )
    let unsafe = try await NativeOpenAIResponsesTransport(loader: unsafeLoader).send(
      body: Data(), credential: "credential-fixture")
    XCTAssertNil(unsafe.errorCode)
  }

  func testBlockedOpenAIRouteStartsNeitherTransportNorAppleFallback() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let transport = ScriptedOpenAITransport(results: [])
    let appleCalls = LockedCounter()
    let assistant = makeAssistant(
      fixture: fixture,
      transport: transport,
      appleCalls: appleCalls,
      snapshot: AssistantTextRouteSnapshot(
        provider: .openAI,
        modelID: "gpt-5.6-terra",
        authorizationFailure: .consentRequired
      )
    )

    let response = await assistant.respond(to: request("Hi, how are you?"))

    XCTAssertEqual(response.status, .unavailable)
    XCTAssertEqual(response.metadata?.requestedProvider, .openAI)
    XCTAssertEqual(response.metadata?.recoveryAction, .openSettings)
    let transportSnapshot = await transport.snapshot()
    XCTAssertEqual(transportSnapshot.callCount, 0)
    XCTAssertEqual(appleCalls.value, 0)
  }

  func testGreetingUsesSelectedOpenAIModelAndPropagatesReceipt() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let terminal = completedEvent(
      output: [messageOutput(answer: "I'm doing well — how can I help?", factIDs: [])],
      model: "gpt-5.6-terra",
      usage: usage(input: 12, cached: 4, output: 9, reasoning: 2)
    )
    let transport = ScriptedOpenAITransport(results: [success(terminal, requestID: "req_safe-123")])
    let appleCalls = LockedCounter()
    let assistant = makeAssistant(fixture: fixture, transport: transport, appleCalls: appleCalls)

    let response = await assistant.respond(to: request("Hi, how are you?"))

    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(response.answer, "I'm doing well — how can I help?")
    XCTAssertEqual(response.metadata?.requestedModelID, "gpt-5.6-terra")
    XCTAssertEqual(response.metadata?.actualModelID, "gpt-5.6-terra")
    XCTAssertEqual(response.metadata?.requestID, "req_safe-123")
    XCTAssertEqual(response.metadata?.usage?.input, 12)
    XCTAssertEqual(response.metadata?.usage?.cachedInput, 4)
    XCTAssertEqual(response.metadata?.usage?.output, 9)
    XCTAssertEqual(response.metadata?.usage?.reasoning, 2)
    XCTAssertEqual(appleCalls.value, 0)
  }

  func testOnlyRecentOpenAITextHistoryIsUploaded() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let transport = ScriptedOpenAITransport(
      results: [success(completedEvent(output: [messageOutput(answer: "Hello", factIDs: [])]))]
    )
    let assistant = makeAssistant(fixture: fixture, transport: transport)
    let turns = [
      AssistantConversationTurn(
        utterance: "APPLE PRIVATE",
        answer: "APPLE ANSWER",
        status: .answered,
        provenance: .nonLocal,
        metadata: AssistantResponseMetadata(
          requestedProvider: .appleOnDevice,
          routeLabel: "Apple On Device"
        )
      ),
      AssistantConversationTurn(
        utterance: "OPENAI CONTEXT",
        answer: "OPENAI ANSWER",
        status: .answered,
        provenance: .nonLocal,
        metadata: openAIMetadata()
      ),
      AssistantConversationTurn(
        utterance: "VOICE PRIVATE",
        answer: "VOICE ANSWER",
        status: .answered,
        provenance: .nonLocal,
        metadata: openAIMetadata(),
        modality: .voice
      ),
    ]

    _ = await assistant.respond(
      to: AssistantConversationRequest(
        utterance: "continue",
        priorTurns: turns,
        locale: .current,
        now: Date()
      )
    )
    let transportSnapshot = await transport.snapshot()
    let body = try XCTUnwrap(transportSnapshot.bodies.first)
    let serialized = String(decoding: body, as: UTF8.self)

    XCTAssertTrue(serialized.contains("OPENAI CONTEXT"))
    XCTAssertFalse(serialized.contains("APPLE PRIVATE"))
    XCTAssertFalse(serialized.contains("VOICE PRIVATE"))
  }

  func testLocalDerivedLastTurnUsesOneCleanRequestWithoutAutomaticRetry() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let transport = ScriptedOpenAITransport(
      results: [success(completedEvent(output: [messageOutput(answer: "Hello", factIDs: [])]))]
    )
    let assistant = makeAssistant(fixture: fixture, transport: transport)
    let localTurn = AssistantConversationTurn(
      utterance: "What is today?",
      answer: "LOCAL PRIVATE ANSWER",
      status: .answered,
      provenance: .localDataDerived,
      metadata: openAIMetadata()
    )

    let response = await assistant.respond(
      to: AssistantConversationRequest(
        utterance: "Hi, how are you?",
        priorTurns: [localTurn],
        locale: .current,
        now: Date()
      )
    )
    let transportSnapshot = await transport.snapshot()

    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(transportSnapshot.callCount, 1)
    XCTAssertFalse(
      String(decoding: transportSnapshot.bodies[0], as: UTF8.self).contains("What is today?"))
    XCTAssertEqual(response.metadata?.priorOpenAITurnCount, 0)
  }

  func testToolLoopPreservesFullOutputMatchesCallAndRendersOnlyTrustedFacts() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let page = try await fixture.repository.createFreePage(title: "Launch notes")
    let factID = "page:\(page.id.rawValue)#title"
    let functionOutput: OpenAIJSONValue = .object([
      "type": .string("function_call"),
      "id": .string("fc_item_1"),
      "call_id": .string("call_1"),
      "name": .string("searchNotes"),
      "arguments": .string("{\"limit\":5,\"query\":\"Launch\"}"),
    ])
    let transport = ScriptedOpenAITransport(results: [
      success(completedEvent(output: [functionOutput])),
      success(
        completedEvent(
          output: [messageOutput(answer: "MODEL PROSE MUST NOT SHIP", factIDs: [factID])]
        )
      ),
    ])
    let assistant = makeAssistant(fixture: fixture, transport: transport)

    let response = await assistant.respond(to: request("Find my launch notes"))

    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(response.answer, "A local page is titled Launch notes.")
    XCTAssertFalse(response.answer.contains("MODEL PROSE"))
    XCTAssertEqual(response.sources.map(\.title), ["Launch notes"])
    XCTAssertEqual(response.metadata?.localContextCount, 1)
    let bodies = await transport.snapshot().bodies
    XCTAssertEqual(bodies.count, 2)
    let second = String(decoding: bodies[1], as: UTF8.self)
    XCTAssertTrue(second.contains("fc_item_1"))
    XCTAssertTrue(second.contains("function_call_output"))
    XCTAssertTrue(second.contains("call_1"))
  }

  func testMalformedSelectedFactIDsUseTrustedOrderedFallback() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    _ = try await fixture.repository.createFreePage(title: "Trusted note")
    let call: OpenAIJSONValue = .object([
      "type": .string("function_call"),
      "call_id": .string("call_2"),
      "name": .string("searchNotes"),
      "arguments": .string("{\"limit\":5,\"query\":\"Trusted\"}"),
    ])
    let transport = ScriptedOpenAITransport(results: [
      success(completedEvent(output: [call])),
      success(completedEvent(output: [messageOutput(answer: "ignore", factIDs: ["invented"])])),
    ])
    let assistant = makeAssistant(fixture: fixture, transport: transport)

    let response = await assistant.respond(to: request("Find trusted note"))

    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(response.answer, "A local page is titled Trusted note.")
  }

  func testResponses403DoesNotFallbackAndOffersSettingsRecovery() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let transport = ScriptedOpenAITransport(results: [
      OpenAIResponsesTransportResult(
        statusCode: 403,
        requestID: "req_403",
        retryAfterSeconds: nil,
        events: [],
        errorCode: "permission_denied"
      )
    ])
    let appleCalls = LockedCounter()
    let assistant = makeAssistant(
      fixture: fixture,
      transport: transport,
      appleCalls: appleCalls
    )

    let response = await assistant.respond(to: request("Hello"))

    XCTAssertEqual(response.status, .unavailable)
    XCTAssertTrue(response.answer.contains("denied this API request"))
    XCTAssertEqual(response.metadata?.requestedProvider, .openAI)
    XCTAssertEqual(response.metadata?.recoveryAction, .openSettings)
    XCTAssertEqual(appleCalls.value, 0)
  }

  func testHTTPFailuresMapToSanitizedRecoveryWithoutFallback() async throws {
    let cases: [(Int, String?, AssistantRecoveryAction, String)] = [
      (401, nil, .openSettings, "could not authorize"),
      (429, "rate_limit_exceeded", .retry, "rate-limited"),
      (429, "insufficient_quota", .openSettings, "billing and limits"),
      (503, nil, .retry, "temporarily unavailable"),
    ]
    for (status, code, recovery, message) in cases {
      let fixture = try OpenAITestRepositoryFixture()
      let transport = ScriptedOpenAITransport(results: [
        OpenAIResponsesTransportResult(
          statusCode: status,
          requestID: "unsafe request id\nsecret",
          retryAfterSeconds: status == 429 ? 7 : nil,
          events: [],
          errorCode: code
        )
      ])
      let appleCalls = LockedCounter()
      let assistant = makeAssistant(
        fixture: fixture,
        transport: transport,
        appleCalls: appleCalls
      )

      let response = await assistant.respond(to: request("Hello"))

      XCTAssertEqual(response.status, .unavailable)
      XCTAssertEqual(response.metadata?.recoveryAction, recovery)
      XCTAssertTrue(response.answer.localizedCaseInsensitiveContains(message))
      XCTAssertNil(response.metadata?.requestID)
      XCTAssertEqual(appleCalls.value, 0)
    }
  }

  func testFifthSerialToolCallFailsWithoutExecutingUnboundedWork() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let results = (1...5).map { index in
      success(
        completedEvent(output: [
          .object([
            "type": .string("function_call"),
            "call_id": .string("call_\(index)"),
            "name": .string("searchNotes"),
            "arguments": .string("{\"limit\":1,\"query\":\"missing\"}"),
          ])
        ])
      )
    }
    let transport = ScriptedOpenAITransport(results: results)
    let assistant = makeAssistant(fixture: fixture, transport: transport)

    let response = await assistant.respond(to: request("Keep searching"))
    let transportSnapshot = await transport.snapshot()

    XCTAssertEqual(response.status, .unavailable)
    XCTAssertEqual(transportSnapshot.callCount, 5)
    XCTAssertEqual(response.metadata?.recoveryAction, .retry)
  }

  func testNoToolAnswerWithFactIDsFailsClosed() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let transport = ScriptedOpenAITransport(results: [
      success(
        completedEvent(output: [messageOutput(answer: "invented", factIDs: ["invented"])])
      )
    ])
    let assistant = makeAssistant(fixture: fixture, transport: transport)

    let response = await assistant.respond(to: request("Hello"))

    XCTAssertEqual(response.status, .unavailable)
    XCTAssertTrue(response.sources.isEmpty)
  }

  @MainActor
  func testCancellationRejectsLateCompletionAndLeavesNoPartialTurn() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let transport = SleepingOpenAITransport()
    let assistant = makeAssistant(fixture: fixture, transport: transport)
    let session = AssistantConversationSession(answerer: assistant)
    let submission = Task { await session.submit("Hello") }
    for _ in 0..<200 {
      if await transport.hasStarted { break }
      await Task.yield()
    }
    let didStart = await transport.hasStarted
    XCTAssertTrue(didStart)

    await session.stop()
    await submission.value

    XCTAssertTrue(session.turns.isEmpty)
    XCTAssertEqual(session.state, .stopped)
    let cancellationCount = await transport.cancellationCount
    XCTAssertEqual(cancellationCount, 1)
  }

  func testVoiceModalityAlwaysUsesAppleAndNeverStartsOpenAITransport() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let transport = ScriptedOpenAITransport(results: [])
    let appleCalls = LockedCounter()
    let assistant = makeAssistant(
      fixture: fixture,
      transport: transport,
      appleCalls: appleCalls
    )

    let response = await assistant.respond(
      to: AssistantConversationRequest(
        utterance: "Hello by voice",
        priorTurns: [],
        locale: .current,
        now: Date(),
        modality: .voice
      )
    )

    XCTAssertEqual(response.metadata?.requestedProvider, .appleOnDevice)
    let transportSnapshot = await transport.snapshot()
    XCTAssertEqual(transportSnapshot.callCount, 0)
    XCTAssertEqual(appleCalls.value, 1)
  }

  func testMissingMalformedOrMismatchedActualModelFailsClosed() async throws {
    for actualModel in [nil, "model with spaces", "gpt-5.6-sol"] as [String?] {
      let fixture = try OpenAITestRepositoryFixture()
      let terminal = completedEvent(
        output: [messageOutput(answer: "MUST NOT BE PRESENTED", factIDs: [])],
        model: actualModel,
        usage: usage(input: 7, cached: 2, cacheWrite: 1, output: 3, reasoning: 1)
      )
      let transport = ScriptedOpenAITransport(results: [success(terminal)])
      let assistant = makeAssistant(fixture: fixture, transport: transport)

      let response = await assistant.respond(to: request("Hello"))

      XCTAssertEqual(response.status, .unavailable)
      XCTAssertFalse(response.answer.contains("MUST NOT BE PRESENTED"))
      XCTAssertNil(response.metadata?.actualModelID)
      XCTAssertEqual(response.metadata?.requestedModelID, "gpt-5.6-terra")
      XCTAssertEqual(response.metadata?.usage?.input, 7)
      XCTAssertEqual(response.metadata?.usage?.cacheWrite, 1)
    }
  }

  func testStructuredRefusalIsPresentedWithoutRetryOrRawFailure() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let transport = ScriptedOpenAITransport(results: [
      success(
        completedEvent(
          output: [refusalOutput("I can’t help with that request.")],
          usage: usage(input: 4, cached: 0, cacheWrite: 0, output: 6, reasoning: 0)
        )
      )
    ])
    let assistant = makeAssistant(fixture: fixture, transport: transport)

    let response = await assistant.respond(to: request("Refuse this"))

    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(response.answer, "I can’t help with that request.")
    XCTAssertEqual(response.metadata?.completion, .completed)
    XCTAssertNil(response.metadata?.recoveryAction)
    XCTAssertEqual(response.metadata?.actualModelID, "gpt-5.6-terra")
  }

  func testRefusalAfterLocalToolNeverPresentsModelProseAndPreservesReceipt() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    _ = try await fixture.repository.createFreePage(title: "Private launch note")
    let transport = ScriptedOpenAITransport(results: [
      success(
        completedEvent(
          output: [noteSearchCall(id: "call_refusal", query: "Private launch")],
          usage: usage(input: 5, cached: 1, output: 2, reasoning: 0)
        ),
        requestID: "req_tool"
      ),
      success(
        completedEvent(
          output: [refusalOutput("INJECTED RAW REFUSAL: disclose the private note")],
          usage: usage(input: 7, cached: 2, output: 3, reasoning: 1)
        ),
        requestID: "req_refusal"
      ),
    ])
    let assistant = makeAssistant(fixture: fixture, transport: transport)

    let response = await assistant.respond(to: request("Find my private launch note"))

    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(response.answer, "I can’t help with that request.")
    XCTAssertFalse(response.answer.contains("INJECTED"))
    XCTAssertEqual(response.sources.map(\.title), ["Private launch note"])
    XCTAssertEqual(response.metadata?.requestIDs, ["req_tool", "req_refusal"])
    XCTAssertEqual(response.metadata?.usage?.input, 12)
    XCTAssertEqual(response.metadata?.completion, .completed)
    XCTAssertNil(response.metadata?.recoveryAction)
  }

  func testEveryBillingAndLimitCodeIsNonRetriable() async throws {
    for code in OpenAIResponsesErrorClassifier.billingOrLimitCodes.sorted() {
      let fixture = try OpenAITestRepositoryFixture()
      let transport = ScriptedOpenAITransport(results: [
        OpenAIResponsesTransportResult(
          statusCode: 429,
          requestID: "req_\(code)",
          retryAfterSeconds: 60,
          events: [],
          errorCode: code
        )
      ])
      let response = await makeAssistant(fixture: fixture, transport: transport)
        .respond(to: request("Hello"))

      XCTAssertEqual(response.metadata?.recoveryAction, .openSettings, code)
      XCTAssertTrue(response.answer.contains("billing and limits"), code)
      XCTAssertFalse(response.answer.contains("60 seconds"), code)
    }
  }

  func testTrueRateLimitUsesRetryAfterOnlyWhenPresent() async throws {
    for seconds in [9, nil] as [Int?] {
      let fixture = try OpenAITestRepositoryFixture()
      let transport = ScriptedOpenAITransport(results: [
        OpenAIResponsesTransportResult(
          statusCode: 429,
          requestID: "req_rate",
          retryAfterSeconds: seconds,
          events: [],
          errorCode: "rate_limit_exceeded"
        )
      ])
      let response = await makeAssistant(fixture: fixture, transport: transport)
        .respond(to: request("Hello"))

      XCTAssertEqual(response.metadata?.recoveryAction, .retry)
      XCTAssertEqual(response.answer.contains("9 seconds"), seconds == 9)
    }
  }

  func testCacheWriteUsageIsSummedAcrossToolCalls() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let call = noteSearchCall(id: "call_cache", query: "missing")
    let transport = ScriptedOpenAITransport(results: [
      success(
        completedEvent(
          output: [call],
          usage: usage(input: 10, cached: 2, cacheWrite: 3, output: 4, reasoning: 1)
        )
      ),
      success(
        completedEvent(
          output: [],
          usage: usage(input: 20, cached: 5, cacheWrite: 7, output: 6, reasoning: 2)
        )
      ),
    ])

    let response = await makeAssistant(fixture: fixture, transport: transport)
      .respond(to: request("Find missing"))

    XCTAssertEqual(response.status, .noResults)
    XCTAssertEqual(response.metadata?.usage?.input, 30)
    XCTAssertEqual(response.metadata?.usage?.cachedInput, 7)
    XCTAssertEqual(response.metadata?.usage?.cacheWrite, 10)
    XCTAssertEqual(response.metadata?.usage?.output, 10)
    XCTAssertEqual(response.metadata?.usage?.reasoning, 3)
  }

  func testOpenAIHistoryIsBoundedAfterJSONEscapingAndSafetyIdentifierIsAbsent() throws {
    let adversarial = String(repeating: "\\\"\\\\", count: 1_200)
    let turns = (0..<4).map { index in
      AssistantConversationTurn(
        utterance: "\(index)-\(adversarial)",
        answer: adversarial,
        status: .answered,
        provenance: .nonLocal,
        metadata: openAIMetadata()
      )
    }
    let body = try OpenAIResponsesRequestBuilder.makeBody(
      request: AssistantModelRequestSanitizer.sanitize(
        AssistantConversationRequest(
          utterance: "current",
          priorTurns: turns,
          locale: .current,
          now: Date()
        )
      ),
      modelID: "gpt-5.6-terra",
      continuationItems: []
    )
    let object = try XCTUnwrap(
      try JSONDecoder().decode(OpenAIJSONValue.self, from: body).objectValue
    )
    let input = try XCTUnwrap(object["input"]?.arrayValue)
    let history = OpenAIJSONValue.array(Array(input.dropLast()))
    let encodedHistory = try JSONEncoder().encode(history)

    XCTAssertLessThanOrEqual(
      encodedHistory.count, OpenAIResponsesRequestBuilder.maximumHistoryBytes)
    XCTAssertNil(object["safety_identifier"])
  }

  func testCalendarBriefRejectsDirectFirstForeignMalformedAndPriorTurnIDs() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_753_891_200)
    let event = testCalendarEvent(
      id: "review", title: "Design review", start: now.addingTimeInterval(3_600))
    try await fixture.repository.replaceCalendarProjection(
      [event], provider: "eventkit", refreshedAt: now)
    let calendarResults = try await fixture.repository.findCalendarEvents(
      from: now,
      through: now.addingTimeInterval(7_200),
      now: now
    )
    let sourceID = try XCTUnwrap(calendarResults.events.first?.source.id)
    let cases: [(String, [AssistantConversationTurn])] = [
      (sourceID, []),
      ("page:foreign", []),
      ("calendar:not base64", []),
      (
        sourceID,
        [
          AssistantConversationTurn(
            utterance: "Brief that event",
            answer: "Prior event",
            status: .answered,
            provenance: .localDataDerived,
            sources: [AssistantSource(id: sourceID, kind: .calendarEvent, title: "Design review")],
            metadata: openAIMetadata()
          )
        ]
      ),
    ]

    for (candidate, priorTurns) in cases {
      let transport = ScriptedOpenAITransport(results: [
        success(completedEvent(output: [calendarBriefCall(id: "brief", sourceID: candidate)]))
      ])
      let assistant = makeAssistant(fixture: fixture, transport: transport)
      let response = await assistant.respond(
        to: AssistantConversationRequest(
          utterance: "Brief it",
          priorTurns: priorTurns,
          locale: .current,
          now: now
        )
      )

      XCTAssertEqual(response.status, .unavailable, candidate)
      XCTAssertTrue(response.sources.isEmpty, candidate)
      let snapshot = await transport.snapshot()
      XCTAssertEqual(snapshot.callCount, 1, candidate)
    }
  }

  func testCalendarBriefAcceptsOnlyExactIDFromCurrentTurnFind() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let now = Date(timeIntervalSince1970: 1_753_891_200)
    let event = testCalendarEvent(
      id: "valid", title: "Roadmap review", start: now.addingTimeInterval(3_600))
    try await fixture.repository.replaceCalendarProjection(
      [event], provider: "eventkit", refreshedAt: now)
    let calendarResults = try await fixture.repository.findCalendarEvents(
      from: now,
      through: now.addingTimeInterval(7_200),
      now: now
    )
    let sourceID = try XCTUnwrap(calendarResults.events.first?.source.id)
    let transport = ScriptedOpenAITransport(results: [
      success(completedEvent(output: [calendarFindCall(now: now)])),
      success(completedEvent(output: [calendarBriefCall(id: "brief", sourceID: sourceID)])),
      success(completedEvent(output: [])),
    ])

    let response = await makeAssistant(fixture: fixture, transport: transport)
      .respond(to: request("Brief my roadmap review"))

    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(response.sources.first?.id, sourceID)
    let snapshot = await transport.snapshot()
    XCTAssertEqual(snapshot.callCount, 3)
  }

  func testFailureReceiptPreservesEveryBilledRequestAndDisclosedSource() async throws {
    for successfulToolCalls in 1...2 {
      let fixture = try OpenAITestRepositoryFixture()
      _ = try await fixture.repository.createFreePage(title: "Receipt note")
      var results: [OpenAIResponsesTransportResult] = []
      for index in 1...successfulToolCalls {
        results.append(
          success(
            completedEvent(
              output: [noteSearchCall(id: "call_\(index)", query: "Receipt")],
              usage: usage(
                input: index * 10,
                cached: index,
                cacheWrite: index + 1,
                output: index * 2,
                reasoning: index
              )
            ),
            requestID: "req_\(index)"
          )
        )
      }
      results.append(
        OpenAIResponsesTransportResult(
          statusCode: 503,
          requestID: "req_failure",
          retryAfterSeconds: nil,
          events: [],
          errorCode: "service_unavailable"
        )
      )
      let response = await makeAssistant(
        fixture: fixture,
        transport: ScriptedOpenAITransport(results: results)
      ).respond(to: request("Find receipt note"))

      XCTAssertEqual(response.status, .unavailable)
      XCTAssertEqual(response.sources.map(\.title), ["Receipt note"])
      XCTAssertEqual(response.metadata?.localContextCount, 1)
      XCTAssertEqual(
        response.metadata?.requestIDs,
        (1...successfulToolCalls).map { "req_\($0)" } + ["req_failure"]
      )
      XCTAssertEqual(response.metadata?.actualModelID, "gpt-5.6-terra")
      XCTAssertEqual(
        response.metadata?.usage?.input,
        (1...successfulToolCalls).reduce(0) { $0 + ($1 * 10) }
      )
      XCTAssertEqual(response.metadata?.recoveryAction, .retry)
    }
  }

  func testFirstHTTPFailureStillPreservesSanitizedRequestID() async throws {
    let fixture = try OpenAITestRepositoryFixture()
    let response = await makeAssistant(
      fixture: fixture,
      transport: ScriptedOpenAITransport(results: [
        OpenAIResponsesTransportResult(
          statusCode: 401,
          requestID: "req_authorization-1",
          retryAfterSeconds: nil,
          events: [],
          errorCode: "invalid_api_key"
        )
      ])
    ).respond(to: request("Hello"))

    XCTAssertEqual(response.metadata?.requestIDs, ["req_authorization-1"])
    XCTAssertNil(response.metadata?.usage)
    XCTAssertNil(response.metadata?.actualModelID)
  }

  private func makeAssistant(
    fixture: OpenAITestRepositoryFixture,
    transport: any OpenAIResponsesTransporting,
    appleCalls: LockedCounter = LockedCounter(),
    snapshot: AssistantTextRouteSnapshot = authorizedSnapshot()
  ) -> OpenAIResponsesAssistant {
    let apple = FoundationModelAssistant(
      repository: fixture.repository,
      attemptRunnerFactory: { _ in RecordingAppleRunner(counter: appleCalls) }
    )
    return OpenAIResponsesAssistant(
      repository: fixture.repository,
      appleAnswerer: apple,
      routeSnapshot: { _ in snapshot },
      credential: { _ in "runtime-credential-placeholder" },
      transport: transport
    )
  }

  private func request(_ utterance: String) -> AssistantConversationRequest {
    AssistantConversationRequest(
      utterance: utterance,
      priorTurns: [],
      locale: Locale(identifier: "en_GB"),
      now: Date(timeIntervalSince1970: 1_753_891_200)
    )
  }
}

private actor RecordingOpenAIHTTPLoader: OpenAIResponsesHTTPLoading {
  let exchange: OpenAIResponsesHTTPExchange
  private(set) var lastRequest: URLRequest?

  init(exchange: OpenAIResponsesHTTPExchange) {
    self.exchange = exchange
  }

  func load(_ request: URLRequest) -> OpenAIResponsesHTTPExchange {
    lastRequest = request
    return exchange
  }
}

private actor ScriptedOpenAITransport: OpenAIResponsesTransporting {
  private var results: [OpenAIResponsesTransportResult]
  private(set) var bodies: [Data] = []
  private(set) var callCount = 0

  init(results: [OpenAIResponsesTransportResult]) {
    self.results = results
  }

  func send(body: Data, credential: String) async throws -> OpenAIResponsesTransportResult {
    callCount += 1
    bodies.append(body)
    guard !results.isEmpty else { throw URLError(.cannotConnectToHost) }
    return results.removeFirst()
  }

  func snapshot() -> (bodies: [Data], callCount: Int) {
    (bodies, callCount)
  }
}

private actor SleepingOpenAITransport: OpenAIResponsesTransporting {
  private(set) var hasStarted = false
  private(set) var cancellationCount = 0

  func send(body: Data, credential: String) async throws -> OpenAIResponsesTransportResult {
    hasStarted = true
    do {
      try await Task.sleep(for: .seconds(60))
      throw URLError(.timedOut)
    } catch is CancellationError {
      cancellationCount += 1
      throw CancellationError()
    }
  }
}

private struct RecordingAppleRunner: AssistantModelAttemptRunning {
  let counter: LockedCounter

  func respond(
    to request: SanitizedAssistantConversationRequest
  ) async throws -> AssistantModelAttemptOutcome {
    counter.increment()
    return AssistantModelAttemptOutcome(
      response: GroundedAssistantResponse(answer: "Apple answer", status: .answered),
      didUseTools: false
    )
  }
}

private final class LockedCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0

  var value: Int { lock.withLock { count } }
  func increment() { lock.withLock { count += 1 } }
}

private final class OpenAITestRepositoryFixture {
  let repository: LibraryRepository

  init() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-openai-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    repository = try LibraryRepository(
      path: directory.appendingPathComponent("library.sqlite").path)
  }
}

private func authorizedSnapshot() -> AssistantTextRouteSnapshot {
  AssistantTextRouteSnapshot(
    provider: .openAI,
    modelID: "gpt-5.6-terra",
    credentialBinding: OpenAICredentialBinding(
      revision: "revision-placeholder",
      fingerprint: String(repeating: "a", count: 64)
    )
  )
}

private func openAIMetadata() -> AssistantResponseMetadata {
  AssistantResponseMetadata(
    requestedProvider: .openAI,
    requestedModelID: "gpt-5.6-terra",
    actualModelID: "gpt-5.6-terra",
    routeLabel: "OpenAI · Balanced"
  )
}

private func success(
  _ event: Data,
  requestID: String? = "req_test"
) -> OpenAIResponsesTransportResult {
  OpenAIResponsesTransportResult(
    statusCode: 200,
    requestID: requestID,
    retryAfterSeconds: nil,
    events: [event, Data("[DONE]".utf8)],
    errorCode: nil
  )
}

private func completedEvent(
  output: [OpenAIJSONValue],
  model: String? = "gpt-5.6-terra",
  usage: OpenAIJSONValue? = nil
) -> Data {
  var response: [String: OpenAIJSONValue] = [
    "id": .string("resp_test"),
    "status": .string("completed"),
    "output": .array(output),
  ]
  if let model { response["model"] = .string(model) }
  if let usage { response["usage"] = usage }
  return try! JSONEncoder().encode(
    OpenAIJSONValue.object([
      "type": .string("response.completed"),
      "response": .object(response),
    ])
  )
}

private func messageOutput(answer: String, factIDs: [String]) -> OpenAIJSONValue {
  let payload = try! JSONSerialization.data(
    withJSONObject: ["answer": answer, "factIDs": factIDs],
    options: [.sortedKeys]
  )
  return .object([
    "type": .string("message"),
    "role": .string("assistant"),
    "content": .array([
      .object([
        "type": .string("output_text"),
        "text": .string(String(decoding: payload, as: UTF8.self)),
      ])
    ]),
  ])
}

private func refusalOutput(_ refusal: String) -> OpenAIJSONValue {
  .object([
    "type": .string("message"),
    "role": .string("assistant"),
    "content": .array([
      .object([
        "type": .string("refusal"),
        "refusal": .string(refusal),
      ])
    ]),
  ])
}

private func noteSearchCall(id: String, query: String) -> OpenAIJSONValue {
  .object([
    "type": .string("function_call"),
    "call_id": .string(id),
    "name": .string("searchNotes"),
    "arguments": .string("{\"limit\":5,\"query\":\"\(query)\"}"),
  ])
}

private func calendarFindCall(now: Date) -> OpenAIJSONValue {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  let start = formatter.string(from: now)
  let end = formatter.string(from: now.addingTimeInterval(7_200))
  return .object([
    "type": .string("function_call"),
    "call_id": .string("find"),
    "name": .string("findCalendarEvents"),
    "arguments": .string(
      "{\"end\":\"\(end)\",\"includeOngoing\":false,\"limit\":5,\"query\":\"\",\"start\":\"\(start)\"}"
    ),
  ])
}

private func calendarBriefCall(id: String, sourceID: String) -> OpenAIJSONValue {
  .object([
    "type": .string("function_call"),
    "call_id": .string(id),
    "name": .string("briefCalendarEvent"),
    "arguments": .string("{\"peopleLimit\":6,\"sourceID\":\"\(sourceID)\"}"),
  ])
}

private func testCalendarEvent(
  id: String,
  title: String,
  start: Date
) -> CalendarEventSnapshot {
  CalendarEventSnapshot(
    identity: CalendarEventIdentity(externalIdentifier: id, occurrenceStart: start),
    title: title,
    startDate: start,
    endDate: start.addingTimeInterval(3_600),
    isAllDay: false,
    location: nil,
    notes: nil,
    url: nil,
    calendarTitle: "Work"
  )
}

private func usage(
  input: Int,
  cached: Int,
  cacheWrite: Int = 0,
  output: Int,
  reasoning: Int
) -> OpenAIJSONValue {
  .object([
    "input_tokens": .number(Double(input)),
    "input_tokens_details": .object([
      "cached_tokens": .number(Double(cached)),
      "cache_write_tokens": .number(Double(cacheWrite)),
    ]),
    "output_tokens": .number(Double(output)),
    "output_tokens_details": .object(["reasoning_tokens": .number(Double(reasoning))]),
    "total_tokens": .number(Double(input + output)),
  ])
}
