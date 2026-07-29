import EnchiridionCore
import SwiftUI

struct MobileRootView: View {
  @State private var store: LibraryStore
  private let contactsResolver: DeviceContactsResolver
  private let assistantSession: AssistantConversationSession?
  private let assistantUnavailableReason: String?

  init(
    store: LibraryStore,
    contactsResolver: DeviceContactsResolver = DeviceContactsResolver(),
    assistantSession: AssistantConversationSession? = nil,
    assistantUnavailableReason: String? = nil
  ) {
    _store = State(initialValue: store)
    self.contactsResolver = contactsResolver
    self.assistantSession = assistantSession
    self.assistantUnavailableReason = assistantUnavailableReason
  }

  var body: some View {
    TabView {
      TodayWorkspaceView(
        store: store,
        assistantSession: assistantSession,
        assistantUnavailableReason: assistantUnavailableReason
      )
        .tabItem { Label("Today", systemImage: "sun.max") }

      MobileTaskHomeScreen(store: store)
        .tabItem { Label("Tasks", systemImage: "checkmark.circle") }

      MobileLibraryScreen(store: store)
        .tabItem { Label("Library", systemImage: "books.vertical") }

      CalendarScreen(store: store)
        .tabItem { Label("Calendar", systemImage: "calendar") }

      MobileSettingsView(store: store, contactsResolver: contactsResolver)
        .tabItem { Label("Settings", systemImage: "gear") }
    }
  }
}
