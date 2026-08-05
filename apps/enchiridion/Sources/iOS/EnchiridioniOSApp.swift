import EnchiridionCore
import Observation
import SwiftUI
import UIKit

@main
struct EnchiridioniOSApp: App {
  @UIApplicationDelegateAdaptor(EnchiridionAppDelegate.self) private var appDelegate
  @Environment(\.scenePhase) private var scenePhase
  @State private var runtime = EnchiridionAppRuntime.shared

  var body: some Scene {
    WindowGroup {
      MobileRootView(
        store: runtime.store,
        contactsResolver: runtime.contactsResolver,
        vaultSession: runtime.vaultSession,
        selectVault: runtime.selectVault,
        workspaceDidChange: runtime.workspaceDidChange,
        assistantSession: runtime.assistantSession,
        assistantUnavailableReason: runtime.assistantUnavailableReason,
        assistantVoicePreferences: runtime.assistantVoicePreferences,
        assistantProviderSettings: runtime.assistantProviderSettings
      )
      .managesDeviceContacts(
        store: runtime.store,
        resolver: runtime.contactsResolver
      )
      .onChange(of: scenePhase) { _, phase in
        if phase == .active {
          runtime.retryRetiredProviderMigration()
          runtime.reconcileMeetingPrompts()
        } else if phase == .background {
          MeetingTranscriptionRuntime.shared.sweepTransientCloudAudio()
        }
      }
      .onChange(of: runtime.store.calendarRelationshipGeneration) { _, _ in
        runtime.reconcileMeetingPrompts()
      }
    }
  }
}

@MainActor
@Observable
final class EnchiridionAppRuntime {
  static let shared = EnchiridionAppRuntime()

  let vaultSession: VaultSession?
  let contactsResolver = DeviceContactsResolver()
  let assistantVoicePreferences = AssistantVoicePreferences()
  let openAICredentialStore: OpenAICredentialStore
  let assistantProviderSettings: AssistantProviderSettingsController
  private let retiredQwenProviderMigrator = RetiredQwenProviderMigrator()
  private let fallbackStore: LibraryStore
  private(set) var assistant: FoundationModelAssistant?
  private(set) var textAssistant: OpenAIResponsesAssistant?
  private(set) var carPlayAssistant: FoundationModelAssistant?
  private(set) var assistantSession: AssistantConversationSession?
  private(set) var carPlayAssistantSession: AssistantConversationSession?
  private(set) var carPlayVoice: CarPlayVoiceCoordinator!
  private(set) var repositoryError: String?

  var repository: LibraryRepository? { vaultSession?.repository }
  var store: LibraryStore { vaultSession?.store ?? fallbackStore }
  var assistantUnavailableReason: String? {
    if let repositoryError { return "Your local library could not be opened: \(repositoryError)" }
    return assistantSession == nil ? "Your local library is unavailable." : nil
  }

  private init() {
    MeetingTranscriptionPromptScheduler.registerNotificationCategory()
    retiredQwenProviderMigrator.migrateIfNeeded()
    do {
      try WorkoutModuleViews.register()
    } catch {
      preconditionFailure("First-party module view registration failed: \(error)")
    }
    let credentialStore = OpenAICredentialStore()
    openAICredentialStore = credentialStore
    assistantProviderSettings = AssistantProviderSettingsController(
      credentialStore: credentialStore
    )
    do {
      let session = try VaultSession(contactResolver: contactsResolver)
      vaultSession = session
      fallbackStore = session.store
    } catch {
      vaultSession = nil
      fallbackStore = LibraryStore(contactResolver: contactsResolver)
      repositoryError = error.localizedDescription
    }
    rebuildWorkspaceDependents()
    configureMeetingTranscription()
    Task { await assistantProviderSettings.refreshCredentialState() }
  }

  func retryRetiredProviderMigration() {
    retiredQwenProviderMigrator.migrateIfNeeded()
  }

  func selectVault(_ id: VaultID) throws {
    guard let vaultSession else { throw VaultRegistryError.vaultNotFound }
    try vaultSession.selectVault(id)
    workspaceDidChange()
  }

  func workspaceDidChange() {
    if vaultSession != nil { repositoryError = nil }
    rebuildWorkspaceDependents()
    TaskReminderNotificationCoordinator.shared.configure(
      store: store,
      resolveStore: { vaultID in
        try await EnchiridionAppRuntime.shared.vaultSession?.backgroundStore(forVault: vaultID)
      },
      openURL: { url in UIApplication.shared.open(url) }
    )
    configureMeetingTranscription()
  }

  func reconcileMeetingPrompts() {
    MeetingTranscriptionRuntime.shared.reconcile(store: store)
  }

  private func configureMeetingTranscription() {
    MeetingTranscriptionRuntime.shared.configure(
      store: store,
      repository: repository,
      credentialStore: openAICredentialStore,
      providerSettings: assistantProviderSettings,
      captureFactory: { MeetingMicrophoneCapture() }
    )
  }

  /// Runs queued external bookmark captures without changing the selected vault. A successful
  /// import reloads only the currently selected store, which refreshes Today as well.
  func refreshBookmarkCaptures() async {
    guard await BookmarkCaptureRuntime.shared.refresh() else { return }
    await store.reload()
  }

  func store(for vaultID: VaultID) throws -> LibraryStore? {
    guard let vaultSession else {
      return store.vaultID == vaultID ? store : nil
    }
    return try vaultSession.store(forVault: vaultID, selectingWith: selectVault)
  }

  private func rebuildWorkspaceDependents() {
    assistant = repository.map { FoundationModelAssistant(repository: $0) }
    textAssistant = repository.flatMap { repository in
      assistant.map { appleAssistant in
        OpenAIResponsesAssistant(
          repository: repository,
          appleAnswerer: appleAssistant,
          credentialStore: openAICredentialStore,
          routeSnapshot: { [assistantProviderSettings] routeOverride in
            await assistantProviderSettings.textRouteSnapshot(for: routeOverride)
          }
        )
      }
    }
    carPlayAssistant = repository.map { FoundationModelAssistant(repository: $0) }
    assistantSession = makeAssistantConversationSession(
      assistant: textAssistant,
      voicePreferences: assistantVoicePreferences
    )
    carPlayAssistantSession = makeAssistantConversationSession(
      assistant: carPlayAssistant,
      voicePreferences: assistantVoicePreferences,
      surface: .carPlay
    )
    let unavailableReason: @MainActor () -> String? = { [weak self] in
      guard let self else { return "Your local library is unavailable." }
      return assistantUnavailabilityMessage(
        assistant: self.carPlayAssistant,
        repositoryError: self.repositoryError
      )
    }
    if let carPlayVoice {
      carPlayVoice.update(
        session: carPlayAssistantSession,
        unavailableReason: unavailableReason
      )
    } else {
      carPlayVoice = CarPlayVoiceCoordinator(
        session: carPlayAssistantSession,
        unavailableReason: unavailableReason
      )
    }
  }
}
