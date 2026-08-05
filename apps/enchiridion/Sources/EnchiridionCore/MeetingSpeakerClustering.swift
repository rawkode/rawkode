import Foundation

/// Deterministic, best-effort clustering for VAD-positive speech spans. It is
/// intentionally not identity recognition: callers may later assign a cluster
/// to a Person page, and frozen assignments are never reconsidered.
public struct MeetingSpeakerClusterer: Sendable {
  public static let algorithm = "logmel-pitch-vad-cluster"
  public static let algorithmVersion = "1"

  public init() {}

  public func assign(
    _ regions: [MeetingSpeechRegion],
    frozenAssignments: [String: String] = [:]
  ) -> [MeetingSpeakerAssignment] {
    var clusters: [Cluster] = []
    var assignments: [MeetingSpeakerAssignment] = []
    for region in regions.sorted(by: { ($0.startTime, $0.id) < ($1.startTime, $1.id) }) {
      if let frozen = frozenAssignments[region.id] {
        assignments.append(.init(regionID: region.id, clusterID: frozen, confidence: 1, isFrozen: true))
        continue
      }
      guard !region.overlapsOtherSpeech, let feature = feature(for: region) else {
        assignments.append(.init(regionID: region.id, clusterID: MeetingSpeakerAssignment.unknownClusterID, confidence: 0, isFrozen: false))
        continue
      }
      let candidates = clusters.enumerated().filter { $0.element.channel == region.channel }
      let nearest = candidates.min { distance(feature, $0.element.centroid) < distance(feature, $1.element.centroid) }
      if let nearest {
        let d = distance(feature, nearest.element.centroid)
        // Conservative: low-margin or acoustically distant spans remain Unknown.
        let confidence = max(0, min(1, 1 - d / 2.2))
        if d <= 0.95, confidence >= 0.57 {
          clusters[nearest.offset].include(feature)
          assignments.append(.init(regionID: region.id, clusterID: clusters[nearest.offset].id, confidence: confidence, isFrozen: false))
          continue
        }
      }
      let id = "speaker-\(Self.algorithmVersion)-\(region.channel.rawValue)-\(clusters.filter { $0.channel == region.channel }.count + 1)"
      clusters.append(.init(id: id, channel: region.channel, centroid: feature))
      assignments.append(.init(regionID: region.id, clusterID: id, confidence: 0.75, isFrozen: false))
    }
    return assignments
  }

  private func feature(for region: MeetingSpeechRegion) -> [Double]? {
    let samples = region.samples
    guard region.sampleRate > 0, samples.count >= 256 else { return nil }
    let decimation = max(1, samples.count / 1_024)
    let x: [Float] = decimation == 1 ? samples : Swift.stride(from: 0, to: samples.count, by: decimation).map { samples[$0] }
    guard x.count >= 128 else { return nil }
    let energy = sqrt(x.reduce(0) { $0 + Double($1 * $1) } / Double(x.count))
    guard energy > 0.003 else { return nil }
    let mean = x.reduce(0) { $0 + Double($1) } / Double(x.count)
    let centered = x.map { Double($0) - mean }
    var zeroCrossings = 0
    for index in 1..<centered.count where (centered[index - 1] < 0) != (centered[index] < 0) {
      zeroCrossings += 1
    }
    let envelope = spectralEnvelope(centered, sampleRate: region.sampleRate * Double(decimation))
    let pitch = estimatePitch(centered, sampleRate: region.sampleRate * Double(decimation))
    // Compact normalized log-mel-like envelope proxies plus pitch/voicing.
    return [
      max(-2, min(2, (log(energy) + 3.5) / 1.5)),
      max(-2, min(2, Double(zeroCrossings) / Double(max(1, centered.count - 1)) / 0.15)),
      max(-2, min(2, log((envelope.low + 0.000_001) / (envelope.mid + 0.000_001)) / 2)),
      max(-2, min(2, log((envelope.mid + 0.000_001) / (envelope.high + 0.000_001)) / 2)),
      pitch.map { max(-2, min(2, log($0 / 160) / 0.5)) } ?? 0,
      pitch == nil ? 0 : 1,
    ]
  }

  private func spectralEnvelope(_ x: [Double], sampleRate: Double) -> (low: Double, mid: Double, high: Double) {
    // A small, fixed-bin DFT is cheap for short VAD regions and avoids an
    // Accelerate dependency in Core. The three bands act like coarse log-mel
    // coefficients rather than an identity-bearing voice print.
    let n = min(512, x.count)
    guard n >= 64, sampleRate > 0 else { return (0, 0, 0) }
    let signal = Array(x.prefix(n))
    var low = 0.0, mid = 0.0, high = 0.0
    for bin in 1...min(96, n / 2 - 1) {
      let frequency = Double(bin) * sampleRate / Double(n)
      guard frequency >= 80, frequency <= 4_000 else { continue }
      var real = 0.0, imaginary = 0.0
      for index in 0..<n {
        let phase = 2 * Double.pi * Double(bin * index) / Double(n)
        real += signal[index] * cos(phase)
        imaginary -= signal[index] * sin(phase)
      }
      let power = real * real + imaginary * imaginary
      if frequency < 400 { low += power } else if frequency < 1_800 { mid += power } else { high += power }
    }
    return (low, mid, high)
  }

  private func estimatePitch(_ x: [Double], sampleRate: Double) -> Double? {
    let minLag = max(1, Int(sampleRate / 340))
    let maxLag = min(x.count / 2, Int(sampleRate / 75))
    guard minLag < maxLag else { return nil }
    let energy = x.reduce(0) { $0 + $1 * $1 }
    guard energy > 0 else { return nil }
    var best: (lag: Int, score: Double)?
    for lag in stride(from: minLag, through: maxLag, by: max(1, (maxLag - minLag) / 96)) {
      var value = 0.0
      for i in 0..<(x.count - lag) { value += x[i] * x[i + lag] }
      let score = value / energy
      if best == nil || score > best!.score { best = (lag, score) }
    }
    guard let best, best.score >= 0.12 else { return nil }
    return sampleRate / Double(best.lag)
  }

  private func distance(_ a: [Double], _ b: [Double]) -> Double {
    sqrt(zip(a, b).reduce(0) { $0 + pow($1.0 - $1.1, 2) })
  }

  private struct Cluster {
    let id: String
    let channel: MeetingAudioChannel
    var centroid: [Double]
    var count = 1
    mutating func include(_ value: [Double]) {
      count += 1
      centroid = zip(centroid, value).map { $0 + ($1 - $0) / Double(count) }
    }
  }
}
