#if os(macOS)
import AppKit
import SwiftUI

/// SwiftUI disappearance is not a reliable window-close boundary. Observe only this view's window.
struct VoiceWindowCloseObserver: NSViewRepresentable {
    let onClose: @MainActor () -> Void

    func makeNSView(context: Context) -> ObserverView {
        let view = ObserverView()
        view.onClose = onClose
        return view
    }
    func updateNSView(_ nsView: ObserverView, context: Context) { nsView.onClose = onClose }
    static func dismantleNSView(_ nsView: ObserverView, coordinator: ()) { nsView.detach() }

    final class ObserverView: NSView {
        var onClose: (@MainActor () -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            NotificationCenter.default.removeObserver(self, name: NSWindow.willCloseNotification, object: nil)
            if let window {
                NotificationCenter.default.addObserver(self, selector: #selector(windowWillClose), name: NSWindow.willCloseNotification, object: window)
            }
        }
        @objc private func windowWillClose(_ notification: Notification) { onClose?() }
        func detach() {
            NotificationCenter.default.removeObserver(self, name: NSWindow.willCloseNotification, object: nil)
            onClose = nil
        }
    }
}
#endif
