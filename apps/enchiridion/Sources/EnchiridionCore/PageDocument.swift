import Automerge
import CryptoKit
import Foundation

public enum PageDocumentError: Error, LocalizedError, Equatable {
  case documentTooLarge
  case invalidSchema
  case invalidHeads
  case invalidBookmarkCaptureEvent
  case bookmarkCaptureEventConflict
  case bookmarkCaptureEventLimit
  case invalidBookmarkIdentityDeletion
  case bookmarkIdentityDeletionConflict
  case bookmarkIdentityDeletionLimit
  case bookmarkIdentityDeletionCarrierRequiresDistinctPageID

  public var errorDescription: String? {
    switch self {
    case .documentTooLarge: "The page exceeds the 20 MiB document limit."
    case .invalidSchema: "The page has an unsupported Automerge schema."
    case .invalidHeads: "The editor commit does not match its advertised Automerge heads."
    case .invalidBookmarkCaptureEvent: "The bookmark capture event is invalid."
    case .bookmarkCaptureEventConflict: "This bookmark capture identifier has conflicting facts."
    case .bookmarkCaptureEventLimit: "This bookmark page has too many capture events."
    case .invalidBookmarkIdentityDeletion: "The bookmark deletion marker is invalid."
    case .bookmarkIdentityDeletionConflict: "This bookmark deletion identifier has conflicting facts."
    case .bookmarkIdentityDeletionLimit: "This bookmark page has too many deletion markers."
    case .bookmarkIdentityDeletionCarrierRequiresDistinctPageID:
      "A deletion carrier must use a new page identifier."
    }
  }
}

public struct BookmarkCaptureEventProvenance: Hashable, Sendable, Identifiable {
  public let rootKey: String
  public let encodedEnvelope: String
  public let rawHash: String
  public let event: BookmarkSyncedCaptureEvent
  public var id: String { "\(rootKey):\(rawHash)" }
}

public enum BookmarkCaptureEventIssueKind: String, Hashable, Sendable {
  case nonScalar, invalidEnvelope, nonCanonicalEnvelope, mismatchedKey, conflictingValues, limitExceeded
}

public struct BookmarkCaptureEventIssue: Hashable, Sendable, Identifiable {
  public let rootKey: String
  public let rawHash: String
  public let kind: BookmarkCaptureEventIssueKind
  public let occurrence: Int

  public init(
    rootKey: String,
    rawHash: String,
    kind: BookmarkCaptureEventIssueKind,
    occurrence: Int = 0
  ) {
    self.rootKey = rootKey
    self.rawHash = rawHash
    self.kind = kind
    self.occurrence = occurrence
  }

  public var id: String {
    "bookmark-capture-issue:\(kind.rawValue):\(rootKey):\(rawHash):\(occurrence)"
  }
}

public struct BookmarkCaptureEventInspection: Hashable, Sendable {
  public let events: [BookmarkCaptureEventProvenance]
  public let issues: [BookmarkCaptureEventIssue]
  public let rootKeyCount: Int
}

public struct BookmarkIdentityDeletionProvenance: Hashable, Sendable, Identifiable {
  public let rootKey: String
  public let encodedEnvelope: String
  public let rawHash: String
  public let envelope: BookmarkIdentityDeletionEnvelope
  public var id: String { "\(rootKey):\(rawHash)" }
}

public struct BookmarkIdentityDeletionInspection: Hashable, Sendable {
  public let deletions: [BookmarkIdentityDeletionProvenance]
  public let issues: [BookmarkCaptureEventIssue]
  public let rootKeyCount: Int
}

public struct BookmarkIdentityDeletionCarrierInspection: Hashable, Sendable {
  public let deletionInspection: BookmarkIdentityDeletionInspection
  public let canonicalDeletion: BookmarkIdentityDeletionEnvelope?
  public let isCanonicalCarrier: Bool
}

public struct PageDocumentProjection: Hashable, Sendable {
  public var title: String
  public var plainText: String
  public var deletedAt: Date?
  public var isPinned: Bool
  public var references: [PageReference]
  public var graphEdges: [KnowledgeEdge]
  public var objectMetadata: PageObjectMetadata
}

public struct PageRichTextDocument: Equatable, Sendable {
  public var title: String
  public var body: AttributedString

  public init(title: String, body: AttributedString) {
    self.title = title
    self.body = body
  }
}

public struct PageRichTextMark: Hashable, Sendable {
  public var name: String
  public var value: PageRichTextMarkValue

  public init(name: String, value: PageRichTextMarkValue) {
    self.name = name
    self.value = value
  }
}

public struct PageReferenceDestination: Hashable, Sendable {
  public let pageID: PageID
  public let label: String

  public init(pageID: PageID, label: String) {
    self.pageID = pageID
    self.label = label
  }
}

public enum PageRichTextMarkValue: Hashable, Sendable {
  case bytes(Data)
  case string(String)
  case uint(UInt64)
  case int(Int64)
  case floatingPoint(Double)
  case counter(Int64)
  case timestamp(Date)
  case boolean(Bool)
  case unknown(typeCode: UInt8, data: Data)
  case null
}

public enum PageRichTextAttributes {
  public struct AutomergeMarks: AttributedStringKey {
    public typealias Value = [PageRichTextMark]
    public static let name = "dev.rawkode.enchiridion.automerge-marks"
    public static let inheritedByAddedText = false
  }
}

public enum PageDocument {
  public static let format = "enchiridion/page"
  public static let schemaVersion = 2
  public static let maximumDocumentBytes = 20 * 1_024 * 1_024
  public static let maximumChangeBytes = 1 * 1_024 * 1_024
  public static let maximumMeetingTranscriptChangeBytes = 256 * 1_024
  public static let pageReferenceMark = "__ext__dev.rawkode.enchiridion.page-reference"
  public static let meetingSemanticProvenanceMark = "__ext__dev.rawkode.enchiridion.meeting-semantic"
  public static let strongMark = "strong"
  public static let emphasisMark = "em"
  public static let strikethroughMark = "strike"
  public static let codeMark = "code"
  public static let bookmarkCaptureEventRootPrefix = "bookmarkCaptureEvent/"
  public static let maximumBookmarkCaptureEvents = 4_096
  public static let bookmarkIdentityDeletionRootPrefix = "bookmarkIdentityDeletion/"
  public static let maximumBookmarkIdentityDeletions = 4_096
  public static let bookmarkIdentityDeletionCarrierTitle = "Deleted Bookmark"

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
    _ = try document.putObject(obj: .ROOT, key: "edges", ty: .Map)
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

  /// Forks a page while retaining its Automerge history. Recurring-task successors created on
  /// different replicas can then merge from shared ancestry without duplicating text content.
  public static func fork(
    _ snapshot: Data,
    to pageID: PageID,
    message: String
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    try document.put(obj: .ROOT, key: "pageID", value: .String(pageID.rawValue))
    document.commitWith(message: message, timestamp: Date())
    return (document.save(), heads(document), try projection(document, pageID: pageID))
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

  public static func replaceTitle(
    with title: String,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    guard case .Object(let titleObject, .Text)? = try document.get(obj: .ROOT, key: "title") else {
      throw PageDocumentError.invalidSchema
    }
    let current = try document.text(obj: titleObject)
    try document.spliceText(
      obj: titleObject,
      start: 0,
      delete: Int64(current.unicodeScalars.count),
      value: title
    )
    document.commitWith(message: "Rename page", timestamp: Date())
    return (document.save(), heads(document), try projection(document))
  }

  public static func richText(in snapshot: Data) throws -> PageRichTextDocument {
    let document = try Document(snapshot)
    try validate(document)
    guard case .Object(let titleObject, .Text)? = try document.get(obj: .ROOT, key: "title"),
      case .Object(let bodyObject, .Text)? = try document.get(obj: .ROOT, key: "body")
    else { throw PageDocumentError.invalidSchema }

    return PageRichTextDocument(
      title: try document.text(obj: titleObject),
      body: try attributedText(from: document, object: bodyObject)
    )
  }

  public static func replaceRichText(
    title: String,
    body: AttributedString,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    guard case .Object(let titleObject, .Text)? = try document.get(obj: .ROOT, key: "title"),
      case .Object(let bodyObject, .Text)? = try document.get(obj: .ROOT, key: "body")
    else { throw PageDocumentError.invalidSchema }

    try document.put(obj: .ROOT, key: "schemaVersion", value: .Int(Int64(schemaVersion)))
    try document.updateText(obj: titleObject, value: title)
    try replaceTextAndMarks(in: document, object: bodyObject, with: body)
    document.commitWith(message: "Edit rich page", timestamp: Date())
    return (document.save(), heads(document), try projection(document))
  }

  public static func pageReferenceMark(
    to pageID: PageID,
    label: String
  ) throws -> PageRichTextMark {
    let payload = try JSONEncoder.enchiridion.encode(
      PageReferenceValue(pageID: pageID.rawValue, label: label)
    )
    return PageRichTextMark(
      name: pageReferenceMark,
      value: .string(String(decoding: payload, as: UTF8.self))
    )
  }

  public static func pageReferenceDestination(
    from mark: PageRichTextMark
  ) -> PageReferenceDestination? {
    guard mark.name == pageReferenceMark,
      case .string(let encoded) = mark.value,
      let data = encoded.data(using: .utf8),
      let value = try? JSONDecoder.enchiridion.decode(PageReferenceValue.self, from: data)
    else { return nil }

    return PageReferenceDestination(
      pageID: PageID(rawValue: value.pageID),
      label: value.label
    )
  }

  public static func meetingSemanticMark(operationID: String) -> PageRichTextMark {
    PageRichTextMark(name: meetingSemanticProvenanceMark, value: .string(operationID))
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
    if !values.isEmpty && values.allSatisfy({ if case .page = $0 { true } else { false } }) {
      return try setRelationship(key: key, values: values, in: snapshot)
    }
    return try mutateMetadata(in: snapshot, message: "Set \(key.fieldID.rawValue)") { document, tags, properties in
      try document.put(obj: tags, key: key.supertagID.rawValue, value: .Boolean(true))
      if values.isEmpty {
        try replaceRelationshipEdges(document, key: key, targets: [])
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

  public static func setProperties(
    _ updates: [SupertagPropertyKey: [SupertagValue]],
    ensuring supertagID: SupertagID,
    message: String,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    try mutateMetadata(in: snapshot, message: message) { document, tags, properties in
      try document.put(obj: tags, key: supertagID.rawValue, value: .Boolean(true))
      for key in updates.keys.sorted(by: { $0.storageKey < $1.storageKey }) {
        let values = updates[key] ?? []
        if values.allSatisfy({ if case .page = $0 { true } else { false } }),
          values.contains(where: { if case .page = $0 { true } else { false } })
        {
          try replaceRelationshipEdges(
            document,
            key: key,
            targets: values.compactMap { value in
              guard case .page(let pageID) = value else { return nil }
              return pageID
            }
          )
          if try document.get(obj: properties, key: key.storageKey) != nil {
            try document.delete(obj: properties, key: key.storageKey)
          }
          continue
        }
        if values.isEmpty {
          try replaceRelationshipEdges(document, key: key, targets: [])
          if try document.get(obj: properties, key: key.storageKey) != nil {
            try document.delete(obj: properties, key: key.storageKey)
          }
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
  }

  public static func resolvePropertyConflict(
    key: SupertagPropertyKey,
    values: [SupertagValue],
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    try setProperty(key: key, values: values, in: snapshot)
  }

  public static func upsertEdge(
    _ edge: KnowledgeEdge,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    let pageID = try resolvedPageID(document)
    guard edge.sourceNodeID == pageID else { throw PageDocumentError.invalidSchema }
    let edges = try edgesObject(document)
    let encoded = try JSONEncoder.enchiridion.encode(edge)
    try document.put(
      obj: edges,
      key: edge.id.rawValue,
      value: .String(String(decoding: encoded, as: UTF8.self))
    )
    document.commitWith(message: "Add \(edge.relationID.rawValue)", timestamp: Date())
    return (document.save(), heads(document), try projection(document))
  }

  public static func removeEdge(
    _ edgeID: EdgeID,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    let edges = try edgesObject(document)
    if try document.get(obj: edges, key: edgeID.rawValue) != nil {
      try document.delete(obj: edges, key: edgeID.rawValue)
    }
    document.commitWith(message: "Remove relationship", timestamp: Date())
    return (document.save(), heads(document), try projection(document))
  }

  public static func setPersonClassification(
    visibility: PersonVisibility,
    origin: PersonOrigin,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    let metadata = try metadataObject(document)
    try document.put(
      obj: metadata,
      key: "personVisibility",
      value: .String(visibility.rawValue)
    )
    try document.put(
      obj: metadata,
      key: "personOrigin",
      value: .String(origin.rawValue)
    )
    document.commitWith(
      message: visibility == .promoted ? "Promote person" : "Move person to Other",
      timestamp: Date()
    )
    return (document.save(), heads(document), try projection(document))
  }

  public static func clearPersonClassification(
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    let document = try Document(snapshot)
    try validate(document)
    let metadata = try metadataObject(document)
    if try document.get(obj: metadata, key: "personVisibility") != nil {
      try document.delete(obj: metadata, key: "personVisibility")
    }
    if try document.get(obj: metadata, key: "personOrigin") != nil {
      try document.delete(obj: metadata, key: "personOrigin")
    }
    document.commitWith(message: "Remove person classification", timestamp: Date())
    return (document.save(), heads(document), try projection(document))
  }

  public static func inspect(_ snapshot: Data, pageID: PageID) throws -> PageDocumentProjection {
    guard snapshot.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    let document = try Document(snapshot)
    try validate(document)
    return try projection(document, pageID: pageID)
  }

  /// Reads the Event-page resource map. Transcript segments remain separate CRDT map entries,
  /// so a long meeting is never rewritten as one unbounded Automerge change.
  public static func meetingTranscript(
    resourceKey: String,
    in snapshot: Data
  ) throws -> MeetingTranscriptResource? {
    let document = try Document(snapshot)
    try validate(document)
    let resourceMaps = try document.getAll(obj: .ROOT, key: "meetingResources").compactMap { value -> ObjId? in
      guard case .Object(let object, .Map) = value else { return nil }
      return object
    }
    var resources: [ObjId] = []
    for map in resourceMaps {
      resources.append(contentsOf: try document.getAll(obj: map, key: resourceKey).compactMap { value -> ObjId? in
        guard case .Object(let object, .Map) = value else { return nil }
        return object
      })
    }

    var metadataJSON: [String] = []
    var segmentJSON: [String] = []
    for resource in resources {
      metadataJSON.append(contentsOf: try document.getAll(obj: resource, key: "metadata").compactMap {
        guard case .Scalar(.String(let value)) = $0 else { return nil }
        return value
      })
      let segmentMaps = try document.getAll(obj: resource, key: "segments").compactMap { value -> ObjId? in
        guard case .Object(let object, .Map) = value else { return nil }
        return object
      }
      for segments in segmentMaps {
        for (key, _) in try document.mapEntries(obj: segments) {
          segmentJSON.append(contentsOf: try document.getAll(obj: segments, key: key).compactMap {
            guard case .Scalar(.String(let value)) = $0 else { return nil }
            return value
          })
        }
      }
    }

    var merged: MeetingTranscriptResource?
    for json in metadataJSON.sorted() {
      guard let data = json.data(using: .utf8) else { continue }
      let candidate = try JSONDecoder.enchiridion.decode(MeetingTranscriptResource.self, from: data)
      merged = mergeMeetingTranscript(merged, candidate)
    }
    guard var value = merged else { return nil }
    for json in segmentJSON.sorted() {
      guard let data = json.data(using: .utf8),
        let segment = try? JSONDecoder.enchiridion.decode(MeetingTranscriptSegment.self, from: data)
      else { continue }
      var candidate = value
      candidate.segments = [segment]
      value = mergeMeetingTranscript(value, candidate)
    }
    try validateMeetingTranscript(value)
    return value
  }

  public static func upsertMeetingTranscript(
    _ incoming: MeetingTranscriptResource,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection, changed: Bool) {
    guard incoming.id == MeetingTranscriptResource.resourceKey(for: incoming.eventPageID) else {
      throw MeetingTranscriptError.invalidResource
    }
    try validateMeetingTranscript(incoming)
    let original = try Document(snapshot)
    try validate(original)
    let previousHeads = heads(original)
    let existing = try meetingTranscript(resourceKey: incoming.id, in: snapshot)
    let merged = mergeMeetingTranscript(existing, incoming)
    try validateMeetingTranscript(merged)
    guard existing != merged else {
      return (snapshot, previousHeads, try projection(original), false)
    }

    let resources: ObjId
    if case .Object(let object, .Map)? = try original.get(obj: .ROOT, key: "meetingResources") { resources = object }
    else { resources = try original.putObject(obj: .ROOT, key: "meetingResources", ty: .Map) }
    let resource: ObjId
    if case .Object(let object, .Map)? = try original.get(obj: resources, key: merged.id) { resource = object }
    else { resource = try original.putObject(obj: resources, key: merged.id, ty: .Map) }
    let segments: ObjId
    if case .Object(let object, .Map)? = try original.get(obj: resource, key: "segments") { segments = object }
    else { segments = try original.putObject(obj: resource, key: "segments", ty: .Map) }
    var metadata = merged
    metadata.segments = []
    let metadataData = try JSONEncoder.enchiridion.encode(metadata)
    guard metadataData.count <= maximumMeetingTranscriptChangeBytes else {
      throw MeetingTranscriptError.changeTooLarge
    }
    try original.put(obj: resource, key: "metadata", value: .String(String(decoding: metadataData, as: UTF8.self)))
    for segment in merged.segments {
      let encoded = try JSONEncoder.enchiridion.encode(segment)
      guard encoded.count <= maximumMeetingTranscriptChangeBytes else {
        throw MeetingTranscriptError.changeTooLarge
      }
      try original.put(obj: segments, key: segment.id, value: .String(String(decoding: encoded, as: UTF8.self)))
    }
    original.commitWith(message: "Update meeting transcript", timestamp: Date())
    let changed = try original.encodeChangesSince(heads: previousHeads.changeHashes ?? [])
    guard changed.count <= maximumMeetingTranscriptChangeBytes else { throw MeetingTranscriptError.changeTooLarge }
    let document = original.save()
    guard document.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    return (document, heads(original), try projection(original), true)
  }

  private static func mergeMeetingTranscript(
    _ existing: MeetingTranscriptResource?, _ incoming: MeetingTranscriptResource
  ) -> MeetingTranscriptResource {
    guard var value = existing else { return incoming }
    value.transcriptState = .monotonic(value.transcriptState, incoming.transcriptState)
    value.analysisState = .monotonic(value.analysisState, incoming.analysisState)
    value.semanticState = .monotonic(value.semanticState, incoming.semanticState)
    value.analysisReceipt = incoming.analysisReceipt ?? value.analysisReceipt
    value.semanticReceipt = incoming.semanticReceipt ?? value.semanticReceipt
    var segments = Dictionary(uniqueKeysWithValues: value.segments.map { ($0.id, $0) })
    for incomingSegment in incoming.segments {
      if let current = segments[incomingSegment.id] {
        var resolved = incomingSegment
        let currentAssignment = (
          current.speakerAssignmentRevision ?? 0,
          current.speakerAssignmentOperationID ?? ""
        )
        let incomingAssignment = (
          incomingSegment.speakerAssignmentRevision ?? 0,
          incomingSegment.speakerAssignmentOperationID ?? ""
        )
        if incomingAssignment < currentAssignment
          || (incomingAssignment == currentAssignment && incomingSegment.speakerPageID == nil)
        {
          resolved.speakerPageID = current.speakerPageID
          resolved.speakerAssignmentRevision = current.speakerAssignmentRevision
          resolved.speakerAssignmentOperationID = current.speakerAssignmentOperationID
        }
        segments[incomingSegment.id] = resolved
      } else { segments[incomingSegment.id] = incomingSegment }
    }
    value.segments = segments.values.sorted { ($0.startTime, $0.id) < ($1.startTime, $1.id) }
    if let analysis = incoming.analysis,
      analysis.transcriptHash == MeetingTranscriptHash.value(for: value.segments) {
      value.analysis = analysis
    }
    if let analysis = value.analysis,
      analysis.transcriptHash != MeetingTranscriptHash.value(for: value.segments) {
      value.analysis = nil
      value.analysisReceipt = nil
      value.analysisState = .incomplete
    }
    if let receipt = value.semanticReceipt,
      receipt.transcriptHash != MeetingTranscriptHash.value(for: value.segments) {
      value.semanticReceipt = nil
      value.semanticState = .incomplete
    }
    return value
  }

  private static func validateMeetingTranscript(_ resource: MeetingTranscriptResource) throws {
    guard resource.format == MeetingTranscriptResource.format,
      resource.schemaVersion == MeetingTranscriptResource.schemaVersion,
      resource.segments.count <= MeetingTranscriptResource.maximumSegmentCount,
      Set(resource.segments.map(\.id)).count == resource.segments.count,
      resource.segments.allSatisfy({ !$0.id.isEmpty && !$0.speakerClusterID.isEmpty && $0.startTime >= 0 && $0.endTime >= $0.startTime }),
      (resource.segments.map(\.endTime).max() ?? 0) <= MeetingTranscriptResource.maximumDurationSeconds
    else { throw MeetingTranscriptError.resourceLimit }
    guard try JSONEncoder.enchiridion.encode(resource).count <= MeetingTranscriptResource.maximumResourceBytes else {
      throw MeetingTranscriptError.resourceLimit
    }
  }

  public static func encodedChanges(from snapshot: Data, since heads: AutomergeHeads) throws -> Data {
    let document = try Document(snapshot)
    guard let changeHashes = heads.changeHashes else { throw PageDocumentError.invalidHeads }
    return try document.encodeChangesSince(heads: changeHashes)
  }

  /// Adds one immutable capture scalar without changing title, body, or object metadata. The
  /// root-keyed shape means independent replicas can add different captures without a map-level
  /// overwrite; equal replays leave the document byte-for-byte unchanged.
  public static func appendBookmarkCaptureEvent(
    _ event: BookmarkSyncedCaptureEvent,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    do { try event.validate() } catch { throw PageDocumentError.invalidBookmarkCaptureEvent }
    let encoded: String
    do {
      let data = try event.canonicalData()
      guard data.count <= BookmarkSyncedCaptureEvent.maximumEncodedBytes,
        let value = String(data: data, encoding: .utf8)
      else { throw PageDocumentError.invalidBookmarkCaptureEvent }
      encoded = value
    } catch let error as PageDocumentError { throw error }
    catch { throw PageDocumentError.invalidBookmarkCaptureEvent }

    let document = try Document(snapshot)
    try validate(document)
    let inspection = try bookmarkCaptureEventInspection(document)
    let rootKey = bookmarkCaptureEventRootPrefix + event.captureID.uuidString.lowercased()
    let existing = inspection.events.filter { $0.rootKey == rootKey }
    if existing.contains(where: { $0.event == event }) {
      return (snapshot, heads(document), try projection(document))
    }
    if !existing.isEmpty || inspection.issues.contains(where: { $0.rootKey == rootKey }) {
      throw PageDocumentError.bookmarkCaptureEventConflict
    }
    guard inspection.rootKeyCount < maximumBookmarkCaptureEvents else {
      throw PageDocumentError.bookmarkCaptureEventLimit
    }
    let priorHeads = document.heads()
    try document.put(obj: .ROOT, key: rootKey, value: .String(encoded))
    document.commitWith(message: "Capture bookmark", timestamp: event.capturedAt)
    guard try document.encodeChangesSince(heads: priorHeads).count <= maximumChangeBytes else {
      throw PageDocumentError.documentTooLarge
    }
    let saved = document.save()
    guard saved.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    return (saved, heads(document), try projection(document))
  }

  public static func bookmarkCaptureEvents(in snapshot: Data) throws -> BookmarkCaptureEventInspection {
    guard snapshot.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    let document = try Document(snapshot)
    try validate(document)
    return try bookmarkCaptureEventInspection(document)
  }

  public static func appendBookmarkIdentityDeletion(
    _ deletion: BookmarkIdentityDeletionEnvelope,
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    do { try deletion.validate() } catch { throw PageDocumentError.invalidBookmarkIdentityDeletion }
    let encoded: String
    do {
      let data = try deletion.canonicalData()
      guard data.count <= BookmarkIdentityDeletionEnvelope.maximumEncodedBytes,
        let value = String(data: data, encoding: .utf8)
      else { throw PageDocumentError.invalidBookmarkIdentityDeletion }
      encoded = value
    } catch let error as PageDocumentError { throw error }
    catch { throw PageDocumentError.invalidBookmarkIdentityDeletion }
    let document = try Document(snapshot)
    try validate(document)
    let inspection = try bookmarkIdentityDeletionInspection(document)
    let rootKey = bookmarkIdentityDeletionRootPrefix + deletion.deletionID.uuidString.lowercased()
    let existing = inspection.deletions.filter { $0.rootKey == rootKey }
    if existing.contains(where: { $0.envelope == deletion }) {
      return (snapshot, heads(document), try projection(document))
    }
    if !existing.isEmpty || inspection.issues.contains(where: { $0.rootKey == rootKey }) {
      throw PageDocumentError.bookmarkIdentityDeletionConflict
    }
    guard inspection.rootKeyCount < maximumBookmarkIdentityDeletions else {
      throw PageDocumentError.bookmarkIdentityDeletionLimit
    }
    let priorHeads = document.heads()
    try document.put(obj: .ROOT, key: rootKey, value: .String(encoded))
    document.commitWith(message: "Delete bookmark identity", timestamp: deletion.deletedAt)
    guard try document.encodeChangesSince(heads: priorHeads).count <= maximumChangeBytes else {
      throw PageDocumentError.documentTooLarge
    }
    let saved = document.save()
    guard saved.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    return (saved, heads(document), try projection(document))
  }

  public static func bookmarkIdentityDeletions(
    in snapshot: Data
  ) throws -> BookmarkIdentityDeletionInspection {
    guard snapshot.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    let document = try Document(snapshot)
    try validate(document)
    return try bookmarkIdentityDeletionInspection(document)
  }

  /// Creates a fresh, distinct carrier Page. It is intentionally not a transform of an original
  /// Page: repository code must allocate a new ID and apply marker-dominance during cloud merges.
  public static func makeBookmarkIdentityDeletionCarrier(
    id: PageID,
    replacingCandidateID: PageID,
    deletion: BookmarkIdentityDeletionEnvelope
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    guard id != replacingCandidateID else {
      throw PageDocumentError.bookmarkIdentityDeletionCarrierRequiresDistinctPageID
    }
    let created = try create(id: id, kind: .free, title: bookmarkIdentityDeletionCarrierTitle, createdAt: deletion.deletedAt)
    let appended = try appendBookmarkIdentityDeletion(deletion, in: created.document)
    return try setDeleted(deletion.deletedAt, in: appended.document)
  }

  public static func bookmarkIdentityDeletionCarrierInspection(
    in snapshot: Data
  ) throws -> BookmarkIdentityDeletionCarrierInspection {
    guard snapshot.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    let document = try Document(snapshot)
    try validate(document)
    let inspection = try bookmarkIdentityDeletionInspection(document)
    let ordered = inspection.deletions.map(\.envelope).sorted {
      if $0.deletedAt != $1.deletedAt { return $0.deletedAt < $1.deletedAt }
      return $0.deletionID.uuidString < $1.deletionID.uuidString
    }
    let canonical = ordered.first
    let digests = Set(ordered.map(\.urlKeyDigest))
    let rootKeys = Set(try document.mapEntries(obj: .ROOT).map(\.0))
    let allowedRoots = Set([
      "format", "schemaVersion", "pageID", "kind", "createdAt", "deletedAt", "isPinned",
      "objectMetadata", "edges", "title", "body"
    ]).union(inspection.deletions.map(\.rootKey))
    let projection = try projection(document)
    let projectionDeletionMilliseconds = projection.deletedAt.map {
      Int64(($0.timeIntervalSince1970 * 1_000).rounded())
    }
    let canonicalDeletionMilliseconds = canonical.map {
      Int64(($0.deletedAt.timeIntervalSince1970 * 1_000).rounded())
    }
    let canonicalCarrier = canonical.map { _ in
      inspection.issues.isEmpty
        && digests.count == 1
        && rootKeys == allowedRoots
        && projection.title == bookmarkIdentityDeletionCarrierTitle
        && projection.plainText.isEmpty
        && projectionDeletionMilliseconds == canonicalDeletionMilliseconds
        && !projection.isPinned
        && projection.objectMetadata.supertagIDs.isEmpty
        && projection.objectMetadata.properties.isEmpty
        && projection.references.isEmpty
        && projection.graphEdges.isEmpty
        && (try? bookmarkCaptureEventInspection(document).rootKeyCount) == 0
    } ?? false
    return .init(deletionInspection: inspection, canonicalDeletion: canonical, isCanonicalCarrier: canonicalCarrier)
  }

  private static func bookmarkCaptureEventInspection(
    _ document: Document
  ) throws -> BookmarkCaptureEventInspection {
    var events: [BookmarkCaptureEventProvenance] = []
    var issues: [BookmarkCaptureEventIssue] = []
    let rootKeys = try document.mapEntries(obj: .ROOT).map(\.0)
      .filter { $0.hasPrefix(bookmarkCaptureEventRootPrefix) }
      .sorted()
    for rootKey in rootKeys {
      let expectedID = String(rootKey.dropFirst(bookmarkCaptureEventRootPrefix.count))
      let candidates = try document.getAll(obj: .ROOT, key: rootKey)
      var validEncoded: [String] = []
      for candidate in candidates {
        let rawHash = eventRawHash(candidate)
        guard case .Scalar(.String(let encoded)) = candidate else {
          issues.append(.init(rootKey: rootKey, rawHash: rawHash, kind: .nonScalar)); continue
        }
        guard let data = encoded.data(using: .utf8), data.count <= BookmarkSyncedCaptureEvent.maximumEncodedBytes,
          let event = try? JSONDecoder.enchiridion.decode(BookmarkSyncedCaptureEvent.self, from: data)
        else {
          issues.append(.init(rootKey: rootKey, rawHash: rawHash, kind: .invalidEnvelope)); continue
        }
        guard (try? event.canonicalData()) == data else {
          issues.append(.init(rootKey: rootKey, rawHash: rawHash, kind: .nonCanonicalEnvelope)); continue
        }
        guard event.captureID.uuidString.lowercased() == expectedID else {
          issues.append(.init(rootKey: rootKey, rawHash: rawHash, kind: .mismatchedKey)); continue
        }
        validEncoded.append(encoded)
        events.append(.init(rootKey: rootKey, encodedEnvelope: encoded, rawHash: rawHash, event: event))
      }
      if Set(validEncoded).count > 1 {
        issues.append(.init(
          rootKey: rootKey,
          rawHash: eventRawHash(validEncoded.sorted().joined(separator: "\n")),
          kind: .conflictingValues
        ))
      }
    }
    if rootKeys.count > maximumBookmarkCaptureEvents {
      issues.append(.init(
        rootKey: bookmarkCaptureEventRootPrefix,
        rawHash: eventRawHash(rootKeys.joined(separator: "\n")),
        kind: .limitExceeded
      ))
    }
    return .init(
      events: events.sorted { lhs, rhs in
        if lhs.rootKey != rhs.rootKey { return lhs.rootKey < rhs.rootKey }
        return lhs.encodedEnvelope < rhs.encodedEnvelope
      },
      issues: stableBookmarkCaptureIssues(issues),
      rootKeyCount: rootKeys.count
    )
  }

  private static func bookmarkIdentityDeletionInspection(
    _ document: Document
  ) throws -> BookmarkIdentityDeletionInspection {
    var deletions: [BookmarkIdentityDeletionProvenance] = []
    var issues: [BookmarkCaptureEventIssue] = []
    let rootKeys = try document.mapEntries(obj: .ROOT).map(\.0)
      .filter { $0.hasPrefix(bookmarkIdentityDeletionRootPrefix) }
      .sorted()
    for rootKey in rootKeys {
      let expectedID = String(rootKey.dropFirst(bookmarkIdentityDeletionRootPrefix.count))
      var validEncoded: [String] = []
      for candidate in try document.getAll(obj: .ROOT, key: rootKey) {
        let rawHash = eventRawHash(candidate)
        guard case .Scalar(.String(let encoded)) = candidate else {
          issues.append(.init(rootKey: rootKey, rawHash: rawHash, kind: .nonScalar)); continue
        }
        guard let data = encoded.data(using: .utf8), data.count <= BookmarkIdentityDeletionEnvelope.maximumEncodedBytes,
          let deletion = try? JSONDecoder.enchiridion.decode(BookmarkIdentityDeletionEnvelope.self, from: data)
        else {
          issues.append(.init(rootKey: rootKey, rawHash: rawHash, kind: .invalidEnvelope)); continue
        }
        guard (try? deletion.canonicalData()) == data else {
          issues.append(.init(rootKey: rootKey, rawHash: rawHash, kind: .nonCanonicalEnvelope)); continue
        }
        guard deletion.deletionID.uuidString.lowercased() == expectedID else {
          issues.append(.init(rootKey: rootKey, rawHash: rawHash, kind: .mismatchedKey)); continue
        }
        validEncoded.append(encoded)
        deletions.append(.init(rootKey: rootKey, encodedEnvelope: encoded, rawHash: rawHash, envelope: deletion))
      }
      if Set(validEncoded).count > 1 {
        issues.append(.init(
          rootKey: rootKey,
          rawHash: eventRawHash(validEncoded.sorted().joined(separator: "\n")),
          kind: .conflictingValues
        ))
      }
    }
    if rootKeys.count > maximumBookmarkIdentityDeletions {
      issues.append(.init(
        rootKey: bookmarkIdentityDeletionRootPrefix,
        rawHash: eventRawHash(rootKeys.joined(separator: "\n")),
        kind: .limitExceeded
      ))
    }
    return .init(
      deletions: deletions.sorted { lhs, rhs in
        if lhs.rootKey != rhs.rootKey { return lhs.rootKey < rhs.rootKey }
        return lhs.encodedEnvelope < rhs.encodedEnvelope
      },
      issues: stableBookmarkCaptureIssues(issues),
      rootKeyCount: rootKeys.count
    )
  }

  private static func stableBookmarkCaptureIssues(
    _ issues: [BookmarkCaptureEventIssue]
  ) -> [BookmarkCaptureEventIssue] {
    let ordered = issues.sorted { lhs, rhs in
        if lhs.rootKey != rhs.rootKey { return lhs.rootKey < rhs.rootKey }
        if lhs.kind.rawValue != rhs.kind.rawValue { return lhs.kind.rawValue < rhs.kind.rawValue }
        return lhs.rawHash < rhs.rawHash
      }
    var counts: [String: Int] = [:]
    return ordered.map { issue in
      let key = "\(issue.rootKey)\u{0}\(issue.kind.rawValue)\u{0}\(issue.rawHash)"
      let occurrence = counts[key, default: 0]
      counts[key] = occurrence + 1
      return .init(rootKey: issue.rootKey, rawHash: issue.rawHash, kind: issue.kind, occurrence: occurrence)
    }
  }

  private static func eventRawHash(_ value: Any) -> String {
    SHA256.hash(data: Data(String(describing: value).utf8)).map { String(format: "%02x", $0) }.joined()
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
    switch value {
    case .Scalar(.Int(let version)):
      (1...Int64(schemaVersion)).contains(version)
    case .Scalar(.Uint(let version)):
      (1...UInt64(schemaVersion)).contains(version)
    case .Scalar(.F64(let version)):
      version.rounded() == version && (1...Double(schemaVersion)).contains(version)
    default:
      false
    }
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
    } else {
      resolvedPageID = try Self.resolvedPageID(document)
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
    for mark in try document.marks(obj: bodyObject) {
      let richTextMark = PageRichTextMark(name: mark.name, value: richTextValue(from: mark.value))
      guard let destination = pageReferenceDestination(from: richTextMark) else { continue }
      let target = destination.pageID
      guard seen.insert(target).inserted else { continue }
      references.append(
        PageReference(
          sourcePageID: resolvedPageID,
          targetPageID: target,
          fallbackLabel: destination.label
        )
      )
    }

    let edges = try graphEdges(document, pageID: resolvedPageID)
    return PageDocumentProjection(
      title: try document.text(obj: titleObject),
      plainText: try document.text(obj: bodyObject),
      deletedAt: deletedAt,
      isPinned: isPinned,
      references: references,
      graphEdges: edges,
      objectMetadata: try metadataProjection(document, pageID: resolvedPageID, edges: edges)
    )
  }

  private static func attributedText(from document: Document, object: ObjId) throws -> AttributedString {
    let plainText = try document.text(obj: object)
    var text = AttributedString(plainText)
    let length = UInt64(plainText.unicodeScalars.count)

    for mark in try document.marks(obj: object) {
      guard mark.start < mark.end, mark.end <= length else { continue }
      let range = text.index(text.startIndex, offsetByUnicodeScalars: Int(mark.start))
        ..< text.index(text.startIndex, offsetByUnicodeScalars: Int(mark.end))
      let richTextMark = PageRichTextMark(name: mark.name, value: richTextValue(from: mark.value))
      appendAutomergeMark(richTextMark, to: &text, in: range)
      applyPresentationIntent(for: mark.name, to: &text, in: range)
    }

    return text
  }

  private static func replaceTextAndMarks(
    in document: Document,
    object: ObjId,
    with richText: AttributedString
  ) throws {
    let previousText = try document.text(obj: object)
    let previousLength = UInt64(previousText.unicodeScalars.count)
    let markNames = Set(try document.marks(obj: object).map(\.name))
    for markName in markNames where previousLength > 0 {
      try document.mark(
        obj: object,
        start: 0,
        end: previousLength,
        expand: .none,
        name: markName,
        value: .Null
      )
    }

    let plainText = String(richText.characters)
    try document.updateText(obj: object, value: plainText)
    for mark in richTextMarks(in: richText) {
      try document.mark(
        obj: object,
        start: mark.start,
        end: mark.end,
        expand: .both,
        name: mark.name,
        value: mark.value
      )
    }
  }

  private static func richTextMarks(in text: AttributedString) -> [Mark] {
    var result: [Mark] = []
    var offset: UInt64 = 0

    for run in text.runs {
      let runText = String(text[run.range].characters)
      let length = UInt64(runText.unicodeScalars.count)
      defer { offset += length }
      guard length > 0 else { continue }

      var marks = (run[PageRichTextAttributes.AutomergeMarks.self] ?? []).filter {
        !inlineMarkNames.contains($0.name)
      }
      let presentationIntent = run.inlinePresentationIntent ?? []
      appendInlineMark(
        strongMark,
        intent: .stronglyEmphasized,
        presentationIntent: presentationIntent,
        to: &marks
      )
      appendInlineMark(
        emphasisMark,
        intent: .emphasized,
        presentationIntent: presentationIntent,
        to: &marks
      )
      appendInlineMark(
        strikethroughMark,
        intent: .strikethrough,
        presentationIntent: presentationIntent,
        to: &marks
      )
      appendInlineMark(
        codeMark,
        intent: .code,
        presentationIntent: presentationIntent,
        to: &marks
      )

      result.append(
        contentsOf: marks.map {
          Mark(start: offset, end: offset + length, name: $0.name, value: scalarValue(from: $0.value))
        }
      )
    }

    return result
  }

  private static let inlineMarkNames: Set<String> = [
    strongMark,
    emphasisMark,
    strikethroughMark,
    codeMark,
  ]

  private static func appendAutomergeMark(
    _ mark: PageRichTextMark,
    to text: inout AttributedString,
    in range: Range<AttributedString.Index>
  ) {
    let runRanges = text[range].runs.map(\.range)
    for runRange in runRanges {
      var persistedMarks = text[runRange][PageRichTextAttributes.AutomergeMarks.self] ?? []
      guard !persistedMarks.contains(mark) else { continue }
      persistedMarks.append(mark)
      text[runRange][PageRichTextAttributes.AutomergeMarks.self] = persistedMarks
    }
  }

  private static func appendInlineMark(
    _ name: String,
    intent: InlinePresentationIntent,
    presentationIntent: InlinePresentationIntent,
    to marks: inout [PageRichTextMark]
  ) {
    guard presentationIntent.contains(intent), !marks.contains(where: { $0.name == name }) else { return }
    marks.append(PageRichTextMark(name: name, value: .boolean(true)))
  }

  private static func applyPresentationIntent(
    for markName: String,
    to text: inout AttributedString,
    in range: Range<AttributedString.Index>
  ) {
    let intent: InlinePresentationIntent
    switch markName {
    case strongMark:
      intent = .stronglyEmphasized
    case emphasisMark:
      intent = .emphasized
    case strikethroughMark:
      intent = .strikethrough
    case codeMark:
      intent = .code
    default:
      return
    }
    var existing = text[range].inlinePresentationIntent ?? []
    existing.insert(intent)
    text[range].inlinePresentationIntent = existing
  }

  private static func richTextValue(from value: ScalarValue) -> PageRichTextMarkValue {
    switch value {
    case .Bytes(let value):
      .bytes(value)
    case .String(let value):
      .string(value)
    case .Uint(let value):
      .uint(value)
    case .Int(let value):
      .int(value)
    case .F64(let value):
      .floatingPoint(value)
    case .Counter(let value):
      .counter(value)
    case .Timestamp(let value):
      .timestamp(value)
    case .Boolean(let value):
      .boolean(value)
    case .Unknown(let typeCode, let data):
      .unknown(typeCode: typeCode, data: data)
    case .Null:
      .null
    }
  }

  private static func scalarValue(from value: PageRichTextMarkValue) -> ScalarValue {
    switch value {
    case .bytes(let value):
      .Bytes(value)
    case .string(let value):
      .String(value)
    case .uint(let value):
      .Uint(value)
    case .int(let value):
      .Int(value)
    case .floatingPoint(let value):
      .F64(value)
    case .counter(let value):
      .Counter(value)
    case .timestamp(let value):
      .Timestamp(value)
    case .boolean(let value):
      .Boolean(value)
    case .unknown(let typeCode, let data):
      .Unknown(typeCode: typeCode, data: data)
    case .null:
      .Null
    }
  }

  private static func setRelationship(
    key: SupertagPropertyKey,
    values: [SupertagValue],
    in snapshot: Data
  ) throws -> (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection) {
    try mutateMetadata(in: snapshot, message: "Set \(key.fieldID.rawValue)") { document, tags, properties in
      try document.put(obj: tags, key: key.supertagID.rawValue, value: .Boolean(true))
      if try document.get(obj: properties, key: key.storageKey) != nil {
        try document.delete(obj: properties, key: key.storageKey)
      }
      try replaceRelationshipEdges(
        document,
        key: key,
        targets: values.compactMap { value in
          guard case .page(let pageID) = value else { return nil }
          return pageID
        }
      )
    }
  }

  private static func replaceRelationshipEdges(
    _ document: Document,
    key: SupertagPropertyKey,
    targets: [PageID]
  ) throws {
    let edges = try edgesObject(document)
    let relationID = BuiltInRelations.relationID(for: key)
    let sourceID = try resolvedPageID(document)
    let targetSet = Set(targets)
    var retainedTargets: Set<PageID> = []
    for (edgeID, _) in try document.mapEntries(obj: edges).sorted(by: { $0.0 < $1.0 }) {
      guard let edge = try decodedEdge(document, edges: edges, key: edgeID),
        edge.relationID == relationID
      else { continue }
      if targetSet.contains(edge.targetNodeID), retainedTargets.insert(edge.targetNodeID).inserted {
        continue
      }
      try document.delete(obj: edges, key: edgeID)
    }
    for target in targets where retainedTargets.insert(target).inserted {
      let edge = KnowledgeEdge(
        relationID: relationID,
        sourceNodeID: sourceID,
        targetNodeID: target
      )
      let encoded = try JSONEncoder.enchiridion.encode(edge)
      try document.put(
        obj: edges,
        key: edge.id.rawValue,
        value: .String(String(decoding: encoded, as: UTF8.self))
      )
    }
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

  private static func metadataObject(_ document: Document) throws -> ObjId {
    if case .Object(let object, .Map)? = try document.get(obj: .ROOT, key: "objectMetadata") {
      return object
    }
    let metadata = try document.putObject(obj: .ROOT, key: "objectMetadata", ty: .Map)
    try document.put(obj: metadata, key: "version", value: .Int(1))
    return metadata
  }

  private static func metadataObjects(_ document: Document) throws -> (tags: ObjId, values: ObjId) {
    let metadata = try metadataObject(document)
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

  private static func metadataProjection(
    _ document: Document,
    pageID: PageID,
    edges: [KnowledgeEdge]
  ) throws -> PageObjectMetadata {
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
    var relationshipKeys: Set<SupertagPropertyKey> = []
    for edge in edges where edge.sourceNodeID == pageID {
      guard let key = BuiltInRelations.propertyKey(for: edge.relationID) else { continue }
      relationshipKeys.insert(key)
      projected[key, default: []].append(.page(edge.targetNodeID))
    }
    for key in relationshipKeys {
      projected[key] = Array(Set(projected[key] ?? [])).sorted { $0.id < $1.id }
    }
    for key in projected.keys {
      guard let field = BuiltInSupertags.all
        .first(where: { $0.id == key.supertagID })?
        .fields.first(where: { $0.id == key.fieldID }),
        !field.allowsMultiple,
        let values = projected[key],
        values.count > 1,
        values.allSatisfy({ if case .page = $0 { true } else { false } })
      else { continue }
      conflicts.append(.init(key: key, candidates: values.map { [$0] }))
    }
    let personVisibility: PersonVisibility?
    if case .Scalar(.String(let value))? = try document.get(
      obj: metadata,
      key: "personVisibility"
    ) {
      personVisibility = PersonVisibility(rawValue: value)
    } else {
      personVisibility = nil
    }
    let personOrigin: PersonOrigin?
    if case .Scalar(.String(let value))? = try document.get(
      obj: metadata,
      key: "personOrigin"
    ) {
      personOrigin = PersonOrigin(rawValue: value)
    } else {
      personOrigin = nil
    }
    return PageObjectMetadata(
      supertagIDs: tagIDs,
      properties: projected,
      conflicts: conflicts.sorted { $0.id < $1.id },
      personVisibility: personVisibility,
      personOrigin: personOrigin
    )
  }

  private static func resolvedPageID(_ document: Document) throws -> PageID {
    guard case .Scalar(.String(let value))? = try document.get(obj: .ROOT, key: "pageID")
    else { throw PageDocumentError.invalidSchema }
    return PageID(rawValue: value)
  }

  private static func edgesObject(_ document: Document) throws -> ObjId {
    if case .Object(let object, .Map)? = try document.get(obj: .ROOT, key: "edges") {
      return object
    }
    return try document.putObject(obj: .ROOT, key: "edges", ty: .Map)
  }

  private static func decodedEdge(
    _ document: Document,
    edges: ObjId,
    key: String
  ) throws -> KnowledgeEdge? {
    let candidates: [KnowledgeEdge] = try document.getAll(obj: edges, key: key).compactMap { value in
      guard case .Scalar(.String(let json)) = value,
        let data = json.data(using: .utf8)
      else { return nil }
      return try? JSONDecoder.enchiridion.decode(KnowledgeEdge.self, from: data)
    }
    return candidates.sorted { lhs, rhs in
      let left = (try? String(data: JSONEncoder.enchiridion.encode(lhs), encoding: .utf8)) ?? ""
      let right = (try? String(data: JSONEncoder.enchiridion.encode(rhs), encoding: .utf8)) ?? ""
      return left < right
    }.first
  }

  private static func graphEdges(
    _ document: Document,
    pageID: PageID
  ) throws -> [KnowledgeEdge] {
    guard case .Object(let edges, .Map)? = try document.get(obj: .ROOT, key: "edges") else {
      return []
    }
    return try document.mapEntries(obj: edges).compactMap { key, _ in
      guard var edge = try decodedEdge(document, edges: edges, key: key) else { return nil }
      edge.sourceNodeID = pageID
      return edge
    }.sorted {
      if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
      return $0.id.rawValue < $1.id.rawValue
    }
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
