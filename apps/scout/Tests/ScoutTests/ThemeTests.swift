import AppKit
import XCTest
@testable import Scout

final class ThemeTests: XCTestCase {
  func testEveryThemeResolvesLightAndDarkPalettes() {
    for id in ScoutThemeID.allCases {
      let definition = ScoutThemeDefinition.named(id)

      XCTAssertEqual(definition.id, id)
      XCTAssertNotNil(definition.light.canvasNS.usingColorSpace(.sRGB))
      XCTAssertNotNil(definition.dark.canvasNS.usingColorSpace(.sRGB))
      XCTAssertNotNil(definition.light.accentNS.usingColorSpace(.sRGB))
      XCTAssertNotNil(definition.dark.accentNS.usingColorSpace(.sRGB))

      if id != .system {
        XCTAssertNotEqual(rgb(definition.light.canvasNS), rgb(definition.dark.canvasNS), "\(id.displayName) needs distinct light and dark palettes")
      }
    }
  }

  func testThemeCatalogContainsRequestedAndPopularThemes() {
    XCTAssertTrue(ScoutThemeID.allCases.contains(.rosePine))
    XCTAssertTrue(ScoutThemeID.allCases.contains(.catppuccin))
    XCTAssertTrue(ScoutThemeID.allCases.contains(.nord))
    XCTAssertTrue(ScoutThemeID.allCases.contains(.dracula))
    XCTAssertTrue(ScoutThemeID.allCases.contains(.github))
    XCTAssertTrue(ScoutThemeID.allCases.contains(.solarized))
    XCTAssertTrue(ScoutThemeID.allCases.contains(.oneDark))
    XCTAssertTrue(ScoutThemeID.allCases.contains(.tokyoNight))
    XCTAssertTrue(ScoutThemeID.allCases.contains(.gruvbox))
    XCTAssertTrue(ScoutThemeID.allCases.contains(.monokai))
  }

  func testUnknownStoredThemeFallsBackToSystem() {
    let storedValue = "theme-added-by-a-future-version"
    let selected = ScoutThemeID(rawValue: storedValue) ?? .system

    XCTAssertEqual(selected, .system)
  }

  func testTextTokensMeetContrastRequirementsAcrossThemeSurfaces() {
    for id in ScoutThemeID.allCases where id != .system {
      let definition = ScoutThemeDefinition.named(id)
      for (appearance, palette) in [("light", definition.light), ("dark", definition.dark)] {
        for background in [palette.canvasNS, palette.elevatedNS, palette.chromeNS] {
          XCTAssertGreaterThanOrEqual(
            contrastRatio(palette.secondaryNS, against: background),
            4.5,
            "\(id.displayName) \(appearance) secondary text needs more contrast"
          )
          XCTAssertGreaterThanOrEqual(
            contrastRatio(palette.tertiaryNS, against: background),
            4.5,
            "\(id.displayName) \(appearance) tertiary text needs more contrast"
          )
        }
      }
    }
  }

  func testRepresentativePaletteColorsPreserveTheirRGBValues() {
    XCTAssertEqual(rgb(ScoutThemeDefinition.named(.rosePine).dark.canvasNS), [0x19, 0x17, 0x24])
    XCTAssertEqual(rgb(ScoutThemeDefinition.named(.catppuccin).dark.accentNS), [0xCB, 0xA6, 0xF7])
    XCTAssertEqual(rgb(ScoutThemeDefinition.named(.nord).light.canvasNS), [0xEC, 0xEF, 0xF4])
    XCTAssertEqual(rgb(ScoutThemeDefinition.named(.dracula).dark.canvasNS), [0x28, 0x2A, 0x36])
  }

  private func rgb(_ color: NSColor) -> [Int] {
    let color = color.usingColorSpace(.sRGB)!
    return [
      Int((color.redComponent * 255).rounded()),
      Int((color.greenComponent * 255).rounded()),
      Int((color.blueComponent * 255).rounded())
    ]
  }

  private func contrastRatio(_ foreground: NSColor, against background: NSColor) -> CGFloat {
    let foregroundLuminance = relativeLuminance(foreground)
    let backgroundLuminance = relativeLuminance(background)
    let lighter = max(foregroundLuminance, backgroundLuminance)
    let darker = min(foregroundLuminance, backgroundLuminance)
    return (lighter + 0.05) / (darker + 0.05)
  }

  private func relativeLuminance(_ color: NSColor) -> CGFloat {
    let color = color.usingColorSpace(.sRGB)!
    func linearize(_ component: CGFloat) -> CGFloat {
      component <= 0.03928 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
    }

    let red = linearize(color.redComponent)
    let green = linearize(color.greenComponent)
    let blue = linearize(color.blueComponent)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
}
