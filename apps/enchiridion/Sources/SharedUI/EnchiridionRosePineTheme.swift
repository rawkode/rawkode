import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// Cross-platform semantic Rosé Pine colors for shared SwiftUI screens.
///
/// These preserve contrast in the current system appearance; they are not a
/// replacement for the iOS-specific palette used by the Today workspace.
enum EnchiridionRosePine {
  static let base = adaptive(light: (250, 244, 237), dark: (25, 23, 36))
  static let surface = adaptive(light: (255, 250, 247), dark: (31, 29, 46))
  static let overlay = adaptive(light: (242, 233, 222), dark: (57, 53, 82))
  static let text = adaptive(light: (87, 82, 121), dark: (224, 222, 244))
  static let secondary = adaptive(light: (121, 117, 147), dark: (144, 140, 170))

  static let rose = adaptive(light: (180, 99, 122), dark: (235, 188, 186))
  static let iris = adaptive(light: (144, 122, 169), dark: (196, 167, 231))
  static let pine = adaptive(light: (40, 105, 102), dark: (49, 116, 143))
  static let foam = adaptive(light: (86, 148, 159), dark: (156, 207, 216))
  static let gold = adaptive(light: (180, 125, 55), dark: (246, 193, 119))

  private static func adaptive(
    light: (Double, Double, Double),
    dark: (Double, Double, Double)
  ) -> Color {
    #if os(iOS)
      Color(
        uiColor: UIColor { traits in
          let value = traits.userInterfaceStyle == .dark ? dark : light
          return UIColor(red: value.0 / 255, green: value.1 / 255, blue: value.2 / 255, alpha: 1)
        })
    #elseif os(macOS)
      Color(
        nsColor: NSColor(name: nil) { appearance in
          let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
          return NSColor(calibratedRed: value.0 / 255, green: value.1 / 255, blue: value.2 / 255, alpha: 1)
        })
    #else
      Color(red: light.0 / 255, green: light.1 / 255, blue: light.2 / 255)
    #endif
  }
}
