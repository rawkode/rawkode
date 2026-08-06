// SyntheticOldVault.swift
// EnchiridionImporterTests
//
// Builds a SMALL SYNTHETIC old-app vault directly against the real
// `Automerge.Document` API — deliberately NOT a real user's data (per the
// task brief) and deliberately NOT a call into the old app's own
// `PageDocument.swift` (this importer target has no dependency on that
// package — see EnchiridionImporter's Package.swift comment). Every
// document shape here is hand-reproduced from having read that file in
// full: root fields (`format`/`schemaVersion`/`pageID`/`kind`/`createdAt`/
// `deletedAt`/`isPinned`), `objectMetadata.tags`/`.values`, `edges`, and
// `title`/`body` Text objects with marks — matching PageDocument.swift's
// `create`/`addSupertag`/`setProperty`/`replaceRichText`/`upsertEdge`
// exactly (see each builder function's comment for its citation).
import Automerge
import EnchiridionCore
import Foundation

enum SyntheticOldPageBuilder {
  /// Matches `PageDocument.format`/`.schemaVersion`
  /// (apps/enchiridion/Sources/EnchiridionCore/PageDocument.swift:157-158).
  static let format = "enchiridion/page"
  static let schemaVersion = 2
  static let pageReferenceMarkName = "__ext__dev.rawkode.enchiridion.page-reference"

  /// Old app's `JSONEncoder.enchiridion` (PageDocument.swift:1575-1582):
  /// `.iso8601` dates, sorted keys, no slash escaping.
  static let jsonEncoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }()

  /// Old app's `Date.enchiridionISO8601` (PageModels.swift): ISO-8601 WITH
  /// fractional seconds — used ONLY for the root `createdAt`/`deletedAt`
  /// scalar strings (never for JSON-embedded dates, which go through
  /// `jsonEncoder`'s plain `.iso8601` strategy instead — see
  /// PageDocument.swift:1090-1092/1077-1081 for `createdAt`'s
  /// production callers versus `KnowledgeEdge.createdAt`'s
  /// `JSONEncoder.enchiridion` callers).
  static func rootISO8601(_ date: Date) -> String {
    date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
  }

  /// Mirrors `PageDocument.create` (PageDocument.swift:174-207).
  static func create(id: String, kind: String, title: String, createdAt: Date) -> Document {
    let document = Document(textEncoding: .unicodeScalar)
    try! document.put(obj: .ROOT, key: "format", value: .String(format))
    try! document.put(obj: .ROOT, key: "schemaVersion", value: .Int(Int64(schemaVersion)))
    try! document.put(obj: .ROOT, key: "pageID", value: .String(id))
    try! document.put(obj: .ROOT, key: "kind", value: .String(kind))
    try! document.put(obj: .ROOT, key: "createdAt", value: .String(rootISO8601(createdAt)))
    try! document.put(obj: .ROOT, key: "deletedAt", value: .Null)
    try! document.put(obj: .ROOT, key: "isPinned", value: .Boolean(false))
    let metadata = try! document.putObject(obj: .ROOT, key: "objectMetadata", ty: .Map)
    try! document.put(obj: metadata, key: "version", value: .Int(1))
    _ = try! document.putObject(obj: metadata, key: "tags", ty: .Map)
    _ = try! document.putObject(obj: metadata, key: "values", ty: .Map)
    _ = try! document.putObject(obj: .ROOT, key: "edges", ty: .Map)
    let titleObject = try! document.putObject(obj: .ROOT, key: "title", ty: .Text)
    try! document.spliceText(obj: titleObject, start: 0, delete: 0, value: title)
    _ = try! document.putObject(obj: .ROOT, key: "body", ty: .Text)
    document.commitWith(message: "Create page", timestamp: createdAt)
    return document
  }

  static func kindJSON(daily day: String) -> String {
    // Matches Swift's real SE-0295 enum-Codable wire shape, empirically
    // verified against a real `JSONEncoder` before writing this fixture
    // builder (single unlabeled associated value -> `{"_0": ...}`; a
    // RawRepresentable<String> associated value encodes as a bare string).
    #"{"daily":{"_0":"\#(day)"}}"#
  }

  static let freeKindJSON = #"{"free":{}}"#

  /// Sets the body text (no marks) — mirrors `replaceBody`
  /// (PageDocument.swift:293-311), simplified for a fresh empty body.
  static func setBody(_ document: Document, text: String) {
    guard case .Object(let bodyObject, .Text)? = try! document.get(obj: .ROOT, key: "body") else {
      fatalError("body object missing")
    }
    try! document.spliceText(obj: bodyObject, start: 0, delete: 0, value: text)
    document.commitWith(message: "Set body", timestamp: Date())
  }

  /// Applies a bold/italic/strike/code-shaped mark over the body — mirrors
  /// `replaceTextAndMarks`'s mark-application loop (PageDocument.swift:1156-1165).
  static func markBody(_ document: Document, name: String, start: UInt64, end: UInt64, value: ScalarValue = .Boolean(true)) {
    guard case .Object(let bodyObject, .Text)? = try! document.get(obj: .ROOT, key: "body") else {
      fatalError("body object missing")
    }
    try! document.mark(obj: bodyObject, start: start, end: end, expand: .both, name: name, value: value)
    document.commitWith(message: "Mark body", timestamp: Date())
  }

  /// Mirrors `PageDocument.pageReferenceMark(to:label:)` (PageDocument.swift:364-375)
  /// applied via `mark`.
  static func markPageReference(_ document: Document, targetPageID: String, label: String, start: UInt64, end: UInt64) {
    struct PageReferenceValue: Encodable {
      var pageID: String
      var label: String
    }
    let payload = try! jsonEncoder.encode(PageReferenceValue(pageID: targetPageID, label: label))
    markBody(
      document, name: pageReferenceMarkName, start: start, end: end,
      value: .String(String(decoding: payload, as: UTF8.self))
    )
  }

  /// Mirrors `PageDocument.addSupertag` (PageDocument.swift:396-403).
  static func addSupertag(_ document: Document, _ supertagID: String) {
    guard case .Object(let metadata, .Map)? = try! document.get(obj: .ROOT, key: "objectMetadata"),
      case .Object(let tags, .Map)? = try! document.get(obj: metadata, key: "tags")
    else { fatalError("objectMetadata/tags missing") }
    try! document.put(obj: tags, key: supertagID, value: .Boolean(true))
    document.commitWith(message: "Add #\(supertagID)", timestamp: Date())
  }

  /// Mirrors `PageDocument.setProperty` for a plain (non-`.page`) value —
  /// PageDocument.swift:417-439's scalar-value branch: JSON-encodes
  /// `[SupertagValue]` and stores it at `"<supertagID>:<fieldID>"`.
  static func setScalarProperty<Value: Encodable>(
    _ document: Document, supertagID: String, fieldID: String, jsonValues: [Value]
  ) {
    guard case .Object(let metadata, .Map)? = try! document.get(obj: .ROOT, key: "objectMetadata"),
      case .Object(let values, .Map)? = try! document.get(obj: metadata, key: "values")
    else { fatalError("objectMetadata/values missing") }
    let data = try! jsonEncoder.encode(jsonValues)
    try! document.put(
      obj: values, key: "\(supertagID):\(fieldID)", value: .String(String(decoding: data, as: UTF8.self))
    )
    document.commitWith(message: "Set \(fieldID)", timestamp: Date())
  }

  /// Mirrors `PageDocument.upsertEdge`/`replaceRelationshipEdges`
  /// (PageDocument.swift:492-509, :1342-1374) — writes one JSON-encoded
  /// `KnowledgeEdge` entry directly into `edges`, keyed by a synthetic edge
  /// id.
  static func addEdge(
    _ document: Document, edgeID: String, relationID: String, sourcePageID: String, targetPageID: String,
    createdAt: Date
  ) {
    guard case .Object(let edges, .Map)? = try! document.get(obj: .ROOT, key: "edges") else {
      fatalError("edges missing")
    }
    // Mirrors the old app's `KnowledgeEdge` field set exactly (id,
    // relationID, sourceNodeID, targetNodeID, origin, createdAt).
    struct OldKnowledgeEdge: Encodable {
      var id: String
      var relationID: String
      var sourceNodeID: String
      var targetNodeID: String
      var origin: String
      var createdAt: Date
    }
    let edge = OldKnowledgeEdge(
      id: edgeID, relationID: relationID, sourceNodeID: sourcePageID, targetNodeID: targetPageID,
      origin: "user", createdAt: createdAt
    )
    let data = try! jsonEncoder.encode(edge)
    try! document.put(obj: edges, key: edgeID, value: .String(String(decoding: data, as: UTF8.self)))
    document.commitWith(message: "Add edge", timestamp: Date())
  }

  static func setPinned(_ document: Document, _ pinned: Bool) {
    try! document.put(obj: .ROOT, key: "isPinned", value: .Boolean(pinned))
    document.commitWith(message: "Pin", timestamp: Date())
  }

  static func setDeleted(_ document: Document, _ deletedAt: Date) {
    try! document.put(obj: .ROOT, key: "deletedAt", value: .String(rootISO8601(deletedAt)))
    document.commitWith(message: "Trash", timestamp: deletedAt)
  }
}

/// Mirrors old app's `JSONEncoder`-visible `SupertagValue` case shapes
/// (`.text(String)`, `.email(String)`, `.select(String)`, ...) for use with
/// `SyntheticOldPageBuilder.setScalarProperty` — a minimal local mirror
/// (this test target could import `EnchiridionCore.SupertagValue` and
/// encode that directly, but spelling these out explicitly keeps the
/// synthetic fixture visibly independent of whatever the NEW app's type
/// happens to look like today, which is the point of a "decode OLD bytes"
/// test).
enum SyntheticSupertagValue: Encodable {
  case text(String)
  case email(String)
  case select(String)
  case number(Double)

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: DynamicKey.self)
    var nested = container.nestedContainer(keyedBy: DynamicKey.self, forKey: .init(stringValue: caseName)!)
    switch self {
    case .text(let value), .email(let value), .select(let value):
      try nested.encode(value, forKey: .init(stringValue: "_0")!)
    case .number(let value):
      try nested.encode(value, forKey: .init(stringValue: "_0")!)
    }
  }

  private var caseName: String {
    switch self {
    case .text: return "text"
    case .email: return "email"
    case .select: return "select"
    case .number: return "number"
    }
  }

  private struct DynamicKey: CodingKey {
    var stringValue: String
    init?(stringValue: String) { self.stringValue = stringValue }
    var intValue: Int? { nil }
    init?(intValue: Int) { nil }
  }
}
