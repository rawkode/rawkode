import Foundation

public enum MeetingCloudTranscriptionError: Error, Equatable, Sendable, LocalizedError {
  case insufficientFreeSpace
  case audioTooLarge
  case invalidFinalizedAudio
  case invalidResponse
  case server(status: Int)
  case staleHandle
  case recordingAlreadyActive

  public var errorDescription: String? {
    switch self {
    case .insufficientFreeSpace: "There is not enough free space to transcribe this meeting."
    case .audioTooLarge: "The meeting reached the cloud transcription size limit."
    case .invalidFinalizedAudio, .invalidResponse: "The meeting audio could not be transcribed."
    case .server(let status): "Cloud transcription failed (HTTP \(status))."
    case .staleHandle: "The meeting transcription session is no longer authorized."
    case .recordingAlreadyActive: "Another cloud meeting transcription is already active."
    }
  }
}

/// Codec implementations write only to the URL supplied by the session. They must
/// not retain a second recording or a durable retry queue.
public protocol MeetingCompressedAudioWriting: Sendable {
  func begin(destination: URL) async throws
  /// Called throughout capture, before `finalize`; implementations encode directly
  /// into the supplied session container and must not retain raw PCM after append.
  func append(_ frame: MeetingPCMFrame) async throws
  func finalize() async throws -> URL
  func cancel() async
}

/// This is Core-internal by design: a UI can pass a binding selected at Start but
/// can never obtain the saved API key. Production conformance lives next to the
/// Keychain store rather than in a view model.
protocol MeetingCloudCredentialLeasing: Sendable {
  func credential(matching binding: OpenAICredentialBinding?) async throws -> String
}

extension OpenAICredentialStore: MeetingCloudCredentialLeasing {
  func credential(matching binding: OpenAICredentialBinding?) async throws -> String {
    guard let binding else { throw OpenAICredentialStoreError.bindingMismatch }
    return try runtimeCredential(matching: binding)
  }
}

public protocol MeetingCloudHTTPUploading: Sendable {
  func upload(_ request: URLRequest) async throws -> (statusCode: Int, body: Data)
}

public actor URLSessionMeetingCloudHTTPUploader: MeetingCloudHTTPUploading {
  private let session: URLSession
  public init(configuration: URLSessionConfiguration = URLSessionMeetingCloudHTTPUploader.defaultConfiguration()) {
    session = URLSession(configuration: configuration)
  }
  public static func defaultConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.waitsForConnectivity = false
    return configuration
  }
  public func upload(_ request: URLRequest) async throws -> (statusCode: Int, body: Data) {
    let (body, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw MeetingCloudTranscriptionError.invalidResponse }
    return (http.statusCode, body)
  }
}

/// Owns an app-private, session-scoped audio pathname and its lease marker. The
/// marker is intentionally separate metadata, so the only audio container is the
/// finalized compressed file itself.
public actor MeetingTransientAudioStore {
  public static let maximumAudioBytes = 24 * 1_024 * 1_024
  public static let staleAge: TimeInterval = 60 * 60
  private let root: URL
  private let fileManager: FileManager

  public init(root: URL? = nil, fileManager: FileManager = .default) throws {
    self.fileManager = fileManager
    self.root = try root ?? fileManager.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("MeetingTranscription", isDirectory: true)
    try fileManager.createDirectory(at: self.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }

  public func begin(sessionID: UUID, expectedMaximumBytes: Int = maximumAudioBytes) throws -> MeetingAudioLease {
    guard availableCapacity() >= Int64(expectedMaximumBytes) else { throw MeetingCloudTranscriptionError.insufficientFreeSpace }
    let url = root.appendingPathComponent("meeting-\(sessionID.uuidString.lowercased()).m4a")
    let marker = url.appendingPathExtension("lease")
    guard !fileManager.fileExists(atPath: url.path), !fileManager.fileExists(atPath: marker.path) else { throw MeetingCloudTranscriptionError.invalidFinalizedAudio }
    try Data().write(to: url, options: [.atomic])
    try secure(url)
    let lease = Lease(sessionID: sessionID.uuidString, createdAt: Date(), active: true)
    try JSONEncoder().encode(lease).write(to: marker, options: [.atomic])
    try secure(marker)
    return MeetingAudioLease(audioURL: url, markerURL: marker)
  }

  public func finalize(_ lease: MeetingAudioLease) throws {
    try validate(lease)
    let bytes = try fileManager.attributesOfItem(atPath: lease.audioURL.path)[.size] as? NSNumber
    guard let bytes, bytes.intValue > 0 else { throw MeetingCloudTranscriptionError.invalidFinalizedAudio }
    guard bytes.intValue <= Self.maximumAudioBytes else { throw MeetingCloudTranscriptionError.audioTooLarge }
    // Keep the original marker: it holds the actual UUID session ID used by the
    // active-lease sweeper. Finalization changes no authority or retention state.
  }

  public func remove(_ lease: MeetingAudioLease) {
    try? fileManager.removeItem(at: lease.audioURL)
    try? fileManager.removeItem(at: lease.markerURL)
  }

  /// Active markers are never reaped, including if a background sweep overlaps an
  /// in-flight upload. Relaunch marks have no in-memory owner, so callers should
  /// invoke `sweepStaleLeases` at startup/background before starting a new session.
  public func sweepStaleLeases(now: Date = Date(), activeSessionIDs: Set<UUID> = []) {
    guard let markers = try? fileManager.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
    for marker in markers where marker.pathExtension == "lease" {
      guard let data = try? Data(contentsOf: marker), let lease = try? JSONDecoder().decode(Lease.self, from: data),
        let id = UUID(uuidString: lease.sessionID)
      else { try? fileManager.removeItem(at: marker.deletingPathExtension()); try? fileManager.removeItem(at: marker); continue }
      // An active in-process lease is unconditionally retained.
      if activeSessionIDs.contains(id) { continue }
      if now.timeIntervalSince(lease.createdAt) < Self.staleAge { continue }
      let audio = marker.deletingPathExtension()
      try? fileManager.removeItem(at: audio)
      try? fileManager.removeItem(at: marker)
    }
    for audio in markers where audio.pathExtension == "m4a" {
      let marker = audio.appendingPathExtension("lease")
      guard !fileManager.fileExists(atPath: marker.path),
        let date = (try? audio.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate,
        now.timeIntervalSince(date) >= Self.staleAge
      else { continue }
      try? fileManager.removeItem(at: audio)
    }
  }

  private func availableCapacity() -> Int64 {
    let values = try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    if let capacity = values?.volumeAvailableCapacityForImportantUsage { return Int64(capacity) }
    if let free = try? fileManager.attributesOfFileSystem(forPath: root.path)[.systemFreeSize] as? NSNumber { return free.int64Value }
    return Int64.max
  }
  private func validate(_ lease: MeetingAudioLease) throws {
    guard lease.audioURL.deletingLastPathComponent() == root, fileManager.fileExists(atPath: lease.markerURL.path) else { throw MeetingCloudTranscriptionError.invalidFinalizedAudio }
  }
  private func secure(_ fileURL: URL) throws {
    var url = fileURL
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    #if os(iOS)
      try fileManager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    #endif
  }
  private struct Lease: Codable { let sessionID: String; let createdAt: Date; let active: Bool }
}

public struct MeetingAudioLease: Sendable, Equatable { public let audioURL: URL; public let markerURL: URL }

/// A one-shot, non-streaming upload. It has no retry queue: after one request the
/// audio and its marker are deleted on success, failure, cancellation, and relaunch
/// sweep. The request body contains the finalized file exactly once.
public actor MeetingCloudTranscriber {
  private let store: MeetingTransientAudioStore
  private let writer: any MeetingCompressedAudioWriting
  private let credentialLease: any MeetingCloudCredentialLeasing
  private let uploader: any MeetingCloudHTTPUploading
  private let endpoint: URL
  private var activeHandles = Set<UUID>()

  /// Public composition entry point. Passing the store, rather than a secret or a
  /// credential callback, preserves the Keychain boundary for SharedUI callers.
  public init(store: MeetingTransientAudioStore, writer: any MeetingCompressedAudioWriting, credentialStore: OpenAICredentialStore, uploader: any MeetingCloudHTTPUploading = URLSessionMeetingCloudHTTPUploader(), endpoint: URL = URL(string: "https://api.openai.com/v1/audio/transcriptions")!) {
    self.store = store; self.writer = writer; credentialLease = credentialStore; self.uploader = uploader; self.endpoint = endpoint
  }

  init(store: MeetingTransientAudioStore, writer: any MeetingCompressedAudioWriting, credentialLease: any MeetingCloudCredentialLeasing, uploader: any MeetingCloudHTTPUploading = URLSessionMeetingCloudHTTPUploader(), endpoint: URL = URL(string: "https://api.openai.com/v1/audio/transcriptions")!) {
    self.store = store; self.writer = writer; self.credentialLease = credentialLease; self.uploader = uploader; self.endpoint = endpoint
  }

  /// Starts the recorder before capture begins. The caller forwards every current
  /// generation PCM frame to `append`; Stop then calls `finishAndTranscribe`.
  public func beginRecording(authority: MeetingAutomationAuthority) async throws -> MeetingCloudRecordingHandle {
    guard authority.transcriptionRoute.route == .cloud,
      authority.transcriptionRoute.cloudModelID == "gpt-4o-transcribe-diarize",
      authority.transcriptionRoute.credentialBinding != nil
    else { throw MeetingSessionError.staleAuthority }
    guard activeHandles.isEmpty else { throw MeetingCloudTranscriptionError.recordingAlreadyActive }
    let lease = try await store.begin(sessionID: authority.sessionID)
    do {
      try await writer.begin(destination: lease.audioURL)
      let handle = MeetingCloudRecordingHandle(authority: authority, lease: lease)
      activeHandles.insert(handle.id)
      return handle
    } catch {
      await writer.cancel()
      await store.remove(lease)
      throw error
    }
  }

  public func append(_ frame: MeetingPCMFrame, to handle: MeetingCloudRecordingHandle) async throws {
    guard activeHandles.contains(handle.id) else { throw MeetingCloudTranscriptionError.staleHandle }
    try await writer.append(frame)
  }

  public func cancel(_ handle: MeetingCloudRecordingHandle) async {
    guard activeHandles.remove(handle.id) != nil else { return }
    await writer.cancel()
    await store.remove(handle.lease)
  }

  public func finishAndTranscribe(_ handle: MeetingCloudRecordingHandle, credentialBinding: OpenAICredentialBinding) async throws -> [MeetingTranscriptSegment] {
    guard activeHandles.remove(handle.id) != nil else { throw MeetingCloudTranscriptionError.staleHandle }
    guard handle.authority.transcriptionRoute.credentialBinding == credentialBinding else {
      await writer.cancel()
      await store.remove(handle.lease)
      throw MeetingCloudTranscriptionError.staleHandle
    }
    do {
      let finalized = try await writer.finalize()
      guard finalized.standardizedFileURL == handle.lease.audioURL.standardizedFileURL else { throw MeetingCloudTranscriptionError.invalidFinalizedAudio }
      try await store.finalize(handle.lease)
      try Task.checkCancellation()
      let credential = try await credentialLease.credential(matching: credentialBinding)
      let request = try makeRequest(fileURL: handle.lease.audioURL, credential: credential)
      let response = try await uploader.upload(request)
      try Task.checkCancellation()
      guard (200..<300).contains(response.statusCode) else { throw MeetingCloudTranscriptionError.server(status: response.statusCode) }
      let segments = try decodeSegments(response.body)
      await store.remove(handle.lease)
      return segments
    } catch {
      await writer.cancel()
      await store.remove(handle.lease)
      throw error
    }
  }

  private func makeRequest(fileURL: URL, credential: String) throws -> URLRequest {
    let audio = try Data(contentsOf: fileURL, options: [.mappedIfSafe])
    guard audio.count <= MeetingTransientAudioStore.maximumAudioBytes, !audio.isEmpty else { throw MeetingCloudTranscriptionError.audioTooLarge }
    let boundary = "MeetingTranscription-\(UUID().uuidString)"
    var body = Data()
    func field(_ name: String, _ value: String) {
      body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
    }
    field("model", "gpt-4o-transcribe-diarize")
    field("response_format", "diarized_json")
    field("chunking_strategy", "auto")
    body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"meeting.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n".data(using: .utf8)!)
    body.append(audio); body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"; request.httpBody = body
    request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    return request
  }

  private func decodeSegments(_ data: Data) throws -> [MeetingTranscriptSegment] {
    struct Response: Decodable { let segments: [Segment] }
    struct Segment: Decodable { let start: Double; let end: Double; let text: String; let speaker: String }
    let response = try JSONDecoder().decode(Response.self, from: data)
    guard !response.segments.isEmpty, response.segments.count <= MeetingTranscriptResource.maximumSegmentCount else { throw MeetingCloudTranscriptionError.invalidResponse }
    return try response.segments.enumerated().map { index, segment in
      guard segment.start.isFinite, segment.end.isFinite, segment.start >= 0, segment.end >= segment.start, segment.end <= MeetingTranscriptResource.maximumDurationSeconds, !segment.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !segment.speaker.isEmpty else { throw MeetingCloudTranscriptionError.invalidResponse }
      return MeetingTranscriptSegment(id: "cloud-\(index)-\(Int((segment.start * 1_000).rounded()))", startTime: segment.start, endTime: segment.end, text: segment.text, speakerClusterID: segment.speaker)
    }
  }
}

public struct MeetingCloudRecordingHandle: Sendable, Equatable {
  fileprivate let id: UUID
  fileprivate let authority: MeetingAutomationAuthority
  fileprivate let lease: MeetingAudioLease
  fileprivate init(authority: MeetingAutomationAuthority, lease: MeetingAudioLease) {
    id = UUID(); self.authority = authority; self.lease = lease
  }
}
