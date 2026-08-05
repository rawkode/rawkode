import AVFoundation
import CoreMedia
import EnchiridionCore
import Foundation
import Speech

/// Long-session on-device speech bridge. It accepts the meeting capture stream
/// rather than opening its own microphone, preserving the single-capture
/// boundary used for both in-person and macOS call capture.
@available(iOS 26.0, macOS 26.0, *)
actor MeetingOnDeviceSpeechTranscriber {
  func transcribe(_ frames: AsyncStream<MeetingPCMFrame>, locale: Locale = .current) async throws -> [MeetingTranscriptSegment] {
    guard SpeechTranscriber.isAvailable,
      let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
    else { throw MeetingAudioCaptureError.unavailable("On-device speech transcription is unavailable for this language.") }

    let transcriber = SpeechTranscriber(locale: supportedLocale, preset: .timeIndexedProgressiveTranscription)
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw MeetingAudioCaptureError.inputUnavailable
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    try await analyzer.prepareToAnalyze(in: format)
    let regions = MeetingSpeechRegionAccumulator()

    let (input, continuation) = AsyncThrowingStream<AnalyzerInput, Error>.makeStream(
      bufferingPolicy: .bufferingNewest(64)
    )
    let feeder = Task {
      var timelineOrigin: TimeInterval?
      for await frame in frames {
        guard !Task.isCancelled else { break }
        let origin = timelineOrigin ?? frame.timestamp
        timelineOrigin = origin
        // ScreenCaptureKit presentation timestamps may be on a host-clock
        // timeline. Persisted meeting segments are always relative to Start so
        // they remain within the resource's 12-hour duration bound.
        let relativeFrame = MeetingPCMFrame(
          generation: frame.generation,
          channel: frame.channel,
          timestamp: max(0, frame.timestamp - origin),
          sampleRate: frame.sampleRate,
          channelCount: frame.channelCount,
          samples: frame.samples
        )
        await regions.append(relativeFrame)
        guard let buffer = Self.buffer(relativeFrame, target: format) else { continue }
        let time = CMTime(seconds: relativeFrame.timestamp, preferredTimescale: 48_000)
        continuation.yield(AnalyzerInput(buffer: buffer, bufferStartTime: time))
      }
      continuation.finish()
    }
    let results = Task { () throws -> [SpeechTranscriber.Result] in
      var final: [SpeechTranscriber.Result] = []
      for try await result in transcriber.results where result.isFinal { final.append(result) }
      return final
    }

    do {
      try await analyzer.start(inputSequence: input)
      // `start` only begins analysis. The capture stream closes at foreground
      // Stop, so finalization must wait for the feeder to drain its last PCM
      // frame rather than ending the meeting immediately after Start.
      await feeder.value
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      let final = try await results.value
      let accumulatedRegions = await regions.values
      let assignments = Dictionary(uniqueKeysWithValues: MeetingSpeakerClusterer().assign(accumulatedRegions).map { ($0.regionID, $0.clusterID) })
      return final.enumerated().compactMap { index, result in
        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let start = CMTimeGetSeconds(result.range.start)
        let duration = CMTimeGetSeconds(result.range.duration)
        guard start.isFinite, duration.isFinite, start >= 0, duration >= 0 else { return nil }
        // Speech's local API has no speaker identity. The acoustic cluster is a
        // generic label only and remains manually assignable in the Event view.
        let region = accumulatedRegions.min { abs($0.startTime - start) < abs($1.startTime - start) }
        let cluster = region.flatMap { candidate -> String? in
          guard abs(candidate.startTime - start) <= max(1, duration + 1) else { return nil }
          return assignments[candidate.id]
        } ?? MeetingSpeakerAssignment.unknownClusterID
        return MeetingTranscriptSegment(
          id: "local-\(Int((start * 1_000).rounded()))-\(index)",
          startTime: start,
          endTime: start + duration,
          text: text,
          speakerClusterID: cluster
        )
      }
    } catch {
      feeder.cancel()
      results.cancel()
      await analyzer.cancelAndFinishNow()
      throw error
    }
  }

  private static func buffer(_ frame: MeetingPCMFrame, target: AVAudioFormat) -> AVAudioPCMBuffer? {
    guard frame.frameCount > 0, frame.channelCount > 0,
      let sourceFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: frame.sampleRate, channels: 1, interleaved: false),
      let source = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(frame.frameCount)),
      let channel = source.floatChannelData?[0]
    else { return nil }
    source.frameLength = AVAudioFrameCount(frame.frameCount)
    for index in 0..<frame.frameCount {
      var mixed: Float = 0
      for sourceChannel in 0..<frame.channelCount { mixed += frame.samples[index * frame.channelCount + sourceChannel] }
      channel[index] = mixed / Float(frame.channelCount)
    }
    guard sourceFormat != target else { return source }
    guard let converter = AVAudioConverter(from: sourceFormat, to: target),
      let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(source.frameLength) * target.sampleRate / sourceFormat.sampleRate + 2))
    else { return nil }
    var supplied = false
    converter.convert(to: converted, error: nil) { _, status in
      if supplied { status.pointee = .noDataNow; return nil }
      supplied = true; status.pointee = .haveData
      return source
    }
    return converted
  }
}

/// Retains at most a compact VAD-positive feature window per time slice while a
/// local session is active. This is transient analysis input, not a recording;
/// it is released when `transcribe` returns or throws.
private actor MeetingSpeechRegionAccumulator {
  private var regions: [MeetingSpeechRegion] = []
  private let maximumRegions = 2_000

  func append(_ frame: MeetingPCMFrame) {
    guard regions.count < maximumRegions, frame.frameCount >= 256, frame.sampleRate > 0 else { return }
    var mono: [Float] = []
    mono.reserveCapacity(512)
    for index in 0..<min(frame.frameCount, 512) {
      var value: Float = 0
      for channel in 0..<frame.channelCount { value += frame.samples[index * frame.channelCount + channel] }
      mono.append(value / Float(frame.channelCount))
    }
    let energy = sqrt(mono.reduce(0) { $0 + Double($1 * $1) } / Double(max(1, mono.count)))
    guard energy > 0.008 else { return }
    regions.append(.init(
      id: "region-\(regions.count)-\(Int((frame.timestamp * 1_000).rounded()))",
      channel: frame.channel,
      startTime: frame.timestamp,
      endTime: frame.timestamp + frame.duration,
      sampleRate: frame.sampleRate,
      samples: mono
    ))
  }

  var values: [MeetingSpeechRegion] { regions }

}
