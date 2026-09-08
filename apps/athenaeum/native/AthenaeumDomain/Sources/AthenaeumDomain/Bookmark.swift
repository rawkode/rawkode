import Foundation

// Phase 5 native stage — mirrors `packages/domain/src/bookmark.ts`. See that file's own header
// comment for why `Bookmark` is deliberately the plan's low-complexity Phase 5 companion to
// Calendar: a capture-inbox record with no OAuth/provider dependency at all.

/// Mirrors `bookmark.ts`'s `BookmarkUrl` brand: "an absolute http(s) URL — validated, not
/// normalized." Same validating-wrapper convention as `ShareKeyHash`/`EntityId`/`Email`.
public struct BookmarkUrl: Hashable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let rawValue: String

    /// Matches `bookmark.ts`'s `httpUrlPattern = /^https?:\/\/\S+$/i` exactly.
    private static let pattern = #"^https?://\S+$"#

    public static func isValid(_ value: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return false
        }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.firstMatch(in: value, range: range) != nil
    }

    /// See `EntityId.init(validating:)`'s doc comment for why this is labeled, not `init(_:)`.
    public init(validating rawValue: String) throws {
        guard BookmarkUrl.isValid(rawValue) else {
            throw AthenaeumDomainDecodingError.invalidBookmarkUrl(rawValue)
        }
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        precondition(BookmarkUrl.isValid(value), "BookmarkUrl literal is not an absolute http(s) URL: \(value)")
        self.rawValue = value
    }

    public var description: String { rawValue }
}

extension BookmarkUrl: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard BookmarkUrl.isValid(value) else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "BookmarkUrl must be an absolute http(s) URL, got: \(value)"
            )
        }
        self.rawValue = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Mirrors `bookmark.ts`'s `Bookmark` — a captured bookmark, `{id, workspaceId, url, title?,
/// capturedAt, linkedNodeId?}`. `Schema.Class`, diffed by `schema-diff.ts`.
public struct Bookmark: Codable, Hashable, Sendable {
    public let id: EntityId
    public let workspaceId: EntityId
    public let url: BookmarkUrl
    public let title: String?
    public let capturedAt: IsoDateTimeString
    public let linkedNodeId: EntityId?

    public init(
        id: EntityId,
        workspaceId: EntityId,
        url: BookmarkUrl,
        title: String? = nil,
        capturedAt: IsoDateTimeString,
        linkedNodeId: EntityId? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.url = url
        self.title = title
        self.capturedAt = capturedAt
        self.linkedNodeId = linkedNodeId
    }
}
