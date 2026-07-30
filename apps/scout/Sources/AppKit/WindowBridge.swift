import AppKit
import SwiftUI

struct ScoutWindowBridge: NSViewRepresentable {
  let title: String
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme

  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async { configure(view.window, palette: palette) }
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    DispatchQueue.main.async { configure(nsView.window, palette: palette) }
  }

  private var palette: ScoutThemePalette {
    theme.palette(for: colorScheme)
  }

  private func configure(_ window: NSWindow?, palette: ScoutThemePalette) {
    guard let window else { return }
    window.title = title
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.toolbarStyle = .unifiedCompact
    // Leave appearance ownership with macOS so system light/dark changes,
    // increased contrast, and other accessibility settings continue to flow
    // through the native window.
    window.appearance = nil
    window.backgroundColor = palette.canvasNS
    window.tabbingMode = .preferred
    window.tabbingIdentifier = "dev.rawkode.scout.browser"
    window.minSize = NSSize(width: 900, height: 560)
    window.isRestorable = true
  }
}
