import AppKit
import SwiftUI

enum ScoutThemeID: String, CaseIterable, Identifiable, Sendable {
  case system
  case rosePine
  case catppuccin
  case nord
  case dracula
  case github
  case solarized
  case oneDark
  case tokyoNight
  case gruvbox
  case monokai

  var id: Self { self }

  var displayName: String {
    switch self {
    case .system: "System"
    case .rosePine: "Rose Pine"
    case .catppuccin: "Catppuccin"
    case .nord: "Nord"
    case .dracula: "Dracula"
    case .github: "GitHub"
    case .solarized: "Solarized"
    case .oneDark: "One Dark"
    case .tokyoNight: "Tokyo Night"
    case .gruvbox: "Gruvbox"
    case .monokai: "Monokai"
    }
  }

  var subtitle: String {
    switch self {
    case .system: "Use macOS colors"
    case .rosePine: "Natural, muted tones"
    case .catppuccin: "Pastel syntax colors"
    case .nord: "Arctic blue neutrals"
    case .dracula: "Violet and pink contrast"
    case .github: "GitHub's familiar surfaces"
    case .solarized: "Precision low-contrast color"
    case .oneDark: "Atom's balanced classic"
    case .tokyoNight: "Night-time city lights"
    case .gruvbox: "Warm retro earth tones"
    case .monokai: "High-contrast editor classic"
    }
  }
}

struct ScoutThemePalette {
  let canvasNS: NSColor
  let elevatedNS: NSColor
  let sidebarNS: NSColor
  let chromeNS: NSColor
  let separatorNS: NSColor
  let quietFillNS: NSColor
  let selectionNS: NSColor
  let accentNS: NSColor
  let accentForegroundNS: NSColor
  let primaryNS: NSColor
  let secondaryNS: NSColor
  let tertiaryNS: NSColor

  var canvas: Color { Color(nsColor: canvasNS) }
  var elevated: Color { Color(nsColor: elevatedNS) }
  var sidebar: Color { Color(nsColor: sidebarNS) }
  var chrome: Color { Color(nsColor: chromeNS) }
  var separator: Color { Color(nsColor: separatorNS) }
  var quietFill: Color { Color(nsColor: quietFillNS) }
  var selection: Color { Color(nsColor: selectionNS) }
  var accent: Color { Color(nsColor: accentNS) }
  var accentForeground: Color { Color(nsColor: accentForegroundNS) }
  var primary: Color { Color(nsColor: primaryNS) }
  var secondary: Color { Color(nsColor: secondaryNS) }
  var tertiary: Color { Color(nsColor: tertiaryNS) }
}

struct ScoutThemeDefinition {
  static let preferenceKey = "ScoutThemeID"

  let id: ScoutThemeID
  let light: ScoutThemePalette
  let dark: ScoutThemePalette

  func palette(for colorScheme: ColorScheme) -> ScoutThemePalette {
    colorScheme == .dark ? dark : light
  }

  static func named(_ id: ScoutThemeID) -> Self {
    switch id {
    case .system:
      let palette = systemPalette
      return Self(id: id, light: palette, dark: palette)

    case .rosePine:
      return Self(
        id: id,
        light: codingPalette(
          base: 0xFAF4ED, surface: 0xFFFAF3, overlay: 0xF2E9E1,
          accent: 0xB4637A, text: 0x575279, muted: 0x797593,
          accentForeground: 0xFFFAF3, selectionAlpha: 0.18
        ),
        dark: codingPalette(
          base: 0x191724, surface: 0x1F1D2E, overlay: 0x26233A,
          accent: 0xEB6F92, text: 0xE0DEF4, muted: 0x908CAA,
          accentForeground: 0x191724, selectionAlpha: 0.24
        )
      )

    case .catppuccin:
      return Self(
        id: id,
        light: codingPalette(
          base: 0xEFF1F5, surface: 0xE6E9EF, overlay: 0xDCE0E8,
          accent: 0x8839EF, text: 0x4C4F69, muted: 0x6C6F85,
          accentForeground: 0xFFFFFF, selectionAlpha: 0.16
        ),
        dark: codingPalette(
          base: 0x1E1E2E, surface: 0x181825, overlay: 0x313244,
          accent: 0xCBA6F7, text: 0xCDD6F4, muted: 0xA6ADC8,
          accentForeground: 0x1E1E2E, selectionAlpha: 0.24
        )
      )

    case .nord:
      return Self(
        id: id,
        light: codingPalette(
          base: 0xECEFF4, surface: 0xE5E9F0, overlay: 0xD8DEE9,
          accent: 0x5E81AC, text: 0x2E3440, muted: 0x4C566A,
          accentForeground: 0xECEFF4, selectionAlpha: 0.18
        ),
        dark: codingPalette(
          base: 0x2E3440, surface: 0x3B4252, overlay: 0x434C5E,
          accent: 0x88C0D0, text: 0xD8DEE9, muted: 0xA3B1C6,
          accentForeground: 0x2E3440, selectionAlpha: 0.25
        )
      )

    case .dracula:
      return Self(
        id: id,
        light: codingPalette(
          base: 0xF8F8F2, surface: 0xFFFFFF, overlay: 0xE9E9F2,
          accent: 0x7654B8, text: 0x282A36, muted: 0x555765,
          accentForeground: 0xFFFFFF, selectionAlpha: 0.16
        ),
        dark: codingPalette(
          base: 0x282A36, surface: 0x343746, overlay: 0x44475A,
          accent: 0xBD93F9, text: 0xF8F8F2, muted: 0xB7B9C8,
          accentForeground: 0x282A36, selectionAlpha: 0.25
        )
      )

    case .github:
      return Self(
        id: id,
        light: codingPalette(
          base: 0xFFFFFF, surface: 0xF6F8FA, overlay: 0xEAEEF2,
          accent: 0x0969DA, text: 0x1F2328, muted: 0x656D76,
          accentForeground: 0xFFFFFF, selectionAlpha: 0.14
        ),
        dark: codingPalette(
          base: 0x0D1117, surface: 0x161B22, overlay: 0x21262D,
          accent: 0x58A6FF, text: 0xE6EDF3, muted: 0x8B949E,
          accentForeground: 0x0D1117, selectionAlpha: 0.25
        )
      )

    case .solarized:
      return Self(
        id: id,
        light: codingPalette(
          base: 0xFDF6E3, surface: 0xEEE8D5, overlay: 0xE0D9C4,
          accent: 0x268BD2, text: 0x586E75, muted: 0x657B83,
          accentForeground: 0x002B36, selectionAlpha: 0.18
        ),
        dark: codingPalette(
          base: 0x002B36, surface: 0x073642, overlay: 0x094451,
          accent: 0x2AA198, text: 0xEEE8D5, muted: 0x93A1A1,
          accentForeground: 0x002B36, selectionAlpha: 0.25
        )
      )

    case .oneDark:
      return Self(
        id: id,
        light: codingPalette(
          base: 0xFAFAFA, surface: 0xF0F0F0, overlay: 0xE5E5E6,
          accent: 0x4078F2, text: 0x383A42, muted: 0x696C77,
          accentForeground: 0xFFFFFF, selectionAlpha: 0.14
        ),
        dark: codingPalette(
          base: 0x282C34, surface: 0x21252B, overlay: 0x2C313C,
          accent: 0x61AFEF, text: 0xABB2BF, muted: 0x858C99,
          accentForeground: 0x282C34, selectionAlpha: 0.25
        )
      )

    case .tokyoNight:
      return Self(
        id: id,
        light: codingPalette(
          base: 0xE1E2E7, surface: 0xD5D6DB, overlay: 0xCBCCD1,
          accent: 0x2E7DE9, text: 0x3760BF, muted: 0x6172A0,
          accentForeground: 0xFFFFFF, selectionAlpha: 0.16
        ),
        dark: codingPalette(
          base: 0x1A1B26, surface: 0x16161E, overlay: 0x24283B,
          accent: 0x7AA2F7, text: 0xC0CAF5, muted: 0x7982A9,
          accentForeground: 0x1A1B26, selectionAlpha: 0.25
        )
      )

    case .gruvbox:
      return Self(
        id: id,
        light: codingPalette(
          base: 0xFBF1C7, surface: 0xF2E5BC, overlay: 0xEBDBB2,
          accent: 0xB57614, text: 0x3C3836, muted: 0x665C54,
          accentForeground: 0xFBF1C7, selectionAlpha: 0.18
        ),
        dark: codingPalette(
          base: 0x282828, surface: 0x3C3836, overlay: 0x504945,
          accent: 0xFABD2F, text: 0xEBDBB2, muted: 0xBDAE93,
          accentForeground: 0x282828, selectionAlpha: 0.25
        )
      )

    case .monokai:
      return Self(
        id: id,
        light: codingPalette(
          base: 0xF8F8F2, surface: 0xFFFFFF, overlay: 0xE6E6E0,
          accent: 0x007ACC, text: 0x272822, muted: 0x5C5D56,
          accentForeground: 0xFFFFFF, selectionAlpha: 0.16
        ),
        dark: codingPalette(
          base: 0x272822, surface: 0x3E3D32, overlay: 0x49483E,
          accent: 0xA6E22E, text: 0xF8F8F2, muted: 0xC5C8B8,
          accentForeground: 0x272822, selectionAlpha: 0.25
        )
      )
    }
  }

  private static let systemPalette = ScoutThemePalette(
    canvasNS: .textBackgroundColor,
    elevatedNS: .controlBackgroundColor,
    sidebarNS: .underPageBackgroundColor,
    chromeNS: .windowBackgroundColor,
    separatorNS: .separatorColor,
    quietFillNS: NSColor.quaternaryLabelColor.withAlphaComponent(0.10),
    selectionNS: NSColor.controlAccentColor.withAlphaComponent(0.20),
    accentNS: .controlAccentColor,
    accentForegroundNS: .selectedControlTextColor,
    primaryNS: .labelColor,
    secondaryNS: .secondaryLabelColor,
    tertiaryNS: .tertiaryLabelColor
  )

  private static func codingPalette(
    base: UInt32,
    surface: UInt32,
    overlay: UInt32,
    accent: UInt32,
    text: UInt32,
    muted: UInt32,
    accentForeground: UInt32,
    selectionAlpha: CGFloat
  ) -> ScoutThemePalette {
    let baseColor = hex(base)
    let surfaceColor = hex(surface)
    let overlayColor = hex(overlay)
    let accentColor = hex(accent)
    let textColor = hex(text)
    let mutedColor = hex(muted)
    let backgrounds = [baseColor, surfaceColor, overlayColor]
    let secondaryColor = contrastSafeForeground(
      preferred: mutedColor,
      toward: textColor,
      backgrounds: backgrounds
    )
    let tertiaryColor = contrastSafeForeground(
      preferred: mutedColor,
      toward: textColor,
      backgrounds: backgrounds
    )

    return ScoutThemePalette(
      canvasNS: baseColor,
      elevatedNS: surfaceColor,
      sidebarNS: surfaceColor,
      chromeNS: overlayColor,
      separatorNS: mutedColor.withAlphaComponent(0.38),
      quietFillNS: overlayColor.withAlphaComponent(0.64),
      selectionNS: accentColor.withAlphaComponent(selectionAlpha),
      accentNS: accentColor,
      accentForegroundNS: hex(accentForeground),
      primaryNS: textColor,
      secondaryNS: secondaryColor,
      tertiaryNS: tertiaryColor
    )
  }

  private static func contrastSafeForeground(
    preferred: NSColor,
    toward target: NSColor,
    backgrounds: [NSColor],
    minimumContrast: CGFloat = 4.5
  ) -> NSColor {
    if backgrounds.allSatisfy({ contrastRatio(preferred, against: $0) >= minimumContrast }) {
      return preferred
    }

    var best = preferred
    var bestMinimumContrast = backgrounds.map { contrastRatio(preferred, against: $0) }.min() ?? 0
    let targets = [target, hex(0x000000), hex(0xFFFFFF)]

    for target in targets {
      for step in 1...20 {
        let amount = CGFloat(step) / 20
        let candidate = blend(preferred, toward: target, amount: amount)
        let candidateMinimumContrast = backgrounds.map { contrastRatio(candidate, against: $0) }.min() ?? 0
        if candidateMinimumContrast >= minimumContrast {
          return candidate
        }
        if candidateMinimumContrast > bestMinimumContrast {
          best = candidate
          bestMinimumContrast = candidateMinimumContrast
        }
      }
    }

    return best
  }

  private static func blend(_ color: NSColor, toward target: NSColor, amount: CGFloat) -> NSColor {
    let color = color.usingColorSpace(.sRGB)!
    let target = target.usingColorSpace(.sRGB)!
    return NSColor(
      srgbRed: color.redComponent + (target.redComponent - color.redComponent) * amount,
      green: color.greenComponent + (target.greenComponent - color.greenComponent) * amount,
      blue: color.blueComponent + (target.blueComponent - color.blueComponent) * amount,
      alpha: 1
    )
  }

  private static func contrastRatio(_ foreground: NSColor, against background: NSColor) -> CGFloat {
    let foregroundLuminance = relativeLuminance(foreground)
    let backgroundLuminance = relativeLuminance(background)
    let lighter = max(foregroundLuminance, backgroundLuminance)
    let darker = min(foregroundLuminance, backgroundLuminance)
    return (lighter + 0.05) / (darker + 0.05)
  }

  private static func relativeLuminance(_ color: NSColor) -> CGFloat {
    let color = color.usingColorSpace(.sRGB)!
    func linearize(_ component: CGFloat) -> CGFloat {
      component <= 0.03928 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
    }

    let red = linearize(color.redComponent)
    let green = linearize(color.greenComponent)
    let blue = linearize(color.blueComponent)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }

  private static func hex(_ value: UInt32) -> NSColor {
    NSColor(
      srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
      green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255,
      alpha: 1
    )
  }
}

private struct ScoutThemeEnvironmentKey: EnvironmentKey {
  static let defaultValue = ScoutThemeDefinition.named(.system)
}

extension EnvironmentValues {
  var scoutTheme: ScoutThemeDefinition {
    get { self[ScoutThemeEnvironmentKey.self] }
    set { self[ScoutThemeEnvironmentKey.self] = newValue }
  }
}

struct ScoutBrandMark: View {
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme

  var size: CGFloat = 42

  private var palette: ScoutThemePalette { theme.palette(for: colorScheme) }

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
        .fill(palette.accent)
      Image(systemName: "chevron.forward.2")
        .font(.system(size: size * 0.40, weight: .bold))
        .foregroundStyle(palette.accentForeground)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
