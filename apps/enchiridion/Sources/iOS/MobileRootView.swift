import EnchiridionCore
import SwiftUI

struct MobileRootView: View {
  @State private var store = LibraryStore()

  var body: some View {
    TabView {
      PageListScreen(store: store, section: .today)
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
