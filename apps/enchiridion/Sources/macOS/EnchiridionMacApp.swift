import AppKit
import EnchiridionCore
import Observation
import SwiftUI

@main
struct EnchiridionMacApp: App {
  @NSApplicationDelegateAdaptor(EnchiridionMacAppDelegate.self) private var appDelegate
  @FocusedValue(\.newPageAction) private var newPageAction
  @FocusedValue(\.newTaskAction) private var newTaskAction
  @FocusedValue(\.openTaskListAction) private var openTaskListAction
  @Environment(\.openWindow) private var openWindow
  @Environment(\.scenePhase) private var scenePhase
  @State private var runtime = EnchiridionMacRuntime.shared

  var body: some Scene {
    WindowGroup {
      MacRootView(
        store: runtime.store,
        vaultSession: runtime.vaultSession,
        selectVault: runtime.selectVault
      )
      .frame(minWidth: 820, minHeight: 520)
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
    .commands {
      CommandGroup(after: .newItem) {
        Button("New Page") {
          newPageAction?()
        }
        .keyboardShortcut("n", modifiers: .command)
        .disabled(newPageAction == nil)

        Button("New Task") {
          newTaskAction?()
        }
        .keyboardShortcut("n", modifiers: [.command, .shift])
        .disabled(newTaskAction == nil)

        Divider()

        Button("Open Assistant") {
          openWindow(id: "assistant")
        }
        .keyboardShortcut("a", modifiers: [.command, .shift])
      }

      CommandMenu("Tasks") {
        Button("Inbox") { openTaskListAction?(.inbox) }
          .keyboardShortcut("1", modifiers: [.command, .option])
        Button("Today") { openTaskListAction?(.today) }
          .keyboardShortcut("2", modifiers: [.command, .option])
        Button("Upcoming") { openTaskListAction?(.upcoming) }
          .keyboardShortcut("3", modifiers: [.command, .option])
        Divider()
        Button("Anytime") { openTaskListAction?(.anytime) }
        Button("Someday") { openTaskListAction?(.someday) }
        Button("Logbook") { openTaskListAction?(.logbook) }
      }
    }

    Window("Assistant", id: "assistant") {
      AssistantConversationView(
        session: runtime.assistantSession,
        unavailableReason: runtime.assistantUnavailableReason,
        providerSettings: runtime.assistantProviderSettings
      )
      .frame(minWidth: 480, minHeight: 560)
    }
    .defaultSize(width: 560, height: 680)

    Settings {
      MacSettingsView(
        store: runtime.store,
        contactsResolver: runtime.contactsResolver,
        vaultContext: runtime.vaultSession.map { session in
          VaultSettingsContext(
            session: session,
            selectVault: runtime.selectVault,
            workspaceDidChange: runtime.workspaceDidChange
          )
        },
        assistantVoicePreferences: runtime.assistantVoicePreferences,
        assistantProviderSettings: runtime.assistantProviderSettings
      )
    }
  }
}

@MainActor
@Observable
final class EnchiridionMacRuntime {
  static let shared = EnchiridionMacRuntime()

  let vaultSession: VaultSession?
  let contactsResolver = DeviceContactsResolver()
  let assistantVoicePreferences = AssistantVoicePreferences()
  let openAICredentialStore: OpenAICredentialStore
  let assistantProviderSettings: AssistantProviderSettingsController
  private let retiredQwenProviderMigrator = RetiredQwenProviderMigrator()
  private let fallbackStore: LibraryStore
  private(set) var assistant: FoundationModelAssistant?
  private(set) var textAssistant: OpenAIResponsesAssistant?
  private(set) var assistantSession: AssistantConversationSession?
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
        try await EnchiridionMacRuntime.shared.vaultSession?.backgroundStore(forVault: vaultID)
      },
      openURL: { url in NSWorkspace.shared.open(url) }
    )
    Task {
      await MacBookmarkCaptureRuntime.shared.configure {
        await EnchiridionMacRuntime.shared.store.reload()
      }
      await MacBookmarkCaptureRuntime.shared.drainInbox()
    }
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
      captureFactory: { MeetingSystemAudioCapture() }
    )
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
    assistantSession = makeAssistantConversationSession(
      assistant: textAssistant,
      voicePreferences: assistantVoicePreferences
    )
  }
}
