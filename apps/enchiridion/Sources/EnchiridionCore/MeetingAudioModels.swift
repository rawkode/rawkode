import Foundation

/// Audio is ephemeral while a meeting is active. These values deliberately have
/// no URL, filename, or persistence representation.
public enum MeetingAudioChannel: String, Codable, Hashable, Sendable {
  case microphone
  case systemAudio
  /// A time-aligned mono combination of microphone and system audio.
  case mixed
}

/// A timestamped interleaved Float32 PCM block. `samples` is copied at the
/// capture boundary so an AVFoundation/CoreMedia buffer is never retained.
public struct MeetingPCMFrame: Sendable, Hashable {
  public let generation: UInt64
  public let channel: MeetingAudioChannel
  public let timestamp: TimeInterval
  public let sampleRate: Double
  public let channelCount: Int
  public let samples: [Float]

  public init(
    generation: UInt64,
    channel: MeetingAudioChannel,
    timestamp: TimeInterval,
    sampleRate: Double,
    channelCount: Int,
    samples: [Float]
  ) {
    self.generation = generation
    self.channel = channel
    self.timestamp = timestamp
    self.sampleRate = sampleRate
    self.channelCount = channelCount
    self.samples = samples
  }

  public var frameCount: Int { channelCount > 0 ? samples.count / channelCount : 0 }
  public var duration: TimeInterval { sampleRate > 0 ? Double(frameCount) / sampleRate : 0 }
}

public enum MeetingAudioCaptureError: Error, Equatable, Sendable, LocalizedError {
  case microphonePermissionDenied
  case systemAudioPermissionDenied
  case captureInterrupted
  case inputUnavailable
  case revoked
  case unavailable(String)

  public var errorDescription: String? {
    switch self {
    case .microphonePermissionDenied: "Microphone access is required to transcribe this meeting."
    case .systemAudioPermissionDenied: "Screen and system-audio access is required to transcribe call participants."
    case .captureInterrupted: "Meeting transcription stopped because audio capture was interrupted."
    case .inputUnavailable: "No meeting audio input is currently available."
    case .revoked: "Meeting transcription stopped because capture permission was revoked."
    case .unavailable(let message): message
    }
  }
}

/// A capture is one-shot: each call creates a new generation and its stream
/// keeps only the newest blocks when a consumer falls behind.
public protocol MeetingAudioCapturing: Sendable {
  func startCapture() async throws -> AsyncStream<MeetingPCMFrame>
  func stopCapture() async
}

public struct MeetingSpeechRegion: Hashable, Sendable, Identifiable {
  public let id: String
  public let channel: MeetingAudioChannel
  public let startTime: TimeInterval
  public let endTime: TimeInterval
  public let sampleRate: Double
  /// Mono, normalized samples for a VAD-positive region only.
  public let samples: [Float]
  public let overlapsOtherSpeech: Bool

  public init(
    id: String,
    channel: MeetingAudioChannel,
    startTime: TimeInterval,
    endTime: TimeInterval,
    sampleRate: Double,
    samples: [Float],
    overlapsOtherSpeech: Bool = false
  ) {
    self.id = id
    self.channel = channel
    self.startTime = startTime
    self.endTime = endTime
    self.sampleRate = sampleRate
    self.samples = samples
    self.overlapsOtherSpeech = overlapsOtherSpeech
  }
}

public struct MeetingSpeakerAssignment: Hashable, Sendable {
  public static let unknownClusterID = "speaker-unknown"
  public let regionID: String
  public let clusterID: String
  public let confidence: Double
  public let isFrozen: Bool
}

/// Bounded, deterministic time-domain mixer for independently delivered
/// ScreenCaptureKit microphone and system-audio blocks. It holds only a few
/// PCM blocks while waiting for their timestamp peer and emits one mono stream.
public struct MeetingPCMFrameMixer: Sendable {
  public struct Configuration: Hashable, Sendable {
    public var outputSampleRate: Double
    public var skewTolerance: TimeInterval
    public var maximumLatency: TimeInterval
    public var maximumPendingBlocks: Int

    public init(
      outputSampleRate: Double = 48_000,
      skewTolerance: TimeInterval = 0.035,
      maximumLatency: TimeInterval = 0.12,
      maximumPendingBlocks: Int = 8
    ) {
      self.outputSampleRate = max(1, outputSampleRate)
      self.skewTolerance = max(0, skewTolerance)
      self.maximumLatency = max(0, maximumLatency)
      self.maximumPendingBlocks = max(1, maximumPendingBlocks)
    }
  }

  public let configuration: Configuration
  public private(set) var generation: UInt64?
  public private(set) var pendingBlockCount = 0
  private var microphone: [Block] = []
  private var systemAudio: [Block] = []
  private var latestObservedEnd: TimeInterval = -.infinity
  private var lastOutputEnd: TimeInterval = -.infinity

  public init(configuration: Configuration = .init()) { self.configuration = configuration }

  public mutating func reset(generation: UInt64? = nil) {
    self.generation = generation
    microphone.removeAll(keepingCapacity: true)
    systemAudio.removeAll(keepingCapacity: true)
    latestObservedEnd = -.infinity
    lastOutputEnd = -.infinity
    pendingBlockCount = 0
  }

  public mutating func ingest(_ frame: MeetingPCMFrame) -> [MeetingPCMFrame] {
    guard frame.channel == .microphone || frame.channel == .systemAudio,
      let block = normalize(frame)
    else { return [] }
    if generation != frame.generation { reset(generation: frame.generation) }
    guard block.end > lastOutputEnd else { return [] } // discard a late block for an emitted interval
    latestObservedEnd = max(latestObservedEnd, block.end)
    if frame.channel == .microphone {
      var blocks = microphone
      Self.insert(block, into: &blocks)
      microphone = blocks
    } else {
      var blocks = systemAudio
      Self.insert(block, into: &blocks)
      systemAudio = blocks
    }
    updatePendingCount()
    return drain(force: false)
  }

  /// Drains the final bounded tail, substituting silence for a missing peer.
  public mutating func finish() -> [MeetingPCMFrame] { drain(force: true) }

  private mutating func drain(force: Bool) -> [MeetingPCMFrame] {
    var output: [MeetingPCMFrame] = []
    while let earliest = earliestPending() {
      let opposite = earliest.channel == .microphone ? systemAudio : microphone
      let matchIndex = opposite.enumerated()
        .filter { blocksMayAlign(earliest.block, $0.element) }
        .min { abs($0.element.start - earliest.block.start) < abs($1.element.start - earliest.block.start) }?.offset
      if let matchIndex {
        let first = removeEarliest(earliest)
        let second = earliest.channel == .microphone
          ? systemAudio.remove(at: matchIndex) : microphone.remove(at: matchIndex)
        if let mixed = makeOutput([first, second]) { output.append(mixed) }
        updatePendingCount()
        continue
      }
      let exceedsLatency = latestObservedEnd - earliest.block.end >= configuration.maximumLatency
      let exceedsBound = microphone.count + systemAudio.count > configuration.maximumPendingBlocks
      guard force || exceedsLatency || exceedsBound else { break }
      if let mixed = makeOutput([removeEarliest(earliest)]) { output.append(mixed) }
      updatePendingCount()
    }
    return output
  }

  private func blocksMayAlign(_ a: Block, _ b: Block) -> Bool {
    a.start <= b.end + configuration.skewTolerance && b.start <= a.end + configuration.skewTolerance
  }

  private mutating func makeOutput(_ blocks: [Block]) -> MeetingPCMFrame? {
    guard let generation else { return nil }
    let unionStart = blocks.map(\.start).min()!
    let unionEnd = blocks.map(\.end).max()!
    let start = max(unionStart, lastOutputEnd)
    guard unionEnd > start else { return nil }
    // Presentation times are floating point. Round to the nearest complete
    // sample so a one-sample block cannot grow a silent tail through epsilon.
    let sampleCount = max(1, Int(((unionEnd - start) * configuration.outputSampleRate).rounded()))
    var sums = [Float](repeating: 0, count: sampleCount)
    var contributors = [UInt8](repeating: 0, count: sampleCount)
    for block in blocks {
      let offset = Int(((block.start - start) * configuration.outputSampleRate).rounded())
      for (sourceIndex, sample) in block.samples.enumerated() {
        let destination = offset + sourceIndex
        guard destination >= 0, destination < sampleCount else { continue }
        sums[destination] += sample
        contributors[destination] &+= 1
      }
    }
    for index in sums.indices where contributors[index] > 0 {
      sums[index] = max(-1, min(1, sums[index] / Float(contributors[index])))
    }
    let output = MeetingPCMFrame(
      generation: generation,
      channel: .mixed,
      timestamp: start,
      sampleRate: configuration.outputSampleRate,
      channelCount: 1,
      samples: sums
    )
    lastOutputEnd = start + output.duration
    return output
  }

  private func normalize(_ frame: MeetingPCMFrame) -> Block? {
    guard frame.timestamp.isFinite, frame.sampleRate > 0, frame.channelCount > 0, frame.frameCount > 0 else { return nil }
    var mono = [Float](repeating: 0, count: frame.frameCount)
    for index in 0..<frame.frameCount {
      for channel in 0..<frame.channelCount { mono[index] += frame.samples[index * frame.channelCount + channel] }
      mono[index] /= Float(frame.channelCount)
    }
    let outputCount = max(1, Int((frame.duration * configuration.outputSampleRate).rounded()))
    guard outputCount != mono.count || frame.sampleRate != configuration.outputSampleRate else {
      return .init(channel: frame.channel, start: frame.timestamp, samples: mono, sampleRate: configuration.outputSampleRate)
    }
    var resampled = [Float](repeating: 0, count: outputCount)
    for outputIndex in 0..<outputCount {
      let position = Double(outputIndex) * frame.sampleRate / configuration.outputSampleRate
      let lower = min(mono.count - 1, Int(position))
      let upper = min(mono.count - 1, lower + 1)
      let fraction = Float(position - Double(lower))
      resampled[outputIndex] = mono[lower] + (mono[upper] - mono[lower]) * fraction
    }
    return .init(channel: frame.channel, start: frame.timestamp, samples: resampled, sampleRate: configuration.outputSampleRate)
  }

  private static func insert(_ block: Block, into blocks: inout [Block]) {
    let index = blocks.firstIndex { $0.start > block.start } ?? blocks.endIndex
    blocks.insert(block, at: index)
  }

  private func earliestPending() -> (channel: MeetingAudioChannel, block: Block)? {
    switch (microphone.first, systemAudio.first) {
    case let (mic?, system?): mic.start <= system.start ? (.microphone, mic) : (.systemAudio, system)
    case let (mic?, nil): (.microphone, mic)
    case let (nil, system?): (.systemAudio, system)
    case (nil, nil): nil
    }
  }

  private mutating func removeEarliest(_ value: (channel: MeetingAudioChannel, block: Block)) -> Block {
    value.channel == .microphone ? microphone.removeFirst() : systemAudio.removeFirst()
  }

  private mutating func updatePendingCount() { pendingBlockCount = microphone.count + systemAudio.count }

  private struct Block: Sendable {
    let channel: MeetingAudioChannel
    let start: TimeInterval
    let samples: [Float]
    let sampleRate: Double
    var end: TimeInterval { start + Double(samples.count) / sampleRate }

    init(channel: MeetingAudioChannel, start: TimeInterval, samples: [Float], sampleRate: Double) {
      self.channel = channel; self.start = start; self.samples = samples; self.sampleRate = sampleRate
    }
  }
}
