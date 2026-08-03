import AVFoundation
import EnchiridionCore
import Foundation

/// Native WebSocket transport for the frozen, workspace-specific Qwen route.
/// It never follows a redirect and never exposes a credential to a web view.
@MainActor
final class URLSessionQwenRealtimeVoiceTransport: NSObject, QwenRealtimeTransport, URLSessionTaskDelegate {
  private let codec: QwenRealtimeProtocolCodec
  private let eventsStream: AsyncStream<QwenRealtimeServerEvent>
  private let eventsContinuation: AsyncStream<QwenRealtimeServerEvent>.Continuation
  private let activityStream: AsyncStream<RealtimeAudioActivitySample>
  private let activityContinuation: AsyncStream<RealtimeAudioActivitySample>.Continuation
  private var urlSession: URLSession?
  private var task: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var generation: UInt64?
  private var audio: QwenRealtimeAudioPipeline?
  private var started = false

  init(codec: QwenRealtimeProtocolCodec = QwenRealtimeProtocolCodec()) {
    self.codec = codec
    let events = AsyncStream<QwenRealtimeServerEvent>.makeStream(bufferingPolicy: .bufferingNewest(256))
    eventsStream = events.stream; eventsContinuation = events.continuation
    let activity = AsyncStream<RealtimeAudioActivitySample>.makeStream(bufferingPolicy: .bufferingNewest(1))
    activityStream = activity.stream; activityContinuation = activity.continuation
  }

  deinit { receiveTask?.cancel(); task?.cancel(with: .goingAway, reason: nil); urlSession?.invalidateAndCancel() }

  func start(
    generation: UInt64,
    route: QwenVoiceRouteSnapshot,
    configuration: QwenRealtimeConfiguration,
    credential: QwenRealtimeCredentialLease
  ) async throws -> QwenRealtimeSessionCreated {
    guard !started, credential.binding == configuration.credentialBinding,
      let workspace = route.workspaceID,
      let model = route.model,
      QwenWorkspace.endpoint(workspaceID: workspace, model: model) == configuration.endpoint
    else { throw QwenRealtimeError.invalidEndpoint }
    guard isExactEndpoint(configuration.endpoint, workspaceID: workspace, model: model) else { throw QwenRealtimeError.invalidEndpoint }

    var request = URLRequest(url: configuration.endpoint)
    request.timeoutInterval = 30
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    credential.withSecret { secret in request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization") }
    let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    let task = session.webSocketTask(with: request)
    self.urlSession = session; self.task = task; self.generation = generation
    task.resume()
    do {
      guard case let .sessionCreated(created) = try await receiveOne() else { throw QwenRealtimeError.handshakeFailed }
      guard created.modelID == configuration.modelID else { throw QwenRealtimeError.handshakeFailed }
      try await send(
        .sessionUpdate(
          modelID: configuration.modelID,
          voiceID: configuration.voiceID,
          enablesTools: configuration.enablesTools
        )
      )
      guard case let .sessionUpdated(updated) = try await receiveOne(),
        updated.modelID == configuration.modelID, updated.voiceID == configuration.voiceID
      else { throw QwenRealtimeError.handshakeFailed }
      started = true
      beginReceiving()
      return updated
    } catch { await close(); throw error }
  }

  func events() -> AsyncStream<QwenRealtimeServerEvent> { eventsStream }
  func activity() -> AsyncStream<RealtimeAudioActivitySample> { activityStream }

  func send(_ event: QwenRealtimeClientEvent) async throws {
    guard let task else { throw QwenRealtimeError.closed }
    let json = try codec.encode(event)
    try await task.send(.string(json))
    if event == .outputAudioBufferClear { audio?.interruptOutput() }
  }

  func setMuted(_ muted: Bool) async throws {
    guard started, let generation else { throw QwenRealtimeError.closed }
    if muted { audio?.stopCapture(); activityContinuation.yield(RealtimeAudioActivitySample(generation: generation, inputLevel: 0, outputLevel: 0)); return }
    if audio == nil {
      audio = QwenRealtimeAudioPipeline(
        generation: generation,
        send: { [weak self] data in try await self?.send(.appendInputAudio(data)) },
        activity: { [weak self] input, output in self?.activityContinuation.yield(RealtimeAudioActivitySample(generation: generation, inputLevel: input, outputLevel: output)) }
      )
    }
    try audio?.startCapture()
  }

  func close() async {
    receiveTask?.cancel(); receiveTask = nil
    audio?.stop(); audio = nil
    task?.cancel(with: .goingAway, reason: nil); task = nil
    urlSession?.invalidateAndCancel(); urlSession = nil
    started = false
    // Streams stay reusable across an intentional stop/start cycle. `deinit`
    // owns terminal completion when the coordinator releases this transport.
  }

  nonisolated func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) { completionHandler(nil) }

  private func isExactEndpoint(_ url: URL, workspaceID: String, model: QwenRealtimeModel) -> Bool {
    QwenWorkspace.endpoint(workspaceID: workspaceID, model: model) == url
  }

  private func receiveOne() async throws -> QwenRealtimeServerEvent {
    guard let task else { throw QwenRealtimeError.closed }
    while true {
      let message = try await task.receive()
      let text: String
      switch message { case let .string(value): text = value; case let .data(data): guard let value = String(data: data, encoding: .utf8) else { throw QwenRealtimeError.malformedEvent }; text = value; @unknown default: throw QwenRealtimeError.malformedEvent }
      if let event = try codec.decode(text) { return event }
    }
  }

  private func beginReceiving() {
    receiveTask = Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        while !Task.isCancelled {
          let event = try await self.receiveOne()
          switch event {
          case let .outputAudio(data): self.audio?.play(data)
          default: self.eventsContinuation.yield(event)
          }
        }
      } catch {
        if !Task.isCancelled {
          self.eventsContinuation.yield(.error(code: nil, message: "Qwen Realtime disconnected."))
        }
      }
    }
  }
}

/// A deliberately bounded PCM bridge: capture is converted to 16 kHz mono
/// signed PCM and sliced into approximately 20 ms frames; playback accepts the
/// service's 24 kHz mono PCM. Audio drops rather than backing up control work.
@MainActor
private final class QwenRealtimeAudioPipeline {
  private let generation: UInt64
  private let send: @Sendable (Data) async throws -> Void
  private let activity: @Sendable (Double, Double) -> Void
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let captureFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
  private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
  private var captureQueue: [Data] = []
  private var sending = false
  private var running = false

  init(generation: UInt64, send: @escaping @Sendable (Data) async throws -> Void, activity: @escaping @Sendable (Double, Double) -> Void) {
    self.generation = generation; self.send = send; self.activity = activity
    engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: outputFormat)
  }

  func startCapture() throws {
    guard !running else { return }
    let input = engine.inputNode
    let sourceFormat = input.outputFormat(forBus: 0)
    guard let converter = AVAudioConverter(from: sourceFormat, to: captureFormat) else { throw QwenRealtimeError.handshakeFailed }
    input.installTap(onBus: 0, bufferSize: 960, format: sourceFormat) { [weak self] buffer, _ in
      guard let self else { return }
      let frameCapacity = AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / max(sourceFormat.sampleRate, 1)) + 32
      guard let converted = AVAudioPCMBuffer(pcmFormat: self.captureFormat, frameCapacity: frameCapacity) else { return }
      var error: NSError?
      var suppliedInput = false
      converter.convert(to: converted, error: &error) { _, status in
        guard !suppliedInput else {
          status.pointee = .noDataNow
          return nil
        }
        suppliedInput = true
        status.pointee = .haveData
        return buffer
      }
      guard error == nil, converted.frameLength > 0, let channel = converted.int16ChannelData?[0] else { return }
      let byteCount = Int(converted.frameLength) * MemoryLayout<Int16>.size
      let data = Data(bytes: channel, count: byteCount)
      Task { @MainActor [weak self] in self?.enqueue(data, level: Self.level(data)) }
    }
    engine.prepare(); try engine.start(); player.play(); running = true
  }

  func stopCapture() {
    guard running else { captureQueue.removeAll(); return }
    engine.inputNode.removeTap(onBus: 0)
    captureQueue.removeAll()
    running = false
  }
  func stop() { stopCapture(); player.stop(); engine.stop() }

  func interruptOutput() {
    player.stop()
    if running { player.play() }
    activity(0, 0)
  }

  func play(_ data: Data) {
    guard !data.isEmpty, data.count <= QwenRealtimeProtocolCodec.maximumAudioBytes else { return }
    let frames = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frames) else { return }
    buffer.frameLength = frames
    buffer.int16ChannelData![0].withMemoryRebound(to: UInt8.self, capacity: data.count) {
      data.copyBytes(to: $0, count: data.count)
    }
    player.scheduleBuffer(buffer); if !player.isPlaying { player.play() }
    activity(0, Self.level(data))
  }

  private func enqueue(_ data: Data, level: Double) {
    // 20 ms at 16 kHz mono PCM is 640 bytes. Keep at most four newest frames.
    guard data.count >= 320, data.count <= QwenRealtimeProtocolCodec.maximumAudioBytes else { return }
    captureQueue.append(data); if captureQueue.count > 4 { captureQueue.removeFirst(captureQueue.count - 4) }
    activity(level, 0)
    guard !sending else { return }; sending = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      while !self.captureQueue.isEmpty {
        let frame = self.captureQueue.removeFirst()
        do { try await self.send(frame) } catch { self.captureQueue.removeAll(); break }
      }
      self.sending = false
    }
  }

  private static func level(_ data: Data) -> Double {
    guard data.count >= 2 else { return 0 }
    let samples = data.withUnsafeBytes { $0.bindMemory(to: Int16.self) }
    let peak = samples.reduce(0) { max($0, abs(Int($1))) }
    return min(1, Double(peak) / Double(Int16.max))
  }
}
