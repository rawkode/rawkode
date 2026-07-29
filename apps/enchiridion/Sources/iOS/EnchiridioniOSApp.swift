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
        assistantUnavailableReason: runtime.assistantUnavailableReason
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
    repositoryError = nil
    rebuildWorkspaceDependents()
    TaskReminderNotificationCoordinator.shared.configure(
      store: store,
      openURL: { url in UIApplication.shared.open(url) }
    )
  }

  private func rebuildWorkspaceDependents() {
    carPlayVoice?.disconnect()
    assistant = repository.map { FoundationModelAssistant(repository: $0) }
    carPlayAssistant = repository.map { FoundationModelAssistant(repository: $0) }
    assistantSession = makeAssistantConversationSession(assistant: assistant)
    carPlayAssistantSession = makeAssistantConversationSession(
      assistant: carPlayAssistant,
      surface: .carPlay
    )
    carPlayVoice = CarPlayVoiceCoordinator(
      session: carPlayAssistantSession,
      unavailableReason: { [weak self] in
        guard let self else { return "Your local library is unavailable." }
        return assistantUnavailabilityMessage(
          assistant: self.carPlayAssistant,
          repositoryError: self.repositoryError
        )
      }
    )
  }
}
