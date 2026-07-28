import CloudKit
import CryptoKit
import Foundation
#if os(macOS)
import Security
#endif

public actor CloudSyncCoordinator: CKSyncEngineDelegate {
  public static let containerIdentifier = "iCloud.dev.rawkode.enchiridion"
  public static let zoneName = "EnchiridionVault"
  static let codeSignEntitlementsInfoKey = "EnchiridionCodeSignEntitlements"

  public nonisolated static var hasRequiredEntitlement: Bool {
    #if os(macOS)
    guard let task = SecTaskCreateFromSelf(nil),
      let identifiers = SecTaskCopyValueForEntitlement(
        task,
        "com.apple.developer.icloud-container-identifiers" as CFString,
        nil
      ) as? [String]
    else { return false }
    return hasRequiredEntitlement(in: identifiers)
    #else
    return hasDeclaredEntitlements(
      Bundle.main.object(forInfoDictionaryKey: codeSignEntitlementsInfoKey) as? String
    )
    #endif
  }

  nonisolated static func hasRequiredEntitlement(in identifiers: [String]?) -> Bool {
    identifiers?.contains(containerIdentifier) == true
  }

  nonisolated static func hasDeclaredEntitlements(_ path: String?) -> Bool {
    guard let path else { return false }
    return !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private let repository: LibraryRepository
  private let statusHandler: @Sendable (SyncStatus) -> Void
  private let changeHandler: @Sendable () -> Void
  private let container: CKContainer
  private let zoneID: CKRecordZone.ID
  private var engine: CKSyncEngine?
  private var assetURLs: [CKRecord.ID: URL] = [:]

  public init(
    repository: LibraryRepository,
    statusHandler: @escaping @Sendable (SyncStatus) -> Void,
    changeHandler: @escaping @Sendable () -> Void = {}
  ) {
    self.repository = repository
    self.statusHandler = statusHandler
    self.changeHandler = changeHandler
    container = CKContainer(identifier: Self.containerIdentifier)
    zoneID = CKRecordZone.ID(zoneName: Self.zoneName, ownerName: CKCurrentUserDefaultName)
  }

  public func start() async {
    do {
      switch try await container.accountStatus() {
      case .available:
        break
      case .noAccount:
        statusHandler(.localOnly)
        return
      case .restricted:
        statusHandler(.iCloudUnavailable("This iCloud account is restricted."))
        return
      case .couldNotDetermine, .temporarilyUnavailable:
        statusHandler(.offline)
        return
      @unknown default:
        statusHandler(.iCloudUnavailable("The iCloud account status is unknown."))
        return
      }

      let accountID = try await container.userRecordID().recordName
      if let boundAccountID = try await repository.cloudAccountID(), boundAccountID != accountID {
        statusHandler(.attentionRequired("iCloud account changed. This local vault is locked to its original account and will not upload."))
        return
      }
      try await repository.bindCloudAccountID(accountID)

      let serialization: CKSyncEngine.State.Serialization?
      if let data = try await repository.cloudState() {
        serialization = try? JSONDecoder().decode(CKSyncEngine.State.Serialization.self, from: data)
      } else {
        serialization = nil
      }
      var configuration = CKSyncEngine.Configuration(
        database: container.privateCloudDatabase,
        stateSerialization: serialization,
        delegate: self
      )
      configuration.automaticallySync = true
      let engine = CKSyncEngine(configuration)
      self.engine = engine

      engine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: zoneID))])
      let pageChanges = try await repository.dirtyPages().map {
        CKSyncEngine.PendingRecordZoneChange.saveRecord(recordID(for: $0.id))
      }
      let purgeChanges = try await repository.dirtyPurgeMarkers().map {
        CKSyncEngine.PendingRecordZoneChange.saveRecord(recordID(for: $0.pageID))
      }
      let viewChanges = try await repository.dirtyViews().map {
        CKSyncEngine.PendingRecordZoneChange.saveRecord(recordID(for: $0.id))
      }
      engine.state.add(pendingRecordZoneChanges: pageChanges + purgeChanges + viewChanges)
      await syncNow()
    } catch {
      statusHandler(Self.status(for: error))
    }
  }

  public func pageDidChange(_ pageID: PageID) async {
    guard let engine else { return }
    engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID(for: pageID))])
  }

  public func pageWasPurged(_ pageID: PageID) async {
    guard let engine else { return }
    engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID(for: pageID))])
  }

  public func viewDidChange(_ viewID: LiveQueryID) async {
    guard let engine else { return }
    engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID(for: viewID))])
  }

  public func syncNow() async {
    guard let engine else { return }
    statusHandler(.syncing)
    do {
      try await engine.fetchChanges()
      try await engine.sendChanges()
      statusHandler(.synced(Date()))
    } catch {
      statusHandler(Self.status(for: error))
    }
  }

  public func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
    do {
      switch event {
      case .stateUpdate(let update):
        let data = try JSONEncoder().encode(update.stateSerialization)
        try await repository.setCloudState(data)

      case .accountChange(let change):
        switch change.changeType {
        case .signIn:
          statusHandler(.syncing)
        case .signOut:
          engine = nil
          statusHandler(.localOnly)
        case .switchAccounts:
          engine = nil
          statusHandler(.attentionRequired("iCloud account changed. The previous vault is locked and will never be uploaded to the new account."))
        @unknown default:
          statusHandler(.attentionRequired("The iCloud account changed in an unsupported way."))
        }

      case .fetchedRecordZoneChanges(let changes):
        for modification in changes.modifications where modification.record.recordID.zoneID == zoneID {
          try await receive(modification.record)
        }
        for deletion in changes.deletions where deletion.recordID.zoneID == zoneID {
          if deletion.recordID.recordName.hasPrefix(Self.viewRecordPrefix) {
            continue
          }
          let pageID = PageID(rawValue: deletion.recordID.recordName)
          try await repository.applyCloudPurge(
            pageID: pageID,
            generation: Int64.max,
            purgedAt: Date(),
            systemFields: Data()
          )
        }
        changeHandler()

      case .sentDatabaseChanges(let changes):
        if !changes.failedZoneSaves.isEmpty {
          statusHandler(.attentionRequired("The private CloudKit zone could not be created."))
        }

      case .sentRecordZoneChanges(let changes):
        for record in changes.savedRecords {
          let fields = try Self.systemFields(for: record)
          if record.recordType == RecordType.savedView {
            try await repository.markViewCloudSaved(id: viewID(for: record.recordID), systemFields: fields)
          } else if record.recordType == RecordType.page {
            let pageID = PageID(rawValue: record.recordID.recordName)
            if (record[Field.purged] as? NSNumber)?.boolValue == true {
              try await repository.markPurgeCloudSaved(pageID: pageID, systemFields: fields)
            } else {
              try await repository.markCloudSaved(pageID: pageID, systemFields: fields)
            }
          }
          cleanupAsset(for: record.recordID)
        }
        for failure in changes.failedRecordSaves {
          cleanupAsset(for: failure.record.recordID)
          if failure.error.code == .serverRecordChanged, let server = failure.error.serverRecord {
            try await receive(server)
            syncEngine.state.add(
              pendingRecordZoneChanges: [.saveRecord(failure.record.recordID)]
            )
          } else {
            statusHandler(Self.status(for: failure.error))
          }
        }

      case .willFetchChanges, .willSendChanges:
        statusHandler(.syncing)
      case .didFetchChanges, .didSendChanges:
        statusHandler(.synced(Date()))
      case .fetchedDatabaseChanges, .willFetchRecordZoneChanges, .didFetchRecordZoneChanges:
        break
      @unknown default:
        break
      }
    } catch {
      statusHandler(.attentionRequired(error.localizedDescription))
    }
  }

  public func nextRecordZoneChangeBatch(
    _ context: CKSyncEngine.SendChangesContext,
    syncEngine: CKSyncEngine
  ) async -> CKSyncEngine.RecordZoneChangeBatch? {
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
    options.prioritizedZoneIDs = [zoneID]
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
        record[Field.schemaVersion] = NSNumber(value: 1)
        record[Field.definition] = try JSONEncoder.enchiridion.encode(view.definition) as NSData
        record[Field.deleted] = NSNumber(value: view.isDeleted)
        record[Field.sortOrder] = NSNumber(value: view.sortOrder)
        record[Field.modifiedAt] = view.modifiedAt as NSDate
        record[Field.dirtyGeneration] = NSNumber(value: view.dirtyGeneration)
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
      guard let page = try await repository.page(id: pageID) else { return nil }
      let metadata = try await repository.cloudRecordMetadata(pageID: pageID)
      let record = try Self.record(from: metadata, recordType: RecordType.page, recordID: recordID)
      let assetURL = try Self.writeAsset(page.document, pageID: pageID)
      assetURLs[recordID] = assetURL
      record[Field.purged] = NSNumber(value: false)
      record[Field.schemaVersion] = NSNumber(value: 1)
      record[Field.kind] = try JSONEncoder.enchiridion.encode(page.kind) as NSData
      record[Field.document] = CKAsset(fileURL: assetURL)
      record[Field.contentHash] = Self.sha256(page.document) as NSString
      record[Field.modifiedAt] = page.modifiedAt as NSDate
      return record
    } catch {
      statusHandler(.attentionRequired(error.localizedDescription))
      return nil
    }
  }

  private func receive(_ record: CKRecord) async throws {
    guard record.recordID.zoneID == zoneID else { return }
    if record.recordType == RecordType.savedView {
      guard let definitionData = record[Field.definition] as? Data else { return }
      let definition = try JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: definitionData)
      let needsUpload = try await repository.mergeCloudView(
        id: viewID(for: record.recordID),
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
    guard record.recordType == RecordType.page else { return }
    let pageID = PageID(rawValue: record.recordID.recordName)
    let systemFields = try Self.systemFields(for: record)
    if (record[Field.purged] as? NSNumber)?.boolValue == true {
      let generation = (record[Field.purgeGeneration] as? NSNumber)?.int64Value ?? 1
      let date = record[Field.purgedAt] as? Date ?? record.modificationDate ?? Date()
      try await repository.applyCloudPurge(
        pageID: pageID,
        generation: generation,
        purgedAt: date,
        systemFields: systemFields
      )
      return
    }
    guard let asset = record[Field.document] as? CKAsset,
      let url = asset.fileURL,
      let kindData = record[Field.kind] as? Data
    else { return }
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
    if merged.document != remote {
      engine?.state.add(pendingRecordZoneChanges: [.saveRecord(record.recordID)])
    }
  }

  private func recordID(for pageID: PageID) -> CKRecord.ID {
    CKRecord.ID(recordName: pageID.rawValue, zoneID: zoneID)
  }

  private func recordID(for viewID: LiveQueryID) -> CKRecord.ID {
    CKRecord.ID(recordName: Self.viewRecordPrefix + viewID.rawValue, zoneID: zoneID)
  }

  private func viewID(for recordID: CKRecord.ID) -> LiveQueryID {
    .init(rawValue: String(recordID.recordName.dropFirst(Self.viewRecordPrefix.count)))
  }

  private static let viewRecordPrefix = "saved-view:"

  private func cleanupAsset(for recordID: CKRecord.ID) {
    guard let url = assetURLs.removeValue(forKey: recordID) else { return }
    try? FileManager.default.removeItem(at: url)
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

  private static func status(for error: Error) -> SyncStatus {
    guard let cloudError = error as? CKError else {
      return .attentionRequired(error.localizedDescription)
    }
    switch cloudError.code {
    case .networkFailure, .networkUnavailable, .serviceUnavailable, .requestRateLimited, .zoneBusy:
      return .offline
    case .notAuthenticated:
      return .localOnly
    default:
      return .attentionRequired(cloudError.localizedDescription)
    }
  }
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
  static let deleted = "deleted"
  static let sortOrder = "sortOrder"
  static let dirtyGeneration = "dirtyGeneration"
}

private enum RecordType {
  static let page = "Page"
  static let savedView = "SavedView"
}
