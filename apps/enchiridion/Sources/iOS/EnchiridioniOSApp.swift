import EnchiridionCore
import SwiftUI
import UIKit

@main
struct EnchiridioniOSApp: App {
  @UIApplicationDelegateAdaptor(EnchiridionAppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      MobileRootView(
        store: EnchiridionAppRuntime.shared.store,
        contactsResolver: EnchiridionAppRuntime.shared.contactsResolver,
        assistantSession: EnchiridionAppRuntime.shared.assistantSession,
        assistantUnavailableReason: EnchiridionAppRuntime.shared.assistantUnavailableReason
      )
      .managesDeviceContacts(
        store: EnchiridionAppRuntime.shared.store,
        resolver: EnchiridionAppRuntime.shared.contactsResolver
      )
    }
  }
}

@MainActor
final class EnchiridionAppRuntime {
  static let shared = EnchiridionAppRuntime()

  let repository: LibraryRepository?
  let store: LibraryStore
  let assistant: FoundationModelAssistant?
  lazy var carPlayAssistant = repository.map { FoundationModelAssistant(repository: $0) }
  lazy var assistantSession = makeAssistantConversationSession(assistant: assistant)
  lazy var carPlayAssistantSession = makeAssistantConversationSession(
    assistant: carPlayAssistant,
    surface: .carPlay
  )
  var assistantUnavailableReason: String? {
    assistantUnavailabilityMessage(assistant: assistant, repositoryError: repositoryError)
  }
  let repositoryError: String?
  let contactsResolver = DeviceContactsResolver()
  lazy var carPlayVoice = CarPlayVoiceCoordinator(
    session: carPlayAssistantSession,
    unavailableReason: { [weak self] in
      guard let self else { return "Your local library is unavailable." }
      return assistantUnavailabilityMessage(
        assistant: self.carPlayAssistant,
        repositoryError: self.repositoryError
      )
    }
  )

  private init() {
    do {
      let repository = try LibraryRepository(path: LibraryRepository.defaultLocalPath())
      self.repository = repository
      store = LibraryStore(repository: repository, contactResolver: contactsResolver)
      assistant = FoundationModelAssistant(repository: repository)
      repositoryError = nil
    } catch {
      repository = nil
      store = LibraryStore(contactResolver: contactsResolver)
      assistant = nil
      repositoryError = error.localizedDescription
    }
  }
}
