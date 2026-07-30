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
        unavailableReason: runtime.assistantUnavailableReason
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
  let assistantProviderSettings = AssistantProviderSettingsController()
  private let fallbackStore: LibraryStore
  private(set) var assistant: FoundationModelAssistant?
  private(set) var assistantSession: AssistantConversationSession?
  private(set) var repositoryError: String?

  var repository: LibraryRepository? { vaultSession?.repository }
  var store: LibraryStore { vaultSession?.store ?? fallbackStore }
  var assistantUnavailableReason: String? {
    assistantUnavailabilityMessage(assistant: assistant, repositoryError: repositoryError)
  }
  private init() {
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
  }

  func store(for vaultID: VaultID) throws -> LibraryStore? {
    guard let vaultSession else {
      return store.vaultID == vaultID ? store : nil
    }
    return try vaultSession.store(forVault: vaultID, selectingWith: selectVault)
  }

  private func rebuildWorkspaceDependents() {
    assistant = repository.map { FoundationModelAssistant(repository: $0) }
    assistantSession = makeAssistantConversationSession(
      assistant: assistant,
      voicePreferences: assistantVoicePreferences
    )
  }
}
