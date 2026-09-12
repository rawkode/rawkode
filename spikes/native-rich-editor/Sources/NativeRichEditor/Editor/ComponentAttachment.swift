import AppKit
import SwiftUI

final class ComponentAttachment: NSTextAttachment {
    static let contentType = "dev.rawkode.native-rich-editor.component"
    let component: Component
    weak var session: EditorSession?

    // AppKit may derive fileType from its file wrapper while constructing an
    // attributed attachment. This immutable component always has our own type.
    override var fileType: String? {
        get { Self.contentType }
        set { super.fileType = newValue }
    }

    override func viewProvider(for parentView: NSView?, location: any NSTextLocation, textContainer: NSTextContainer?) -> NSTextAttachmentViewProvider? {
        ComponentViewProvider(textAttachment: self, parentView: parentView,
                              textLayoutManager: textContainer?.textLayoutManager, location: location)
    }

    init(_ component: Component) {
        self.component = component
        super.init(data: try? JSONEncoder().encode(component), ofType: Self.contentType)
        fileType = Self.contentType
        allowsTextAttachmentView = true
    }

    required init?(coder: NSCoder) {
        guard let data = coder.decodeObject(of: NSData.self, forKey: "component") as Data?,
              let decoded = try? JSONDecoder().decode(Component.self, from: data) else { return nil }
        component = decoded
        super.init(coder: coder)
        fileType = Self.contentType
    }

    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        coder.encode(try? JSONEncoder().encode(component), forKey: "component")
    }

    static func register() {
        registerViewProviderClass(ComponentViewProvider.self, forFileType: contentType)
    }

    override func attachmentBounds(for attributes: [NSAttributedString.Key: Any], location: any NSTextLocation, textContainer: NSTextContainer?, proposedLineFragment: NSRect, position: NSPoint) -> NSRect {
        let width = max(240, min(780, (textContainer?.size.width ?? 720) - 12))
        let height: CGFloat
        switch component.kind {
        case .diagram, .mermaid: height = 260
        case .drawing: height = 300
        case .link: height = component.metadata?.hasPlayableVideo == true ? width * 9 / 16 + 64 : 118
        }
        return NSRect(x: 0, y: 0, width: width, height: height)
    }
}

final class ComponentViewProvider: NSTextAttachmentViewProvider {
    override func loadView() {
        guard let attachment = textAttachment as? ComponentAttachment else { return }
        let host = NSHostingView(rootView: InlineComponentView(component: attachment.component, edit: { [weak attachment] in
            Task { @MainActor in
                guard let attachment else { return }
                attachment.session?.edit(attachment.component)
            }
        }))
        host.sizingOptions = []
        view = host
    }
}
