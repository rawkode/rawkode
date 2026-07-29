import Combine
import EnchiridionCore
import SwiftUI
import UIKit

struct MobileRootView: View {
  @Environment(\.scenePhase) private var scenePhase

  @State private var store: LibraryStore
  @State private var selectedTab: MobileTab = .today
  @State private var requestedTaskSelection: TaskListSelection?
  @State private var requestedTaskID: PageID?
  @State private var showsQuickTaskCapture = false
  @State private var quickTaskSelection: TaskListSelection = .smart(.inbox)
  @State private var systemHandoffCoordinator = TaskSystemHandoffCoordinator()
  @State private var isEditorFocused = false
  @State private var isKeyboardVisible = false
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
        .toolbar(tabBarVisibility, for: .tabBar)

      MobileTaskHomeScreen(store: store, requestedSelection: $requestedTaskSelection)
        .tabItem { Label("Tasks", systemImage: "checkmark.circle") }
        .tag(MobileTab.tasks)
        .toolbar(tabBarVisibility, for: .tabBar)

      AssistantConversationView(
        session: assistantSession,
        unavailableReason: assistantUnavailableReason,
        presentation: .embedded
      )
      .tabItem { Label("Assistant", systemImage: "waveform") }
        .tag(MobileTab.assistant)
        .toolbar(tabBarVisibility, for: .tabBar)

      CalendarScreen(store: store)
        .tabItem { Label("Calendar", systemImage: "calendar") }
        .tag(MobileTab.calendar)
        .toolbar(tabBarVisibility, for: .tabBar)

      MobileLibraryScreen(store: store, contactsResolver: contactsResolver)
        .tabItem { Label("Library", systemImage: "books.vertical") }
        .tag(MobileTab.library)
        .toolbar(tabBarVisibility, for: .tabBar)
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
      Task { await receive(route) }
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active else { return }
      Task { await refreshForActivation() }
    }
    .task { await refreshForActivation() }
    .presentsTaskCompletionUndo(from: store)
    .presentsTaskMutationWarnings(from: store)
    .onReceive(NotificationCenter.default.publisher(for: .enchiridionEditorFocusDidChange)) { notification in
      isEditorFocused = notification.userInfo?["isFocused"] as? Bool ?? false
    }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
      isKeyboardVisible = true
    }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
      isKeyboardVisible = false
    }
  }

  private var tabBarVisibility: Visibility {
    isEditorFocused || isKeyboardVisible ? .hidden : .visible
  }

  private func receive(_ route: TaskDeepLinkRoute) async {
    let outcome = await systemHandoffCoordinator.open(route) {
      await store.reload()
    }
    guard let route = outcome?.route else { return }
    apply(route)
  }

  private func refreshForActivation() async {
    let outcome = await systemHandoffCoordinator.activate {
      await store.reload()
    }
    guard let route = outcome?.route else { return }
    apply(route)
  }

  private func apply(_ route: TaskDeepLinkRoute) {
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

private enum MobileTab: Hashable {
  case today
  case tasks
  case assistant
  case calendar
  case library
}
