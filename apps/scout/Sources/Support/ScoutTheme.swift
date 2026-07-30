import AppKit
import SwiftUI

enum ScoutTheme {
  static let canvas = Color(nsColor: canvasNS)
  static let elevated = Color(nsColor: elevatedNS)
  static let sidebar = Color(nsColor: sidebarNS)
  static let chrome = Color(nsColor: chromeNS)
  static let separator = Color(nsColor: separatorNS)
  static let quietFill = Color(nsColor: quietFillNS)
  static let selection = Color(nsColor: selectionNS)
  static let accent = Color("ScoutAccent")

  static let canvasNS = NSColor.textBackgroundColor
  static let elevatedNS = NSColor.controlBackgroundColor
  static let sidebarNS = NSColor.underPageBackgroundColor
  static let chromeNS = NSColor.windowBackgroundColor
  static let separatorNS = NSColor.separatorColor
  static let quietFillNS = NSColor.quaternaryLabelColor.withAlphaComponent(0.10)
  static let selectionNS = NSColor.controlAccentColor.withAlphaComponent(0.20)
}

struct ScoutBrandMark: View {
  var size: CGFloat = 42

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
        .fill(ScoutTheme.accent)
      Image(systemName: "chevron.forward.2")
        .font(.system(size: size * 0.40, weight: .bold))
        .foregroundStyle(.white)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
