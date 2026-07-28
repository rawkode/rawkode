import Automerge
import Foundation

public enum PageDocumentError: Error, LocalizedError, Equatable {
  case documentTooLarge
  case invalidSchema
  case invalidHeads

  public var errorDescription: String? {
    switch self {
    case .documentTooLarge: "The page exceeds the 20 MiB document limit."
    case .invalidSchema: "The page has an unsupported Automerge schema."
    case .invalidHeads: "The editor commit does not match its advertised Automerge heads."
    }
  }
}

public struct PageDocumentProjection: Hashable, Sendable {
  public var title: String
  public var plainText: String
  public var deletedAt: Date?
  public var isPinned: Bool
  public var references: [PageReference]
  public var objectMetadata: PageObjectMetadata
}

public enum PageDocument {
  public static let format = "enchiridion/page"
  public static let schemaVersion = 1
  public static let maximumDocumentBytes = 20 * 1_024 * 1_024
  public static let maximumChangeBytes = 1 * 1_024 * 1_024
  public static let pageReferenceMark = "__ext__dev.rawkode.enchiridion.page-reference"

  public static func create(
    id: PageID,
    kind: PageKind,
    title: String,
    createdAt: Date
  ) throws -> (document: Data, heads: AutomergeHeads) {
    let document = Document(textEncoding: .unicodeScalar)
    try document.put(obj: .ROOT, key: "format", value: .String(format))
    try document.put(obj: .ROOT, key: "schemaVersion", value: .Int(Int64(schemaVersion)))
    try document.put(obj: .ROOT, key: "pageID", value: .String(id.rawValue))
    let kindData = try JSONEncoder.enchiridion.encode(kind)
    try document.put(
      obj: .ROOT,
      key: "kind",
      value: .String(String(decoding: kindData, as: UTF8.self))
    )
    try document.put(
      obj: .ROOT,
      key: "createdAt",
      value: .String(createdAt.enchiridionISO8601)
    )
    try document.put(obj: .ROOT, key: "deletedAt", value: .Null)
    try document.put(obj: .ROOT, key: "isPinned", value: .Boolean(false))
    let metadata = try document.putObject(obj: .ROOT, key: "objectMetadata", ty: .Map)
    try document.put(obj: metadata, key: "version", value: .Int(1))
    _ = try document.putObject(obj: metadata, key: "tags", ty: .Map)
    _ = try document.putObject(obj: metadata, key: "values", ty: .Map)
    let titleObject = try document.putObject(obj: .ROOT, key: "title", ty: .Text)
    try document.spliceText(obj: titleObject, start: 0, delete: 0, value: title)
    _ = try document.putObject(obj: .ROOT, key: "body", ty: .Text)
    document.commitWith(message: "Create page", timestamp: createdAt)
    return (document.save(), heads(document))
  }

  public static func applyChanges(
    to snapshot: Data,
    encodedChanges: Data,
    advertisedHeads: AutomergeHeads
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    guard snapshot.count <= maximumDocumentBytes,
      encodedChanges.count <= maximumChangeBytes
    else { throw PageDocumentError.documentTooLarge }
    let document = try Document(snapshot)
    try validate(document)
    try document.applyEncodedChanges(encoded: encodedChanges)
    let result = document.save()
    guard result.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    let resultingHeads = heads(document)
    guard advertisedHeads.values.isEmpty || advertisedHeads == resultingHeads else {
      throw PageDocumentError.invalidHeads
    }
    return (result, resultingHeads, try projection(document))
  }

  public static func merge(
    local: Data,
    remote: Data,
    pageID: PageID
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    guard local.count <= maximumDocumentBytes, remote.count <= maximumDocumentBytes else {
      throw PageDocumentError.documentTooLarge
    }
    let localDocument = try Document(local)
    let remoteDocument = try Document(remote)
    try validate(localDocument)
    try validate(remoteDocument)
    try localDocument.merge(other: remoteDocument)
    return (
      localDocument.save(),
      heads(localDocument),
      try projection(localDocument, pageID: pageID)
    )
  }

  public static func setPinned(
    _ pinned: Bool,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    try document.put(obj: .ROOT, key: "isPinned", value: .Boolean(pinned))
    document.commitWith(message: pinned ? "Pin page" : "Unpin page", timestamp: Date())
    return (document.save(), heads(document), try projection(document))
  }

  public static func setDeleted(
    _ deletedAt: Date?,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    if let deletedAt {
      try document.put(
        obj: .ROOT,
        key: "deletedAt",
        value: .String(deletedAt.enchiridionISO8601)
      )
    } else {
      try document.put(obj: .ROOT, key: "deletedAt", value: .Null)
    }
    document.commitWith(message: deletedAt == nil ? "Restore page" : "Move page to Trash", timestamp: Date())
    return (document.save(), heads(document), try projection(document))
  }

  public static func replaceBody(
    with body: String,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    guard case .Object(let bodyObject, .Text)? = try document.get(obj: .ROOT, key: "body") else {
      throw PageDocumentError.invalidSchema
    }
    let current = try document.text(obj: bodyObject)
    try document.spliceText(
      obj: bodyObject,
      start: 0,
      delete: Int64(current.unicodeScalars.count),
      value: body
    )
    document.commitWith(message: "Replace page body", timestamp: Date())
    return (document.save(), heads(document), try projection(document))
  }

  public static func addSupertag(
    _ supertagID: SupertagID,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    try mutateMetadata(in: snapshot, message: "Add #\(supertagID.rawValue)") { document, tags, _ in
      try document.put(obj: tags, key: supertagID.rawValue, value: .Boolean(true))
    }
  }

  public static func removeSupertag(
    _ supertagID: SupertagID,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    try mutateMetadata(in: snapshot, message: "Remove #\(supertagID.rawValue)") { document, tags, values in
      try document.delete(obj: tags, key: supertagID.rawValue)
      for (key, _) in try document.mapEntries(obj: values) where key.hasPrefix("\(supertagID.rawValue):") {
        try document.delete(obj: values, key: key)
      }
    }
  }

  public static func setProperty(
    key: SupertagPropertyKey,
    values: [SupertagValue],
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    try mutateMetadata(in: snapshot, message: "Set \(key.fieldID.rawValue)") { document, tags, properties in
      try document.put(obj: tags, key: key.supertagID.rawValue, value: .Boolean(true))
      if values.isEmpty {
        try document.delete(obj: properties, key: key.storageKey)
      } else {
        let data = try JSONEncoder.enchiridion.encode(values)
        try document.put(
          obj: properties,
          key: key.storageKey,
          value: .String(String(decoding: data, as: UTF8.self))
        )
      }
    }
  }

  public static func resolvePropertyConflict(
    key: SupertagPropertyKey,
    values: [SupertagValue],
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    try setProperty(key: key, values: values, in: snapshot)
  }

  public static func inspect(_ snapshot: Data, pageID: PageID) throws -> PageDocumentProjection {
    guard snapshot.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    let document = try Document(snapshot)
    try validate(document)
    return try projection(document, pageID: pageID)
  }

  public static func encodedChanges(from snapshot: Data, since heads: AutomergeHeads) throws -> Data {
    let document = try Document(snapshot)
    guard let changeHashes = heads.changeHashes else { throw PageDocumentError.invalidHeads }
    return try document.encodeChangesSince(heads: changeHashes)
  }

  private static func validate(_ document: Document) throws {
    guard case .Scalar(.String(format))? = try document.get(obj: .ROOT, key: "format"),
      format == Self.format,
      let version = try document.get(obj: .ROOT, key: "schemaVersion"),
      isSupportedVersion(version),
      case .Object(_, .Text)? = try document.get(obj: .ROOT, key: "title"),
      case .Object(_, .Text)? = try document.get(obj: .ROOT, key: "body")
    else { throw PageDocumentError.invalidSchema }
  }

  private static func isSupportedVersion(_ value: Value) -> Bool {
    value == .Scalar(.Int(Int64(schemaVersion)))
      || value == .Scalar(.Uint(UInt64(schemaVersion)))
      || value == .Scalar(.F64(Double(schemaVersion)))
  }

  private static func projection(
    _ document: Document,
    pageID: PageID? = nil
  ) throws -> PageDocumentProjection {
    guard case .Object(let titleObject, .Text)? = try document.get(obj: .ROOT, key: "title"),
      case .Object(let bodyObject, .Text)? = try document.get(obj: .ROOT, key: "body")
    else { throw PageDocumentError.invalidSchema }

    let resolvedPageID: PageID
    if let pageID {
      resolvedPageID = pageID
    } else if case .Scalar(.String(let value))? = try document.get(obj: .ROOT, key: "pageID") {
      resolvedPageID = PageID(rawValue: value)
    } else {
      throw PageDocumentError.invalidSchema
    }

    let deletedAt: Date?
    if case .Scalar(.String(let value))? = try document.get(obj: .ROOT, key: "deletedAt") {
      deletedAt = Date.fromEnchiridionISO8601(value)
    } else {
      deletedAt = nil
    }

    let isPinned: Bool
    if case .Scalar(.Boolean(let value))? = try document.get(obj: .ROOT, key: "isPinned") {
      isPinned = value
    } else {
      isPinned = false
    }

    var references: [PageReference] = []
    var seen: Set<PageID> = []
    for mark in try document.marks(obj: bodyObject) where mark.name == pageReferenceMark {
      guard case .String(let encoded) = mark.value,
        let data = encoded.data(using: .utf8),
        let value = try? JSONDecoder.enchiridion.decode(PageReferenceValue.self, from: data)
      else { continue }
      let target = PageID(rawValue: value.pageID)
      guard seen.insert(target).inserted else { continue }
      references.append(
        PageReference(
          sourcePageID: resolvedPageID,
          targetPageID: target,
          fallbackLabel: value.label
        )
      )
    }

    return PageDocumentProjection(
      title: try document.text(obj: titleObject),
      plainText: try document.text(obj: bodyObject),
      deletedAt: deletedAt,
      isPinned: isPinned,
      references: references,
      objectMetadata: try metadataProjection(document)
    )
  }

  private static func mutateMetadata(
    in snapshot: Data,
    message: String,
    mutation: (Document, ObjId, ObjId) throws -> Void
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    let objects = try metadataObjects(document)
    try mutation(document, objects.tags, objects.values)
    document.commitWith(message: message, timestamp: Date())
    return (document.save(), heads(document), try projection(document))
  }

  private static func metadataObjects(_ document: Document) throws -> (tags: ObjId, values: ObjId) {
    let metadata: ObjId
    if case .Object(let object, .Map)? = try document.get(obj: .ROOT, key: "objectMetadata") {
      metadata = object
    } else {
      metadata = try document.putObject(obj: .ROOT, key: "objectMetadata", ty: .Map)
      try document.put(obj: metadata, key: "version", value: .Int(1))
    }
    let tags: ObjId
    if case .Object(let object, .Map)? = try document.get(obj: metadata, key: "tags") {
      tags = object
    } else {
      tags = try document.putObject(obj: metadata, key: "tags", ty: .Map)
    }
    let values: ObjId
    if case .Object(let object, .Map)? = try document.get(obj: metadata, key: "values") {
      values = object
    } else {
      values = try document.putObject(obj: metadata, key: "values", ty: .Map)
    }
    return (tags, values)
  }

  private static func metadataProjection(_ document: Document) throws -> PageObjectMetadata {
    guard case .Object(let metadata, .Map)? = try document.get(obj: .ROOT, key: "objectMetadata") else {
      return .init()
    }
    var tagIDs: [SupertagID] = []
    if case .Object(let tags, .Map)? = try document.get(obj: metadata, key: "tags") {
      tagIDs = try document.mapEntries(obj: tags).compactMap { key, value in
        guard value == .Scalar(.Boolean(true)) else { return nil }
        return SupertagID(rawValue: key)
      }.sorted { $0.rawValue < $1.rawValue }
    }

    var projected: [SupertagPropertyKey: [SupertagValue]] = [:]
    var conflicts: [SupertagConflict] = []
    if case .Object(let values, .Map)? = try document.get(obj: metadata, key: "values") {
      for (storageKey, _) in try document.mapEntries(obj: values) {
        guard let separator = storageKey.firstIndex(of: ":") else { continue }
        let key = SupertagPropertyKey(
          supertagID: .init(rawValue: String(storageKey[..<separator])),
          fieldID: .init(rawValue: String(storageKey[storageKey.index(after: separator)...]))
        )
        let candidates: [[SupertagValue]] = try document.getAll(obj: values, key: storageKey)
          .compactMap { value in
            guard case .Scalar(.String(let json)) = value, let data = json.data(using: .utf8) else { return nil }
            return try? JSONDecoder.enchiridion.decode([SupertagValue].self, from: data)
          }
          .sorted { lhs, rhs in
            (try? String(data: JSONEncoder.enchiridion.encode(lhs), encoding: .utf8)) ?? ""
              < (try? String(data: JSONEncoder.enchiridion.encode(rhs), encoding: .utf8)) ?? ""
          }
        if let first = candidates.first { projected[key] = first }
        if candidates.count > 1 { conflicts.append(.init(key: key, candidates: candidates)) }
      }
    }
    return PageObjectMetadata(
      supertagIDs: tagIDs,
      properties: projected,
      conflicts: conflicts.sorted { $0.id < $1.id }
    )
  }

  private static func heads(_ document: Document) -> AutomergeHeads {
    AutomergeHeads(document.heads().map(\.debugDescription))
  }
}

private struct PageReferenceValue: Codable {
  var pageID: String
  var label: String
}

extension AutomergeHeads {
  fileprivate var changeHashes: Set<ChangeHash>? {
    var data = Data()
    for value in values {
      guard value.count == 64 else { return nil }
      var index = value.startIndex
      for _ in 0..<32 {
        let next = value.index(index, offsetBy: 2)
        guard let byte = UInt8(value[index..<next], radix: 16) else { return nil }
        data.append(byte)
        index = next
      }
    }
    return data.heads()
  }
}

extension JSONEncoder {
  static let enchiridion: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }()
}

extension JSONDecoder {
  static let enchiridion: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }()
}
