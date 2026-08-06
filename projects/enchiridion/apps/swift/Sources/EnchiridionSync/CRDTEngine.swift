// CRDTEngine.swift
// EnchiridionSync
//
// Design decision: `CRDTEngine` lives in EnchiridionSync, not
// EnchiridionCore. EnchiridionCore's README is explicit that "CRDT engine /
// sync" is out of scope for it ("that's EnchiridionSync"), and the plan
// frames the protocol boundary as *the* mitigation for Risk #1 ("Loro Swift
// bindings are experimental ... the CRDTEngine protocol keeps Automerge 3 as
// the escape hatch") — i.e. it is infrastructure for the sync engine, not a
// domain concept `EnchiridionCore` (or a hypothetical non-sync consumer)
// should need to know about. `EnchiridionCore` stays a plain-data module
// with no CRDT library dependency at all, which is also what keeps a future
// Automerge swap from touching it.
//
// This protocol is intentionally CRDT-shape-agnostic: the operation vocabulary
// (`CRDTMutation`) models "text insert/delete/mark" and "map set/delete"
// because that's what a Loro *and* an Automerge document both support, not
// because it mirrors Loro's API one-for-one. `LoroEngine` (see
// LoroEngine.swift) is what actually maps these onto verified loro-swift
// calls.

import EnchiridionCore
import Foundation

/// A value that can sit in a CRDT map or as a rich-text mark's payload.
///
/// Deliberately a small closed set (not "any Codable") — this is the exact
/// vocabulary `objectMetadata` field values and text marks need per the
/// plan's doc shape, and keeping it closed is what lets both `LoroEngine`
/// and a hypothetical Automerge engine implement it exhaustively.
public enum CRDTValue: Sendable, Codable, Hashable {
  case string(String)
  case bool(Bool)
  case int(Int64)
  case double(Double)
  case null
}

/// A single local edit to a CRDT document, expressed independently of which
/// CRDT library ultimately applies it.
///
/// `container` names a root container within the document (e.g. `"body"`
/// for a page's rich text, `"objectMetadata"` for its supertag field map,
/// `"edges"` for canonical relation storage) — the plan's doc-per-page shape
/// keeps a small, fixed set of named root containers per page, so this is a
/// string identifier rather than a path.
public enum CRDTMutation: Sendable {
  /// Insert `text` at unicode scalar position `position` in a text
  /// container.
  case textInsert(container: String, position: UInt32, text: String)

  /// Delete `length` unicode scalars starting at `position` in a text
  /// container.
  case textDelete(container: String, position: UInt32, length: UInt32)

  /// Apply a rich-text mark (e.g. bold, a page-reference span) over
  /// `range` in a text container. `value == nil` clears the mark's value
  /// but the CRDT-shape-agnostic surface doesn't distinguish "set to null"
  /// from "unmark" — engines are expected to treat `nil` as unmark.
  case textMark(container: String, range: Range<UInt32>, key: String, value: CRDTValue?)

  /// Set a key in a map container (e.g. a supertag field on
  /// `objectMetadata`, or an edge entry on `edges`).
  case mapSet(container: String, key: String, value: CRDTValue)

  /// Remove a key from a map container.
  case mapDelete(container: String, key: String)
}

/// The result of merging remote bytes (an update or a snapshot) into a
/// document.
public struct CRDTImportOutcome: Sendable, Equatable {
  /// The document's live state actually changed as a result of this import
  /// (as opposed to importing bytes the document already had — a no-op
  /// merge). Reprojection should only be triggered when this is `true`.
  public let changedState: Bool

  /// The import left operations pending because their causal dependencies
  /// (earlier ops from the same peer, or ops they reference) haven't
  /// arrived yet. The sync client should not treat the doc as fully caught
  /// up when this is `true` — more updates are needed from the peer.
  public let hasPendingDependencies: Bool

  public init(changedState: Bool, hasPendingDependencies: Bool) {
    self.changedState = changedState
    self.hasPendingDependencies = hasPendingDependencies
  }
}

/// Thrown by `CRDTEngine` implementations for engine-level failures (bad
/// bytes, container-type mismatches, etc.) — never for "document doesn't
/// exist yet", which every mutating/exporting method handles by
/// auto-creating the document (see each method's doc comment).
public enum CRDTEngineError: Error, Sendable, Equatable {
  /// The supplied bytes could not be parsed as an update or snapshot for
  /// this engine's format.
  case malformedBytes(String)
  /// An operation was attempted against a document the engine has no
  /// record of and the operation does not auto-create (currently none do,
  /// but the case exists for engines with a stricter contract).
  case unknownDocument(PageID)
  /// The underlying CRDT library raised an error this engine couldn't
  /// otherwise classify. `underlying` carries its description for
  /// diagnostics.
  case engineFailure(String)
}

/// Abstraction boundary over a CRDT library, so Loro (the plan's pinned
/// choice) can be swapped for Automerge later without touching call sites
/// in `VaultSyncClient` or above (plan Risk #1's stated mitigation).
///
/// An engine owns a *set* of documents, keyed by `PageID` — one per page
/// plus the `vault-meta` catalog doc, per the plan's doc-per-page
/// granularity — rather than exposing a single document, because the sync
/// client needs to operate over many docs per vault (catalog-first sync,
/// then lazy per-doc subscription).
///
/// Conforming types are expected to be reference types with internal
/// synchronization (an `actor`, concretely — see `LoroEngine`) since the
/// sync client, outbox replay, and reprojection triggers all need
/// concurrent-safe access to the same live documents.
public protocol CRDTEngine: AnyObject, Sendable {
  /// Registers a brand-new, empty document under `id`. Throws if a document
  /// already exists for `id` — callers that don't know whether a document
  /// exists yet should use one of the mutating/importing methods, which all
  /// auto-create.
  func createDocument(id: PageID) async throws

  /// Whether the engine currently holds live state for `id` (created this
  /// run or imported into).
  func hasDocument(id: PageID) async -> Bool

  /// Applies a local mutation to `id`'s live state. Auto-creates the
  /// document first if this is the first operation the engine has seen for
  /// it — this is deliberate: the plan's "fast capture is never blocked by
  /// schema" principle extends to "never blocked by a create-before-write
  /// ceremony" for the sync layer too.
  func apply(_ mutation: CRDTMutation, to id: PageID) async throws

  /// `id`'s current version vector, in the engine's own opaque encoded
  /// format (never assume cross-engine compatibility of these bytes — they
  /// are meaningful only to the same `CRDTEngine` implementation on the
  /// other end of the wire, which for Loro means the same Rust-core
  /// version per plan Risk #1's lockstep-upgrade mitigation).
  func versionVector(of id: PageID) async throws -> Data

  /// All operations applied to `id` that are not reflected in
  /// `versionVector` — the plan's "incremental `export(mode: update, from:
  /// vv)`" sync step. `versionVector` bytes must have come from this same
  /// engine implementation (see the note on `versionVector(of:)`).
  func exportUpdates(of id: PageID, since versionVector: Data) async throws -> Data

  /// A full-history snapshot of `id` — used for first sync of a doc, and as
  /// the payload for the plan's nightly R2 backup export.
  func exportSnapshot(of id: PageID) async throws -> Data

  /// A snapshot of `id`'s current state without full edit history — the
  /// plan's compaction-horizon fallback: "if a client's VV predates the
  /// DO's compaction horizon, the DO answers with a full snapshot instead
  /// of a diff" (the device-in-a-drawer case). Smaller than
  /// `exportSnapshot` at the cost of losing the ability to compute a diff
  /// against versions older than this snapshot.
  func exportShallowSnapshot(of id: PageID) async throws -> Data

  /// Merges remote `bytes` (an update or a snapshot — the engine
  /// distinguishes by content, not by a caller-supplied flag) into `id`.
  /// Auto-creates the document first if this is the first the engine has
  /// heard of `id` — this is how a device that starts fresh learns pages
  /// that already existed on the server. Merge is idempotent: importing
  /// bytes the document already has is a safe no-op (`changedState ==
  /// false` in the result).
  @discardableResult
  func importBytes(_ bytes: Data, into id: PageID) async throws -> CRDTImportOutcome

  /// `PageID`s whose live state changed (via `apply` or a state-changing
  /// `importBytes`) since `sequence`, plus the engine's current sequence
  /// number. Feeds the plan's per-doc debounced reprojection trigger and,
  /// on the client, "list changed doc IDs" for deciding what to
  /// re-materialize locally. `sequence: 0` returns every document that has
  /// ever changed in this engine instance.
  func changedDocuments(since sequence: UInt64) async -> (ids: [PageID], sequence: UInt64)
}
