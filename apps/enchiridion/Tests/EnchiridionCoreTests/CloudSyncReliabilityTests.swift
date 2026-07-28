import CloudKit
import Foundation
import XCTest
@testable import EnchiridionCore

final class CloudSyncReliabilityPolicyTests: XCTestCase {
  func testEffectiveEntitlementRejectsEveryPartiallySignedConfiguration() {
    let container = CloudSyncCoordinator.containerIdentifier

    XCTAssertTrue(
      CloudSyncCoordinator.hasRequiredEntitlements(
        containerIdentifiers: ["unrelated", container],
        iCloudServices: ["CloudDocuments", "CloudKit"],
        pushEnvironment: "production"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.hasRequiredEntitlements(
        containerIdentifiers: nil,
        iCloudServices: ["CloudKit"],
        pushEnvironment: "development"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.hasRequiredEntitlements(
        containerIdentifiers: ["iCloud.dev.rawkode.another-app"],
        iCloudServices: ["CloudKit"],
        pushEnvironment: "development"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.hasRequiredEntitlements(
        containerIdentifiers: [container],
        iCloudServices: ["CloudDocuments"],
        pushEnvironment: "development"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.hasRequiredEntitlements(
        containerIdentifiers: [container],
        iCloudServices: ["CloudKit"],
        pushEnvironment: "  \n"
      )
    )

    for allowed in ["YES", "yes", " true ", "1"] {
      XCTAssertTrue(
        CloudSyncCoordinator.hasRequiredEntitlement(
          declaredEntitlementsPath: "Configuration/EnchiridionMobile.entitlements",
          codeSigningAllowed: allowed
        )
      )
    }
    for disabled in [nil, "", "NO", "false", "0"] {
      XCTAssertFalse(
        CloudSyncCoordinator.hasRequiredEntitlement(
          declaredEntitlementsPath: "Configuration/EnchiridionMobile.entitlements",
          codeSigningAllowed: disabled
        )
      )
    }
  }

  func testEveryTransientCKErrorRetriesAndPermanentErrorsRequireAttention() {
    let transientCodes: [CKError.Code] = [
      .networkFailure,
      .networkUnavailable,
      .serviceUnavailable,
      .requestRateLimited,
      .zoneBusy,
      .accountTemporarilyUnavailable,
    ]
    for code in transientCodes {
      XCTAssertEqual(
        CloudSyncCoordinator.disposition(for: code),
        .retryAutomatically,
        "Expected \(code) to remain retryable"
      )
    }

    let permanentCodes: [CKError.Code] = [
      .badContainer,
      .missingEntitlement,
      .permissionFailure,
      .quotaExceeded,
      .invalidArguments,
    ]
    for code in permanentCodes {
      XCTAssertEqual(
        CloudSyncCoordinator.disposition(for: code),
        .requiresAttention,
        "Expected \(code) to surface an actionable failure"
      )
    }
  }
}

final class CloudSyncReliabilityRepositoryTests: XCTestCase {
  func testExactAcknowledgementThenNewEditThenStaleAcknowledgementForEveryEntity() async throws {
    let fixture = try CloudSyncReliabilityFixture()

    let page = try await fixture.repository.createFreePage(title: "Page")
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markCloudSaved(
        pageID: page.id,
        sentGeneration: page.dirtyGeneration,
        systemFields: Data([1])
      )
    )
    try await fixture.repository.togglePinned(pageID: page.id)
    try await XCTAssertAsyncTrue(
      try await fixture.repository.markCloudSaved(
        pageID: page.id,
        sentGeneration: page.dirtyGeneration,
        systemFields: Data([2])
      )
    )
    let editedPage = try await XCTUnwrapAsync(try await fixture.repository.page(id: page.id))
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markCloudSaved(
        pageID: page.id,
        sentGeneration: editedPage.dirtyGeneration,
        systemFields: Data([3])
      )
    )

    var view = LiveQueryDefinition(name: "View", source: .pages)
    try await fixture.repository.saveView(view, now: Date(timeIntervalSince1970: 10))
    let firstViewGeneration = try await XCTUnwrapAsync(
      try await fixture.repository.savedViewCloudRecord(id: view.id)?.dirtyGeneration
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markViewCloudSaved(
        id: view.id,
        sentGeneration: firstViewGeneration,
        systemFields: Data([4])
      )
    )
    view.name = "Edited view"
    try await fixture.repository.saveView(view, now: Date(timeIntervalSince1970: 20))
    try await XCTAssertAsyncTrue(
      try await fixture.repository.markViewCloudSaved(
        id: view.id,
        sentGeneration: firstViewGeneration,
        systemFields: Data([5])
      )
    )
    let editedViewGeneration = try await XCTUnwrapAsync(
      try await fixture.repository.savedViewCloudRecord(id: view.id)?.dirtyGeneration
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markViewCloudSaved(
        id: view.id,
        sentGeneration: editedViewGeneration,
        systemFields: Data([6])
      )
    )

    let purgePage = try await fixture.repository.createFreePage(title: "Purge")
    try await fixture.repository.moveToTrash(pageID: purgePage.id)
    try await fixture.repository.purge(pageID: purgePage.id)
    let marker = try await XCTUnwrapAsync(
      try await fixture.repository.purgeMarker(pageID: purgePage.id)
    )
    try await XCTAssertAsyncTrue(
      try await fixture.repository.markPurgeCloudSaved(
        pageID: purgePage.id,
        sentGeneration: marker.generation - 1,
        systemFields: Data([7])
      )
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markPurgeCloudSaved(
        pageID: purgePage.id,
        sentGeneration: marker.generation,
        systemFields: Data([8])
      )
    )

    var supertag = SupertagDefinition.draft(name: "Book")
    try await fixture.repository.saveSupertag(supertag, now: Date(timeIntervalSince1970: 30))
    let firstSupertagGeneration = try await XCTUnwrapAsync(
      try await fixture.repository.supertagCloudRecord(id: supertag.id)?.dirtyGeneration
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markSupertagCloudSaved(
        id: supertag.id,
        sentGeneration: firstSupertagGeneration,
        systemFields: Data([9])
      )
    )
    supertag.name = "Reading"
    try await fixture.repository.saveSupertag(supertag, now: Date(timeIntervalSince1970: 40))
    try await XCTAssertAsyncTrue(
      try await fixture.repository.markSupertagCloudSaved(
        id: supertag.id,
        sentGeneration: firstSupertagGeneration,
        systemFields: Data([10])
      )
    )
    let editedSupertagGeneration = try await XCTUnwrapAsync(
      try await fixture.repository.supertagCloudRecord(id: supertag.id)?.dirtyGeneration
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markSupertagCloudSaved(
        id: supertag.id,
        sentGeneration: editedSupertagGeneration,
        systemFields: Data([11])
      )
    )

    try await XCTAssertAsyncFalse(try await fixture.repository.dirtyPages().contains { $0.id == page.id })
    try await XCTAssertAsyncFalse(try await fixture.repository.dirtyViews().contains { $0.id == view.id })
    try await XCTAssertAsyncFalse(
      try await fixture.repository.dirtyPurgeMarkers().contains { $0.pageID == purgePage.id }
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.dirtySupertags().contains { $0.id == supertag.id }
    )
  }

  func testRemoteRecordDeletionPreservesDirtyLocalRecordsAndTombstonesCleanRecords() async throws {
    let fixture = try CloudSyncReliabilityFixture()

    let dirtyPage = try await fixture.repository.createFreePage(title: "Dirty page")
    try await XCTAssertAsyncTrue(
      try await fixture.repository.applyCloudPageRecordDeletion(pageID: dirtyPage.id)
    )
    try await XCTAssertAsyncNotNil(try await fixture.repository.page(id: dirtyPage.id))
    try await XCTAssertAsyncNil(try await fixture.repository.purgeMarker(pageID: dirtyPage.id))

    let cleanPage = try await fixture.repository.createFreePage(title: "Clean page")
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markCloudSaved(
        pageID: cleanPage.id,
        sentGeneration: cleanPage.dirtyGeneration,
        systemFields: Data([1])
      )
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.applyCloudPageRecordDeletion(pageID: cleanPage.id)
    )
    try await XCTAssertAsyncNil(try await fixture.repository.page(id: cleanPage.id))
    try await XCTAssertAsyncNotNil(try await fixture.repository.purgeMarker(pageID: cleanPage.id))
    try await XCTAssertAsyncFalse(
      try await fixture.repository.dirtyPurgeMarkers().contains { $0.pageID == cleanPage.id }
    )

    let dirtyView = LiveQueryDefinition(name: "Dirty view", source: .pages)
    try await fixture.repository.saveView(dirtyView)
    try await XCTAssertAsyncTrue(
      try await fixture.repository.applyCloudViewRecordDeletion(id: dirtyView.id)
    )
    try await XCTAssertAsyncEqual(
      try await fixture.repository.savedViewCloudRecord(id: dirtyView.id)?.definition.name,
      "Dirty view"
    )

    let cleanView = LiveQueryDefinition(name: "Clean view", source: .pages)
    try await fixture.repository.saveView(cleanView)
    let cleanViewGeneration = try await XCTUnwrapAsync(
      try await fixture.repository.savedViewCloudRecord(id: cleanView.id)?.dirtyGeneration
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markViewCloudSaved(
        id: cleanView.id,
        sentGeneration: cleanViewGeneration,
        systemFields: Data([2])
      )
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.applyCloudViewRecordDeletion(id: cleanView.id)
    )
    try await XCTAssertAsyncFalse(try await fixture.repository.savedViews().contains { $0.id == cleanView.id })

    let dirtySupertag = SupertagDefinition.draft(name: "Dirty tag")
    try await fixture.repository.saveSupertag(dirtySupertag)
    try await XCTAssertAsyncTrue(
      try await fixture.repository.applyCloudSupertagRecordDeletion(id: dirtySupertag.id)
    )
    try await XCTAssertAsyncTrue(
      try await fixture.repository.supertags().contains { $0.id == dirtySupertag.id }
    )

    let cleanSupertag = SupertagDefinition.draft(name: "Clean tag")
    try await fixture.repository.saveSupertag(cleanSupertag)
    let cleanSupertagGeneration = try await XCTUnwrapAsync(
      try await fixture.repository.supertagCloudRecord(id: cleanSupertag.id)?.dirtyGeneration
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markSupertagCloudSaved(
        id: cleanSupertag.id,
        sentGeneration: cleanSupertagGeneration,
        systemFields: Data([3])
      )
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.applyCloudSupertagRecordDeletion(id: cleanSupertag.id)
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.supertags().contains { $0.id == cleanSupertag.id }
    )
  }

  func testQuarantineDeduplicatesAndSurvivesSelectiveClearAcrossRepeatedReopens() async throws {
    let fixture = try CloudSyncReliabilityFixture()
    try await fixture.repository.markCloudRecordUnresolved(
      recordName: "page-b",
      detectedAt: Date(timeIntervalSince1970: 10)
    )
    try await fixture.repository.markCloudRecordUnresolved(
      recordName: "page-a",
      detectedAt: Date(timeIntervalSince1970: 20)
    )
    try await fixture.repository.markCloudRecordUnresolved(
      recordName: "page-a",
      detectedAt: Date(timeIntervalSince1970: 30)
    )

    let firstReopen = try LibraryRepository(path: fixture.path)
    try await XCTAssertAsyncEqual(
      try await firstReopen.unresolvedCloudRecordNames(),
      Set(["page-a", "page-b"])
    )
    try await firstReopen.clearUnresolvedCloudRecord(recordName: "page-a")

    let secondReopen = try LibraryRepository(path: fixture.path)
    try await XCTAssertAsyncEqual(try await secondReopen.unresolvedCloudRecordNames(), ["page-b"])
    try await secondReopen.clearAllUnresolvedCloudRecords()

    let thirdReopen = try LibraryRepository(path: fixture.path)
    try await XCTAssertAsyncTrue(try await thirdReopen.unresolvedCloudRecordNames().isEmpty)
  }

  func testAccountBindingPersistsAndRejectsCrossAccountReuse() async throws {
    let fixture = try CloudSyncReliabilityFixture()
    try await fixture.repository.bindCloudAccountID("account-a")
    try await fixture.repository.bindCloudAccountID("account-a")

    let reopened = try LibraryRepository(path: fixture.path)
    try await XCTAssertAsyncEqual(try await reopened.cloudAccountID(), "account-a")
    do {
      try await reopened.bindCloudAccountID("account-b")
      XCTFail("A vault must never silently switch iCloud accounts")
    } catch let LibraryRepositoryError.databaseUnavailable(message) {
      XCTAssertTrue(message.contains("different iCloud account"))
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
    try await XCTAssertAsyncEqual(try await reopened.cloudAccountID(), "account-a")
  }

  func testZoneRecoveryAlsoRequeuesCleanPurgeMarkers() async throws {
    let fixture = try CloudSyncReliabilityFixture()
    let page = try await fixture.repository.createFreePage(title: "Purged")
    try await fixture.repository.moveToTrash(pageID: page.id)
    try await fixture.repository.purge(pageID: page.id)
    let marker = try await XCTUnwrapAsync(
      try await fixture.repository.purgeMarker(pageID: page.id)
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markPurgeCloudSaved(
        pageID: page.id,
        sentGeneration: marker.generation,
        systemFields: Data([1])
      )
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.dirtyPurgeMarkers().contains { $0.pageID == page.id }
    )

    try await fixture.repository.markAllCloudDataForZoneRecovery()

    let recovered = try await XCTUnwrapAsync(
      try await fixture.repository.dirtyPurgeMarkers().first { $0.pageID == page.id }
    )
    XCTAssertNil(recovered.cloudRecord)
  }

  func testRemoteSupertagTombstoneCanBeResurrectedLocallyWithoutDeletionWinningTheRace() async throws {
    let fixture = try CloudSyncReliabilityFixture()
    let id = SupertagID(rawValue: "tag-reading")
    var live = SupertagDefinition.draft(name: "Reading")
    live.id = id

    try await XCTAssertAsyncFalse(
      try await fixture.repository.mergeCloudSupertag(
        id: id,
        definition: live,
        isDeleted: false,
        sortOrder: 1,
        modifiedAt: Date(timeIntervalSince1970: 10),
        dirtyGeneration: 7,
        systemFields: Data([1])
      )
    )
    try await XCTAssertAsyncTrue(try await fixture.repository.supertags().contains { $0.id == id })

    var tombstone = live
    tombstone.isDeleted = true
    try await XCTAssertAsyncFalse(
      try await fixture.repository.mergeCloudSupertag(
        id: id,
        definition: tombstone,
        isDeleted: true,
        sortOrder: 1,
        modifiedAt: Date(timeIntervalSince1970: 20),
        dirtyGeneration: 8,
        systemFields: Data([2])
      )
    )
    try await XCTAssertAsyncFalse(try await fixture.repository.supertags().contains { $0.id == id })

    live.name = "Reading again"
    try await fixture.repository.saveSupertag(live, now: Date(timeIntervalSince1970: 30))
    try await XCTAssertAsyncTrue(
      try await fixture.repository.applyCloudSupertagRecordDeletion(id: id)
    )
    try await XCTAssertAsyncEqual(
      try await fixture.repository.supertags().first { $0.id == id }?.name,
      "Reading again"
    )

    let resurrectionGeneration = try await XCTUnwrapAsync(
      try await fixture.repository.supertagCloudRecord(id: id)?.dirtyGeneration
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.markSupertagCloudSaved(
        id: id,
        sentGeneration: resurrectionGeneration,
        systemFields: Data([3])
      )
    )
    try await XCTAssertAsyncFalse(
      try await fixture.repository.applyCloudSupertagRecordDeletion(id: id)
    )
    try await XCTAssertAsyncFalse(try await fixture.repository.supertags().contains { $0.id == id })
  }
}

private final class CloudSyncReliabilityFixture {
  let path: String
  let repository: LibraryRepository

  init() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-cloud-reliability-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    path = directory.appendingPathComponent("library.sqlite").path
    repository = try LibraryRepository(path: path)
  }
}

private func XCTAssertAsyncTrue(
  _ expression: @autoclosure () async throws -> Bool,
  _ message: @autoclosure () -> String = "",
  file: StaticString = #filePath,
  line: UInt = #line
) async rethrows {
  let value = try await expression()
  XCTAssertTrue(value, message(), file: file, line: line)
}

private func XCTAssertAsyncFalse(
  _ expression: @autoclosure () async throws -> Bool,
  _ message: @autoclosure () -> String = "",
  file: StaticString = #filePath,
  line: UInt = #line
) async rethrows {
  let value = try await expression()
  XCTAssertFalse(value, message(), file: file, line: line)
}

private func XCTAssertAsyncEqual<Value: Equatable>(
  _ expression: @autoclosure () async throws -> Value,
  _ expected: Value,
  _ message: @autoclosure () -> String = "",
  file: StaticString = #filePath,
  line: UInt = #line
) async rethrows {
  let value = try await expression()
  XCTAssertEqual(value, expected, message(), file: file, line: line)
}

private func XCTAssertAsyncNil<Value>(
  _ expression: @autoclosure () async throws -> Value?,
  _ message: @autoclosure () -> String = "",
  file: StaticString = #filePath,
  line: UInt = #line
) async rethrows {
  let value = try await expression()
  XCTAssertNil(value, message(), file: file, line: line)
}

private func XCTAssertAsyncNotNil<Value>(
  _ expression: @autoclosure () async throws -> Value?,
  _ message: @autoclosure () -> String = "",
  file: StaticString = #filePath,
  line: UInt = #line
) async rethrows {
  let value = try await expression()
  XCTAssertNotNil(value, message(), file: file, line: line)
}

private func XCTUnwrapAsync<Value>(
  _ expression: @autoclosure () async throws -> Value?,
  _ message: @autoclosure () -> String = "",
  file: StaticString = #filePath,
  line: UInt = #line
) async throws -> Value {
  let value = try await expression()
  return try XCTUnwrap(value, message(), file: file, line: line)
}
