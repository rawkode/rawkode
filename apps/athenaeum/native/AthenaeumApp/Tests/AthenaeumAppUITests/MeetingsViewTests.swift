import Foundation
import XCTest
@testable import AthenaeumRPC
@testable import AthenaeumAppUI

private struct MeetingsHTTPResponse {
    let statusCode: Int
    let body: Data
}

private final class MeetingsRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requestBodies: [Data] = []
    private var responses: [MeetingsHTTPResponse] = []

    func reset(responses: [MeetingsHTTPResponse]) {
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

    func nextResponse() -> MeetingsHTTPResponse {
        lock.lock()
        defer { lock.unlock() }
        guard !responses.isEmpty else {
            return MeetingsHTTPResponse(statusCode: 500, body: Data("missing test response".utf8))
        }
        return responses.removeFirst()
    }

    func recordedBodies() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return requestBodies
    }
}

private final class MeetingsURLProtocol: URLProtocol {
    private static let recorder = MeetingsRequestRecorder()

    static func reset(responses: [MeetingsHTTPResponse]) {
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
final class MeetingsViewTests: XCTestCase {
    private let workspaceId = "f9ecd920-d30a-4314-9870-3cc80e2efb58"

    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
    }

    private func makeModel(responses: [MeetingsHTTPResponse]) -> MeetingsViewModel {
        MeetingsURLProtocol.reset(responses: responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MeetingsURLProtocol.self]
        let client = WorkspaceRPCClient(
            baseURL: URL(string: "http://meetings.invalid")!,
            workspaceId: workspaceId,
            urlSession: URLSession(configuration: configuration)
        )
        return MeetingsViewModel(client: client)
    }

    private func resolved(_ value: CapnWebValue) throws -> MeetingsHTTPResponse {
        let line = try CapnWebValue.encodeMessageLine(["resolve", 1, value.toWireJSON()])
        return MeetingsHTTPResponse(statusCode: 200, body: Data(line.utf8))
    }

    private func requestMethod(from body: Data) throws -> String {
        let text = try XCTUnwrap(String(data: body, encoding: .utf8))
        let line = try XCTUnwrap(text.split(separator: "\n").first)
        let message = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [Any])
        let pipeline = try XCTUnwrap(message[1] as? [Any])
        return try XCTUnwrap((pipeline[2] as? [String])?.first)
    }

    private func meeting() -> CapnWebValue {
        .object([
            "id": .string("meeting-1"),
            "workspaceId": .string(workspaceId),
            "title": .string("Product review"),
            "startedAt": .string("2026-08-28T09:00:00.000Z"),
            "endedAt": .string("2026-08-28T09:30:00.000Z"),
            "linkedNodeId": .null
        ])
    }

    func testFormatOffsetUsesMinuteAndSecondBuckets() {
        XCTAssertEqual(MeetingsViewModel.formatOffset(0), "0:00")
        XCTAssertEqual(MeetingsViewModel.formatOffset(65_432), "1:05")
        XCTAssertEqual(MeetingsViewModel.formatOffset(-1), "0:00")
    }

    func testFormatDateKeepsMalformedWireValuesVisible() {
        XCTAssertEqual(MeetingsViewModel.formatDate("not-a-date"), "not-a-date")
    }

    func testLoadFailureMessagesSuppressUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let meetings = MeetingsViewModel.meetingsLoadFailureMessage(for: error)
        let transcript = MeetingsViewModel.transcriptLoadFailureMessage(for: error)

        XCTAssertEqual(
            meetings,
            "Meetings couldn’t be loaded. Nothing has been changed. Refresh to check your meetings again."
        )
        XCTAssertEqual(
            transcript,
            "This transcript couldn’t be loaded. Nothing has been changed. Retry this transcript or refresh your meetings."
        )
        XCTAssertFalse(meetings.contains(error.description))
        XCTAssertFalse(transcript.contains(error.description))
    }

    func testMeetingListRetryEligibilityRequiresACompletedFailure() {
        XCTAssertFalse(
            MeetingsViewModel.shouldShowMeetingsRetry(errorMessage: nil, isLoading: false)
        )
        XCTAssertFalse(
            MeetingsViewModel.shouldShowMeetingsRetry(
                errorMessage: "Meetings couldn’t be loaded.",
                isLoading: true
            )
        )
        XCTAssertTrue(
            MeetingsViewModel.shouldShowMeetingsRetry(
                errorMessage: "Meetings couldn’t be loaded.",
                isLoading: false
            )
        )
    }

    func testListRefreshPresentationRejectsRapidDuplicateActionsAndRestoresLoadingState() {
        var isRefreshInFlight = false

        XCTAssertTrue(
            MeetingsListRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            MeetingsListRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = true
        XCTAssertFalse(
            MeetingsListRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            MeetingsListRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = false
        XCTAssertTrue(
            MeetingsListRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            MeetingsListRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            MeetingsListRefreshPresentation.isLoading(
                isModelLoading: true,
                isRefreshInFlight: isRefreshInFlight
            )
        )
    }

    func testFailureThenRefreshConfirmsAnEmptyMeetingListOnlyAfterSuccess() async throws {
        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let model = makeModel(
            responses: [
                MeetingsHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8)),
                try resolved(.object(["meetings": .array([])]))
            ]
        )

        XCTAssertTrue(
            MeetingsViewModel.shouldShowMeetingsLoading(
                hasLoadedMeetings: model.hasLoadedMeetings,
                isLoading: model.isLoading,
                errorMessage: model.errorMessage
            )
        )
        XCTAssertFalse(
            MeetingsViewModel.shouldShowEmptyMeetings(
                isEmpty: model.meetings.isEmpty,
                hasLoadedMeetings: model.hasLoadedMeetings,
                isLoading: model.isLoading,
                errorMessage: model.errorMessage
            )
        )

        await model.refresh()

        XCTAssertEqual(
            model.errorMessage,
            "Meetings couldn’t be loaded. Nothing has been changed. Refresh to check your meetings again."
        )
        XCTAssertFalse(model.errorMessage?.contains(privateFailure) ?? true)
        XCTAssertFalse(model.hasLoadedMeetings)
        XCTAssertFalse(model.isLoading)
        XCTAssertTrue(
            MeetingsViewModel.shouldShowMeetingsRetry(
                errorMessage: model.errorMessage,
                isLoading: model.isLoading
            )
        )
        XCTAssertFalse(
            MeetingsViewModel.shouldShowEmptyMeetings(
                isEmpty: model.meetings.isEmpty,
                hasLoadedMeetings: model.hasLoadedMeetings,
                isLoading: model.isLoading,
                errorMessage: model.errorMessage
            )
        )

        await model.refresh()

        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.hasLoadedMeetings)
        XCTAssertFalse(model.isLoading)
        XCTAssertFalse(
            MeetingsViewModel.shouldShowMeetingsRetry(
                errorMessage: model.errorMessage,
                isLoading: model.isLoading
            )
        )
        XCTAssertTrue(
            MeetingsViewModel.shouldShowEmptyMeetings(
                isEmpty: model.meetings.isEmpty,
                hasLoadedMeetings: model.hasLoadedMeetings,
                isLoading: model.isLoading,
                errorMessage: model.errorMessage
            )
        )
        let requests = MeetingsURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(try requestMethod(from: requests[0]), "listMeetings")
        XCTAssertEqual(try requestMethod(from: requests[1]), "listMeetings")
    }

    func testLaterFailureRetainsCachedMeetings() async throws {
        let model = makeModel(
            responses: [
                try resolved(.object(["meetings": .array([meeting()])])),
                MeetingsHTTPResponse(statusCode: 500, body: Data("private backend failure".utf8))
            ]
        )

        await model.refresh()
        XCTAssertEqual(model.meetings.map(\.title), ["Product review"])
        XCTAssertTrue(model.hasLoadedMeetings)
        XCTAssertFalse(
            MeetingsViewModel.shouldShowMeetingsLoading(
                hasLoadedMeetings: model.hasLoadedMeetings,
                isLoading: true,
                errorMessage: nil
            )
        )

        await model.refresh()

        XCTAssertEqual(model.meetings.map(\.title), ["Product review"])
        XCTAssertTrue(model.hasLoadedMeetings)
        XCTAssertNotNil(model.errorMessage)
        XCTAssertFalse(
            MeetingsViewModel.shouldShowEmptyMeetings(
                isEmpty: model.meetings.isEmpty,
                hasLoadedMeetings: model.hasLoadedMeetings,
                isLoading: model.isLoading,
                errorMessage: model.errorMessage
            )
        )
        let requests = MeetingsURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(try requestMethod(from: requests[0]), "listMeetings")
        XCTAssertEqual(try requestMethod(from: requests[1]), "listMeetings")
    }

    func testTranscriptRetryRequiresSelectedMeetingAndNoActiveDetailRead() {
        XCTAssertTrue(
            MeetingsViewModel.canRetryTranscript(meetingId: "meeting-1", isLoadingDetail: false)
        )
        XCTAssertFalse(
            MeetingsViewModel.canRetryTranscript(meetingId: nil, isLoadingDetail: false)
        )
        XCTAssertFalse(
            MeetingsViewModel.canRetryTranscript(meetingId: "meeting-1", isLoadingDetail: true)
        )
    }

    func testRapidTranscriptActivationKeepsTheFirstPendingMeetingUntilItCompletes() {
        let firstMeetingId = "meeting-first"
        let secondMeetingId = "meeting-second"
        var pendingMeetingId: String? = firstMeetingId

        XCTAssertFalse(MeetingTranscriptSelectionPresentation.canStartSelection(pendingMeetingId: pendingMeetingId))

        pendingMeetingId = MeetingTranscriptSelectionPresentation.pendingMeetingId(
            afterCompleting: secondMeetingId,
            pendingMeetingId: pendingMeetingId
        )
        XCTAssertEqual(pendingMeetingId, firstMeetingId)

        pendingMeetingId = MeetingTranscriptSelectionPresentation.pendingMeetingId(
            afterCompleting: firstMeetingId,
            pendingMeetingId: pendingMeetingId
        )
        XCTAssertNil(pendingMeetingId)
        XCTAssertTrue(MeetingTranscriptSelectionPresentation.canStartSelection(pendingMeetingId: pendingMeetingId))
    }
}
