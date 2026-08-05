import AVFoundation
import EnchiridionCore
import Foundation

/// Meeting-only microphone capture. It never calls `OnDeviceSpeechTranscriber`:
/// that assistant path is deliberately limited to short, single utterances.
@available(iOS 26.0, macOS 26.0, *)
final class MeetingMicrophoneCapture: NSObject, MeetingAudioCapturing, @unchecked Sendable {
  private let engine = AVAudioEngine()
  private let lock = NSLock()
  private var continuation: AsyncStream<MeetingPCMFrame>.Continuation?
  private var generation: UInt64 = 0
  private var installedTap = false
  private var running = false
  #if os(iOS)
    private var interruptionObserver: NSObjectProtocol?
  #endif

  deinit { stopSynchronously() }

  func startCapture() async throws -> AsyncStream<MeetingPCMFrame> {
    stopSynchronously()
    guard await requestMicrophonePermission() else { throw MeetingAudioCaptureError.microphonePermissionDenied }
    #if os(iOS)
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
      try session.setActive(true)
    #endif
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      #endif
      throw MeetingAudioCaptureError.inputUnavailable
    }
    let (stream, continuation) = AsyncStream<MeetingPCMFrame>.makeStream(bufferingPolicy: .bufferingNewest(32))
    let token = lock.withLock { () -> UInt64 in
      generation &+= 1
      self.continuation = continuation
      return generation
    }
    continuation.onTermination = { [weak self] _ in self?.stopIfCurrent(token) }
    input.installTap(onBus: 0, bufferSize: 2_048, format: format) { [weak self] buffer, time in
      self?.receive(buffer, time: time, generation: token)
    }
    lock.withLock { installedTap = true }
    do {
      engine.prepare()
      try engine.start()
      lock.withLock { running = true }
      #if os(iOS)
        installInterruptionObserver(generation: token)
      #endif
      return stream
    } catch {
      stopIfCurrent(token)
      throw error
    }
  }

  func stopCapture() async { stopSynchronously() }

  private func receive(_ buffer: AVAudioPCMBuffer, time: AVAudioTime, generation token: UInt64) {
    guard buffer.frameLength > 0, let channels = buffer.floatChannelData else { return }
    let channelCount = Int(buffer.format.channelCount)
    let frames = Int(buffer.frameLength)
    var samples = [Float](repeating: 0, count: frames * channelCount)
    for frame in 0..<frames {
      for channel in 0..<channelCount { samples[frame * channelCount + channel] = channels[channel][frame] }
    }
    let timestamp = time.sampleTime >= 0 && buffer.format.sampleRate > 0
      ? Double(time.sampleTime) / buffer.format.sampleRate : Date.timeIntervalSinceReferenceDate
    let frame = MeetingPCMFrame(generation: token, channel: .microphone, timestamp: timestamp, sampleRate: buffer.format.sampleRate, channelCount: channelCount, samples: samples)
    lock.withLock {
      guard generation == token, running else { return }
      _ = continuation?.yield(frame)
    }
  }

  private func stopIfCurrent(_ token: UInt64) {
    let shouldStop = lock.withLock { generation == token }
    if shouldStop { stopSynchronously() }
  }

  private func stopSynchronously() {
    let state = lock.withLock { () -> (Bool, Bool, AsyncStream<MeetingPCMFrame>.Continuation?) in
      generation &+= 1
      let state = (installedTap, running, continuation)
      installedTap = false; running = false; continuation = nil
      return state
    }
    if state.0 { engine.inputNode.removeTap(onBus: 0) }
    if state.1 { engine.stop() }
    state.2?.finish()
    #if os(iOS)
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
      interruptionObserver = nil
    #endif
  }

  private func requestMicrophonePermission() async -> Bool {
    #if os(macOS)
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized: true
      case .notDetermined: await AVCaptureDevice.requestAccess(for: .audio)
      default: false
      }
    #else
      switch AVAudioApplication.shared.recordPermission {
      case .granted: true
      case .undetermined:
        await withCheckedContinuation { continuation in AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) } }
      default: false
      }
    #endif
  }

  #if os(iOS)
    private func installInterruptionObserver(generation token: UInt64) {
      interruptionObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), queue: nil
      ) { [weak self] notification in
        guard let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          AVAudioSession.InterruptionType(rawValue: type) == .began
        else { return }
        // Do not auto-resume: a new foreground Start issues a new generation.
        self?.stopIfCurrent(token)
      }
    }
  #endif
}

/// Keeps the long-session speech pipeline independent from the assistant's
/// 15-second endpointing policy. A concrete speech implementation consumes its
/// bounded PCM stream and emits transcript segments; it owns no audio files.
@available(iOS 26.0, macOS 26.0, *)
protocol MeetingOnDeviceLongSessionTranscribing: Sendable {
  func transcribe(_ frames: AsyncStream<MeetingPCMFrame>) async
}
