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

  static let canvasNS = NSColor(name: nil) { appearance in
    appearance.isDark
      ? NSColor(displayP3Red: 0.050, green: 0.075, blue: 0.058, alpha: 1)
      : NSColor(displayP3Red: 0.955, green: 0.973, blue: 0.960, alpha: 1)
  }

  static let elevatedNS = NSColor(name: nil) { appearance in
    appearance.isDark
      ? NSColor(displayP3Red: 0.071, green: 0.105, blue: 0.080, alpha: 1)
      : NSColor(displayP3Red: 0.985, green: 0.992, blue: 0.987, alpha: 1)
  }

  static let sidebarNS = NSColor(name: nil) { appearance in
    appearance.isDark
      ? NSColor(displayP3Red: 0.065, green: 0.100, blue: 0.075, alpha: 0.96)
      : NSColor(displayP3Red: 0.900, green: 0.935, blue: 0.910, alpha: 0.96)
  }

  static let chromeNS = NSColor(name: nil) { appearance in
    appearance.isDark
      ? NSColor(displayP3Red: 0.075, green: 0.118, blue: 0.086, alpha: 0.92)
      : NSColor(displayP3Red: 0.875, green: 0.925, blue: 0.892, alpha: 0.92)
  }

  static let separatorNS = NSColor(name: nil) { appearance in
    appearance.isDark
      ? NSColor.white.withAlphaComponent(0.085)
      : NSColor(displayP3Red: 0.14, green: 0.23, blue: 0.17, alpha: 0.13)
  }

  static let quietFillNS = NSColor(name: nil) { appearance in
    appearance.isDark
      ? NSColor.white.withAlphaComponent(0.055)
      : NSColor(displayP3Red: 0.12, green: 0.28, blue: 0.18, alpha: 0.065)
  }

  static let selectionNS = NSColor(name: nil) { appearance in
    appearance.isDark
      ? NSColor(displayP3Red: 0.20, green: 0.48, blue: 0.30, alpha: 0.44)
      : NSColor(displayP3Red: 0.18, green: 0.43, blue: 0.29, alpha: 0.18)
  }
}

private extension NSAppearance {
  var isDark: Bool {
    bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
  }
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
    .shadow(color: .black.opacity(0.14), radius: 5, y: 2)
    .accessibilityHidden(true)
  }
}
