import AppKit
import SwiftUI

@main
struct NativeRichEditorApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var session = EditorSession()

    var body: some Scene {
        Window("Fieldnotes", id: "editor") {
            ContentView(session: session)
        }
        .defaultSize(width: 900, height: 820)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Open…", action: session.open).keyboardShortcut("o")
                Button("Save As…", action: session.saveAs).keyboardShortcut("s", modifiers: [.command, .shift])
            }
            CommandMenu("Format") {
                Button("Bold") { session.toggleFont(.boldFontMask) }.keyboardShortcut("b")
                Button("Italic") { session.toggleFont(.italicFontMask) }.keyboardShortcut("i")
                Button("Underline") { session.toggleDecoration(.underlineStyle) }.keyboardShortcut("u")
                Button("Strikethrough") { session.toggleDecoration(.strikethroughStyle) }.keyboardShortcut("x", modifiers: [.command, .shift])
                Divider()
                Button("Heading 1") { session.applyTextStyle(.heading1) }.keyboardShortcut("1", modifiers: [.command, .option])
                Button("Heading 2") { session.applyTextStyle(.heading2) }.keyboardShortcut("2", modifiers: [.command, .option])
                Button("Heading 3") { session.applyTextStyle(.heading3) }.keyboardShortcut("3", modifiers: [.command, .option])
                Button("Body") { session.setParagraphStyle(heading: false) }.keyboardShortcut("0", modifiers: [.command, .option])
                Divider()
                Button("Bulleted list") { if let text = session.textView { ListEditing.apply(.bullet, in: text) } }.keyboardShortcut("8", modifiers: [.command, .shift])
                Button("Numbered list") { if let text = session.textView { ListEditing.apply(.numbered, in: text) } }.keyboardShortcut("7", modifiers: [.command, .shift])
                Button("To-do list") { if let text = session.textView { ListEditing.apply(.task, in: text) } }.keyboardShortcut("9", modifiers: [.command, .shift])
            }
            CommandMenu("Insert") {
                Button("D2 Diagram") { session.insert(.diagram) }.keyboardShortcut("d", modifiers: [.command, .shift])
                Button("Mermaid Diagram") { session.insert(.mermaid) }
                Button("Code Block") { session.insertCodeBlock() }
                Button("Drawing") { session.insert(.drawing) }.keyboardShortcut("k", modifiers: [.command, .shift])
                Button("Link") { session.insert(.link) }.keyboardShortcut("k")
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
