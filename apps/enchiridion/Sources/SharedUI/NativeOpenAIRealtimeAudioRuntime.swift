import AVFoundation
import EnchiridionCore
import Foundation

/// The native-only OpenAI Realtime path.  Unlike the legacy WebRTC bridge this
/// object owns one WebSocket, one receiver and one serial writer for the whole
/// lifetime of a voice attempt.  It is intentionally injected as both the
/// transport and the audio-session controller so capture cannot outlive the
/// connection that accepted it.
@MainActor
final class NativeOpenAIRealtimeAudioRuntime: NSObject, RealtimeVoiceTransport, RealtimeAudioSessionControlling, URLSessionTaskDelegate {
  private static let endpoint = URL(string: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1")!
  private let codec = RealtimeProtocolCodec()
  private let audioSession: any RealtimeAudioSessionControlling
  private let stream: AsyncStream<RealtimeServerEvent>
  private let continuation: AsyncStream<RealtimeServerEvent>.Continuation
  private let activityStream: AsyncStream<RealtimeAudioActivitySample>
  private let activityContinuation: AsyncStream<RealtimeAudioActivitySample>.Continuation
  private var session: URLSession?
  private var socket: URLSessionWebSocketTask?
  private var receiver: Task<Void, Never>?
  private var writer = NativeRealtimeWriter()
  private var activeGeneration: UInt64?
  private var failure: RealtimeVoiceFailure?
  private var microphoneEnabled = false
  private var audio: NativeRealtimeAudioPipeline?
  /// The only data used for a truncate is locally rendered audio from this
  /// response. It is reset before a new response can reuse an item id.
  private var renderedOutput: RenderedOutput?
  private var scheduledByResponse: [String: Int] = [:]

  private struct RenderedOutput {
    let responseID: String
    let itemID: String
    let contentIndex: Int
    var renderedFrames: Int
  }

  init(audioSession: any RealtimeAudioSessionControlling = realtimeAudioSessionController()) {
    self.audioSession = audioSession
    let events = AsyncStream<RealtimeServerEvent>.makeStream(bufferingPolicy: .bufferingNewest(256))
    stream = events.stream; continuation = events.continuation
    let activity = AsyncStream<RealtimeAudioActivitySample>.makeStream(bufferingPolicy: .bufferingNewest(1))
    activityStream = activity.stream; activityContinuation = activity.continuation
  }

  deinit { receiver?.cancel(); socket?.cancel(with: .goingAway, reason: nil); session?.invalidateAndCancel() }

  func start(generation: UInt64, diagnosticContext: OpenAIRealtimeVoiceDiagnosticContext, route: RealtimeVoiceRouteSnapshot, configuration: RealtimeVoiceConfiguration, credential: RealtimeCredentialLease) async throws -> RealtimeSessionCreated {
    guard socket == nil, configuration.modelID == "gpt-realtime-2.1" else { throw RealtimeVoiceTransportError.unavailable }
    var request = URLRequest(url: Self.endpoint)
    request.timeoutInterval = 30
    credential.withSecret { request.setValue("Bearer \($0)", forHTTPHeaderField: "Authorization") }
    let urlSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    let task = urlSession.webSocketTask(with: request)
    session = urlSession; socket = task; activeGeneration = generation; task.resume()
    do {
      let created = try await receiveSessionCreated()
      try configuration.validateActual(modelID: created.modelID, voiceID: created.voiceID)
      try await sendJSON(["type": "session.update", "session": [
        "type": "realtime", "output_modalities": ["audio"],
        "audio": ["input": ["format": ["type": "audio/pcm", "rate": 24_000], "turn_detection": ["type": "server_vad", "create_response": true, "interrupt_response": true]],
                  "output": ["format": ["type": "audio/pcm", "rate": 24_000], "voice": configuration.voiceID]],
        "tools": [], "tool_choice": "none", "max_output_tokens": configuration.maxOutputTokens
      ]])
      try await receiveSessionUpdated(configuration: configuration)
      beginReceiving(generation: generation)
      return created
    } catch { await close(); throw error }
  }

  func events() -> AsyncStream<RealtimeServerEvent> { stream }
  func activity() -> AsyncStream<RealtimeAudioActivitySample> { activityStream }
  func terminalFailure() -> RealtimeVoiceFailure? { failure }
  func activate() async throws { try await audioSession.activate() }
  func deactivate() async { microphoneEnabled = false; audio?.stopCapture(); await audioSession.deactivate() }
  func deactivateWithResult() async -> RealtimeAudioSessionDeactivationResult {
    microphoneEnabled = false; audio?.stopCapture()
    return await audioSession.deactivateWithResult()
  }
  func resetAfterMediaServicesReset() async { await audioSession.resetAfterMediaServicesReset() }
  func setInputEnabled(_ enabled: Bool) async throws {
    guard let generation = activeGeneration, socket != nil else { throw RealtimeVoiceTransportError.bridgeClosed }
    microphoneEnabled = enabled
    if enabled {
      if audio == nil {
        audio = NativeRealtimeAudioPipeline(
          generation: generation,
          append: { [weak self] frame in
            await self?.appendCapturedAudioIfEnabled(frame, generation: generation)
          },
          activity: { [weak self] input, output in
            Task { @MainActor [weak self] in
              self?.activityContinuation.yield(.init(generation: generation, inputLevel: input, outputLevel: output))
            }
          }, rendered: { [weak self] responseID, itemID, contentIndex, frames in
            Task { @MainActor [weak self] in
              self?.finishRenderedBuffer(
                responseID: responseID,
                itemID: itemID,
                contentIndex: contentIndex,
                renderedFrames: frames
              )
            }
          }
        )
      }
      try audio?.startCapture()
    } else { audio?.stopCapture() }
  }
  func close() async { microphoneEnabled = false; audio?.stop(); audio = nil; receiver?.cancel(); receiver = nil; socket?.cancel(with: .goingAway, reason: nil); socket = nil; session?.invalidateAndCancel(); session = nil; activeGeneration = nil }

  func send(_ command: RealtimeClientCommand) async throws {
    // The writer is a strict interruption barrier: clear local work before
    // sending control so a stale capture append cannot cross a cancel.
    switch command {
    case let .responseCancel(responseID):
      audio?.interruptOutput()
      let truncate: RenderedOutput? = {
        guard let output = renderedOutput,
          output.responseID == responseID,
          output.renderedFrames > 0
        else { return nil }
        return output
      }()
      try await writer.interrupt(
        control: { [weak self] in
          guard let self else { return }
          try await self.sendInterruption(command: command, truncate: truncate)
        },
        sendAppend: { [weak self] frame in try await self?.sendCapturedAudio(frame, generation: self?.activeGeneration ?? 0) }
      )
      continuation.yield(.init(payload: .playbackInterrupted(responseID: responseID)))
      renderedOutput = nil
      return
    case .outputAudioBufferClear:
      audio?.interruptOutput()
      try await writer.interrupt(
        control: { [weak self] in try await self?.sendCommand(command) },
        sendAppend: { [weak self] frame in try await self?.sendCapturedAudio(frame, generation: self?.activeGeneration ?? 0) }
      )
      return
    case .inputAudioBufferClear:
      try await writer.interrupt(
        control: { [weak self] in try await self?.sendCommand(command) },
        sendAppend: { [weak self] frame in
          try await self?.sendCapturedAudio(frame, generation: self?.activeGeneration ?? 0)
        }
      )
      return
    }
  }

  nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }

  private func beginReceiving(generation: UInt64) {
    receiver = Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        while !Task.isCancelled, self.activeGeneration == generation {
          let text = try await self.receiveText()
          self.consumeNativeAudioDelta(text, generation: generation)
          if let event = try self.codec.decode(text) { self.continuation.yield(event) }
        }
      } catch where !Task.isCancelled {
        self.failure = RealtimeVoiceFailure(code: "native_transport_closed", message: "The OpenAI Voice connection closed.")
        self.continuation.finish()
      } catch {}
    }
  }

  private func receiveSessionCreated() async throws -> RealtimeSessionCreated {
    while true { if let event = try codec.decode(try await receiveText()), case let .sessionCreated(created) = event.payload { return created } }
  }
  private func receiveSessionUpdated(configuration: RealtimeVoiceConfiguration) async throws {
    while true {
      let text = try await receiveText()
      guard let data = text.data(using: .utf8), let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], root["type"] as? String == "session.updated", let session = root["session"] as? [String: Any], session["model"] as? String == configuration.modelID,
        let audio = session["audio"] as? [String: Any], let input = audio["input"] as? [String: Any], let output = audio["output"] as? [String: Any],
        (output["voice"] as? String) == configuration.voiceID,
        ((input["turn_detection"] as? [String: Any])?["type"] as? String) == "server_vad",
        ((output["format"] as? [String: Any])?["rate"] as? Int) == 24_000
      else { continue }
      return
    }
  }
  private func receiveText() async throws -> String {
    guard let socket else { throw RealtimeVoiceTransportError.bridgeClosed }
    switch try await socket.receive() { case let .string(value): return value; case let .data(data): guard let value = String(data: data, encoding: .utf8) else { throw RealtimeVoiceTransportError.bridgeFailure }; return value; @unknown default: throw RealtimeVoiceTransportError.bridgeFailure }
  }
  private func sendJSON(_ object: [String: Any]) async throws {
    guard let socket, JSONSerialization.isValidJSONObject(object) else { throw RealtimeVoiceTransportError.bridgeClosed }
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    guard data.count <= RealtimeProtocolCodec.maximumEventBytes, let text = String(data: data, encoding: .utf8) else { throw RealtimeVoiceTransportError.bridgeFailure }
    try await socket.send(.string(text))
  }

  private func appendAudio(_ pcm: Data, generation: UInt64) async {
    guard activeGeneration == generation, pcm.count <= 16_384 else { return }
    await writer.enqueue(pcm) { [weak self] frame in
      try await self?.sendCapturedAudio(frame, generation: generation)
    }
  }

  private func appendCapturedAudioIfEnabled(_ pcm: Data, generation: UInt64) async {
    guard microphoneEnabled else { return }
    await appendAudio(pcm, generation: generation)
  }

  private func sendCapturedAudio(_ frame: Data, generation: UInt64) async throws {
    guard activeGeneration == generation, microphoneEnabled else { return }
    try await sendJSON([
      "type": "input_audio_buffer.append",
      "audio": frame.base64EncodedString(),
    ])
  }

  private func consumeNativeAudioDelta(_ text: String, generation: UInt64) {
    guard let data = text.data(using: .utf8),
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      root["type"] as? String == "response.output_audio.delta",
      let responseID = root["response_id"] as? String,
      let itemID = root["item_id"] as? String,
      let contentIndex = root["content_index"] as? Int,
      let encoded = root["delta"] as? String,
      encoded.utf8.count <= 64 * 1024,
      let pcm = Data(base64Encoded: encoded), pcm.count <= 48_000
    else { return }
    let scheduled = audio?.play(
      pcm,
      responseID: responseID,
      itemID: itemID,
      contentIndex: contentIndex
    )
    guard (scheduled ?? 0) > 0 else { return }
    scheduledByResponse[responseID, default: 0] += 1
    continuation.yield(.init(payload: .playbackStarted(responseID: responseID)))
  }

  private func commandObject(_ command: RealtimeClientCommand) throws -> [String: Any] {
    let encoded = try codec.encode(command)
    guard let data = encoded.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw RealtimeVoiceTransportError.bridgeFailure }
    return object
  }

  private func sendCommand(_ command: RealtimeClientCommand) async throws {
    try await sendJSON(try commandObject(command))
  }

  private func sendInterruption(
    command: RealtimeClientCommand,
    truncate: RenderedOutput?
  ) async throws {
    try await sendCommand(command)
    if let truncate {
      try await sendJSON([
        "type": "conversation.item.truncate",
        "item_id": truncate.itemID,
        "content_index": truncate.contentIndex,
        "audio_end_ms": truncate.renderedFrames * 1_000 / 24_000,
      ])
    }
  }
  private func finishRenderedBuffer(
    responseID: String,
    itemID: String,
    contentIndex: Int,
    renderedFrames: Int
  ) {
    if renderedOutput?.responseID == responseID,
      renderedOutput?.itemID == itemID,
      renderedOutput?.contentIndex == contentIndex
    {
      renderedOutput?.renderedFrames += renderedFrames
    } else {
      renderedOutput = .init(
        responseID: responseID,
        itemID: itemID,
        contentIndex: contentIndex,
        renderedFrames: renderedFrames
      )
    }
    let remaining = max(0, (scheduledByResponse[responseID] ?? 1) - 1)
    if remaining == 0 { scheduledByResponse[responseID] = nil; continuation.yield(.init(payload: .playbackDrained(responseID: responseID))) }
    else { scheduledByResponse[responseID] = remaining }
  }
}

private actor NativeRealtimeWriter {
  private struct Entry { let epoch: UInt64; let frame: Data }
  private var frames: [Entry] = []
  private var draining = false
  private var epoch: UInt64 = 0
  private var barrierActive = false
  private var settlementWaiters: [CheckedContinuation<Void, Never>] = []
  func enqueue(_ frame: Data, send: @escaping @Sendable (Data) async throws -> Void) async {
    frames.append(.init(epoch: epoch, frame: frame))
    if frames.count > 4 { frames.removeFirst(frames.count - 4) }
    guard !draining, !barrierActive else { return }
    await drain(send)
  }
  func interrupt(
    control: @escaping @Sendable () async throws -> Void,
    sendAppend: @escaping @Sendable (Data) async throws -> Void
  ) async throws {
    barrierActive = true; epoch &+= 1
    if draining { await withCheckedContinuation { settlementWaiters.append($0) } }
    // In-flight append has settled; old queued input can never cross control.
    frames.removeAll { $0.epoch != epoch }
    try await control()
    barrierActive = false
    await drain(sendAppend)
  }
  private func drain(_ send: @escaping @Sendable (Data) async throws -> Void) async {
    guard !draining, !barrierActive else { return }
    draining = true
    while !barrierActive, let next = frames.first {
      guard next.epoch == epoch else { frames.removeFirst(); continue }
      frames.removeFirst()
      do { try await send(next.frame) } catch { frames.removeAll(); break }
    }
    draining = false
    let waiters = settlementWaiters; settlementWaiters.removeAll(); waiters.forEach { $0.resume() }
  }
  func barrier() { epoch &+= 1; frames.removeAll() }
  func clearCapture() { frames.removeAll() }
}

@MainActor
private final class NativeRealtimeAudioPipeline {
  private let generation: UInt64
  private let append: @Sendable (Data) async -> Void
  private let activity: @Sendable (Double, Double) -> Void
  private let rendered: @Sendable (String, String, Int, Int) -> Void
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let captureFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
  private var running = false
  private var ingress: NativeRealtimeCaptureIngress?
  init(generation: UInt64, append: @escaping @Sendable (Data) async -> Void, activity: @escaping @Sendable (Double, Double) -> Void, rendered: @escaping @Sendable (String, String, Int, Int) -> Void) {
    self.generation = generation; self.append = append; self.activity = activity; self.rendered = rendered
    engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: captureFormat)
  }
  func startCapture() throws {
    guard !running else { return }
    let input = engine.inputNode; let source = input.outputFormat(forBus: 0)
    guard let converter = AVAudioConverter(from: source, to: captureFormat) else { throw RealtimeVoiceTransportError.bridgeFailure }
    let ingress = NativeRealtimeCaptureIngress(
      sourceFormat: source, outputFormat: captureFormat, converter: converter,
      consume: append, activity: activity
    )
    self.ingress = ingress
    input.installTap(onBus: 0, bufferSize: 480, format: source) { buffer, _ in
      // Real-time callback: bounded copy + signal only.  No Data allocation,
      // conversion, base64, actor hop, RMS, or Task construction is allowed.
      ingress.push(buffer)
    }
    engine.prepare(); try engine.start(); player.play(); running = true
  }
  func stopCapture() { if running { engine.inputNode.removeTap(onBus: 0) }; ingress?.stop(); ingress = nil; running = false }
  func stop() { stopCapture(); player.stop(); engine.stop() }
  func interruptOutput() { player.stop(); if running { player.play() }; activity(0, 0) }
  @discardableResult func play(
    _ pcm: Data,
    responseID: String,
    itemID: String,
    contentIndex: Int
  ) -> Int {
    guard pcm.count >= 2, pcm.count % 2 == 0, let buffer = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: AVAudioFrameCount(pcm.count / 2)) else { return 0 }
    buffer.frameLength = buffer.frameCapacity
    pcm.copyBytes(to: UnsafeMutableRawBufferPointer(start: buffer.int16ChannelData![0], count: pcm.count))
    let renderedFrames = Int(buffer.frameLength)
    player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [rendered] _ in
      rendered(responseID, itemID, contentIndex, renderedFrames)
    }
    if !player.isPlaying { player.play() }; activity(0, Self.level(pcm)); return Int(buffer.frameLength)
  }
  nonisolated fileprivate static func level(_ bytes: Data) -> Double { let samples = bytes.withUnsafeBytes { $0.bindMemory(to: Int16.self) }; let peak = samples.reduce(0) { max($0, abs(Int($1))) }; return min(1, Double(peak) / Double(Int16.max)) }
}

/// Fixed-slot SPSC capture ingress. Slots are allocated once; overflow drops
/// newest audio rather than delaying Core Audio or allowing unbounded memory.
private final class NativeRealtimeCaptureIngress: @unchecked Sendable {
  private static let slotCount = 8
  private static let slotBytes = 16_384
  private let lock = NSLock()
  private let slots = (0 ..< slotCount).map { _ in UnsafeMutableRawPointer.allocate(byteCount: slotBytes, alignment: 64) }
  /// Reserved worker staging buffer. A producer cannot reuse a slot until the
  /// worker has copied that slot here while it still holds the consumer lock.
  private let workerRaw = UnsafeMutableRawPointer.allocate(byteCount: slotBytes, alignment: 64)
  private var sizes = Array(repeating: 0, count: slotCount)
  private var frames = Array(repeating: AVAudioFrameCount(0), count: slotCount)
  private var write = 0
  private var read = 0
  private var stopped = false
  private let signal = DispatchSemaphore(value: 0)
  private let worker = DispatchQueue(label: "dev.rawkode.enchiridion.realtime.capture", qos: .userInitiated)
  private let sourceFormat: AVAudioFormat
  private let outputFormat: AVAudioFormat
  private let converter: AVAudioConverter
  private let deliveryContinuation: AsyncStream<Data>.Continuation
  private var deliveryTask: Task<Void, Never>?
  private let activity: @Sendable (Double, Double) -> Void

  init(sourceFormat: AVAudioFormat, outputFormat: AVAudioFormat, converter: AVAudioConverter, consume: @escaping @Sendable (Data) async -> Void, activity: @escaping @Sendable (Double, Double) -> Void) {
    self.sourceFormat = sourceFormat; self.outputFormat = outputFormat; self.converter = converter; self.activity = activity
    let delivery = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingNewest(4))
    deliveryContinuation = delivery.continuation
    deliveryTask = Task {
      for await bytes in delivery.stream {
        guard !Task.isCancelled else { return }
        await consume(bytes)
      }
    }
    worker.async { [weak self] in self?.run() }
  }
  deinit {
    deliveryContinuation.finish()
    deliveryTask?.cancel()
    slots.forEach { $0.deallocate() }
    workerRaw.deallocate()
  }
  func push(_ buffer: AVAudioPCMBuffer) {
    // Core Audio gives us a fixed buffer. Copy its first interleaved channel;
    // unsupported/multichannel inputs are safely dropped rather than bridged.
    guard let source = buffer.audioBufferList.pointee.mBuffers.mData else { return }
    let count = min(Int(buffer.audioBufferList.pointee.mBuffers.mDataByteSize), Self.slotBytes)
    guard count > 0 else { return }
    guard lock.try() else { return }
    let next = (write + 1) % Self.slotCount
    guard next != read, !stopped else { lock.unlock(); return }
    slots[write].copyMemory(from: source, byteCount: count); sizes[write] = count; frames[write] = buffer.frameLength; write = next
    lock.unlock(); signal.signal()
  }
  func stop() {
    lock.lock(); stopped = true; lock.unlock()
    deliveryContinuation.finish()
    deliveryTask?.cancel()
    signal.signal()
  }
  private func run() {
    while true {
      signal.wait()
      lock.lock()
      if stopped { lock.unlock(); return }
      guard read != write else { lock.unlock(); continue }
      let index = read; let count = sizes[index]; let countFrames = frames[index]
      // Keep ownership of the slot through this memcpy. Only then is it safe
      // to publish the new read index to the real-time producer.
      workerRaw.copyMemory(from: slots[index], byteCount: count)
      read = (read + 1) % Self.slotCount
      lock.unlock()
      guard let input = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: countFrames) else { continue }
      input.frameLength = countFrames
      input.audioBufferList.pointee.mBuffers.mData?.copyMemory(from: workerRaw, byteCount: count)
      let capacity = AVAudioFrameCount(Double(countFrames) * outputFormat.sampleRate / max(1, sourceFormat.sampleRate)) + 32
      guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { continue }
      var supplied = false; var error: NSError?
      converter.convert(to: output, error: &error) { _, status in
        if supplied { status.pointee = .noDataNow; return nil }; supplied = true; status.pointee = .haveData; return input
      }
      guard error == nil, output.frameLength > 0, let samples = output.int16ChannelData?[0] else { continue }
      let bytes = Data(bytes: samples, count: Int(output.frameLength) * 2)
      activity(NativeRealtimeAudioPipeline.level(bytes), 0)
      deliveryContinuation.yield(bytes)
    }
  }
}
