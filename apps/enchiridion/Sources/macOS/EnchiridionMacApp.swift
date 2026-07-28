import EnchiridionCore
import SwiftUI

@main
struct EnchiridionMacApp: App {
  @FocusedValue(\.newPageAction) private var newPageAction
  @Environment(\.openWindow) private var openWindow

  var body: some Scene {
    WindowGroup {
      MacRootView(store: EnchiridionMacRuntime.shared.store)
        .frame(minWidth: 820, minHeight: 520)
        .managesDeviceContacts(
          store: EnchiridionMacRuntime.shared.store,
          resolver: EnchiridionMacRuntime.shared.contactsResolver
        )
    }
    .commands {
      CommandGroup(after: .newItem) {
        Button("New Page") {
          newPageAction?()
        }
        .keyboardShortcut("n", modifiers: .command)
        .disabled(newPageAction == nil)

        Divider()

        Button("Open Assistant") {
          openWindow(id: "assistant")
        }
        .keyboardShortcut("a", modifiers: [.command, .shift])
      }
    }

    Window("Assistant", id: "assistant") {
      AssistantConversationView(
        session: EnchiridionMacRuntime.shared.assistantSession,
        unavailableReason: EnchiridionMacRuntime.shared.assistantUnavailableReason
      )
      .frame(minWidth: 480, minHeight: 560)
    }
    .defaultSize(width: 560, height: 680)

    Settings {
      MacSettingsView(
        store: EnchiridionMacRuntime.shared.store,
        contactsResolver: EnchiridionMacRuntime.shared.contactsResolver
      )
    }
  }
}

@MainActor
final class EnchiridionMacRuntime {
  static let shared = EnchiridionMacRuntime()

  let repository: LibraryRepository?
  let store: LibraryStore
  let assistant: FoundationModelAssistant?
  lazy var assistantSession = makeAssistantConversationSession(assistant: assistant)
  var assistantUnavailableReason: String? {
    assistantUnavailabilityMessage(assistant: assistant, repositoryError: repositoryError)
  }
  let repositoryError: String?
  let contactsResolver = DeviceContactsResolver()

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
