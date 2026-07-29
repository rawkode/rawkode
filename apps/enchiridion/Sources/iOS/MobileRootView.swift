import EnchiridionCore
import SwiftUI

struct MobileRootView: View {
  @State private var store: LibraryStore
  @State private var selectedTab: MobileTab = .today
  @State private var requestedTaskSelection: TaskListSelection?
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
    TabView(selection: $selectedTab) {
      TodayWorkspaceView(
        store: store,
        assistantSession: assistantSession,
        assistantUnavailableReason: assistantUnavailableReason
      )
        .tabItem { Label("Today", systemImage: "sun.max") }
        .tag(MobileTab.today)

      MobileTaskHomeScreen(store: store, requestedSelection: $requestedTaskSelection)
        .tabItem { Label("Tasks", systemImage: "checkmark.circle") }
        .tag(MobileTab.tasks)

      MobileLibraryScreen(store: store)
        .tabItem { Label("Library", systemImage: "books.vertical") }
        .tag(MobileTab.library)

      CalendarScreen(store: store)
        .tabItem { Label("Calendar", systemImage: "calendar") }
        .tag(MobileTab.calendar)

      MobileSettingsView(store: store, contactsResolver: contactsResolver)
        .tabItem { Label("Settings", systemImage: "gear") }
        .tag(MobileTab.settings)
    }
    .onOpenURL(perform: openURL)
  }

  private func openURL(_ url: URL) {
    guard url.scheme == "enchiridion", url.host == "tasks" else { return }
    selectedTab = .tasks
    let rawList = url.pathComponents.dropFirst().first ?? "inbox"
    requestedTaskSelection = .smart(TaskSmartList(rawValue: rawList) ?? .inbox)
  }
}

private enum MobileTab: Hashable {
  case today
  case tasks
  case library
  case calendar
  case settings
}
