import EnchiridionCore
import Foundation

/// Bridges live capture to the cloud writer without ever creating a second audio
/// buffer or retry queue. Persistence, analysis, and semantic mutation remain
/// separate Core authorities and are invoked only with the final transcript.
@available(iOS 26.0, macOS 26.0, *)
actor MeetingCloudCapturePipeline {
  private let capture: any MeetingAudioCapturing
  private let transcriber: MeetingCloudTranscriber
  private let captureEnded: @Sendable (Error?) async -> Void
  private var generation: UInt64 = 0
  private var active: Active?
  private var forwardingTask: Task<Void, Never>?
  private var isStopping = false

  init(
    capture: any MeetingAudioCapturing,
    transcriber: MeetingCloudTranscriber,
    captureEnded: @escaping @Sendable (Error?) async -> Void = { _ in }
  ) {
    self.capture = capture; self.transcriber = transcriber; self.captureEnded = captureEnded
  }

  func start(authority: MeetingAutomationAuthority) async throws {
    guard authority.transcriptionRoute.route == .cloud, active == nil else {
      throw MeetingSessionError.sessionAlreadyActive
    }
    generation &+= 1
    let expected = generation
    let handle = try await transcriber.beginRecording(authority: authority)
    do {
      let frames = try await capture.startCapture()
      active = .init(authority: authority, handle: handle, generation: expected)
      forwardingTask = Task { [weak self, transcriber] in
        for await frame in frames {
          guard !Task.isCancelled else { return }
          do { try await self?.append(frame, expected: expected, transcriber: transcriber) }
          catch {
            await self?.fail(error, expected: expected, transcriber: transcriber)
            return
          }
        }
        await self?.finishedUnexpectedly(expected: expected)
      }
    } catch {
      await transcriber.cancel(handle)
      throw error
    }
  }

  /// Stop is the only point at which the temporary AAC container is finalized
  /// and uploaded. Its return value contains text only.
  func stop() async throws -> (authority: MeetingAutomationAuthority, segments: [MeetingTranscriptSegment]) {
    guard let active else { throw MeetingSessionError.finalTranscriptRequired }
    isStopping = true
    await capture.stopCapture()
    await forwardingTask?.value
    forwardingTask = nil
    generation &+= 1
    self.active = nil
    isStopping = false
    guard let binding = active.authority.transcriptionRoute.credentialBinding else {
      await transcriber.cancel(active.handle)
      throw MeetingCloudTranscriptionError.staleHandle
    }
    let segments = try await transcriber.finishAndTranscribe(active.handle, credentialBinding: binding)
    return (active.authority, segments)
  }

  func cancel() async {
    generation &+= 1
    guard let active else { return }
    self.active = nil
    await capture.stopCapture()
    forwardingTask?.cancel()
    forwardingTask = nil
    isStopping = false
    await transcriber.cancel(active.handle)
  }

  private func append(_ frame: MeetingPCMFrame, expected: UInt64, transcriber: MeetingCloudTranscriber) async throws {
    guard expected == generation, let active, active.generation == expected else { return }
    try await transcriber.append(frame, to: active.handle)
  }

  private func fail(_ error: Error, expected: UInt64, transcriber: MeetingCloudTranscriber) async {
    guard expected == generation, let active else { return }
    generation &+= 1
    self.active = nil
    await capture.stopCapture()
    await transcriber.cancel(active.handle)
    forwardingTask = nil
    isStopping = false
    await captureEnded(error)
  }

  private func finishedUnexpectedly(expected: UInt64) async {
    guard !isStopping, expected == generation, active?.generation == expected else { return }
    await captureEnded(nil)
  }

  private struct Active: Sendable {
    let authority: MeetingAutomationAuthority
    let handle: MeetingCloudRecordingHandle
    let generation: UInt64
  }
}
