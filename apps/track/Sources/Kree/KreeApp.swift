import SwiftUI
import Cocoa
import Combine
import os.log

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var appState = AppState()
    var settingsWindow: NSWindow?
    private var cancellables = Set<AnyCancellable>()
    private let logger = Logger(subsystem: "com.rawkode.Kree", category: "AppDelegate")
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        logger.notice("Application did finish launching")
        
        // Create Status Item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        
        guard let button = statusItem.button else {
            logger.error("Failed to get status item button")
            return
        }
        
        button.action = #selector(statusBarClicked(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        
        // Initial Image Load
        updateIcon(enabled: appState.isEnabled, trusted: appState.isTrusted)
        
        // Bind Icon Updates
        appState.$isEnabled
            .combineLatest(appState.$isTrusted)
            .receive(on: RunLoop.main)
            .sink { [weak self] (enabled, trusted) in
                self?.updateIcon(enabled: enabled, trusted: trusted)
            }
            .store(in: &cancellables)
    }
    
    func updateIcon(enabled: Bool, trusted: Bool) {
        guard let button = statusItem.button else { return }
        
        if !trusted {
            button.image = KreeIcons.warningIcon()
            button.image?.accessibilityDescription = "Permissions Needed"
        } else {
            button.image = KreeIcons.statusIcon(active: enabled)
            button.image?.accessibilityDescription = "Kree"
        }
    }
    
    @objc func statusBarClicked(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent!
        
        if event.type == .rightMouseUp || (event.type == .leftMouseUp && event.modifierFlags.contains(.control)) {
            showMenu()
        } else {
            // Left Click
            if !appState.isTrusted {
                showMenu()
            } else {
                appState.isEnabled.toggle()
            }
        }
    }
    
    func showMenu() {
        let menu = NSMenu()
        
        if !appState.isTrusted {
            let item = NSMenuItem(title: "⚠️ Permissions Needed", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            menu.addItem(NSMenuItem.separator())
        }
        
        let toggleTitle = appState.isEnabled ? "Disable Kree" : "Enable Kree"
        let toggleItem = NSMenuItem(title: toggleTitle, action: #selector(toggleEnable), keyEquivalent: "")
        toggleItem.target = self
        if !appState.isTrusted { toggleItem.isEnabled = false }
        menu.addItem(toggleItem)
        
        menu.addItem(NSMenuItem.separator())
        
        let settingsItem = NSMenuItem(title: "Settings...", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)
        
        menu.addItem(NSMenuItem.separator())
        
        let quitItem = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }
    
    @objc func toggleEnable() {
        appState.isEnabled.toggle()
    }
    
    @objc func openSettings() {
        if settingsWindow == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
                styleMask: [.titled, .closable, .miniaturizable],
                backing: .buffered, defer: false
            )
            window.center()
            window.title = "Kree Settings"
            window.contentView = NSHostingView(rootView: SettingsView(appState: appState))
            window.isReleasedWhenClosed = false
            settingsWindow = window
        }
        
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    
    @objc func quit() {
        NSApplication.shared.terminate(nil)
    }
}