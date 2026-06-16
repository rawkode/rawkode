import SwiftUI

struct NotesAppScene: Scene {
    @State private var store = NotesStore()

    var body: some Scene {
#if os(macOS)
        WindowGroup {
            NotesRootView(store: store)
        }
        .commands {
            SidebarCommands()
        }
#else
        WindowGroup {
            NotesRootView(store: store)
        }
#endif
    }
}
