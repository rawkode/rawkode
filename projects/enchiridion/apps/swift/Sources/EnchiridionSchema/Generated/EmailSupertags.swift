// GENERATED — DO NOT EDIT BY HAND.
//
// Produced by `packages/codegen`'s `generateSwiftSchema()` (packages/codegen/src/index.ts)
// from the `dev.rawkode.enchiridion.email` supertag module (see `supertags/*`). Regenerate with:
//
//   bun run --cwd packages/codegen generate
//
// which writes every registered module's output into
// apps/swift/Sources/EnchiridionSchema/Generated/ (packages/codegen/scripts/generate.ts).
// See apps/swift/Sources/EnchiridionSchema/README.md and the plan's §Supertag module
// contract ("Swift learns the schema at runtime first ... The generated
// EnchiridionSchema ... is a compile-time convenience layered on top, not a
// prerequisite.").

import EnchiridionCore
import Foundation

/// Field ID constants `dev.rawkode.enchiridion.email.emailThread` (`Email Thread`) declares itself — does NOT include
/// inherited fields (see `EmailEmailthreadFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum EmailEmailthreadFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.email.emailThread")

  public static let subject = SupertagFieldID(rawValue: "subject")
  public static let labels = SupertagFieldID(rawValue: "labels")
  public static let snippet = SupertagFieldID(rawValue: "snippet")
  public static let lastmessageat = SupertagFieldID(rawValue: "lastMessageAt")
  public static let messagecount = SupertagFieldID(rawValue: "messageCount")
  public static let from = SupertagFieldID(rawValue: "from")
  public static let to = SupertagFieldID(rawValue: "to")
  public static let cc = SupertagFieldID(rawValue: "cc")
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.email.emailThread`
/// (`Email Thread`) — includes Email Thread's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct EmailEmailthreadFields: Hashable, Sendable {
  public static let supertagID = EmailEmailthreadFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var subject: String? {
    get { SupertagFieldStorage.readText(metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.subject) }
    set { SupertagFieldStorage.writeText(&metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.subject, newValue) }
  }

  public var labels: [String] {
    get { SupertagFieldStorage.readTextArray(metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.labels) }
    set { SupertagFieldStorage.writeTextArray(&metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.labels, newValue) }
  }

  public var snippet: String? {
    get { SupertagFieldStorage.readText(metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.snippet) }
    set { SupertagFieldStorage.writeText(&metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.snippet, newValue) }
  }

  public var lastmessageat: Date? {
    get { SupertagFieldStorage.readDateTime(metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.lastmessageat) }
    set { SupertagFieldStorage.writeDateTime(&metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.lastmessageat, newValue) }
  }

  public var messagecount: Double? {
    get { SupertagFieldStorage.readNumber(metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.messagecount) }
    set { SupertagFieldStorage.writeNumber(&metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.messagecount, newValue) }
  }

  public var from: [PageID] {
    get { SupertagFieldStorage.readPageArray(metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.from) }
    set { SupertagFieldStorage.writePageArray(&metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.from, newValue) }
  }

  public var to: [PageID] {
    get { SupertagFieldStorage.readPageArray(metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.to) }
    set { SupertagFieldStorage.writePageArray(&metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.to, newValue) }
  }

  public var cc: [PageID] {
    get { SupertagFieldStorage.readPageArray(metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.cc) }
    set { SupertagFieldStorage.writePageArray(&metadata, EmailEmailthreadFieldIDs.supertagID, EmailEmailthreadFieldIDs.cc, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.email.emailThread` (`Email Thread`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct EmailEmailthread: Codable, Hashable, Sendable {
  public var id: PageID
  public var subject: String?
  public var labels: [String]
  public var snippet: String?
  public var lastmessageat: Date?
  public var messagecount: Double?
  public var from: [PageID]
  public var to: [PageID]
  public var cc: [PageID]

  public init(
    id: PageID,
    subject: String? = nil,
    labels: [String] = [],
    snippet: String? = nil,
    lastmessageat: Date? = nil,
    messagecount: Double? = nil,
    from: [PageID] = [],
    to: [PageID] = [],
    cc: [PageID] = []
  ) {
    self.id = id
    self.subject = subject
    self.labels = labels
    self.snippet = snippet
    self.lastmessageat = lastmessageat
    self.messagecount = messagecount
    self.from = from
    self.to = to
    self.cc = cc
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case subject = "subject"
    case labels = "labels"
    case snippet = "snippet"
    case lastmessageat = "lastmessageat"
    case messagecount = "messagecount"
    case from = "from"
    case to = "to"
    case cc = "cc"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.subject = try container.decodeIfPresent(String.self, forKey: .subject)
    self.labels = try container.decodeIfPresent([String].self, forKey: .labels) ?? []
    self.snippet = try container.decodeIfPresent(String.self, forKey: .snippet)
    self.lastmessageat = (try container.decodeIfPresent(Double.self, forKey: .lastmessageat)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.messagecount = try container.decodeIfPresent(Double.self, forKey: .messagecount)
    self.from = (try container.decodeIfPresent([String].self, forKey: .from) ?? []).map { PageID(rawValue: $0) }
    self.to = (try container.decodeIfPresent([String].self, forKey: .to) ?? []).map { PageID(rawValue: $0) }
    self.cc = (try container.decodeIfPresent([String].self, forKey: .cc) ?? []).map { PageID(rawValue: $0) }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encodeIfPresent(subject, forKey: .subject)
    try container.encode(labels, forKey: .labels)
    try container.encodeIfPresent(snippet, forKey: .snippet)
    try container.encodeIfPresent(lastmessageat.map { $0.timeIntervalSince1970 * 1000 }, forKey: .lastmessageat)
    try container.encodeIfPresent(messagecount, forKey: .messagecount)
    try container.encode(from.map { $0.rawValue }, forKey: .from)
    try container.encode(to.map { $0.rawValue }, forKey: .to)
    try container.encode(cc.map { $0.rawValue }, forKey: .cc)
  }
}
