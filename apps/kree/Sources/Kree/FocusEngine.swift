import Cocoa
import ApplicationServices
import os.log

class FocusEngine {
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var permissionTimer: Timer?
    private var focusWorkItem: DispatchWorkItem?
    private var spaceChangeObserver: NSObjectProtocol?
    
    private let systemWideElement = AXUIElementCreateSystemWide()
    private var lastFocusedWindowID: CGWindowID = 0
    private let logger = Logger(subsystem: "com.rawkode.Kree", category: "FocusEngine")
    
    // Config
    private var focusDelay: TimeInterval = 0.0
    private var disableModifier: NSEvent.ModifierFlags?

    // State
    private var pendingWindowID: CGWindowID = 0
    
    var onTrustChange: ((Bool) -> Void)?
    
    func setConfiguration(delay: TimeInterval, disableModifier: NSEvent.ModifierFlags?) {
        self.focusDelay = delay
        self.disableModifier = disableModifier
    }
    
    func start() {
        stop()
        
        if !AXIsProcessTrusted() {
            onTrustChange?(false)
            logger.warning("Accessibility permissions not granted. Prompting user and waiting...")
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            AXIsProcessTrustedWithOptions(options)
            
            permissionTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
                if AXIsProcessTrusted() {
                    self?.logger.notice("Permissions granted! Starting engine.")
                    self?.onTrustChange?(true)
                    self?.permissionTimer?.invalidate()
                    self?.permissionTimer = nil
                    self?.start()
                }
            }
            return
        }
        
        onTrustChange?(true)
        logger.notice("Starting FocusEngine (Event Driven)")
        
        // Create Event Tap
        let eventMask = (1 << CGEventType.mouseMoved.rawValue)
        guard let tap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(eventMask),
            callback: eventTapCallback,
            userInfo: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        ) else {
            logger.error("Failed to create Event Tap")
            return
        }
        
        self.eventTap = tap
        self.runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        // Listen for space changes
        spaceChangeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleSpaceChange()
        }
    }
    
    func stop() {
        if let runLoopSource = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
            self.runLoopSource = nil
        }
        if eventTap != nil {
            // CFMachPortInvalidate(eventTap) // Optional, usually releasing is enough
            self.eventTap = nil
        }
        
        permissionTimer?.invalidate()
        permissionTimer = nil

        if let observer = spaceChangeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            spaceChangeObserver = nil
        }

        cancelPendingFocus()
    }
    
    private func cancelPendingFocus() {
        focusWorkItem?.cancel()
        focusWorkItem = nil
        pendingWindowID = 0
    }

    private func handleSpaceChange() {
        // Brief delay for space transition, then check focus
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            let mouseLocation = NSEvent.mouseLocation
            // Convert from bottom-left origin (NSEvent) to top-left origin (CGEvent/AX)
            if let screenHeight = NSScreen.main?.frame.height {
                let point = CGPoint(x: mouseLocation.x, y: screenHeight - mouseLocation.y)
                self?.checkFocus(at: point)
            }
        }
    }
    
    // Named method to be called from the C-function callback
    fileprivate func handleMouseMoved(event: CGEvent) {
        // Check Modifier
        if let modifier = disableModifier {
             if NSEvent.modifierFlags.contains(modifier) {
                 cancelPendingFocus()
                 return
             }
        }

        let point = event.location
        checkFocus(at: point)
    }
    
    private func checkFocus(at point: CGPoint) {
        // 1. Find element at mouse position
        var element: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(systemWideElement, Float(point.x), Float(point.y), &element)
        
        guard result == .success, let foundElement = element else {
            return
        }
        
        // 2. Walk up to find the Window
        guard let window = getWindow(from: foundElement) else {
            // Mouse moved over something that isn't a window (e.g. desktop), cancel pending
            if pendingWindowID != 0 { cancelPendingFocus() }
            return 
        }
        
        // 3. Get Window ID
        var windowID: CGWindowID = 0
        _ = _AXUIElementGetWindow(window, &windowID)
        
        // If already focused, ignore
        if windowID == lastFocusedWindowID {
            if pendingWindowID != 0 { cancelPendingFocus() }
            return
        }

        // Always cancel and reschedule timer when mouse moves over a non-focused window.
        // This ensures focus only fires when mouse has been stationary for the full delay.
        cancelPendingFocus()
        pendingWindowID = windowID
        
        // 4. Check Ignore List (Dock, etc.)
        if shouldIgnore(window: window) {
            pendingWindowID = 0
            return
        }
        
        // 5. Schedule Focus
        if focusDelay > 0 {
            let item = DispatchWorkItem { [weak self] in
                self?.performFocus(window: window, id: windowID)
            }
            focusWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + focusDelay, execute: item)
        } else {
            // Instant focus
            performFocus(window: window, id: windowID)
        }
    }
    
    private func performFocus(window: AXUIElement, id: CGWindowID) {
        // Final sanity check (modifier might have been pressed during delay)
        if let modifier = disableModifier, NSEvent.modifierFlags.contains(modifier) {
            return
        }
        
        var pid: pid_t = 0
        AXUIElementGetPid(window, &pid)
        
        guard let app = NSRunningApplication(processIdentifier: pid) else { return }
        
        // Don't focus self
        if app.processIdentifier == NSRunningApplication.current.processIdentifier { return }
        
        let error = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, true as CFTypeRef)
        if error == .success {
             app.activate(options: [])
            lastFocusedWindowID = id
            pendingWindowID = 0
            focusWorkItem = nil
        }
    }
    
    private func getWindow(from element: AXUIElement) -> AXUIElement? {
        var current = element
        var count = 0
        let maxDepth = 20
        
        while count < maxDepth {
            var roleRef: CFTypeRef?
            AXUIElementCopyAttributeValue(current, kAXRoleAttribute as CFString, &roleRef)
            
            if let role = roleRef as? String, role == kAXWindowRole as String {
                return current
            }
            
            var parentRef: CFTypeRef?
            let err = AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentRef)
            
            if err != .success || parentRef == nil {
                break
            }
            
            if CFGetTypeID(parentRef!) == AXUIElementGetTypeID() {
                current = (parentRef as! AXUIElement)
            } else {
                break
            }
            count += 1
        }
        
        return nil
    }
    
    private func shouldIgnore(window: AXUIElement) -> Bool {
        var pid: pid_t = 0
        AXUIElementGetPid(window, &pid)
        
        if let app = NSRunningApplication(processIdentifier: pid) {
            if app.bundleIdentifier == "com.apple.dock" { return true }
            if app.bundleIdentifier == "com.apple.finder" {
                 // Finder is usually okay
            }
        }
        return false
    }
}

// C-Function Callback for Event Tap
func eventTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout {
        // Re-enable? Or just ignore.
        // Ideally we should re-enable, but for now we let it be or the engine handle it.
        // To strictly handle it:
        // let engine = Unmanaged<FocusEngine>.fromOpaque(refcon!).takeUnretainedValue()
        // engine.restartTap()
        return Unmanaged.passUnretained(event)
    }
    
    if type == .mouseMoved {
        if let refcon = refcon {
            let engine = Unmanaged<FocusEngine>.fromOpaque(refcon).takeUnretainedValue()
            engine.handleMouseMoved(event: event)
        }
    }
    
    // We are .listenOnly, so returning the event is required to pass it through? 
    // Actually for listenOnly the return value is ignored by the system, but we must return the event.
    return Unmanaged.passUnretained(event)
}

// Private API
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError