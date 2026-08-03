import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class QwenRealtimeVoiceSessionTests: XCTestCase {
  func testStartUsesBoundRouteAndPublishesActivity() async throws {
    let fixture = try makeFixture(tools: false)

    await fixture.session.start()

    XCTAssertEqual(fixture.session.phase, .listening)
    XCTAssertEqual(fixture.transport.mutedValues, [false])
    fixture.transport.emitActivity(
      RealtimeAudioActivitySample(generation: 1, inputLevel: 0.25, outputLevel: 0.5)
    )
    await waitUntil { fixture.session.voiceActivity.outputLevel == 0.5 }
    XCTAssertTrue(fixture.session.voiceActivity.isListening)

    await fixture.session.stop()
    XCTAssertEqual(fixture.session.phase, .ended)
    XCTAssertEqual(fixture.session.voiceActivity, .inactive)
    XCTAssertEqual(fixture.audio.activations, 1)
    XCTAssertEqual(fixture.audio.deactivations, 1)
    XCTAssertEqual(fixture.transport.closeCount, 1)
    XCTAssertTrue(fixture.transport.commands.contains(.responseCancel))
    XCTAssertTrue(fixture.transport.commands.contains(.outputAudioBufferClear))
  }

  func testMultipleReadCallsProduceOneFollowUpResponseAfterAllTerminalOutputs() async throws {
    let fixture = try makeFixture(tools: true)
    _ = try await fixture.repository.createFreePage(title: "Launch plan")
    await fixture.session.start()

    fixture.transport.emit(.inputTranscriptDone(id: "item", text: "Launch"))
    fixture.transport.emit(.responseCreated(id: "response", inputItemID: "item"))
    fixture.transport.emit(.functionCallAdded(id: "call-1", name: "searchNotes", responseID: "response"))
    fixture.transport.emit(.functionCallArgumentsDone(id: "call-1", argumentsJSON: #"{"query":"Launch","limit":1}"#))
    fixture.transport.emit(.functionCallAdded(id: "call-2", name: "searchNotes", responseID: "response"))
    fixture.transport.emit(.functionCallArgumentsDone(id: "call-2", argumentsJSON: #"{"query":"Launch","limit":1}"#))
    fixture.transport.emit(.responseDone(id: "response", cancelled: false))

    await waitUntil { fixture.transport.commands.filter { $0 == .responseCreate }.count == 1 }
    XCTAssertEqual(
      fixture.transport.commands.compactMap {
        guard case .functionOutput(let callID, _) = $0 else { return nil }
        return callID
      },
      ["call-1", "call-2"]
    )
    XCTAssertEqual(fixture.transport.commands.filter { $0 == .responseCreate }.count, 1)
    XCTAssertTrue(fixture.session.pendingMutations.isEmpty)
    await fixture.session.stop()
  }

  func testMutationWaitsForNativeConfirmationBeforeTerminalAndFollowUp() async throws {
    let fixture = try makeFixture(tools: true)
    await fixture.session.start()
    let arguments = #"{"title":"Confirmed task","notes":"","data":{"state":"active","placement":"inbox","scheduleGranularity":"date-time","priority":"none","tags":[],"estimatedMinutes":null}}"#

    fixture.transport.emit(.inputTranscriptDone(id: "item", text: "Create a task"))
    fixture.transport.emit(.responseCreated(id: "response", inputItemID: "item"))
    fixture.transport.emit(.functionCallAdded(id: "create", name: "create_task", responseID: "response"))
    fixture.transport.emit(.functionCallArgumentsDone(id: "create", argumentsJSON: arguments))
    fixture.transport.emit(.responseDone(id: "response", cancelled: false))

    await waitUntil { fixture.session.pendingMutations.count == 1 }
    XCTAssertFalse(fixture.transport.commands.contains { if case .functionOutput = $0 { true } else { false } })
    XCTAssertFalse(fixture.transport.commands.contains(.responseCreate))

    await fixture.session.confirmMutation(id: "create")
    await waitUntil { fixture.transport.commands.contains(.responseCreate) }
    XCTAssertTrue(fixture.session.pendingMutations.isEmpty)
    let tasks = try await fixture.repository.pages(with: BuiltInSupertags.task)
    XCTAssertEqual(tasks.count, 1)
    XCTAssertEqual(fixture.transport.commands.filter { $0 == .responseCreate }.count, 1)
    await fixture.session.stop()
  }

  private func makeFixture(tools: Bool) throws -> QwenSessionFixture {
    let binding = QwenCredentialBinding(revision: "revision", fingerprint: "fingerprint")
    let route = QwenVoiceRouteSnapshot(
      workspaceID: "workspace",
      model: .flash,
      voice: .longanqian,
      credentialBinding: binding
    )
    let transport = QwenTestTransport()
    let audio = QwenTestAudioSession()
    let path = FileManager.default.temporaryDirectory
      .appendingPathComponent("qwen-session-\(UUID().uuidString).sqlite").path
    let repository = try LibraryRepository(path: path)
    let coordinator = AssistantRealtimeToolCoordinator(
      repository: repository,
      mutations: TaskMutationCoordinator(
        repository: repository,
        effects: .init { _ in .applied }
      )
    )
    let authorization = AssistantTurnRetrievalAuthorization(
      noteSearch: try .init(
        query: .init(originalQuery: "Launch"),
        maximumResults: 1
      )
    )
    let session = QwenRealtimeVoiceSession(
      route: route,
      credentialReader: QwenTestCredentialReader(binding: binding),
      transport: transport,
      microphone: QwenTestMicrophone(),
      audioSession: audio,
      transcriptAuthorizer: tools ? QwenTestTranscriptAuthorizer(authorization: authorization) : nil,
      ledger: tools ? QwenVoiceAuthorizationLedger() : nil,
      toolCoordinator: tools ? coordinator : nil
    )
    return QwenSessionFixture(
      session: session,
      transport: transport,
      audio: audio,
      repository: repository
    )
  }

  private func waitUntil(
    _ condition: @escaping @MainActor () -> Bool,
    file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    for _ in 0 ..< 500 {
      if condition() { return }
      try? await Task.sleep(for: .milliseconds(2))
    }
    XCTFail("Timed out waiting for condition", file: file, line: line)
  }
}

@MainActor
private struct QwenSessionFixture {
  let session: QwenRealtimeVoiceSession
  let transport: QwenTestTransport
  let audio: QwenTestAudioSession
  let repository: LibraryRepository
}

private struct QwenTestMicrophone: RealtimeMicrophoneAuthorizing {
  func requestPermission() async -> RealtimeMicrophonePermission { .authorized }
}

private struct QwenTestCredentialReader: QwenRealtimeCredentialReading {
  let binding: QwenCredentialBinding
  func qwenRealtimeCredential(
    matching expected: QwenCredentialBinding
  ) async throws -> QwenRealtimeCredentialLease {
    guard binding == expected else { throw QwenCredentialStoreError.bindingMismatch }
    return QwenRealtimeCredentialLease(credential: "placeholder", binding: binding)
  }
}

private struct QwenTestTranscriptAuthorizer: QwenTranscriptAuthorizing {
  let authorization: AssistantTurnRetrievalAuthorization
  func authorization(for transcript: String) async -> AssistantTurnRetrievalAuthorization {
    authorization
  }
}

@MainActor
private final class QwenTestAudioSession: RealtimeAudioSessionControlling {
  private(set) var activations = 0
  private(set) var deactivations = 0
  func activate() async throws { activations += 1 }
  func deactivate() async { deactivations += 1 }
}

@MainActor
private final class QwenTestTransport: QwenRealtimeTransport {
  private let eventStream: AsyncStream<QwenRealtimeServerEvent>
  private let eventContinuation: AsyncStream<QwenRealtimeServerEvent>.Continuation
  private let activityStream: AsyncStream<RealtimeAudioActivitySample>
  private let activityContinuation: AsyncStream<RealtimeAudioActivitySample>.Continuation
  private(set) var commands: [QwenRealtimeClientEvent] = []
  private(set) var mutedValues: [Bool] = []
  private(set) var closeCount = 0

  init() {
    let events = AsyncStream.makeStream(of: QwenRealtimeServerEvent.self)
    eventStream = events.stream
    eventContinuation = events.continuation
    let activity = AsyncStream.makeStream(of: RealtimeAudioActivitySample.self)
    activityStream = activity.stream
    activityContinuation = activity.continuation
  }

  func start(
    generation: UInt64,
    route: QwenVoiceRouteSnapshot,
    configuration: QwenRealtimeConfiguration,
    credential: QwenRealtimeCredentialLease
  ) async throws -> QwenRealtimeSessionCreated {
    XCTAssertEqual(generation, 1)
    XCTAssertEqual(configuration.modelID, QwenRealtimeModel.flash.rawValue)
    XCTAssertEqual(configuration.voiceID, QwenRealtimeVoice.longanqian.rawValue)
    XCTAssertEqual(credential.binding, route.credentialBinding)
    return .init(
      sessionID: "session",
      modelID: configuration.modelID,
      voiceID: configuration.voiceID
    )
  }

  func events() -> AsyncStream<QwenRealtimeServerEvent> { eventStream }
  func activity() -> AsyncStream<RealtimeAudioActivitySample> { activityStream }
  func send(_ event: QwenRealtimeClientEvent) async throws { commands.append(event) }
  func setMuted(_ muted: Bool) async throws { mutedValues.append(muted) }
  func close() async { closeCount += 1 }
  func emit(_ event: QwenRealtimeServerEvent) { eventContinuation.yield(event) }
  func emitActivity(_ sample: RealtimeAudioActivitySample) { activityContinuation.yield(sample) }
}
