import CoreGraphics
import Darwin
import Foundation

internal struct SkyLightProcessSerialNumber: Equatable {
    internal var high: UInt32
    internal var low: UInt32
    internal init(high: UInt32, low: UInt32) { self.high = high; self.low = low }
}

internal struct SkyLightWindowSnapshot: Equatable {
    internal let windowID: CGWindowID
    internal let ownerPID: pid_t
    internal let bounds: CGRect
}

internal enum SkyLightRecordKind: Equatable { case first, second }

internal enum SkyLightOperationError: Error, Equatable {
    case unavailable(String)
    case failed(step: String, status: Int32)
}

internal enum SkyLightNoMutationReason: Equatable {
    case unavailable(String)
    case staleTarget
    case resolutionFailed(String)
}

internal struct SkyLightRecordFailure: Equatable {
    internal let kind: SkyLightRecordKind
    internal let status: Int32
}

internal enum SkyLightFocusOutcome: Equatable {
    case noMutation(reason: SkyLightNoMutationReason)
    case setterFailed(status: Int32)
    case recordFailures(SkyLightRecordFailure?, SkyLightRecordFailure?)
    case requestAccepted
}

internal protocol SkyLightOperations: AnyObject {
    var missingSymbols: [String] { get }
    func windowSnapshot(for windowID: CGWindowID) -> Result<SkyLightWindowSnapshot, SkyLightOperationError>
    func processPSN(for pid: pid_t) -> Result<SkyLightProcessSerialNumber, SkyLightOperationError>
    func setFrontProcess(
        _ process: SkyLightProcessSerialNumber,
        windowID: CGWindowID,
        options: UInt32
    ) -> Result<Void, SkyLightOperationError>
    func postEventRecord(to process: SkyLightProcessSerialNumber, record: [UInt8]) -> Result<Void, SkyLightOperationError>
}

internal final class SkyLightFocus {
    private let operations: SkyLightOperations

    internal init(operations: SkyLightOperations? = nil) { self.operations = operations ?? DynamicSkyLightOperations() }
    internal var isAvailable: Bool { operations.missingSymbols.isEmpty }
    internal var missingSymbols: [String] { operations.missingSymbols }

    internal static func makeRecord(windowID: CGWindowID, kind: SkyLightRecordKind) -> [UInt8] {
        var record = [UInt8](repeating: 0, count: 248)
        record[0x04] = 0xf8
        record[0x3a] = 0x10
        record.replaceSubrange(0x20..<0x30, with: repeatElement(0xff, count: 16))
        let windowBytes = withUnsafeBytes(of: windowID.littleEndian) { Array($0) }
        record.replaceSubrange(0x3c..<0x40, with: windowBytes)
        record[0x08] = kind == .first ? 0x01 : 0x02
        return record
    }

    /// Accepts only the setter and the two ordered record posts. There is no
    /// AX/AppKit fallback and no postcondition or front-process verification.
    internal func activate(target: WindowTarget, raise: Bool) -> SkyLightFocusOutcome {
        guard isAvailable else {
            return .noMutation(reason: .unavailable(missingSymbols.joined(separator: ", ")))
        }

        let targetProcess: SkyLightProcessSerialNumber
        switch operations.processPSN(for: target.ownerPID) {
        case let .success(process): targetProcess = process
        case let .failure(error): return .noMutation(reason: .resolutionFailed(error.description))
        }

        // The last operation before mutation is an exact identity check.
        guard case let .success(snapshot) = operations.windowSnapshot(for: target.windowID),
              Self.matches(snapshot: snapshot, target: target)
        else { return .noMutation(reason: .staleTarget) }

        let options: UInt32 = raise ? 0x200 : 0x600
        switch operations.setFrontProcess(targetProcess, windowID: target.windowID, options: options) {
        case let .failure(error): return .setterFailed(status: error.statusCode)
        case .success: break
        }

        let records = [
            (SkyLightRecordKind.first, Self.makeRecord(windowID: target.windowID, kind: .first)),
            (SkyLightRecordKind.second, Self.makeRecord(windowID: target.windowID, kind: .second))
        ]
        var firstFailure: SkyLightRecordFailure?
        var secondFailure: SkyLightRecordFailure?
        // Once the setter succeeds, always attempt both posts in this order.
        for (kind, record) in records {
            if case let .failure(error) = operations.postEventRecord(to: targetProcess, record: record) {
                let failure = SkyLightRecordFailure(kind: kind, status: error.statusCode)
                switch kind {
                case .first: firstFailure = failure
                case .second: secondFailure = failure
                }
            }
        }
        return firstFailure == nil && secondFailure == nil
            ? .requestAccepted
            : .recordFailures(firstFailure, secondFailure)
    }

    private static func matches(snapshot: SkyLightWindowSnapshot, target: WindowTarget) -> Bool {
        snapshot.windowID == target.windowID && snapshot.ownerPID == target.ownerPID
            && snapshot.bounds == target.bounds
    }
}

private extension SkyLightOperationError {
    var description: String {
        switch self {
        case let .unavailable(reason): return reason
        case let .failed(step, status): return "\(step) (status \(status))"
        }
    }
    var statusCode: Int32 { if case let .failed(_, status) = self { return status }; return -1 }
}

private final class DynamicSkyLightOperations: SkyLightOperations {
    private typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Int32
    private typealias SetFrontProcessWithOptions = @convention(c) (UnsafeMutableRawPointer?, UInt32, UInt32) -> Int32
    private typealias PostEventRecordTo = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<UInt8>?) -> Int32
    private static let frameworkPath = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
    private static let applicationServicesPath = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    private let handle: UnsafeMutableRawPointer?
    private let applicationServicesHandle: UnsafeMutableRawPointer?
    private let processForPID: GetProcessForPID?
    private let setFront: SetFrontProcessWithOptions?
    private let setFrontSymbol: String?
    private let postRecord: PostEventRecordTo?

    internal init() {
        handle = dlopen(Self.frameworkPath, RTLD_LAZY | RTLD_LOCAL)
        applicationServicesHandle = dlopen(Self.applicationServicesPath, RTLD_LAZY | RTLD_LOCAL)
        processForPID = Self.load(GetProcessForPID.self, handle, "GetProcessForPID")
            ?? Self.load(GetProcessForPID.self, applicationServicesHandle, "GetProcessForPID")
        if let primary = Self.load(SetFrontProcessWithOptions.self, handle, "SLPSSetFrontProcessWithOptions") {
            setFront = primary; setFrontSymbol = "SLPSSetFrontProcessWithOptions"
        } else {
            setFront = Self.load(SetFrontProcessWithOptions.self, handle, "_SLPSSetFrontProcessWithOptions")
            setFrontSymbol = setFront == nil ? nil : "_SLPSSetFrontProcessWithOptions"
        }
        postRecord = Self.load(PostEventRecordTo.self, handle, "SLPSPostEventRecordTo")
    }

    deinit {
        if let handle { dlclose(handle) }
        if let applicationServicesHandle { dlclose(applicationServicesHandle) }
    }

    var missingSymbols: [String] {
        var missing: [String] = []
        if !Self.isSupportedOperatingSystem { missing.append("macOS 14+") }
        if handle == nil { missing.append("SkyLight.framework") }
        if processForPID == nil { missing.append("GetProcessForPID") }
        if postRecord == nil { missing.append("SLPSPostEventRecordTo") }
        if setFrontSymbol == nil { missing.append("SLPSSetFrontProcessWithOptions/_SLPSSetFrontProcessWithOptions") }
        return missing
    }

    private static var isSupportedOperatingSystem: Bool {
        if #available(macOS 14.0, *) { return true }
        return false
    }

    func windowSnapshot(for windowID: CGWindowID) -> Result<SkyLightWindowSnapshot, SkyLightOperationError> {
        let options: CGWindowListOption = [.optionIncludingWindow, .excludeDesktopElements]
        guard let windows = CGWindowListCopyWindowInfo(options, windowID) as? [[String: Any]],
              let info = windows.first,
              let returnedID = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let ownerPID = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary)
        else { return .failure(.unavailable("window snapshot")) }
        return .success(SkyLightWindowSnapshot(windowID: returnedID, ownerPID: pid_t(ownerPID), bounds: rect))
    }

    func processPSN(for pid: pid_t) -> Result<SkyLightProcessSerialNumber, SkyLightOperationError> {
        guard let processForPID else { return .failure(.unavailable("GetProcessForPID")) }
        var process = SkyLightProcessSerialNumber(high: 0, low: 0)
        let status = withUnsafeMutablePointer(to: &process) { processForPID(pid, UnsafeMutableRawPointer($0)) }
        return status == 0 ? .success(process) : .failure(.failed(step: "PID PSN", status: status))
    }

    func setFrontProcess(
        _ process: SkyLightProcessSerialNumber,
        windowID: CGWindowID,
        options: UInt32
    ) -> Result<Void, SkyLightOperationError> {
        guard let setFront else { return .failure(.unavailable("front process setter")) }
        var process = process
        let status = withUnsafeMutablePointer(to: &process) {
            setFront(UnsafeMutableRawPointer($0), windowID, options)
        }
        return status == 0 ? .success(()) : .failure(.failed(step: "set front process", status: status))
    }

    func postEventRecord(to process: SkyLightProcessSerialNumber, record: [UInt8]) -> Result<Void, SkyLightOperationError> {
        guard let postRecord else { return .failure(.unavailable("SLPSPostEventRecordTo")) }
        var process = process
        let status = record.withUnsafeBufferPointer { bytes in
            withUnsafeMutablePointer(to: &process) { postRecord(UnsafeMutableRawPointer($0), bytes.baseAddress) }
        }
        return status == 0 ? .success(()) : .failure(.failed(step: "post event record", status: status))
    }

    private static func load<T>(_ type: T.Type, _ handle: UnsafeMutableRawPointer?, _ name: String) -> T? {
        guard let handle, let symbol = dlsym(handle, name) else { return nil }
        return unsafeBitCast(symbol, to: T.self)
    }
}
