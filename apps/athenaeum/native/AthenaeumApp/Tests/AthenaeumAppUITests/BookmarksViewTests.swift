import Foundation
import XCTest
@testable import AthenaeumRPC
@testable import AthenaeumAppUI

private struct BookmarkCaptureHTTPResponse {
    let statusCode: Int
    let body: Data
}

private final class BookmarkCaptureRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requestBodies: [Data] = []
    private var responses: [BookmarkCaptureHTTPResponse] = []

    func reset(responses: [BookmarkCaptureHTTPResponse]) {
        lock.lock()
        defer { lock.unlock() }
        requestBodies = []
        self.responses = responses
    }

    func record(_ body: Data) {
        lock.lock()
        defer { lock.unlock() }
        requestBodies.append(body)
    }

    func nextResponse() -> BookmarkCaptureHTTPResponse {
        lock.lock()
        defer { lock.unlock() }
        guard !responses.isEmpty else {
            return BookmarkCaptureHTTPResponse(statusCode: 500, body: Data("missing test response".utf8))
        }
        return responses.removeFirst()
    }

    func recordedBodies() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return requestBodies
    }
}

private final class BookmarkCaptureURLProtocol: URLProtocol {
    private static let recorder = BookmarkCaptureRequestRecorder()

    static func reset(responses: [BookmarkCaptureHTTPResponse]) {
        recorder.reset(responses: responses)
    }

    static func requestBodies() -> [Data] {
        recorder.recordedBodies()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.recorder.record(requestBody())
        let fixture = Self.recorder.nextResponse()
        let response = HTTPURLResponse(
            url: request.url!, statusCode: fixture.statusCode, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: fixture.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private func requestBody() -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            result.append(buffer, count: read)
        }
        return result
    }
}

@MainActor
final class BookmarksViewTests: XCTestCase {
    private let workspaceId = "f9ecd920-d30a-4314-9870-3cc80e2efb58"

    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
    }

    private func makeModel(
        pendingKey: String,
        responses: [BookmarkCaptureHTTPResponse]
    ) -> BookmarksViewModel {
        BookmarkCaptureURLProtocol.reset(responses: responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BookmarkCaptureURLProtocol.self]
        let client = WorkspaceRPCClient(
            baseURL: URL(string: "http://bookmark-capture.invalid")!,
            workspaceId: workspaceId,
            urlSession: URLSession(configuration: configuration)
        )
        return BookmarksViewModel(client: client, pendingKey: pendingKey)
    }

    private func bookmark() -> CapnWebValue {
        .object([
            "id": .string("bookmark-1"),
            "workspaceId": .string(workspaceId),
            "url": .string("https://example.com/plan"),
            "title": .string("Project plan"),
            "capturedAt": .string("2026-08-28T10:00:00.000Z"),
            "linkedNodeId": .null
        ])
    }

    private func resolved(_ value: CapnWebValue) throws -> BookmarkCaptureHTTPResponse {
        let line = try CapnWebValue.encodeMessageLine(["resolve", 1, value.toWireJSON()])
        return BookmarkCaptureHTTPResponse(statusCode: 200, body: Data(line.utf8))
    }

    private func requestMethod(from body: Data) throws -> String {
        let text = try XCTUnwrap(String(data: body, encoding: .utf8))
        let line = try XCTUnwrap(text.split(separator: "\n").first)
        let message = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [Any])
        let pipeline = try XCTUnwrap(message[1] as? [Any])
        return try XCTUnwrap((pipeline[2] as? [String])?.first)
    }

    private func bookmarkRequestID(from body: Data) throws -> String {
        let text = try XCTUnwrap(String(data: body, encoding: .utf8))
        let line = try XCTUnwrap(text.split(separator: "\n").first)
        let message = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [Any])
        let pipeline = try XCTUnwrap(message[1] as? [Any])
        XCTAssertEqual(try requestMethod(from: body), "createBookmark")
        let arguments = try XCTUnwrap(pipeline[3] as? [Any])
        let input = try XCTUnwrap(arguments.first as? [String: Any])
        return try XCTUnwrap(input["requestId"] as? String)
    }

    func testCaptureFailureMessageSuppressesPrivateTransportDetails() {
        let error = PrivateTransportError()
        let message = BookmarksViewModel.captureFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm that this bookmark was saved. Your URL and title are still here. " +
                "Review your bookmarks before taking another action."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testListFailureThenRefreshRetrySuppressesPrivateDetailsAndConfirmsEmptyState() async throws {
        let pendingKey = "athenaeum.test.pendingBookmark.\(UUID().uuidString)"
        UserDefaults.standard.removeObject(forKey: pendingKey)
        defer { UserDefaults.standard.removeObject(forKey: pendingKey) }

        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let model = makeModel(
            pendingKey: pendingKey,
            responses: [
                BookmarkCaptureHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8)),
                try resolved(.object(["bookmarks": .array([])]))
            ]
        )

        await model.refresh()

        XCTAssertEqual(
            model.loadErrorMessage,
            "Bookmarks couldn’t be loaded. Nothing has been changed. Refresh to check your bookmarks again."
        )
        XCTAssertFalse(model.loadErrorMessage?.contains(privateFailure) ?? true)
        XCTAssertTrue(model.bookmarks.isEmpty)
        XCTAssertFalse(model.hasLoadedBookmarks)
        XCTAssertFalse(model.isLoadingBookmarks)
        XCTAssertFalse(
            BookmarksViewModel.shouldShowEmptyBookmarks(
                isEmpty: model.bookmarks.isEmpty,
                hasLoadedBookmarks: model.hasLoadedBookmarks,
                isLoadingBookmarks: model.isLoadingBookmarks,
                loadErrorMessage: model.loadErrorMessage
            )
        )

        await model.refresh()

        XCTAssertNil(model.loadErrorMessage)
        XCTAssertTrue(model.hasLoadedBookmarks)
        XCTAssertFalse(model.isLoadingBookmarks)
        XCTAssertTrue(
            BookmarksViewModel.shouldShowEmptyBookmarks(
                isEmpty: model.bookmarks.isEmpty,
                hasLoadedBookmarks: model.hasLoadedBookmarks,
                isLoadingBookmarks: model.isLoadingBookmarks,
                loadErrorMessage: model.loadErrorMessage
            )
        )
        let requests = BookmarkCaptureURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(try requestMethod(from: requests[0]), "listBookmarks")
        XCTAssertEqual(try requestMethod(from: requests[1]), "listBookmarks")
    }

    func testEmptyPresentationWaitsForAConfirmedSuccessfulRead() {
        XCTAssertTrue(
            BookmarksViewModel.shouldShowBookmarksLoading(
                hasLoadedBookmarks: false,
                isLoadingBookmarks: false,
                loadErrorMessage: nil
            )
        )
        XCTAssertFalse(
            BookmarksViewModel.shouldShowEmptyBookmarks(
                isEmpty: true,
                hasLoadedBookmarks: false,
                isLoadingBookmarks: false,
                loadErrorMessage: nil
            )
        )
        XCTAssertFalse(
            BookmarksViewModel.shouldShowEmptyBookmarks(
                isEmpty: true,
                hasLoadedBookmarks: true,
                isLoadingBookmarks: false,
                loadErrorMessage: "Bookmarks couldn’t be loaded."
            )
        )
    }

    func testRefreshPresentationRejectsRapidDuplicateActionsAndRestoresLoadingState() {
        var isRefreshInFlight = false

        XCTAssertTrue(
            BookmarkRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            BookmarkRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertEqual(BookmarkRefreshPresentation.actionTitle(isLoading: false), "Refresh")
        XCTAssertEqual(
            BookmarkRefreshPresentation.progressTitle(hasLoadedBookmarks: false),
            "Loading bookmarks…"
        )
        XCTAssertEqual(
            BookmarkRefreshPresentation.accessibilityHint(isLoading: false),
            "Refresh the bookmark archive."
        )

        isRefreshInFlight = true
        XCTAssertFalse(
            BookmarkRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            BookmarkRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertEqual(BookmarkRefreshPresentation.actionTitle(isLoading: true), "Refreshing…")
        XCTAssertEqual(
            BookmarkRefreshPresentation.accessibilityHint(isLoading: true),
            "Refreshing the bookmark archive."
        )

        isRefreshInFlight = false
        XCTAssertTrue(
            BookmarkRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            BookmarkRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            BookmarkRefreshPresentation.isLoading(
                isModelLoading: true,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertEqual(
            BookmarkRefreshPresentation.progressTitle(hasLoadedBookmarks: true),
            "Refreshing bookmarks…"
        )
    }

    func testBookmarkCapturePresentationRejectsRapidDuplicatesAndRetainsModelBusyState() {
        XCTAssertFalse(
            BookmarkCapturePresentation.isSaving(
                isModelBusy: false,
                isCaptureInFlight: false
            )
        )
        XCTAssertTrue(
            BookmarkCapturePresentation.canStartCapture(
                isModelBusy: false,
                isCaptureInFlight: false
            )
        )

        XCTAssertTrue(
            BookmarkCapturePresentation.isSaving(
                isModelBusy: false,
                isCaptureInFlight: true
            )
        )
        XCTAssertFalse(
            BookmarkCapturePresentation.canStartCapture(
                isModelBusy: false,
                isCaptureInFlight: true
            )
        )

        XCTAssertTrue(
            BookmarkCapturePresentation.isSaving(
                isModelBusy: true,
                isCaptureInFlight: false
            )
        )
        XCTAssertFalse(
            BookmarkCapturePresentation.canStartCapture(
                isModelBusy: true,
                isCaptureInFlight: false
            )
        )

        XCTAssertTrue(
            BookmarkCapturePresentation.canStartCapture(
                isModelBusy: false,
                isCaptureInFlight: false
            )
        )
    }

    func testFailedCaptureRetainsFrozenIntentUntilConfirmedSuccessThenClearsAndRefreshes() async throws {
        let pendingKey = "athenaeum.test.pendingBookmark.\(UUID().uuidString)"
        UserDefaults.standard.removeObject(forKey: pendingKey)
        defer { UserDefaults.standard.removeObject(forKey: pendingKey) }

        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let responses: [BookmarkCaptureHTTPResponse] = [
            BookmarkCaptureHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8)),
            try resolved(.object(["bookmarks": .array([])])),
            try resolved(.object(["bookmark": bookmark()])),
            try resolved(.object(["bookmarks": .array([bookmark()])]))
        ]
        let model = makeModel(
            pendingKey: pendingKey,
            responses: responses
        )
        model.newUrl = "https://example.com/plan"
        model.newTitle = "Project plan"

        await model.capture()

        XCTAssertEqual(
            model.errorMessage,
            "We couldn’t confirm that this bookmark was saved. Your URL and title are still here. " +
                "Review your bookmarks before taking another action."
        )
        XCTAssertFalse(model.errorMessage?.contains(privateFailure) ?? true)
        XCTAssertEqual(model.newUrl, "https://example.com/plan")
        XCTAssertEqual(model.newTitle, "Project plan")
        XCTAssertNotNil(UserDefaults.standard.data(forKey: pendingKey))

        await model.refresh()

        XCTAssertEqual(
            model.errorMessage,
            "We couldn’t confirm that this bookmark was saved. Your URL and title are still here. " +
                "Review your bookmarks before taking another action."
        )
        XCTAssertTrue(model.hasLoadedBookmarks)
        XCTAssertNil(model.loadErrorMessage)

        await model.capture()

        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.newUrl, "")
        XCTAssertEqual(model.newTitle, "")
        XCTAssertEqual(model.bookmarks.map(\.id), ["bookmark-1"])
        XCTAssertNil(UserDefaults.standard.data(forKey: pendingKey))

        let requests = BookmarkCaptureURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 4)
        XCTAssertEqual(try bookmarkRequestID(from: requests[0]), try bookmarkRequestID(from: requests[2]))
    }
}
