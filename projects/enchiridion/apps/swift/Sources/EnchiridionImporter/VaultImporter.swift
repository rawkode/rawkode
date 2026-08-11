// VaultImporter.swift
// EnchiridionImporter
//
// Orchestrates one importer pass: decode -> re-encode -> (skip if
// unchanged) -> push, over a batch of old-app page snapshots. This is the
// "core page-migration path" the P1 task prioritizes.
//
// IDEMPOTENCY — two distinct guarantees, worth stating precisely because
// they come from two different mechanisms:
//
// 1. "Running the importer twice produces no duplicate PAGES." Guaranteed
//    unconditionally, with no ledger needed: `PageReencoder.rederivedPageID`
//    always maps the same old page to the same new PageID (deterministic
//    re-derivation for daily/materialized-calendar/person pages; the old
//    page's own stable id carried forward for genuinely random `.free`
//    pages), and VaultDO's catalog is a `pageID -> entry` UPSERT
//    (`ensureCatalogEntry`/`upsertCatalogEntry` in
//    `workers/vault/src/vault-write-model.ts`/`catalog.ts`) — re-pushing
//    the same pageID is an update to the SAME catalog row and the SAME
//    doc-storage row, never a second page.
//
// 2. "Running the importer twice is safe to re-run" (the plan's literal
//    words) — i.e. doesn't waste work or risk corrupting a page's CONTENT
//    on a no-op re-run. This is what `VaultImportLedger` adds: skip the
//    push entirely when a page's decoded content digest hasn't changed
//    since the last successful push. This matters because of a real,
//    separate risk that "same pageID" alone does NOT protect against —
//    see PageReencoder.swift's header and DecodedOldPage.contentDigest's
//    doc comment: loro-swift's `PageDocument.create`/`.mutate` mint a
//    fresh, random peer id on every call (no persisted per-device peer id
//    exists anywhere in this codebase yet — plan Risk #14's "peer-ID
//    stability" prerequisite, explicitly not yet scheduled), so two
//    independent re-encodes of IDENTICAL logical content are NOT
//    byte-identical Loro docs. If the importer blindly re-pushed on every
//    run, VaultDO's `doc.importBytes()` would treat the second run's ops as
//    genuinely new (different peer/counter identities) and — because
//    `LoroText` inserts are positional/interleaved, not keyed — that risks
//    DUPLICATING the page's title/body text on a content-identical re-run,
//    not harmlessly no-op-ing. The ledger sidesteps this for the common
//    case (nothing changed) by never generating that second, differently-
//    peered doc in the first place. A genuinely EDITED old page still
//    re-pushes on the next run and still carries that residual risk — it
//    is not fully closed by this importer alone, because closing it for
//    real requires the peer-ID-stability fix in `EnchiridionSync`'s
//    `PageDocument`, which this task's constraints keep read-only (see
//    this file's own package README for the explicit follow-up write-up).
import EnchiridionCore
import EnchiridionSync
import Foundation

public struct VaultImportSummary: Sendable, Equatable {
  public var pagesProcessed: Int
  public var pagesPushed: Int
  public var pagesSkippedUnchanged: Int

  public init(pagesProcessed: Int, pagesPushed: Int, pagesSkippedUnchanged: Int) {
    self.pagesProcessed = pagesProcessed
    self.pagesPushed = pagesPushed
    self.pagesSkippedUnchanged = pagesSkippedUnchanged
  }
}

/// One page's snapshot bytes couldn't be decoded/re-encoded — collected
/// rather than thrown, so one corrupted page never aborts an entire batch
/// (mirrors the plan's `rebuild-projections` "isolate per-page failures"
/// principle for the analogous VaultDO-side operation).
public struct VaultImportPageFailure: Sendable {
  public var originalPageID: String?
  public var error: String

  public init(originalPageID: String?, error: String) {
    self.originalPageID = originalPageID
    self.error = error
  }
}

public struct VaultImportResult: Sendable {
  public var summary: VaultImportSummary
  public var failures: [VaultImportPageFailure]

  public init(summary: VaultImportSummary, failures: [VaultImportPageFailure]) {
    self.summary = summary
    self.failures = failures
  }
}

public enum VaultImporter {
  /// Imports every snapshot in `oldSnapshots`. Each is independently
  /// decoded/re-encoded/pushed — a failure on one snapshot is recorded in
  /// `VaultImportResult.failures` and the batch continues.
  public static func importPages(
    oldSnapshots: [Data],
    pusher: any VaultPagePushing,
    ledger: VaultImportLedger? = nil,
    now: Date = Date()
  ) async -> VaultImportResult {
    var pushed = 0
    var skippedUnchanged = 0
    var failures: [VaultImportPageFailure] = []

    for snapshot in oldSnapshots {
      do {
        let decoded = try OldPageDocumentDecoder.decode(snapshot)
        let reencoded = try PageReencoder.reencode(decoded)
        let digest = try decoded.contentDigest()

        if let ledger, await ledger.digest(forPageID: reencoded.pageID.rawValue) == digest {
          skippedUnchanged += 1
          continue
        }

        let entry = VaultCatalogEntry(
          pageID: reencoded.pageID,
          docType: reencoded.docType,
          createdAt: reencoded.createdAt,
          updatedAt: now
        )
        try await pusher.push(catalogEntry: entry, documentSnapshot: reencoded.document)
        await ledger?.record(pageID: reencoded.pageID.rawValue, contentDigest: digest, importedAt: now)
        pushed += 1
      } catch {
        failures.append(
          VaultImportPageFailure(
            originalPageID: (try? OldPageDocumentDecoder.decode(snapshot).originalPageID.rawValue),
            error: String(describing: error)
          )
        )
      }
    }

    if let ledger {
      try? await ledger.persist()
    }

    return VaultImportResult(
      summary: VaultImportSummary(
        pagesProcessed: oldSnapshots.count, pagesPushed: pushed, pagesSkippedUnchanged: skippedUnchanged
      ),
      failures: failures
    )
  }
}
