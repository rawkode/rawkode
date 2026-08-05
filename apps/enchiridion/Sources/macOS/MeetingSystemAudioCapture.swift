import CoreAudio
import CoreMedia
import EnchiridionCore
import Foundation
import ScreenCaptureKit

/// macOS call capture uses Apple's visible source picker. It attaches only
/// `.audio` and `.microphone` outputs—never `.screen` and never a recording
/// output—then time-aligns both sources into one bounded mono meeting stream.
@available(macOS 26.0, *)
final class MeetingSystemAudioCapture: NSObject, MeetingAudioCapturing, @unchecked Sendable {
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "dev.rawkode.enchiridion.meeting-system-audio")
  private let mixerLock = NSLock()
  private var mixer = MeetingPCMFrameMixer()
  private var continuation: AsyncStream<MeetingPCMFrame>.Continuation?
  private var stream: SCStream?
  private var generation: UInt64 = 0
  private var activeStreamGeneration: UInt64?
  private var selected = false

  deinit { stopSynchronously() }

  func startCapture() async throws -> AsyncStream<MeetingPCMFrame> {
    stopSynchronously()
    let (frames, continuation) = AsyncStream<MeetingPCMFrame>.makeStream(bufferingPolicy: .bufferingNewest(64))
    let token = lock.withLock { () -> UInt64 in
      generation &+= 1
      self.continuation = continuation
      selected = false
      return generation
    }
    continuation.onTermination = { [weak self] _ in self?.stopIfCurrent(token) }

    let picker = SCContentSharingPicker.shared
    picker.add(self)
    picker.isActive = true
    var configuration = picker.defaultConfiguration
    configuration.allowedPickerModes = [.singleWindow, .singleDisplay, .multipleWindows]
    configuration.allowsChangingSelectedContent = false
    picker.defaultConfiguration = configuration
    picker.present()
    return frames
  }

  func stopCapture() async { stopSynchronously() }

  private func start(filter: SCContentFilter, generation token: UInt64) {
    guard lock.withLock({ generation == token && !selected }) else { return }
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.captureMicrophone = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = 48_000
    config.channelCount = 2
    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    do {
      try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
      try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue)
    } catch {
      finishIfCurrent(token)
      return
    }
    let published = lock.withLock { () -> Bool in
      guard generation == token, !selected else { return false }
      self.stream = stream
      activeStreamGeneration = token
      selected = true
      return true
    }
    guard published else { return }
    stream.startCapture { [weak self] error in
      if error != nil { self?.finishIfCurrent(token) }
    }
    // Stop may race after publication but before `startCapture` is invoked. A
    // second ownership check after the start request closes that window: either
    // Stop still owns the published stream, or this stale start is stopped here.
    let stillCurrent = lock.withLock {
      generation == token && selected && self.stream === stream
    }
    if !stillCurrent { stream.stopCapture(completionHandler: nil) }
  }

  private func receive(_ sampleBuffer: CMSampleBuffer, type: SCStreamOutputType, generation token: UInt64) {
    guard CMSampleBufferDataIsReady(sampleBuffer),
      let format = CMSampleBufferGetFormatDescription(sampleBuffer),
      let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
      streamDescription.mFormatID == kAudioFormatLinearPCM,
      streamDescription.mFormatFlags & kAudioFormatFlagIsFloat != 0,
      streamDescription.mFormatFlags & kAudioFormatFlagIsPacked != 0,
      streamDescription.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
      streamDescription.mBitsPerChannel == 32,
      streamDescription.mSampleRate > 0,
      streamDescription.mChannelsPerFrame > 0
    else { return }
    let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
    let channelCount = Int(streamDescription.mChannelsPerFrame)
    let nonInterleaved = streamDescription.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
    let expectedBytesPerFrame = UInt32(MemoryLayout<Float>.stride * (nonInterleaved ? 1 : channelCount))
    guard frameCount > 0, streamDescription.mBytesPerFrame == expectedBytesPerFrame else { return }
    let samples: [Float]?
    do {
      samples = try sampleBuffer.withAudioBufferList(
        flags: [.audioBufferListAssure16ByteAlignment]
      ) { buffers, _ in
        Self.copyFloatSamples(
          from: buffers,
          frameCount: frameCount,
          channelCount: channelCount,
          nonInterleaved: nonInterleaved
        )
      }
    } catch { return }
    guard let samples else { return }
    let channel: MeetingAudioChannel = type == .microphone ? .microphone : .systemAudio
    let timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    let source = MeetingPCMFrame(generation: token, channel: channel, timestamp: timestamp.isFinite ? timestamp : Date.timeIntervalSinceReferenceDate, sampleRate: streamDescription.mSampleRate, channelCount: channelCount, samples: samples)
    let mixed = mixerLock.withLock { mixer.ingest(source) }
    lock.withLock {
      guard generation == token, selected else { return }
      for frame in mixed { _ = continuation?.yield(frame) }
    }
  }

  private static func copyFloatSamples(
    from buffers: UnsafeMutableAudioBufferListPointer,
    frameCount: Int,
    channelCount: Int,
    nonInterleaved: Bool
  ) -> [Float]? {
    if nonInterleaved {
      guard buffers.count == channelCount else { return nil }
      var samples = [Float](repeating: 0, count: frameCount * channelCount)
      for channel in 0..<channelCount {
        let buffer = buffers[channel]
        let sampleCount = frameCount
        guard buffer.mNumberChannels == 1,
          Int(buffer.mDataByteSize) >= sampleCount * MemoryLayout<Float>.stride,
          let data = buffer.mData
        else { return nil }
        let source = data.assumingMemoryBound(to: Float.self)
        for frame in 0..<frameCount {
          samples[frame * channelCount + channel] = source[frame]
        }
      }
      return samples
    }

    guard buffers.count == 1 else { return nil }
    let buffer = buffers[0]
    let sampleCount = frameCount * channelCount
    guard Int(buffer.mNumberChannels) == channelCount,
      Int(buffer.mDataByteSize) >= sampleCount * MemoryLayout<Float>.stride,
      let data = buffer.mData
    else { return nil }
    return Array(UnsafeBufferPointer(
      start: data.assumingMemoryBound(to: Float.self),
      count: sampleCount
    ))
  }

  private func stopIfCurrent(_ token: UInt64) {
    stopSynchronously(ifCurrent: token)
  }

  private func finishIfCurrent(_ token: UInt64) {
    stopSynchronously(ifCurrent: token)
  }

  private func stopSynchronously(ifCurrent token: UInt64? = nil, stream expectedStream: SCStream? = nil) {
    let state = lock.withLock { () -> (SCStream?, AsyncStream<MeetingPCMFrame>.Continuation?)? in
      if let token, generation != token { return nil }
      if let expectedStream {
        guard let stream, stream === expectedStream else { return nil }
      }
      generation &+= 1
      let state = (stream, continuation)
      stream = nil; continuation = nil; selected = false; activeStreamGeneration = nil
      return state
    }
    guard let state else { return }
    let tail = mixerLock.withLock { () -> [MeetingPCMFrame] in
      let output = mixer.finish()
      mixer.reset()
      return output
    }
    SCContentSharingPicker.shared.remove(self)
    if let stream = state.0 { stream.stopCapture(completionHandler: nil) }
    for frame in tail { _ = state.1?.yield(frame) }
    state.1?.finish()
  }
}

@available(macOS 26.0, *)
extension MeetingSystemAudioCapture: SCContentSharingPickerObserver {
  func contentSharingPicker(_: SCContentSharingPicker, didCancelFor _: SCStream?) {
    stopSynchronously() // cancellation/revocation is terminal; never retain a stale permission.
  }

  func contentSharingPicker(_: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for _: SCStream?) {
    let token = lock.withLock { generation }
    start(filter: filter, generation: token)
  }

  func contentSharingPickerStartDidFailWithError(_: Error) { stopSynchronously() }
}

@available(macOS 26.0, *)
extension MeetingSystemAudioCapture: SCStreamOutput, SCStreamDelegate {
  func stream(_ callbackStream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
    guard outputType == .audio || outputType == .microphone else { return }
    let token = lock.withLock { () -> UInt64? in
      guard selected, callbackStream === stream else { return nil }
      return activeStreamGeneration
    }
    guard let token else { return }
    receive(sampleBuffer, type: outputType, generation: token)
  }

  func stream(_ callbackStream: SCStream, didStopWithError _: Error) {
    stopSynchronously(stream: callbackStream)
  }
}
