import Foundation

public enum MeetingTranscriptError: Error, Equatable {
    case invalidSegment, conflictingRevision, finalizedSegment, invalidTransition, participantsNotInformed, invalidSource
}

/// A provider item ID is scoped to one stream so reconnects cannot collide.
public struct MeetingSegmentID: Codable, Hashable, Sendable {
    public let stream: UUID
    public let item: String
    public init(stream: UUID, item: String) { self.stream = stream; self.item = item }
}

public struct MeetingTranscriptSegment: Codable, Equatable, Sendable {
    public let id: MeetingSegmentID
    public let revision: Int
    /// Seconds from the meeting's start, never wall-clock arrival time.
    public let start: TimeInterval
    public let end: TimeInterval
    public let text: String
    public let isFinal: Bool

    public init(id: MeetingSegmentID, revision: Int, start: TimeInterval, end: TimeInterval, text: String, isFinal: Bool) throws {
        guard !id.item.isEmpty, revision >= 0, start.isFinite, end.isFinite, start >= 0, end >= start else {
            throw MeetingTranscriptError.invalidSegment
        }
        self.id = id; self.revision = revision; self.start = start; self.end = end; self.text = text; self.isFinal = isFinal
    }

    private enum CodingKeys: String, CodingKey { case id, revision, start, end, text, isFinal }
    public init(from decoder: any Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(id: value.decode(MeetingSegmentID.self, forKey: .id), revision: value.decode(Int.self, forKey: .revision),
            start: value.decode(TimeInterval.self, forKey: .start), end: value.decode(TimeInterval.self, forKey: .end),
            text: value.decode(String.self, forKey: .text), isFinal: value.decode(Bool.self, forKey: .isFinal))
    }
}

public struct MeetingSource: Codable, Equatable, Sendable {
    public let segment: MeetingSegmentID
    public let quote: String
    public init(segment: MeetingSegmentID, quote: String) { self.segment = segment; self.quote = quote }
}

/// A suggestion is not a task or accepted fact. Reviewing or publishing is a UI concern.
public struct MeetingSuggestion: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case summary, action }
    public let kind: Kind
    public let text: String
    public let sources: [MeetingSource]
    public init(kind: Kind, text: String, sources: [MeetingSource]) {
        self.kind = kind; self.text = text; self.sources = sources
    }
}

/// Pure document state. No microphone, network, scheduling, or task creation side effects.
public struct MeetingTranscript: Codable, Equatable, Sendable {
    public enum RecordingState: String, Codable, Sendable { case ready, recording, interrupted, stopped }
    public let id: UUID
    public let startedAt: Date
    public private(set) var recordingState: RecordingState = .ready
    public private(set) var segments: [MeetingTranscriptSegment] = []
    /// User writing stays separate from recognition revisions and generated suggestions.
    public var note: String = ""
    public private(set) var suggestions: [MeetingSuggestion] = []

    public init(id: UUID = UUID(), startedAt: Date = .now) { self.id = id; self.startedAt = startedAt }

    private enum CodingKeys: String, CodingKey { case id, startedAt, recordingState, segments, note, suggestions }
    public init(from decoder: any Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try value.decode(UUID.self, forKey: .id), startedAt: try value.decode(Date.self, forKey: .startedAt))
        recordingState = try value.decode(RecordingState.self, forKey: .recordingState)
        note = try value.decode(String.self, forKey: .note)
        let storedSegments = try value.decode([MeetingTranscriptSegment].self, forKey: .segments)
        guard Set(storedSegments.map(\.id)).count == storedSegments.count else { throw MeetingTranscriptError.conflictingRevision }
        for segment in storedSegments { try receive(segment) }
        for suggestion in try value.decode([MeetingSuggestion].self, forKey: .suggestions) { try propose(suggestion) }
    }

    public mutating func start(participantsInformed: Bool) throws {
        guard recordingState == .ready || recordingState == .interrupted else { throw MeetingTranscriptError.invalidTransition }
        guard participantsInformed else { throw MeetingTranscriptError.participantsNotInformed }
        recordingState = .recording
    }
    public mutating func interrupt() throws {
        guard recordingState == .recording else { throw MeetingTranscriptError.invalidTransition }
        recordingState = .interrupted
    }
    public mutating func stop() throws {
        guard recordingState == .recording || recordingState == .interrupted else { throw MeetingTranscriptError.invalidTransition }
        recordingState = .stopped
    }

    /// Delayed final results can arrive after stop. Replays are idempotent; final text is immutable.
    public mutating func receive(_ segment: MeetingTranscriptSegment) throws {
        if let index = segments.firstIndex(where: { $0.id == segment.id }) {
            let previous = segments[index]
            if previous == segment || segment.revision < previous.revision { return }
            guard previous.revision != segment.revision else { throw MeetingTranscriptError.conflictingRevision }
            guard !previous.isFinal else { throw MeetingTranscriptError.finalizedSegment }
            segments[index] = segment
        } else {
            segments.append(segment)
        }
        segments.sort {
            if $0.start != $1.start { return $0.start < $1.start }
            if $0.id.stream != $1.id.stream { return $0.id.stream.uuidString < $1.id.stream.uuidString }
            return $0.id.item < $1.id.item
        }
    }

    /// Apple can replace a volatile audio range with differently segmented results.
    /// Replace whole overlapping provisional passages; never splice text by guessed word timing.
    public mutating func reconcileRecognition(_ segment: MeetingTranscriptSegment) throws {
        if segments.contains(segment) { return }
        let previousRevision = segments.filter { $0.id.stream == segment.id.stream }.map(\.revision).max() ?? -1
        guard segment.revision > previousRevision else { throw MeetingTranscriptError.conflictingRevision }
        var next = self
        next.segments.removeAll {
            !$0.isFinal && $0.id.stream == segment.id.stream &&
            ($0.id == segment.id || ($0.start < segment.end && segment.start < $0.end))
        }
        try next.receive(segment)
        self = next
    }

    public mutating func propose(_ suggestion: MeetingSuggestion) throws {
        guard !suggestion.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !suggestion.sources.isEmpty,
              suggestion.sources.allSatisfy({ source in
                  !source.quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                  segments.contains { $0.id == source.segment && $0.isFinal && $0.text.contains(source.quote) }
              }) else { throw MeetingTranscriptError.invalidSource }
        if !suggestions.contains(suggestion) { suggestions.append(suggestion) }
    }

    /// Restore crashes as interrupted; persisted recording state must never imply an active microphone.
    public func restored() -> Self {
        var result = self
        if result.recordingState == .recording { result.recordingState = .interrupted }
        return result
    }
}
