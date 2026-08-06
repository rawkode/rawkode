// VaultImportLedger.swift
// EnchiridionImporter
//
// Content-level idempotency for `VaultImporter` — see that file's header
// for the full reasoning on why this exists (loro-swift's snapshot-in/
// snapshot-out `PageDocument` mints a fresh random peer id on every
// mutation call, so two independent re-encodes of identical logical
// content are not byte-identical Loro docs; skipping the push entirely for
// unchanged content sidesteps the risk that pushing a second, differently-
// peered "same content" doc would duplicate text rather than harmlessly
// no-op on a live VaultDO).
//
// Deliberately a plain JSON file on disk (not a database) — this only ever
// needs point lookups and a full-dictionary encode/decode for a
// single-user vault's page count, and staying dependency-free (no SQLite,
// no GRDB) matches this target's minimal-dependency brief.
import EnchiridionCore
import Foundation

public struct VaultImportLedgerEntry: Codable, Sendable, Equatable {
  public var pageID: String
  public var contentDigest: String
  public var lastImportedAt: Date

  public init(pageID: String, contentDigest: String, lastImportedAt: Date) {
    self.pageID = pageID
    self.contentDigest = contentDigest
    self.lastImportedAt = lastImportedAt
  }
}

/// Tracks, per re-derived new PageID, the content digest last successfully
/// pushed for it. `VaultImporter.importPages` consults this to skip
/// re-pushing a page whose decoded content hasn't changed since the last
/// run — an `actor` so a single ledger instance can be shared safely across
/// concurrent import work if `VaultImporter` is ever parallelized.
public actor VaultImportLedger {
  private var entries: [String: VaultImportLedgerEntry]
  private let persistencePath: URL?

  /// `persistencePath`, if given, is read at init (missing/unreadable file
  /// = start empty, never an error — a first run has no ledger yet) and
  /// written by `persist()`. Pass `nil` for a purely in-memory ledger
  /// (what every test in this target uses — real cross-process persistence
  /// isn't needed to prove the digest-skip mechanism works).
  public init(persistencePath: URL? = nil) {
    self.persistencePath = persistencePath
    if let persistencePath,
      let data = try? Data(contentsOf: persistencePath),
      let decoded = try? JSONDecoder.enchiridion.decode([String: VaultImportLedgerEntry].self, from: data)
    {
      self.entries = decoded
    } else {
      self.entries = [:]
    }
  }

  public func digest(forPageID pageID: String) -> String? {
    entries[pageID]?.contentDigest
  }

  public func record(pageID: String, contentDigest: String, importedAt: Date) {
    entries[pageID] = VaultImportLedgerEntry(
      pageID: pageID, contentDigest: contentDigest, lastImportedAt: importedAt
    )
  }

  public func persist() throws {
    guard let persistencePath else { return }
    let data = try JSONEncoder.enchiridion.encode(entries)
    try data.write(to: persistencePath, options: .atomic)
  }

  public var count: Int { entries.count }
}
