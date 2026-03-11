import AVFoundation
import Foundation

final class AudioPlaybackEngine {
  var onPlaybackDrained: (() -> Void)?

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var isConfigured = false
  private var pendingBufferCount = 0
  private let lock = NSLock()

  var isPlaying: Bool {
    player.isPlaying
  }

  init() {
    configureIfNeeded()
  }

  func enqueuePCM16Mono(_ data: Data, sampleRate: Double = 24_000) {
    guard !data.isEmpty else { return }
    configureIfNeeded(sampleRate: sampleRate)

    let bytesPerFrame = MemoryLayout<Int16>.size
    let frameCount = AVAudioFrameCount(data.count / bytesPerFrame)
    guard
      let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)
    else {
      return
    }

    buffer.frameLength = frameCount
    guard let channelData = buffer.floatChannelData?[0] else { return }

    data.withUnsafeBytes { rawBuffer in
      let samples = rawBuffer.bindMemory(to: Int16.self)
      for index in 0..<Int(frameCount) {
        channelData[index] = Float(samples[index]) / Float(Int16.max)
      }
    }

    lock.lock()
    pendingBufferCount += 1
    lock.unlock()

    player.scheduleBuffer(buffer) { [weak self] in
      guard let self else { return }
      self.lock.lock()
      self.pendingBufferCount -= 1
      let drained = self.pendingBufferCount == 0
      self.lock.unlock()
      if drained {
        DispatchQueue.main.async {
          self.onPlaybackDrained?()
        }
      }
    }

    if !player.isPlaying {
      player.play()
    }
  }

  func stop() {
    player.stop()
    engine.stop()
    lock.lock()
    pendingBufferCount = 0
    lock.unlock()
  }

  private func configureIfNeeded(sampleRate: Double = 24_000) {
    guard !isConfigured else { return }

    engine.attach(player)

    if let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) {
      engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    try? engine.start()
    isConfigured = true
  }
}
