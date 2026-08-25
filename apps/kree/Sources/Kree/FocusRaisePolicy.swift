import Foundation

internal enum FocusRaisePolicy: String, CaseIterable, Identifiable {
    case automatic
    case always
    case never

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .automatic: return "Automatic"
        case .always: return "Always"
        case .never: return "Never"
        }
    }

    func shouldRaise(for target: WindowTarget) -> Bool {
        switch self {
        case .automatic: return !target.requiresNoRaise
        case .always: return true
        case .never: return false
        }
    }

    static func decode(_ rawValue: String?) -> Self {
        guard let rawValue, let policy = Self(rawValue: rawValue) else {
            return .automatic
        }
        return policy
    }
}
