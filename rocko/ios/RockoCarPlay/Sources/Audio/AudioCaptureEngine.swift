import AVFoundation
import Foundation

final class AudioCaptureEngine {
  var onPCMChunk: ((Data) -> Void)?
  var onInterruption: ((Bool) -> Void)?

  private static let targetSampleRate: Double = 24_000

  private let engine = AVAudioEngine()
  private let session = AVAudioSession.sharedInstance()
  private let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: targetSampleRate,
    channels: 1,
    interleaved: false
  )!
  private var converter: AVAudioConverter?
  private var isConfigured = false

  var isRunning: Bool {
    engine.isRunning
  }

  func start() throws {
    if engine.isRunning {
      return
    }

    try configureSessionIfNeeded()

    let inputNode = engine.inputNode
    let inputFormat = inputNode.outputFormat(forBus: 0)

    if inputFormat.sampleRate != Self.targetSampleRate || inputFormat.channelCount != 1 {
      converter = AVAudioConverter(from: inputFormat, to: targetFormat)
    } else {
      converter = nil
    }

    inputNode.removeTap(onBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
      guard let self else { return }
      let outputBuffer: AVAudioPCMBuffer
      if let converter = self.converter {
        let ratio = Self.targetSampleRate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
        guard let converted = AVAudioPCMBuffer(pcmFormat: self.targetFormat, frameCapacity: capacity) else { return }
        var error: NSError?
        var inputConsumed = false
        converter.convert(to: converted, error: &error) { _, outStatus in
          if inputConsumed {
            outStatus.pointee = .noDataNow
            return nil
          }
          inputConsumed = true
          outStatus.pointee = .haveData
          return buffer
        }
        if error != nil { return }
        outputBuffer = converted
      } else {
        outputBuffer = buffer
      }
      let payload = self.encodePCM16Mono(buffer: outputBuffer)
      guard !payload.isEmpty else { return }
      self.onPCMChunk?(payload)
    }

    engine.prepare()
    try engine.start()
  }

  func stop() {
    guard isConfigured else { return }

    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    converter = nil

    NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: session)
    NotificationCenter.default.removeObserver(self, name: AVAudioSession.routeChangeNotification, object: session)

    do {
      try session.setActive(false, options: [.notifyOthersOnDeactivation])
    } catch {
      // Keep shutdown best-effort.
    }

    isConfigured = false
  }

  private func configureSessionIfNeeded() throws {
    guard !isConfigured else { return }

    try session.setCategory(
      .playAndRecord,
      mode: .spokenAudio,
      options: [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker, .duckOthers]
    )
    try session.setActive(true, options: [])

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleInterruption(_:)),
      name: AVAudioSession.interruptionNotification,
      object: session
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleRouteChange(_:)),
      name: AVAudioSession.routeChangeNotification,
      object: session
    )

    isConfigured = true
  }

  @objc private func handleInterruption(_ notification: Notification) {
    guard let userInfo = notification.userInfo,
          let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

    switch type {
    case .began:
      onInterruption?(true)
    case .ended:
      let options = (userInfo[AVAudioSessionInterruptionOptionKey] as? UInt)
        .map { AVAudioSession.InterruptionOptions(rawValue: $0) }
      if options?.contains(.shouldResume) == true {
        try? engine.start()
      }
      onInterruption?(false)
    @unknown default:
      break
    }
  }

  @objc private func handleRouteChange(_ notification: Notification) {
    guard let userInfo = notification.userInfo,
          let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else { return }

    if reason == .oldDeviceUnavailable {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      onInterruption?(true)
    }
  }

  private func encodePCM16Mono(buffer: AVAudioPCMBuffer) -> Data {
    let frameCount = Int(buffer.frameLength)
    guard frameCount > 0 else { return Data() }

    if let floatChannelData = buffer.floatChannelData {
      let channel = floatChannelData[0]
      var samples = [Int16](repeating: 0, count: frameCount)

      for index in 0..<frameCount {
        let sample = max(-1.0, min(1.0, channel[index]))
        samples[index] = Int16(sample * Float(Int16.max))
      }

      return samples.withUnsafeBufferPointer { pointer in
        Data(buffer: pointer)
      }
    }

    if let int16ChannelData = buffer.int16ChannelData {
      let channel = int16ChannelData[0]
      let pointer = UnsafeBufferPointer(start: channel, count: frameCount)
      return Data(buffer: pointer)
    }

    return Data()
  }
}
