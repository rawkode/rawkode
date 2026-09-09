import AppKit
import SwiftUI
import XCTest
@testable import NativeRichEditor

final class EditorIntegrationTests: XCTestCase {
    @MainActor
    func testAttachmentPreservesProviderConfigurationThroughDocumentPersistence() throws {
        _ = NSApplication.shared
        ComponentAttachment.register()
        let component = Component(kind: .drawing, title: "Provider test", drawing: .sample)
        let original = ComponentAttachment(component)
        let encoded = try JSONEncoder().encode(NoteDocument(attributedString: NSAttributedString(attachment: original)))
        let decoded = try JSONDecoder().decode(NoteDocument.self, from: encoded).attributedString()
        let restored = try XCTUnwrap(decoded.attribute(.attachment, at: 0, effectiveRange: nil) as? ComponentAttachment)

        for attachment in [original, restored] {
            XCTAssertEqual(attachment.fileType, ComponentAttachment.contentType)
            let data = try XCTUnwrap(attachment.contents, "Provider eligibility needs attachment contents")
            XCTAssertEqual(try JSONDecoder().decode(Component.self, from: data), component)
            XCTAssertTrue(attachment.allowsTextAttachmentView)
            XCTAssertTrue(attachment.usesTextAttachmentView, "Registered content must select the view-provider path")

            let text = DocumentTextView(usingTextLayoutManager: true)
            text.frame = NSRect(x: 0, y: 0, width: 700, height: 500)
            text.textStorage?.setAttributedString(NSAttributedString(attachment: attachment))
            let manager = try XCTUnwrap(text.textLayoutManager)
            let content = try XCTUnwrap(manager.textContentManager)
            let provider = try XCTUnwrap(attachment.viewProvider(for: text, location: content.documentRange.location,
                                                                textContainer: text.textContainer))
            XCTAssertTrue(provider is ComponentViewProvider)
            XCTAssertNotNil(provider.view as? NSHostingView<InlineComponentView>, "Reading view must load the SwiftUI host")
        }
    }

    @MainActor
    func testTextKitReservesDrawingAttachmentGeometry() throws {
        _ = NSApplication.shared
        ComponentAttachment.register()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 500),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 700, height: 500))
        window.contentView = scroll
        let text = DocumentTextView(usingTextLayoutManager: true)
        text.frame = NSRect(x: 0, y: 0, width: 700, height: 500)
        text.isRichText = true
        text.importsGraphics = true
        scroll.documentView = text
        let attachment = ComponentAttachment(Component(kind: .drawing, title: "Layout test", drawing: .sample))
        text.textStorage?.setAttributedString(NSAttributedString(attachment: attachment))
        let manager = try XCTUnwrap(text.textLayoutManager)
        let content = try XCTUnwrap(manager.textContentManager)
        manager.ensureLayout(for: content.documentRange)
        manager.textViewportLayoutController.layoutViewport()
        text.layoutSubtreeIfNeeded()
        var attachmentFrames: [NSRect] = []
        manager.enumerateTextLayoutFragments(from: content.documentRange.location, options: [.ensuresLayout]) { fragment in
            attachmentFrames.append(fragment.frameForTextAttachment(at: content.documentRange.location))
            return true
        }
        // An unshown test window verifies layout geometry. Host installation and
        // interaction still require a visible-window smoke check.
        let frame = try XCTUnwrap(attachmentFrames.first)
        XCTAssertGreaterThan(frame.width, 100)
        XCTAssertEqual(frame.height, 300)
    }

    @MainActor
    func testFenceConversionCanActuallyUndoAndRedo() throws {
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 500),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let session = EditorSession(dataDirectory: directory)
        let text = DocumentTextView(usingTextLayoutManager: true)
        text.frame = NSRect(x: 0, y: 0, width: 700, height: 500)
        text.session = session
        text.delegate = session
        text.allowsUndo = true
        window.contentView = text
        window.makeFirstResponder(text)
        session.attach(text)
        let source = "before 👋\n```d2\na -> b\n```\nafter"
        text.textStorage?.setAttributedString(NSAttributedString(string: source, attributes: EditorSession.bodyAttributes))
        session.acceptNativeEdit()
        let undo = try XCTUnwrap(text.undoManager)
        undo.removeAllActions()
        undo.groupsByEvent = false
        undo.beginUndoGrouping()
        session.convertCompletedFences()
        undo.endUndoGrouping()
        let converted = text.string
        XCTAssertTrue(converted.contains("\u{fffc}"))
        XCTAssertFalse(converted.contains("```"))
        XCTAssertTrue(undo.canUndo)

        undo.undo()
        XCTAssertEqual(text.string, source, "Undo must restore authored fences and surrounding Unicode text")
        XCTAssertFalse(try XCTUnwrap(session.document).segments.contains { if case .component = $0 { return true }; return false })
        XCTAssertEqual(EditorSession(dataDirectory: directory).document, session.document, "Undo must update the saved note")
        XCTAssertTrue(undo.canRedo)
        undo.redo()
        XCTAssertEqual(text.string, converted)
        XCTAssertTrue(try XCTUnwrap(session.document).segments.contains { if case .component = $0 { return true }; return false })
        XCTAssertNotNil(text.textLayoutManager)
        XCTAssertEqual(EditorSession(dataDirectory: directory).document, session.document)
    }
}
