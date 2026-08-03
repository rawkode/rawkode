import Foundation
import Observation

/// The local policy seam. A voice surface supplies only an authorization that
/// was finalized locally for this transcript; remote events cannot manufacture
/// or broaden retrieval authority.
public protocol QwenTranscriptAuthorizing: Sendable {
  func authorization(for transcript: String) async -> AssistantTurnRetrievalAuthorization
}

@MainActor
@Observable
public final class QwenRealtimeVoiceSession: QwenRealtimeVoicePresenting {
  public private(set) var phase: QwenRealtimePhase = .idle
  public private(set) var captions: [QwenRealtimeCaption] = []
  public private(set) var voiceActivity = VoiceActivitySnapshot.inactive
  public private(set) var pendingMutations: [QwenPendingMutation] = []

  @ObservationIgnored private let route: QwenVoiceRouteSnapshot
  @ObservationIgnored private let credentialReader: any QwenRealtimeCredentialReading
  @ObservationIgnored private let transport: any QwenRealtimeTransport
  @ObservationIgnored private let microphone: any RealtimeMicrophoneAuthorizing
  @ObservationIgnored private let audioSession: any RealtimeAudioSessionControlling
  @ObservationIgnored private let transcriptAuthorizer: (any QwenTranscriptAuthorizing)?
  @ObservationIgnored private let ledger: QwenVoiceAuthorizationLedger?
  @ObservationIgnored private let toolCoordinator: AssistantRealtimeToolCoordinator?
  @ObservationIgnored private let mutationHandler: (any QwenVoiceMutationHandling)?
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var eventTask: Task<Void, Never>?
  @ObservationIgnored private var activityTask: Task<Void, Never>?
  @ObservationIgnored private var callNames: [String: String] = [:]
  @ObservationIgnored private var callResponses: [String: String] = [:]
  @ObservationIgnored private var responseItems: [String: String] = [:]
  @ObservationIgnored private var mostRecentInputItemID: String?
  @ObservationIgnored private var mostRecentResponseID: String?
  @ObservationIgnored private var responseCalls: [String: Set<AssistantToolCallID>] = [:]
  @ObservationIgnored private var responseTerminalCalls: [String: Set<AssistantToolCallID>] = [:]
  @ObservationIgnored private var completedResponses: Set<String> = []
  @ObservationIgnored private var continuedResponses: Set<String> = []
  @ObservationIgnored private var awaitingFollowUpAfterResponseID: String?
  @ObservationIgnored private var ownsAudioSession = false

  public init(
    route: QwenVoiceRouteSnapshot,
    credentialReader: any QwenRealtimeCredentialReading,
    transport: any QwenRealtimeTransport,
    microphone: any RealtimeMicrophoneAuthorizing,
    audioSession: any RealtimeAudioSessionControlling,
    transcriptAuthorizer: (any QwenTranscriptAuthorizing)? = nil,
    ledger: QwenVoiceAuthorizationLedger? = nil,
    toolCoordinator: AssistantRealtimeToolCoordinator? = nil,
    mutationHandler: (any QwenVoiceMutationHandling)? = nil
  ) {
    self.route = route
    self.credentialReader = credentialReader
    self.transport = transport
    self.microphone = microphone
    self.audioSession = audioSession
    self.transcriptAuthorizer = transcriptAuthorizer
    self.ledger = ledger
    self.toolCoordinator = toolCoordinator
    self.mutationHandler = mutationHandler
  }

  deinit { eventTask?.cancel(); activityTask?.cancel() }

  public func start() async {
    guard phase == .idle || phase == .ended else { return }
    generation &+= 1
    let currentGeneration = generation
    phase = .connecting
    do {
      guard await microphone.requestPermission() == .authorized else {
        phase = .failed("Microphone access is not available.")
        return
      }
      let configuration = try QwenRealtimeConfiguration(
        route: route,
        enablesTools: toolsEnabled
      )
      guard configuration.credentialBinding == route.credentialBinding else { throw QwenRealtimeError.credentialMismatch }
      let credential = try await credentialReader.qwenRealtimeCredential(matching: configuration.credentialBinding)
      guard credential.binding == configuration.credentialBinding else { throw QwenRealtimeError.credentialMismatch }
      _ = try await transport.start(generation: currentGeneration, route: route, configuration: configuration, credential: credential)
      guard currentGeneration == generation else { await transport.close(); return }
      await ledger?.beginGeneration(currentGeneration)
      await toolCoordinator?.beginInputTurn()
      consumeEvents(generation: currentGeneration)
      consumeActivity(generation: currentGeneration)
      try await audioSession.activate()
      ownsAudioSession = true
      try await transport.setMuted(false)
      phase = .listening
    } catch {
      phase = .failed("Qwen Realtime could not start the selected route.")
      await transport.close()
      if ownsAudioSession { await audioSession.deactivate(); ownsAudioSession = false }
    }
  }

  public func stop() async {
    guard phase != .ended, phase != .idle else { return }
    phase = .ending
    eventTask?.cancel(); activityTask?.cancel()
    try? await transport.setMuted(true)
    try? await transport.send(.responseCancel)
    try? await transport.send(.outputAudioBufferClear)
    await ledger?.retire(generation: generation)
    await transport.close()
    if ownsAudioSession { await audioSession.deactivate(); ownsAudioSession = false }
    voiceActivity = .inactive
    phase = .ended
  }

  public func setMuted(_ muted: Bool) async {
    guard phase == .listening || phase == .userSpeaking || phase == .responding || phase == .muted else { return }
    do {
      try await transport.setMuted(muted)
      phase = muted ? .muted : .listening
    } catch { phase = .failed("Qwen Realtime microphone control failed.") }
  }

  public func confirmMutation(id: String) async {
    guard let toolCoordinator,
      let responseID = callResponses[id],
      pendingMutations.contains(where: { $0.id == id })
    else { return }
    let output = await toolCoordinator.confirm(.init(rawValue: id))
    await deliverTerminal(output, responseID: responseID, generation: generation)
  }

  public func rejectMutation(id: String) async {
    guard let toolCoordinator,
      let responseID = callResponses[id],
      pendingMutations.contains(where: { $0.id == id })
    else { return }
    let output = await toolCoordinator.reject(.init(rawValue: id))
    await deliverTerminal(output, responseID: responseID, generation: generation)
  }

  private var toolsEnabled: Bool {
    transcriptAuthorizer != nil && ledger != nil && toolCoordinator != nil
  }

  private func consumeEvents(generation expected: UInt64) {
    let stream = transport.events()
    eventTask = Task { @MainActor [weak self] in
      for await event in stream where !Task.isCancelled {
        guard let self, self.generation == expected else { return }
        await self.receive(event, generation: expected)
      }
    }
  }

  private func consumeActivity(generation expected: UInt64) {
    let stream = transport.activity()
    activityTask = Task { @MainActor [weak self] in
      for await sample in stream where !Task.isCancelled {
        guard let self, self.generation == expected, sample.generation == expected else { return }
        self.voiceActivity = VoiceActivitySnapshot(
          isListening: self.phase == .listening || self.phase == .userSpeaking,
          isPreparingResponse: self.phase == .responding,
          isResponding: self.phase == .responding,
          inputLevel: sample.inputLevel,
          outputLevel: sample.outputLevel
        )
      }
    }
  }

  private func receive(_ event: QwenRealtimeServerEvent, generation: UInt64) async {
    switch event {
    case .speechStarted:
      // Smart-turn barge-in is local as well as remote: stop queued speech
      // before accepting the next user utterance, with no replay afterwards.
      if phase == .responding {
        try? await transport.send(.responseCancel)
        try? await transport.send(.outputAudioBufferClear)
      }
      phase = .userSpeaking
    case .speechStopped: if phase != .muted { phase = .responding }
    case let .inputTranscriptDelta(id, text): appendCaption(id: id, role: .user, text: text, completed: false)
    case let .inputTranscriptDone(id, text):
      appendCaption(id: id, role: .user, text: text, completed: true)
      await finalizeInput(id: id, transcript: text, generation: generation)
    case let .outputTranscriptDelta(id, text): appendCaption(id: id, role: .assistant, text: text, completed: false)
    case let .outputTranscriptDone(id, text): appendCaption(id: id, role: .assistant, text: text, completed: true)
    case let .responseCreated(id, inputItemID):
      mostRecentResponseID = id
      if let predecessor = awaitingFollowUpAfterResponseID {
        do {
          try await ledger?.bindFollowUpResponse(
            generation: generation,
            responseID: id,
            after: predecessor
          )
          awaitingFollowUpAfterResponseID = nil
        } catch {
          await failAuthorization(generation: generation)
        }
      } else {
        if let itemID = inputItemID ?? mostRecentInputItemID { responseItems[id] = itemID }
        await bindResponseIfAuthorized(id, generation: generation)
      }
    case let .functionCallAdded(id, name, responseID):
      guard callNames[id] == nil else {
        await failAuthorization(generation: generation)
        return
      }
      callNames[id] = name
      callResponses[id] = responseID ?? mostRecentResponseID
      if let responseID = callResponses[id] {
        responseCalls[responseID, default: []].insert(.init(rawValue: id))
      }
      // A tool proposal interrupts audible output and capture before native
      // confirmation. It must never continue a stale spoken instruction.
      try? await transport.setMuted(true)
      try? await transport.send(.responseCancel)
      try? await transport.send(.outputAudioBufferClear)
      phase = .muted
    case let .functionCallArgumentsDone(id, argumentsJSON): await receiveFunction(id: id, argumentsJSON: argumentsJSON, generation: generation)
    case let .responseDone(id, _):
      let responseID = id ?? mostRecentResponseID
      if let responseID {
        completedResponses.insert(responseID)
        if responseCalls[responseID, default: []].isEmpty {
          await ledger?.retire(generation: generation)
          if phase != .muted { phase = .listening }
        } else {
          await continueAfterToolsIfReady(responseID: responseID, generation: generation)
        }
      }
    case .outputAudio, .sessionCreated, .sessionUpdated: break
    case .error:
      phase = .failed("Qwen Realtime reported a connection error.")
      await ledger?.retire(generation: generation)
      await transport.close()
      if ownsAudioSession { await audioSession.deactivate(); ownsAudioSession = false }
      voiceActivity = .inactive
    }
  }

  private func finalizeInput(id: String, transcript: String, generation: UInt64) async {
    mostRecentInputItemID = id
    guard let ledger, let transcriptAuthorizer else { return }
    await toolCoordinator?.beginInputTurn()
    let turnID = RealtimeInputTurnID(rawValue: UUID().uuidString.lowercased())
    do {
      try await ledger.finalizeTranscript(generation: generation, turnID: turnID, authorization: transcriptAuthorizer.authorization(for: transcript))
      try await ledger.bindInputItem(generation: generation, itemID: id, to: turnID)
      for responseID in responseItems.compactMap({ $0.value == id ? $0.key : nil }) {
        await bindResponseIfAuthorized(responseID, generation: generation)
      }
    } catch { phase = .failed("Qwen Realtime authorization became invalid.") }
  }

  private func bindResponseIfAuthorized(_ responseID: String, generation: UInt64) async {
    guard let itemID = responseItems[responseID] else { return }
    try? await ledger?.bindResponse(generation: generation, responseID: responseID, forItem: itemID)
  }

  private func receiveFunction(id: String, argumentsJSON: String, generation: UInt64) async {
    guard let name = callNames[id], let responseID = callResponses[id],
      let ledger, let toolCoordinator
    else { return }
    let callID = AssistantToolCallID(rawValue: id)
    do {
      let authorization = try await ledger.authorization(
        generation: generation,
        responseID: responseID,
        callID: callID
      )
      let disposition = try await toolCoordinator.receive(
        .init(name: name, callID: callID, arguments: argumentsJSON),
        authorization: authorization
      )
      switch disposition {
      case .terminal(let output):
        await deliverTerminal(output, responseID: responseID, generation: generation)
      case .confirmation:
        let proposal = QwenPendingMutation(id: id, name: name, argumentsJSON: argumentsJSON)
        guard !pendingMutations.contains(where: { $0.id == id }) else { return }
        pendingMutations.append(proposal)
        await mutationHandler?.receive(proposal)
      }
    } catch {
      let output = AssistantToolTerminalOutput(
        callID: callID,
        json: #"{"status":"rejected"}"#
      )
      await deliverTerminal(output, responseID: responseID, generation: generation)
    }
  }

  private func deliverTerminal(
    _ output: AssistantToolTerminalOutput,
    responseID: String,
    generation: UInt64
  ) async {
    do {
      try await transport.send(
        .functionOutput(
          callID: output.callID.rawValue,
          outputJSON: output.json
        )
      )
      try await ledger?.recordTerminalOutput(
        generation: generation,
        responseID: responseID,
        callID: output.callID
      )
      responseTerminalCalls[responseID, default: []].insert(output.callID)
      pendingMutations.removeAll { $0.id == output.callID.rawValue }
      await continueAfterToolsIfReady(responseID: responseID, generation: generation)
    } catch {
      await failAuthorization(generation: generation)
    }
  }

  private func continueAfterToolsIfReady(
    responseID: String,
    generation: UInt64
  ) async {
    let calls = responseCalls[responseID, default: []]
    guard completedResponses.contains(responseID), !calls.isEmpty,
      calls == responseTerminalCalls[responseID, default: []],
      continuedResponses.insert(responseID).inserted
    else { return }
    do {
      awaitingFollowUpAfterResponseID = responseID
      try await transport.send(.responseCreate)
      try await transport.setMuted(false)
      phase = .responding
    } catch {
      await failAuthorization(generation: generation)
    }
  }

  private func failAuthorization(generation: UInt64) async {
    phase = .failed("Qwen Realtime authorization became invalid.")
    await ledger?.retire(generation: generation)
    try? await transport.setMuted(true)
    await transport.close()
    if ownsAudioSession { await audioSession.deactivate(); ownsAudioSession = false }
    voiceActivity = .inactive
  }

  private func appendCaption(id: String, role: QwenRealtimeCaption.Role, text: String, completed: Bool) {
    guard text.utf8.count <= QwenRealtimeProtocolCodec.maximumTranscriptBytes else { return }
    if let index = captions.firstIndex(where: { $0.id == id }) {
      if completed { captions[index].text = text }
      else { captions[index].text += text }
      if completed { captions[index].status = .completed }
    } else { captions.append(QwenRealtimeCaption(id: id, role: role, text: text, status: completed ? .completed : .streaming)) }
  }
}
