import Foundation
import Observation

public enum MeetingTranscriptionRoute: String, CaseIterable, Codable, Equatable, Sendable, Identifiable {
  case onDevice
  case cloud

  public var id: String { rawValue }
  public var title: String { self == .onDevice ? "On Device" : "Cloud" }
}

/// Describes whether the selected cloud route still needs configuration, without
/// exposing or reading a credential. The capture runtime performs authorization.
public enum MeetingCloudTranscriptionReadiness: Equatable, Sendable {
  case notRequired
  case requiresProviderConfiguration
}

public struct MeetingTranscriptionRouteSnapshot: Codable, Equatable, Sendable {
  public let route: MeetingTranscriptionRoute
  public let cloudReadiness: MeetingCloudTranscriptionReadiness
  public let cloudModelID: String?
  public let credentialBinding: OpenAICredentialBinding?

  public init(route: MeetingTranscriptionRoute, cloudReadiness: MeetingCloudTranscriptionReadiness, cloudModelID: String? = nil, credentialBinding: OpenAICredentialBinding? = nil) {
    self.route = route
    self.cloudReadiness = cloudReadiness
    self.cloudModelID = cloudModelID; self.credentialBinding = credentialBinding
  }
}

extension MeetingCloudTranscriptionReadiness: Codable {}

public struct MeetingAnalysisRouteSnapshot: Codable, Equatable, Sendable {
  public let route: MeetingTranscriptionRoute
  public let cloudModelID: String?
  public let credentialBinding: OpenAICredentialBinding?

  public init(route: MeetingTranscriptionRoute, cloudModelID: String? = nil, credentialBinding: OpenAICredentialBinding? = nil) { self.route = route; self.cloudModelID = cloudModelID; self.credentialBinding = credentialBinding }
}

public struct MeetingTranscriptionSettingsPayload: Codable, Equatable, Sendable {
  public static let currentVersion = 1
  public var version: Int
  public var promptsEnabled: Bool
  public var route: MeetingTranscriptionRoute

  public init(version: Int = currentVersion, promptsEnabled: Bool = true, route: MeetingTranscriptionRoute = .onDevice) {
    self.version = version
    self.promptsEnabled = promptsEnabled
    self.route = route
  }
}

@MainActor
public final class MeetingTranscriptionSettingsDefaultsStore {
  public static let defaultKey = "meeting.transcription.settings.v1"
  private let defaults: UserDefaults
  private let key: String

  public init(defaults: UserDefaults = .standard, key: String = defaultKey) {
    self.defaults = defaults
    self.key = key
  }

  public func load() -> MeetingTranscriptionSettingsPayload {
    guard let data = defaults.data(forKey: key),
      let value = try? JSONDecoder().decode(MeetingTranscriptionSettingsPayload.self, from: data),
      value.version == MeetingTranscriptionSettingsPayload.currentVersion
    else { return .init() }
    return value
  }

  public func save(_ value: MeetingTranscriptionSettingsPayload) {
    guard let data = try? JSONEncoder().encode(value) else { return }
    defaults.set(data, forKey: key)
  }
}

@MainActor @Observable
public final class MeetingTranscriptionSettings {
  private let store: MeetingTranscriptionSettingsDefaultsStore
  public var promptsEnabled: Bool { didSet { persist() } }
  public var route: MeetingTranscriptionRoute { didSet { persist() } }

  public init(store: MeetingTranscriptionSettingsDefaultsStore = .init()) {
    self.store = store
    let payload = store.load()
    promptsEnabled = payload.promptsEnabled
    route = payload.route
  }

  public func routeSnapshot() -> MeetingTranscriptionRouteSnapshot {
    .init(
      route: route,
      cloudReadiness: route == .cloud ? .requiresProviderConfiguration : .notRequired
    )
  }

  public func analysisRouteSnapshot() -> MeetingAnalysisRouteSnapshot { .init(route: route) }

  private func persist() { store.save(.init(promptsEnabled: promptsEnabled, route: route)) }
}

public struct MeetingAutomationCapabilities: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let mayCreateLinkedEntities: Bool
  public let mayWriteTranscriptResource: Bool
  /// Deliberately separate from the generic assistant/tool capability. A meeting
  /// completion can only write its own provenance block when this was granted at
  /// Start.
  public let mayWriteEventNote: Bool
  public let maximumEntitiesPerTag: Int
  public let maximumTotalEntities: Int

  public init(
    schemaVersion: Int = 1,
    mayCreateLinkedEntities: Bool = true,
    mayWriteTranscriptResource: Bool = true,
    mayWriteEventNote: Bool = true,
    maximumEntitiesPerTag: Int = 25,
    maximumTotalEntities: Int = 100
  ) {
    self.schemaVersion = schemaVersion
    self.mayCreateLinkedEntities = mayCreateLinkedEntities
    self.mayWriteTranscriptResource = mayWriteTranscriptResource
    self.mayWriteEventNote = mayWriteEventNote
    self.maximumEntitiesPerTag = maximumEntitiesPerTag
    self.maximumTotalEntities = maximumTotalEntities
  }

  private enum CodingKeys: String, CodingKey {
    case schemaVersion, mayCreateLinkedEntities, mayWriteTranscriptResource
    case mayWriteEventNote, maximumEntitiesPerTag, maximumTotalEntities
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try values.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
    mayCreateLinkedEntities = try values.decodeIfPresent(Bool.self, forKey: .mayCreateLinkedEntities) ?? true
    mayWriteTranscriptResource = try values.decodeIfPresent(Bool.self, forKey: .mayWriteTranscriptResource) ?? true
    mayWriteEventNote = try values.decodeIfPresent(Bool.self, forKey: .mayWriteEventNote) ?? true
    maximumEntitiesPerTag = try values.decodeIfPresent(Int.self, forKey: .maximumEntitiesPerTag) ?? 25
    maximumTotalEntities = try values.decodeIfPresent(Int.self, forKey: .maximumTotalEntities) ?? 100
  }
}

/// A frozen, canonical schema projection. Meeting analysis receives only these
/// IDs and names; completion rechecks the fingerprint against the live vault.
public struct MeetingAllowedSupertagSnapshot: Codable, Equatable, Sendable, Identifiable {
  public let supertagID: SupertagID
  public let schemaFingerprint: String
  public let allowedFieldIDs: [SupertagFieldID]
  public let allowedRelationIDs: [RelationID]

  public var id: SupertagID { supertagID }

  public init(
    supertagID: SupertagID,
    schemaFingerprint: String,
    allowedFieldIDs: [SupertagFieldID] = [],
    allowedRelationIDs: [RelationID] = []
  ) {
    self.supertagID = supertagID
    self.schemaFingerprint = schemaFingerprint
    self.allowedFieldIDs = allowedFieldIDs.sorted { $0.rawValue < $1.rawValue }
    self.allowedRelationIDs = allowedRelationIDs.sorted { $0.rawValue < $1.rawValue }
  }
}

/// Authority issued at foreground Start. It freezes the selected routes so a
/// later settings change cannot reroute an in-flight meeting.
public struct MeetingAutomationAuthority: Codable, Equatable, Sendable {
  public let vaultID: VaultID
  public let eventPageID: PageID
  public let occurrenceKey: String
  public let sessionID: UUID
  public let transcriptionRoute: MeetingTranscriptionRouteSnapshot
  public let analysisRoute: MeetingAnalysisRouteSnapshot
  public let issuedAt: Date
  public let expiresAt: Date
  public let capabilities: MeetingAutomationCapabilities
  /// Existing tags only. An empty list means semantic entity creation was not
  /// authorized at Start, rather than "all tags".
  public let allowedSupertags: [MeetingAllowedSupertagSnapshot]

  public init(vaultID: VaultID, eventPageID: PageID, occurrenceKey: String, sessionID: UUID = UUID(), transcriptionRoute: MeetingTranscriptionRouteSnapshot, analysisRoute: MeetingAnalysisRouteSnapshot, issuedAt: Date = Date(), expiresAt: Date, capabilities: MeetingAutomationCapabilities = .init(), allowedSupertags: [MeetingAllowedSupertagSnapshot] = []) {
    self.vaultID = vaultID
    self.eventPageID = eventPageID
    self.occurrenceKey = occurrenceKey
    self.sessionID = sessionID
    self.transcriptionRoute = transcriptionRoute
    self.analysisRoute = analysisRoute
    self.issuedAt = issuedAt
    self.expiresAt = expiresAt
    self.capabilities = capabilities
    self.allowedSupertags = allowedSupertags.sorted { $0.supertagID.rawValue < $1.supertagID.rawValue }
  }

  public func completion(transcriptHash: String, completedAt: Date = Date()) -> MeetingAutomationCompletionAuthority? {
    guard completedAt >= issuedAt, completedAt <= expiresAt, !transcriptHash.isEmpty else { return nil }
    return .init(authority: self, transcriptHash: transcriptHash, completedAt: completedAt)
  }
}

/// Completion-only authority. The transcript hash intentionally does not exist
/// at Start and can therefore only be bound after capture is complete.
public struct MeetingAutomationCompletionAuthority: Codable, Equatable, Sendable {
  public let authority: MeetingAutomationAuthority
  public let transcriptHash: String
  public let completedAt: Date
}
