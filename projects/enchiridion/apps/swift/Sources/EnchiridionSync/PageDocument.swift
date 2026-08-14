// PageDocument.swift
// EnchiridionSync
//
// The CRDT doc shape + mutation/projection API for a single page, ported
// concept (not code) from the old app's
// apps/enchiridion/Sources/EnchiridionCore/PageDocument.swift, adapted from
// Automerge's snapshot-based API to loro-swift.
//
// WHY THIS LIVES IN EnchiridionSync, NOT EnchiridionCore (P1 task's open
// structural question):
//
// `EnchiridionSync` already depends on `EnchiridionCore` (Package.swift),
// so the reverse is circular — `PageDocument` cannot live in
// `EnchiridionCore` if it needs anything EnchiridionSync-side. It does:
// `CRDTEngine`'s protocol (CRDTEngine.swift) is deliberately
// write/export/import-oriented only — by design, per that file's header
// comment, "real reads go through projections, not the engine." But
// `PageDocument.projection(of:)` (below) *is* the thing that turns raw CRDT
// state into a projection — it needs to read map entries and text+marks
// directly, which the protocol has no vocabulary for (only
// `LoroEngine.debugTextContent` exists, and it's explicitly test-only, not
// part of the protocol). So this type talks to `Loro.LoroDoc` /
// `LoroMap` / `LoroText` directly (the same verified API surface
// LoroEngine.swift uses — see that file's header for the verification
// story), rather than going through `CRDTMutation`/`CRDTEngine`.
//
// This does NOT reintroduce Risk #1's exposure beyond what LoroEngine.swift
// already accepts: every loro-swift call below is one already verified and
// cited in LoroEngine.swift, or the same shape (e.g. `LoroMap.get`/
// `.getValue()` are the read-side counterparts of the write calls already
// used there). If Loro's Swift bindings are ever swapped for Automerge
// (the plan's stated escape hatch), this file — like LoroEngine.swift — is
// the one that would need a parallel Automerge-backed twin; `CRDTEngine`
// callers elsewhere (VaultSyncClient, the outbox) are unaffected either
// way, since they never see a concrete `LoroDoc`.
//
// DOC SHAPE ADAPTATION FROM THE OLD (AUTOMERGE) APP:
//
// The old app nested `objectMetadata` as an Automerge map object holding
// `version`/`tags`/`values` sub-maps plus `personVisibility`/
// `personOrigin`. `CRDTMutation.container` (and every `LoroDoc.getMap(id:)`
// call — see LoroEngineTests.swift's existing `mapSet(container:
// "objectMetadata", ...)` calls) addresses only ROOT containers by name —
// Loro's Swift bindings have no "nested path" addressing in the
// CRDT-engine-agnostic layer this codebase already established. Rather
// than fight that (e.g. by inserting a nested LoroMap container for
// "tags"/"values" inside a root "objectMetadata" map, which `CRDTMutation`
// could never address anyway), this file flattens the old nesting into
// five root containers: `root` (format/schemaVersion/pageID/kind/
// createdAt/deletedAt/isPinned), `objectMetadata` (version/
// personVisibility/personOrigin only now), `tags`, `values`, `edges` — plus
// `title`/`body` text containers, unchanged. This is a clean adaptation,
// not a compromise: Loro's actual doc model *is* "a small set of named
// root containers" (see LoroEngine's own file header), so this shape now
// matches the engine's real idiom instead of simulating Automerge's
// arbitrary object nesting on top of it.
//
// OPTIMISTIC CONCURRENCY (task point 8 — thought about, not blindly
// ported): the old app's `applyChanges(to:encodedChanges:advertisedHeads:)`
// rejected a write if the resulting Automerge heads didn't match a
// caller-advertised value. That existed as a data-integrity assertion, not
// a conflict-prevention gate — Automerge merges, like Loro merges, are
// commutative and never "conflict" in the OT/lock sense; the check caught
// garbled/mismatched change bytes, not concurrent-edit races. Loro's
// `LoroDoc.import(bytes:)` already reports exactly that class of problem
// through `ImportStatus.pending` (see `LoroEngine.importBytes`'s
// `hasPendingDependencies`), so there is no separate heads-equality gate
// here. What *is* provided is `PageDocument.versionMatches(_:in:)` — a
// pure convenience for a caller (an editor session, the outbox) that wants
// to detect "this snapshot changed underneath me since I last read it,"
// documented at its declaration below. It is never required before any
// mutation call.
//
// SIZE LIMITS (task point 7): Automerge's `encodeChangesSince(heads:)`
// gave an exact byte count for "the single change just committed." Loro's
// equivalent is `LoroDoc.export(mode: .updates(from: versionVectorBefore))`
// — the same mechanism `LoroEngine.exportUpdates` already uses for sync —
// so `mutate(_:_:)` below captures `doc.oplogVv()` before running the
// caller's mutation and diffs against it after, preserving the old app's
// exact two limits (20 MiB per document, 1 MiB per change) with a
// faithfully equivalent mechanism.

import EnchiridionCore
import Foundation
import Loro

// MARK: - Errors

public enum PageDocumentError: Error, LocalizedError, Equatable, Sendable {
  case documentTooLarge
  case changeTooLarge
  case invalidSchema
  case engineFailure(String)

  public var errorDescription: String? {
    switch self {
    case .documentTooLarge: "The page exceeds the 20 MiB document limit."
    case .changeTooLarge: "This edit exceeds the 1 MiB per-change limit."
    case .invalidSchema: "The page has an unsupported document schema."
    case .engineFailure(let message): "The CRDT engine reported an error: \(message)"
    }
  }
}

// MARK: - Version token

/// A page document's current version, opaque outside this file — an
/// encoded Loro `VersionVector` (see `LoroEngine.versionVector(of:)`, which
/// this mirrors exactly so a `PageDocumentVersion` and a live
/// `LoroEngine`-held document's version are always comparable byte-for-
/// -byte for the same logical state). NOT an "Automerge heads" equivalent
/// used as a merge precondition — see this file's header for why that gate
/// doesn't carry over to Loro.
public struct PageDocumentVersion: Codable, Hashable, Sendable {
  public var encoded: Data

  public init(encoded: Data) {
    self.encoded = encoded
  }

  public static let empty = PageDocumentVersion(encoded: Data())
}

/// The catalog fields embedded in every page document at creation time.
/// Sync uses this to introduce a locally-created page to Vault before sending
/// its bytes, without inventing a parallel source of truth for page kind or
/// creation time.
public struct PageDocumentMetadata: Hashable, Sendable {
  public let pageID: PageID
  public let kind: PageKind
  public let createdAt: Date

  public init(pageID: PageID, kind: PageKind, createdAt: Date) {
    self.pageID = pageID
    self.kind = kind
    self.createdAt = createdAt
  }
}

// MARK: - Projection

/// Everything the rest of the app (a future `EnchiridionStore` GRDB
/// projection, the page editor) needs from a page document without
/// touching Loro directly. Ported concept from the old app's
/// `PageDocumentProjection`.
public struct PageDocumentProjection: Hashable, Sendable {
  public var title: String
  public var plainText: String
  public var deletedAt: Date?
  public var isPinned: Bool
  public var references: [PageReference]
  /// Every non-`.pageReference` `LoroEngine.MarkStyle` span in the body
  /// text (bold/italic/underline/strikethrough/code), extracted from the
  /// same delta walk as `references`. One run per style per contiguous
  /// styled span — an overlapping bold+italic range produces two runs
  /// (one `.bold`, one `.italic`), both covering that range, not one
  /// merged/ambiguous run. Empty when the body has no formatting, never
  /// omitted. `range` is a `Range<Int>` of Unicode Scalar offsets into
  /// `plainText` — the same convention `PageDocument.mark`'s `range:
  /// Range<UInt32>` and Loro's `LoroText` positions already use (see
  /// `PageDocumentTests.testPageReferenceMarkIsExtractedAsAReference`'s
  /// "unicode scalars" comment), matching EnchiridionUI's
  /// `UnicodeScalarOffsets.swift` convention rather than reinventing one.
  ///
  /// Breadcrumb for a follow-up task: `EnchiridionUI/PageEditorBody.swift`'s
  /// `from(projection:)` currently starts every loaded page with empty
  /// formatting marks (`MarkRun(range: 0..<text.scalarCount, styles: [])`)
  /// as a workaround for this field not existing — it should be updated to
  /// consume `formattingMarks` instead. Not done here; left to that task.
  public var formattingMarks: [FormattingMarkRun]
  /// Every `attachmentMark` span in the body text — P7 "native drawing
  /// canvas" task. Extracted from the same delta walk as `references`/
  /// `formattingMarks`. See `PageAttachment`'s doc comment
  /// (`EnchiridionCore/PageModels.swift`) for the shape and why it (unlike
  /// `references`) carries an exact position.
  public var attachments: [PageAttachment]
  public var graphEdges: [KnowledgeEdge]
  public var objectMetadata: PageObjectMetadata

  public init(
    title: String,
    plainText: String,
    deletedAt: Date?,
    isPinned: Bool,
    references: [PageReference],
    formattingMarks: [FormattingMarkRun] = [],
    attachments: [PageAttachment] = [],
    graphEdges: [KnowledgeEdge],
    objectMetadata: PageObjectMetadata
  ) {
    self.title = title
    self.plainText = plainText
    self.deletedAt = deletedAt
    self.isPinned = isPinned
    self.references = references
    self.formattingMarks = formattingMarks
    self.attachments = attachments
    self.graphEdges = graphEdges
    self.objectMetadata = objectMetadata
  }
}

/// A page-reference mark's decoded payload. Ported concept from the old
/// app's `PageReferenceDestination`.
public struct PageReferenceDestination: Hashable, Sendable {
  public let pageID: PageID
  public let label: String

  public init(pageID: PageID, label: String) {
    self.pageID = pageID
    self.label = label
  }
}

/// One contiguous, single-style formatting-mark span in a page's body text,
/// as reported by `PageDocumentProjection.formattingMarks`. `style` is
/// always one of `LoroEngine.MarkStyle`'s non-`.pageReference` cases
/// (`.bold`/`.italic`/`.underline`/`.strikethrough`/`.code`) — page
/// references are reported separately via `PageReference`, since they carry
/// a destination payload rather than being a bare on/off style.
public struct FormattingMarkRun: Hashable, Sendable {
  public var style: LoroEngine.MarkStyle
  /// Unicode Scalar offset range into `PageDocumentProjection.plainText` —
  /// see that field's doc comment for the exact convention.
  public var range: Range<Int>

  public init(style: LoroEngine.MarkStyle, range: Range<Int>) {
    self.style = style
    self.range = range
  }
}

/// The named text containers a page document has. Ported concept from the
/// old app's `"title"`/`"body"` root keys.
public enum PageTextContainer: String, Sendable {
  case title
  case body
}

// MARK: - PageDocument

/// Snapshot-in/snapshot-out functions over a single page's Loro document —
/// the Loro-backed equivalent of the old app's `PageDocument` enum. Every
/// mutating function here takes the page's current `Data` snapshot (a
/// `LoroDoc.exportSnapshot()` result) and returns a new one, mirroring the
/// old app's exact call shape so callers porting from it need to change
/// import statements and payload shapes, not control flow.
///
/// Deliberately out of scope for this port (see PageModels.swift's header
/// for the full list): bookmark capture events, meeting transcripts,
/// `SupertagConflict`, and the full `BuiltInRelations` declared-relation
/// table — none of those are part of the P1 task this file implements.
/// `SupertagConflict` specifically: PageModels.swift's header has the full,
/// independently-verified investigation (loro-swift/loro-rust API surface,
/// why a merge-time heuristic wasn't implemented here, and what would need
/// to be true to add one) — this is not just "not ported," it's a
/// documented, reasoned decision with a recommended follow-up.
public enum PageDocument {
  public static let format = "enchiridion/page"
  public static let schemaVersion = 1
  public static let maximumDocumentBytes = 20 * 1_024 * 1_024
  public static let maximumChangeBytes = 1 * 1_024 * 1_024

  /// Mark name aliases matching the old app's naming, mapped onto
  /// `LoroEngine.MarkStyle`'s already-pre-registered vocabulary (task
  /// point 2: verified the old app's mark set — strong/em/strike/code/
  /// page-reference — is already fully covered there under different
  /// names; `.underline` is the one style `LoroEngine` has that the old
  /// app didn't, left available for future rich-text work, not used here).
  public static let strongMark = LoroEngine.MarkStyle.bold
  public static let emphasisMark = LoroEngine.MarkStyle.italic
  public static let strikethroughMark = LoroEngine.MarkStyle.strikethrough
  public static let codeMark = LoroEngine.MarkStyle.code
  public static let pageReferenceMark = LoroEngine.MarkStyle.pageReference
  /// P7 "native drawing canvas" task's embed/attachment mark — see
  /// `addAttachmentMark(kind:blobID:...)` below.
  public static let attachmentMark = LoroEngine.MarkStyle.attachment

  private enum Container {
    static let root = "root"
    static let objectMetadata = "objectMetadata"
    static let tags = "tags"
    static let values = "values"
    static let edges = "edges"
  }

  public typealias MutationResult = (
    document: Data, version: PageDocumentVersion, projection: PageDocumentProjection
  )

  // MARK: Creation

  public static func create(
    id: PageID,
    kind: PageKind,
    title: String,
    createdAt: Date = Date()
  ) throws -> (document: Data, version: PageDocumentVersion) {
    let doc = LoroEngine.makeConfiguredDocument()
    do {
      let root = doc.getMap(id: Container.root)
      try root.insert(key: "format", v: format)
      try root.insert(key: "schemaVersion", v: Int64(schemaVersion))
      try root.insert(key: "pageID", v: id.rawValue)
      try root.insert(key: "kind", v: String(decoding: try encodeKind(kind), as: UTF8.self))
      try root.insert(key: "createdAt", v: createdAt.enchiridionISO8601)
      try root.insert(key: "isPinned", v: false)

      let metadata = doc.getMap(id: Container.objectMetadata)
      try metadata.insert(key: "version", v: Int64(1))

      if !title.isEmpty {
        try doc.getText(id: PageTextContainer.title.rawValue).insert(pos: 0, s: title)
      }
    } catch let error as PageDocumentError {
      throw error
    } catch {
      throw PageDocumentError.engineFailure(String(describing: error))
    }
    doc.commit()
    let saved = try export(doc)
    return (saved, version(of: doc))
  }

  // MARK: Text + marks

  public static func insertText(
    _ container: PageTextContainer,
    at position: UInt32,
    text: String,
    in snapshot: Data
  ) throws -> MutationResult {
    try mutate(snapshot) { doc in
      do {
        try doc.getText(id: container.rawValue).insert(pos: position, s: text)
      } catch {
        throw PageDocumentError.engineFailure(String(describing: error))
      }
    }
  }

  public static func deleteText(
    _ container: PageTextContainer,
    at position: UInt32,
    length: UInt32,
    in snapshot: Data
  ) throws -> MutationResult {
    try mutate(snapshot) { doc in
      do {
        try doc.getText(id: container.rawValue).delete(pos: position, len: length)
      } catch {
        throw PageDocumentError.engineFailure(String(describing: error))
      }
    }
  }

  /// Applies (`value != nil`) or clears (`value == nil`) a rich-text mark
  /// over `range` — `style` must be one of `LoroEngine.MarkStyle`'s
  /// pre-registered vocabulary, which every document this type creates is
  /// already configured for (see `LoroEngine.makeConfiguredDocument()`).
  public static func mark(
    _ container: PageTextContainer,
    range: Range<UInt32>,
    style: LoroEngine.MarkStyle,
    value: CRDTValue?,
    in snapshot: Data
  ) throws -> MutationResult {
    try mutate(snapshot) { doc in
      let text = doc.getText(id: container.rawValue)
      do {
        if let value {
          try text.mark(
            from: range.lowerBound, to: range.upperBound, key: style.rawValue,
            value: LoroEngine.loroValue(value))
        } else {
          try text.unmark(from: range.lowerBound, to: range.upperBound, key: style.rawValue)
        }
      } catch {
        throw PageDocumentError.engineFailure(String(describing: error))
      }
    }
  }

  /// Builds the mark payload for a page-reference span (`pageID` + a
  /// display-fallback `label`, JSON-encoded exactly like the old app's
  /// `pageReferenceMark(to:label:)`) and applies it over `range` in the
  /// body text in one step.
  public static func addPageReferenceMark(
    to pageID: PageID,
    label: String,
    range: Range<UInt32>,
    in snapshot: Data
  ) throws -> MutationResult {
    let payload: Data
    do {
      payload = try JSONEncoder.enchiridion.encode(
        PageReferenceValue(pageID: pageID.rawValue, label: label))
    } catch {
      throw PageDocumentError.invalidSchema
    }
    return try mark(
      .body, range: range, style: pageReferenceMark,
      value: .string(String(decoding: payload, as: UTF8.self)), in: snapshot)
  }

  /// Builds the mark payload for an inline attachment span (a canvas
  /// embed today; the same shape a future image attachment would use —
  /// see `PageAttachment`'s doc comment in `EnchiridionCore/PageModels.swift`)
  /// and applies it over `range` in the given text container in one step.
  ///
  /// `range` must cover at least one already-inserted character — like
  /// every Loro text mark, `text.mark(from:to:...)` over a truly empty
  /// range (`range.isEmpty`) has no persisted, observable effect: a mark's
  /// existence is only ever visible via `toDelta()`'s per-insert
  /// `attributes`, and an empty range covers zero inserted characters (see
  /// `PageDocument.plainTextAndReferences`'s delta walk — it can only ever
  /// report a mark over content that was actually inserted). This is not
  /// a limitation specific to attachments — `addPageReferenceMark` has the
  /// exact same requirement, just less visible because its callers always
  /// happen to have real label text under the range already. Callers that
  /// want a bare, non-textual embed (a canvas page's own body, which is
  /// otherwise empty) must first `insertText` a placeholder run — e.g. one
  /// `"\u{FFFC}"` (OBJECT REPLACEMENT CHARACTER, the same placeholder
  /// convention `NSTextAttachment`-based rich text uses for this exact
  /// purpose) — and mark exactly that inserted range. See
  /// `EnchiridionCanvas/CanvasPageAttachment.swift`'s
  /// `embedNewCanvasPage(...)` for the real caller doing this.
  ///
  /// `container` defaults to `.body` (mirrors `addPageReferenceMark`,
  /// which is hardcoded to `.body`) but is a parameter here, not hardcoded
  /// — a canvas *page*'s own attachment mark is naturally applied to its
  /// `.body` too, so the default covers both call shapes without forcing
  /// a caller to repeat `.body` explicitly.
  public static func addAttachmentMark(
    kind: String,
    blobID: String,
    width: Double? = nil,
    height: Double? = nil,
    mimeType: String? = nil,
    range: Range<UInt32>,
    in container: PageTextContainer = .body,
    snapshot: Data
  ) throws -> MutationResult {
    let payload: Data
    do {
      payload = try JSONEncoder.enchiridion.encode(
        AttachmentMarkValue(
          kind: kind, blobID: blobID, width: width, height: height, mimeType: mimeType))
    } catch {
      throw PageDocumentError.invalidSchema
    }
    return try mark(
      container, range: range, style: attachmentMark,
      value: .string(String(decoding: payload, as: UTF8.self)), in: snapshot)
  }

  // MARK: Supertags

  public static func addSupertag(
    _ supertagID: SupertagID,
    in snapshot: Data
  ) throws -> MutationResult {
    try mutate(snapshot) { doc in
      try ensureSupertag(supertagID, in: doc)
    }
  }

  public static func removeSupertag(
    _ supertagID: SupertagID,
    in snapshot: Data
  ) throws -> MutationResult {
    try mutate(snapshot) { doc in
      let tags = doc.getMap(id: Container.tags)
      let values = doc.getMap(id: Container.values)
      let edges = doc.getMap(id: Container.edges)
      do {
        if tags.get(key: supertagID.rawValue) != nil {
          try tags.delete(key: supertagID.rawValue)
        }
        let valuePrefix = "property:\(supertagID.rawValue):"
        for key in values.keys() where key.hasPrefix(valuePrefix) {
          try values.delete(key: key)
        }
        for (edgeKey, edge) in decodedEdges(from: edges) {
          guard let propertyKey = BuiltInRelations.propertyKey(for: edge.relationID),
            propertyKey.supertagID == supertagID
          else { continue }
          try edges.delete(key: edgeKey)
        }
      } catch {
        throw PageDocumentError.engineFailure(String(describing: error))
      }
    }
  }

  // MARK: Properties (the property/edge duality)

  /// Sets a supertag field's value(s). If `values` is non-empty and every
  /// element is `.page` (an entityReference field), this does NOT write a
  /// `values` entry — it writes canonical graph edges into the document's
  /// `edges` container instead (via `BuiltInRelations.relationID(for:)`'s
  /// synthetic key — see PageModels.swift's header for why that's the
  /// generic fallback, not a declared-relation lookup, today). Mixed or
  /// non-page values (including an empty array clearing the field) are
  /// stored as a plain JSON-encoded `values` entry. Matches the old app's
  /// exact detection rule.
  public static func setProperty(
    key: SupertagPropertyKey,
    values: [SupertagValue],
    in snapshot: Data
  ) throws -> MutationResult {
    let isRelationship = !values.isEmpty && values.allSatisfy(\.isPageReference)
    return try mutate(snapshot) { doc in
      try ensureSupertag(key.supertagID, in: doc)
      let valuesMap = doc.getMap(id: Container.values)
      if isRelationship {
        do {
          if valuesMap.get(key: key.storageKey) != nil {
            try valuesMap.delete(key: key.storageKey)
          }
        } catch {
          throw PageDocumentError.engineFailure(String(describing: error))
        }
        try replaceRelationshipEdges(
          in: doc, key: key,
          targets: values.compactMap { if case .page(let id) = $0 { id } else { nil } })
        return
      }
      try replaceRelationshipEdges(in: doc, key: key, targets: [])
      do {
        if values.isEmpty {
          if valuesMap.get(key: key.storageKey) != nil {
            try valuesMap.delete(key: key.storageKey)
          }
        } else {
          let data = try JSONEncoder.enchiridion.encode(values)
          try valuesMap.insert(key: key.storageKey, v: String(decoding: data, as: UTF8.self))
        }
      } catch {
        throw PageDocumentError.engineFailure(String(describing: error))
      }
    }
  }

  /// Batched `setProperty`, ensuring `supertagID` is present once for the
  /// whole batch. Ported concept from the old app's `setProperties`.
  public static func setProperties(
    _ updates: [SupertagPropertyKey: [SupertagValue]],
    ensuring supertagID: SupertagID,
    in snapshot: Data
  ) throws -> MutationResult {
    try mutate(snapshot) { doc in
      try ensureSupertag(supertagID, in: doc)
      let valuesMap = doc.getMap(id: Container.values)
      for key in updates.keys.sorted(by: { $0.storageKey < $1.storageKey }) {
        let values = updates[key] ?? []
        let isRelationship = !values.isEmpty && values.allSatisfy(\.isPageReference)
        if isRelationship {
          try replaceRelationshipEdges(
            in: doc, key: key,
            targets: values.compactMap { if case .page(let id) = $0 { id } else { nil } })
          do {
            if valuesMap.get(key: key.storageKey) != nil {
              try valuesMap.delete(key: key.storageKey)
            }
          } catch {
            throw PageDocumentError.engineFailure(String(describing: error))
          }
          continue
        }
        try replaceRelationshipEdges(in: doc, key: key, targets: [])
        do {
          if values.isEmpty {
            if valuesMap.get(key: key.storageKey) != nil {
              try valuesMap.delete(key: key.storageKey)
            }
          } else {
            let data = try JSONEncoder.enchiridion.encode(values)
            try valuesMap.insert(key: key.storageKey, v: String(decoding: data, as: UTF8.self))
          }
        } catch {
          throw PageDocumentError.engineFailure(String(describing: error))
        }
      }
    }
  }

  // MARK: Page-level flags

  public static func setPinned(_ pinned: Bool, in snapshot: Data) throws -> MutationResult {
    try mutate(snapshot) { doc in
      do {
        try doc.getMap(id: Container.root).insert(key: "isPinned", v: pinned)
      } catch {
        throw PageDocumentError.engineFailure(String(describing: error))
      }
    }
  }

  public static func setDeleted(_ deletedAt: Date?, in snapshot: Data) throws -> MutationResult {
    try mutate(snapshot) { doc in
      let root = doc.getMap(id: Container.root)
      do {
        if let deletedAt {
          try root.insert(key: "deletedAt", v: deletedAt.enchiridionISO8601)
        } else if root.get(key: "deletedAt") != nil {
          try root.delete(key: "deletedAt")
        }
      } catch {
        throw PageDocumentError.engineFailure(String(describing: error))
      }
    }
  }

  // MARK: Merge (two-replica convergence)

  /// Merges `remote` bytes (an update or a full snapshot — Loro
  /// distinguishes by content, same as `CRDTEngine.importBytes`) into
  /// `local`. Real Loro CRDT merge, not the sync protocol's wall-clock LWW
  /// simplification the plan documents for `vault-meta` — this is
  /// per-page content, which always merges via genuine CRDT semantics.
  public static func merge(
    local: Data,
    remote: Data
  ) throws -> MutationResult {
    guard local.count <= maximumDocumentBytes, remote.count <= maximumDocumentBytes else {
      throw PageDocumentError.documentTooLarge
    }
    let doc = try loadedDocument(from: local)
    do {
      _ = try doc.`import`(bytes: remote)
    } catch {
      throw PageDocumentError.engineFailure(String(describing: error))
    }
    doc.commit()
    let saved = try export(doc)
    return (saved, version(of: doc), try projection(doc))
  }

  // MARK: Projection

  public static func projection(of snapshot: Data) throws -> PageDocumentProjection {
    try projection(try loadedDocument(from: snapshot))
  }

  /// Returns the immutable catalog identity stored in `snapshot`. The
  /// returned values are used to form a `CatalogEntry` before a native client
  /// uploads a locally-created page to Vault.
  public static func metadata(of snapshot: Data) throws -> PageDocumentMetadata {
    let root = scalarMap(try loadedDocument(from: snapshot).getMap(id: Container.root))
    guard
      case .string(let pageIDRaw)? = root["pageID"],
      case .string(let kindJSON)? = root["kind"],
      let kindData = kindJSON.data(using: .utf8),
      let kind = try? JSONDecoder.enchiridion.decode(PageKind.self, from: kindData),
      let createdAt = stringValue(root["createdAt"]).flatMap(Date.fromEnchiridionISO8601)
    else {
      throw PageDocumentError.invalidSchema
    }
    return PageDocumentMetadata(pageID: PageID(rawValue: pageIDRaw), kind: kind, createdAt: createdAt)
  }

  /// See this file's header for why this is a pure application-level
  /// convenience, never a required precondition for any mutation above.
  public static func versionMatches(_ expected: PageDocumentVersion, in snapshot: Data) throws -> Bool {
    try version(of: loadedDocument(from: snapshot)) == expected
  }

  public static func currentVersion(of snapshot: Data) throws -> PageDocumentVersion {
    try version(of: loadedDocument(from: snapshot))
  }

  // MARK: - Internals

  private static func ensureSupertag(_ supertagID: SupertagID, in doc: LoroDoc) throws {
    do {
      try doc.getMap(id: Container.tags).insert(key: supertagID.rawValue, v: true)
    } catch {
      throw PageDocumentError.engineFailure(String(describing: error))
    }
  }

  private static func replaceRelationshipEdges(
    in doc: LoroDoc,
    key: SupertagPropertyKey,
    targets: [PageID]
  ) throws {
    guard case .string(let sourceRaw)? = scalarMap(doc.getMap(id: Container.root))["pageID"] else {
      throw PageDocumentError.invalidSchema
    }
    let sourceID = PageID(rawValue: sourceRaw)
    let relationID = BuiltInRelations.relationID(for: key)
    let edges = doc.getMap(id: Container.edges)
    let targetSet = Set(targets)
    var retained: Set<PageID> = []

    for (edgeKey, edge) in decodedEdges(from: edges).sorted(by: { $0.0 < $1.0 })
    where edge.relationID == relationID {
      if targetSet.contains(edge.targetNodeID), retained.insert(edge.targetNodeID).inserted {
        continue
      }
      do {
        try edges.delete(key: edgeKey)
      } catch {
        throw PageDocumentError.engineFailure(String(describing: error))
      }
    }

    for target in targets where retained.insert(target).inserted {
      let edge = KnowledgeEdge(
        relationID: relationID, sourceNodeID: sourceID, targetNodeID: target, origin: .user)
      do {
        let encoded = try JSONEncoder.enchiridion.encode(edge)
        try edges.insert(key: edge.id.rawValue, v: String(decoding: encoded, as: UTF8.self))
      } catch {
        throw PageDocumentError.engineFailure(String(describing: error))
      }
    }
  }

  /// Loads a snapshot into a freshly configured `LoroDoc` and validates its
  /// root shape. An empty `snapshot` (the not-yet-created case) is treated
  /// as an empty, unconfigured document rather than an error — callers
  /// that need an existing page should have gone through `create` first;
  /// this tolerance exists so `projection(of:)` etc. never crash on a
  /// caller mistake, they just report `.invalidSchema`.
  private static func loadedDocument(from snapshot: Data) throws -> LoroDoc {
    guard snapshot.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    let doc = LoroEngine.makeConfiguredDocument()
    if !snapshot.isEmpty {
      do {
        _ = try doc.`import`(bytes: snapshot)
      } catch {
        throw PageDocumentError.engineFailure(String(describing: error))
      }
    }
    try validate(doc)
    return doc
  }

  private static func validate(_ doc: LoroDoc) throws {
    let root = scalarMap(doc.getMap(id: Container.root))
    guard case .string(let storedFormat)? = root["format"], storedFormat == format,
      let versionValue = root["schemaVersion"], isSupportedVersion(versionValue),
      case .string? = root["pageID"]
    else {
      throw PageDocumentError.invalidSchema
    }
  }

  private static func isSupportedVersion(_ value: LoroValue) -> Bool {
    switch value {
    case .i64(let version): (1...Int64(schemaVersion)).contains(version)
    case .double(let version):
      version.rounded() == version && (1...Double(schemaVersion)).contains(version)
    default: false
    }
  }

  /// Runs `body` against a freshly loaded document, committing, then
  /// enforces the 1 MiB-per-change / 20 MiB-per-document limits (see this
  /// file's header) before returning the new snapshot + version +
  /// projection. Every public mutation function above is a thin wrapper
  /// around this.
  private static func mutate(
    _ snapshot: Data,
    _ body: (LoroDoc) throws -> Void
  ) throws -> MutationResult {
    let doc = try loadedDocument(from: snapshot)
    let versionVectorBefore = doc.oplogVv()
    try body(doc)
    doc.commit()

    let changeBytes: Data
    do {
      changeBytes = try doc.export(mode: .updates(from: versionVectorBefore))
    } catch {
      throw PageDocumentError.engineFailure(String(describing: error))
    }
    guard changeBytes.count <= maximumChangeBytes else { throw PageDocumentError.changeTooLarge }

    let saved = try export(doc)
    return (saved, version(of: doc), try projection(doc))
  }

  private static func export(_ doc: LoroDoc) throws -> Data {
    let saved: Data
    do {
      saved = try doc.exportSnapshot()
    } catch {
      throw PageDocumentError.engineFailure(String(describing: error))
    }
    guard saved.count <= maximumDocumentBytes else { throw PageDocumentError.documentTooLarge }
    return saved
  }

  private static func version(of doc: LoroDoc) -> PageDocumentVersion {
    PageDocumentVersion(encoded: doc.oplogVv().encode())
  }

  private static func encodeKind(_ kind: PageKind) throws -> Data {
    do {
      return try JSONEncoder.enchiridion.encode(kind)
    } catch {
      throw PageDocumentError.invalidSchema
    }
  }

  // MARK: - Reads

  private static func projection(_ doc: LoroDoc) throws -> PageDocumentProjection {
    let root = scalarMap(doc.getMap(id: Container.root))
    guard case .string(let pageIDRaw)? = root["pageID"] else {
      throw PageDocumentError.invalidSchema
    }
    let pageID = PageID(rawValue: pageIDRaw)

    let title = doc.getText(id: PageTextContainer.title.rawValue).toString()
    let (plainText, references, formattingMarks, attachments) = plainTextAndReferences(
      from: doc.getText(id: PageTextContainer.body.rawValue), sourcePageID: pageID)
    let deletedAt = stringValue(root["deletedAt"]).flatMap(Date.fromEnchiridionISO8601)
    let isPinned = boolValue(root["isPinned"]) ?? false
    let edges = graphEdges(doc, pageID: pageID)

    return PageDocumentProjection(
      title: title,
      plainText: plainText,
      deletedAt: deletedAt,
      isPinned: isPinned,
      references: references,
      formattingMarks: formattingMarks,
      attachments: attachments,
      graphEdges: edges,
      objectMetadata: objectMetadataProjection(doc, pageID: pageID, edges: edges)
    )
  }

  /// The `LoroEngine.MarkStyle` cases this walk reports as
  /// `FormattingMarkRun`s — every registered style except `.pageReference`
  /// and `.attachment`, both of which are reported separately (as
  /// `PageReference`/`PageAttachment`, via their own dedicated tracking
  /// below) because they carry a payload, not a bare on/off bit.
  private static let formattingMarkStyles: [LoroEngine.MarkStyle] =
    LoroEngine.MarkStyle.allCases.filter { $0 != pageReferenceMark && $0 != attachmentMark }

  private static func plainTextAndReferences(
    from text: LoroText,
    sourcePageID: PageID
  ) -> (
    plainText: String, references: [PageReference], formattingMarks: [FormattingMarkRun],
    attachments: [PageAttachment]
  ) {
    var plainText = ""
    var references: [PageReference] = []
    var seen: Set<PageID> = []

    // One open-run start offset per style, keyed by style — a style is
    // "open" from the scalar offset it first became active in this walk
    // until the first subsequent delta segment where it's no longer
    // present in `attributes`. Since `text.toDelta()`'s insert segments
    // partition `[0, plainText.scalarCount)` contiguously with no gaps,
    // a style still open at the end of one segment and active at the
    // start of the next is exactly one uninterrupted styled span — no
    // separate "merge adjacent runs" pass is needed. Overlapping styles
    // (e.g. bold AND italic over the same span) are tracked independently
    // per style, so they naturally close into two separate
    // `FormattingMarkRun`s covering the same range, never one merged run.
    var openRunStart: [LoroEngine.MarkStyle: Int] = [:]
    var formattingMarks: [FormattingMarkRun] = []

    // Attachment runs are tracked like formatting-mark runs (contiguous
    // "active" span), but ALSO close early if the mark *value* changes
    // between two adjacent delta segments (two different embeds placed
    // back-to-back with no plain-text gap between their placeholder
    // runs) — unlike a formatting style's bare boolean, an attachment
    // mark's value (blobID/kind/...) genuinely varies between distinct
    // embeds, so "still active" alone isn't enough to say "still the same
    // attachment".
    var openAttachment: (start: Int, value: LoroValue)?
    var attachments: [PageAttachment] = []
    func closeAttachment(at offset: Int) {
      guard let open = openAttachment else { return }
      openAttachment = nil
      guard
        let attachment = decodedAttachment(
          fromMarkValue: open.value, sourcePageID: sourcePageID, range: open.start..<offset)
      else { return }
      attachments.append(attachment)
    }

    var scalarOffset = 0

    for delta in text.toDelta() {
      guard case .insert(let inserted, let attributes) = delta else { continue }
      plainText += inserted
      let scalarLength = inserted.unicodeScalars.count

      for style in formattingMarkStyles {
        let isActive = attributes?[style.rawValue] != nil
        switch (isActive, openRunStart[style]) {
        case (true, .none):
          openRunStart[style] = scalarOffset
        case (false, .some(let start)):
          formattingMarks.append(FormattingMarkRun(style: style, range: start..<scalarOffset))
          openRunStart[style] = nil
        case (true, .some), (false, .none):
          break
        }
      }

      if let attachmentValue = attributes?[attachmentMark.rawValue] {
        if let open = openAttachment, open.value != attachmentValue {
          closeAttachment(at: scalarOffset)
        }
        if openAttachment == nil {
          openAttachment = (scalarOffset, attachmentValue)
        }
      } else {
        closeAttachment(at: scalarOffset)
      }

      scalarOffset += scalarLength

      guard let attributes, let markValue = attributes[pageReferenceMark.rawValue],
        let destination = pageReferenceDestination(fromMarkValue: markValue),
        seen.insert(destination.pageID).inserted
      else { continue }
      references.append(
        PageReference(
          sourcePageID: sourcePageID, targetPageID: destination.pageID,
          fallbackLabel: destination.label))
    }

    // Close any styles/attachment still open at the end of the text (a
    // mark spanning through to the last character never sees a "no longer
    // active" segment to trigger the close above).
    for (style, start) in openRunStart {
      formattingMarks.append(FormattingMarkRun(style: style, range: start..<scalarOffset))
    }
    closeAttachment(at: scalarOffset)
    formattingMarks.sort { lhs, rhs in
      if lhs.range.lowerBound != rhs.range.lowerBound {
        return lhs.range.lowerBound < rhs.range.lowerBound
      }
      return lhs.style.rawValue < rhs.style.rawValue
    }
    attachments.sort { $0.range.lowerBound < $1.range.lowerBound }

    return (plainText, references, formattingMarks, attachments)
  }

  private static func pageReferenceDestination(fromMarkValue value: LoroValue) -> PageReferenceDestination? {
    guard case .string(let json) = value,
      let data = json.data(using: .utf8),
      let decoded = try? JSONDecoder.enchiridion.decode(PageReferenceValue.self, from: data)
    else { return nil }
    return PageReferenceDestination(pageID: PageID(rawValue: decoded.pageID), label: decoded.label)
  }

  private static func decodedAttachment(
    fromMarkValue value: LoroValue,
    sourcePageID: PageID,
    range: Range<Int>
  ) -> PageAttachment? {
    guard case .string(let json) = value,
      let data = json.data(using: .utf8),
      let decoded = try? JSONDecoder.enchiridion.decode(AttachmentMarkValue.self, from: data)
    else { return nil }
    return PageAttachment(
      sourcePageID: sourcePageID, kind: decoded.kind, blobID: decoded.blobID, range: range,
      width: decoded.width, height: decoded.height, mimeType: decoded.mimeType)
  }

  private static func objectMetadataProjection(
    _ doc: LoroDoc,
    pageID: PageID,
    edges: [KnowledgeEdge]
  ) -> PageObjectMetadata {
    let tagsMap = scalarMap(doc.getMap(id: Container.tags))
    var supertagIDs: [SupertagID] = tagsMap.compactMap { key, value in
      guard case .bool(true) = value else { return nil }
      return SupertagID(rawValue: key)
    }
    supertagIDs.sort { $0.rawValue < $1.rawValue }

    var properties: [SupertagPropertyKey: [SupertagValue]] = [:]
    let valuesMap = scalarMap(doc.getMap(id: Container.values))
    for (storageKey, loroValue) in valuesMap {
      guard case .string(let json) = loroValue,
        let key = SupertagPropertyKey(storageKey: storageKey),
        let data = json.data(using: .utf8),
        let decoded = try? JSONDecoder.enchiridion.decode([SupertagValue].self, from: data)
      else { continue }
      properties[key] = decoded
    }

    var relationshipKeys: Set<SupertagPropertyKey> = []
    for edge in edges where edge.sourceNodeID == pageID {
      guard let key = BuiltInRelations.propertyKey(for: edge.relationID) else { continue }
      relationshipKeys.insert(key)
      properties[key, default: []].append(.page(edge.targetNodeID))
    }
    for key in relationshipKeys {
      properties[key] = Array(Set(properties[key] ?? [])).sorted { $0.id < $1.id }
    }

    let metadataMap = scalarMap(doc.getMap(id: Container.objectMetadata))
    let personVisibility = stringValue(metadataMap["personVisibility"])
      .flatMap(PersonVisibility.init(rawValue:))
    let personOrigin = stringValue(metadataMap["personOrigin"])
      .flatMap(PersonOrigin.init(rawValue:))

    return PageObjectMetadata(
      supertagIDs: supertagIDs,
      properties: properties,
      personVisibility: personVisibility,
      personOrigin: personOrigin
    )
  }

  private static func decodedEdges(from edges: LoroMap) -> [(key: String, edge: KnowledgeEdge)] {
    scalarMap(edges).compactMap { key, loroValue in
      guard case .string(let json) = loroValue,
        let data = json.data(using: .utf8),
        let edge = try? JSONDecoder.enchiridion.decode(KnowledgeEdge.self, from: data)
      else { return nil }
      return (key, edge)
    }
  }

  private static func graphEdges(_ doc: LoroDoc, pageID: PageID) -> [KnowledgeEdge] {
    decodedEdges(from: doc.getMap(id: Container.edges))
      .map { _, edge in
        var edge = edge
        edge.sourceNodeID = pageID
        return edge
      }
      .sorted {
        if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
        return $0.id.rawValue < $1.id.rawValue
      }
  }

  /// The shallow (non-recursive-into-containers) contents of a root map as
  /// plain `LoroValue`s — every container this file addresses (`root`,
  /// `objectMetadata`, `tags`, `values`, `edges`) holds only scalars, so
  /// `LoroMap.getValue()`'s shallow form (LoroFFI.swift: "It will not
  /// convert the state of sub-containers, but represent them as
  /// [LoroValue::Container]") is exactly the full, one-call read this
  /// needs — no per-key `get(key:)` round trips.
  private static func scalarMap(_ map: LoroMap) -> [String: LoroValue] {
    guard case .map(let value) = map.getValue() else { return [:] }
    return value
  }

  private static func stringValue(_ value: LoroValue?) -> String? {
    guard case .string(let value)? = value else { return nil }
    return value
  }

  private static func boolValue(_ value: LoroValue?) -> Bool? {
    guard case .bool(let value)? = value else { return nil }
    return value
  }
}

private struct PageReferenceValue: Codable {
  var pageID: String
  var label: String
}

/// `attachmentMark`'s JSON-encoded mark-value payload. Mirrors
/// `PageReferenceValue` above; decoded back into a `PageAttachment` by
/// `PageDocument.decodedAttachment(fromMarkValue:sourcePageID:range:)`.
private struct AttachmentMarkValue: Codable {
  var kind: String
  var blobID: String
  var width: Double?
  var height: Double?
  var mimeType: String?
}
