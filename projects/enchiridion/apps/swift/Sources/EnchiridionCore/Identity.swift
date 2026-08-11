// Identity.swift
// EnchiridionCore
//
// Deterministic identity types ported (concept, not code) from
// apps/enchiridion/Sources/EnchiridionCore/{PageModels,GraphIdentifiers}.swift.
//
// Plan's "Critical invariant" (Backend architecture section): these IDs must
// be derived byte-for-byte identically to `packages/graph-core` (TS side),
// locked with cross-language golden tests in CI. That means the exact digest
// algorithm here (SHA-256, first 20 bytes, lowercase hex — 40 hex chars,
// mirroring the old app's `PageID.digest`) is load-bearing: do not change it
// without a matching change + golden test on the TS side.

import CryptoKit
import Foundation

/// Identifies a vault (one Loro doc set + one VaultDO on the backend).
///
/// Ported concept from the old app's `VaultID` (GraphIdentifiers.swift).
/// Enchiridion 2 drops the CloudKit zone-name responsibility (no CloudKit),
/// but keeps the identity shape so a future importer can key off it.
public struct VaultID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public static func random() -> Self {
    .init(rawValue: "vault_\(UUID().uuidString.lowercased())")
  }
}

/// A single day, used to derive the deterministic ID of a daily page.
///
/// Ported concept from the old app's `DayKey`.
public struct DayKey: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  /// `rawValue` must be `YYYY-MM-DD`. This intentionally does not validate
  /// the string beyond shape — callers that need calendar validity should
  /// construct via `init(date:calendar:)`.
  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public init(date: Date, calendar: Calendar = .init(identifier: .gregorian)) {
    var calendar = calendar
    calendar.timeZone = TimeZone(identifier: "UTC") ?? calendar.timeZone
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    self.init(
      rawValue: String(
        format: "%04d-%02d-%02d",
        components.year ?? 0,
        components.month ?? 0,
        components.day ?? 0
      )
    )
  }
}

/// The deterministic or random identity of a page — the one node type in the
/// Enchiridion graph (plan: "everything-is-a-page").
///
/// Ported concept from the old app's `PageID` (PageModels.swift). Two
/// derivation families:
/// - **Random** (`free`) — most pages; catalog discovery (the `vault-meta`
///   sync-first doc) exists precisely because random IDs give no other way
///   for devices to learn about pages created elsewhere.
/// - **Deterministic** (`daily`, `person`) — content-addressed by a stable
///   external key, so re-ingesting the same external fact (a calendar
///   attendee, a day) never forks a duplicate page. This is the invariant
///   the plan's cross-language golden tests protect.
public struct PageID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String

  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  /// A freshly captured, non-deterministic page (notes, tasks the user types
  /// directly, etc.) — the common case per PRODUCT.md's "literal capture
  /// first" principle.
  public static func free(_ id: UUID = UUID()) -> Self {
    Self(rawValue: "page_\(id.uuidString.lowercased())")
  }

  /// The single page for a given calendar day. Deterministic so every device
  /// (and the server-side materializer) agree on one daily page without
  /// coordination.
  public static func daily(_ day: DayKey) -> Self {
    Self(rawValue: "daily:\(day.rawValue)")
  }

  /// A person page keyed by email. Deterministic so the same correspondent
  /// discovered independently by Calendar and Gmail ingestion (plan
  /// §"Google gatekeeper") converges on one page instead of forking.
  public static func person(email: String) -> Self {
    Self(
      rawValue:
        "person_\(digest(email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()))"
    )
  }

  /// A digest-identified page for an arbitrary stable external key —
  /// generalizes the old app's `calendarEvent`/`calendarSeries` derivations
  /// (`event_<digest>`, `series_<digest>`) without hard-coding calendar
  /// specifics into `EnchiridionCore` before the gatekeeper exists. Callers
  /// pick the prefix (e.g. `"event"`, `"series"`) and the canonical key.
  ///
  /// Deliberately: provider IDs and iCalendar UIDs never appear in the key
  /// or prefix themselves — only in the hashed `canonicalKey` — matching the
  /// old app's "cloud-safe" identity comment on `materializedCalendarEvent`.
  public static func digestIdentified(prefix: String, canonicalKey: String) -> Self {
    Self(rawValue: "\(prefix)_\(digest(canonicalKey))")
  }

  /// SHA-256 of `value`, truncated to the first 20 bytes (40 hex chars),
  /// lowercase. Matches `PageID.digest` in the old app byte-for-byte — this
  /// exact truncation is part of the cross-language contract, not an
  /// arbitrary shortening.
  static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8))
      .prefix(20)
      .map { String(format: "%02x", $0) }
      .joined()
  }
}

/// Identifies a supertag definition (as-code, per `supertags/*` in the
/// plan's monorepo layout). Ported concept from the old app's `SupertagID`
/// (aliased there to `TagID`).
public struct SupertagID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }
}

/// Field identity is `(tagID, fieldID)` per the plan's supertag module
/// contract ("Field identity stays `(tagID, fieldID)`"), so a bare field ID
/// is only ever meaningful alongside its owning tag.
public struct SupertagFieldID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }
}

/// A field's fully-qualified identity, `property:<tagID>:<fieldID>` — mirrors
/// the old app's `PredicateID.property`. Used as the CRDT map key for
/// per-field values on a page's `objectMetadata` map (see
/// `EnchiridionSync.CRDTMutation.mapSet`).
public struct PredicateID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public static func property(tagID: SupertagID, fieldID: SupertagFieldID) -> Self {
    .init(rawValue: "property:\(tagID.rawValue):\(fieldID.rawValue)")
  }
}
