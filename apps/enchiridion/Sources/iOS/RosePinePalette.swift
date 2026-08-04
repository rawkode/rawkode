import SwiftUI
import UIKit

/// Semantic Rosé Pine tokens that remain legible in both system appearances.
enum RosePinePalette {
  static let background = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 25 / 255, green: 23 / 255, blue: 36 / 255, alpha: 1)  // base
        : UIColor(red: 250 / 255, green: 244 / 255, blue: 237 / 255, alpha: 1)  // Dawn base
    })
  static let secondaryText = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 144 / 255, green: 140 / 255, blue: 170 / 255, alpha: 1)  // subtle
        : UIColor(red: 121 / 255, green: 117 / 255, blue: 147 / 255, alpha: 1)  // Dawn subtle
    })
  static let accent = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 196 / 255, green: 167 / 255, blue: 231 / 255, alpha: 1)  // iris
        : UIColor(red: 144 / 255, green: 122 / 255, blue: 169 / 255, alpha: 1)  // Dawn iris
    })

  // Today deliberately uses the Rosé Pine canvas rather than inheriting a
  // system surface. Calendar selection is a deeper rose so it belongs to
  // Enchiridion rather than borrowing the system-blue calendar treatment.
  static let calendarBackground = background
  static let calendarAccent = Color(
    uiColor: UIColor(red: 177 / 255, green: 67 / 255, blue: 106 / 255, alpha: 1))
  static let calendarSurface = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 31 / 255, green: 29 / 255, blue: 46 / 255, alpha: 1)
        : UIColor(red: 255 / 255, green: 250 / 255, blue: 247 / 255, alpha: 1)
    })
  static let calendarControlSurface = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 57 / 255, green: 53 / 255, blue: 82 / 255, alpha: 1)
        : UIColor(red: 242 / 255, green: 233 / 255, blue: 222 / 255, alpha: 1)
    })
}
