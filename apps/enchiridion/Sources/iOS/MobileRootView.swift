import EnchiridionCore
import SwiftUI

struct MobileRootView: View {
  @State private var store: LibraryStore

  init(store: LibraryStore) {
    _store = State(initialValue: store)
  }

  var body: some View {
    TabView {
      TodayWorkspaceView(store: store)
        .tabItem { Label("Today", systemImage: "sun.max") }

      MobileLibraryScreen(store: store)
        .tabItem { Label("Library", systemImage: "books.vertical") }

      CalendarScreen(store: store)
        .tabItem { Label("Calendar", systemImage: "calendar") }

      MobileSettingsView(store: store)
        .tabItem { Label("Settings", systemImage: "gear") }
    }
  }
}
