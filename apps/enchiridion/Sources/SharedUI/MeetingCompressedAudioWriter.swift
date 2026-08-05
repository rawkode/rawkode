import AVFoundation
import EnchiridionCore
import Foundation

/// Session-scoped AAC writer for the cloud route. It accepts only live PCM
/// blocks, writes directly to the transient lease file, and discards every block
/// once `AVAudioFile` has accepted it.
@available(iOS 26.0, macOS 26.0, *)
actor MeetingCompressedAudioWriter: MeetingCompressedAudioWriting {
  private static let targetBitRate = 64_000
  /// Leaves room for the MPEG-4 container and encoder variance. The actual file
  /// size is also checked after every write.
  private static let containerHeadroomBytes = 256 * 1_024
  private var output: AVAudioFile?
  private var destination: URL?
  private var encodedDuration: TimeInterval = 0
  private let targetFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!

  func begin(destination: URL) async throws {
    await cancel()
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: targetFormat.sampleRate,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: Self.targetBitRate,
    ]
    output = try AVAudioFile(forWriting: destination, settings: settings)
    self.destination = destination
    encodedDuration = 0
  }

  func append(_ frame: MeetingPCMFrame) async throws {
    guard let output, frame.frameCount > 0, frame.sampleRate > 0, frame.channelCount > 0 else { return }
    let projectedDuration = encodedDuration + frame.duration
    let encodedBudget = MeetingTransientAudioStore.maximumAudioBytes - Self.containerHeadroomBytes
    let projectedEncodedBytes = projectedDuration * Double(Self.targetBitRate) / 8
    guard projectedEncodedBytes <= Double(encodedBudget) else {
      throw MeetingCloudTranscriptionError.audioTooLarge
    }
    // Downmix every source (including ScreenCaptureKit's normal stereo system
    // stream) before conversion. The output is intentionally one mono AAC track,
    // so it can never accidentally write a stereo buffer into a mono container.
    let inputFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: frame.sampleRate,
      channels: 1,
      interleaved: false
    )!
    guard let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(frame.frameCount)),
      let channel = input.floatChannelData?[0]
    else { return }
    input.frameLength = AVAudioFrameCount(frame.frameCount)
    for index in 0..<frame.frameCount {
      var mixed: Float = 0
      for sourceChannel in 0..<frame.channelCount { mixed += frame.samples[index * frame.channelCount + sourceChannel] }
      channel[index] = mixed / Float(frame.channelCount)
    }
    if inputFormat.sampleRate == targetFormat.sampleRate {
      try output.write(from: input)
      encodedDuration = projectedDuration
      try enforceActualFileSize()
      return
    }
    guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat),
      let converted = AVAudioPCMBuffer(
        pcmFormat: targetFormat,
        frameCapacity: AVAudioFrameCount(Double(input.frameLength) * targetFormat.sampleRate / inputFormat.sampleRate + 2)
      )
    else { return }
    var supplied = false
    var conversionError: NSError?
    converter.convert(to: converted, error: &conversionError) { _, status in
      if supplied { status.pointee = .noDataNow; return nil }
      supplied = true
      status.pointee = .haveData
      return input
    }
    if let conversionError { throw conversionError }
    if converted.frameLength > 0 {
      try output.write(from: converted)
      encodedDuration = projectedDuration
      try enforceActualFileSize()
    }
  }

  func finalize() async throws -> URL {
    guard let destination else { throw MeetingCloudTranscriptionError.invalidFinalizedAudio }
    output = nil
    self.destination = nil
    encodedDuration = 0
    return destination
  }

  func cancel() async {
    output = nil
    destination = nil
    encodedDuration = 0
  }

  private func enforceActualFileSize() throws {
    guard let destination,
      let bytes = try FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber,
      bytes.intValue <= MeetingTransientAudioStore.maximumAudioBytes
    else { throw MeetingCloudTranscriptionError.audioTooLarge }
  }
}
