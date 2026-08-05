import CryptoKit
import Foundation

/// The permanently frozen identity representation used by bookmark capture v1.
/// Do not change this algorithm: a later normalizer must use a new version rather
/// than re-keying records written with `url-key-v1`.
public struct BookmarkURLKey: Codable, Hashable, Sendable, Identifiable {
  public static let version = "url-key-v1"
  public let canonicalURL: String
  public var id: String { digest }
  public var digest: String {
    SHA256.hash(data: Data((Self.version + "\n" + canonicalURL).utf8))
      .map { String(format: "%02x", $0) }.joined()
  }

  public init?(submittedURL: String) {
    guard let components = URLComponents(string: submittedURL.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
      components.user == nil, components.password == nil,
      let host = components.host, !host.isEmpty
    else { return nil }
    // URLComponents canonicalizes Unicode host names to their ASCII IDNA spelling.
    var normalized = URLComponents()
    normalized.scheme = scheme
    normalized.host = host.lowercased()
    if let port = components.port, !(scheme == "http" && port == 80), !(scheme == "https" && port == 443) {
      normalized.port = port
    }
    normalized.percentEncodedPath = Self.normalizedPercentEncoding(components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath)
    // Query item order, duplicate values, and the fragment are intentional identity input.
    normalized.percentEncodedQuery = components.percentEncodedQuery.map(Self.normalizedPercentEncoding)
    normalized.percentEncodedFragment = components.percentEncodedFragment.map(Self.normalizedPercentEncoding)
    guard let value = normalized.string else { return nil }
    canonicalURL = value
  }

  private static func normalizedPercentEncoding(_ input: String) -> String {
    let unreserved = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
    var output = ""; var index = input.startIndex
    while index < input.endIndex {
      if input[index] == "%", input.distance(from: index, to: input.endIndex) >= 3 {
        let a = input.index(after: index), b = input.index(after: a)
        let hex = String(input[a...b])
        if let byte = UInt8(hex, radix: 16) {
          let scalar = UnicodeScalar(byte)
          if unreserved.contains(scalar) { output.unicodeScalars.append(scalar) }
          else { output += String(format: "%%%02X", byte) }
          index = input.index(after: b); continue
        }
      }
      output.append(input[index]); index = input.index(after: index)
    }
    return output
  }
}

public struct BookmarkCaptureRequest: Sendable, Hashable {
  public let captureID: UUID
  public let submittedURL: String
  public let note: String?
  public let capturedAt: Date
  public let dayKey: DayKey
  public let timeZoneIdentifier: String
  public let source: String
  public let platform: String
  public let vaultID: VaultID
  public init(captureID: UUID, submittedURL: String, note: String? = nil, capturedAt: Date = Date(), dayKey: DayKey, timeZoneIdentifier: String, source: String, platform: String, vaultID: VaultID) {
    self.captureID = captureID; self.submittedURL = submittedURL; self.note = note; self.capturedAt = capturedAt
    self.dayKey = dayKey; self.timeZoneIdentifier = timeZoneIdentifier; self.source = source; self.platform = platform; self.vaultID = vaultID
  }
}

public struct BookmarkCaptureResult: Sendable, Hashable {
  public let pageID: PageID
  public let urlKey: BookmarkURLKey
  public let duplicate: Bool
}

public struct BookmarkIdentityCandidate: Codable, Hashable, Sendable, Identifiable {
  public let urlKey: BookmarkURLKey; public let pageID: PageID
  public var id: String { "bookmark-candidate:\(urlKey.digest):\(pageID.rawValue)" }
}

public struct BookmarkCaptureEvent: Codable, Hashable, Sendable, Identifiable {
  public let captureID: UUID; public let urlKey: BookmarkURLKey; public let submittedURL: String; public let note: String?
  public let capturedAt: Date; public let dayKey: DayKey; public let timeZoneIdentifier: String; public let source: String; public let platform: String; public let vaultID: VaultID
  public var id: UUID { captureID }
}

/// The privacy-minimal, immutable capture fact replicated inside an ordinary Bookmark Page.
/// Presentation-only capture metadata deliberately stays out of this envelope.
public struct BookmarkSyncedCaptureEvent: Codable, Hashable, Sendable, Identifiable {
  public static let version = 1
  public static let maximumEncodedBytes = 2_048
  public static let minimumCaptureTimestamp = Date(timeIntervalSince1970: 946_684_800) // 2000-01-01
  public static let maximumCaptureTimestamp = Date(timeIntervalSince1970: 4_102_444_800) // 2100-01-01

  public let formatVersion: Int
  public let captureID: UUID
  public let urlKey: BookmarkURLKey
  public let submittedURL: String
  public let capturedAt: Date
  public let dayKey: DayKey
  public let timeZoneIdentifier: String

  public var id: UUID { captureID }

  public init(
    captureID: UUID,
    urlKey: BookmarkURLKey,
    submittedURL: String,
    capturedAt: Date,
    dayKey: DayKey,
    timeZoneIdentifier: String
  ) throws {
    formatVersion = Self.version
    self.captureID = captureID
    self.urlKey = urlKey
    self.submittedURL = submittedURL
    self.capturedAt = try Self.normalizedTimestamp(capturedAt)
    self.dayKey = dayKey
    self.timeZoneIdentifier = timeZoneIdentifier
    try validate()
    guard try canonicalData().count <= Self.maximumEncodedBytes else {
      throw BookmarkSyncedCaptureEventError.envelopeTooLarge
    }
  }

  public func canonicalData() throws -> Data {
    try JSONEncoder.enchiridion.encode(self)
  }

  public func validate() throws {
    guard formatVersion == Self.version else { throw BookmarkSyncedCaptureEventError.unsupportedVersion }
    guard BookmarkURLKey(submittedURL: urlKey.canonicalURL) == urlKey else {
      throw BookmarkSyncedCaptureEventError.invalidURLKey
    }
    guard BookmarkURLKey(submittedURL: submittedURL) == urlKey, submittedURL.utf8.count <= 1_024 else {
      throw BookmarkSyncedCaptureEventError.invalidSubmittedURL
    }
    let timestamp = capturedAt.timeIntervalSince1970
    guard timestamp.isFinite,
      capturedAt >= Self.minimumCaptureTimestamp,
      capturedAt < Self.maximumCaptureTimestamp
    else { throw BookmarkSyncedCaptureEventError.invalidTimestamp }
    guard Self.isStrictDayKey(dayKey.rawValue) else { throw BookmarkSyncedCaptureEventError.invalidDayKey }
    guard timeZoneIdentifier.utf8.count <= 128, TimeZone(identifier: timeZoneIdentifier) != nil else {
      throw BookmarkSyncedCaptureEventError.invalidTimeZone
    }
  }

  private static func isStrictDayKey(_ value: String) -> Bool {
    guard value.utf8.count == 10 else { return false }
    let parts = value.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
      let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
      (1...9_999).contains(year), (1...12).contains(month), (1...31).contains(day)
    else { return false }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    guard let date = calendar.date(from: DateComponents(year: year, month: month, day: day)) else {
      return false
    }
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    return components.year == year && components.month == month && components.day == day
  }

  private static func normalizedTimestamp(_ value: Date) throws -> Date {
    let seconds = value.timeIntervalSince1970
    guard seconds.isFinite,
      seconds >= minimumCaptureTimestamp.timeIntervalSince1970,
      seconds < maximumCaptureTimestamp.timeIntervalSince1970
    else { throw BookmarkSyncedCaptureEventError.invalidTimestamp }
    let milliseconds = (seconds * 1_000).rounded()
    guard milliseconds.isFinite, milliseconds >= Double(Int64.min), milliseconds <= Double(Int64.max) else {
      throw BookmarkSyncedCaptureEventError.invalidTimestamp
    }
    return Date(timeIntervalSince1970: TimeInterval(Int64(milliseconds)) / 1_000)
  }

  private var capturedAtMilliseconds: Int64 {
    Int64((capturedAt.timeIntervalSince1970 * 1_000).rounded())
  }

  private enum CodingKeys: String, CodingKey {
    case formatVersion, captureID, urlKey, submittedURL, capturedAtMilliseconds, dayKey, timeZoneIdentifier
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    formatVersion = try container.decode(Int.self, forKey: .formatVersion)
    let rawID = try container.decode(String.self, forKey: .captureID)
    guard let parsedID = UUID(uuidString: rawID), parsedID.uuidString.lowercased() == rawID else {
      throw BookmarkSyncedCaptureEventError.invalidCaptureID
    }
    captureID = parsedID
    urlKey = try container.decode(BookmarkURLKey.self, forKey: .urlKey)
    submittedURL = try container.decode(String.self, forKey: .submittedURL)
    capturedAt = try Self.normalizedTimestamp(
      Date(timeIntervalSince1970: TimeInterval(try container.decode(Int64.self, forKey: .capturedAtMilliseconds)) / 1_000)
    )
    dayKey = try container.decode(DayKey.self, forKey: .dayKey)
    timeZoneIdentifier = try container.decode(String.self, forKey: .timeZoneIdentifier)
    try validate()
    guard try canonicalData().count <= Self.maximumEncodedBytes else {
      throw BookmarkSyncedCaptureEventError.envelopeTooLarge
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(formatVersion, forKey: .formatVersion)
    try container.encode(captureID.uuidString.lowercased(), forKey: .captureID)
    try container.encode(urlKey, forKey: .urlKey)
    try container.encode(submittedURL, forKey: .submittedURL)
    try container.encode(capturedAtMilliseconds, forKey: .capturedAtMilliseconds)
    try container.encode(dayKey, forKey: .dayKey)
    try container.encode(timeZoneIdentifier, forKey: .timeZoneIdentifier)
  }
}

public enum BookmarkSyncedCaptureEventError: Error, Equatable, Sendable {
  case unsupportedVersion, invalidCaptureID, invalidURLKey, invalidSubmittedURL
  case invalidTimestamp, invalidDayKey, invalidTimeZone, envelopeTooLarge
}

/// A privacy-minimal, immutable URL-identity suppression fact. It intentionally carries no URL
/// text or Page/user content, so a retained carrier can suppress re-creation without retaining it.
public struct BookmarkIdentityDeletionEnvelope: Codable, Hashable, Sendable, Identifiable {
  public static let version = 1
  public static let urlKeyVersion = BookmarkURLKey.version
  public static let maximumEncodedBytes = 1_024

  public let formatVersion: Int
  public let deletionID: UUID
  public let urlKeyVersion: String
  public let urlKeyDigest: String
  public let deletedAt: Date

  public var id: UUID { deletionID }

  public init(deletionID: UUID, urlKeyDigest: String, deletedAt: Date) throws {
    formatVersion = Self.version
    self.deletionID = deletionID
    urlKeyVersion = Self.urlKeyVersion
    self.urlKeyDigest = urlKeyDigest
    self.deletedAt = try Self.normalizedTimestamp(deletedAt)
    try validate()
    guard try canonicalData().count <= Self.maximumEncodedBytes else {
      throw BookmarkIdentityDeletionEnvelopeError.envelopeTooLarge
    }
  }

  public func validate() throws {
    guard formatVersion == Self.version else { throw BookmarkIdentityDeletionEnvelopeError.unsupportedVersion }
    guard urlKeyVersion == Self.urlKeyVersion else { throw BookmarkIdentityDeletionEnvelopeError.invalidURLKeyVersion }
    guard urlKeyDigest.count == 64,
      urlKeyDigest.unicodeScalars.allSatisfy({ "0123456789abcdef".unicodeScalars.contains($0) })
    else { throw BookmarkIdentityDeletionEnvelopeError.invalidURLKeyDigest }
    let seconds = deletedAt.timeIntervalSince1970
    guard seconds.isFinite,
      deletedAt >= BookmarkSyncedCaptureEvent.minimumCaptureTimestamp,
      deletedAt < BookmarkSyncedCaptureEvent.maximumCaptureTimestamp
    else { throw BookmarkIdentityDeletionEnvelopeError.invalidTimestamp }
  }

  public func canonicalData() throws -> Data { try JSONEncoder.enchiridion.encode(self) }

  private static func normalizedTimestamp(_ value: Date) throws -> Date {
    let seconds = value.timeIntervalSince1970
    guard seconds.isFinite,
      seconds >= BookmarkSyncedCaptureEvent.minimumCaptureTimestamp.timeIntervalSince1970,
      seconds < BookmarkSyncedCaptureEvent.maximumCaptureTimestamp.timeIntervalSince1970
    else { throw BookmarkIdentityDeletionEnvelopeError.invalidTimestamp }
    let milliseconds = (seconds * 1_000).rounded()
    guard milliseconds.isFinite, milliseconds >= Double(Int64.min), milliseconds <= Double(Int64.max) else {
      throw BookmarkIdentityDeletionEnvelopeError.invalidTimestamp
    }
    return Date(timeIntervalSince1970: TimeInterval(Int64(milliseconds)) / 1_000)
  }

  private var deletedAtMilliseconds: Int64 {
    Int64((deletedAt.timeIntervalSince1970 * 1_000).rounded())
  }

  private enum CodingKeys: String, CodingKey {
    case formatVersion, deletionID, urlKeyVersion, urlKeyDigest, deletedAtMilliseconds
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    formatVersion = try container.decode(Int.self, forKey: .formatVersion)
    let rawID = try container.decode(String.self, forKey: .deletionID)
    guard let parsed = UUID(uuidString: rawID), parsed.uuidString.lowercased() == rawID else {
      throw BookmarkIdentityDeletionEnvelopeError.invalidDeletionID
    }
    deletionID = parsed
    urlKeyVersion = try container.decode(String.self, forKey: .urlKeyVersion)
    urlKeyDigest = try container.decode(String.self, forKey: .urlKeyDigest)
    deletedAt = try Self.normalizedTimestamp(
      Date(timeIntervalSince1970: TimeInterval(try container.decode(Int64.self, forKey: .deletedAtMilliseconds)) / 1_000)
    )
    try validate()
    guard try canonicalData().count <= Self.maximumEncodedBytes else {
      throw BookmarkIdentityDeletionEnvelopeError.envelopeTooLarge
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(formatVersion, forKey: .formatVersion)
    try container.encode(deletionID.uuidString.lowercased(), forKey: .deletionID)
    try container.encode(urlKeyVersion, forKey: .urlKeyVersion)
    try container.encode(urlKeyDigest, forKey: .urlKeyDigest)
    try container.encode(deletedAtMilliseconds, forKey: .deletedAtMilliseconds)
  }
}

public enum BookmarkIdentityDeletionEnvelopeError: Error, Equatable, Sendable {
  case unsupportedVersion, invalidDeletionID, invalidURLKeyVersion, invalidURLKeyDigest
  case invalidTimestamp, envelopeTooLarge
}

public struct BookmarkIdentityDeletion: Codable, Hashable, Sendable, Identifiable {
  public let deletionID: UUID; public let urlKey: BookmarkURLKey
  public var id: String { "bookmark-deletion:\(urlKey.digest):\(deletionID.uuidString.lowercased())" }
}

public struct BookmarkAliasSuggestion: Sendable, Hashable, Identifiable {
  public let urlKey: BookmarkURLKey; public let winner: PageID; public let alias: PageID
  public var id: String { "\(urlKey.digest):\(alias.rawValue)" }
}
