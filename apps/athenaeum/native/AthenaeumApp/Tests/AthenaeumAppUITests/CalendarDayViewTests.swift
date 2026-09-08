import Foundation
import XCTest
@testable import AthenaeumRPC
@testable import AthenaeumAppUI

private struct CalendarDayHTTPResponse {
    let statusCode: Int
    let body: Data
}

private final class CalendarDayRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requestBodies: [Data] = []
    private var responses: [CalendarDayHTTPResponse] = []

    func reset(responses: [CalendarDayHTTPResponse]) {
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

    func nextResponse() -> CalendarDayHTTPResponse {
        lock.lock()
        defer { lock.unlock() }
        guard !responses.isEmpty else {
            return CalendarDayHTTPResponse(statusCode: 500, body: Data("missing test response".utf8))
        }
        return responses.removeFirst()
    }

    func recordedBodies() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return requestBodies
    }
}

private final class CalendarDayURLProtocol: URLProtocol {
    private static let recorder = CalendarDayRequestRecorder()

    static func reset(responses: [CalendarDayHTTPResponse]) {
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
final class CalendarDayViewTests: XCTestCase {
    private let workspaceId = "f9ecd920-d30a-4314-9870-3cc80e2efb58"

    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "provider=https://calendar.example/api?credential=private-token"
    }

    private func makeModel(responses: [CalendarDayHTTPResponse]) -> CalendarDayViewModel {
        CalendarDayURLProtocol.reset(responses: responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CalendarDayURLProtocol.self]
        let client = WorkspaceRPCClient(
            baseURL: URL(string: "http://calendar-day.invalid")!,
            workspaceId: workspaceId,
            urlSession: URLSession(configuration: configuration)
        )
        return CalendarDayViewModel(client: client)
    }

    private func resolved(_ value: CapnWebValue) throws -> CalendarDayHTTPResponse {
        let line = try CapnWebValue.encodeMessageLine(["resolve", 1, value.toWireJSON()])
        return CalendarDayHTTPResponse(statusCode: 200, body: Data(line.utf8))
    }

    private func requestMethod(from body: Data) throws -> String {
        let text = try XCTUnwrap(String(data: body, encoding: .utf8))
        let line = try XCTUnwrap(text.split(separator: "\n").first)
        let message = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [Any])
        let pipeline = try XCTUnwrap(message[1] as? [Any])
        return try XCTUnwrap((pipeline[2] as? [String])?.first)
    }

    private func calendarEvent() -> CapnWebValue {
        .object([
            "id": .string("calendar-event-1"),
            "workspaceId": .string(workspaceId),
            "providerEventId": .string("provider-event-1"),
            "title": .string("Team standup"),
            "start": .object([
                "kind": .string("dateTime"),
                "dateTime": .string("2026-08-28T09:00:00.000Z"),
                "timeZone": .string("UTC")
            ]),
            "end": .object([
                "kind": .string("dateTime"),
                "dateTime": .string("2026-08-28T09:30:00.000Z"),
                "timeZone": .string("UTC")
            ]),
            "attendees": .array([]),
            "status": .string("confirmed"),
            "syncedAt": .string("2026-08-28T08:00:00.000Z")
        ])
    }

    private func bindingSummary(
        id: String = "calendar-binding-1",
        mode: String = "selected"
    ) -> CapnWebValue {
        .object([
            "id": .string(id),
            "workspaceId": .string(workspaceId),
            "gatekeeperKind": .string("google-calendar"),
            "mode": .string(mode),
            "createdAt": .string("2026-08-28T08:00:00.000Z")
        ])
    }

    func testLoadFailureMessageSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = CalendarDayViewModel.calendarLoadFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "Calendar events couldn’t be loaded. Nothing has been changed. Refresh to check today again."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testRetryEligibilityRequiresACompletedFailure() {
        XCTAssertFalse(
            CalendarDayViewModel.shouldShowEventsRetry(errorMessage: nil, isLoading: false)
        )
        XCTAssertFalse(
            CalendarDayViewModel.shouldShowEventsRetry(
                errorMessage: "Calendar events couldn’t be loaded.",
                isLoading: true
            )
        )
        XCTAssertTrue(
            CalendarDayViewModel.shouldShowEventsRetry(
                errorMessage: "Calendar events couldn’t be loaded.",
                isLoading: false
            )
        )
    }

    func testRefreshPresentationRejectsRapidDuplicateActionsAndRestoresLoadingState() {
        var isRefreshInFlight = false

        XCTAssertTrue(
            CalendarDayRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            CalendarDayRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = true
        XCTAssertFalse(
            CalendarDayRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            CalendarDayRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = false
        XCTAssertTrue(
            CalendarDayRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            CalendarDayRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            CalendarDayRefreshPresentation.isLoading(
                isModelLoading: true,
                isRefreshInFlight: isRefreshInFlight
            )
        )
    }

    func testFailureThenRefreshConfirmsAnEmptyCalendarOnlyAfterSuccess() async throws {
        let privateFailure = "provider=https://calendar.example/api?credential=private-token"
        let model = makeModel(
            responses: [
                CalendarDayHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8)),
                try resolved(.object(["events": .array([])]))
            ]
        )

        XCTAssertTrue(
            CalendarDayViewModel.shouldShowEventsLoading(
                hasLoadedEvents: model.hasLoadedEvents,
                isLoading: model.isLoading,
                errorMessage: model.errorMessage
            )
        )
        XCTAssertFalse(
            CalendarDayViewModel.shouldShowEmptyEvents(
                isEmpty: model.events.isEmpty,
                hasLoadedEvents: model.hasLoadedEvents,
                isLoading: model.isLoading,
                errorMessage: model.errorMessage
            )
        )

        await model.refresh()

        XCTAssertEqual(
            model.errorMessage,
            "Calendar events couldn’t be loaded. Nothing has been changed. Refresh to check today again."
        )
        XCTAssertFalse(model.errorMessage?.contains(privateFailure) ?? true)
        XCTAssertFalse(model.hasLoadedEvents)
        XCTAssertFalse(model.isLoading)
        XCTAssertTrue(
            CalendarDayViewModel.shouldShowEventsRetry(
                errorMessage: model.errorMessage,
                isLoading: model.isLoading
            )
        )
        XCTAssertFalse(
            CalendarDayViewModel.shouldShowEmptyEvents(
                isEmpty: model.events.isEmpty,
                hasLoadedEvents: model.hasLoadedEvents,
                isLoading: model.isLoading,
                errorMessage: model.errorMessage
            )
        )

        await model.refresh()

        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.hasLoadedEvents)
        XCTAssertFalse(model.isLoading)
        XCTAssertFalse(
            CalendarDayViewModel.shouldShowEventsRetry(
                errorMessage: model.errorMessage,
                isLoading: model.isLoading
            )
        )
        XCTAssertTrue(
            CalendarDayViewModel.shouldShowEmptyEvents(
                isEmpty: model.events.isEmpty,
                hasLoadedEvents: model.hasLoadedEvents,
                isLoading: model.isLoading,
                errorMessage: model.errorMessage
            )
        )
        let requests = CalendarDayURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(try requestMethod(from: requests[0]), "listCalendarEvents")
        XCTAssertEqual(try requestMethod(from: requests[1]), "listCalendarEvents")
    }

    func testLaterFailureRetainsCachedCalendarRows() async throws {
        let model = makeModel(
            responses: [
                try resolved(.object(["events": .array([calendarEvent()])])),
                CalendarDayHTTPResponse(statusCode: 500, body: Data("private provider failure".utf8))
            ]
        )

        await model.refresh()
        XCTAssertEqual(model.events.map(\.title), ["Team standup"])
        XCTAssertTrue(model.hasLoadedEvents)

        await model.refresh()

        XCTAssertEqual(model.events.map(\.title), ["Team standup"])
        XCTAssertNotNil(model.errorMessage)
        XCTAssertFalse(
            CalendarDayViewModel.shouldShowEmptyEvents(
                isEmpty: model.events.isEmpty,
                hasLoadedEvents: model.hasLoadedEvents,
                isLoading: model.isLoading,
                errorMessage: model.errorMessage
            )
        )
        let requests = CalendarDayURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(try requestMethod(from: requests[0]), "listCalendarEvents")
        XCTAssertEqual(try requestMethod(from: requests[1]), "listCalendarEvents")
    }

    func testRefreshBindingsUsesSanitizedCatalog() async throws {
        let model = makeModel(
            responses: [
                try resolved(.object(["bindings": .array([bindingSummary()])]))
            ]
        )

        await model.refreshBindings()

        XCTAssertNil(model.bindingsErrorMessage)
        XCTAssertEqual(model.bindings.map(\.id), ["calendar-binding-1"])
        XCTAssertEqual(model.bindings.first?.mode, "selected")
        let requests = CalendarDayURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(try requestMethod(from: requests[0]), "listGatekeeperBindings")
    }

    func testRefreshBindingsSuppressesPrivateTransportDetails() async throws {
        let privateFailure = "provider=https://calendar.example/api?credential=private-token"
        let model = makeModel(
            responses: [
                CalendarDayHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8))
            ]
        )

        await model.refreshBindings()

        XCTAssertEqual(
            model.bindingsErrorMessage,
            "Calendar connections couldn’t be confirmed. Retry before requesting a sync."
        )
        XCTAssertFalse(model.bindingsErrorMessage?.contains(privateFailure) ?? true)
    }

    func testSyncGoogleCalendarRequestsConfirmedBindingThenRefreshesEvents() async throws {
        let model = makeModel(
            responses: [
                try resolved(.object(["bindings": .array([bindingSummary()])])),
                try resolved(.object(["triggered": .bool(true)])),
                try resolved(.object(["events": .array([])]))
            ]
        )

        await model.refreshBindings()
        await model.syncGoogleCalendar(bindingId: "calendar-binding-1")

        XCTAssertEqual(model.syncState, .success(bindingId: "calendar-binding-1"))
        XCTAssertTrue(model.hasLoadedEvents)
        XCTAssertTrue(model.events.isEmpty)
        let requests = CalendarDayURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(try requestMethod(from: requests[0]), "listGatekeeperBindings")
        XCTAssertEqual(try requestMethod(from: requests[1]), "syncGoogleCalendar")
        XCTAssertEqual(try requestMethod(from: requests[2]), "listCalendarEvents")
    }

    func testSyncGoogleCalendarRejectsUnconfirmedBinding() async throws {
        let model = makeModel(responses: [])

        await model.syncGoogleCalendar(bindingId: "not-confirmed")

        XCTAssertEqual(model.syncState, .idle)
        XCTAssertTrue(CalendarDayURLProtocol.requestBodies().isEmpty)
    }
}
