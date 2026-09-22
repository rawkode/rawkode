import SwiftUI

enum ApsidesTheme: String, CaseIterable, Identifiable {
    case dawn, dark
    var id: String { rawValue }
    var label: String { self == .dawn ? "Rosé Pine Dawn" : "Rosé Pine Dark" }
    var scheme: ColorScheme { self == .dawn ? .light : .dark }
    var canvas: Color { Color(hex: self == .dawn ? 0xfffaf3 : 0x1f1d2e) }
    var base: Color { Color(hex: self == .dawn ? 0xfaf4ed : 0x191724) }
    var ink: Color { Color(hex: self == .dawn ? 0x575279 : 0xe0def4) }
    var secondary: Color { Color(hex: self == .dawn ? 0x6f6886 : 0xaaa5bd) }
    var accent: Color { Color(hex: self == .dawn ? 0x286983 : 0x9ccfd8) }
}
extension Color {
    init(hex: UInt32) { self.init(.sRGB, red: Double(hex >> 16 & 255) / 255, green: Double(hex >> 8 & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1) }
}

/// Keep automated appearance tests separate from the user’s saved palette.
enum ApsidesPreferences {
    static var store: UserDefaults {
        ProcessInfo.processInfo.arguments.contains("--ui-testing")
            ? UserDefaults(suiteName: "dev.rawkode.apsides.ui-tests")! : .standard
    }
}
