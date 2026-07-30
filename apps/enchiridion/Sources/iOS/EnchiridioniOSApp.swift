import EnchiridionCore
import Observation
import SwiftUI
import UIKit

@main
struct EnchiridioniOSApp: App {
  @UIApplicationDelegateAdaptor(EnchiridionAppDelegate.self) private var appDelegate
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
        assistantVoicePreferences: runtime.assistantVoicePreferences
      )
      .managesDeviceContacts(
        store: runtime.store,
        resolver: runtime.contactsResolver
      )
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
  private let fallbackStore: LibraryStore
  private(set) var assistant: FoundationModelAssistant?
  private(set) var carPlayAssistant: FoundationModelAssistant?
  private(set) var assistantSession: AssistantConversationSession?
  private(set) var carPlayAssistantSession: AssistantConversationSession?
  private(set) var carPlayVoice: CarPlayVoiceCoordinator!
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
        try await EnchiridionAppRuntime.shared.vaultSession?.backgroundStore(forVault: vaultID)
      },
      openURL: { url in UIApplication.shared.open(url) }
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
    carPlayAssistant = repository.map { FoundationModelAssistant(repository: $0) }
    assistantSession = makeAssistantConversationSession(
      assistant: assistant,
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
