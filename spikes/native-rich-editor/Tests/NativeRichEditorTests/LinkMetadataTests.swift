import Foundation
import XCTest
@testable import NativeRichEditor

final class LinkMetadataTests: XCTestCase {
    private let baseURL = URL(string: "https://unlisted-provider.example/posts/demo")!

    func testURLValidationAllowsWebURLsWithoutCredentials() {
        XCTAssertEqual(LinkMetadataResolver.validatedURL("  https://example.com/watch?v=123 \n")?.absoluteString,
                       "https://example.com/watch?v=123")
        XCTAssertNotNil(LinkMetadataResolver.validatedURL("http://example.com"))
        for invalid in ["javascript:alert(1)", "file:///private/tmp/video.mp4", "https://user:password@example.com", "ftp://example.com", "not a link"] {
            XCTAssertNil(LinkMetadataResolver.validatedURL(invalid), invalid)
        }
    }

    func testOpenGraphParsesEntitiesCaseAndRelativeImageURL() {
        let html = """
        <META content='A &amp; B &#x1F600;' PROPERTY="og:title">
        <meta name="description" content="Text with &quot;quotes&quot;">
        <meta property="og:image" content="/images/demo.jpg">
        """
        let parsed = LinkMetadataResolver.parseHTML(html, baseURL: baseURL)
        XCTAssertEqual(parsed.metadata.title, "A & B 😀")
        XCTAssertEqual(parsed.metadata.summary, "Text with \"quotes\"")
        XCTAssertEqual(parsed.metadata.imageURL?.absoluteString, "https://unlisted-provider.example/images/demo.jpg")
        XCTAssertFalse(parsed.metadata.hasPlayableVideo)
    }

    func testAdvertisedJSONOEmbedEndpointIsDiscoveredWithoutProviderRegistry() {
        let html = """
        <link href="/discover?post=demo&amp;format=json" type='application/json+oembed' rel='alternate'>
        """
        let parsed = LinkMetadataResolver.parseHTML(html, baseURL: baseURL)
        XCTAssertEqual(parsed.oEmbedURL?.absoluteString, "https://unlisted-provider.example/discover?post=demo&format=json")
    }

    func testOpenGraphVideoMIMEChoosesNativePlayback() {
        let html = """
        <meta property="og:video:type" content="video/mp4">
        <meta property="og:video" content="https://cdn.example/demo.mp4">
        """
        let parsed = LinkMetadataResolver.parseHTML(html, baseURL: baseURL)
        XCTAssertEqual(parsed.metadata.playback, .directVideo(URL(string: "https://cdn.example/demo.mp4")!))
        XCTAssertTrue(parsed.metadata.hasPlayableVideo)
    }

    func testOpenGraphHTMLVideoChoosesEmbeddedPlayback() {
        let html = """
        <meta property="og:video:type" content="text/html">
        <meta property="og:video:secure_url" content="https://player.example/123">
        """
        let parsed = LinkMetadataResolver.parseHTML(html, baseURL: baseURL)
        XCTAssertEqual(parsed.metadata.playback, .embedURL(URL(string: "https://player.example/123")!))
    }

    func testOEmbedExtractsAdvertisedIframeAndPreservesCardSummary() throws {
        let oEmbed = """
        {"type":"video","title":"Discovered player","html":"<iframe src='https://player.other-provider.example/123?mode=inline&amp;autoplay=0'></iframe>"}
        """
        let metadata = try LinkMetadataResolver.mergeOEmbed(Data(oEmbed.utf8),
                                                           into: LinkMetadata(title: "Original", summary: "Keep this description"),
                                                           baseURL: baseURL)
        XCTAssertEqual(metadata.title, "Discovered player")
        XCTAssertEqual(metadata.summary, "Keep this description")
        XCTAssertEqual(metadata.playback, .embedURL(URL(string: "https://player.other-provider.example/123?mode=inline&autoplay=0")!))
    }

    func testOEmbedRejectsNonWebIframeURLAndKeepsFallbackCard() throws {
        for source in ["javascript:alert(1)", "file:///private/tmp/secret", "https://name:password@example.com/player"] {
            let data = try JSONSerialization.data(withJSONObject: ["type": "video", "html": "<iframe src='\(source)'></iframe>"])
            let metadata = try LinkMetadataResolver.mergeOEmbed(data, into: LinkMetadata(title: "Fallback"), baseURL: baseURL)
            XCTAssertEqual(metadata.title, "Fallback")
            XCTAssertNil(metadata.playback)
            XCTAssertNotNil(metadata.discoveryNote)
        }
    }

    func testPlainPageFallsBackToTitleWithoutInventingPlayer() {
        let parsed = LinkMetadataResolver.parseHTML("<title>A plain page</title>", baseURL: baseURL)
        XCTAssertEqual(parsed.metadata.title, "A plain page")
        XCTAssertFalse(parsed.metadata.hasPlayableVideo)
        XCTAssertNil(parsed.oEmbedURL)
    }

    func testMetadataRoundTripPreservesBothPlaybackKinds() throws {
        for playback in [LinkMetadata.Playback.embedURL(URL(string: "https://player.example/123")!),
                         .directVideo(URL(string: "https://cdn.example/demo.mp4")!)] {
            let original = LinkMetadata(title: "Film", summary: "Description", imageURL: URL(string: "https://cdn.example/poster.jpg"),
                                        playback: playback, discoveryNote: "Note")
            let restored = try JSONDecoder().decode(LinkMetadata.self, from: JSONEncoder().encode(original))
            XCTAssertEqual(restored, original)
        }
    }
}
