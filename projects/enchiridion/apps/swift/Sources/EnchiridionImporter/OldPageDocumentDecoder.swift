// OldPageDocumentDecoder.swift
// EnchiridionImporter
//
// Decodes ONE old-app page's raw Automerge document bytes (the
// `document: Data` column read off the old SQLite `pages` table — see
// `LibraryRepository.decodePage`/`fetchPage`, and `PageSnapshot.document` in
// PageModels.swift — NOT any of the old app's derived SQL projection
// columns) into `DecodedOldPage`, a plain value type with no further
// Automerge dependency.
//
// Ported CONCEPT (not code) from the old app's
// apps/enchiridion/Sources/EnchiridionCore/PageDocument.swift `projection(_:pageID:)`
// / `metadataProjection` / `attributedText` functions — this is deliberately
// a fresh, independent read against the raw `Automerge.Document` API rather
// than a call into that file (this target does not depend on the old app's
// package at all — see OldBuiltInRelations.swift's header for why).
//
// A key simplification verified empirically before writing this (see
// Tests/EnchiridionImporterTests — the "wire shape" tests): because
// `EnchiridionCore.SupertagValue`/`.KnowledgeEdge`/`.PageKind` (the NEW
// app's types) have field-for-field IDENTICAL shapes to their OLD-app
// counterparts, and Swift's compiler-synthesized `Codable` for an enum
// with one unlabeled associated value + a `RawRepresentable` struct with a
// `String` raw value are BOTH deterministic, structural encodings (verified
// against a real `JSONEncoder`, not assumed from memory — see the decoder
// tests), decoding OLD-produced JSON directly into the NEW types via
// `JSONDecoder.enchiridion` (same `.iso8601` date strategy the old app's own
// `JSONDecoder.enchiridion` used) just works — no separate "OldSupertagValue"
// mirror type needed for those three.
import Automerge
import EnchiridionCore
import EnchiridionSync
import Foundation

public enum OldPageDocumentDecoderError: Error, Equatable, Sendable {
  case documentTooLarge
  case invalidSchema
}

/// A `{pageID, label}` page-reference mark payload — mirrors the old app's
/// private `PageReferenceValue` (PageDocument.swift) byte-for-byte (same two
/// `String` fields, same JSON key names via default `CodingKeys`).
private struct OldPageReferenceValue: Decodable {
  var pageID: String
  var label: String
}

public enum OldPageDocumentDecoder {
  public static let maximumDocumentBytes = 20 * 1_024 * 1_024

  /// Old app's page-reference mark name
  /// (`PageDocument.pageReferenceMark`, PageDocument.swift:162).
  public static let pageReferenceMarkName = "__ext__dev.rawkode.enchiridion.page-reference"
  /// Old app's format tag (`PageDocument.format`, PageDocument.swift:157).
  public static let expectedFormat = "enchiridion/page"

  public static func decode(_ snapshot: Data) throws -> DecodedOldPage {
    guard snapshot.count <= maximumDocumentBytes else {
      throw OldPageDocumentDecoderError.documentTooLarge
    }
    let document = try Document(snapshot)

    guard case .Scalar(.String(expectedFormat))? = try document.get(obj: .ROOT, key: "format"),
      case .Scalar(.String(let pageIDRaw))? = try document.get(obj: .ROOT, key: "pageID"),
      case .Object(let titleObject, .Text)? = try document.get(obj: .ROOT, key: "title"),
      case .Object(let bodyObject, .Text)? = try document.get(obj: .ROOT, key: "body")
    else {
      throw OldPageDocumentDecoderError.invalidSchema
    }
    let pageID = PageID(rawValue: pageIDRaw)

    let createdAt: Date
    if case .Scalar(.String(let value))? = try document.get(obj: .ROOT, key: "createdAt"),
      let parsed = Date.fromEnchiridionISO8601(value)
    {
      createdAt = parsed
    } else {
      // Old app always writes `createdAt` at `create(...)` time — an
      // unparseable/missing value means a corrupt or pre-schema-version
      // doc; fall back to the epoch rather than throwing, matching this
      // decoder's general stance of "degrade gracefully, don't abort the
      // whole import batch for one odd page" (the real per-page isolation
      // happens one level up, in `VaultImporter`).
      createdAt = Date(timeIntervalSince1970: 0)
    }

    var deletedAt: Date?
    if case .Scalar(.String(let value))? = try document.get(obj: .ROOT, key: "deletedAt") {
      deletedAt = Date.fromEnchiridionISO8601(value)
    }

    var isPinned = false
    if case .Scalar(.Boolean(let value))? = try document.get(obj: .ROOT, key: "isPinned") {
      isPinned = value
    }

    // `kind` — see this file's header: decoding straight into the NEW
    // app's `PageKind` works because the case/field shapes are identical.
    // Anything this decoder doesn't recognize (a future old-app kind, or a
    // genuinely corrupt value) degrades to `.free` — `PageReencoder` then
    // carries the page's own id forward rather than attempting a
    // deterministic re-derivation it has no basis for.
    var kind: PageKind = .free
    if case .Scalar(.String(let kindJSON))? = try document.get(obj: .ROOT, key: "kind"),
      let data = kindJSON.data(using: .utf8),
      let decodedKind = try? JSONDecoder.enchiridion.decode(PageKind.self, from: data)
    {
      kind = decodedKind
    }

    let title = try document.text(obj: titleObject)
    let body = try document.text(obj: bodyObject)
    let bodyScalarCount = UInt64(body.unicodeScalars.count)

    var marks: [DecodedMark] = []
    for mark in try document.marks(obj: bodyObject) {
      guard mark.start < mark.end, mark.end <= bodyScalarCount else { continue }
      let range = UInt32(mark.start)..<UInt32(mark.end)

      if mark.name == pageReferenceMarkName {
        guard case .String(let json) = mark.value,
          let data = json.data(using: .utf8),
          let payload = try? JSONDecoder().decode(OldPageReferenceValue.self, from: data)
        else { continue }
        marks.append(
          DecodedMark(
            kind: .pageReference(pageID: PageID(rawValue: payload.pageID), label: payload.label),
            range: range
          )
        )
        continue
      }

      if let style = markStyle(forOldName: mark.name) {
        marks.append(DecodedMark(kind: .style(style), range: range))
      } else {
        marks.append(DecodedMark(kind: .unsupported(name: mark.name), range: range))
      }
    }

    var supertagIDs: [SupertagID] = []
    var properties: [SupertagPropertyKey: [SupertagValue]] = [:]

    if case .Object(let metadataObject, .Map)? = try document.get(obj: .ROOT, key: "objectMetadata") {
      if case .Object(let tagsObject, .Map)? = try document.get(obj: metadataObject, key: "tags") {
        for (key, value) in try document.mapEntries(obj: tagsObject) {
          guard case .Scalar(.Boolean(true)) = value else { continue }
          supertagIDs.append(SupertagID(rawValue: key))
        }
      }

      if case .Object(let valuesObject, .Map)? = try document.get(obj: metadataObject, key: "values") {
        for (storageKey, value) in try document.mapEntries(obj: valuesObject) {
          // Old app's `SupertagPropertyKey.storageKey` is
          // `"<supertagID>:<fieldID>"` (SupertagModels.swift) — a bare
          // colon join, NOT the new app's `"property:<tag>:<field>"`
          // format, so this cannot use
          // `EnchiridionCore.SupertagPropertyKey.init?(storageKey:)`.
          guard case .Scalar(.String(let json)) = value,
            let separator = storageKey.firstIndex(of: ":")
          else { continue }
          let key = SupertagPropertyKey(
            supertagID: .init(rawValue: String(storageKey[..<separator])),
            fieldID: .init(rawValue: String(storageKey[storageKey.index(after: separator)...]))
          )
          guard let data = json.data(using: .utf8),
            let decoded = try? JSONDecoder.enchiridion.decode([SupertagValue].self, from: data)
          else { continue }
          properties[key] = decoded
        }
      }
    }

    // Fold decoded edges back into `.page(...)` property values — mirrors
    // the old app's own `metadataProjection` (PageDocument.swift), which
    // does the identical fold at read time. `edge.sourceNodeID` is not
    // checked against `pageID` here for the same reason the old app's own
    // `graphEdges(_:pageID:)` doesn't rely on it either: it force-
    // reassigns `edge.sourceNodeID = pageID` unconditionally when
    // projecting, so every edge under this page's own `edges` map is
    // treated as sourced from this page regardless of what its stored
    // JSON says.
    if case .Object(let edgesObject, .Map)? = try document.get(obj: .ROOT, key: "edges") {
      var relationshipKeys: Set<SupertagPropertyKey> = []
      for (_, value) in try document.mapEntries(obj: edgesObject) {
        guard case .Scalar(.String(let json)) = value,
          let data = json.data(using: .utf8),
          let edge = try? JSONDecoder.enchiridion.decode(KnowledgeEdge.self, from: data),
          let key = OldBuiltInRelations.propertyKey(for: edge.relationID.rawValue)
        else { continue }
        relationshipKeys.insert(key)
        properties[key, default: []].append(.page(edge.targetNodeID))
      }
      for key in relationshipKeys {
        properties[key] = Array(Set(properties[key] ?? [])).sorted { $0.id < $1.id }
      }
    }

    return DecodedOldPage(
      originalPageID: pageID,
      kind: kind,
      title: title,
      body: body,
      marks: marks,
      createdAt: createdAt,
      deletedAt: deletedAt,
      isPinned: isPinned,
      supertagIDs: supertagIDs.sorted { $0.rawValue < $1.rawValue },
      properties: properties
    )
  }

  /// Old app's mark-name constants (`PageDocument.strongMark`/`.emphasisMark`/
  /// `.strikethroughMark`/`.codeMark`, PageDocument.swift:164-167), mapped
  /// onto `LoroEngine.MarkStyle`'s equivalent vocabulary — matches the NEW
  /// app's own `PageDocument`'s identical alias table
  /// (EnchiridionSync/PageDocument.swift:246-249) exactly, so this
  /// decode-side mapping and that re-encode-side mapping agree by
  /// construction.
  static func markStyle(forOldName name: String) -> LoroEngine.MarkStyle? {
    switch name {
    case "strong": return .bold
    case "em": return .italic
    case "strike": return .strikethrough
    case "code": return .code
    default: return nil
    }
  }
}
