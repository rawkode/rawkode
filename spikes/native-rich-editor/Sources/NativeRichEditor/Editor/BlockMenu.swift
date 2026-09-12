import AppKit

/// Native keyboard-navigable block menu positioned at the text insertion point.
@MainActor
enum BlockMenu {
    static func show(in text: DocumentTextView, slashRange: NSRange? = nil) {
        let menu = NSMenu(title: "Insert block")
        let target = ActionTarget(text: text, slashRange: slashRange)
        func item(_ title: String, symbol: String, action: @escaping () -> Void) {
            let row = NSMenuItem(title: title, action: #selector(ActionTarget.choose(_:)), keyEquivalent: "")
            row.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
            row.target = target
            row.tag = target.actions.count
            target.actions.append(action)
            menu.addItem(row)
        }
        for style in TextBlockStyle.allCases {
            item(style.rawValue, symbol: style == .quote ? "text.quote" : "textformat") { text.session?.applyTextStyle(style) }
        }
        menu.addItem(.separator())
        item("Bulleted list", symbol: "list.bullet") { ListEditing.apply(.bullet, in: text) }
        item("Numbered list", symbol: "list.number") { ListEditing.apply(.numbered, in: text) }
        item("To-do list", symbol: "checklist") { ListEditing.apply(.task, in: text) }
        item("Code block", symbol: "chevron.left.forwardslash.chevron.right") { text.session?.insertCodeBlock() }
        menu.addItem(.separator())
        item("D2 diagram", symbol: "point.3.connected.trianglepath.dotted") { text.session?.insert(.diagram) }
        item("Mermaid diagram", symbol: "arrow.triangle.branch") { text.session?.insert(.mermaid) }
        item("Drawing", symbol: "pencil.tip.crop.circle") { text.session?.insert(.drawing) }
        item("Link or video", symbol: "link") { text.session?.insert(.link) }
        let screenRect = text.firstRect(forCharacterRange: text.selectedRange(), actualRange: nil)
        if let window = text.window {
            let windowRect = window.convertFromScreen(screenRect)
            let local = text.convert(windowRect, from: nil)
            menu.popUp(positioning: nil, at: NSPoint(x: local.minX, y: local.maxY + 4), in: text)
        }
        withExtendedLifetime(target) {}
    }

    @MainActor private final class ActionTarget: NSObject {
        weak var text: DocumentTextView?
        let slashRange: NSRange?
        var actions: [() -> Void] = []
        init(text: DocumentTextView, slashRange: NSRange?) { self.text = text; self.slashRange = slashRange }
        @objc func choose(_ sender: NSMenuItem) {
            guard let text, actions.indices.contains(sender.tag) else { return }
            if let slashRange, NSMaxRange(slashRange) <= text.string.utf16.count,
               (text.string as NSString).substring(with: slashRange) == "/" {
                text.session?.replace(slashRange, with: NSAttributedString(string: "", attributes: EditorSession.bodyAttributes), action: "Choose block")
            }
            actions[sender.tag]()
        }
    }
}
