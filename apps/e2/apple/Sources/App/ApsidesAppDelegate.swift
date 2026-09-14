#if os(iOS)
import UIKit

@MainActor
final class ApsidesAppDelegate: NSObject, UIApplicationDelegate {
    private(set) static weak var current: ApsidesAppDelegate?
    let store = WorkspaceStore()

    override init() {
        super.init()
        Self.current = self
    }
}
#endif
