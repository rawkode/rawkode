import Foundation
import IOKit.hid

public enum MouseSwitchResult: Sendable {
    /// The source acknowledged the request or observed the mouse depart after a successful write.
    /// This does not confirm a connection to the destination computer.
    case switched
    case alreadyOnTarget
    case unavailable(String)
    case failed(String)
}

private final class ReportInbox {
    var request: HIDRequest?
    var response: HIDResponse?
}

private enum Exchange {
    case response(HIDResponse)
    case timedOut
    case writeFailed(IOReturn)
}

public final class MouseController: @unchecked Sendable {
    private let worker = DispatchQueue(label: "Multipass.mouse-control")
    public init() {}

    /// Automatic handoff only: the EVO80 must be absent immediately before the switch write.
    public func switchTo(slot: Int, shouldProceed: @escaping @Sendable () -> Bool = { true }) async -> MouseSwitchResult {
        guard (1...3).contains(slot) else { return .failed("Mouse slot must be between 1 and 3.") }
        return await withCheckedContinuation { continuation in
            worker.async { continuation.resume(returning: self.performSwitch(slot: slot, shouldProceed: shouldProceed)) }
        }
    }

    private func performSwitch(slot: Int, shouldProceed: @Sendable () -> Bool) -> MouseSwitchResult {
        guard shouldProceed() else { return .unavailable("Switch cancelled because device state changed.") }
        let devices = Devices.matching(vendor: Devices.mouseVendor, product: Devices.mouseProduct)
        guard !devices.isEmpty else { return .unavailable("MX Master 4 is not connected to this Mac.") }
        var lastFailure = "The connected mouse did not expose HID++ ChangeHost."
        for device in devices {
            let status = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
            guard status == kIOReturnSuccess else {
                if IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted {
                    lastFailure = "Mouse HID access was denied (\(Self.hex(status))). Enable Multipass in System Settings → Privacy & Security → Input Monitoring, then restart it."
                } else {
                    lastFailure = "Unable to open the mouse HID interface (\(Self.hex(status))); another app or device disconnection may be responsible."
                }
                continue
            }
            let inbox = ReportInbox()
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 256)
            let context = Unmanaged.passUnretained(inbox).toOpaque()
            let runLoop = CFRunLoopGetCurrent()!
            IOHIDDeviceRegisterInputReportCallback(device, buffer, 256, { context, result, _, _, _, report, length in
                guard result == kIOReturnSuccess, let context, length > 0, length <= 256 else { return }
                let inbox = Unmanaged<ReportInbox>.fromOpaque(context).takeUnretainedValue()
                guard inbox.response == nil, let request = inbox.request else { return }
                inbox.response = request.match(Array(UnsafeBufferPointer(start: report, count: length)))
            }, context)
            IOHIDDeviceScheduleWithRunLoop(device, runLoop, CFRunLoopMode.defaultMode.rawValue)
            defer {
                IOHIDDeviceUnscheduleFromRunLoop(device, runLoop, CFRunLoopMode.defaultMode.rawValue)
                IOHIDDeviceRegisterInputReportCallback(device, buffer, 256, nil, nil)
                IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
                buffer.deallocate()
                withExtendedLifetime(inbox) {}
            }
            let deviceIndex: UInt8 = 0xff
            let discovery = exchange(device, inbox, HIDRequest(device: deviceIndex, feature: 0, function: 0), parameters: [0x18, 0x14])
            guard case .response(.reply(let featureData)) = discovery, let feature = featureData.first, feature != 0 else {
                lastFailure = "ChangeHost discovery failed: \(describe(discovery))"
                continue
            }
            let hostInfo = exchange(device, inbox, HIDRequest(device: deviceIndex, feature: feature, function: 0))
            guard case .response(.reply(let hosts)) = hostInfo, hosts.count >= 2,
                  hosts[0] > 0, hosts[1] < hosts[0] else {
                lastFailure = "Unable to read valid mouse host information: \(describe(hostInfo))"
                continue
            }
            guard slot <= Int(hosts[0]) else { return .failed("Mouse reports only \(hosts[0]) supported slots.") }
            guard Int(hosts[1]) + 1 != slot else { return .alreadyOnTarget }
            guard Devices.matching(vendor: Devices.keyboardVendor, product: Devices.keyboardProduct).isEmpty,
                  shouldProceed() else { return .unavailable("Switch cancelled because device state changed.") }
            // Exactly one switch write. Never retry on timeout: the first request may have succeeded.
            let result = exchange(device, inbox, HIDRequest(device: deviceIndex, feature: feature, function: 1), parameters: [UInt8(slot - 1)])
            switch result {
            case .response(.reply): return .switched
            case .response(.error(let code)): return .failed("Mouse rejected the switch with HID++ error \(code).")
            case .writeFailed(let status): return .failed("Mouse switch write failed (\(Self.hex(status))).")
            case .timedOut:
                if Devices.matching(vendor: Devices.mouseVendor, product: Devices.mouseProduct).isEmpty { return .switched }
                return .failed("Switch request was written but not acknowledged; the mouse still appears connected. It was not retried.")
            }
        }
        return .unavailable(lastFailure)
    }

    private func exchange(_ device: IOHIDDevice, _ inbox: ReportInbox, _ request: HIDRequest, parameters: [UInt8] = []) -> Exchange {
        inbox.request = request
        inbox.response = nil
        defer { inbox.request = nil }
        let report = request.report(parameters: parameters)
        let status = report.withUnsafeBufferPointer {
            IOHIDDeviceSetReport(device, kIOHIDReportTypeOutput, CFIndex(0x11), $0.baseAddress!, $0.count)
        }
        guard status == kIOReturnSuccess else { return .writeFailed(status) }
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while inbox.response == nil, ProcessInfo.processInfo.systemUptime < deadline {
            CFRunLoopRunInMode(.defaultMode, 0.025, false)
        }
        return inbox.response.map(Exchange.response) ?? .timedOut
    }

    private func describe(_ result: Exchange) -> String {
        switch result {
        case .response(.reply): return "malformed or unsupported reply"
        case .response(.error(let code)): return "HID++ error \(code)"
        case .timedOut: return "response timed out"
        case .writeFailed(let status): return "HID write failed (\(Self.hex(status)))"
        }
    }

    private static func hex(_ status: IOReturn) -> String { String(format: "0x%08x", status) }
}
