import Foundation

private struct OpenAIAttemptReceipt {
  var requestIDs: [String] = []
  var usage = AssistantTokenUsage()
  var hasUsage = false
  var actualModelID: String?
  var collector = OpenAITurnCollector()
  var disclosedSources: [AssistantSource] = []

  mutating func recordRequestID(_ value: String?) {
    guard let value = OpenAIResponsesCodec.sanitizedIdentifier(value),
      !requestIDs.contains(value)
    else { return }
    requestIDs.append(value)
  }

  mutating func recordTerminal(_ terminal: OpenAITerminalResponse, expectedModelID: String) throws {
    // Usage is part of the attempt's billing receipt even when the server's
    // model claim is missing or rejected below.
    if let terminalUsage = terminal.usage {
      usage = OpenAIResponsesCodec.adding(usage, terminalUsage)
      hasUsage = true
    }
    guard let actual = OpenAIResponsesCodec.sanitizedIdentifier(terminal.model),
      actual == expectedModelID
    else { throw OpenAIResponsesAssistantError.invalidResponse }
    actualModelID = actual

  }

  mutating func recordDisclosures() {
    for source in collector.sources where !disclosedSources.contains(where: { $0.id == source.id })
    {
      disclosedSources.append(source)
    }
  }
}

/// Selects the provider once at the start of each handheld turn. OpenAI is
/// text-only; dictated/voice turns remain on Apple's on-device answerer.
public actor OpenAIResponsesAssistant: AssistantConversationAnswering {
  private let toolExecutor: OpenAILocalToolExecutor
  private let appleAnswerer: FoundationModelAssistant
  private let routeSnapshot:
    @Sendable (AssistantConversationRoute?) async -> AssistantTextRouteSnapshot
  private let credential: @Sendable (OpenAICredentialBinding) async throws -> String
  private let transport: any OpenAIResponsesTransporting

  public init(
    repository: LibraryRepository,
    appleAnswerer: FoundationModelAssistant,
    credentialStore: OpenAICredentialStore,
    routeSnapshot:
      @escaping @Sendable (AssistantConversationRoute?) async -> AssistantTextRouteSnapshot
  ) {
    toolExecutor = OpenAILocalToolExecutor(repository: repository)
    self.appleAnswerer = appleAnswerer
    self.routeSnapshot = routeSnapshot
    credential = { binding in
      try await credentialStore.runtimeCredential(matching: binding)
    }
    transport = NativeOpenAIResponsesTransport()
  }

  init(
    repository: LibraryRepository,
    appleAnswerer: FoundationModelAssistant,
    routeSnapshot:
      @escaping @Sendable (AssistantConversationRoute?) async -> AssistantTextRouteSnapshot,
    credential: @escaping @Sendable (OpenAICredentialBinding) async throws -> String,
    transport: any OpenAIResponsesTransporting
  ) {
    toolExecutor = OpenAILocalToolExecutor(repository: repository)
    self.appleAnswerer = appleAnswerer
    self.routeSnapshot = routeSnapshot
    self.credential = credential
    self.transport = transport
  }

  public func respond(to request: AssistantConversationRequest) async -> GroundedAssistantResponse {
    if request.modality == .voice {
      return await appleResponse(to: request)
    }

    let snapshot = await routeSnapshot(request.routeOverride)
    guard snapshot.provider == .openAI else {
      return await appleResponse(to: request)
    }
    guard let modelID = snapshot.modelID else {
      return failure(
        .authorization(snapshot.authorizationFailure ?? .modelSelectionRequired),
        modelID: nil
      )
    }
    guard snapshot.authorizationFailure == nil, let binding = snapshot.credentialBinding else {
      return failure(
        .authorization(snapshot.authorizationFailure ?? .credentialVerificationRequired),
        modelID: modelID
      )
    }

    let openAIHistory = request.priorTurns.filter {
      $0.modality == .text
        && $0.metadata?.requestedProvider == .openAI
        && $0.metadata?.completion == .completed
    }.suffix(AssistantConversationSession.defaultMaximumContextTurns)
    var routedRequest = request
    routedRequest.priorTurns = Array(openAIHistory)
    let sanitized = AssistantModelRequestSanitizer.sanitize(routedRequest)

    do {
      let runtimeCredential = try await credential(binding)
      try Task.checkCancellation()
      let shouldUseCleanContext = sanitized.request.priorTurns.last?.provenance == .localDataDerived
      var effectiveRequest = sanitized.request
      if shouldUseCleanContext { effectiveRequest.priorTurns = [] }
      let boundedRequest = OpenAIResponsesRequestBuilder.boundedHistory(
        AssistantModelRequestSanitizer.sanitize(effectiveRequest)
      )
      return await performAttempt(
        boundedRequest,
        modelID: modelID,
        credential: runtimeCredential,
        priorOpenAITurnCount: boundedRequest.request.priorTurns.count
      )
    } catch is CancellationError {
      return failure(.networkUnavailable, modelID: modelID)
    } catch OpenAICredentialStoreError.bindingMismatch {
      return failure(.credentialBinding, modelID: modelID)
    } catch let error as OpenAIResponsesAssistantError {
      return failure(error, modelID: modelID)
    } catch is URLError {
      return failure(.networkUnavailable, modelID: modelID)
    } catch {
      return failure(.invalidResponse, modelID: modelID)
    }
  }

  public func resetConversation() async {
    await appleAnswerer.resetConversation()
  }

  private func appleResponse(
    to request: AssistantConversationRequest
  ) async -> GroundedAssistantResponse {
    let appleHistory = request.priorTurns.filter {
      $0.metadata == nil || $0.metadata?.requestedProvider == .appleOnDevice
    }
    var response = await appleAnswerer.respond(
      to: request.utterance,
      context: appleHistory,
      locale: request.locale,
      now: request.now
    )
    response.metadata = AssistantResponseMetadata(
      requestedProvider: .appleOnDevice,
      routeLabel: "Apple On Device",
      completion: response.status == .unavailable ? .failed : .completed
    )
    return response
  }

  private func performAttempt(
    _ sanitized: SanitizedAssistantConversationRequest,
    modelID: String,
    credential: String,
    priorOpenAITurnCount: Int
  ) async -> GroundedAssistantResponse {
    var continuationItems: [OpenAIJSONValue] = []
    var toolCallCount = 0
    var receipt = OpenAIAttemptReceipt()

    do {
      while true {
        try Task.checkCancellation()
        let body = try OpenAIResponsesRequestBuilder.makeBody(
          request: sanitized,
          modelID: modelID,
          continuationItems: continuationItems
        )
        receipt.recordDisclosures()
        let result = try await transport.send(body: body, credential: credential)
        receipt.recordRequestID(result.requestID)
        if let failure = OpenAIResponsesErrorClassifier.failure(for: result) { throw failure }

        let terminal = try OpenAIResponsesCodec.terminalResponse(from: result.events)
        try receipt.recordTerminal(terminal, expectedModelID: modelID)
        switch terminal.status {
        case .completed: break
        case .incomplete: throw OpenAIResponsesAssistantError.incomplete
        case .failed: throw OpenAIResponsesAssistantError.failed
        }

        let calls = try OpenAIResponsesCodec.toolCalls(in: terminal.output)
        guard calls.count <= 1 else { throw OpenAIResponsesAssistantError.invalidResponse }
        if let call = calls.first {
          toolCallCount += 1
          guard toolCallCount <= 4 else { throw OpenAIResponsesAssistantError.tooManyToolCalls }
          let toolResult = try await toolExecutor.execute(
            call,
            now: sanitized.request.now,
            eligibleCalendarSourceIDs: receipt.collector.eligibleCalendarSourceIDs
          )
          receipt.collector.record(toolResult)
          continuationItems.append(contentsOf: terminal.output)
          continuationItems.append(
            .object([
              "type": .string("function_call_output"),
              "call_id": .string(call.callID),
              "output": .string(toolResult.output),
            ])
          )
          continue
        }

        let response = try resolvedResponse(
          content: OpenAIResponsesCodec.content(in: terminal.output),
          toolCallCount: toolCallCount,
          collector: receipt.collector
        )
        return presented(
          response,
          modelID: modelID,
          priorOpenAITurnCount: priorOpenAITurnCount,
          receipt: receipt
        )
      }
    } catch is CancellationError {
      return failure(.networkUnavailable, modelID: modelID, receipt: receipt)
    } catch let error as OpenAIResponsesAssistantError {
      return failure(error, modelID: modelID, receipt: receipt)
    } catch is URLError {
      return failure(.networkUnavailable, modelID: modelID, receipt: receipt)
    } catch {
      return failure(.invalidResponse, modelID: modelID, receipt: receipt)
    }
  }

  private func resolvedResponse(
    content: OpenAIResponseContent,
    toolCallCount: Int,
    collector: OpenAITurnCollector
  ) throws -> GroundedAssistantResponse {
    switch content {
    case .refusal(let refusal) where toolCallCount == 0:
      return GroundedAssistantResponse(answer: refusal, status: .answered)
    case .refusal:
      // Once local tool output has crossed the provider boundary, model prose
      // is untrusted for presentation even when labelled as a refusal.
      return GroundedAssistantResponse(
        answer: "I can’t help with that request.",
        status: .answered
      )
    case .answer(let structuredAnswer) where toolCallCount == 0:
      let answer = structuredAnswer.answer.trimmingCharacters(in: .whitespacesAndNewlines)
      guard structuredAnswer.factIDs.isEmpty, !answer.isEmpty, answer.count <= 1_200 else {
        throw OpenAIResponsesAssistantError.invalidResponse
      }
      return GroundedAssistantResponse(answer: answer, status: .answered)
    case .answer(let structuredAnswer):
      return FoundationModelAssistant.resolveModelTurn(
        answer: structuredAnswer.answer,
        usesLocalSources: true,
        selectedFactIDs: structuredAnswer.factIDs,
        availableFacts: collector.facts,
        availableSources: collector.sources,
        ambiguousTitles: collector.ambiguousTitles,
        didUseTools: true,
        trustedEmptyAnswer: collector.trustedEmptyAnswer
      )
    case .none where !collector.facts.isEmpty:
      return FoundationModelAssistant.resolveModelTurn(
        answer: "",
        usesLocalSources: true,
        selectedFactIDs: collector.facts.map(\.id),
        availableFacts: collector.facts,
        availableSources: collector.sources,
        ambiguousTitles: collector.ambiguousTitles,
        didUseTools: true,
        trustedEmptyAnswer: collector.trustedEmptyAnswer
      )
    case .none:
      guard let trustedEmptyAnswer = collector.trustedEmptyAnswer else {
        throw OpenAIResponsesAssistantError.invalidResponse
      }
      return GroundedAssistantResponse(answer: trustedEmptyAnswer, status: .noResults)
    }
  }

  private func presented(
    _ response: GroundedAssistantResponse,
    modelID: String,
    priorOpenAITurnCount: Int,
    receipt: OpenAIAttemptReceipt
  ) -> GroundedAssistantResponse {
    var response = response
    response.sources = receipt.disclosedSources
    response.metadata = AssistantResponseMetadata(
      requestedProvider: .openAI,
      requestedModelID: modelID,
      actualModelID: receipt.actualModelID,
      routeLabel: Self.routeLabel(modelID: modelID),
      usage: receipt.hasUsage ? receipt.usage : nil,
      requestIDs: receipt.requestIDs,
      completion: .completed,
      priorOpenAITurnCount: priorOpenAITurnCount,
      localContextCount: receipt.disclosedSources.count
    )
    return response
  }
  private static func routeLabel(modelID: String) -> String {
    let title =
      OpenAIModelCatalog.textOptions.first(where: { $0.id == modelID })?.title
      ?? modelID
    return "OpenAI · \(title)"
  }

  private func failure(
    _ error: OpenAIResponsesAssistantError,
    modelID: String?,
    receipt: OpenAIAttemptReceipt = OpenAIAttemptReceipt()
  ) -> GroundedAssistantResponse {
    let message: String
    let recovery: AssistantRecoveryAction
    let completion: AssistantResponseCompletion
    switch error {
    case .authorization(.consentRequired):
      message = "Review and approve OpenAI Text in Settings before sending this message."
      recovery = .openSettings
      completion = .failed
    case .authorization(.credentialVerificationRequired), .credentialBinding:
      message = "The OpenAI key changed or needs verification. Open Settings to verify it again."
      recovery = .openSettings
      completion = .failed
    case .authorization(.modelSelectionRequired):
      message = "Choose an available OpenAI text model in Settings, then try again."
      recovery = .openSettings
      completion = .failed
    case .authorization(.modelUnavailable):
      message =
        "That OpenAI model is no longer available to this project. Verify the key and choose another model."
      recovery = .openSettings
      completion = .failed
    case .authorizationRejected:
      message =
        "OpenAI could not authorize this API request. Check the key, organization, project, and network access in Settings."
      recovery = .openSettings
      completion = .failed
    case .accessDenied:
      message =
        "OpenAI denied this API request. Project permissions or regional availability may apply. Review the provider settings."
      recovery = .openSettings
      completion = .failed
    case .rateLimited(let seconds):
      message =
        seconds.map { "OpenAI rate-limited this request. Try again in \($0) seconds." }
        ?? "OpenAI rate-limited this request. Wait, then try again."
      recovery = .retry
      completion = .failed
    case .billingRequired:
      message =
        "OpenAI could not bill this API request. Check the API project's billing and limits."
      recovery = .openSettings
      completion = .failed
    case .serviceUnavailable:
      message = "OpenAI is temporarily unavailable. Try again later."
      recovery = .retry
      completion = .failed
    case .networkUnavailable:
      message = "The OpenAI request did not complete. Check your connection and try again."
      recovery = .retry
      completion = .failed
    case .incomplete:
      message = "OpenAI could not finish this response. You can retry when ready."
      recovery = .retry
      completion = .incomplete
    case .failed, .invalidResponse, .tooManyToolCalls:
      message = "OpenAI could not complete this response safely. You can retry when ready."
      recovery = .retry
      completion = .failed
    }
    return GroundedAssistantResponse(
      answer: message,
      status: .unavailable,
      sources: receipt.disclosedSources,
      metadata: AssistantResponseMetadata(
        requestedProvider: .openAI,
        requestedModelID: modelID,
        actualModelID: receipt.actualModelID,
        routeLabel: modelID.map(Self.routeLabel) ?? "OpenAI",
        usage: receipt.hasUsage ? receipt.usage : nil,
        requestIDs: receipt.requestIDs,
        completion: completion,
        localContextCount: receipt.disclosedSources.count,
        recoveryAction: recovery
      )
    )
  }
}
