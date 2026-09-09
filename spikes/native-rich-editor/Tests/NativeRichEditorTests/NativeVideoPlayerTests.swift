import AppKit
import AVKit
import SwiftUI
import XCTest
@testable import NativeRichEditor

final class NativeVideoPlayerTests: XCTestCase {
    @MainActor
    func testHostedPlayerConstructsAppKitViewAndDismantlesWhenRemoved() throws {
        _ = NSApplication.shared
        // Loopback deliberately needs no external media service. This verifies
        // view/player construction, not video decoding or network playback.
        let source = URL(string: "http://127.0.0.1:1/unused.mp4")!
        let host = NSHostingView(rootView: AnyView(NativeVideoPlayer(url: source, failure: .constant(nil))))
        host.frame = NSRect(x: 0, y: 0, width: 600, height: 360)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        pumpRunLoop { self.playerView(in: host) != nil }

        let view = try XCTUnwrap(playerView(in: host), "NativeVideoPlayer must construct AVPlayerView through SwiftUI hosting")
        let player = try XCTUnwrap(view.player, "The representable update must construct AVPlayer")
        let asset = try XCTUnwrap(player.currentItem?.asset as? AVURLAsset)
        XCTAssertEqual(asset.url, source)
        XCTAssertEqual(view.controlsStyle, .inline)
        XCTAssertTrue(view.showsFullScreenToggleButton)

        host.rootView = AnyView(EmptyView())
        host.layoutSubtreeIfNeeded()
        pumpRunLoop { view.player == nil }
        XCTAssertNil(view.player, "Removing the representable must release the view's player ownership")
        XCTAssertEqual(player.rate, 0, "Removing the player must pause media")
    }

    @MainActor
    func testDismantleInvalidatesObservationAndReleasesPlayer() {
        let view = AVPlayerView()
        let item = AVPlayerItem(asset: AVMutableComposition())
        let player = AVPlayer(playerItem: item)
        let coordinator = NativeVideoPlayer.Coordinator(failure: .constant(nil))
        coordinator.observation = item.observe(\.status, options: [.new]) { _, _ in }
        view.player = player
        player.play()

        NativeVideoPlayer.dismantleNSView(view, coordinator: coordinator)

        XCTAssertNil(coordinator.observation)
        XCTAssertNil(view.player)
        XCTAssertEqual(player.rate, 0)
    }

    @MainActor
    private func playerView(in root: NSView) -> AVPlayerView? {
        if let player = root as? AVPlayerView { return player }
        for child in root.subviews {
            if let player = playerView(in: child) { return player }
        }
        return nil
    }

    @MainActor
    private func pumpRunLoop(until condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(1)
        while !condition(), Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }
}

final class CodeAttachmentPersistenceTests: XCTestCase {
    @MainActor
    func testAttachmentInsideSharedCodeStyleSurvivesRoundTrip() throws {
        ComponentAttachment.register()
        let component = Component(kind: .diagram, title: "Inside code", source: "a -> b", svg: "<svg/>")
        let text = NSMutableAttributedString(string: "before ")
        text.append(NSAttributedString(attachment: ComponentAttachment(component)))
        text.append(NSAttributedString(string: " after"))
        text.addAttribute(.codeLanguage, value: "swift", range: NSRange(location: 0, length: text.length))

        let document = try NoteDocument(attributedString: text)
        let encoded = try JSONEncoder().encode(document)
        let restored = try JSONDecoder().decode(NoteDocument.self, from: encoded).attributedString()

        XCTAssertEqual(restored.string, text.string)
        let attachment = try XCTUnwrap(restored.attribute(.attachment, at: 7, effectiveRange: nil) as? ComponentAttachment)
        XCTAssertEqual(attachment.component, component)
        XCTAssertEqual(restored.attribute(.codeLanguage, at: 0, effectiveRange: nil) as? String, "swift")
        XCTAssertEqual(restored.attribute(.codeLanguage, at: restored.length - 1, effectiveRange: nil) as? String, "swift")
    }
}
