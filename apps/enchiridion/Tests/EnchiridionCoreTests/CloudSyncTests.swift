import CloudKit
import CryptoKit
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

  func testRecordPreparationFailureWaitsForAnExplicitRecoveryTrigger() {
    XCTAssertFalse(
      CloudSyncCoordinator.shouldQueueDirtyRecords(for: .recordPreparationFailure)
    )
    XCTAssertTrue(CloudSyncCoordinator.shouldQueueDirtyRecords(for: .manualSync))
    XCTAssertTrue(CloudSyncCoordinator.shouldQueueDirtyRecords(for: .localMutation))
    XCTAssertTrue(CloudSyncCoordinator.shouldQueueDirtyRecords(for: .launch))
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
    XCTAssertTrue(
      CloudSyncCoordinator.isValidRecordIdentity(
        recordType: "GraphRelation",
        recordName: "graph-relation:reports-to"
      )
    )
    XCTAssertTrue(
      CloudSyncCoordinator.isValidRecordIdentity(
        recordType: "GraphQuery",
        recordName: "graph-query:leadership"
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
        recordType: "Page",
        recordName: "graph-relation:reports-to"
      )
    )
    XCTAssertFalse(
      CloudSyncCoordinator.isValidRecordIdentity(
        recordType: "GraphQuery",
        recordName: "graph-relation:leadership"
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

  func testStalePendingSaveCannotPrepareLocalOnlyOtherPersonRecord() async throws {
    let fixture = try CloudRepositoryFixture()
    let event = cloudPersonEvent(email: "local-only@example.com")
    try await fixture.repository.replaceCalendarProjection([event], provider: "eventkit")
    let pageID = PageID.person(email: "local-only@example.com")
    let eligiblePage = try await fixture.repository.cloudEligiblePage(pageID: pageID)
    XCTAssertNil(eligiblePage)
    let preparedPage = try await CloudSyncCoordinator.pageForPendingSave(
      pageID,
      repository: fixture.repository
    )
    XCTAssertNil(preparedPage)
  }

  func testPromotedClassificationDominatesStaleOtherAcrossRepositories() async throws {
    let source = try CloudRepositoryFixture()
    let target = try CloudRepositoryFixture()
    let email = "cross-device@example.com"
    let pageID = PageID.person(email: email)
    let event = cloudPersonEvent(email: email)
    try await source.repository.replaceCalendarProjection([event], provider: "eventkit")
    let loadedStaleOther = try await source.repository.page(id: pageID)
    let staleOther = try XCTUnwrap(loadedStaleOther)

    let initialTargetMerge = try await target.repository.mergeCloudPage(
      pageID: pageID,
      kind: staleOther.kind,
      remoteDocument: staleOther.document,
      systemFields: Data([1])
    )
    XCTAssertEqual(initialTargetMerge.page?.effectivePersonVisibility, .other)
    let initiallyEligibleTarget = try await target.repository.cloudEligiblePage(pageID: pageID)
    XCTAssertNil(initiallyEligibleTarget)

    let promotedSource = try await source.repository.promotePerson(pageID: pageID)
    let targetMerge = try await target.repository.mergeCloudPage(
      pageID: pageID,
      kind: promotedSource.kind,
      remoteDocument: promotedSource.document,
      systemFields: Data([2])
    )
    XCTAssertEqual(targetMerge.page?.effectivePersonVisibility, .promoted)
    let eligibleTarget = try await target.repository.cloudEligiblePage(pageID: pageID)
    XCTAssertNotNil(eligibleTarget)

    let sourceMerge = try await source.repository.mergeCloudPage(
      pageID: pageID,
      kind: staleOther.kind,
      remoteDocument: staleOther.document,
      systemFields: Data([3])
    )
    XCTAssertEqual(sourceMerge.page?.effectivePersonVisibility, .promoted)
    let eligibleSource = try await source.repository.cloudEligiblePage(pageID: pageID)
    XCTAssertNotNil(eligibleSource)
  }

  func testInheritedOtherPersonQueuesPrivacyDeleteAndPreservesLocalPage() async throws {
    let fixture = try CloudRepositoryFixture()
    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveSupertag(employee)
    let page = try await fixture.repository.createTaggedPage(title: "Ada", supertagID: employee.id)

    _ = try await fixture.repository.movePersonToOther(pageID: page.id)
    let removals = try await fixture.repository.claimCloudPrivacyRemovalsForSync()
    let eligible = try await fixture.repository.cloudEligiblePage(pageID: page.id)
    let prepared = try await CloudSyncCoordinator.pageForPendingSave(
      page.id,
      repository: fixture.repository
    )
    let retained = try await fixture.repository.page(id: page.id)
    let dirtyPages = try await fixture.repository.dirtyPages()

    XCTAssertEqual(removals.map(\.pageID), [page.id])
    XCTAssertNil(eligible)
    XCTAssertNil(prepared)
    XCTAssertNotNil(retained)
    XCTAssertFalse(dirtyPages.contains { $0.id == page.id })
  }

  func testPrivacyDeleteAcknowledgementIsCompensatedAfterPromotion() async throws {
    let fixture = try CloudRepositoryFixture()
    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveSupertag(employee)
    let page = try await fixture.repository.createTaggedPage(title: "Ada", supertagID: employee.id)

    _ = try await fixture.repository.movePersonToOther(pageID: page.id)
    let removals = try await fixture.repository.claimCloudPrivacyRemovalsForSync()
    let removal = try XCTUnwrap(removals.first)
    _ = try await fixture.repository.promotePerson(pageID: page.id)
    let acknowledgement = try await fixture.repository.acknowledgeCloudPrivacyRemoval(
      pageID: page.id,
      sentGeneration: removal.generation
    )
    let eligible = try await fixture.repository.cloudEligiblePage(pageID: page.id)
    let dirtyPages = try await fixture.repository.dirtyPages()

    XCTAssertEqual(acknowledgement, .save(page.id))
    XCTAssertNotNil(eligible)
    XCTAssertTrue(dirtyPages.contains { $0.id == page.id })
  }

  func testDeleteAcknowledgementAfterPromotionClaimsCompensatingSave() async throws {
    let fixture = try CloudRepositoryFixture()
    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveSupertag(employee)
    let page = try await fixture.repository.createTaggedPage(title: "Ada", supertagID: employee.id)

    _ = try await fixture.repository.movePersonToOther(pageID: page.id)
    let removals = try await fixture.repository.claimCloudPrivacyRemovalsForSync()
    let removal = try XCTUnwrap(removals.first)
    let promoted = try await fixture.repository.promotePerson(pageID: page.id)

    let deleteAcknowledgement = try await fixture.repository.acknowledgeCloudPrivacyRemoval(
      pageID: page.id,
      sentGeneration: removal.generation
    )
    let duplicateCompensatingSaves = try await fixture.repository.claimCloudPrivacySavesForSync()
    let saveAcknowledgement = try await fixture.repository.acknowledgeCloudPrivacySave(
      pageID: page.id,
      sentPageGeneration: promoted.dirtyGeneration
    )
    let subsequentSaves = try await fixture.repository.claimCloudPrivacySavesForSync()

    XCTAssertEqual(deleteAcknowledgement, .save(page.id))
    XCTAssertTrue(duplicateCompensatingSaves.isEmpty)
    XCTAssertEqual(saveAcknowledgement, .none)
    XCTAssertTrue(subsequentSaves.isEmpty)
  }

  func testSteadyPrivacyDeleteAcknowledgementDoesNotRequeueAndSuppressesDeletionEcho() async throws {
    let fixture = try CloudRepositoryFixture()
    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveSupertag(employee)
    let page = try await fixture.repository.createTaggedPage(title: "Ada", supertagID: employee.id)

    _ = try await fixture.repository.movePersonToOther(pageID: page.id)
    let initialRemovals = try await fixture.repository.claimCloudPrivacyRemovalsForSync()
    let removal = try XCTUnwrap(initialRemovals.first)
    let acknowledgement = try await fixture.repository.acknowledgeCloudPrivacyRemoval(
      pageID: page.id,
      sentGeneration: removal.generation
    )
    let subsequentRemovals = try await fixture.repository.claimCloudPrivacyRemovalsForSync()
    let deletionEchoShouldRetry = try await fixture.repository.applyCloudPageRecordDeletion(pageID: page.id)
    let retained = try await fixture.repository.page(id: page.id)

    XCTAssertEqual(acknowledgement, .none)
    XCTAssertTrue(subsequentRemovals.isEmpty)
    XCTAssertFalse(deletionEchoShouldRetry)
    XCTAssertNotNil(retained)
  }

  func testLateDeleteAcknowledgementAfterSettledPromotionQueuesCompensatingSave() async throws {
    let fixture = try CloudRepositoryFixture()
    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveSupertag(employee)
    let page = try await fixture.repository.createTaggedPage(title: "Ada", supertagID: employee.id)

    _ = try await fixture.repository.movePersonToOther(pageID: page.id)
    let removals = try await fixture.repository.claimCloudPrivacyRemovalsForSync()
    let removal = try XCTUnwrap(removals.first)
    _ = try await fixture.repository.promotePerson(pageID: page.id)
    let initialSaves = try await fixture.repository.claimCloudPrivacySavesForSync()
    let save = try XCTUnwrap(initialSaves.first)
    let acknowledgement = try await fixture.repository.acknowledgeCloudPrivacySave(
      pageID: page.id,
      sentPageGeneration: save.pageDirtyGeneration
    )
    let lateDeleteAcknowledgement = try await fixture.repository.acknowledgeCloudPrivacyRemoval(
      pageID: page.id,
      sentGeneration: removal.generation
    )
    let subsequentSaves = try await fixture.repository.claimCloudPrivacySavesForSync()

    XCTAssertEqual(acknowledgement, .none)
    XCTAssertEqual(lateDeleteAcknowledgement, .save(page.id))
    XCTAssertTrue(subsequentSaves.isEmpty)
    let compensatingAcknowledgement = try await fixture.repository.acknowledgeCloudPrivacySave(
      pageID: page.id,
      sentPageGeneration: save.pageDirtyGeneration
    )
    let settledSaves = try await fixture.repository.claimCloudPrivacySavesForSync()
    XCTAssertEqual(compensatingAcknowledgement, .none)
    XCTAssertTrue(settledSaves.isEmpty)
  }

  func testPrivacySaveUsesPreparedRecordGenerationAfterAnInterveningEdit() async throws {
    let fixture = try CloudRepositoryFixture()
    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveSupertag(employee)
    let page = try await fixture.repository.createTaggedPage(title: "Ada", supertagID: employee.id)

    _ = try await fixture.repository.movePersonToOther(pageID: page.id)
    _ = try await fixture.repository.claimCloudPrivacyRemovalsForSync()
    _ = try await fixture.repository.promotePerson(pageID: page.id)
    let claimedSaves = try await fixture.repository.claimCloudPrivacySavesForSync()
    let claimed = try XCTUnwrap(claimedSaves.first)

    let emailKey = SupertagPropertyKey(
      supertagID: BuiltInSupertags.person,
      fieldID: .init(rawValue: "email")
    )
    try await fixture.repository.setProperty(
      pageID: page.id,
      key: emailKey,
      values: [.email("ada@example.com")]
    )
    let preparedPage = try await fixture.repository.page(id: page.id)
    let prepared = try XCTUnwrap(preparedPage)
    XCTAssertGreaterThan(prepared.dirtyGeneration, claimed.pageDirtyGeneration)

    let acknowledgement = try await fixture.repository.acknowledgeCloudPrivacySave(
      pageID: page.id,
      sentPageGeneration: prepared.dirtyGeneration
    )
    let subsequentSaves = try await fixture.repository.claimCloudPrivacySavesForSync()

    XCTAssertEqual(acknowledgement, .none)
    XCTAssertTrue(subsequentSaves.isEmpty)
  }

  func testCloudMergeUsesInheritedPersonPrivacyForEligibilityAndDeletion() async throws {
    let source = try CloudRepositoryFixture()
    let target = try CloudRepositoryFixture()
    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await source.repository.saveSupertag(employee)
    try await target.repository.saveSupertag(employee)
    let page = try await source.repository.createTaggedPage(title: "Ada", supertagID: employee.id)
    let localOnly = try await source.repository.movePersonToOther(pageID: page.id)

    let merge = try await target.repository.mergeCloudPage(
      pageID: page.id,
      kind: localOnly.kind,
      remoteDocument: localOnly.document,
      systemFields: Data([1])
    )
    let eligible = try await target.repository.cloudEligiblePage(pageID: page.id)
    let dirtyPages = try await target.repository.dirtyPages()
    let removals = try await target.repository.claimCloudPrivacyRemovalsForSync()

    XCTAssertFalse(merge.needsUpload)
    XCTAssertNil(eligible)
    XCTAssertFalse(dirtyPages.contains { $0.id == page.id })
    XCTAssertEqual(removals.map(\.pageID), [page.id])
  }

  func testRemovingInheritedPersonTypeRetainsExistingLocalOnlyEligibility() async throws {
    let fixture = try CloudRepositoryFixture()
    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveSupertag(employee)
    let page = try await fixture.repository.createTaggedPage(title: "Ada", supertagID: employee.id)

    _ = try await fixture.repository.movePersonToOther(pageID: page.id)
    let removals = try await fixture.repository.claimCloudPrivacyRemovalsForSync()
    let removal = try XCTUnwrap(removals.first)
    try await fixture.repository.removeSupertag(employee.id, from: page.id)
    let eligible = try await fixture.repository.cloudEligiblePage(pageID: page.id)
    let acknowledgement = try await fixture.repository.acknowledgeCloudPrivacyRemoval(
      pageID: page.id,
      sentGeneration: removal.generation
    )
    let dirtyPages = try await fixture.repository.dirtyPages()

    XCTAssertNil(eligible)
    XCTAssertEqual(acknowledgement, .none)
    XCTAssertFalse(dirtyPages.contains { $0.id == page.id })
  }

  func testStalePromotionSaveAfterDemotionRequeuesDelete() async throws {
    let fixture = try CloudRepositoryFixture()
    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveSupertag(employee)
    let page = try await fixture.repository.createTaggedPage(title: "Ada", supertagID: employee.id)

    _ = try await fixture.repository.movePersonToOther(pageID: page.id)
    _ = try await fixture.repository.claimCloudPrivacyRemovalsForSync()
    _ = try await fixture.repository.promotePerson(pageID: page.id)
    let initialSaves = try await fixture.repository.claimCloudPrivacySavesForSync()
    let save = try XCTUnwrap(initialSaves.first)
    _ = try await fixture.repository.movePersonToOther(pageID: page.id)
    let subsequentRemovals = try await fixture.repository.claimCloudPrivacyRemovalsForSync()
    let removal = try XCTUnwrap(subsequentRemovals.first)
    let acknowledgement = try await fixture.repository.acknowledgeCloudPrivacySave(
      pageID: page.id,
      sentPageGeneration: save.pageDirtyGeneration
    )

    XCTAssertEqual(acknowledgement, .delete(removal))
  }

  func testInheritedPersonWithoutVisibilityKeepsLegacyCloudEligibility() async throws {
    let fixture = try CloudRepositoryFixture()
    var employee = SupertagDefinition.draft(name: "Employee")
    employee.parentIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveSupertag(employee)
    let page = try await fixture.repository.createTaggedPage(title: "Legacy", supertagID: employee.id)
    let persisted = try await fixture.repository.page(id: page.id)
    let eligible = try await fixture.repository.cloudEligiblePage(pageID: page.id)
    let removals = try await fixture.repository.claimCloudPrivacyRemovalsForSync()

    XCTAssertNil(persisted?.effectivePersonVisibility)
    XCTAssertNotNil(eligible)
    XCTAssertTrue(removals.isEmpty)
  }

  private func cloudPersonEvent(email: String) -> CalendarEventSnapshot {
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    return CalendarEventSnapshot(
      identity: .init(
        provider: "eventkit",
        externalIdentifier: "person-\(email)",
        occurrenceStart: start
      ),
      title: "Meeting",
      startDate: start,
      endDate: start.addingTimeInterval(3_600),
      isAllDay: false,
      location: nil,
      notes: nil,
      url: nil,
      calendarTitle: "Calendar",
      attendees: [
        .init(
          email: email,
          displayName: "Person",
          role: "attendee",
          responseStatus: "accepted",
          isCurrentUser: false
        )
      ]
    )
  }
}

final class BookmarkCloudCarrierTransportTests: XCTestCase {
  func testOutgoingCarrierUsesOrdinaryPageAssetWithOnlyDigestDeletionContent() async throws {
    let fixture = try CloudRepositoryFixture()
    let request = bookmarkRequest(
      url: "https://private.example.test/article?token=never-upload-as-carrier",
      note: "private-note-never-upload-as-carrier"
    )
    let bookmark = try await fixture.repository.materializeBookmark(request)
    try await fixture.repository.moveToTrash(pageID: bookmark.pageID, now: request.capturedAt)
    let carrierIDs = try await fixture.repository.bookmarkDeletionCarrierPageIDs(
      urlKeyDigest: bookmark.urlKey.digest
    )
    let carrierID = try XCTUnwrap(carrierIDs.first)
    let coordinator = makeCoordinator(repository: fixture.repository)

    let prepared = await coordinator.preparePageRecordForTesting(carrierID)
    let record = try XCTUnwrap(prepared)
    XCTAssertEqual(record.recordType, "Page")
    XCTAssertEqual(record.recordID.recordName, carrierID.rawValue)
    XCTAssertEqual(Set(record.allKeys()), Set([
      "purged", "schemaVersion", "kind", "document", "contentHash", "modifiedAt",
      "dirtyGeneration",
    ]))
    let kindData = try XCTUnwrap(record["kind"] as? Data)
    XCTAssertEqual(try JSONDecoder.enchiridion.decode(PageKind.self, from: kindData), .free)
    let asset = try XCTUnwrap(record["document"] as? CKAsset)
    let assetURL = try XCTUnwrap(asset.fileURL)
    let bytes = try Data(contentsOf: assetURL)
    XCTAssertEqual(record["contentHash"] as? String, sha256(bytes))

    let carrier = try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: bytes)
    XCTAssertTrue(carrier.isCanonicalCarrier)
    XCTAssertEqual(carrier.canonicalDeletion?.urlKeyDigest, bookmark.urlKey.digest)
    let projection = try PageDocument.inspect(bytes, pageID: carrierID)
    XCTAssertEqual(projection.title, "Deleted Bookmark")
    XCTAssertTrue(projection.plainText.isEmpty)
    XCTAssertNotNil(projection.deletedAt)
    for forbidden in [
      request.submittedURL,
      request.note ?? "",
      request.source,
      request.platform,
      request.vaultID.rawValue,
    ] where !forbidden.isEmpty {
      XCTAssertNil(bytes.range(of: Data(forbidden.utf8)), "Carrier leaked \(forbidden)")
    }

    XCTAssertTrue(FileManager.default.fileExists(atPath: assetURL.path))
    await coordinator.discardPreparedRecordForTesting(record)
    XCTAssertFalse(FileManager.default.fileExists(atPath: assetURL.path))
  }

  func testInboundActualCarrierAssetValidatesHashAndCreatesAcknowledgedSuppression() async throws {
    let source = try CloudRepositoryFixture()
    let request = bookmarkRequest(url: "https://source.example.test/private")
    let bookmark = try await source.repository.materializeBookmark(request)
    try await source.repository.moveToTrash(pageID: bookmark.pageID, now: request.capturedAt)
    let carrierIDs = try await source.repository.bookmarkDeletionCarrierPageIDs(
      urlKeyDigest: bookmark.urlKey.digest
    )
    let carrierID = try XCTUnwrap(carrierIDs.first)
    let sourceCoordinator = makeCoordinator(repository: source.repository)
    let prepared = await sourceCoordinator.preparePageRecordForTesting(carrierID)
    let record = try XCTUnwrap(prepared)
    let generation = try XCTUnwrap((record["dirtyGeneration"] as? NSNumber)?.int64Value)
    XCTAssertGreaterThan(generation, 0)

    let corruptTarget = try CloudRepositoryFixture()
    let corruptCoordinator = makeCoordinator(repository: corruptTarget.repository)
    let expectedHash = try XCTUnwrap(record["contentHash"] as? String)
    record["contentHash"] = "corrupt" as NSString
    do {
      try await corruptCoordinator.receiveRecordForTesting(record)
      XCTFail("A mismatched asset hash must be rejected")
    } catch let error as CocoaError {
      XCTAssertEqual(error.code, .fileReadCorruptFile)
    }
    let corruptState = try await corruptTarget.repository.bookmarkSuppressionState(
      urlKeyDigest: bookmark.urlKey.digest
    )
    XCTAssertNil(corruptState)

    record["contentHash"] = expectedHash as NSString
    let target = try CloudRepositoryFixture()
    let targetCoordinator = makeCoordinator(repository: target.repository)
    try await targetCoordinator.receiveRecordForTesting(record)

    let fetchedState = try await target.repository.bookmarkSuppressionState(
      urlKeyDigest: bookmark.urlKey.digest
    )
    let state = try XCTUnwrap(fetchedState)
    XCTAssertEqual(state.stage, .carrierAcknowledged)
    XCTAssertEqual(state.carrierPageID, carrierID)
    XCTAssertEqual(state.acknowledgedGeneration, state.requiredGeneration)
    let fetchedTargetCarrierPage = try await target.repository.page(id: carrierID)
    let targetCarrierPage = try XCTUnwrap(fetchedTargetCarrierPage)
    let targetCarrier = try PageDocument.bookmarkIdentityDeletionCarrierInspection(
      in: targetCarrierPage.document
    )
    XCTAssertTrue(targetCarrier.isCanonicalCarrier)
    let visiblePages = try await target.repository.pages(in: .allPages)
    let resolvedBookmarks = try await target.repository.resolvedBookmarkPages()
    let localCaptureHistory = try await target.repository.bookmarkCaptureEvents()
    XCTAssertTrue(visiblePages.isEmpty)
    XCTAssertTrue(resolvedBookmarks.isEmpty)
    XCTAssertTrue(localCaptureHistory.isEmpty)

    await sourceCoordinator.discardPreparedRecordForTesting(record)
  }

  func testPreparedRecordGenerationFencesStaleAndExactAcknowledgements() async throws {
    let fixture = try CloudRepositoryFixture()
    let coordinator = makeCoordinator(repository: fixture.repository)
    let page = try await fixture.repository.createFreePage(title: "Generation fence")
    let stalePreparedRecord = await coordinator.preparePageRecordForTesting(page.id)
    let stalePrepared = try XCTUnwrap(stalePreparedRecord)
    let staleGeneration = try XCTUnwrap(
      (stalePrepared["dirtyGeneration"] as? NSNumber)?.int64Value
    )
    XCTAssertEqual(staleGeneration, page.dirtyGeneration)

    try await fixture.repository.togglePinned(pageID: page.id)
    let staleStillDirty = try await coordinator.acknowledgePreparedRecordForTesting(stalePrepared)
    XCTAssertTrue(staleStillDirty)
    let fetchedAfterStale = try await fixture.repository.page(id: page.id)
    let afterStale = try XCTUnwrap(fetchedAfterStale)
    XCTAssertGreaterThan(afterStale.dirtyGeneration, staleGeneration)
    let dirtyAfterStale = try await fixture.repository.dirtyPages()
    XCTAssertTrue(dirtyAfterStale.contains { $0.id == page.id })

    let exactPreparedRecord = await coordinator.preparePageRecordForTesting(page.id)
    let exactPrepared = try XCTUnwrap(exactPreparedRecord)
    let exactGeneration = try XCTUnwrap(
      (exactPrepared["dirtyGeneration"] as? NSNumber)?.int64Value
    )
    XCTAssertEqual(exactGeneration, afterStale.dirtyGeneration)
    let exactStillDirty = try await coordinator.acknowledgePreparedRecordForTesting(exactPrepared)
    XCTAssertFalse(exactStillDirty)
    let dirtyAfterExact = try await fixture.repository.dirtyPages()
    XCTAssertFalse(dirtyAfterExact.contains { $0.id == page.id })
  }

  func testExactCarrierAcknowledgementAdvancesPermanentDeletionAndUploadsPurgeMarker() async throws {
    let fixture = try CloudRepositoryFixture()
    let request = bookmarkRequest(url: "https://example.test/permanent")
    let bookmark = try await fixture.repository.materializeBookmark(request)
    try await fixture.repository.moveToTrash(pageID: bookmark.pageID, now: request.capturedAt)
    try await fixture.repository.purge(
      pageID: bookmark.pageID,
      now: request.capturedAt.addingTimeInterval(1)
    )
    let carrierIDs = try await fixture.repository.bookmarkDeletionCarrierPageIDs(
      urlKeyDigest: bookmark.urlKey.digest
    )
    let carrierID = try XCTUnwrap(carrierIDs.first)
    let coordinator = makeCoordinator(repository: fixture.repository)
    let preparedRecord = await coordinator.preparePageRecordForTesting(carrierID)
    let record = try XCTUnwrap(preparedRecord)
    let sentGeneration = try XCTUnwrap((record["dirtyGeneration"] as? NSNumber)?.int64Value)

    let stillDirty = try await coordinator.acknowledgePreparedRecordForTesting(record)

    XCTAssertFalse(stillDirty)
    let fetchedState = try await fixture.repository.bookmarkSuppressionState(for: bookmark.urlKey)
    let state = try XCTUnwrap(fetchedState)
    XCTAssertEqual(state.stage, .stable)
    XCTAssertEqual(state.acknowledgedGeneration, sentGeneration)
    let deletedCandidate = try await fixture.repository.page(id: bookmark.pageID)
    XCTAssertNil(deletedCandidate)
    let markers = try await fixture.repository.dirtyPurgeMarkers()
    XCTAssertTrue(markers.contains { $0.pageID == bookmark.pageID })
  }

  func testCarrierDeletionQueuesSurvivorOrFreshReplacementByCurrentPageID() async throws {
    let fixture = try CloudRepositoryFixture()
    let request = bookmarkRequest(url: "https://example.test/carrier-repair")
    let bookmark = try await fixture.repository.materializeBookmark(request)
    try await fixture.repository.moveToTrash(pageID: bookmark.pageID, now: request.capturedAt)
    let firstCarrierIDs = try await fixture.repository.bookmarkDeletionCarrierPageIDs(
      urlKeyDigest: bookmark.urlKey.digest
    )
    let firstCarrierID = try XCTUnwrap(firstCarrierIDs.first)
    let coordinator = makeCoordinator(repository: fixture.repository)
    let preparedFirstRecord = await coordinator.preparePageRecordForTesting(firstCarrierID)
    let firstRecord = try XCTUnwrap(preparedFirstRecord)
    _ = try await coordinator.acknowledgePreparedRecordForTesting(firstRecord)
    let fetchedTombstone = try await fixture.repository.page(id: bookmark.pageID)
    let tombstone = try XCTUnwrap(fetchedTombstone)
    _ = try await fixture.repository.markCloudSaved(
      pageID: bookmark.pageID,
      sentGeneration: tombstone.dirtyGeneration,
      systemFields: Data([0x31])
    )

    let fetchedFirstPage = try await fixture.repository.page(id: firstCarrierID)
    let firstPage = try XCTUnwrap(fetchedFirstPage)
    let envelope = try XCTUnwrap(
      try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: firstPage.document)
        .canonicalDeletion
    )
    let secondCarrierID = PageID.free()
    let secondCarrier = try PageDocument.makeBookmarkIdentityDeletionCarrier(
      id: secondCarrierID,
      replacingCandidateID: bookmark.pageID,
      deletion: envelope
    )
    _ = try await fixture.repository.mergeCloudPage(
      pageID: secondCarrierID,
      kind: .free,
      remoteDocument: secondCarrier.document,
      systemFields: Data([0x32]),
      now: request.capturedAt.addingTimeInterval(2)
    )

    let survivorRetries = try await coordinator.applyPageRecordDeletionForTesting(firstCarrierID)
    XCTAssertTrue(survivorRetries.isEmpty)
    let survivingPage = try await fixture.repository.page(id: secondCarrierID)
    XCTAssertNotNil(survivingPage)

    let replacementRetries = try await coordinator.applyPageRecordDeletionForTesting(secondCarrierID)
    let replacementIDs = try await fixture.repository.bookmarkDeletionCarrierPageIDs(
      urlKeyDigest: bookmark.urlKey.digest
    )
    let replacementID = try XCTUnwrap(replacementIDs.first)
    XCTAssertNotEqual(replacementID, firstCarrierID)
    XCTAssertNotEqual(replacementID, secondCarrierID)
    XCTAssertEqual(replacementRetries, [replacementID])
  }

  func testLateCandidateAssetAfterSuppressionKeepsPurgeMarkerAndDoesNotResurrectPage() async throws {
    let fixture = try CloudRepositoryFixture()
    let request = bookmarkRequest(url: "https://example.test/late-reupload")
    let bookmark = try await fixture.repository.materializeBookmark(request)
    let coordinator = makeCoordinator(repository: fixture.repository)
    let preparedLateCandidate = await coordinator.preparePageRecordForTesting(bookmark.pageID)
    let lateCandidateRecord = try XCTUnwrap(preparedLateCandidate)

    try await fixture.repository.moveToTrash(pageID: bookmark.pageID, now: request.capturedAt)
    try await fixture.repository.purge(
      pageID: bookmark.pageID,
      now: request.capturedAt.addingTimeInterval(1)
    )
    let carrierIDs = try await fixture.repository.bookmarkDeletionCarrierPageIDs(
      urlKeyDigest: bookmark.urlKey.digest
    )
    let carrierID = try XCTUnwrap(carrierIDs.first)
    let preparedCarrierRecord = await coordinator.preparePageRecordForTesting(carrierID)
    let carrierRecord = try XCTUnwrap(preparedCarrierRecord)
    _ = try await coordinator.acknowledgePreparedRecordForTesting(carrierRecord)
    let candidateAfterPurge = try await fixture.repository.page(id: bookmark.pageID)
    XCTAssertNil(candidateAfterPurge)

    try await coordinator.receiveRecordForTesting(lateCandidateRecord)

    let candidateAfterLateRecord = try await fixture.repository.page(id: bookmark.pageID)
    XCTAssertNil(candidateAfterLateRecord)
    let dirtyMarkers = try await fixture.repository.dirtyPurgeMarkers()
    XCTAssertTrue(dirtyMarkers.contains { $0.pageID == bookmark.pageID })
    let dirtyRecordIDs = try await coordinator.dirtyPageRecordIDsForTesting()
    XCTAssertTrue(dirtyRecordIDs.contains(bookmark.pageID))
    await coordinator.discardPreparedRecordForTesting(lateCandidateRecord)
  }

  func testInboundPurgeOfLastCarrierCreatesDifferentDirtyCarrierRecord() async throws {
    let fixture = try CloudRepositoryFixture()
    let request = bookmarkRequest(url: "https://example.test/purged-carrier")
    let bookmark = try await fixture.repository.materializeBookmark(request)
    try await fixture.repository.moveToTrash(pageID: bookmark.pageID, now: request.capturedAt)
    let initialCarrierIDs = try await fixture.repository.bookmarkDeletionCarrierPageIDs(
      urlKeyDigest: bookmark.urlKey.digest
    )
    let carrierID = try XCTUnwrap(initialCarrierIDs.first)
    let coordinator = makeCoordinator(repository: fixture.repository)
    let preparedCarrierRecord = await coordinator.preparePageRecordForTesting(carrierID)
    let carrierRecord = try XCTUnwrap(preparedCarrierRecord)
    _ = try await coordinator.acknowledgePreparedRecordForTesting(carrierRecord)
    let fetchedTombstone = try await fixture.repository.page(id: bookmark.pageID)
    let tombstone = try XCTUnwrap(fetchedTombstone)
    _ = try await fixture.repository.markCloudSaved(
      pageID: bookmark.pageID,
      sentGeneration: tombstone.dirtyGeneration,
      systemFields: Data([0x41])
    )

    let recordID = CKRecord.ID(
      recordName: carrierID.rawValue,
      zoneID: CKRecordZone.ID(
        zoneName: CloudSyncCoordinator.zoneName,
        ownerName: CKCurrentUserDefaultName
      )
    )
    let purge = CKRecord(recordType: "Page", recordID: recordID)
    purge["purged"] = NSNumber(value: true)
    purge["purgeGeneration"] = NSNumber(value: 9)
    purge["purgedAt"] = request.capturedAt.addingTimeInterval(3) as NSDate
    purge["schemaVersion"] = NSNumber(value: 1)
    try await coordinator.receiveRecordForTesting(purge)

    let carrierIDs = try await fixture.repository.bookmarkDeletionCarrierPageIDs(
      urlKeyDigest: bookmark.urlKey.digest
    )
    let replacementID = try XCTUnwrap(carrierIDs.first)
    XCTAssertNotEqual(replacementID, carrierID)
    let dirtyRecordIDs = try await coordinator.dirtyPageRecordIDsForTesting()
    XCTAssertEqual(dirtyRecordIDs, [replacementID])
  }

  private func bookmarkRequest(url: String, note: String? = nil) -> BookmarkCaptureRequest {
    BookmarkCaptureRequest(
      captureID: UUID(),
      submittedURL: url,
      note: note,
      capturedAt: Date(timeIntervalSince1970: 1_786_000_000),
      dayKey: DayKey(rawValue: "2026-08-05"),
      timeZoneIdentifier: "Europe/London",
      source: "source-secret-never-upload-as-carrier",
      platform: "platform-secret-never-upload-as-carrier",
      vaultID: .personal
    )
  }

  private func makeCoordinator(repository: LibraryRepository) -> CloudSyncCoordinator {
    CloudSyncCoordinator(repository: repository, statusHandler: { _ in })
  }

  private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
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
