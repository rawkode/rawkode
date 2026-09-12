import AppKit
import AVKit
import CoreVideo
import XCTest

/// Opt-in network evidence; the ordinary suite never contacts a media service.
final class RemotePlaybackSmokeTests: XCTestCase {
    @MainActor
    func testRemoteHLSProducesDecodedFramesAndAdvancingPlayback() async throws {
        guard ProcessInfo.processInfo.environment["RUN_MEDIA_SMOKE"] == "1" else {
            throw XCTSkip("Set RUN_MEDIA_SMOKE=1 to run the bounded remote HLS playback check.")
        }
        _ = NSApplication.shared
        let url = URL(string: "https://content.rawkode.academy/videos/elpqrlouhe220jyf5tqr65vm/stream.m3u8")!
        let item = AVPlayerItem(url: url)
        item.preferredForwardBufferDuration = 1
        let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ])
        item.add(output)
        let player = AVPlayer(playerItem: item)
        player.isMuted = true
        let view = AVPlayerView(frame: NSRect(x: 0, y: 0, width: 600, height: 360))
        view.player = player
        defer {
            player.pause()
            view.player = nil
            item.remove(output)
            player.replaceCurrentItem(with: nil)
            item.asset.cancelLoading()
        }

        let deadline = Date().addingTimeInterval(25)
        var decodedFrames = 0
        var firstFrameTime: Double?
        var lastFrameTime = 0.0
        var dimensions = (width: 0, height: 0)
        var playbackStarted = false
        while Date() < deadline {
            if item.status == .failed {
                XCTFail("Remote HLS failed: \(item.error?.localizedDescription ?? "unknown player error")")
                return
            }
            if item.status == .readyToPlay, !playbackStarted {
                playbackStarted = true
                player.play()
            }
            let time = player.currentTime()
            if output.hasNewPixelBuffer(forItemTime: time),
               let frame = output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil) {
                decodedFrames += 1
                dimensions = (CVPixelBufferGetWidth(frame), CVPixelBufferGetHeight(frame))
                if firstFrameTime == nil { firstFrameTime = time.seconds }
                lastFrameTime = time.seconds
                if let firstFrameTime, decodedFrames >= 2, lastFrameTime - firstFrameTime >= 0.25 {
                    XCTAssertEqual(item.status, .readyToPlay)
                    XCTAssertGreaterThan(dimensions.width, 0)
                    XCTAssertGreaterThan(dimensions.height, 0)
                    print("MEDIA SMOKE: decoded \(decodedFrames) frames at \(dimensions.width)x\(dimensions.height); playback advanced from \(firstFrameTime)s to \(lastFrameTime)s.")
                    return
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("No advancing decoded video within 25 seconds. status=\(item.status.rawValue), frames=\(decodedFrames), currentTime=\(player.currentTime().seconds), rate=\(player.rate), timeControl=\(player.timeControlStatus.rawValue)")
    }
}
