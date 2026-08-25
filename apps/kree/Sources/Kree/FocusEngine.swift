import Cocoa
import ApplicationServices
import os.log

/// Thread-safe lifecycle token shared by event ingress, the coordinator, and
/// the focus mutation queue. A new input or lifecycle transition invalidates
/// older focus transactions before they can mutate window state.
final class FocusGeneration {
    private let lock = NSLock()
    private var value: UInt64 = 0
    private var active = false

    @discardableResult
    func activate() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        value &+= 1
        active = true
        return value
    }

    @discardableResult
    func invalidate() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        value &+= 1
        return value
    }

    func deactivate() {
        lock.lock()
        value &+= 1
        active = false
        lock.unlock()
    }

    func isCurrent(_ token: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return active && value == token
    }

    func isActive() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return active
    }
}

/// Reserves focus-attempt time at the mutation boundary, not after a later
/// asynchronous backend operation completes.
final class FocusAttemptGate {
    private let lock = NSLock()
    private var lastAttemptAt: TimeInterval?

    func remaining(after interval: TimeInterval, now: TimeInterval = CFAbsoluteTimeGetCurrent()) -> TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        guard let lastAttemptAt else { return 0 }
        return max(0, interval - (now - lastAttemptAt))
    }

    @discardableResult
    func reserve(after interval: TimeInterval, now: TimeInterval = CFAbsoluteTimeGetCurrent()) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        if let lastAttemptAt, now - lastAttemptAt < interval {
            return false
        }

        self.lastAttemptAt = now
        return true
    }
}

final class FocusEngine {
    private enum WorkerState {
        case stopped
        case waitingForTrust
        case monitoring
    }

    private struct MovementSample {
        let point: CGPoint
        let modifiers: NSEvent.ModifierFlags
        let physicalMovement: Bool
        let inputToken: UInt64
    }

    private let workerQueue = DispatchQueue(label: "com.rawkode.Kree.focus-worker")
    private let focusMutationQueue = DispatchQueue(label: "com.rawkode.Kree.focus-mutation")
    private let lifecycle = FocusGeneration()
    private let focusAttemptGate = FocusAttemptGate()
    private let hitTester = WindowHitTester()
    private let skyLightFocus = SkyLightFocus()
    private let configurationLock = NSLock()
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var permissionTimer: Timer?
    private var spaceChangeObserver: NSObjectProtocol?
    private var isRunning = false

    private let logger = Logger(subsystem: "com.rawkode.Kree", category: "FocusEngine")

    // All state below this line is owned by workerQueue. The event tap only
    // packages movement and lifecycle signals before enqueueing them here.
    private var workerState: WorkerState = .stopped
    private var lifecycleGeneration: UInt64 = 0
    private var candidateGeneration: UInt64 = 0
    private var focusDelay: TimeInterval = 0.0
    private var disableModifier: NSEvent.ModifierFlags?
    private var focusRaisePolicy: FocusRaisePolicy = .automatic
    private var lastProcessedAt = 0.0
    private var latestSample: MovementSample?
    private var trailingWorkItem: DispatchWorkItem?
    private var pendingCandidate: WindowTarget?
    private var pendingInputToken: UInt64 = 0
    private var dwellWorkItem: DispatchWorkItem?
    private var lastFocusedWindowID: CGWindowID = 0
    private var lastFocusedOwnerPID: pid_t = 0

    private let processMinInterval = 0.04
    private let focusCooldown = 0.25
    var onTrustChange: ((Bool) -> Void)?

    func setConfiguration(
        delay: TimeInterval,
        disableModifier: NSEvent.ModifierFlags?,
        raisePolicy: FocusRaisePolicy
    ) {
        lifecycle.invalidate()
        workerQueue.async { [weak self] in
            guard let self else { return }
            self.focusDelay = max(0, delay)
            self.configurationLock.lock()
            self.disableModifier = disableModifier
            self.configurationLock.unlock()
            self.focusRaisePolicy = raisePolicy
            self.invalidateLifecycle()
        }
    }

    func start() {
        stop()

        guard AXIsProcessTrusted() else {
            workerQueue.async { [weak self] in
                self?.workerState = .waitingForTrust
                self?.lifecycleGeneration &+= 1
            }
            onTrustChange?(false)
            logger.warning("Accessibility permissions not granted. Prompting user and waiting...")

            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            AXIsProcessTrustedWithOptions(options)

            permissionTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
                guard let self, AXIsProcessTrusted() else { return }
                self.logger.notice("Permissions granted! Starting engine.")
                self.permissionTimer?.invalidate()
                self.permissionTimer = nil
                self.onTrustChange?(true)
                self.start()
            }
            return
        }

        guard installEventTap() else {
            onTrustChange?(true)
            logger.error("Failed to create Event Tap")
            return
        }

        isRunning = true
        lifecycle.activate()
        onTrustChange?(true)
        logger.notice("Starting FocusEngine (Event Driven)")

        workerQueue.async { [weak self] in
            guard let self else { return }
            self.workerState = .monitoring
            self.lifecycleGeneration &+= 1
            self.resetCandidateState()
        }

        // Listen for space changes. The current pointer location is read in
        // Quartz coordinates so multiple-display arrangements do not need the
        // primary-screen height conversion previously used here.
        spaceChangeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleSpaceChange()
        }
    }

    func stop() {
        isRunning = false
        lifecycle.deactivate()

        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
            self.runLoopSource = nil
        }
        if let eventTap {
            CFMachPortInvalidate(eventTap)
            self.eventTap = nil
        }

        permissionTimer?.invalidate()
        permissionTimer = nil

        if let observer = spaceChangeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            spaceChangeObserver = nil
        }

        // Lifecycle invalidation above makes queued focus results no-ops. Keep the
        // main thread non-blocking while the coordinator drains its state.
        workerQueue.async {
            self.workerState = .stopped
            self.lifecycleGeneration &+= 1
            self.resetCandidateState()
        }
    }

    private func installEventTap() -> Bool {
        let eventTypes: [CGEventType] = [
            .mouseMoved,
            .flagsChanged,
            .leftMouseDown,
            .leftMouseUp,
            .rightMouseDown,
            .rightMouseUp,
            .otherMouseDown,
            .otherMouseUp
        ]
        let eventMask = eventTypes.reduce(into: CGEventMask(0)) { mask, type in
            mask |= CGEventMask(1 << type.rawValue)
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: eventMask,
            callback: eventTapCallback,
            userInfo: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        ) else {
            return false
        }

        eventTap = tap
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        if let runLoopSource {
            CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        }
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    private func recoverEventTap() {
        guard isRunning, AXIsProcessTrusted(), let eventTap else { return }

        // CGEvent.tapEnable is intentionally the only recovery operation. The
        // existing tap and run-loop source remain owned by the main thread, so
        // recovery cannot create duplicate taps or observers.
        CGEvent.tapEnable(tap: eventTap, enable: true)
        logger.notice("Requested recovery for disabled event tap")
    }

    // Called by the C callback. It performs no window or Accessibility work.
    fileprivate func handleMouseMoved(event: CGEvent) {
        let dx = event.getDoubleValueField(.mouseEventDeltaX)
        let dy = event.getDoubleValueField(.mouseEventDeltaY)
        guard dx != 0.0 || dy != 0.0 else {
            return
        }

        let inputToken = lifecycle.invalidate()
        let modifiers = NSEvent.ModifierFlags(rawValue: UInt(event.flags.rawValue))
        enqueue(MovementSample(
            point: event.location,
            modifiers: modifiers,
            physicalMovement: true,
            inputToken: inputToken
        ))
    }

    fileprivate func handleInputStateChanged() {
        lifecycle.invalidate()
        workerQueue.async { [weak self] in
            guard let self else { return }
            self.invalidateLifecycle()
        }
    }

    fileprivate func handleEventTapDisabled(type: CGEventType) {
        guard type == .tapDisabledByTimeout || type == .tapDisabledByUserInput else {
            return
        }

        lifecycle.invalidate()
        workerQueue.async { [weak self] in
            guard let self else { return }
            self.invalidateLifecycle()
            self.logger.warning("Event tap disabled; invalidated pending focus work")
        }

        // Re-enable asynchronously so the callback returns promptly to
        // WindowServer. Both timeout and user-input disablement use this path.
        DispatchQueue.main.async { [weak self] in
            self?.recoverEventTap()
        }
    }

    private func handleSpaceChange() {
        let spaceToken = lifecycle.invalidate()

        workerQueue.async { [weak self] in
            guard let self, self.workerState == .monitoring else { return }
            self.lastFocusedWindowID = 0
            self.lastFocusedOwnerPID = 0
            self.invalidateCandidate()
        }

        // Preserve Kree's settle delay while still invalidating the old
        // transaction immediately. The delayed sample is dropped if another
        // movement, configuration change, stop, or restart occurs first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self,
                self.isRunning,
                self.lifecycle.isCurrent(spaceToken),
                let point = CGEvent(source: nil)?.location
            else { return }

            self.enqueue(MovementSample(
                point: point,
                modifiers: NSEvent.modifierFlags,
                physicalMovement: false,
                inputToken: spaceToken
            ))
        }
    }

    private func enqueue(_ sample: MovementSample) {
        workerQueue.async { [weak self] in
            guard let self, self.workerState == .monitoring else { return }
            self.receive(sample)
        }
    }

    private func receive(_ sample: MovementSample) {
        guard workerState == .monitoring,
            lifecycle.isCurrent(sample.inputToken)
        else { return }

        // A modifier/button transition must cancel existing work immediately;
        // otherwise a throttled trailing callback could let an old dwell fire.
        if isSuppressed(sample.modifiers) || mouseButtonIsDown() {
            latestSample = nil
            trailingWorkItem?.cancel()
            trailingWorkItem = nil
            invalidateCandidate()
            return
        }

        if sample.physicalMovement {
            // Kree retains its documented stationary-dwell behavior. A real
            // movement always invalidates the prior dwell, even if its CG
            // hit-test is deferred to the trailing edge.
            invalidateCandidate()
        } else {
            trailingWorkItem?.cancel()
            trailingWorkItem = nil
            latestSample = nil
            lastProcessedAt = CFAbsoluteTimeGetCurrent()
            process(sample)
            return
        }

        let now = CFAbsoluteTimeGetCurrent()
        let elapsed = now - lastProcessedAt
        guard elapsed >= processMinInterval else {
            latestSample = sample
            guard trailingWorkItem == nil else { return }

            let expectedLifecycle = lifecycleGeneration
            let work = DispatchWorkItem { [weak self] in
                guard let self,
                    self.workerState == .monitoring,
                    self.lifecycleGeneration == expectedLifecycle,
                    self.lifecycle.isActive()
                else { return }

                self.trailingWorkItem = nil
                guard let latestSample = self.latestSample else { return }
                self.latestSample = nil
                self.lastProcessedAt = CFAbsoluteTimeGetCurrent()
                self.process(latestSample)
            }
            trailingWorkItem = work
            workerQueue.asyncAfter(deadline: .now() + (processMinInterval - elapsed), execute: work)
            return
        }

        trailingWorkItem?.cancel()
        trailingWorkItem = nil
        latestSample = nil
        lastProcessedAt = now
        process(sample)
    }

    private func process(_ sample: MovementSample) {
        guard workerState == .monitoring,
            lifecycle.isCurrent(sample.inputToken),
            !isSuppressed(sample.modifiers),
            !mouseButtonIsDown()
        else {
            invalidateCandidate()
            return
        }

        switch hitTester.hitTest(at: sample.point) {
        case .none, .blocked:
            invalidateCandidate()

        case .target(let target):
            if shouldIgnore(target: target) || isAlreadyFocused(target: target) {
                invalidateCandidate()
                return
            }

            invalidateCandidate()
            pendingCandidate = target
            pendingInputToken = sample.inputToken
            let expectedLifecycle = lifecycleGeneration
            let expectedCandidate = candidateGeneration
            let expectedInputToken = sample.inputToken

            if focusDelay <= 0 {
                confirmAndFocus(
                    target: target,
                    expectedLifecycle: expectedLifecycle,
                    expectedCandidate: expectedCandidate,
                    expectedInputToken: expectedInputToken
                )
                return
            }

            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.confirmAndFocus(
                    target: target,
                    expectedLifecycle: expectedLifecycle,
                    expectedCandidate: expectedCandidate,
                    expectedInputToken: expectedInputToken
                )
            }
            dwellWorkItem = work
            workerQueue.asyncAfter(deadline: .now() + focusDelay, execute: work)
        }
    }

    private func confirmAndFocus(
        target: WindowTarget,
        expectedLifecycle: UInt64,
        expectedCandidate: UInt64,
        expectedInputToken: UInt64
    ) {
        guard workerState == .monitoring,
            lifecycleGeneration == expectedLifecycle,
            candidateGeneration == expectedCandidate,
            pendingCandidate == target,
            pendingInputToken == expectedInputToken,
            lifecycle.isCurrent(expectedInputToken),
            !isSuppressed(currentModifierFlags()),
            !mouseButtonIsDown()
        else {
            return
        }

        // Re-hit-test at dwell completion. A window may have moved, closed,
        // changed Space, or become covered without producing another event.
        guard let point = CGEvent(source: nil)?.location,
            case .target(let currentTarget) = hitTester.hitTest(at: point),
            currentTarget == target,
            !shouldIgnore(target: currentTarget)
        else {
            invalidateCandidate()
            return
        }

        dwellWorkItem = nil
        pendingCandidate = nil
        pendingInputToken = 0
        dispatchFocus(target: currentTarget, expectedInputToken: expectedInputToken)
    }

    private func dispatchFocus(target: WindowTarget, expectedInputToken: UInt64) {
        guard workerState == .monitoring,
            lifecycle.isCurrent(expectedInputToken),
            !isSuppressed(currentModifierFlags()),
            !mouseButtonIsDown()
        else {
            return
        }

        // Resolve the policy on workerQueue and pass an immutable decision to
        // the serial mutation queue. Configuration changes invalidate the
        // lifecycle before a queued transaction can pass its final preflight.
        let raise = focusRaisePolicy.shouldRaise(for: target)
        focusMutationQueue.async { [weak self] in
            self?.resolveAndPrepareFocus(
                target: target,
                raise: raise,
                expectedInputToken: expectedInputToken
            )
        }
    }

    private func resolveAndPrepareFocus(
        target: WindowTarget,
        raise: Bool,
        expectedInputToken: UInt64
    ) {
        guard lifecycle.isCurrent(expectedInputToken) else { return }

        // Window IDs are recyclable. Validate the owner before reserving an
        // attempt; SkyLight repeats the exact (window ID, PID, bounds) check
        // immediately before its first mutation.
        guard isCurrentWindowTarget(target) else {
            logger.debug("Window target \(target.windowID) is no longer owned by PID \(target.ownerPID)")
            return
        }

        guard lifecycle.isCurrent(expectedInputToken),
            !isSuppressed(currentModifierFlags()),
            !mouseButtonIsDown()
        else { return }

        guard focusAttemptGate.reserve(after: focusCooldown) else {
            let remaining = focusAttemptGate.remaining(after: focusCooldown)
            workerQueue.async { [weak self] in
                self?.retryFocusAfterCooldown(
                    target: target,
                    expectedInputToken: expectedInputToken,
                    after: remaining
                )
            }
            return
        }

        guard lifecycle.isCurrent(expectedInputToken),
            !isSuppressed(currentModifierFlags()),
            !mouseButtonIsDown(),
            isCurrentWindowTarget(target)
        else { return }

        let outcome = skyLightFocus.activate(target: target, raise: raise)
        switch outcome {
        case .requestAccepted:
            recordFocusedWindow(target: target, expectedInputToken: expectedInputToken)
        case let .noMutation(reason):
            logger.debug("SkyLight did not mutate window \(target.windowID): \(String(describing: reason))")
        case let .setterFailed(status):
            logger.debug("SkyLight setter failed for window \(target.windowID): status \(status)")
        case let .recordFailures(first, second):
            logger.debug(
                "SkyLight records failed for window \(target.windowID): first \(String(describing: first)), second \(String(describing: second))"
            )
        }
    }

    private func recordFocusedWindow(target: WindowTarget, expectedInputToken: UInt64) {
        workerQueue.async { [weak self] in
            guard let self,
                self.workerState == .monitoring,
                self.lifecycle.isCurrent(expectedInputToken)
            else { return }
            self.lastFocusedWindowID = target.windowID
            self.lastFocusedOwnerPID = target.ownerPID
        }
    }

    private func retryFocusAfterCooldown(
        target: WindowTarget,
        expectedInputToken: UInt64,
        after delay: TimeInterval
    ) {
        guard workerState == .monitoring,
            lifecycle.isCurrent(expectedInputToken)
        else { return }

        workerQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self,
                self.workerState == .monitoring,
                self.lifecycle.isCurrent(expectedInputToken),
                let point = CGEvent(source: nil)?.location,
                case .target(let currentTarget) = self.hitTester.hitTest(at: point),
                currentTarget == target
            else { return }

            self.dispatchFocus(target: currentTarget, expectedInputToken: expectedInputToken)
        }
    }

    private func isCurrentWindowTarget(_ target: WindowTarget) -> Bool {
        let options: CGWindowListOption = [.optionIncludingWindow, .excludeDesktopElements]
        guard let windows = CGWindowListCopyWindowInfo(options, target.windowID) as? [[String: Any]],
            let info = windows.first,
            let windowID = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
            let ownerPID = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        else {
            return false
        }

        return CGWindowID(windowID) == target.windowID && pid_t(ownerPID) == target.ownerPID
    }

    private func shouldIgnore(target: WindowTarget) -> Bool {
        target.ownerName == "Dock"
            || target.ownerPID == ProcessInfo.processInfo.processIdentifier
    }

    private func isAlreadyFocused(target: WindowTarget) -> Bool {
        target.windowID == lastFocusedWindowID
            && target.ownerPID == lastFocusedOwnerPID
    }

    private func isSuppressed(_ modifiers: NSEvent.ModifierFlags) -> Bool {
        configurationLock.lock()
        let disableModifier = self.disableModifier
        configurationLock.unlock()
        guard let disableModifier else { return false }
        return modifiers.contains(disableModifier)
    }

    private func currentModifierFlags() -> NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: UInt(
            CGEventSource.flagsState(.combinedSessionState).rawValue
        ))
    }

    private func mouseButtonIsDown() -> Bool {
        CGEventSource.buttonState(.combinedSessionState, button: .left)
            || CGEventSource.buttonState(.combinedSessionState, button: .right)
            || CGEventSource.buttonState(.combinedSessionState, button: .center)
    }

    private func invalidateCandidate() {
        candidateGeneration &+= 1
        dwellWorkItem?.cancel()
        dwellWorkItem = nil
        pendingCandidate = nil
        pendingInputToken = 0
    }

    private func resetCandidateState() {
        lifecycleGeneration &+= 1
        candidateGeneration &+= 1
        latestSample = nil
        trailingWorkItem?.cancel()
        trailingWorkItem = nil
        dwellWorkItem?.cancel()
        dwellWorkItem = nil
        pendingCandidate = nil
        pendingInputToken = 0
        lastProcessedAt = 0
        lastFocusedWindowID = 0
        lastFocusedOwnerPID = 0
    }

    private func invalidateLifecycle() {
        lifecycleGeneration &+= 1
        latestSample = nil
        trailingWorkItem?.cancel()
        trailingWorkItem = nil
        invalidateCandidate()
    }
}

// C-function callback for the listen-only event tap. Returning the event keeps
// the tap transparent to the rest of the system.
func eventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let refcon else {
        return Unmanaged.passUnretained(event)
    }

    let engine = Unmanaged<FocusEngine>.fromOpaque(refcon).takeUnretainedValue()
    switch type {
    case .mouseMoved:
        engine.handleMouseMoved(event: event)
    case .flagsChanged,
        .leftMouseDown,
        .leftMouseUp,
        .rightMouseDown,
        .rightMouseUp,
        .otherMouseDown,
        .otherMouseUp:
        engine.handleInputStateChanged()
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        engine.handleEventTapDisabled(type: type)
    default:
        break
    }

    return Unmanaged.passUnretained(event)
}
