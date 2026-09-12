import Foundation
import IOKit.hid

public struct DeviceSnapshot: Equatable, Sendable {
    public let keyboardPresent: Bool
    public let mousePresent: Bool

    public init(keyboardPresent: Bool, mousePresent: Bool) {
        self.keyboardPresent = keyboardPresent
        self.mousePresent = mousePresent
    }
}

enum Devices {
    static let keyboardVendor = 0x36b0
    static let keyboardProduct = 0x3004
    static let mouseVendor = 0x046d
    static let mouseProduct = 0xb042

    // Enumeration requires neither opening a device nor capturing keyboard reports.
    static func matching(vendor: Int, product: Int) -> [IOHIDDevice] {
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatching(manager, [kIOHIDVendorIDKey: vendor, kIOHIDProductIDKey: product] as CFDictionary)
        guard let devices = IOHIDManagerCopyDevices(manager) else { return [] }
        return (devices as NSSet).allObjects.map { $0 as! IOHIDDevice }
    }
}

@MainActor
public final class DeviceMonitor {
    public var onChange: ((DeviceSnapshot) -> Void)?
    private var timer: Timer?
    private var previous: DeviceSnapshot?

    public init() {}

    public func start() {
        guard timer == nil else { return }
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.poll() }
        }
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
        previous = nil
    }

    public func snapshot() -> DeviceSnapshot {
        DeviceSnapshot(
            keyboardPresent: !Devices.matching(vendor: Devices.keyboardVendor, product: Devices.keyboardProduct).isEmpty,
            mousePresent: !Devices.matching(vendor: Devices.mouseVendor, product: Devices.mouseProduct).isEmpty
        )
    }

    private func poll() {
        let value = snapshot()
        guard value != previous else { return }
        previous = value
        onChange?(value)
    }

    deinit { timer?.invalidate() }
}
