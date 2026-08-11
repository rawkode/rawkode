// GadgetCapabilityTypes.swift
// EnchiridionGadgets
//
// Swift mirror of `workers/gadget-host/src/capability-types.ts`'s
// `CapabilityType`/`CapabilityScope` — the closed capability vocabulary the
// server enforces. This module does NOT re-implement that enforcement (the
// server remains the authority: a device never holds unrevocable trust),
// but `GadgetBridge` (GadgetBridge.swift) does its own LOCAL copy of the
// same allowlist check before ever placing a network call — see that
// file's header for why a client-side check is worth having in addition to
// (never instead of) the server's. Keeping the vocabulary's shape
// identical on both sides means a grant fetched from the server decodes
// straight into these types with no translation layer that could drift.
//
// Raw string values are kept byte-identical to the TS union
// (`"graph.query"`, not `"graphQuery"`) for the same reason
// `capability-types.ts` itself gives for using string literals over an
// enum: this value round-trips through JSON (here: the bridge wire
// format's `"type"` field — GadgetBridgeMessage.swift) without an
// encode/decode step of its own.

import Foundation

public enum GadgetCapabilityType: String, Sendable, Equatable, Hashable, CaseIterable {
  case graphQuery = "graph.query"
  case graphPropose = "graph.propose"
  case gatekeeperGoogleCalendarRead = "gatekeeper.google.calendar.read"
  case scheduleCron = "schedule.cron"
}

/// Mirrors `capability-types.ts`'s `CapabilityScope` discriminated union.
/// Each case's associated data is that capability type's own scope shape —
/// see `capability-types.ts`'s doc comment on `CapabilityScope` for why
/// each is shaped the way it is (that rationale is server-authored and not
/// repeated here). `capabilityType` recovers the discriminant, mirroring
/// the TS type's `capabilityType` field so a `GadgetCapabilityScope` alone
/// (without a wrapping grant) still self-identifies which capability it
/// scopes.
public enum GadgetCapabilityScope: Sendable, Equatable {
  /// `views`: the `graph.query` view-name allowlist. An empty array is a
  /// valid (if useless) grant — no implicit wildcard, matching the
  /// server's "default nothing" posture.
  case graphQuery(views: [String])
  /// `pageIDs`/`pagePrefixes`: exact-match and prefix-match allowlists for
  /// `graph.propose`'s target page. Both default to empty with the same
  /// "no implicit wildcard" rule as `graphQuery`'s `views`.
  case graphPropose(pageIDs: [String], pagePrefixes: [String])
  /// No scope fields — the one operation this unlocks is already narrow
  /// enough that v1 is all-or-nothing (matches `capability-types.ts`).
  case gatekeeperGoogleCalendarRead
  /// `minIntervalMinutes`: the floor on how often a schedule registered
  /// under this grant may fire.
  case scheduleCron(minIntervalMinutes: Int)

  public var capabilityType: GadgetCapabilityType {
    switch self {
    case .graphQuery: .graphQuery
    case .graphPropose: .graphPropose
    case .gatekeeperGoogleCalendarRead: .gatekeeperGoogleCalendarRead
    case .scheduleCron: .scheduleCron
    }
  }
}

/// One active capability grant for one gadget — the device-side view of a
/// row from the server's `capability_grants` table
/// (`capability-store.ts`). `GadgetBridge` is handed a snapshot of these at
/// load time (and again via `updateGrants(_:)` whenever the in-app
/// approval UI changes them — e.g. a revocation), NOT a live subscription:
/// this module has no networking of its own beyond `GadgetBridgeTransport`
/// (GadgetBridgeTransport.swift), and keeping "how grants get from the
/// server to here" out of this type keeps it a plain, freely-constructible
/// value for tests.
public struct GadgetCapabilityGrant: Sendable, Equatable {
  public let id: String
  public let scope: GadgetCapabilityScope
  public let grantedAt: Date

  public init(id: String, scope: GadgetCapabilityScope, grantedAt: Date = Date()) {
    self.id = id
    self.scope = scope
    self.grantedAt = grantedAt
  }

  public var capabilityType: GadgetCapabilityType { scope.capabilityType }
}
