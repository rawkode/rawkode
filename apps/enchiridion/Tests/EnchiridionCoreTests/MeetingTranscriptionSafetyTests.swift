import Foundation
import Security
import XCTest

@testable import EnchiridionCore

final class MeetingTranscriptionSafetyTests: XCTestCase {
  func testTransientStoreReapsStaleLeaseAndOrphanButRetainsActiveLease() async throws {
    let root = temporaryDirectory()
    let store = try MeetingTransientAudioStore(root: root)
    let staleID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    let activeID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
    let stale = try await store.begin(sessionID: staleID)
    let active = try await store.begin(sessionID: activeID)
    try Data("audio".utf8).write(to: stale.audioURL)
    try Data("audio".utf8).write(to: active.audioURL)
    try Data("{\"sessionID\":\"\(staleID.uuidString)\",\"createdAt\":0,\"active\":true}".utf8)
      .write(to: stale.markerURL)
    let orphan = root.appendingPathComponent("orphan.m4a")
    try Data("audio".utf8).write(to: orphan)
    try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 0)], ofItemAtPath: orphan.path)

    await store.sweepStaleLeases(now: Date().addingTimeInterval(MeetingTransientAudioStore.staleAge + 1), activeSessionIDs: [activeID])

    XCTAssertFalse(FileManager.default.fileExists(atPath: stale.audioURL.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: stale.markerURL.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: active.audioURL.path))
    await store.remove(active)
  }

  func testCloudTranscriberRemovesAudioAfterCancelSuccessAndFailure() async throws {
    try await assertCloudLifecycle(mode: .cancel)
    try await assertCloudLifecycle(mode: .success)
    try await assertCloudLifecycle(mode: .failure)
  }

  func testCloudTranscriberRejectsConcurrentBeginAndStaleHandle() async throws {
    let root = temporaryDirectory()
    let store = try MeetingTransientAudioStore(root: root)
    await XCTAssertThrowsErrorAsync(try await store.begin(sessionID: UUID(), expectedMaximumBytes: .max)) { error in
      XCTAssertEqual(error as? MeetingCloudTranscriptionError, .insufficientFreeSpace)
    }
    let writer = RecordingWriter()
    let transcriber = MeetingCloudTranscriber(
      store: store,
      writer: writer,
      credentialLease: FixedCredentialLease(),
      uploader: FixedUploader(result: .success)
    )
    let authority = cloudAuthority()
    let handle = try await transcriber.beginRecording(authority: authority)
    await XCTAssertThrowsErrorAsync(try await transcriber.beginRecording(authority: authority)) { error in
      XCTAssertEqual(error as? MeetingCloudTranscriptionError, .recordingAlreadyActive)
    }
    await transcriber.cancel(handle)
    await XCTAssertThrowsErrorAsync(try await transcriber.append(frame(), to: handle)) { error in
      XCTAssertEqual(error as? MeetingCloudTranscriptionError, .staleHandle)
    }
  }

  func testCloudTranscriberWrongCredentialBindingDeletesTransientAudioAndReleasesSession() async throws {
    let root = temporaryDirectory()
    let store = try MeetingTransientAudioStore(root: root)
    let writer = RecordingWriter()
    let transcriber = MeetingCloudTranscriber(
      store: store,
      writer: writer,
      credentialLease: FixedCredentialLease(),
      uploader: FixedUploader(result: .success)
    )
    let handle = try await transcriber.beginRecording(authority: cloudAuthority())
    try await transcriber.append(frame(), to: handle)
    let recordedDestination = await writer.recordedDestination()
    let destination = try XCTUnwrap(recordedDestination)
    let wrongBinding = OpenAICredentialBinding(revision: "other", fingerprint: "other")

    await XCTAssertThrowsErrorAsync(
      try await transcriber.finishAndTranscribe(handle, credentialBinding: wrongBinding)
    )

    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathExtension("lease").path))
    let replacement = try await transcriber.beginRecording(authority: cloudAuthority())
    await transcriber.cancel(replacement)
  }

  func testOnDeviceAndCloudAnalyzersRejectOutputsOutsideCapturedTranscriptAndSchema() async throws {
    let snapshot = transcriptSnapshot()
    let completion = completionAuthority(for: snapshot, route: .onDevice)
    let invalid = try MeetingAnalysis(
      transcriptHash: snapshot.hash,
      summary: "summary",
      decisions: [],
      actionItems: [.init(id: "action", title: "Do it", ownerClusterID: "unknown-speaker")],
      entityProposals: []
    )
    let onDevice = MeetingOnDeviceAnalyzer(generator: FixedGenerator(result: invalid))
    await XCTAssertThrowsErrorAsync(try await onDevice.analyze(.init(snapshot: snapshot, allowedSuperTags: []), authority: completion)) { error in
      XCTAssertEqual(error as? MeetingAnalysisError, .invalidOutput)
    }

    let cloudCompletion = completionAuthority(for: snapshot, route: .cloud)
    let cloud = MeetingCloudAnalyzer(responder: FixedAnalysisResponder(data: try JSONEncoder.enchiridion.encode(invalid)))
    await XCTAssertThrowsErrorAsync(try await cloud.analyze(.init(snapshot: snapshot, allowedSuperTags: []), authority: cloudCompletion)) { error in
      XCTAssertEqual(error as? MeetingAnalysisError, .invalidOutput)
    }
  }

  func testAnalysisCoordinatorDoesNotPersistAfterInvalidationOrHashMismatch() async throws {
    let snapshot = transcriptSnapshot()
    let completion = completionAuthority(for: snapshot, route: .onDevice)
    let result = try MeetingAnalysis(transcriptHash: snapshot.hash, summary: "summary", decisions: [], actionItems: [], entityProposals: [])
    let persistence = RecordingAnalysisPersistence()
    let coordinator = MeetingAnalysisCoordinator(analyzer: DelayedAnalyzer(result: result), persistence: persistence)
    let task = Task { try await coordinator.analyze(final: snapshot, completion: completion, allowedSuperTags: []) }
    await Task.yield()
    await coordinator.invalidate()
    await XCTAssertThrowsErrorAsync(try await task.value) { error in
      XCTAssertEqual(error as? MeetingAnalysisError, .transcriptChanged)
    }
    let firstPersistCount = await persistence.persistCount()
    XCTAssertEqual(firstPersistCount, 0)

    let wrongCompletion = MeetingAutomationCompletionAuthority(authority: completion.authority, transcriptHash: "different", completedAt: completion.completedAt)
    await XCTAssertThrowsErrorAsync(try await coordinator.analyze(final: snapshot, completion: wrongCompletion, allowedSuperTags: [])) { error in
      XCTAssertEqual(error as? MeetingAnalysisError, .transcriptChanged)
    }
    let secondPersistCount = await persistence.persistCount()
    XCTAssertEqual(secondPersistCount, 0)
  }

  func testNativeCloudRequestDisablesToolsAndDisclosesOnlyInputProjection() async throws {
    let snapshot = transcriptSnapshot()
    let input = MeetingAnalysisInput(snapshot: snapshot, allowedSuperTags: [.init(id: .init(rawValue: "project"), name: "Project", propertyNames: ["Status"])])
    let keychain = TestKeychain(payload: try JSONEncoder().encode(OpenAIKeychainCredentialPayload(credential: "test-secret", revision: "r1")))
    let credentials = OpenAICredentialStore(client: keychain, platform: .macOS)
    let outcome = try await credentials.readBinding(generation: 1)
    guard case let .available(binding) = outcome else { return XCTFail("Expected a credential binding") }
    let transport = RecordingResponsesTransport(reply: completedAnalysisEvent())
    let responder = NativeMeetingCloudAnalysisResponder(credentialStore: credentials, transport: transport)

    _ = try await responder.respond(
      transcriptAndSchema: try JSONEncoder.enchiridion.encode(input),
      modelID: "model-test",
      credentialBinding: binding
    )
    let capturedBody = await transport.capturedBody()
    let body = try XCTUnwrap(capturedBody)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(json["store"] as? Bool, false)
    XCTAssertEqual(json["tool_choice"] as? String, "none")
    XCTAssertEqual((json["tools"] as? [Any])?.count, 0)
    XCTAssertEqual(json["parallel_tool_calls"] as? Bool, false)
    let serialized = String(decoding: body, as: UTF8.self)
    XCTAssertFalse(serialized.contains("test-secret"))
    XCTAssertTrue(serialized.contains("speaker-1"))
    XCTAssertTrue(serialized.contains("Project"))
  }

  private enum LifecycleMode { case cancel, success, failure }

  private func assertCloudLifecycle(mode: LifecycleMode) async throws {
    let root = temporaryDirectory()
    let store = try MeetingTransientAudioStore(root: root)
    let writer = RecordingWriter()
    let transcriber = MeetingCloudTranscriber(
      store: store,
      writer: writer,
      credentialLease: FixedCredentialLease(),
      uploader: FixedUploader(result: mode == .failure ? .failure : .success)
    )
    let handle = try await transcriber.beginRecording(authority: cloudAuthority())
    try await transcriber.append(frame(), to: handle)
    let recordedDestination = await writer.recordedDestination()
    let destination = try XCTUnwrap(recordedDestination)
    if mode == .cancel {
      await transcriber.cancel(handle)
    } else if mode == .success {
      _ = try await transcriber.finishAndTranscribe(handle, credentialBinding: cloudBinding)
    } else {
      await XCTAssertThrowsErrorAsync(try await transcriber.finishAndTranscribe(handle, credentialBinding: cloudBinding))
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathExtension("lease").path))
  }

  private func temporaryDirectory() -> URL {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString, isDirectory: true)
    try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return directory
  }

  private var cloudBinding: OpenAICredentialBinding { .init(revision: "revision", fingerprint: "fingerprint") }

  private func cloudAuthority() -> MeetingAutomationAuthority {
    MeetingAutomationAuthority(
      vaultID: .personal, eventPageID: .init(rawValue: "event"), occurrenceKey: "occurrence",
      transcriptionRoute: .init(route: .cloud, cloudReadiness: .notRequired, cloudModelID: "gpt-4o-transcribe-diarize", credentialBinding: cloudBinding),
      analysisRoute: .init(route: .cloud, cloudModelID: "model-test", credentialBinding: cloudBinding),
      issuedAt: .distantPast, expiresAt: .distantFuture
    )
  }

  private func transcriptSnapshot() -> MeetingTranscriptSnapshot {
    let event = PageID(rawValue: "event")
    let resource = MeetingTranscriptResource(
      eventPageID: event,
      provenance: .init(captureAlgorithm: "test", captureAlgorithmVersion: "1", transcriptionAlgorithm: "test", transcriptionAlgorithmVersion: "1"),
      segments: [.init(id: "segment-1", startTime: 0, endTime: 1, text: "Discuss Project", speakerClusterID: "speaker-1")]
    )
    return MeetingTranscriptSnapshot(resource: resource)
  }

  private func completionAuthority(for snapshot: MeetingTranscriptSnapshot, route: MeetingTranscriptionRoute) -> MeetingAutomationCompletionAuthority {
    let authority = MeetingAutomationAuthority(
      vaultID: .personal, eventPageID: snapshot.resource.eventPageID, occurrenceKey: "occurrence",
      transcriptionRoute: .init(route: route, cloudReadiness: route == .cloud ? .notRequired : .notRequired, cloudModelID: route == .cloud ? "gpt-4o-transcribe-diarize" : nil, credentialBinding: route == .cloud ? cloudBinding : nil),
      analysisRoute: .init(route: route, cloudModelID: route == .cloud ? "model-test" : nil, credentialBinding: route == .cloud ? cloudBinding : nil),
      issuedAt: .distantPast, expiresAt: .distantFuture
    )
    return authority.completion(transcriptHash: snapshot.hash, completedAt: Date())!
  }

  private func frame() -> MeetingPCMFrame {
    .init(generation: 1, channel: .microphone, timestamp: 0, sampleRate: 16_000, channelCount: 1, samples: [0, 0, 0, 0])
  }

  private func completedAnalysisEvent() -> Data {
    let text = "{\"transcriptHash\":\"unused\",\"summary\":\"\",\"decisions\":[],\"actionItems\":[],\"entityProposals\":[]}"
    return try! JSONEncoder().encode(OpenAIJSONValue.object([
      "type": .string("response.completed"),
      "response": .object(["id": .string("response"), "status": .string("completed"), "output": .array([.object(["type": .string("message"), "content": .array([.object(["type": .string("output_text"), "text": .string(text)])])])])]),
    ]))
  }
}

private actor RecordingWriter: MeetingCompressedAudioWriting {
  private(set) var destination: URL?
  func begin(destination: URL) async throws { self.destination = destination }
  func append(_: MeetingPCMFrame) async throws {}
  func finalize() async throws -> URL {
    let destination = try! XCTUnwrap(destination)
    try Data("compressed".utf8).write(to: destination)
    return destination
  }
  func cancel() async {}
  func recordedDestination() -> URL? { destination }
}

private struct FixedCredentialLease: MeetingCloudCredentialLeasing {
  func credential(matching _: OpenAICredentialBinding?) async throws -> String { "credential" }
}

private actor FixedUploader: MeetingCloudHTTPUploading {
  enum Result { case success, failure }
  let result: Result
  init(result: Result) { self.result = result }
  func upload(_: URLRequest) async throws -> (statusCode: Int, body: Data) {
    switch result {
    case .success:
      return (200, Data("{\"segments\":[{\"start\":0,\"end\":1,\"text\":\"Hi\",\"speaker\":\"speaker-1\"}]}".utf8))
    case .failure:
      return (500, Data())
    }
  }
}

private struct FixedGenerator: MeetingOnDeviceAnalysisGenerating {
  let result: MeetingAnalysis
  func generate(_: MeetingAnalysisInput) async throws -> MeetingAnalysis { result }
}

private struct FixedAnalysisResponder: MeetingCloudAnalysisResponding {
  let data: Data
  func respond(transcriptAndSchema _: Data, modelID _: String, credentialBinding _: OpenAICredentialBinding) async throws -> Data { data }
}

private actor DelayedAnalyzer: MeetingAnalyzing {
  let result: MeetingAnalysis
  init(result: MeetingAnalysis) { self.result = result }
  func analyze(_: MeetingAnalysisInput, authority _: MeetingAutomationCompletionAuthority) async throws -> MeetingAnalysis {
    try await Task.sleep(for: .milliseconds(20))
    return result
  }
}

private actor RecordingAnalysisPersistence: MeetingAnalysisPersisting {
  private(set) var count = 0
  func persist(_: MeetingAnalysis, authority _: MeetingAutomationCompletionAuthority) async throws { count += 1 }
  func persistCount() -> Int { count }
}

private final class TestKeychain: KeychainClient, @unchecked Sendable {
  private let payload: Data
  init(payload: Data) { self.payload = payload }
  func add(_: CFDictionary) -> OSStatus { errSecSuccess }
  func copyMatching(_: CFDictionary, result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    result?.pointee = payload as CFTypeRef
    return errSecSuccess
  }
  func update(_: CFDictionary, attributes _: CFDictionary) -> OSStatus { errSecSuccess }
  func delete(_: CFDictionary) -> OSStatus { errSecSuccess }
}

private actor RecordingResponsesTransport: OpenAIResponsesTransporting {
  private(set) var body: Data?
  let reply: Data
  init(reply: Data) { self.reply = reply }
  func send(body: Data, credential _: String) async throws -> OpenAIResponsesTransportResult {
    self.body = body
    return .init(statusCode: 200, requestID: nil, retryAfterSeconds: nil, events: [reply], errorCode: nil)
  }
  func capturedBody() -> Data? { body }
}

private func XCTAssertThrowsErrorAsync<T>(
  _ expression: @autoclosure () async throws -> T,
  _ handler: ((Error) -> Void)? = nil,
  file: StaticString = #filePath,
  line: UInt = #line
) async {
  do {
    _ = try await expression()
    XCTFail("Expected error", file: file, line: line)
  } catch {
    handler?(error)
  }
}
