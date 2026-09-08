import Combine
import Foundation
import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

private struct GraphHTTPResponse {
    let statusCode: Int
    let body: Data
}

private final class GraphReadRecorder: @unchecked Sendable {
    private struct Pending {
        let protocolInstance: URLProtocol
        let body: Data
    }

    private let lock = NSLock()
    private var pending: [Pending] = []
    private var bodies: [Data] = []
    private var startExpectations: [XCTestExpectation] = []

    func reset(startExpectations: [XCTestExpectation]) {
        lock.lock()
        defer { lock.unlock() }
        pending = []
        bodies = []
        self.startExpectations = startExpectations
    }

    func recordStart(protocolInstance: URLProtocol, body: Data) {
        lock.lock()
        pending.append(.init(protocolInstance: protocolInstance, body: body))
        bodies.append(body)
        let expectation = pending.count <= startExpectations.count ? startExpectations[pending.count - 1] : nil
        lock.unlock()
        expectation?.fulfill()
    }

    func requestBodies() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return bodies
    }

    func release(at index: Int, response: GraphHTTPResponse) {
        lock.lock()
        guard pending.indices.contains(index) else {
            lock.unlock()
            XCTFail("missing pending graph request at index \(index)")
            return
        }
        let pendingRequest = pending[index]
        lock.unlock()
        let httpResponse = HTTPURLResponse(
            url: pendingRequest.protocolInstance.request.url!,
            statusCode: response.statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        pendingRequest.protocolInstance.client?.urlProtocol(
            pendingRequest.protocolInstance,
            didReceive: httpResponse,
            cacheStoragePolicy: .notAllowed
        )
        pendingRequest.protocolInstance.client?.urlProtocol(pendingRequest.protocolInstance, didLoad: response.body)
        pendingRequest.protocolInstance.client?.urlProtocolDidFinishLoading(pendingRequest.protocolInstance)
    }
}

private final class GraphReadURLProtocol: URLProtocol {
    private static let recorder = GraphReadRecorder()

    static func reset(startExpectations: [XCTestExpectation]) {
        recorder.reset(startExpectations: startExpectations)
    }

    static func requestBodies() -> [Data] { recorder.requestBodies() }

    static func release(at index: Int, response: GraphHTTPResponse) {
        recorder.release(at: index, response: response)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.recorder.recordStart(protocolInstance: self, body: requestBody())
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
private final class UnusedGraphPageOperations: DailyNotePageOperations {
    func resolveNode(id: EntityId, title: String) async throws { fatalError("unused") }
    func descriptor(nodeId: EntityId) async throws -> PageDocumentDescriptor { fatalError("unused") }
    func resolveOrCreateLoro(nodeId: EntityId, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor { fatalError("unused") }
    func hasLocalLoroPage(nodeId: EntityId) async throws -> Bool { fatalError("unused") }
    func legacyPageProjection(nodeId: EntityId, descriptor: PageDocumentDescriptor, session: SyncSessionHandle) async throws -> DailyNoteLegacyReadOnlyState { fatalError("unused") }
    func hasDirtyLocalAutomerge(nodeId: EntityId) async throws -> Bool { fatalError("unused") }
    func localAutomergeHeads(nodeId: EntityId) async throws -> String? { fatalError("unused") }
    func loadedAutomergeHeads(nodeId: EntityId) async throws -> String? { fatalError("unused") }
    func resolveOrCreateAutomerge(nodeId: EntityId, session: SyncSessionHandle) async throws -> String { fatalError("unused") }
    func syncAutomerge(nodeId: EntityId, session: SyncSessionHandle) async throws -> String { fatalError("unused") }
    func isAutomergeRichText(nodeId: EntityId) async throws -> Bool { fatalError("unused") }
    func applyAutomergeSplice(nodeId: EntityId, index: Int, deleteCount: Int, insertText: String) async throws { fatalError("unused") }
    func syncLoroReadOnly(nodeId: EntityId) async throws -> DailyNoteLoroReadOnlyState { fatalError("unused") }
    func syncLoroProjection(nodeId: EntityId) async throws -> DailyNoteLoroProjectionState { fatalError("unused") }
    func recoverInFlightLoroSemanticCheckpoint(nodeId: EntityId) async throws -> LoroSemanticCheckpointResolution { fatalError("unused") }
    func retryRetainedLoroSemanticCheckpoint(nodeId: EntityId) async throws -> LoroSemanticCheckpointResolution { fatalError("unused") }
    func loroNativePlainEditorEligibility(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility { fatalError("unused") }
    func recoverAcceptedLoroLiteralForEditing(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility { fatalError("unused") }
    func submitNativePlainText(nodeId: EntityId, base: LoroNativePlainEditorState, proposedText: String) async throws -> LoroNativePlainTextSubmissionDisposition { fatalError("unused") }
    func loroNativeRichEditorEligibility(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility { fatalError("unused") }
    func recoverAcceptedLoroRichLiteralForEditing(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility { fatalError("unused") }
    func submitNativeRichDocumentV1(nodeId: EntityId, base: LoroNativeRichEditorState, proposed: LoroNativeRichDocumentV1, commitMessage: String) async throws -> LoroNativeRichDocumentSubmissionDisposition { fatalError("unused") }
    func submitNativeRichTaskItemToggle(nodeId: EntityId, base: LoroNativeRichEditorState, command: LoroNativeRichTaskItemToggleCommand, commitMessage: String, surface: NativeRichTaskItemToggleSurface) async throws -> LoroNativeRichDocumentSubmissionDisposition { fatalError("unused") }
    func submitNativeRichTaskListInsertion(nodeId: EntityId, base: LoroNativeRichEditorState, command: LoroNativeRichTaskListInsertionCommand, commitMessage: String, surface: NativeRichTaskItemToggleSurface) async throws -> LoroNativeRichDocumentSubmissionDisposition { fatalError("unused") }
    func prepareMeetingInDailyNote(_ input: PrepareMeetingInDailyNoteInput) async throws -> PrepareMeetingInDailyNoteOutput { fatalError("unused") }
}

@MainActor
final class GraphNodesViewTests: XCTestCase {
    private let workspaceId = try! EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60")
    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
    }

    private func makeModel(
        startExpectations: [XCTestExpectation],
        graphReadCompletionObserver: (() -> Void)? = nil
    ) throws -> AthenaeumViewModel {
        GraphReadURLProtocol.reset(startExpectations: startExpectations)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GraphReadURLProtocol.self]
        let client = WorkspaceRPCClient(
            baseURL: URL(string: "http://graph-read.invalid")!,
            workspaceId: workspaceId.rawValue,
            urlSession: URLSession(configuration: configuration)
        )
        return try AthenaeumViewModel(
            workspaceId: workspaceId,
            pageOperations: UnusedGraphPageOperations(),
            readClient: client,
            graphReadCompletionObserver: graphReadCompletionObserver
        )
    }

    private func resolvedRows(_ rows: [AthenaeumViewModel.GraphNodeRow]) throws -> GraphHTTPResponse {
        let value: [String: Any] = [
            "rows": [rows.map { ["id": $0.id, "title": $0.title, "createdAt": $0.createdAt] }]
        ]
        let data = try JSONSerialization.data(withJSONObject: ["resolve", 1, value])
        return .init(statusCode: 200, body: data + Data("\n".utf8))
    }

    private func hasPeoplePredicate(_ body: Data) throws -> Bool {
        let text = try XCTUnwrap(String(data: body, encoding: .utf8))
        let line = try XCTUnwrap(text.split(separator: "\n").first)
        let message = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [Any])
        let pipeline = try XCTUnwrap(message[1] as? [Any])
        let arguments = try XCTUnwrap(pipeline[3] as? [Any])
        let request = try XCTUnwrap(arguments.first as? [String: Any])
        XCTAssertEqual(request["viewName"] as? String, "graph_nodes")
        let viewSpec = try XCTUnwrap(request["viewSpec"] as? [String: Any])
        guard let filter = viewSpec["filter"] as? [String: Any] else { return false }
        return filter["op"] as? String == "hasTag" && filter["tagId"] as? String == BaseTagIds.person.rawValue
    }

    private func awaitSettledGraph(
        _ model: AthenaeumViewModel,
        rowID: String,
        onlyPerson: Bool
    ) async {
        let settled = expectation(description: "graph state settled for \(rowID)")
        var subscription: AnyCancellable?
        subscription = model.$isLoadingGraph.sink { [weak model] isLoading in
            guard let model,
                  !isLoading,
                  model.graphRows.map(\.id) == [rowID],
                  model.graphRowsOnlyPerson == onlyPerson,
                  model.hasLoadedGraph,
                  model.graphLoadErrorMessage == nil
            else { return }
            settled.fulfill()
        }
        await fulfillment(of: [settled], timeout: 1)
        subscription?.cancel()
    }

    func testStaleGraphSuccessCannotReplaceNewerPeopleFilterResult() async throws {
        let staleStarted = expectation(description: "stale graph request started")
        let currentStarted = expectation(description: "current graph request started")
        let model = try makeModel(startExpectations: [staleStarted, currentStarted])

        let staleRead = Task { await model.reloadGraphView() }
        await fulfillment(of: [staleStarted], timeout: 1)
        model.onlyPerson = true
        await fulfillment(of: [currentStarted], timeout: 1)
        let requests = GraphReadURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 2)
        XCTAssertFalse(try hasPeoplePredicate(requests[0]))
        XCTAssertTrue(try hasPeoplePredicate(requests[1]))

        let current = AthenaeumViewModel.GraphNodeRow(id: "person-current", title: "Current", createdAt: "2026-08-28T10:00:00Z")
        let stale = AthenaeumViewModel.GraphNodeRow(id: "all-stale", title: "Stale", createdAt: "2026-08-28T09:00:00Z")
        let settled = Task { await self.awaitSettledGraph(model, rowID: current.id, onlyPerson: true) }
        GraphReadURLProtocol.release(at: 1, response: try resolvedRows([current]))
        await settled.value
        GraphReadURLProtocol.release(at: 0, response: try resolvedRows([stale]))
        await staleRead.value

        XCTAssertEqual(model.graphRows.map(\.id), [current.id])
        XCTAssertEqual(model.graphRowsOnlyPerson, true)
        XCTAssertTrue(model.hasLoadedGraph)
        XCTAssertNil(model.graphLoadErrorMessage)
        XCTAssertFalse(model.isLoadingGraph)
    }

    func testStaleGraphFailureCannotReplaceNewerPeopleFilterSuccess() async throws {
        let staleStarted = expectation(description: "stale graph request started")
        let currentStarted = expectation(description: "current graph request started")
        let model = try makeModel(startExpectations: [staleStarted, currentStarted])

        let staleRead = Task { await model.reloadGraphView() }
        await fulfillment(of: [staleStarted], timeout: 1)
        model.onlyPerson = true
        await fulfillment(of: [currentStarted], timeout: 1)
        let requests = GraphReadURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 2)
        XCTAssertFalse(try hasPeoplePredicate(requests[0]))
        XCTAssertTrue(try hasPeoplePredicate(requests[1]))

        let current = AthenaeumViewModel.GraphNodeRow(id: "person-current", title: "Current", createdAt: "2026-08-28T10:00:00Z")
        let settled = Task { await self.awaitSettledGraph(model, rowID: current.id, onlyPerson: true) }
        GraphReadURLProtocol.release(at: 1, response: try resolvedRows([current]))
        await settled.value
        GraphReadURLProtocol.release(at: 0, response: .init(statusCode: 500, body: Data("stale failure".utf8)))
        await staleRead.value

        XCTAssertEqual(model.graphRows.map(\.id), [current.id])
        XCTAssertEqual(model.graphRowsOnlyPerson, true)
        XCTAssertTrue(model.hasLoadedGraph)
        XCTAssertNil(model.graphLoadErrorMessage)
        XCTAssertFalse(model.isLoadingGraph)
    }

    func testRapidFilterChangesKeepEachQueuedTaskBoundToItsOriginalIntent() async throws {
        let firstStarted = expectation(description: "first queued filter request started")
        let secondStarted = expectation(description: "second queued filter request started")
        let completed = expectation(description: "both graph reads completed")
        completed.expectedFulfillmentCount = 2
        let model = try makeModel(
            startExpectations: [firstStarted, secondStarted],
            graphReadCompletionObserver: { completed.fulfill() }
        )

        model.onlyPerson = true
        model.onlyPerson = false
        await fulfillment(of: [firstStarted, secondStarted], timeout: 1)

        let requests = GraphReadURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 2)
        let filters = try requests.map(hasPeoplePredicate)
        let peopleIndex = try XCTUnwrap(filters.firstIndex(of: true))
        let allIndex = try XCTUnwrap(filters.firstIndex(of: false))
        XCTAssertNotEqual(peopleIndex, allIndex)

        let latest = AthenaeumViewModel.GraphNodeRow(id: "all-current", title: "All", createdAt: "2026-08-28T10:00:00Z")
        let settled = Task { await self.awaitSettledGraph(model, rowID: latest.id, onlyPerson: false) }
        GraphReadURLProtocol.release(at: allIndex, response: try resolvedRows([latest]))
        await settled.value
        let stale = AthenaeumViewModel.GraphNodeRow(id: "person-stale", title: "Person", createdAt: "2026-08-28T09:00:00Z")
        GraphReadURLProtocol.release(at: peopleIndex, response: try resolvedRows([stale]))
        await fulfillment(of: [completed], timeout: 1)

        XCTAssertEqual(model.graphRows.map(\.id), [latest.id])
        XCTAssertEqual(model.graphRowsOnlyPerson, false)
        XCTAssertTrue(model.hasLoadedGraph)
        XCTAssertNil(model.graphLoadErrorMessage)
        XCTAssertFalse(model.isLoadingGraph)
    }

    func testGraphLoadFailureMessageSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = AthenaeumViewModel.graphLoadFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "The node list could not be loaded. Nothing has been changed. Retry to check it again."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testGraphPersonTagFailureMessageSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = AthenaeumViewModel.graphPersonTagFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm that this entity was tagged Person. Review the graph before taking another action."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testPersonTagAssignmentActionIsHiddenForThePeopleOnlyFilter() {
        XCTAssertTrue(GraphPersonTagPresentation.shouldShowAssignmentAction(onlyPerson: false))
        XCTAssertFalse(GraphPersonTagPresentation.shouldShowAssignmentAction(onlyPerson: true))
    }

    func testPersonTagAssignmentPresentationAllowsOnlyOneRapidActionAtATime() {
        var assigningNodeId: String?

        XCTAssertTrue(GraphPersonTagPresentation.canStartAssignment(assigningNodeId: assigningNodeId))
        assigningNodeId = "node-a"

        XCTAssertFalse(GraphPersonTagPresentation.canStartAssignment(assigningNodeId: assigningNodeId))
        XCTAssertEqual(
            GraphPersonTagPresentation.assignmentActionLabel(rowId: "node-a", assigningNodeId: assigningNodeId),
            "Tagging…"
        )
        XCTAssertEqual(
            GraphPersonTagPresentation.assignmentActionLabel(rowId: "node-b", assigningNodeId: assigningNodeId),
            "+ Person tag"
        )

        assigningNodeId = nil
        XCTAssertTrue(GraphPersonTagPresentation.canStartAssignment(assigningNodeId: assigningNodeId))
    }

    func testGraphRefreshPresentationRequiresASettledCurrentFilterAndPreventsRapidRepeats() {
        XCTAssertTrue(
            GraphRefreshPresentation.shouldShowControl(
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: false,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            GraphRefreshPresentation.canStartRefresh(
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: false,
                isLoadingGraph: false,
                errorMessage: nil,
                isRefreshing: false
            )
        )
        XCTAssertEqual(GraphRefreshPresentation.actionTitle(isRefreshing: false), "Refresh")
        XCTAssertEqual(GraphRefreshPresentation.actionTitle(isRefreshing: true), "Refreshing…")

        XCTAssertFalse(
            GraphRefreshPresentation.canStartRefresh(
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: false,
                isLoadingGraph: false,
                errorMessage: nil,
                isRefreshing: true
            )
        )
        XCTAssertFalse(
            GraphRefreshPresentation.canStartRefresh(
                hasLoadedGraph: false,
                graphRowsOnlyPerson: nil,
                onlyPerson: false,
                isLoadingGraph: false,
                errorMessage: nil,
                isRefreshing: false
            )
        )
        XCTAssertFalse(
            GraphRefreshPresentation.canStartRefresh(
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: true,
                isLoadingGraph: false,
                errorMessage: nil,
                isRefreshing: false
            )
        )
        XCTAssertFalse(
            GraphRefreshPresentation.canStartRefresh(
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: false,
                isLoadingGraph: true,
                errorMessage: nil,
                isRefreshing: false
            )
        )
        XCTAssertFalse(
            GraphRefreshPresentation.shouldShowControl(
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: false,
                errorMessage: "The node list could not be loaded."
            )
        )
    }

    func testGraphLoadRetryPresentationRejectsRapidDuplicatesAndRestoresRetryAffordance() {
        let error = "The node list could not be loaded."

        XCTAssertTrue(
            GraphLoadRetryPresentation.canStartRetry(
                errorMessage: error,
                isLoadingGraph: false,
                isRetrying: false
            )
        )
        XCTAssertEqual(
            GraphLoadRetryPresentation.actionTitle(isRetrying: false),
            "Retry"
        )

        XCTAssertFalse(
            GraphLoadRetryPresentation.canStartRetry(
                errorMessage: error,
                isLoadingGraph: false,
                isRetrying: true
            )
        )
        XCTAssertEqual(
            GraphLoadRetryPresentation.actionTitle(isRetrying: true),
            "Retrying…"
        )

        XCTAssertFalse(
            GraphLoadRetryPresentation.canStartRetry(
                errorMessage: error,
                isLoadingGraph: true,
                isRetrying: false
            )
        )
        XCTAssertFalse(
            GraphLoadRetryPresentation.canStartRetry(
                errorMessage: nil,
                isLoadingGraph: false,
                isRetrying: false
            )
        )

        XCTAssertTrue(
            GraphLoadRetryPresentation.canStartRetry(
                errorMessage: error,
                isLoadingGraph: false,
                isRetrying: false
            )
        )
    }

    func testGraphEmptyPresentationRequiresSuccessfulIdleLoad() {
        XCTAssertTrue(
            AthenaeumViewModel.shouldShowEmptyGraph(
                isEmpty: true,
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: false,
                isLoadingGraph: false,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.shouldShowEmptyGraph(
                isEmpty: true,
                hasLoadedGraph: false,
                graphRowsOnlyPerson: nil,
                onlyPerson: false,
                isLoadingGraph: false,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.shouldShowEmptyGraph(
                isEmpty: true,
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: false,
                isLoadingGraph: true,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.shouldShowEmptyGraph(
                isEmpty: true,
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: false,
                isLoadingGraph: false,
                errorMessage: "The node list could not be loaded."
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.shouldShowEmptyGraph(
                isEmpty: true,
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: true,
                isLoadingGraph: false,
                errorMessage: nil
            )
        )
    }

    func testGraphLoadingAndRetryPresentationStayScopedToTheExistingRead() {
        XCTAssertTrue(
            AthenaeumViewModel.shouldShowGraphLoading(
                hasLoadedGraph: false,
                graphRowsOnlyPerson: nil,
                onlyPerson: false,
                isLoadingGraph: false,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            AthenaeumViewModel.shouldShowGraphLoading(
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: false,
                isLoadingGraph: true,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.shouldShowGraphLoading(
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: false,
                isLoadingGraph: false,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            AthenaeumViewModel.canRetryGraphLoad(
                errorMessage: "The node list could not be loaded.",
                isLoadingGraph: false
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.canRetryGraphLoad(
                errorMessage: nil,
                isLoadingGraph: false
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.canRetryGraphLoad(
                errorMessage: "The node list could not be loaded.",
                isLoadingGraph: true
            )
        )
        XCTAssertTrue(
            AthenaeumViewModel.shouldShowGraphLoading(
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: true,
                isLoadingGraph: false,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            AthenaeumViewModel.shouldShowCachedGraphRows(
                isEmpty: false,
                hasLoadedGraph: true,
                graphRowsOnlyPerson: true,
                onlyPerson: true
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.shouldShowCachedGraphRows(
                isEmpty: false,
                hasLoadedGraph: true,
                graphRowsOnlyPerson: false,
                onlyPerson: true
            )
        )
    }
}
