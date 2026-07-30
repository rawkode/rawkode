import CloudKit
import CryptoKit
import Foundation
import OSLog
#if os(macOS)
import Security
#endif

enum CloudSyncFailureDisposition: Equatable {
  case retryAutomatically
  case signedOut
  case mergeServerRecord
  case recreateZone
  case recreateRecord
  case requiresAttention
}

enum CloudSyncQueueTrigger: Equatable {
  case launch
  case manualSync
  case localMutation
  case automaticRecovery
  case recordPreparationFailure
}

struct CloudAssetRegistry {
  private(set) var urls: [CKRecord.ID: [URL]] = [:]

  mutating func register(_ url: URL, for recordID: CKRecord.ID) {
    urls[recordID, default: []].append(url)
  }

  mutating func removeURL(
    for recordID: CKRecord.ID,
    preferredURL: URL?
  ) -> URL? {
    guard var candidates = urls[recordID], !candidates.isEmpty else { return nil }
    let url: URL
    if let preferredURL, let index = candidates.firstIndex(of: preferredURL) {
      url = candidates.remove(at: index)
    } else {
      url = candidates.removeFirst()
    }
    if candidates.isEmpty {
      urls.removeValue(forKey: recordID)
    } else {
      urls[recordID] = candidates
    }
    return url
  }

  mutating func removeAll() -> [URL] {
    let result = urls.values.flatMap { $0 }
    urls.removeAll()
    return result
  }
}

public actor CloudSyncCoordinator: CKSyncEngineDelegate {
  public static let containerIdentifier = "iCloud.dev.rawkode.enchiridion"
  public static let zoneName = "EnchiridionVault"
  static let codeSignEntitlementsInfoKey = "EnchiridionCodeSignEntitlements"
  static let codeSigningAllowedInfoKey = "EnchiridionCodeSigningAllowed"

  public nonisolated static var hasRequiredEntitlement: Bool {
    #if os(macOS)
    guard let task = SecTaskCreateFromSelf(nil) else { return false }
    let identifiers = SecTaskCopyValueForEntitlement(
        task,
        "com.apple.developer.icloud-container-identifiers" as CFString,
        nil
      ) as? [String]
    let services = SecTaskCopyValueForEntitlement(
      task,
      "com.apple.developer.icloud-services" as CFString,
      nil
    ) as? [String]
    let pushEnvironment = SecTaskCopyValueForEntitlement(
      task,
      "com.apple.developer.aps-environment" as CFString,
      nil
    ) as? String
    return hasRequiredEntitlements(
      containerIdentifiers: identifiers,
      iCloudServices: services,
      pushEnvironment: pushEnvironment
    )
    #else
    return hasRequiredEntitlement(
      declaredEntitlementsPath:
        Bundle.main.object(forInfoDictionaryKey: codeSignEntitlementsInfoKey) as? String,
      codeSigningAllowed:
        Bundle.main.object(forInfoDictionaryKey: codeSigningAllowedInfoKey) as? String
    )
    #endif
  }

  nonisolated static func hasRequiredEntitlement(in identifiers: [String]?) -> Bool {
    identifiers?.contains(containerIdentifier) == true
  }

  nonisolated static func hasRequiredEntitlements(
    containerIdentifiers: [String]?,
    iCloudServices: [String]?,
    pushEnvironment: String?
  ) -> Bool {
    hasRequiredEntitlement(in: containerIdentifiers)
      && iCloudServices?.contains("CloudKit") == true
      && !(pushEnvironment?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
  }

  nonisolated static func hasDeclaredEntitlements(_ path: String?) -> Bool {
    guard let path else { return false }
    return !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  nonisolated static func hasRequiredEntitlement(
    declaredEntitlementsPath: String?,
    codeSigningAllowed: String?
  ) -> Bool {
    guard hasDeclaredEntitlements(declaredEntitlementsPath), let codeSigningAllowed else {
      return false
    }
    return ["1", "true", "yes"].contains(
      codeSigningAllowed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    )
  }

  nonisolated static func permitsCloudDataTransfer(accountAuthorized: Bool) -> Bool {
    accountAuthorized
  }

  nonisolated static func shouldReplaceEngineOnSignIn(accountAuthorized: Bool) -> Bool {
    !accountAuthorized
  }

  nonisolated static func shouldQueueDirtyRecords(for trigger: CloudSyncQueueTrigger) -> Bool {
    trigger != .recordPreparationFailure
  }

  nonisolated static func revalidationDelay(forAttempt attempt: Int) -> TimeInterval {
    let schedule: [TimeInterval] = [5, 15, 60, 300]
    return schedule[min(max(attempt, 0), schedule.count - 1)]
  }

  nonisolated static func isValidRecordIdentity(
    recordType: String,
    recordName: String
  ) -> Bool {
    switch recordType {
    case RecordType.savedView:
      recordName.hasPrefix(viewRecordPrefix)
    case RecordType.supertag:
      recordName.hasPrefix(supertagRecordPrefix)
    case RecordType.graphRelation:
      recordName.hasPrefix(graphRelationRecordPrefix)
    case RecordType.graphQuery:
      recordName.hasPrefix(graphQueryRecordPrefix)
    case RecordType.page:
      !recordName.hasPrefix(viewRecordPrefix)
        && !recordName.hasPrefix(supertagRecordPrefix)
        && !recordName.hasPrefix(graphRelationRecordPrefix)
        && !recordName.hasPrefix(graphQueryRecordPrefix)
    default:
      false
    }
  }

  private let repository: LibraryRepository
  private let statusHandler: @Sendable (SyncStatus) -> Void
  private let changeHandler: @Sendable () -> Void
  private let container: CKContainer
  private let zoneID: CKRecordZone.ID
  private var engine: CKSyncEngine?
  private var assetRegistry = CloudAssetRegistry()
  private var isAccountAuthorized = false
  private var isStarting = false
  private var manualSyncInProgress = false
  private var manualSyncRequested = false
  private var isFetching = false
  private var isSending = false
  private var operationHasIssue = false
  private var hasUnresolvedRecords = false
  private var revalidationTask: Task<Void, Never>?

  private static let logger = Logger(
    subsystem: "dev.rawkode.enchiridion",
    category: "iCloudSync"
  )

  public init(
    repository: LibraryRepository,
    zoneName: String = CloudSyncCoordinator.zoneName,
    statusHandler: @escaping @Sendable (SyncStatus) -> Void,
    changeHandler: @escaping @Sendable () -> Void = {}
  ) {
    self.repository = repository
    self.statusHandler = statusHandler
    self.changeHandler = changeHandler
    container = CKContainer(identifier: Self.containerIdentifier)
    zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
  }

  public func start() async {
    guard engine == nil, !isStarting else { return }
    isStarting = true
    defer { isStarting = false }

    do {
      let serialization: CKSyncEngine.State.Serialization?
      if let data = try await repository.cloudState() {
        do {
          serialization = try JSONDecoder().decode(CKSyncEngine.State.Serialization.self, from: data)
        } catch {
          serialization = nil
          try await repository.clearCloudState()
          Self.logger.error("Discarded an unreadable persisted sync-engine state")
        }
      } else {
        serialization = nil
      }
      hasUnresolvedRecords = try await !repository.unresolvedCloudRecordNames().isEmpty

      // A dormant engine is created before any account RPC so account transitions remain observable
      // even when the initial status request is offline or unavailable.
      engine = makeEngine(stateSerialization: nil, automaticallySync: false)

      var shouldScheduleRevalidation = false
      do {
        let accountStatus = try await container.accountStatus()
        switch accountStatus {
        case .available:
          try await authorizeCurrentAccount()
        case .noAccount:
          isAccountAuthorized = false
          statusHandler(.localOnly)
        case .restricted:
          isAccountAuthorized = false
          statusHandler(.iCloudUnavailable("This iCloud account is restricted."))
        case .couldNotDetermine, .temporarilyUnavailable:
          isAccountAuthorized = false
          shouldScheduleRevalidation = true
          statusHandler(.offline)
        @unknown default:
          isAccountAuthorized = false
          statusHandler(.iCloudUnavailable("The iCloud account status is unknown."))
        }
      } catch {
        isAccountAuthorized = false
        shouldScheduleRevalidation = !(error is CloudAccountBindingError)
        statusHandler(Self.status(for: error))
        Self.logger.error(
          "Initial iCloud account validation failed; a dormant observer will remain active"
        )
      }
      if isAccountAuthorized {
        engine = makeEngine(stateSerialization: serialization, automaticallySync: true)
      } else if shouldScheduleRevalidation {
        scheduleRevalidation()
      }
      guard let engine else { return }
      Self.logger.info(
        "Sync engine started; accountAuthorized=\(self.isAccountAuthorized, privacy: .public)"
      )

      if isAccountAuthorized {
        try await enqueueRepositoryChanges(on: engine, trigger: .launch)
        await syncNow()
      }
    } catch {
      Self.logger.error(
        "Sync engine start failed; category=\(Self.logCategory(for: error), privacy: .public)"
      )
      statusHandler(Self.status(for: error))
    }
  }

  public func pageDidChange(_ pageID: PageID) async {
    guard isAccountAuthorized else { return }
    queueRecord(recordID(for: pageID), trigger: .localMutation)
  }

  public func pageWasPurged(_ pageID: PageID) async {
    guard isAccountAuthorized else { return }
    queueRecord(recordID(for: pageID), trigger: .localMutation)
  }

  public func viewDidChange(_ viewID: LiveQueryID) async {
    guard isAccountAuthorized else { return }
    queueRecord(recordID(for: viewID), trigger: .localMutation)
  }

  public func supertagDidChange(_ supertagID: SupertagID) async {
    guard isAccountAuthorized else { return }
    queueRecord(recordID(for: supertagID), trigger: .localMutation)
  }

  public func relationDefinitionDidChange(_ relationID: RelationID) async {
    guard isAccountAuthorized else { return }
    queueRecord(recordID(for: relationID), trigger: .localMutation)
  }

  public func graphQueryDidChange(_ queryID: GraphQueryID) async {
    guard isAccountAuthorized else { return }
    queueRecord(recordID(for: queryID), trigger: .localMutation)
  }

  public func enqueueDirtyChanges() async {
    guard isAccountAuthorized, let engine else { return }
    do {
      try await enqueueRepositoryChanges(on: engine, trigger: .localMutation)
    } catch {
      operationHasIssue = true
      statusHandler(.attentionRequired(error.localizedDescription))
      Self.logger.error("Failed to queue repository-derived changes")
    }
  }

  public func syncNow() async {
    if !isAccountAuthorized {
      do {
        try await resumeSyncForCurrentAccount()
      } catch {
        pauseForUnvalidatedAccount(error: error)
        return
      }
    }
    guard let engine else { return }
    if manualSyncInProgress {
      manualSyncRequested = true
      return
    }
    manualSyncInProgress = true

    repeat {
      manualSyncRequested = false
      operationHasIssue = hasUnresolvedRecords
      statusHandler(.syncing)
      Self.logger.info("Manual fetch and send started")
      do {
        await retryUnresolvedRecords(on: engine)
        try await enqueueRepositoryChanges(on: engine, trigger: .manualSync)
        try await engine.fetchChanges()
        try await engine.sendChanges()
        await publishSyncedIfIdle(engine)
      } catch {
        operationHasIssue = true
        Self.logger.error(
          "Manual sync failed; category=\(Self.logCategory(for: error), privacy: .public)"
        )
        statusHandler(Self.status(for: error))
      }
    } while manualSyncRequested && isAccountAuthorized
    manualSyncInProgress = false
    await publishSyncedIfIdle(engine)
  }

  private func authorizeCurrentAccount() async throws {
    let accountID = try await container.userRecordID().recordName
    if let boundAccountID = try await repository.cloudAccountID(), boundAccountID != accountID {
      isAccountAuthorized = false
      throw CloudAccountBindingError.accountChanged
    }
    try await repository.bindCloudAccountID(accountID)
    isAccountAuthorized = true
    revalidationTask?.cancel()
    revalidationTask = nil
  }

  private func makeEngine(
    stateSerialization: CKSyncEngine.State.Serialization?,
    automaticallySync: Bool
  ) -> CKSyncEngine {
    var configuration = CKSyncEngine.Configuration(
      database: container.privateCloudDatabase,
      stateSerialization: stateSerialization,
      delegate: self
    )
    configuration.automaticallySync = automaticallySync
    return CKSyncEngine(configuration)
  }

  private func enqueueRepositoryChanges(
    on engine: CKSyncEngine,
    trigger: CloudSyncQueueTrigger
  ) async throws {
    guard Self.shouldQueueDirtyRecords(for: trigger) else { return }
    engine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: zoneID))])
    let pages = try await repository.dirtyPages()
    let purges = try await repository.dirtyPurgeMarkers()
    let views = try await repository.dirtyViews()
    let supertags = try await repository.dirtySupertags()
    let relations = try await repository.dirtyRelationDefinitions()
    let graphQueries = try await repository.dirtyGraphQueries()
    let pageChanges = pages.map {
      CKSyncEngine.PendingRecordZoneChange.saveRecord(recordID(for: $0.id))
    }
    let purgeChanges = purges.map {
      CKSyncEngine.PendingRecordZoneChange.saveRecord(recordID(for: $0.pageID))
    }
    let viewChanges = views.map {
      CKSyncEngine.PendingRecordZoneChange.saveRecord(recordID(for: $0.id))
    }
    let supertagChanges = supertags.map {
      CKSyncEngine.PendingRecordZoneChange.saveRecord(recordID(for: $0.id))
    }
    let relationChanges = relations.map {
      CKSyncEngine.PendingRecordZoneChange.saveRecord(recordID(for: $0.definition.id))
    }
    let graphQueryChanges = graphQueries.map {
      CKSyncEngine.PendingRecordZoneChange.saveRecord(recordID(for: $0.query.id))
    }
    engine.state.add(
      pendingRecordZoneChanges: pageChanges + purgeChanges + viewChanges + supertagChanges
        + relationChanges + graphQueryChanges
    )
    Self.logger.info(
      "Queued local changes; pages=\(pages.count, privacy: .public), purges=\(purges.count, privacy: .public), views=\(views.count, privacy: .public), supertags=\(supertags.count, privacy: .public), relations=\(relations.count, privacy: .public), graphQueries=\(graphQueries.count, privacy: .public)"
    )
  }

  public func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
    guard syncEngine === engine else {
      Self.logger.info("Ignored a late event from a retired sync engine")
      return
    }
    do {
      switch event {
      case .stateUpdate(let update):
        guard Self.permitsCloudDataTransfer(accountAuthorized: isAccountAuthorized) else {
          Self.logger.info("Ignored sync-engine state while iCloud sync is paused")
          return
        }
        let data = try JSONEncoder().encode(update.stateSerialization)
        try await repository.setCloudState(data)

      case .accountChange(let change):
        cleanupAllAssets()
        switch change.changeType {
        case .signIn:
          let wasAuthorized = isAccountAuthorized
          do {
            if !Self.shouldReplaceEngineOnSignIn(accountAuthorized: isAccountAuthorized) {
              try await enqueueRepositoryChanges(on: syncEngine, trigger: .automaticRecovery)
              statusHandler(.syncing)
              Self.logger.info("The active iCloud account was confirmed; local changes were requeued")
            } else {
              try await resumeSyncForCurrentAccount()
              Self.logger.info("The original iCloud account signed in; local changes were requeued")
            }
          } catch {
            pauseForUnvalidatedAccount(
              error: error,
              replaceWithDormantEngine: wasAuthorized
            )
          }
        case .signOut:
          isAccountAuthorized = false
          engine = makeEngine(stateSerialization: nil, automaticallySync: false)
          statusHandler(.localOnly)
          Self.logger.info("The iCloud account signed out; the local vault remains available")
        case .switchAccounts:
          isAccountAuthorized = false
          do {
            try await resumeSyncForCurrentAccount()
            Self.logger.info("The original iCloud account returned; local changes were requeued")
          } catch {
            pauseForUnvalidatedAccount(error: error, replaceWithDormantEngine: true)
          }
        @unknown default:
          isAccountAuthorized = false
          engine = makeEngine(stateSerialization: nil, automaticallySync: false)
          statusHandler(.attentionRequired("The iCloud account changed in an unsupported way."))
          Self.logger.error("An unsupported iCloud account transition occurred")
        }

      case .fetchedRecordZoneChanges(let changes):
        guard Self.permitsCloudDataTransfer(accountAuthorized: isAccountAuthorized) else {
          Self.logger.error("Discarded fetched records because the current iCloud account is not authorized")
          return
        }
        var appliedCount = 0
        var failedCount = 0
        for modification in changes.modifications where modification.record.recordID.zoneID == zoneID {
          do {
            try await receive(modification.record)
            try await repository.clearUnresolvedCloudRecord(
              recordName: modification.record.recordID.recordName
            )
            hasUnresolvedRecords = try await !repository.unresolvedCloudRecordNames().isEmpty
            appliedCount += 1
          } catch {
            failedCount += 1
            operationHasIssue = true
            try await repository.markCloudRecordUnresolved(
              recordName: modification.record.recordID.recordName
            )
            hasUnresolvedRecords = true
            Self.logger.error(
              "A fetched record could not be applied; category=\(Self.logCategory(for: error), privacy: .public)"
            )
            statusHandler(
              .attentionRequired(
                "An iCloud record could not be read. Other changes were applied; this record needs attention."
              )
            )
          }
        }
        var deletionCount = 0
        for deletion in changes.deletions where deletion.recordID.zoneID == zoneID {
          do {
            if deletion.recordID.recordName.hasPrefix(Self.viewRecordPrefix) {
              let shouldRetry = try await repository.applyCloudViewRecordDeletion(
                id: viewID(for: deletion.recordID)
              )
              if shouldRetry {
                syncEngine.state.add(
                  pendingRecordZoneChanges: [.saveRecord(deletion.recordID)]
                )
              }
            } else if deletion.recordID.recordName.hasPrefix(Self.supertagRecordPrefix) {
              let shouldRetry = try await repository.applyCloudSupertagRecordDeletion(
                id: supertagID(for: deletion.recordID)
              )
              if shouldRetry {
                syncEngine.state.add(
                  pendingRecordZoneChanges: [.saveRecord(deletion.recordID)]
                )
              }
            } else if deletion.recordID.recordName.hasPrefix(Self.graphRelationRecordPrefix) {
              let shouldRetry = try await repository.applyCloudRelationDefinitionRecordDeletion(
                id: relationID(for: deletion.recordID)
              )
              if shouldRetry {
                syncEngine.state.add(
                  pendingRecordZoneChanges: [.saveRecord(deletion.recordID)]
                )
              }
            } else if deletion.recordID.recordName.hasPrefix(Self.graphQueryRecordPrefix) {
              let shouldRetry = try await repository.applyCloudGraphQueryRecordDeletion(
                id: graphQueryID(for: deletion.recordID)
              )
              if shouldRetry {
                syncEngine.state.add(
                  pendingRecordZoneChanges: [.saveRecord(deletion.recordID)]
                )
              }
            } else {
              let pageID = PageID(rawValue: deletion.recordID.recordName)
              let shouldRetry = try await repository.applyCloudPageRecordDeletion(pageID: pageID)
              if shouldRetry {
                syncEngine.state.add(
                  pendingRecordZoneChanges: [.saveRecord(deletion.recordID)]
                )
              }
            }
            try await repository.clearUnresolvedCloudRecord(
              recordName: deletion.recordID.recordName
            )
            hasUnresolvedRecords = try await !repository.unresolvedCloudRecordNames().isEmpty
            deletionCount += 1
          } catch {
            failedCount += 1
            operationHasIssue = true
            try await repository.markCloudRecordUnresolved(
              recordName: deletion.recordID.recordName
            )
            hasUnresolvedRecords = true
            Self.logger.error(
              "A fetched record deletion could not be applied; category=\(Self.logCategory(for: error), privacy: .public)"
            )
            statusHandler(
              .attentionRequired(
                "An iCloud deletion could not be applied. Other changes were kept in sync."
              )
            )
          }
        }
        Self.logger.info(
          "Applied fetched record changes; modifications=\(appliedCount, privacy: .public), deletions=\(deletionCount, privacy: .public), failures=\(failedCount, privacy: .public)"
        )
        if appliedCount > 0 || deletionCount > 0 {
          changeHandler()
        }

      case .fetchedDatabaseChanges(let changes):
        guard isAccountAuthorized else { return }
        for deletion in changes.deletions where deletion.zoneID == zoneID {
          if deletion.reason == .purged {
            isAccountAuthorized = false
            engine = makeEngine(stateSerialization: nil, automaticallySync: false)
            operationHasIssue = true
            statusHandler(
              .attentionRequired(
                "This app’s iCloud data was removed in iCloud storage settings. Local data was preserved and will not be uploaded automatically."
              )
            )
            Self.logger.error("The private sync zone was purged by the user; automatic upload is disabled")
          } else {
            try await repository.markAllCloudDataForZoneRecovery()
            try await repository.clearAllUnresolvedCloudRecords()
            hasUnresolvedRecords = false
            try await enqueueRepositoryChanges(on: syncEngine, trigger: .automaticRecovery)
            statusHandler(.syncing)
            Self.logger.error("The private sync zone disappeared; local data was requeued for recovery")
          }
        }

      case .sentDatabaseChanges(let changes):
        Self.logger.info(
          "Sent database changes; savedZones=\(changes.savedZones.count, privacy: .public), failedZoneSaves=\(changes.failedZoneSaves.count, privacy: .public), failedZoneDeletes=\(changes.failedZoneDeletes.count, privacy: .public)"
        )
        for failure in changes.failedZoneSaves {
          operationHasIssue = true
          statusHandler(Self.status(for: failure.error))
        }

      case .sentRecordZoneChanges(let changes):
        Self.logger.info(
          "Sent record changes; saved=\(changes.savedRecords.count, privacy: .public), failedSaves=\(changes.failedRecordSaves.count, privacy: .public), deleted=\(changes.deletedRecordIDs.count, privacy: .public), failedDeletes=\(changes.failedRecordDeletes.count, privacy: .public)"
        )
        for record in changes.savedRecords {
          do {
            let fields = try Self.systemFields(for: record)
            let stillDirty: Bool
            if record.recordType == RecordType.savedView {
              let generation = (record[Field.dirtyGeneration] as? NSNumber)?.int64Value ?? 0
              stillDirty = try await repository.markViewCloudSaved(
                id: viewID(for: record.recordID),
                sentGeneration: generation,
                systemFields: fields
              )
            } else if record.recordType == RecordType.supertag {
              let generation = (record[Field.dirtyGeneration] as? NSNumber)?.int64Value ?? 0
              stillDirty = try await repository.markSupertagCloudSaved(
                id: supertagID(for: record.recordID),
                sentGeneration: generation,
                systemFields: fields
              )
            } else if record.recordType == RecordType.graphRelation {
              let generation = (record[Field.dirtyGeneration] as? NSNumber)?.int64Value ?? 0
              stillDirty = try await repository.markRelationDefinitionCloudSaved(
                id: relationID(for: record.recordID),
                sentGeneration: generation,
                systemFields: fields
              )
            } else if record.recordType == RecordType.graphQuery {
              let generation = (record[Field.dirtyGeneration] as? NSNumber)?.int64Value ?? 0
              stillDirty = try await repository.markGraphQueryCloudSaved(
                id: graphQueryID(for: record.recordID),
                sentGeneration: generation,
                systemFields: fields
              )
            } else if record.recordType == RecordType.page {
              let pageID = PageID(rawValue: record.recordID.recordName)
              if (record[Field.purged] as? NSNumber)?.boolValue == true {
                let generation = (record[Field.purgeGeneration] as? NSNumber)?.int64Value ?? 0
                stillDirty = try await repository.markPurgeCloudSaved(
                  pageID: pageID,
                  sentGeneration: generation,
                  systemFields: fields
                )
              } else {
                let generation = (record[Field.dirtyGeneration] as? NSNumber)?.int64Value ?? 0
                stillDirty = try await repository.markCloudSaved(
                  pageID: pageID,
                  sentGeneration: generation,
                  systemFields: fields
                )
              }
            } else {
              stillDirty = false
            }
            if Self.shouldImmediatelyRequeueAfterAcknowledgement(
              localPersistenceSucceeded: true,
              stillDirty: stillDirty
            ) {
              syncEngine.state.add(
                pendingRecordZoneChanges: [.saveRecord(record.recordID)]
              )
            }
          } catch {
            operationHasIssue = true
            statusHandler(.attentionRequired(error.localizedDescription))
          }
          cleanupAsset(for: record)
        }
        for failure in changes.failedRecordSaves {
          cleanupAsset(for: failure.record)
          do {
            let disposition = Self.disposition(for: failure.error.code)
            switch disposition {
            case .mergeServerRecord:
              guard let server = failure.error.serverRecord else {
                operationHasIssue = true
                statusHandler(.attentionRequired("CloudKit reported a conflict without the server record needed to resolve it."))
                continue
              }
              try await receive(server)
            case .recreateZone:
              syncEngine.state.add(
                pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: zoneID))]
              )
              statusHandler(.syncing)
            case .recreateRecord:
              try await clearCloudMetadata(for: failure.record)
              statusHandler(.syncing)
            case .retryAutomatically:
              operationHasIssue = true
              statusHandler(Self.status(for: failure.error))
            case .signedOut:
              operationHasIssue = true
              isAccountAuthorized = false
              engine = makeEngine(stateSerialization: nil, automaticallySync: false)
              statusHandler(.localOnly)
            case .requiresAttention:
              operationHasIssue = true
              statusHandler(Self.status(for: failure.error))
            }
            if Self.shouldImmediatelyRequeue(disposition: disposition) {
              syncEngine.state.add(
                pendingRecordZoneChanges: [.saveRecord(failure.record.recordID)]
              )
            }
          } catch {
            operationHasIssue = true
            try? await repository.markCloudRecordUnresolved(
              recordName: failure.record.recordID.recordName
            )
            hasUnresolvedRecords = true
            statusHandler(.attentionRequired(error.localizedDescription))
          }
        }

      case .willFetchChanges:
        guard isAccountAuthorized else { break }
        if !isFetching && !isSending && !manualSyncInProgress {
          operationHasIssue = hasUnresolvedRecords
        }
        isFetching = true
        statusHandler(.syncing)
        Self.logger.info("Scheduled fetch started")
      case .willSendChanges:
        guard isAccountAuthorized else { break }
        if !isFetching && !isSending && !manualSyncInProgress {
          operationHasIssue = hasUnresolvedRecords
        }
        isSending = true
        statusHandler(.syncing)
        Self.logger.info("Scheduled send started")
      case .didFetchChanges:
        isFetching = false
        Self.logger.info("Scheduled fetch finished")
        await publishSyncedIfIdle(syncEngine)
      case .didSendChanges:
        isSending = false
        Self.logger.info("Scheduled send finished")
        await publishSyncedIfIdle(syncEngine)
      case .willFetchRecordZoneChanges, .didFetchRecordZoneChanges:
        break
      @unknown default:
        break
      }
    } catch {
      operationHasIssue = true
      Self.logger.error(
        "Sync event handling failed; category=\(Self.logCategory(for: error), privacy: .public)"
      )
      statusHandler(.attentionRequired(error.localizedDescription))
    }
  }

  private func resumeSyncForCurrentAccount() async throws {
    try await authorizeCurrentAccount()
    hasUnresolvedRecords = try await !repository.unresolvedCloudRecordNames().isEmpty
    let serialization: CKSyncEngine.State.Serialization?
    if let data = try await repository.cloudState() {
      do {
        serialization = try JSONDecoder().decode(
          CKSyncEngine.State.Serialization.self,
          from: data
        )
      } catch {
        try await repository.clearCloudState()
        serialization = nil
      }
    } else {
      serialization = nil
    }
    let activeEngine = makeEngine(
      stateSerialization: serialization,
      automaticallySync: true
    )
    engine = activeEngine
    try await enqueueRepositoryChanges(on: activeEngine, trigger: .automaticRecovery)
    statusHandler(.syncing)
  }

  private func retryUnresolvedRecords(on syncEngine: CKSyncEngine) async {
    do {
      let recordNames = try await repository.unresolvedCloudRecordNames()
      guard !recordNames.isEmpty else {
        hasUnresolvedRecords = false
        return
      }
      var resolvedCount = 0
      for recordName in recordNames {
        let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
        do {
          let record = try await container.privateCloudDatabase.record(for: recordID)
          try await receive(record)
          try await repository.clearUnresolvedCloudRecord(recordName: recordName)
          resolvedCount += 1
        } catch let error as CKError where error.code == .unknownItem {
          try await applyCloudRecordDeletion(recordID, on: syncEngine)
          try await repository.clearUnresolvedCloudRecord(recordName: recordName)
          resolvedCount += 1
        } catch {
          operationHasIssue = true
        }
      }
      hasUnresolvedRecords = try await !repository.unresolvedCloudRecordNames().isEmpty
      operationHasIssue = hasUnresolvedRecords
      Self.logger.info(
        "Retried quarantined records; attempted=\(recordNames.count, privacy: .public), resolved=\(resolvedCount, privacy: .public)"
      )
      if resolvedCount > 0 {
        changeHandler()
      }
      if hasUnresolvedRecords {
        statusHandler(
          .attentionRequired(
            "One or more iCloud records still cannot be read. Local data is safe; use Sync Now after the remote record is repaired."
          )
        )
      }
    } catch {
      hasUnresolvedRecords = true
      operationHasIssue = true
      Self.logger.error("Could not retry quarantined iCloud records")
    }
  }

  private func applyCloudRecordDeletion(
    _ recordID: CKRecord.ID,
    on syncEngine: CKSyncEngine
  ) async throws {
    let shouldRetry: Bool
    if recordID.recordName.hasPrefix(Self.viewRecordPrefix) {
      shouldRetry = try await repository.applyCloudViewRecordDeletion(
        id: viewID(for: recordID)
      )
    } else if recordID.recordName.hasPrefix(Self.supertagRecordPrefix) {
      shouldRetry = try await repository.applyCloudSupertagRecordDeletion(
        id: supertagID(for: recordID)
      )
    } else if recordID.recordName.hasPrefix(Self.graphRelationRecordPrefix) {
      shouldRetry = try await repository.applyCloudRelationDefinitionRecordDeletion(
        id: relationID(for: recordID)
      )
    } else if recordID.recordName.hasPrefix(Self.graphQueryRecordPrefix) {
      shouldRetry = try await repository.applyCloudGraphQueryRecordDeletion(
        id: graphQueryID(for: recordID)
      )
    } else {
      shouldRetry = try await repository.applyCloudPageRecordDeletion(
        pageID: PageID(rawValue: recordID.recordName)
      )
    }
    if shouldRetry {
      syncEngine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
    }
  }

  private func pauseForUnvalidatedAccount(
    error: Error,
    replaceWithDormantEngine: Bool = false
  ) {
    isAccountAuthorized = false
    if replaceWithDormantEngine {
      engine = makeEngine(stateSerialization: nil, automaticallySync: false)
    }
    Self.logger.error(
      "iCloud sync was paused; category=\(Self.logCategory(for: error), privacy: .public)"
    )
    statusHandler(Self.status(for: error))
    if error is CloudAccountBindingError {
      revalidationTask?.cancel()
      revalidationTask = nil
    } else {
      scheduleRevalidation()
    }
  }

  private func scheduleRevalidation(attempt: Int = 0) {
    guard !isAccountAuthorized, revalidationTask == nil else { return }
    let delay = Self.revalidationDelay(forAttempt: attempt)
    revalidationTask = Task { [weak self] in
      do {
        try await Task.sleep(for: .seconds(delay))
      } catch {
        return
      }
      await self?.performScheduledRevalidation(nextAttempt: attempt + 1)
    }
  }

  private func performScheduledRevalidation(nextAttempt: Int) async {
    revalidationTask = nil
    guard !isAccountAuthorized else { return }
    do {
      try await resumeSyncForCurrentAccount()
      Self.logger.info("Automatic iCloud account revalidation succeeded")
    } catch {
      statusHandler(Self.status(for: error))
      if error is CloudAccountBindingError {
        Self.logger.error("Automatic revalidation found a different iCloud account and stopped")
      } else {
        Self.logger.info("Automatic iCloud account revalidation remains pending")
        scheduleRevalidation(attempt: nextAttempt)
      }
    }
  }

  public func nextRecordZoneChangeBatch(
    _ context: CKSyncEngine.SendChangesContext,
    syncEngine: CKSyncEngine
  ) async -> CKSyncEngine.RecordZoneChangeBatch? {
    guard Self.permitsCloudDataTransfer(accountAuthorized: isAccountAuthorized) else {
      return nil
    }
    let changes = syncEngine.state.pendingRecordZoneChanges.filter(context.options.scope.contains)
    guard !changes.isEmpty else { return nil }
    return await CKSyncEngine.RecordZoneChangeBatch(pendingChanges: changes) { [weak self] recordID in
      guard let self else { return nil }
      return await self.recordToSave(recordID)
    }
  }

  public func nextFetchChangesOptions(
    _ context: CKSyncEngine.FetchChangesContext,
    syncEngine: CKSyncEngine
  ) async -> CKSyncEngine.FetchChangesOptions {
    var options = context.options
    options.prioritizedZoneIDs = isAccountAuthorized ? [zoneID] : []
    return options
  }

  private func recordToSave(_ recordID: CKRecord.ID) async -> CKRecord? {
    do {
      if recordID.recordName.hasPrefix(Self.viewRecordPrefix) {
        let viewID = viewID(for: recordID)
        guard let view = try await repository.savedViewCloudRecord(id: viewID) else { return nil }
        let record = try Self.record(
          from: view.cloudRecord, recordType: RecordType.savedView, recordID: recordID
        )
        record[Field.schemaVersion] = NSNumber(value: 2)
        record[Field.definition] = try JSONEncoder.enchiridion.encode(view.definition) as NSData
        record[Field.whiteboardDocument] = try JSONEncoder.enchiridion.encode(view.whiteboardDocument) as NSData
        record[Field.deleted] = NSNumber(value: view.isDeleted)
        record[Field.sortOrder] = NSNumber(value: view.sortOrder)
        record[Field.modifiedAt] = view.modifiedAt as NSDate
        record[Field.dirtyGeneration] = NSNumber(value: view.dirtyGeneration)
        return record
      }
      if recordID.recordName.hasPrefix(Self.supertagRecordPrefix) {
        let supertagID = supertagID(for: recordID)
        guard let supertag = try await repository.supertagCloudRecord(id: supertagID) else {
          return nil
        }
        let record = try Self.record(
          from: supertag.cloudRecord,
          recordType: RecordType.supertag,
          recordID: recordID
        )
        record[Field.schemaVersion] = NSNumber(value: 1)
        record[Field.definition] =
          try JSONEncoder.enchiridion.encode(supertag.definition) as NSData
        record[Field.deleted] = NSNumber(value: supertag.isDeleted)
        record[Field.sortOrder] = NSNumber(value: supertag.sortOrder)
        record[Field.modifiedAt] = supertag.modifiedAt as NSDate
        record[Field.dirtyGeneration] = NSNumber(value: supertag.dirtyGeneration)
        return record
      }
      if recordID.recordName.hasPrefix(Self.graphRelationRecordPrefix) {
        let relationID = relationID(for: recordID)
        guard let relation = try await repository.relationDefinitionCloudRecord(id: relationID)
        else { return nil }
        let record = try Self.record(
          from: relation.cloudRecord,
          recordType: RecordType.graphRelation,
          recordID: recordID
        )
        record[Field.schemaVersion] = NSNumber(value: 1)
        record[Field.definition] =
          try JSONEncoder.enchiridion.encode(relation.definition) as NSData
        record[Field.deleted] = NSNumber(value: relation.definition.isDeleted)
        record[Field.modifiedAt] = relation.modifiedAt as NSDate
        record[Field.dirtyGeneration] = NSNumber(value: relation.dirtyGeneration)
        return record
      }
      if recordID.recordName.hasPrefix(Self.graphQueryRecordPrefix) {
        let queryID = graphQueryID(for: recordID)
        guard let query = try await repository.savedGraphQueryCloudRecord(id: queryID)
        else { return nil }
        let record = try Self.record(
          from: query.cloudRecord,
          recordType: RecordType.graphQuery,
          recordID: recordID
        )
        record[Field.schemaVersion] = NSNumber(value: 1)
        record[Field.definition] = try JSONEncoder.enchiridion.encode(query.query) as NSData
        record[Field.deleted] = NSNumber(value: query.isDeleted)
        record[Field.sortOrder] = NSNumber(value: query.sortOrder)
        record[Field.modifiedAt] = query.modifiedAt as NSDate
        record[Field.dirtyGeneration] = NSNumber(value: query.dirtyGeneration)
        return record
      }
      let pageID = PageID(rawValue: recordID.recordName)
      if let marker = try await repository.purgeMarker(pageID: pageID) {
        let record = try Self.record(from: marker.cloudRecord, recordType: RecordType.page, recordID: recordID)
        record[Field.purged] = NSNumber(value: true)
        record[Field.purgeGeneration] = NSNumber(value: marker.generation)
        record[Field.purgedAt] = marker.purgedAt as NSDate
        record[Field.schemaVersion] = NSNumber(value: 1)
        record[Field.document] = nil
        record[Field.kind] = nil
        return record
      }
      guard let page = try await Self.pageForPendingSave(pageID, repository: repository) else {
        return nil
      }
      let metadata = try await repository.cloudRecordMetadata(pageID: pageID)
      let record = try Self.record(from: metadata, recordType: RecordType.page, recordID: recordID)
      let assetURL = try Self.writeAsset(page.document, pageID: pageID)
      assetRegistry.register(assetURL, for: recordID)
      record[Field.purged] = NSNumber(value: false)
      record[Field.schemaVersion] = NSNumber(value: 1)
      record[Field.kind] = try JSONEncoder.enchiridion.encode(page.kind) as NSData
      record[Field.document] = CKAsset(fileURL: assetURL)
      record[Field.contentHash] = Self.sha256(page.document) as NSString
      record[Field.modifiedAt] = page.modifiedAt as NSDate
      record[Field.dirtyGeneration] = NSNumber(value: page.dirtyGeneration)
      return record
    } catch {
      operationHasIssue = true
      queueRecord(recordID, trigger: .recordPreparationFailure)
      statusHandler(.attentionRequired(error.localizedDescription))
      Self.logger.error(
        "A local record could not be prepared for upload; its dirty state was preserved and automatic retry was suppressed"
      )
      return nil
    }
  }

  static func pageForPendingSave(
    _ pageID: PageID,
    repository: LibraryRepository
  ) async throws -> PageSnapshot? {
    try await repository.cloudEligiblePage(pageID: pageID)
  }

  private func queueRecord(_ recordID: CKRecord.ID, trigger: CloudSyncQueueTrigger) {
    guard Self.shouldQueueDirtyRecords(for: trigger), let engine else { return }
    engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
  }

  private func receive(_ record: CKRecord) async throws {
    guard Self.permitsCloudDataTransfer(accountAuthorized: isAccountAuthorized) else {
      return
    }
    guard record.recordID.zoneID == zoneID else { return }
    guard Self.isValidRecordIdentity(
      recordType: record.recordType,
      recordName: record.recordID.recordName
    ) else {
      throw LibraryRepositoryError.invalidRecord
    }
    if record.recordType == RecordType.savedView {
      guard let definitionData = record[Field.definition] as? Data else {
        throw LibraryRepositoryError.invalidRecord
      }
      let definition = try JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: definitionData)
      let whiteboardDocument = try (record[Field.whiteboardDocument] as? Data).map {
        try JSONDecoder.enchiridion.decode(WhiteboardDocument.self, from: $0)
      }
      let needsUpload = try await repository.mergeCloudView(
        id: viewID(for: record.recordID),
        definition: definition,
        isDeleted: (record[Field.deleted] as? NSNumber)?.boolValue ?? false,
        sortOrder: (record[Field.sortOrder] as? NSNumber)?.intValue ?? 999,
        modifiedAt: record[Field.modifiedAt] as? Date ?? record.modificationDate ?? Date(),
        dirtyGeneration: (record[Field.dirtyGeneration] as? NSNumber)?.int64Value ?? 0,
        systemFields: try Self.systemFields(for: record),
        whiteboardDocument: whiteboardDocument
      )
      if needsUpload {
        engine?.state.add(pendingRecordZoneChanges: [.saveRecord(record.recordID)])
      }
      return
    }
    if record.recordType == RecordType.supertag {
      guard let definitionData = record[Field.definition] as? Data else {
        throw LibraryRepositoryError.invalidRecord
      }
      let definition = try JSONDecoder.enchiridion.decode(
        SupertagDefinition.self,
        from: definitionData
      )
      let needsUpload = try await repository.mergeCloudSupertag(
        id: supertagID(for: record.recordID),
        definition: definition,
        isDeleted: (record[Field.deleted] as? NSNumber)?.boolValue ?? false,
        sortOrder: (record[Field.sortOrder] as? NSNumber)?.intValue ?? 999,
        modifiedAt: record[Field.modifiedAt] as? Date ?? record.modificationDate ?? Date(),
        dirtyGeneration: (record[Field.dirtyGeneration] as? NSNumber)?.int64Value ?? 0,
        systemFields: try Self.systemFields(for: record)
      )
      if needsUpload {
        engine?.state.add(pendingRecordZoneChanges: [.saveRecord(record.recordID)])
      }
      return
    }
    if record.recordType == RecordType.graphRelation {
      guard let definitionData = record[Field.definition] as? Data else {
        throw LibraryRepositoryError.invalidRecord
      }
      let definition = try JSONDecoder.enchiridion.decode(
        RelationDefinition.self,
        from: definitionData
      )
      let needsUpload = try await repository.mergeCloudRelationDefinition(
        id: relationID(for: record.recordID),
        definition: definition,
        isDeleted: (record[Field.deleted] as? NSNumber)?.boolValue ?? false,
        modifiedAt: record[Field.modifiedAt] as? Date ?? record.modificationDate ?? Date(),
        dirtyGeneration: (record[Field.dirtyGeneration] as? NSNumber)?.int64Value ?? 0,
        systemFields: try Self.systemFields(for: record)
      )
      if needsUpload {
        engine?.state.add(pendingRecordZoneChanges: [.saveRecord(record.recordID)])
      }
      return
    }
    if record.recordType == RecordType.graphQuery {
      guard let definitionData = record[Field.definition] as? Data else {
        throw LibraryRepositoryError.invalidRecord
      }
      let query = try JSONDecoder.enchiridion.decode(SavedGraphQuery.self, from: definitionData)
      let needsUpload = try await repository.mergeCloudGraphQuery(
        id: graphQueryID(for: record.recordID),
        query: query,
        isDeleted: (record[Field.deleted] as? NSNumber)?.boolValue ?? false,
        sortOrder: (record[Field.sortOrder] as? NSNumber)?.intValue ?? 999,
        modifiedAt: record[Field.modifiedAt] as? Date ?? record.modificationDate ?? Date(),
        dirtyGeneration: (record[Field.dirtyGeneration] as? NSNumber)?.int64Value ?? 0,
        systemFields: try Self.systemFields(for: record)
      )
      if needsUpload {
        engine?.state.add(pendingRecordZoneChanges: [.saveRecord(record.recordID)])
      }
      return
    }
    guard record.recordType == RecordType.page else { return }
    let pageID = PageID(rawValue: record.recordID.recordName)
    let systemFields = try Self.systemFields(for: record)
    if (record[Field.purged] as? NSNumber)?.boolValue == true {
      let generation = (record[Field.purgeGeneration] as? NSNumber)?.int64Value ?? 1
      let date = record[Field.purgedAt] as? Date ?? record.modificationDate ?? Date()
      let needsUpload = try await repository.applyCloudPurge(
        pageID: pageID,
        generation: generation,
        purgedAt: date,
        systemFields: systemFields
      )
      if needsUpload {
        engine?.state.add(pendingRecordZoneChanges: [.saveRecord(record.recordID)])
      }
      return
    }
    guard let asset = record[Field.document] as? CKAsset,
      let url = asset.fileURL,
      let kindData = record[Field.kind] as? Data
    else { throw LibraryRepositoryError.invalidRecord }
    let remote = try Data(contentsOf: url)
    if let expected = record[Field.contentHash] as? String,
      expected != Self.sha256(remote)
    {
      throw CocoaError(.fileReadCorruptFile)
    }
    let kind = try JSONDecoder.enchiridion.decode(PageKind.self, from: kindData)
    let merged = try await repository.mergeCloudPage(
      pageID: pageID,
      kind: kind,
      remoteDocument: remote,
      systemFields: systemFields
    )
    if merged.needsUpload {
      engine?.state.add(pendingRecordZoneChanges: [.saveRecord(record.recordID)])
    }
  }

  private func recordID(for pageID: PageID) -> CKRecord.ID {
    CKRecord.ID(recordName: pageID.rawValue, zoneID: zoneID)
  }

  private func recordID(for viewID: LiveQueryID) -> CKRecord.ID {
    CKRecord.ID(recordName: Self.viewRecordPrefix + viewID.rawValue, zoneID: zoneID)
  }

  private func recordID(for supertagID: SupertagID) -> CKRecord.ID {
    CKRecord.ID(recordName: Self.supertagRecordPrefix + supertagID.rawValue, zoneID: zoneID)
  }

  private func recordID(for relationID: RelationID) -> CKRecord.ID {
    CKRecord.ID(
      recordName: Self.graphRelationRecordPrefix + relationID.rawValue,
      zoneID: zoneID
    )
  }

  private func recordID(for queryID: GraphQueryID) -> CKRecord.ID {
    CKRecord.ID(recordName: Self.graphQueryRecordPrefix + queryID.rawValue, zoneID: zoneID)
  }

  private func viewID(for recordID: CKRecord.ID) -> LiveQueryID {
    .init(rawValue: String(recordID.recordName.dropFirst(Self.viewRecordPrefix.count)))
  }

  private func supertagID(for recordID: CKRecord.ID) -> SupertagID {
    .init(rawValue: String(recordID.recordName.dropFirst(Self.supertagRecordPrefix.count)))
  }

  private func relationID(for recordID: CKRecord.ID) -> RelationID {
    .init(rawValue: String(recordID.recordName.dropFirst(Self.graphRelationRecordPrefix.count)))
  }

  private func graphQueryID(for recordID: CKRecord.ID) -> GraphQueryID {
    .init(rawValue: String(recordID.recordName.dropFirst(Self.graphQueryRecordPrefix.count)))
  }

  private static let viewRecordPrefix = "saved-view:"
  private static let supertagRecordPrefix = "supertag:"
  private static let graphRelationRecordPrefix = "graph-relation:"
  private static let graphQueryRecordPrefix = "graph-query:"

  private func cleanupAsset(for record: CKRecord) {
    let recordID = record.recordID
    let assetURL = (record[Field.document] as? CKAsset)?.fileURL
    guard let url = assetRegistry.removeURL(for: recordID, preferredURL: assetURL) else {
      return
    }
    try? FileManager.default.removeItem(at: url)
  }

  private func cleanupAllAssets() {
    let urls = assetRegistry.removeAll()
    for url in urls {
      try? FileManager.default.removeItem(at: url)
    }
  }

  private func clearCloudMetadata(for record: CKRecord) async throws {
    if record.recordType == RecordType.savedView {
      try await repository.clearViewCloudRecordMetadata(id: viewID(for: record.recordID))
      return
    }
    if record.recordType == RecordType.supertag {
      try await repository.clearSupertagCloudRecordMetadata(id: supertagID(for: record.recordID))
      return
    }
    if record.recordType == RecordType.graphRelation {
      try await repository.clearRelationDefinitionCloudRecordMetadata(
        id: relationID(for: record.recordID)
      )
      return
    }
    if record.recordType == RecordType.graphQuery {
      try await repository.clearGraphQueryCloudRecordMetadata(id: graphQueryID(for: record.recordID))
      return
    }
    guard record.recordType == RecordType.page else { return }
    let pageID = PageID(rawValue: record.recordID.recordName)
    if (record[Field.purged] as? NSNumber)?.boolValue == true {
      try await repository.clearPurgeCloudRecordMetadata(pageID: pageID)
    } else {
      try await repository.clearPageCloudRecordMetadata(pageID: pageID)
    }
  }

  private func publishSyncedIfIdle(_ syncEngine: CKSyncEngine) async {
    guard isAccountAuthorized,
      !manualSyncInProgress,
      !isFetching,
      !isSending
    else { return }
    if hasUnresolvedRecords {
      statusHandler(
        .attentionRequired(
          "One or more iCloud records could not be read. Local data is safe, but remote data needs attention before sync can be considered complete."
        )
      )
      return
    }
    guard !operationHasIssue,
      syncEngine.state.pendingDatabaseChanges.isEmpty,
      syncEngine.state.pendingRecordZoneChanges.isEmpty
    else { return }
    do {
      let dirtyPages = try await repository.dirtyPages()
      let dirtyPurges = try await repository.dirtyPurgeMarkers()
      let dirtyViews = try await repository.dirtyViews()
      let dirtySupertags = try await repository.dirtySupertags()
      let dirtyRelations = try await repository.dirtyRelationDefinitions()
      let dirtyGraphQueries = try await repository.dirtyGraphQueries()
      let hasRepositoryChanges =
        !dirtyPages.isEmpty
        || !dirtyPurges.isEmpty
        || !dirtyViews.isEmpty
        || !dirtySupertags.isEmpty
        || !dirtyRelations.isEmpty
        || !dirtyGraphQueries.isEmpty
      if hasRepositoryChanges {
        statusHandler(
          .attentionRequired(
            "One or more local changes could not be uploaded. They remain safe on this device; edit them again or choose Sync Now to retry."
          )
        )
        return
      }
    } catch {
      operationHasIssue = true
      statusHandler(.attentionRequired(error.localizedDescription))
      return
    }
    statusHandler(.synced(Date()))
  }

  private static func record(
    from systemFields: Data?,
    recordType: CKRecord.RecordType,
    recordID: CKRecord.ID
  ) throws -> CKRecord {
    guard let systemFields, !systemFields.isEmpty else {
      return CKRecord(recordType: recordType, recordID: recordID)
    }
    let unarchiver = try NSKeyedUnarchiver(forReadingFrom: systemFields)
    unarchiver.requiresSecureCoding = true
    defer { unarchiver.finishDecoding() }
    return CKRecord(coder: unarchiver) ?? CKRecord(recordType: recordType, recordID: recordID)
  }

  private static func systemFields(for record: CKRecord) throws -> Data {
    let archiver = NSKeyedArchiver(requiringSecureCoding: true)
    record.encodeSystemFields(with: archiver)
    archiver.finishEncoding()
    return archiver.encodedData
  }

  private static func writeAsset(_ data: Data, pageID: PageID) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("EnchiridionCloudAssets", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("\(pageID.rawValue)-\(UUID().uuidString).automerge")
    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    return url
  }

  private static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  nonisolated static func disposition(for code: CKError.Code) -> CloudSyncFailureDisposition {
    switch code {
    case .networkFailure, .networkUnavailable, .serviceUnavailable, .requestRateLimited,
      .zoneBusy, .accountTemporarilyUnavailable:
      .retryAutomatically
    case .notAuthenticated:
      .signedOut
    case .serverRecordChanged:
      .mergeServerRecord
    case .zoneNotFound:
      .recreateZone
    case .unknownItem:
      .recreateRecord
    default:
      .requiresAttention
    }
  }

  nonisolated static func shouldImmediatelyRequeue(
    disposition: CloudSyncFailureDisposition
  ) -> Bool {
    switch disposition {
    case .mergeServerRecord, .recreateZone, .recreateRecord:
      true
    case .retryAutomatically, .signedOut, .requiresAttention:
      false
    }
  }

  nonisolated static func shouldImmediatelyRequeueAfterAcknowledgement(
    localPersistenceSucceeded: Bool,
    stillDirty: Bool
  ) -> Bool {
    localPersistenceSucceeded && stillDirty
  }

  nonisolated static func status(for error: Error) -> SyncStatus {
    if error is CloudAccountBindingError {
      return .attentionRequired(
        "This device is using a different iCloud account. Local data remains available, but iCloud sync is paused until the original account returns."
      )
    }
    guard let cloudError = error as? CKError else {
      return .attentionRequired(error.localizedDescription)
    }
    switch disposition(for: cloudError.code) {
    case .retryAutomatically:
      return .offline
    case .signedOut:
      return .localOnly
    case .mergeServerRecord, .recreateZone, .recreateRecord, .requiresAttention:
      return .attentionRequired(cloudError.localizedDescription)
    }
  }

  private nonisolated static func logCategory(for error: Error) -> String {
    guard let cloudError = error as? CKError else {
      return error is CloudAccountBindingError ? "account-binding" : "local"
    }
    return "cloudkit-\(cloudError.code.rawValue)"
  }
}

private enum CloudAccountBindingError: Error {
  case accountChanged
}

private enum Field {
  static let schemaVersion = "schemaVersion"
  static let kind = "kind"
  static let document = "document"
  static let contentHash = "contentHash"
  static let modifiedAt = "modifiedAt"
  static let purged = "purged"
  static let purgeGeneration = "purgeGeneration"
  static let purgedAt = "purgedAt"
  static let definition = "definition"
  static let whiteboardDocument = "whiteboardDocument"
  static let deleted = "deleted"
  static let sortOrder = "sortOrder"
  static let dirtyGeneration = "dirtyGeneration"
}

private enum RecordType {
  static let page = "Page"
  static let savedView = "SavedView"
  static let supertag = "Supertag"
  static let graphRelation = "GraphRelation"
  static let graphQuery = "GraphQuery"
}
