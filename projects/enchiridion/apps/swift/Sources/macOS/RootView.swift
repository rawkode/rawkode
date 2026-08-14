// RootView.swift
// Enchiridion2Mac
//
// Task #85 (P7 integration wave — see Sources/iOS/RootView.swift's header
// for the full "why this file exists now" context, which applies
// identically here). macOS's native navigation idiom for exactly this
// shape (a small, fixed set of top-level destinations) is a sidebar inside
// `NavigationSplitView`, not a `TabView` — this app's own ecosystem (this
// ported precedent's TabView shows up in the iOS target only) and every
// mainstream native macOS app with a handful of top-level sections (Mail,
// Notes, Reminders, Music) uses a sidebar list, not the tab-bar-per-window
// convention iOS uses instead; `TabView` on macOS also renders as a row of
// top tabs by default, which is the wrong affordance for 3 persistent
// destinations a person is expected to switch between constantly, not
// occasional per-content tabs. Same three real destinations, same shared
// `LocalGraphStore`, same `RootTab` vocabulary (`EnchiridionUI
// /RootNavigation.swift`) as the iOS shell — only the navigation container
// differs, per the task brief's "match platform convention."
//
// TASK #91 — ASSISTANT CONTROLLER HOISTED ABOVE THE DESTINATION SWITCH:
// `detail` below renders exactly one destination at a time inside a
// conditional `switch` (`destination(for:store:assistantController:)`).
// Standard SwiftUI branch-identity semantics tear down and rebuild
// whichever case isn't currently selected — so if `AssistantHomeView` had
// owned its own `AssistantConversationController` (as it used to), every
// trip away from "Assistant" and back would silently rebuild it from
// scratch, discarding the whole conversation transcript and any pending
// unconfirmed write proposal. This is a real, HIGH-severity data-loss bug
// class this codebase has already named exactly once before, for a
// different destination — `PageEditorView`'s `onDisappear`-flush handling
// — and never had for Assistant until now.
//
// The fix: `assistantController` lives in THIS view's own `@State`,
// constructed exactly once (guarded by `store == nil`, same as `store`
// itself) in `openStore()`, above wherever `NavigationSplitView` swaps
// destinations. `AssistantHomeView` (`EnchiridionUI/AssistantHomeView.swift`
// — see its header) now just receives it as a plain, already-alive value
// and never constructs one itself. `NavigationSplitView` can still freely
// tear down and rebuild the `AssistantHomeView` struct itself when the
// person navigates away and back — that's fine, it's stateless now — but
// the controller it's handed is always the SAME one, so the transcript and
// any pending proposal survive exactly like they already did on iOS's
// resident-tabs `TabView` shell (`Sources/iOS/RootView.swift`).
//
// This does not reintroduce the retain-cycle `AssistantSceneAssembly
// .ControllerBox.controller`'s `weak var` fix addresses (see that file's
// header) — there is still exactly one `AssistantConversationController`
// per app launch, now constructed once here instead of once per
// destination rebuild, which if anything makes that comment's "accumulate
// unboundedly on repeated rebuild" worry moot for this call site.

import EnchiridionCore
import EnchiridionStore
import EnchiridionUI
import SwiftUI

struct RootView: View {
  @State private var store: LocalGraphStore?
  @State private var loadError: String?
  @State private var selectedTab: RootTab? = .today
  @State private var assistantController: AssistantConversationController?
  @State private var localVaultSync: LocalVaultSyncCoordinator?

  var body: some View {
    Group {
      if let store, let assistantController {
        NavigationSplitView {
          List(RootTab.allCases, selection: $selectedTab) { tab in
            Label(tab.title, systemImage: tab.systemImage).tag(tab)
          }
          .navigationTitle("Enchiridion")
        } detail: {
          if let selectedTab {
            NavigationStack {
              destination(for: selectedTab, store: store, assistantController: assistantController)
                .navigationTitle(selectedTab.title)
            }
          } else {
            ContentUnavailableView("Choose a section", systemImage: "sidebar.left")
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
    .frame(minWidth: 760, minHeight: 480)
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
      let syncConfiguration = AppBackendConfiguration.localVaultSyncConfiguration
      let opened: LocalGraphStore
      if let storePath = syncConfiguration?.storePath {
        opened = try LocalGraphStore(path: storePath)
      } else {
        opened = try LocalGraphStore.openAppGroupStore()
      }
      store = opened
      assistantController = AssistantSceneAssembly.makeConversationController(store: opened)
      if let syncConfiguration {
        let sync = LocalVaultSyncCoordinator(store: opened, configuration: syncConfiguration)
        localVaultSync = sync
        Task { await sync.start() }
      }
    } catch {
      loadError = error.localizedDescription
    }
  }
}
