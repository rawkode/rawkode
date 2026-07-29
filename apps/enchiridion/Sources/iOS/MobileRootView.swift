import EnchiridionCore
import SwiftUI

struct MobileRootView: View {
  @Environment(\.scenePhase) private var scenePhase

  @State private var store: LibraryStore
  @State private var selectedTab: MobileTab = .today
  @State private var requestedTaskSelection: TaskListSelection?
  @State private var requestedTaskID: PageID?
  @State private var showsQuickTaskCapture = false
  @State private var quickTaskSelection: TaskListSelection = .smart(.inbox)
  @State private var assistantPresentation: MobileAssistantPresentation?
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
      TodayWorkspaceView(store: store)
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
    .overlay(alignment: .bottomTrailing) {
      AssistantFloatingActionButton(
        openTextChat: { assistantPresentation = .text },
        startVoice: { assistantPresentation = .voice }
      )
      .padding(.trailing, 18)
      .padding(.bottom, 66)
    }
    .sheet(isPresented: assistantPresentationBinding(for: .text)) {
      AssistantConversationView(
        session: assistantSession,
        unavailableReason: assistantUnavailableReason
      )
    }
    .fullScreenCover(isPresented: assistantPresentationBinding(for: .voice)) {
      ImmersiveAssistantView(
        session: assistantSession,
        unavailableReason: assistantUnavailableReason
      )
    }
    .sheet(isPresented: $showsQuickTaskCapture) {
      TaskQuickCaptureSheet(store: store, selection: quickTaskSelection)
    }
    .sheet(item: $requestedTaskID) { pageID in
      NavigationStack {
        TaskDetailScreen(store: store, pageID: pageID)
      }
    }
    .onOpenURL { url in
      guard let route = TaskDeepLinkRoute(url: url) else { return }
      Task { await open(route) }
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active else { return }
      Task { await store.reload() }
    }
  }

  private func assistantPresentationBinding(
    for presentation: MobileAssistantPresentation
  ) -> Binding<Bool> {
    Binding(
      get: { assistantPresentation == presentation },
      set: { isPresented in
        if !isPresented, assistantPresentation == presentation {
          assistantPresentation = nil
        }
      }
    )
  }

  private func open(_ route: TaskDeepLinkRoute) async {
    await store.reload()
    let route = route.validated(against: store.pages)
    selectedTab = .tasks
    requestedTaskSelection = .smart(route.list)

    switch route {
    case .list:
      requestedTaskID = nil
      showsQuickTaskCapture = false
    case .task(let pageID, list: _):
      showsQuickTaskCapture = false
      requestedTaskID = pageID
    case .quickAdd(let list):
      requestedTaskID = nil
      quickTaskSelection = .smart(list)
      showsQuickTaskCapture = true
    }
  }
}

private enum MobileAssistantPresentation: Hashable {
  case text
  case voice
}

private enum MobileTab: Hashable {
  case today
  case tasks
  case library
  case calendar
  case settings
}
