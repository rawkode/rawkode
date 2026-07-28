import CloudKit
import Foundation
import XCTest
@testable import EnchiridionCore

final class CloudSyncPolicyTests: XCTestCase {
  func testEffectiveEntitlementRequiresContainerCloudKitAndPush() {
    let container = [CloudSyncCoordinator.containerIdentifier]

    XCTAssertTrue(
      CloudSyncCoordinator.hasRequiredEntitlements(
        containerIdentifiers: container,
        iCloudServices: ["CloudKit"],
        pushEnvironment: "development"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.hasRequiredEntitlements(
        containerIdentifiers: container,
        iCloudServices: [],
        pushEnvironment: "development"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.hasRequiredEntitlements(
        containerIdentifiers: container,
        iCloudServices: ["CloudKit"],
        pushEnvironment: nil
      )
    )
  }

  func testMobileEntitlementRequiresSigningAndDeclaredFile() {
    let path = "Configuration/EnchiridionMobile.entitlements"

    XCTAssertTrue(
      CloudSyncCoordinator.hasRequiredEntitlement(
        declaredEntitlementsPath: path,
        codeSigningAllowed: "YES"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.hasRequiredEntitlement(
        declaredEntitlementsPath: path,
        codeSigningAllowed: "NO"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.hasRequiredEntitlement(
        declaredEntitlementsPath: nil,
        codeSigningAllowed: "YES"
      )
    )
  }

  func testFailureDispositionSeparatesAutomaticAndApplicationRecovery() {
    XCTAssertEqual(
      CloudSyncCoordinator.disposition(for: .networkUnavailable),
      .retryAutomatically
    )
    XCTAssertEqual(
      CloudSyncCoordinator.disposition(for: .serverRecordChanged),
      .mergeServerRecord
    )
    XCTAssertEqual(CloudSyncCoordinator.disposition(for: .zoneNotFound), .recreateZone)
    XCTAssertEqual(CloudSyncCoordinator.disposition(for: .unknownItem), .recreateRecord)
    XCTAssertEqual(CloudSyncCoordinator.disposition(for: .notAuthenticated), .signedOut)
    XCTAssertEqual(
      CloudSyncCoordinator.disposition(for: .permissionFailure),
      .requiresAttention
    )
    XCTAssertEqual(CloudSyncCoordinator.revalidationDelay(forAttempt: 0), 5)
    XCTAssertEqual(CloudSyncCoordinator.revalidationDelay(forAttempt: 2), 60)
    XCTAssertEqual(CloudSyncCoordinator.revalidationDelay(forAttempt: 99), 300)
  }

  func testPermanentFailuresRemainDirtyWithoutImmediateRequeue() {
    XCTAssertFalse(
      CloudSyncCoordinator.shouldImmediatelyRequeue(disposition: .requiresAttention)
    )
    XCTAssertFalse(
      CloudSyncCoordinator.shouldImmediatelyRequeue(disposition: .retryAutomatically)
    )
    XCTAssertTrue(
      CloudSyncCoordinator.shouldImmediatelyRequeue(disposition: .mergeServerRecord)
    )
    XCTAssertTrue(
      CloudSyncCoordinator.shouldImmediatelyRequeue(disposition: .recreateZone)
    )
    XCTAssertTrue(
      CloudSyncCoordinator.shouldImmediatelyRequeue(disposition: .recreateRecord)
    )
    XCTAssertFalse(
      CloudSyncCoordinator.shouldImmediatelyRequeueAfterAcknowledgement(
        localPersistenceSucceeded: false,
        stillDirty: true
      )
    )
    XCTAssertTrue(
      CloudSyncCoordinator.shouldImmediatelyRequeueAfterAcknowledgement(
        localPersistenceSucceeded: true,
        stillDirty: true
      )
    )
  }

  func testAccountAndIdentityPoliciesPreventCrossAccountTransferAndEngineChurn() {
    XCTAssertFalse(
      CloudSyncCoordinator.permitsCloudDataTransfer(accountAuthorized: false)
    )
    XCTAssertTrue(
      CloudSyncCoordinator.permitsCloudDataTransfer(accountAuthorized: true)
    )
    XCTAssertTrue(
      CloudSyncCoordinator.shouldReplaceEngineOnSignIn(accountAuthorized: false)
    )
    XCTAssertFalse(
      CloudSyncCoordinator.shouldReplaceEngineOnSignIn(accountAuthorized: true)
    )

    XCTAssertTrue(
      CloudSyncCoordinator.isValidRecordIdentity(
        recordType: "Page",
        recordName: "page-1"
      )
    )
    XCTAssertTrue(
      CloudSyncCoordinator.isValidRecordIdentity(
        recordType: "SavedView",
        recordName: "saved-view:view-1"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.isValidRecordIdentity(
        recordType: "Page",
        recordName: "saved-view:view-1"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.isValidRecordIdentity(
        recordType: "Unknown",
        recordName: "page-1"
      )
    )
  }

  func testSyncStatusDetailRetainsActionableContext() {
    XCTAssertTrue(SyncStatus.localOnly.detail.contains("safe on this device"))
    XCTAssertTrue(SyncStatus.offline.detail.contains("sync automatically"))
    XCTAssertEqual(
      SyncStatus.attentionRequired("Repair the account.").detail,
      "Repair the account."
    )
  }

  func testAssetRegistryRemovesOnlyAcknowledgedGeneration() {
    let zoneID = CKRecordZone.ID(
      zoneName: CloudSyncCoordinator.zoneName,
      ownerName: CKCurrentUserDefaultName
    )
    let recordID = CKRecord.ID(recordName: "page-1", zoneID: zoneID)
    let first = URL(fileURLWithPath: "/tmp/asset-first")
    let second = URL(fileURLWithPath: "/tmp/asset-second")
    var registry = CloudAssetRegistry()

    registry.register(first, for: recordID)
    registry.register(second, for: recordID)

    XCTAssertEqual(
      registry.removeURL(for: recordID, preferredURL: first),
      first
    )
    XCTAssertEqual(registry.urls[recordID], [second])
    XCTAssertEqual(
      registry.removeURL(for: recordID, preferredURL: second),
      second
    )
    XCTAssertNil(registry.urls[recordID])
  }
}

final class CloudSyncRepositoryTests: XCTestCase {
  func testSaveAcknowledgementsNeverClearNewerPageViewPurgeOrSupertagEdits() async throws {
    let fixture = try CloudRepositoryFixture()

    let page = try await fixture.repository.createFreePage(title: "Page")
    try await fixture.repository.togglePinned(pageID: page.id)
    let pageStillDirty = try await fixture.repository.markCloudSaved(
      pageID: page.id,
      sentGeneration: page.dirtyGeneration,
      systemFields: Data([1])
    )
    XCTAssertTrue(pageStillDirty)
    let dirtyPages = try await fixture.repository.dirtyPages()
    XCTAssertTrue(dirtyPages.contains { $0.id == page.id })

    let view = LiveQueryDefinition(name: "Race", source: .pages)
    try await fixture.repository.saveView(view, now: Date(timeIntervalSince1970: 10))
    let firstViewRecord = try await fixture.repository.savedViewCloudRecord(id: view.id)
    let firstViewGeneration = try XCTUnwrap(firstViewRecord?.dirtyGeneration)
    var renamedView = view
    renamedView.name = "Race again"
    try await fixture.repository.saveView(renamedView, now: Date(timeIntervalSince1970: 20))
    let viewStillDirty = try await fixture.repository.markViewCloudSaved(
      id: view.id,
      sentGeneration: firstViewGeneration,
      systemFields: Data([2])
    )
    XCTAssertTrue(viewStillDirty)

    let purgedPage = try await fixture.repository.createFreePage(title: "Purge")
    try await fixture.repository.moveToTrash(pageID: purgedPage.id)
    try await fixture.repository.purge(pageID: purgedPage.id)
    let loadedMarker = try await fixture.repository.purgeMarker(pageID: purgedPage.id)
    let marker = try XCTUnwrap(loadedMarker)
    let purgeStillDirty = try await fixture.repository.markPurgeCloudSaved(
      pageID: purgedPage.id,
      sentGeneration: marker.generation - 1,
      systemFields: Data([3])
    )
    XCTAssertTrue(purgeStillDirty)

    var supertag = SupertagDefinition.draft(name: "Book")
    try await fixture.repository.saveSupertag(supertag, now: Date(timeIntervalSince1970: 30))
    let firstSupertagRecord = try await fixture.repository.supertagCloudRecord(id: supertag.id)
    let firstSupertagGeneration = try XCTUnwrap(firstSupertagRecord?.dirtyGeneration)
    supertag.name = "Reading"
    try await fixture.repository.saveSupertag(supertag, now: Date(timeIntervalSince1970: 40))
    let supertagStillDirty = try await fixture.repository.markSupertagCloudSaved(
      id: supertag.id,
      sentGeneration: firstSupertagGeneration,
      systemFields: Data([4])
    )
    XCTAssertTrue(supertagStillDirty)
  }

  func testDirtyLocalViewAndSupertagWinFetchedConflictUntilAcknowledged() async throws {
    let fixture = try CloudRepositoryFixture()
    let localView = LiveQueryDefinition(
      id: .init(rawValue: "view-conflict"),
      name: "Local",
      source: .pages
    )
    var remoteView = localView
    remoteView.name = "Remote"
    try await fixture.repository.saveView(localView, now: Date(timeIntervalSince1970: 10))

    let viewNeedsUpload = try await fixture.repository.mergeCloudView(
      id: localView.id,
      definition: remoteView,
      isDeleted: false,
      sortOrder: 1,
      modifiedAt: Date(timeIntervalSince1970: 100),
      dirtyGeneration: 99,
      systemFields: Data([1])
    )
    XCTAssertTrue(viewNeedsUpload)
    let preservedView = try await fixture.repository.savedViewCloudRecord(id: localView.id)
    XCTAssertEqual(preservedView?.definition.name, "Local")

    var localTag = SupertagDefinition.draft(name: "Local tag")
    try await fixture.repository.saveSupertag(localTag, now: Date(timeIntervalSince1970: 10))
    var remoteTag = localTag
    remoteTag.name = "Remote tag"
    let supertagNeedsUpload = try await fixture.repository.mergeCloudSupertag(
      id: localTag.id,
      definition: remoteTag,
      isDeleted: false,
      sortOrder: 1,
      modifiedAt: Date(timeIntervalSince1970: 100),
      dirtyGeneration: 99,
      systemFields: Data([2])
    )
    XCTAssertTrue(supertagNeedsUpload)
    let preservedTag = try await fixture.repository.supertagCloudRecord(id: localTag.id)
    localTag = try XCTUnwrap(preservedTag?.definition)
    XCTAssertEqual(localTag.name, "Local tag")
  }

  func testRemotePurgePreservesDirtyPageAndDirtyPurgeBlocksRemoteLiveZombie() async throws {
    let fixture = try CloudRepositoryFixture()
    let dirtyPage = try await fixture.repository.createFreePage(title: "Unsynced")

    let purgeNeedsUpload = try await fixture.repository.applyCloudPurge(
      pageID: dirtyPage.id,
      generation: 100,
      purgedAt: Date(timeIntervalSince1970: 100),
      systemFields: Data([1])
    )
    XCTAssertTrue(purgeNeedsUpload)
    let preservedPage = try await fixture.repository.page(id: dirtyPage.id)
    let absentPurge = try await fixture.repository.purgeMarker(pageID: dirtyPage.id)
    XCTAssertNotNil(preservedPage)
    XCTAssertNil(absentPurge)

    let purgedPage = try await fixture.repository.createFreePage(title: "Purged locally")
    let remoteDocument = purgedPage.document
    try await fixture.repository.moveToTrash(pageID: purgedPage.id)
    try await fixture.repository.purge(pageID: purgedPage.id)

    let merge = try await fixture.repository.mergeCloudPage(
      pageID: purgedPage.id,
      kind: purgedPage.kind,
      remoteDocument: remoteDocument,
      systemFields: Data([2])
    )
    XCTAssertNil(merge.page)
    XCTAssertTrue(merge.needsUpload)
    let absentPage = try await fixture.repository.page(id: purgedPage.id)
    let preservedPurge = try await fixture.repository.purgeMarker(pageID: purgedPage.id)
    XCTAssertNil(absentPage)
    XCTAssertNotNil(preservedPurge)
  }

  func testCleanPurgeCanBeSupersededByRemoteLiveRecordWithoutZombieMarker() async throws {
    let fixture = try CloudRepositoryFixture()
    let page = try await fixture.repository.createFreePage(title: "Restore remotely")
    let remoteDocument = page.document
    try await fixture.repository.moveToTrash(pageID: page.id)
    try await fixture.repository.purge(pageID: page.id)
    let loadedMarker = try await fixture.repository.purgeMarker(pageID: page.id)
    let marker = try XCTUnwrap(loadedMarker)
    let purgeStillDirty = try await fixture.repository.markPurgeCloudSaved(
      pageID: page.id,
      sentGeneration: marker.generation,
      systemFields: Data([1])
    )
    XCTAssertFalse(purgeStillDirty)

    let merge = try await fixture.repository.mergeCloudPage(
      pageID: page.id,
      kind: page.kind,
      remoteDocument: remoteDocument,
      systemFields: Data([2])
    )
    XCTAssertNotNil(merge.page)
    XCTAssertFalse(merge.needsUpload)
    let absentMarker = try await fixture.repository.purgeMarker(pageID: page.id)
    XCTAssertNil(absentMarker)
  }

  func testSupertagCloudRoundTripTombstoneAndHardDeletionPolicy() async throws {
    let source = try CloudRepositoryFixture()
    var definition = SupertagDefinition.draft(name: "Book")
    try await source.repository.saveSupertag(definition, now: Date(timeIntervalSince1970: 10))
    let loadedOutbound = try await source.repository.supertagCloudRecord(id: definition.id)
    let outbound = try XCTUnwrap(loadedOutbound)

    let target = try CloudRepositoryFixture()
    let targetNeedsUpload = try await target.repository.mergeCloudSupertag(
      id: outbound.id,
      definition: outbound.definition,
      isDeleted: false,
      sortOrder: outbound.sortOrder,
      modifiedAt: outbound.modifiedAt,
      dirtyGeneration: outbound.dirtyGeneration,
      systemFields: Data([1])
    )
    XCTAssertFalse(targetNeedsUpload)
    let targetStillDirty = try await target.repository.markSupertagCloudSaved(
      id: outbound.id,
      sentGeneration: outbound.dirtyGeneration,
      systemFields: Data([2])
    )
    XCTAssertFalse(targetStillDirty)

    definition.isDeleted = true
    try await source.repository.saveSupertag(definition, now: Date(timeIntervalSince1970: 20))
    let loadedTombstone = try await source.repository.supertagCloudRecord(id: definition.id)
    let tombstone = try XCTUnwrap(loadedTombstone)
    XCTAssertTrue(tombstone.isDeleted)

    let deletionNeedsUpload = try await target.repository.applyCloudSupertagRecordDeletion(
      id: outbound.id
    )
    XCTAssertFalse(deletionNeedsUpload)
    let visibleTags = try await target.repository.supertags()
    XCTAssertFalse(visibleTags.contains { $0.id == outbound.id })
  }

  func testUnresolvedRecordQuarantinePersistsAcrossRelaunchAndClearsExplicitly() async throws {
    let fixture = try CloudRepositoryFixture()
    try await fixture.repository.markCloudRecordUnresolved(
      recordName: "page-malformed",
      detectedAt: Date(timeIntervalSince1970: 10)
    )

    let reopened = try LibraryRepository(path: fixture.path)
    let reopenedUnresolved = try await reopened.unresolvedCloudRecordNames()
    XCTAssertEqual(reopenedUnresolved, ["page-malformed"])

    try await reopened.clearUnresolvedCloudRecord(recordName: "page-malformed")
    let unresolved = try await reopened.unresolvedCloudRecordNames()
    XCTAssertTrue(unresolved.isEmpty)
  }

  func testZoneRecoveryMarksEveryCloudEntityDirtyAndClearsSystemFields() async throws {
    let fixture = try CloudRepositoryFixture()
    let page = try await fixture.repository.createFreePage(title: "Page")
    try await fixture.repository.markCloudSaved(
      pageID: page.id,
      sentGeneration: page.dirtyGeneration,
      systemFields: Data([1])
    )
    let view = LiveQueryDefinition(name: "View", source: .pages)
    try await fixture.repository.saveView(view)
    let viewRecord = try await fixture.repository.savedViewCloudRecord(id: view.id)
    let viewGeneration = try XCTUnwrap(viewRecord?.dirtyGeneration)
    try await fixture.repository.markViewCloudSaved(
      id: view.id,
      sentGeneration: viewGeneration,
      systemFields: Data([2])
    )
    let tag = SupertagDefinition.draft(name: "Tag")
    try await fixture.repository.saveSupertag(tag)
    let tagRecord = try await fixture.repository.supertagCloudRecord(id: tag.id)
    let tagGeneration = try XCTUnwrap(tagRecord?.dirtyGeneration)
    try await fixture.repository.markSupertagCloudSaved(
      id: tag.id,
      sentGeneration: tagGeneration,
      systemFields: Data([3])
    )

    try await fixture.repository.markAllCloudDataForZoneRecovery()

    let dirtyPages = try await fixture.repository.dirtyPages()
    let dirtyViews = try await fixture.repository.dirtyViews()
    let dirtySupertags = try await fixture.repository.dirtySupertags()
    let pageMetadata = try await fixture.repository.cloudRecordMetadata(pageID: page.id)
    XCTAssertTrue(dirtyPages.contains { $0.id == page.id })
    XCTAssertTrue(dirtyViews.contains { $0.id == view.id })
    XCTAssertTrue(dirtySupertags.contains { $0.id == tag.id })
    XCTAssertNil(pageMetadata)
  }
}

private final class CloudRepositoryFixture {
  let path: String
  let repository: LibraryRepository

  init() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-cloud-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    path = directory.appendingPathComponent("library.sqlite").path
    repository = try LibraryRepository(path: path)
  }
}
