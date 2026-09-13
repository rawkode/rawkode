import Foundation

/// A bounded display projection. Caption groups are not completed conversational turns.
public struct VoiceCaptions: Equatable, Sendable {
    public enum Speaker: String, Sendable { case user, assistant }
    public struct Fragment: Equatable, Sendable {
        public let id: String
        public let text: String
        public let startMilliseconds: Double
        public let endMilliseconds: Double
    }
    public struct Row: Identifiable, Equatable, Sendable {
        public let id: String
        public let speaker: Speaker
        public fileprivate(set) var fragments: [Fragment]
        public var text: String { fragments.map(\.text).joined() }
        private var start: Double { fragments.map(\.startMilliseconds).min() ?? 0 }
        private var end: Double { fragments.map(\.endMilliseconds).max() ?? 0 }
        fileprivate func distance(to fragment: Fragment) -> Double {
            max(0, max(start - fragment.endMilliseconds, fragment.startMilliseconds - end))
        }
    }
    public private(set) var rows: [Row] = []
    public private(set) var earlierCaptionsOmitted = false
    public init() {}

    public mutating func receive(_ data: Data) {
        guard data.count <= 32_768,
              let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = event["type"] as? String,
              let id = event["event_id"] as? String, !id.isEmpty, id.count <= 256,
              let text = event["delta"] as? String, !text.isEmpty, text.utf8.count <= 8_192,
              let start = event["start_ms"] as? Double, start.isFinite, start >= 0,
              let end = event["end_ms"] as? Double, end.isFinite, end >= start else { return }
        let speaker: Speaker
        switch type {
        case "session.input_transcript.delta": speaker = .user
        case "session.output_transcript.delta": speaker = .assistant
        default: return
        }
        guard !rows.contains(where: { $0.fragments.contains(where: { $0.id == id }) }) else { return }
        let fragment = Fragment(id: id, text: text, startMilliseconds: start, endMilliseconds: end)
        // Late fragments can update an earlier display row, without moving it or changing its ID.
        let closest = rows.indices.filter { rows[$0].speaker == speaker && rows[$0].distance(to: fragment) <= 1_500 }
            .min { rows[$0].distance(to: fragment) < rows[$1].distance(to: fragment) }
        if let index = closest {
            rows[index].fragments.append(fragment)
            rows[index].fragments = rows[index].fragments.enumerated().sorted {
                $0.element.startMilliseconds == $1.element.startMilliseconds ? $0.offset < $1.offset : $0.element.startMilliseconds < $1.element.startMilliseconds
            }.map(\.element)
        } else {
            rows.append(Row(id: id, speaker: speaker, fragments: [fragment]))
        }
        while rows.count > 100 || rows.reduce(0, { $0 + $1.text.utf8.count }) > 65_536 || rows.reduce(0, { $0 + $1.fragments.count }) > 2_000 {
            earlierCaptionsOmitted = true
            if rows.count > 1 { rows.removeFirst() }
            else { rows[0].fragments.removeFirst() }
        }
    }
}
