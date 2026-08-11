// IdempotencyTests.swift
// EnchiridionImporterTests
//
// Task brief: "re-running the importer against the same synthetic vault
// doesn't duplicate anything." Exercises `VaultImporter.importPages`
// end-to-end (decode -> re-encode -> ledger check -> push) against a
// `RecordingVaultPagePusher`, twice, over the same synthetic old-vault
// snapshots — see `VaultImporter.swift`'s header for the precise two-part
// idempotency guarantee this proves:
//   1. same old page -> same new PageID on both runs (no duplicate PAGES).
//   2. with a shared `VaultImportLedger`, the second run pushes NOTHING
//      for unchanged pages (no duplicate/wasted pushes, and — per that
//      file's header — no risk of the peer-ID/Loro-merge duplication
//      concern a blind re-push would carry).
import Automerge
import EnchiridionCore
import Foundation
import XCTest

@testable import EnchiridionImporter

final class IdempotencyTests: XCTestCase {

  private func syntheticVaultSnapshots() -> [Data] {
    let note = SyntheticOldPageBuilder.create(
      id: "page_note1", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Note",
      createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    SyntheticOldPageBuilder.setBody(note, text: "Content.")

    let daily = SyntheticOldPageBuilder.create(
      id: "daily_source_id_irrelevant", kind: SyntheticOldPageBuilder.kindJSON(daily: "2026-08-06"),
      title: "", createdAt: Date(timeIntervalSince1970: 1_700_000_050)
    )

    let task = SyntheticOldPageBuilder.create(
      id: "page_task1", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Task",
      createdAt: Date(timeIntervalSince1970: 1_700_000_100)
    )
    SyntheticOldPageBuilder.addSupertag(task, "task")
    SyntheticOldPageBuilder.setScalarProperty(
      task, supertagID: "task", fieldID: "status", jsonValues: [SyntheticSupertagValue.select("to-do")]
    )

    return [note, daily, task].map { $0.save() }
  }

  func testSamePagesMapToSamePageIDsAcrossTwoRuns() async throws {
    let snapshots = syntheticVaultSnapshots()
    let pusherA = RecordingVaultPagePusher()
    let pusherB = RecordingVaultPagePusher()

    _ = await VaultImporter.importPages(oldSnapshots: snapshots, pusher: pusherA)
    _ = await VaultImporter.importPages(oldSnapshots: snapshots, pusher: pusherB)

    let idsA = await pusherA.pushes.map(\.pageID).sorted { $0.rawValue < $1.rawValue }
    let idsB = await pusherB.pushes.map(\.pageID).sorted { $0.rawValue < $1.rawValue }
    XCTAssertEqual(idsA, idsB)
    XCTAssertEqual(Set(idsA).count, idsA.count, "no duplicate ids within a single run")
  }

  func testSecondRunWithSharedLedgerSkipsUnchangedPages() async throws {
    let snapshots = syntheticVaultSnapshots()
    let pusher = RecordingVaultPagePusher()
    let ledger = VaultImportLedger()

    let firstRun = await VaultImporter.importPages(oldSnapshots: snapshots, pusher: pusher, ledger: ledger)
    XCTAssertEqual(firstRun.summary.pagesPushed, snapshots.count)
    XCTAssertEqual(firstRun.summary.pagesSkippedUnchanged, 0)

    let pushCountAfterFirstRun = await pusher.pushes.count

    let secondRun = await VaultImporter.importPages(oldSnapshots: snapshots, pusher: pusher, ledger: ledger)
    XCTAssertEqual(secondRun.summary.pagesPushed, 0, "nothing changed — the ledger should skip every page")
    XCTAssertEqual(secondRun.summary.pagesSkippedUnchanged, snapshots.count)

    let pushCountAfterSecondRun = await pusher.pushes.count
    XCTAssertEqual(
      pushCountAfterSecondRun, pushCountAfterFirstRun,
      "no new pushes recorded on the unchanged re-run — nothing was duplicated"
    )
  }

  func testChangedPageStillPushesButUnchangedSiblingsDoNot() async throws {
    let pusher = RecordingVaultPagePusher()
    let ledger = VaultImportLedger()

    let unchanged = SyntheticOldPageBuilder.create(
      id: "page_stays_same", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Stable",
      createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let changesLater = SyntheticOldPageBuilder.create(
      id: "page_gets_edited", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Draft v1",
      createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )

    _ = await VaultImporter.importPages(
      oldSnapshots: [unchanged.save(), changesLater.save()], pusher: pusher, ledger: ledger
    )
    let pushesAfterFirstRun = await pusher.pushes.count
    XCTAssertEqual(pushesAfterFirstRun, 2)

    // Simulate the user editing ONE old page between import runs.
    SyntheticOldPageBuilder.setBody(changesLater, text: "Edited content.")

    let secondRun = await VaultImporter.importPages(
      oldSnapshots: [unchanged.save(), changesLater.save()], pusher: pusher, ledger: ledger
    )
    XCTAssertEqual(secondRun.summary.pagesPushed, 1, "only the edited page should push")
    XCTAssertEqual(secondRun.summary.pagesSkippedUnchanged, 1, "the unchanged page should be skipped")

    let pushesAfterSecondRun = await pusher.pushes.count
    XCTAssertEqual(pushesAfterSecondRun, pushesAfterFirstRun + 1)
  }
}
