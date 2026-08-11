// PageModels.swift
// EnchiridionCore
//
// Plain-data page model, ported concept (not code) from the old app's
// apps/enchiridion/Sources/EnchiridionCore/{PageModels,GraphSchema,
// GraphOntology,SupertagModels,GraphIdentifiers}.swift.
//
// Scope note: this file carries only the shapes P1's `PageDocument` (see
// EnchiridionSync/PageDocument.swift — the CRDT-doc-owning layer, which is
// why it lives in EnchiridionSync and not here, see that file's header)
// needs to express a page's kind, its supertag properties, and canonical
// graph edges. It deliberately does NOT port:
// - `BuiltInSupertags`/`GraphOntology`'s full built-in relation table
//   (person.organization, project.area, ...) — that's `packages/schema` +
//   `supertags/core`'s job per the plan (TS, as-code, a separate
//   concurrently-running P1 task). `BuiltInRelations` below keeps only the
//   generic synthetic-key fallback mechanism, with a TODO to wire real
//   declared relations once Swift can see them.
// - `SupertagConflict` — the old app's Automerge-map-conflict-candidate
//   type, populated in the old `PageDocument.metadataProjection` by calling
//   Automerge's `document.getAll(obj:key:)`, which (unlike `get`, which
//   picks a deterministic winner) returns *every* concurrently-written
//   candidate value still present at that key. Old-app `GraphIssueKind`
//   only covers edge-shaped problems (`cardinalityViolation`,
//   `unresolvedTarget`, `invalidSourceType`, `invalidTargetType`,
//   `inheritanceCycle`) — `SupertagConflict` was a *separate* mechanism,
//   surfaced via `PageObjectMetadata.conflicts`, for concurrent writes to
//   the same scalar/select *property* storage key (and single-cardinality
//   `.page` property values), not for `graph_issues` rows.
//
//   INVESTIGATION (2026-08-06, dedicated task): independently verified,
//   not just trusting a prior negative finding, against loro-swift 1.13.3's
//   actual generated FFI (`Sources/Loro/LoroFFI.swift`, the same file
//   LoroEngine.swift's header cites) and loro-rust's source
//   (`crates/loro-internal/src/state/map_state.rs`,
//   `MapState::apply_diff_and_convert`): `LoroMap` keeps exactly one
//   `MapValue` per key, replaced only when an incoming write's
//   `(lamport, peer)` tuple is greater than the stored one; the losing
//   write's value is dropped, not retained. There is no `getAll`
//   equivalent, and confirmed via docs.rs: LoroMap's own doc-comment says
//   "It's LWW(Last-Write-Win) Map. It can support Multi-Value Map in the
//   future" — i.e. Loro's own maintainers treat this as a known future gap,
//   not a solved problem today. The event/diff API doesn't help either:
//   `Diff.map(diff: MapDelta)` and `MapDelta.updated: [String:
//   ValueOrContainer?]` carry only the post-merge winning value per
//   changed key, and a *losing* incoming write doesn't even appear in the
//   diff (the `apply_diff_and_convert` early-return means `changed` stays
//   false for it) — so capturing "what lost" at merge time via subscribe
//   isn't possible either. `LoroTree`/`LoroList`/`LoroMovableList` don't
//   help here: they solve concurrent *structural* edits (moves, ordered
//   inserts), not concurrent scalar-value writes to one property key.
//
//   The one signal LoroMap does expose is `getLastEditor(key:) -> UInt64?`
//   (a `PeerID`, confirmed present in the pinned loro-swift build at
//   LoroFFI.swift:6593) — "who most recently wrote this key," not "who
//   else concurrently tried." A merge-time heuristic built on it alone
//   (diff `getLastEditor`/value before vs. after `doc.import(bytes:)`,
//   flag a change as "possible conflict") was evaluated and REJECTED as
//   unsound: it cannot distinguish a genuine concurrent write from the
//   extremely common legitimate case of editing the same field
//   sequentially on two devices (edit on phone, sync, then edit again on
//   laptop) — both produce the identical observable
//   before-editor/after-editor transition, and PeerID alone carries no
//   causal-order information. Shipping that would flag routine multi-device
//   editing as "conflicts" far more often than real ones, eroding trust in
//   the signal. A *rigorous* version is possible in principle — Loro
//   exposes real causality primitives (`Id{peer,counter}`,
//   `VersionVector.includesId(id:)`, `oplogFrontiers()`,
//   `travelChangeAncestors(ids:f:)`) that could support a genuine
//   "was this key's prior local write already known to the incoming
//   writer?" ancestry check — but it requires the app to self-maintain a
//   companion per-key op-ID record (Loro doesn't expose a
//   key-scoped op `Id`, only `getLastEditor`'s bare `PeerID`), plus a real
//   ancestry walk in `merge()`. That is new, non-trivial, independently
//   testable engineering, not a small tweak, so it is NOT implemented here
//   — see the follow-up task write-up this investigation produced.
//
//   A further, independently-discovered blocker for ANY PeerID-based
//   scheme: `PageDocument`'s snapshot-in/snapshot-out design creates a
//   fresh `LoroDoc()` on every `mutate`/`merge` call (see `loadedDocument`
//   below) and never calls `setPeerId`. Loro assigns a new random PeerID to
//   every `LoroDoc()` instantiation ("A new peer ID is generated for each
//   LoroDoc instance, even when loading the same document" — loro.dev's
//   PeerID-management guidance) — so today, even the *same* device's two
//   successive edits show different `getLastEditor` peers. Any future
//   PeerID-based conflict signal needs a stable, persisted per-device
//   PeerID (`setPeerId` before every mutation) as a prerequisite; that is
//   also not implemented here — it's a separate architectural change with
//   its own design questions (where the ID is persisted, migration for
//   already-created docs) outside this investigation's scope.
//
//   NOT AFFECTED by any of the above: the *edge*-shaped conflict mechanism
//   GraphDataModel.md and the plan describe ("conflicting max-one edges
//   preserved and surfaced as graph issues") is a different code path and
//   remains fully intact under Loro. `PageDocument.replaceRelationshipEdges`
//   keys each edge by its own `EdgeID` in the `edges` map — two concurrent
//   writers proposing different targets for a max-one relation produce two
//   *distinct* map keys, which is not a same-key LWW race at all; both
//   edges survive the CRDT merge unmodified, exactly as they did in the old
//   Automerge app, and it's downstream cardinality-checking code's job
//   (ported from `GraphDatabase.swift`'s `.cardinalityViolation` logic,
//   not yet written — `packages/projection` is still a stub as of this
//   investigation) to turn "more than one edge for a max-one relation"
//   into a `graph_issues` row. Only concurrent writes to the SAME scalar/
//   select *property* storage key (`SupertagConflict`'s actual scope) are
//   degraded to silent LWW by this port.
//
//   RECOMMENDATION: neither option cleared this task's "small,
//   self-contained, low-risk" bar for implementing now, so nothing beyond
//   this documentation changed in this investigation. Of the two viable
//   paths (see the task write-up for full tradeoffs): prefer the rigorous
//   version-vector/causal-ancestry detector (`Id`/`includesId`/
//   `travelChangeAncestors`, once PeerID stability is fixed) as the next
//   concrete step over restructuring property storage as a
//   `LoroList<{value, peerID, timestamp}>` per field — the list-per-value
//   redesign is Loro-native and would faithfully reproduce the old app's
//   "show every candidate" UX, but it changes the doc's on-wire shape,
//   `packages/schema`'s field-type model, and `packages/projection`'s
//   extraction logic all at once, which is real cross-package design work,
//   not a `PageDocument.swift`-local fix.
// - Bookmark capture events / meeting transcripts / `PageSnapshot`'s
//   repository-row fields (dirtyGeneration, etc.) — out of this task's
//   scope (see the P1 task description); `PageDocumentProjection` in
//   PageDocument.swift is the thing `EnchiridionStore`'s future GRDB
//   projection and the page editor actually consume.

import Foundation

// MARK: - Cross-reference aliases

/// The one node type in the Enchiridion graph is a page. Ported concept
/// from the old app's `GraphIdentifiers.swift` (`public typealias NodeID =
/// PageID`) — kept as a distinct name where code is *about the graph*
/// (edges, relations) even though it is exactly `PageID`.
public typealias NodeID = PageID

/// Ported concept from the old app's `public typealias TagID = SupertagID`.
public typealias TagID = SupertagID

// MARK: - Calendar identities (P2 shape, not yet constructed)

/// Ported concept from the old app's `CalendarSeriesIdentity`. Nothing
/// constructs `PageKind.calendarSeries` yet (no gatekeeper exists before
/// P2) — this exists now so the `PageKind` shape doesn't need a breaking
/// change when P2 lands.
public struct CalendarSeriesIdentity: Codable, Hashable, Sendable {
  public var provider: String
  public var externalIdentifier: String
  public var disambiguator: String?
  public var crossProviderIdentifier: String?
  public var canonicalIdentifier: String?

  public init(
    provider: String,
    externalIdentifier: String,
    disambiguator: String? = nil,
    crossProviderIdentifier: String? = nil,
    canonicalIdentifier: String? = nil
  ) {
    self.provider = provider
    self.externalIdentifier = externalIdentifier
    self.disambiguator = disambiguator
    self.crossProviderIdentifier = crossProviderIdentifier
    self.canonicalIdentifier = canonicalIdentifier
  }

  public var sourceKey: String {
    [provider, externalIdentifier, disambiguator ?? ""].joined(separator: "\u{0}")
  }

  public var preferredCanonicalKey: String {
    if let value = crossProviderIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
      !value.isEmpty
    {
      return "ical\u{0}\(value.lowercased())"
    }
    return sourceKey
  }

  public var canonicalKey: String {
    canonicalIdentifier ?? preferredCanonicalKey
  }
}

/// Ported concept from the old app's `CalendarEventIdentity`.
public struct CalendarEventIdentity: Codable, Hashable, Sendable {
  public var provider: String
  public var externalIdentifier: String
  public var occurrenceStart: Date
  public var disambiguator: String?
  public var localIdentifierHint: String?
  public var series: CalendarSeriesIdentity?

  public init(
    provider: String = "eventkit",
    externalIdentifier: String,
    occurrenceStart: Date,
    disambiguator: String? = nil,
    localIdentifierHint: String? = nil,
    series: CalendarSeriesIdentity? = nil
  ) {
    self.provider = provider
    self.externalIdentifier = externalIdentifier
    self.occurrenceStart = occurrenceStart
    self.disambiguator = disambiguator
    self.localIdentifierHint = localIdentifierHint
    self.series = series
  }

  public var stableKey: String {
    let instant = occurrenceStart.enchiridionISO8601
    return [provider, externalIdentifier, instant, disambiguator ?? ""]
      .joined(separator: "\u{0}")
  }

  public var canonicalOccurrenceKey: String {
    guard let series else { return stableKey }
    return [series.canonicalKey, occurrenceStart.enchiridionISO8601]
      .joined(separator: "\u{0}")
  }
}

/// Ported concept from the old app's `CalendarMaterializedIdentity`. Cloud
/// -safe: `uidDigest` is a SHA-256 of the normalised iCalendar UID, so
/// neither an EventKit identifier nor a provider UID leaks into the graph
/// or a synced page — see `PageID.digestIdentified` in Identity.swift for
/// the derivation this identity feeds.
public struct CalendarMaterializedIdentity: Codable, Hashable, Sendable {
  public static let version = 1
  public var version: Int
  public var uidDigest: String
  public var occurrenceToken: String
  public var sourceScopeDigest: String?

  public init(
    version: Int = Self.version,
    uidDigest: String,
    occurrenceToken: String,
    sourceScopeDigest: String? = nil
  ) {
    self.version = version
    self.uidDigest = uidDigest
    self.occurrenceToken = occurrenceToken
    self.sourceScopeDigest = sourceScopeDigest
  }

  public var stableKey: String {
    ["calendar-materialized-v\(version)", uidDigest, occurrenceToken, sourceScopeDigest ?? ""]
      .joined(separator: "\u{0}")
  }
}

// MARK: - PageKind

/// What a page *is*, independent of its supertags. Ported concept from the
/// old app's `PageKind`. `.calendarEvent`/`.calendarSeries` are the
/// provider-facing, not-yet-cloud-safe intermediate shapes used during
/// materialization; `.calendarMaterializedEvent` is what actually gets
/// persisted (see `CalendarMaterializedIdentity`'s doc comment) — both
/// exist here, unconstructed, so P2 doesn't need a `PageKind` shape change.
public enum PageKind: Codable, Hashable, Sendable {
  case daily(DayKey)
  case free
  case calendarEvent(CalendarEventIdentity)
  case calendarSeries(CalendarSeriesIdentity)
  case calendarMaterializedEvent(CalendarMaterializedIdentity)
}

// MARK: - Page references (inline body-text links)

/// An inline `[[page]]`-style reference extracted from a page's body text.
/// Ported concept from the old app's `PageReference`.
public struct PageReference: Codable, Hashable, Sendable {
  public var sourcePageID: PageID
  public var targetPageID: PageID
  public var fallbackLabel: String

  public init(sourcePageID: PageID, targetPageID: PageID, fallbackLabel: String) {
    self.sourcePageID = sourcePageID
    self.targetPageID = targetPageID
    self.fallbackLabel = fallbackLabel
  }
}

/// An inline attachment span (an embedded canvas, and — per the P7 task
/// brief's "reusing whatever mechanism images already use" — the same
/// shape a future image attachment would use) extracted from a page's body
/// text. Ported concept from `PageReference` above, generalized: `kind` is
/// a free-form, small string identifying what the attachment IS
/// (`"canvas"` today; `EnchiridionCanvas/CanvasPageAttachment.swift`
/// defines that constant) rather than a closed enum here, so a future
/// attachment kind (an image, say) needs no `EnchiridionCore` change — only
/// a new kind constant in whichever module owns it.
///
/// Unlike `PageReference` (which has no position — see
/// `EnchiridionUI/PageEditorBody.swift`'s "breadcrumb for a follow-up
/// task" comment on why that's an approximation-by-necessity gap), this
/// type carries `range` directly: `PageDocument`'s mark-walk
/// (`EnchiridionSync/PageDocument.swift`) already has the exact Unicode
/// Scalar span available for free while it walks `LoroText.toDelta()`
/// (the same walk that produces `FormattingMarkRun.range`), so there is no
/// reason to drop it and force a later consumer to re-approximate it the
/// way `PageReference` unfortunately has to.
///
/// Never carries the attachment's bytes — only a `blobID` (a
/// `BlobID.rawValue` string; `EnchiridionCore` cannot reference the real
/// `BlobID` type without a circular dependency on `EnchiridionBlobs`,
/// which itself depends on `EnchiridionCore` — see
/// `EnchiridionBlobs/BlobReference.swift`) plus small display hints
/// (`width`/`height`/`mimeType`) a renderer can use before the blob has
/// downloaded.
public struct PageAttachment: Codable, Hashable, Sendable {
  public var sourcePageID: PageID
  /// What the attachment IS — e.g. `"canvas"`. Free-form (see this type's
  /// doc comment for why not a closed enum).
  public var kind: String
  /// `BlobID.rawValue` (`"blob_<sha256>"`) — the content-addressed
  /// reference to resolve via `EnchiridionBlobs.BlobCache`, never the
  /// bytes themselves.
  public var blobID: String
  /// Unicode Scalar offset range into the source page's body `plainText` —
  /// same convention as `FormattingMarkRun.range`.
  public var range: Range<Int>
  public var width: Double?
  public var height: Double?
  public var mimeType: String?

  public init(
    sourcePageID: PageID,
    kind: String,
    blobID: String,
    range: Range<Int>,
    width: Double? = nil,
    height: Double? = nil,
    mimeType: String? = nil
  ) {
    self.sourcePageID = sourcePageID
    self.kind = kind
    self.blobID = blobID
    self.range = range
    self.width = width
    self.height = height
    self.mimeType = mimeType
  }
}

// MARK: - Graph edges

/// Ported concept from the old app's `GraphIdentifiers.swift` `RelationID`.
public struct RelationID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }
}

/// Ported concept from the old app's `EdgeID`.
public struct EdgeID: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
  public let rawValue: String
  public var id: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }

  public static func random() -> Self {
    .init(rawValue: "edge_\(UUID().uuidString.lowercased())")
  }
}

/// Ported concept from the old app's `GraphEdgeOrigin`.
public enum GraphEdgeOrigin: String, Codable, Hashable, Sendable {
  case user
  case inlineReference
  case provider
  case system
}

/// A canonical, directed relationship between two pages, stored in a page
/// document's `edges` container. Ported concept from the old app's
/// `KnowledgeEdge`.
public struct KnowledgeEdge: Codable, Hashable, Sendable, Identifiable {
  public var id: EdgeID
  public var relationID: RelationID
  public var sourceNodeID: NodeID
  public var targetNodeID: NodeID
  public var origin: GraphEdgeOrigin
  public var createdAt: Date

  public init(
    id: EdgeID = .random(),
    relationID: RelationID,
    sourceNodeID: NodeID,
    targetNodeID: NodeID,
    origin: GraphEdgeOrigin = .user,
    createdAt: Date = Date()
  ) {
    self.id = id
    self.relationID = relationID
    self.sourceNodeID = sourceNodeID
    self.targetNodeID = targetNodeID
    self.origin = origin
    self.createdAt = Date(timeIntervalSince1970: createdAt.timeIntervalSince1970)
  }
}

/// Doc-level relation-ID derivation for the property/edge duality (see
/// `PageDocument.setProperty` in EnchiridionSync). This is deliberately
/// just the generic, synthetic-key mechanism — NOT a port of the old app's
/// `GraphOntology.BuiltInRelations`, which also hard-coded a table of
/// declared forward/inverse relation names (`person.organization`,
/// `project.area`, ...). That table is `packages/schema`'s job now
/// (supertag modules declare `relations:` as-code, per the plan's module
/// contract), and there is no TS-to-Swift schema sync yet (`packages/
/// codegen`'s job, also not this task) to expose those declarations here.
///
/// TODO(P1+, once a task wires generated relation definitions into
/// Swift — likely via `EnchiridionSchema`): resolve `key` against real
/// declared relations first, falling back to the synthetic scheme below
/// only for undeclared entityReference fields.
public enum BuiltInRelations {
  /// The synthetic key every entityReference-shaped property falls back to
  /// today: `property-relation:<tagID>:<fieldID>`. Matches the old app's
  /// documented fallback format exactly (`GraphOntology.swift`'s
  /// `default:` case), so a future switch to declared relations can
  /// recognize and migrate these without a format change.
  public static func relationID(for key: SupertagPropertyKey) -> RelationID {
    .init(rawValue: "property-relation:\(key.supertagID.rawValue):\(key.fieldID.rawValue)")
  }

  /// The inverse of `relationID(for:)` for synthetic keys — used by
  /// `PageDocument.projection` to fold `edges` entries back into
  /// `objectMetadata.properties`. Returns `nil` for anything not in the
  /// synthetic format (i.e. every declared relation, once those exist).
  public static func propertyKey(for relationID: RelationID) -> SupertagPropertyKey? {
    let prefix = "property-relation:"
    guard relationID.rawValue.hasPrefix(prefix) else { return nil }
    let rest = relationID.rawValue.dropFirst(prefix.count)
    guard let separator = rest.firstIndex(of: ":") else { return nil }
    return SupertagPropertyKey(
      supertagID: .init(rawValue: String(rest[..<separator])),
      fieldID: .init(rawValue: String(rest[rest.index(after: separator)...]))
    )
  }
}

// MARK: - Supertag properties

/// A single field's value. Ported concept from the old app's
/// `SupertagValue`. `.page` values are what trigger the property/edge
/// duality in `PageDocument.setProperty`.
public enum SupertagValue: Codable, Hashable, Sendable, Identifiable {
  case text(String)
  case number(Double)
  case boolean(Bool)
  case date(Date)
  case dateTime(Date)
  case select(String)
  case url(String)
  case email(String)
  case phone(String)
  case page(PageID)

  public var id: String {
    switch self {
    case .text(let value): "text:\(value)"
    case .number(let value): "number:\(value)"
    case .boolean(let value): "boolean:\(value)"
    case .date(let value): "date:\(value.timeIntervalSince1970)"
    case .dateTime(let value): "dateTime:\(value.timeIntervalSince1970)"
    case .select(let value): "select:\(value)"
    case .url(let value): "url:\(value)"
    case .email(let value): "email:\(value.lowercased())"
    case .phone(let value): "phone:\(value)"
    case .page(let value): "page:\(value.rawValue)"
    }
  }

  /// `true` for the shape `PageDocument.setProperty` treats as an
  /// entityReference — see that function's doc comment for the detection
  /// rule (all values `.page`, not just some).
  public var isPageReference: Bool {
    if case .page = self { return true }
    return false
  }
}

/// A field's identity, scoped to a supertag. Ported concept from the old
/// app's `SupertagPropertyKey`.
public struct SupertagPropertyKey: Codable, Hashable, Sendable {
  public var supertagID: SupertagID
  public var fieldID: SupertagFieldID

  public init(supertagID: SupertagID, fieldID: SupertagFieldID) {
    self.supertagID = supertagID
    self.fieldID = fieldID
  }

  /// The inverse of `storageKey` — parses a `values`-container CRDT map
  /// key back into its `(tagID, fieldID)` parts. `nil` for anything not in
  /// `PredicateID.property`'s `"property:<tagID>:<fieldID>"` format.
  public init?(storageKey: String) {
    let prefix = "property:"
    guard storageKey.hasPrefix(prefix) else { return nil }
    let rest = storageKey.dropFirst(prefix.count)
    guard let separator = rest.firstIndex(of: ":") else { return nil }
    self.supertagID = .init(rawValue: String(rest[..<separator]))
    self.fieldID = .init(rawValue: String(rest[rest.index(after: separator)...]))
  }

  /// The CRDT map key this field's plain-value form is stored under in a
  /// page document's `values` container — `Identity.swift`'s
  /// `PredicateID.property(tagID:fieldID:)` already documents this exact
  /// use, so this reuses it rather than re-deriving the same string a
  /// second way.
  public var storageKey: String {
    PredicateID.property(tagID: supertagID, fieldID: fieldID).rawValue
  }
}

/// A page's supertag membership and field values, projected from its CRDT
/// document. Ported concept from the old app's `PageObjectMetadata`
/// (`SupertagConflict` intentionally dropped — see file header).
public struct PageObjectMetadata: Codable, Hashable, Sendable {
  public var supertagIDs: [SupertagID]
  public var properties: [SupertagPropertyKey: [SupertagValue]]
  public var personVisibility: PersonVisibility?
  public var personOrigin: PersonOrigin?

  public init(
    supertagIDs: [SupertagID] = [],
    properties: [SupertagPropertyKey: [SupertagValue]] = [:],
    personVisibility: PersonVisibility? = nil,
    personOrigin: PersonOrigin? = nil
  ) {
    self.supertagIDs = supertagIDs
    self.properties = properties
    self.personVisibility = personVisibility
    self.personOrigin = personOrigin
  }
}

/// Ported concept from the old app's `PeopleModels.swift` `PersonVisibility`.
public enum PersonVisibility: String, Codable, CaseIterable, Hashable, Sendable {
  case other
  case promoted
}

/// Ported concept from the old app's `PeopleModels.swift` `PersonOrigin`.
public enum PersonOrigin: String, Codable, CaseIterable, Hashable, Sendable {
  case calendarAttendee
  case manual
}

// MARK: - Date <-> ISO8601 string (CRDT map values are scalars, not dates)

extension Date {
  static let enchiridionISO8601Style = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

  public var enchiridionISO8601: String {
    formatted(Self.enchiridionISO8601Style)
  }

  public static func fromEnchiridionISO8601(_ value: String) -> Date? {
    try? Date(value, strategy: enchiridionISO8601Style)
  }
}

// MARK: - JSON coding shared by EnchiridionCore and EnchiridionSync

/// Canonical JSON coding for values that get embedded as JSON strings
/// inside CRDT map entries (`SupertagValue` arrays, `KnowledgeEdge`,
/// `PageKind`) — sorted keys keep encoded bytes deterministic across
/// replicas encoding the same logical value, which matters for the
/// `1 MiB`-per-change size check comparing byte counts.
extension JSONEncoder {
  public static let enchiridion: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }()
}

extension JSONDecoder {
  public static let enchiridion: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }()
}
