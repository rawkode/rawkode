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

  // Today uses one system-coherent canvas. Calendar selection is a deeper rose
  // so it belongs to Enchiridion rather than borrowing the system-blue calendar
  // treatment. It remains dark enough for white selected-day text in either
  // appearance.
  static let calendarBackground = Color(uiColor: .systemBackground)
  static let calendarAccent = Color(
    uiColor: UIColor(red: 177 / 255, green: 67 / 255, blue: 106 / 255, alpha: 1))
  static let calendarSurface = calendarBackground
  static let calendarControlSurface = Color(uiColor: .secondarySystemBackground)
}
