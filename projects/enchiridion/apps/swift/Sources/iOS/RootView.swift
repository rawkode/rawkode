// RootView.swift
// Enchiridion2iOS
//
// Task #85 (P7 integration wave — plan §Core Product UI (P7): "a direct
// audit against real user-facing success criteria found the actual
// product *screens* barely exist. `RootView.swift` today does exactly one
// thing: open a single blank scratch page."). This is that fix: a real
// `TabView` navigation shell over the three real destinations P7's
// parallel tracks built —
//   - Today (`EnchiridionUI.DayPageView` — day navigation + calendar
//     agenda, tracks 1+2, defaults to today via that view's own default
//     `day: DayKey` parameter)
//   - Tasks (`EnchiridionUI.TasksHomeView` — list/kanban toggle over
//     `TaskListView`/`TaskBoardView`, track 3)
//   - Assistant (`EnchiridionUI.AssistantHomeView` — the real,
//     P5-built-but-never-reachable-until-now `AssistantConversationView`,
//     track 4)
// Track 5 (native canvas) has no destination of its own — see
// `EnchiridionUI/RootNavigation.swift`'s `RootTab` doc comment for why: a
// canvas is always embedded IN a page (`PageEditorView`'s "Insert Canvas"
// toolbar action, `PageCanvasEmbedding.swift`), reachable from any page
// this app already opens (a day page's body, a task's detail page), not a
// freestanding screen.
//
// ONE SHARED `LocalGraphStore` FOR THE WHOLE APP: opened once here via
// `LocalGraphStore.openAppGroupStore()` — the SAME App-Group-shared
// production path `EnchiridionWidgetKit`/`EnchiridionShareKit`/
// `AssistantAppIntents.swift`'s bridge already resolve to
// (`EnchiridionStore/LocalGraphStoreLocation.swift`'s own doc comment: "a
// future app-side projection-writing pipeline is expected to call this
// same method rather than picking its own path, so the two processes
// never diverge") — and handed down to every destination below, rather
// than each screen (or, worse, each tab switch) opening its own instance.
//
// Identical in spirit to Sources/macOS/RootView.swift (same store-opening/
// error-handling shape) — kept as a separate file because `TabView` and
// `NavigationSplitView` are genuinely different, platform-appropriate
// navigation idioms (task brief: "match platform convention"), not because
// anything about opening the store or choosing a destination differs.
//
// TASK #91 — `assistantController` hoisted into this view's own `@State`
// alongside `store`, matching `Sources/macOS/RootView.swift` (see that
// file's header for the full data-loss bug this fixes on macOS's
// `NavigationSplitView`). This `TabView` shell never had that bug — keeping
// all three tab roots resident already kept `AssistantHomeView`'s old
// self-owned `@State private var controller` alive across tab switches —
// but `AssistantHomeView` (`EnchiridionUI/AssistantHomeView.swift`) no
// longer constructs its own controller at all, so both platforms now
// construct the ONE real `AssistantConversationController` the same way,
// in the same place, for the same reason.

import EnchiridionCore
import EnchiridionStore
import EnchiridionUI
import SwiftUI

struct RootView: View {
  @State private var store: LocalGraphStore?
  @State private var loadError: String?
  @State private var selectedTab: RootTab = .today
  @State private var assistantController: AssistantConversationController?

  var body: some View {
    Group {
      if let store, let assistantController {
        TabView(selection: $selectedTab) {
          ForEach(RootTab.allCases) { tab in
            NavigationStack {
              destination(for: tab, store: store, assistantController: assistantController)
                .navigationTitle(tab.title)
            }
            .tabItem { Label(tab.title, systemImage: tab.systemImage) }
            .tag(tab)
          }
        }
      } else if let loadError {
        ContentUnavailableView(
          "Couldn't open Enchiridion",
          systemImage: "exclamationmark.triangle",
          description: Text(loadError)
        )
      } else {
        ProgressView()
      }
    }
    .task {
      openStore()
    }
  }

  @ViewBuilder
  private func destination(
    for tab: RootTab, store: LocalGraphStore, assistantController: AssistantConversationController
  ) -> some View {
    switch tab {
    case .today:
      DayPageView(store: store)
    case .tasks:
      TasksHomeView(store: store)
    case .assistant:
      AssistantHomeView(controller: assistantController)
    case .devices:
      DeviceSettingsView()
    }
  }

  private func openStore() {
    guard store == nil, loadError == nil else { return }
    do {
      let opened = try LocalGraphStore.openAppGroupStore()
      store = opened
      assistantController = AssistantSceneAssembly.makeConversationController(store: opened)
    } catch {
      loadError = error.localizedDescription
    }
  }
}
