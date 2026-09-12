import Foundation

/// Connection edges, not absence, cause a claim. Starting or waking establishes a baseline.
public struct AttachmentPolicy {
    public private(set) var generation = 0
    public private(set) var keyboardPresent: Bool?

    public init() {}

    public mutating func observe(keyboardPresent present: Bool) -> Int? {
        guard keyboardPresent != present else { return nil }
        let previous = keyboardPresent
        keyboardPresent = present
        generation += 1
        return previous == false && present ? generation : nil
    }

    public mutating func reset() {
        generation += 1
        keyboardPresent = nil
    }

    public func isCurrent(_ token: Int) -> Bool {
        generation == token && keyboardPresent == true
    }

    public static func permitsSwitch(enabled: Bool, localSlot: Int, targetSlot: Int,
                                     keyboardPresent: Bool, mousePresent: Bool) -> Bool {
        enabled && (1...3).contains(localSlot) && (1...3).contains(targetSlot)
            && localSlot != targetSlot && !keyboardPresent && mousePresent
    }
}
