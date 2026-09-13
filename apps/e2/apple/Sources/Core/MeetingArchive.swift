import Foundation

public enum MeetingArchiveError: LocalizedError {
    case duplicateIdentity, conflictingUpdate, unsupportedVersion

    public var errorDescription: String? {
        switch self {
        case .duplicateIdentity: "This meeting belongs to another notebook."
        case .conflictingUpdate: "A newer version of this transcript is already saved."
        case .unsupportedVersion: "Update Enchiridion to open these meeting notes."
        }
    }
}

/// Device-local transcripts retain their owner even while that account is signed out.
/// A nil owner is the device notebook, never a wildcard for other accounts.
public struct MeetingArchive: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let ownerID: String?
        public var transcript: MeetingTranscript
    }

    public private(set) var version = 1
    public private(set) var entries: [Entry] = []
    public init() {}

    public func transcripts(ownerID: String?) -> [MeetingTranscript] {
        entries.filter { $0.ownerID == ownerID }.map(\.transcript).sorted { $0.startedAt > $1.startedAt }
    }

    public func saving(_ transcript: MeetingTranscript, ownerID: String?) throws -> Self {
        var next = self
        if let index = entries.firstIndex(where: { $0.transcript.id == transcript.id }) {
            let previous = entries[index]
            guard previous.ownerID == ownerID else { throw MeetingArchiveError.duplicateIdentity }
            guard previous.transcript.startedAt == transcript.startedAt,
                  previous.transcript.recordingState != .stopped || transcript.recordingState == .stopped,
                  previous.transcript.suggestions.allSatisfy({ transcript.suggestions.contains($0) }),
                  previous.transcript.segments.allSatisfy({ old in
                      if let value = transcript.segments.first(where: { $0.id == old.id }) {
                          return value == old || (!old.isFinal && value.revision > old.revision)
                      }
                      // Speech recognition may replace a provisional range with a differently
                      // segmented result. Final text is never removable by this path.
                      return !old.isFinal && transcript.segments.contains { value in
                          value.id.stream == old.id.stream && value.revision > old.revision &&
                          value.start < old.end && value.end > old.start
                      }
                  }) else { throw MeetingArchiveError.conflictingUpdate }
            next.entries[index].transcript = transcript
        } else {
            next.entries.append(Entry(ownerID: ownerID, transcript: transcript))
        }
        return next
    }

    public func restored() -> Self {
        var next = self
        next.entries = entries.map { Entry(ownerID: $0.ownerID, transcript: $0.transcript.restored()) }
        return next
    }

    private enum CodingKeys: String, CodingKey { case version, entries }
    public init(from decoder: any Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        version = try value.decode(Int.self, forKey: .version)
        guard version == 1 else { throw MeetingArchiveError.unsupportedVersion }
        entries = try value.decode([Entry].self, forKey: .entries)
        guard Set(entries.map { $0.transcript.id }).count == entries.count else {
            throw MeetingArchiveError.duplicateIdentity
        }
    }
}

/// Separate from the day cache so a calendar refresh cannot replace meeting notes.
public struct MeetingArchivePersistence: Sendable {
    public let url: URL
    public init(url: URL) { self.url = url }

    public func load() throws -> MeetingArchive {
        guard FileManager.default.fileExists(atPath: url.path) else { return MeetingArchive() }
        return try JSONDecoder().decode(MeetingArchive.self, from: Data(contentsOf: url)).restored()
    }

    public func save(_ archive: MeetingArchive) throws {
        let data = try JSONEncoder().encode(archive)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS) || os(watchOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }
}
