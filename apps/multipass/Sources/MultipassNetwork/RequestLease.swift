import Foundation

/// A brief permission window, revoked when its authenticated connection closes.
/// Network propagation cannot make this an atomic cross-Mac hardware operation.
public final class RequestLease: @unchecked Sendable {
    private let lock = NSLock()
    private var revoked = false
    private let deadline: UInt64

    init(durationNanoseconds: UInt64 = 1_000_000_000) {
        deadline = DispatchTime.now().uptimeNanoseconds &+ durationNanoseconds
    }

    public var isValid: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !revoked && DispatchTime.now().uptimeNanoseconds < deadline
    }

    func invalidate() {
        lock.lock()
        revoked = true
        lock.unlock()
    }
}
