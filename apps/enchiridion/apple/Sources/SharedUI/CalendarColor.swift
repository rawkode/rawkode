import SwiftUI

/// Calendar identity is an accent; text always uses the palette's readable ink.
func calendarAccent(_ hex: String?, fallback: Color) -> Color {
    guard let hex, hex.count == 7, hex.first == "#",
          let value = UInt32(hex.dropFirst(), radix: 16) else { return fallback }
    return Color(hex: value)
}
