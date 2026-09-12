import Foundation

enum HIDResponse: Equatable {
    case reply([UInt8])
    case error(UInt8)
}

struct HIDRequest {
    let device: UInt8
    let feature: UInt8
    let function: UInt8
    var functionAndSoftwareID: UInt8 { (function << 4) | 0x0d }

    func report(parameters: [UInt8] = []) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 20)
        bytes.replaceSubrange(0..<4, with: [0x11, device, feature, functionAndSoftwareID])
        for (index, value) in parameters.prefix(16).enumerated() { bytes[index + 4] = value }
        return bytes
    }

    func match(_ bytes: [UInt8]) -> HIDResponse? {
        guard bytes.count >= 7, bytes[0] == 0x10 || bytes[0] == 0x11,
              bytes[1] == device else { return nil }
        if bytes[2] == 0xff {
            guard bytes[3] == feature, bytes[4] == functionAndSoftwareID else { return nil }
            return .error(bytes[5])
        }
        guard bytes[2] == feature, bytes[3] == functionAndSoftwareID else { return nil }
        return .reply(Array(bytes.dropFirst(4)))
    }
}
