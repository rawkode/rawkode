import AppKit
import SwiftUI

struct ScoutWindowBridge: NSViewRepresentable {
  let title: String

  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async { configure(view.window) }
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    DispatchQueue.main.async { configure(nsView.window) }
  }

  private func configure(_ window: NSWindow?) {
    guard let window else { return }
    window.title = title
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.toolbarStyle = .unifiedCompact
    window.backgroundColor = ScoutTheme.canvasNS
    window.tabbingMode = .preferred
    window.tabbingIdentifier = "dev.rawkode.scout.browser"
    window.minSize = NSSize(width: 900, height: 560)
    window.isRestorable = true
  }
}
