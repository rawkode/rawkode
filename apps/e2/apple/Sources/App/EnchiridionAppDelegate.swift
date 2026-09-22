#if os(iOS)
import UIKit

@MainActor
final class EnchiridionAppDelegate: NSObject, UIApplicationDelegate {
    private(set) static weak var current: EnchiridionAppDelegate?
    let store = WorkspaceStore()

    override init() {
        super.init()
        Self.current = self
    }
}
#endif
