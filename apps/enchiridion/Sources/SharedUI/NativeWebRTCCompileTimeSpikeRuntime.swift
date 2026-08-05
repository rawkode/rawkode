#if DEBUG
import EnchiridionCore
import Foundation
@preconcurrency import LiveKitWebRTC

/// Deliberately non-production compile-time spike for the pinned
/// LiveKitWebRTC surface. It owns no credential and does not construct a peer
/// until `start`, preserving Core's permission/lease sequence. S3 owns the
/// actual offer/answer and media implementation; this fails closed meanwhile.
@MainActor
final class NativeWebRTCCompileTimeSpikeRuntime: NSObject,
  RealtimeVoiceTransport, RealtimeAudioSessionControlling
{
  private let eventsStorage: AsyncStream<RealtimeServerEvent>
  private let eventsContinuation: AsyncStream<RealtimeServerEvent>.Continuation
  private let activityStorage: AsyncStream<RealtimeAudioActivitySample>
  private let activityContinuation: AsyncStream<RealtimeAudioActivitySample>.Continuation
  private var closed = false

  override init() {
    let events = AsyncStream<RealtimeServerEvent>.makeStream(bufferingPolicy: .bufferingNewest(256))
    eventsStorage = events.stream
    eventsContinuation = events.continuation
    let activity = AsyncStream<RealtimeAudioActivitySample>.makeStream(bufferingPolicy: .bufferingNewest(1))
    activityStorage = activity.stream
    activityContinuation = activity.continuation
    super.init()
  }

  func start(
    generation: UInt64,
    diagnosticContext: OpenAIRealtimeVoiceDiagnosticContext,
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration,
    credential _: RealtimeCredentialLease
  ) async throws -> RealtimeSessionCreated {
    guard !closed else { throw RealtimeVoiceTransportError.bridgeClosed }
    let factory = LKRTCPeerConnectionFactory()
    #if os(iOS)
      let audioSession = LKRTCAudioSession.sharedInstance()
      audioSession.useManualAudio = true
      audioSession.isAudioEnabled = false
    #elseif os(macOS)
      let audioDeviceModule: LKRTCAudioDeviceModule = factory.audioDeviceModule
      _ = audioDeviceModule
    #endif
    _ = factory; _ = generation; _ = diagnosticContext; _ = route; _ = configuration
    throw RealtimeVoiceTransportError.unavailable
  }

  func events() -> AsyncStream<RealtimeServerEvent> { eventsStorage }
  func activity() -> AsyncStream<RealtimeAudioActivitySample> { activityStorage }
  func send(_ command: RealtimeClientCommand) async throws { throw RealtimeVoiceTransportError.bridgeClosed }
  func setInputEnabled(_ enabled: Bool) async throws { throw RealtimeVoiceTransportError.bridgeClosed }
  func activate() async throws {}
  func deactivate() async {}
  func close() async {
    guard !closed else { return }
    closed = true; eventsContinuation.finish(); activityContinuation.finish()
  }
}
#endif
