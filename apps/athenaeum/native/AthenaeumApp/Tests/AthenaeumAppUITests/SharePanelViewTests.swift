import Foundation
import XCTest
@testable import AthenaeumRPC
@testable import AthenaeumAppUI

private struct ShareLinkHTTPResponse {
    let statusCode: Int
    let body: Data
}

private final class ShareLinkRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requestBodies: [Data] = []
    private var responses: [ShareLinkHTTPResponse] = []

    func reset(responses: [ShareLinkHTTPResponse]) {
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

    func nextResponse() -> ShareLinkHTTPResponse {
        lock.lock()
        defer { lock.unlock() }
        guard !responses.isEmpty else {
            return ShareLinkHTTPResponse(statusCode: 500, body: Data("missing test response".utf8))
        }
        return responses.removeFirst()
    }

    func recordedBodies() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return requestBodies
    }
}

private final class ShareLinkURLProtocol: URLProtocol {
    private static let recorder = ShareLinkRequestRecorder()

    static func reset(responses: [ShareLinkHTTPResponse]) {
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
final class SharePanelViewTests: XCTestCase {
    private let workspaceId = "f9ecd920-d30a-4314-9870-3cc80e2efb58"

    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
    }

    private func makeModel(responses: [ShareLinkHTTPResponse]) -> SharePanelViewModel {
        ShareLinkURLProtocol.reset(responses: responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ShareLinkURLProtocol.self]
        let client = WorkspaceRPCClient(
            baseURL: URL(string: "http://share-link.invalid")!,
            workspaceId: workspaceId,
            urlSession: URLSession(configuration: configuration),
            bearerCredential: "test-credential"
        )
        return SharePanelViewModel(client: client)
    }

    private func shareLink() -> CapnWebValue {
        .object([
            "id": .string(String(repeating: "a", count: 64)),
            "workspaceId": .string(workspaceId),
            "creatorId": .string("owner@example.com"),
            "role": .string("build"),
            "revoked": .bool(false),
            "createdAt": .string("2026-08-28T10:00:00.000Z")
        ])
    }

    private func resolved(_ value: CapnWebValue) throws -> ShareLinkHTTPResponse {
        let line = try CapnWebValue.encodeMessageLine(["resolve", 1, value.toWireJSON()])
        return ShareLinkHTTPResponse(statusCode: 200, body: Data(line.utf8))
    }

    private func requestInput(from body: Data) throws -> (method: String, input: [String: Any]) {
        let text = try XCTUnwrap(String(data: body, encoding: .utf8))
        let line = try XCTUnwrap(text.split(separator: "\n").first)
        let message = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [Any])
        let pipeline = try XCTUnwrap(message[1] as? [Any])
        let method = try XCTUnwrap((pipeline[2] as? [String])?.first)
        let arguments = try XCTUnwrap(pipeline[3] as? [Any])
        let input = try XCTUnwrap(arguments.first as? [String: Any])
        return (method, input)
    }

    func testShareLinkCreationFailureMessageSuppressesPrivateTransportDetails() {
        let error = PrivateTransportError()
        let message = SharePanelViewModel.shareLinkCreationFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm that the share link was created. Review active share links before taking another action."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testLoadFailureIsPrivateAndRetryRefreshesOnlySharingCatalog() async throws {
        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let responses: [ShareLinkHTTPResponse] = [
            ShareLinkHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8)),
            try resolved(.object(["collaborators": .array([])])),
            try resolved(.object(["shareLinks": .array([])]))
        ]
        let model = makeModel(responses: responses)
        model.newCollaboratorEmail = "collaborator@example.com"
        model.newCollaboratorRole = "build"
        model.shareLinkRole = "build"
        model.redeemKey = "preserve-this-key"

        await model.refresh()

        XCTAssertEqual(
            model.loadErrorMessage,
            "Sharing details couldn’t be loaded. Nothing has been changed. Retry to check collaborators and active links."
        )
        XCTAssertFalse(model.loadErrorMessage?.contains(privateFailure) ?? true)
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.hasLoadedSharingDetails)
        XCTAssertTrue(model.collaborators.isEmpty)
        XCTAssertTrue(model.shareLinks.isEmpty)
        XCTAssertEqual(model.newCollaboratorEmail, "collaborator@example.com")
        XCTAssertEqual(model.newCollaboratorRole, "build")
        XCTAssertEqual(model.shareLinkRole, "build")
        XCTAssertEqual(model.redeemKey, "preserve-this-key")
        XCTAssertEqual(ShareLinkURLProtocol.requestBodies().count, 1)
        XCTAssertEqual(try requestInput(from: ShareLinkURLProtocol.requestBodies()[0]).method, "listCollaborators")

        await model.refresh()

        XCTAssertNil(model.loadErrorMessage)
        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.hasLoadedSharingDetails)
        let requests = ShareLinkURLProtocol.requestBodies()
        XCTAssertEqual(try requests.map { try requestInput(from: $0).method }, [
            "listCollaborators", "listCollaborators", "listShareLinks"
        ])
        XCTAssertEqual(model.newCollaboratorEmail, "collaborator@example.com")
        XCTAssertEqual(model.newCollaboratorRole, "build")
        XCTAssertEqual(model.shareLinkRole, "build")
        XCTAssertEqual(model.redeemKey, "preserve-this-key")
    }

    func testPairedCatalogRemainsUnconfirmedUntilBothReadsSucceed() async throws {
        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let model = makeModel(responses: [
            try resolved(.object(["collaborators": .array([])])),
            ShareLinkHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8)),
            try resolved(.object(["collaborators": .array([])])),
            try resolved(.object(["shareLinks": .array([])]))
        ])

        await model.refresh()

        XCTAssertFalse(model.hasLoadedSharingDetails)
        XCTAssertEqual(
            model.loadErrorMessage,
            "Sharing details couldn’t be loaded. Nothing has been changed. Retry to check collaborators and active links."
        )
        XCTAssertFalse(
            SharePanelViewModel.shouldShowEmptySharingDetails(
                isEmpty: model.collaborators.isEmpty,
                hasLoadedSharingDetails: model.hasLoadedSharingDetails,
                isLoading: model.isLoading,
                loadErrorMessage: model.loadErrorMessage
            )
        )
        XCTAssertEqual(
            try ShareLinkURLProtocol.requestBodies().map { try requestInput(from: $0).method },
            ["listCollaborators", "listShareLinks"]
        )

        await model.refresh()

        XCTAssertTrue(model.hasLoadedSharingDetails)
        XCTAssertNil(model.loadErrorMessage)
        XCTAssertTrue(
            SharePanelViewModel.shouldShowEmptySharingDetails(
                isEmpty: model.collaborators.isEmpty,
                hasLoadedSharingDetails: model.hasLoadedSharingDetails,
                isLoading: model.isLoading,
                loadErrorMessage: model.loadErrorMessage
            )
        )
        XCTAssertEqual(
            try ShareLinkURLProtocol.requestBodies().map { try requestInput(from: $0).method },
            ["listCollaborators", "listShareLinks", "listCollaborators", "listShareLinks"]
        )
    }

    func testSharingDetailsPresentationWaitsForFirstPairResolutionWithoutHidingCachedRows() {
        XCTAssertTrue(
            SharePanelViewModel.shouldShowSharingDetailsLoading(
                hasLoadedSharingDetails: false,
                isLoading: false,
                loadErrorMessage: nil
            )
        )
        XCTAssertTrue(
            SharePanelViewModel.shouldShowSharingDetailsLoading(
                hasLoadedSharingDetails: false,
                isLoading: true,
                loadErrorMessage: "Sharing details couldn’t be loaded."
            )
        )
        XCTAssertFalse(
            SharePanelViewModel.shouldShowSharingDetailsLoading(
                hasLoadedSharingDetails: false,
                isLoading: false,
                loadErrorMessage: "Sharing details couldn’t be loaded."
            )
        )
        XCTAssertFalse(
            SharePanelViewModel.shouldShowSharingDetailsLoading(
                hasLoadedSharingDetails: true,
                isLoading: true,
                loadErrorMessage: nil
            )
        )
        XCTAssertFalse(
            SharePanelViewModel.shouldShowEmptySharingDetails(
                isEmpty: true,
                hasLoadedSharingDetails: false,
                isLoading: false,
                loadErrorMessage: nil
            )
        )
        XCTAssertTrue(
            SharePanelViewModel.shouldShowEmptySharingDetails(
                isEmpty: true,
                hasLoadedSharingDetails: true,
                isLoading: false,
                loadErrorMessage: nil
            )
        )
        XCTAssertFalse(
            SharePanelViewModel.shouldShowEmptySharingDetails(
                isEmpty: true,
                hasLoadedSharingDetails: true,
                isLoading: false,
                loadErrorMessage: "Sharing details couldn’t be loaded."
            )
        )
    }

    func testDetailsRefreshPresentationRejectsRapidDuplicateActionsAndRestoresLoadingState() {
        var isRefreshInFlight = false

        XCTAssertTrue(
            ShareDetailsRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            ShareDetailsRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = true
        XCTAssertFalse(
            ShareDetailsRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            ShareDetailsRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = false
        XCTAssertTrue(
            ShareDetailsRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            ShareDetailsRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            ShareDetailsRefreshPresentation.isLoading(
                isModelLoading: true,
                isRefreshInFlight: isRefreshInFlight
            )
        )
    }

    func testShareMutationPresentationRejectsRapidDuplicateAndCrossActionUntilCompletion() {
        let addCollaborator = ShareMutationAction.addCollaborator
        let createShareLink = ShareMutationAction.createShareLink

        XCTAssertTrue(
            ShareMutationPresentation.canStartMutation(
                pendingAction: nil,
                isModelBusy: false
            )
        )
        XCTAssertFalse(
            ShareMutationPresentation.isMutationBusy(
                pendingAction: nil,
                isModelBusy: false
            )
        )

        XCTAssertFalse(
            ShareMutationPresentation.canStartMutation(
                pendingAction: addCollaborator,
                isModelBusy: false
            )
        )
        XCTAssertFalse(
            ShareMutationPresentation.canStartMutation(
                pendingAction: addCollaborator,
                isModelBusy: true
            )
        )
        XCTAssertTrue(
            ShareMutationPresentation.isMutationBusy(
                pendingAction: addCollaborator,
                isModelBusy: false
            )
        )
        XCTAssertEqual(
            ShareMutationPresentation.actionTitle(
                idleTitle: "Add",
                busyTitle: "Adding…",
                action: addCollaborator,
                pendingAction: addCollaborator
            ),
            "Adding…"
        )
        XCTAssertEqual(
            ShareMutationPresentation.actionTitle(
                idleTitle: "Create link",
                busyTitle: "Creating…",
                action: createShareLink,
                pendingAction: addCollaborator
            ),
            "Create link"
        )

        XCTAssertFalse(
            ShareMutationPresentation.canStartMutation(
                pendingAction: nil,
                isModelBusy: true
            )
        )
        XCTAssertTrue(
            ShareMutationPresentation.isMutationBusy(
                pendingAction: nil,
                isModelBusy: true
            )
        )
        XCTAssertTrue(
            ShareMutationPresentation.canStartMutation(
                pendingAction: nil,
                isModelBusy: false
            )
        )
    }

    func testAddCollaboratorFailurePreservesFormWithoutRefreshingCatalog() async throws {
        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let model = makeModel(responses: [
            ShareLinkHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8))
        ])
        model.newCollaboratorEmail = " collaborator@example.com "
        model.newCollaboratorRole = "build"

        await model.addCollaborator()

        XCTAssertEqual(
            model.errorMessage,
            "We couldn’t confirm that this collaborator was added. The email is still here. Review the list before trying again."
        )
        XCTAssertFalse(model.errorMessage?.contains(privateFailure) ?? true)
        XCTAssertNil(model.loadErrorMessage)
        XCTAssertEqual(model.newCollaboratorEmail, " collaborator@example.com ")
        XCTAssertEqual(model.newCollaboratorRole, "build")
        XCTAssertFalse(model.isBusy)
        XCTAssertTrue(model.collaborators.isEmpty)
        XCTAssertTrue(model.shareLinks.isEmpty)

        let requests = ShareLinkURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 1)
        let request = try requestInput(from: requests[0])
        XCTAssertEqual(request.method, "addCollaborator")
        XCTAssertEqual(request.input["profileId"] as? String, "collaborator@example.com")
        XCTAssertEqual(request.input["role"] as? String, "build")
    }

    func testRedeemFailureRetainsKeyWithoutRefreshingCatalog() async throws {
        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let model = makeModel(responses: [
            ShareLinkHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8))
        ])
        model.redeemKey = " share-key "

        await model.redeemShareLink()

        XCTAssertEqual(
            model.errorMessage,
            "We couldn’t confirm whether this share key was redeemed. The key is still here. Review access before taking another action."
        )
        XCTAssertFalse(model.errorMessage?.contains(privateFailure) ?? true)
        XCTAssertNil(model.loadErrorMessage)
        XCTAssertEqual(model.redeemKey, " share-key ")
        XCTAssertFalse(model.redeemSucceeded)
        XCTAssertFalse(model.isBusy)
        XCTAssertTrue(model.collaborators.isEmpty)
        XCTAssertTrue(model.shareLinks.isEmpty)

        let requests = ShareLinkURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 1)
        let request = try requestInput(from: requests[0])
        XCTAssertEqual(request.method, "redeemShareLink")
        XCTAssertEqual(request.input["key"] as? String, "share-key")
    }

    func testRemovalPreviewFailureDoesNotCreatePendingConfirmation() async throws {
        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let model = makeModel(responses: [
            ShareLinkHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8))
        ])

        await model.previewRemoveCollaborator(profileId: "collaborator@example.com")

        XCTAssertEqual(
            model.errorMessage,
            "We couldn’t inspect this collaborator’s access changes. Review the collaborators and try again."
        )
        XCTAssertFalse(model.errorMessage?.contains(privateFailure) ?? true)
        XCTAssertNil(model.loadErrorMessage)
        XCTAssertNil(model.pendingRemovalProfileId)
        XCTAssertTrue(model.pendingRemovalAffected.isEmpty)
        XCTAssertFalse(model.isBusy)
        XCTAssertTrue(model.collaborators.isEmpty)
        XCTAssertTrue(model.shareLinks.isEmpty)

        let requests = ShareLinkURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 1)
        let request = try requestInput(from: requests[0])
        XCTAssertEqual(request.method, "previewRemoveCollaborator")
        XCTAssertEqual(request.input["profileId"] as? String, "collaborator@example.com")
    }

    func testRemovalFailurePreservesPreviewWithoutRefreshingCatalog() async throws {
        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let profileId = "collaborator@example.com"
        let model = makeModel(responses: [
            try resolved(.object([
                "affected": .array([
                    .object([
                        "profileId": .string("affected@example.com"),
                        "workspaceId": .string(workspaceId),
                        "oldRole": .string("build"),
                        "newRole": .string("use")
                    ])
                ])
            ])),
            ShareLinkHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8))
        ])

        await model.previewRemoveCollaborator(profileId: profileId)
        await model.removeCollaborator(profileId: profileId)

        XCTAssertEqual(
            model.errorMessage,
            "We couldn’t confirm that this collaborator was removed. Review the collaborators before taking another action."
        )
        XCTAssertFalse(model.errorMessage?.contains(privateFailure) ?? true)
        XCTAssertNil(model.loadErrorMessage)
        XCTAssertEqual(model.pendingRemovalProfileId, profileId)
        XCTAssertEqual(model.pendingRemovalAffected.map(\.profileId), ["affected@example.com"])
        XCTAssertFalse(model.isBusy)
        XCTAssertTrue(model.collaborators.isEmpty)
        XCTAssertTrue(model.shareLinks.isEmpty)

        let requests = ShareLinkURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(try requests.map { try requestInput(from: $0).method }, [
            "previewRemoveCollaborator", "removeCollaborator"
        ])
        XCTAssertEqual(try requestInput(from: requests[0]).input["profileId"] as? String, profileId)
        XCTAssertEqual(try requestInput(from: requests[1]).input["profileId"] as? String, profileId)
    }

    func testRevocationPreviewFailureDoesNotCreatePendingConfirmation() async throws {
        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let linkId = String(repeating: "a", count: 64)
        let model = makeModel(responses: [
            ShareLinkHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8))
        ])

        await model.previewRevokeShareLink(linkId: linkId)

        XCTAssertEqual(
            model.errorMessage,
            "We couldn’t inspect this share link’s effects. Review the active links and try again."
        )
        XCTAssertFalse(model.errorMessage?.contains(privateFailure) ?? true)
        XCTAssertNil(model.loadErrorMessage)
        XCTAssertNil(model.pendingRevokeLinkId)
        XCTAssertTrue(model.pendingRevokeAffected.isEmpty)
        XCTAssertFalse(model.isBusy)
        XCTAssertTrue(model.collaborators.isEmpty)
        XCTAssertTrue(model.shareLinks.isEmpty)

        let requests = ShareLinkURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 1)
        let request = try requestInput(from: requests[0])
        XCTAssertEqual(request.method, "previewRevokeShareLink")
        XCTAssertEqual(request.input["linkId"] as? String, linkId)
    }

    func testRevocationFailurePreservesPreviewWithoutRefreshingCatalog() async throws {
        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let linkId = String(repeating: "a", count: 64)
        let model = makeModel(responses: [
            try resolved(.object([
                "affected": .array([
                    .object([
                        "profileId": .string("affected@example.com"),
                        "workspaceId": .string(workspaceId),
                        "oldRole": .string("build"),
                        "newRole": .string("use")
                    ])
                ])
            ])),
            ShareLinkHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8))
        ])

        await model.previewRevokeShareLink(linkId: linkId)
        await model.revokeShareLink(linkId: linkId)

        XCTAssertEqual(
            model.errorMessage,
            "We couldn’t confirm that this share link was revoked. Review the active links before taking another action."
        )
        XCTAssertFalse(model.errorMessage?.contains(privateFailure) ?? true)
        XCTAssertNil(model.loadErrorMessage)
        XCTAssertEqual(model.pendingRevokeLinkId, linkId)
        XCTAssertEqual(model.pendingRevokeAffected.map(\.profileId), ["affected@example.com"])
        XCTAssertFalse(model.isBusy)
        XCTAssertTrue(model.collaborators.isEmpty)
        XCTAssertTrue(model.shareLinks.isEmpty)

        let requests = ShareLinkURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(try requests.map { try requestInput(from: $0).method }, [
            "previewRevokeShareLink", "revokeShareLink"
        ])
        XCTAssertEqual(try requestInput(from: requests[0]).input["linkId"] as? String, linkId)
        XCTAssertEqual(try requestInput(from: requests[1]).input["linkId"] as? String, linkId)
    }

    func testUncertainCreationPreservesRoleWithoutRefreshThenConfirmedCreationMintsAndRefreshes() async throws {
        let privateFailure = "backend=https://internal.example/api?credential=private-token"
        let responses: [ShareLinkHTTPResponse] = [
            ShareLinkHTTPResponse(statusCode: 500, body: Data(privateFailure.utf8)),
            try resolved(.object(["key": .string("confirmed-share-key"), "link": shareLink()])),
            try resolved(.object(["collaborators": .array([])])),
            try resolved(.object(["shareLinks": .array([shareLink()])]))
        ]
        let model = makeModel(responses: responses)
        model.shareLinkRole = "build"

        await model.createShareLink()

        XCTAssertEqual(
            model.errorMessage,
            "We couldn’t confirm that the share link was created. Review active share links before taking another action."
        )
        XCTAssertFalse(model.errorMessage?.contains(privateFailure) ?? true)
        XCTAssertEqual(model.shareLinkRole, "build")
        XCTAssertNil(model.mintedShareKey)
        XCTAssertTrue(model.shareLinks.isEmpty)
        XCTAssertFalse(model.isBusy)
        XCTAssertEqual(ShareLinkURLProtocol.requestBodies().count, 1)
        XCTAssertEqual(try requestInput(from: ShareLinkURLProtocol.requestBodies()[0]).method, "createShareLink")

        await model.createShareLink()

        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.shareLinkRole, "build")
        XCTAssertEqual(model.mintedShareKey, "confirmed-share-key")
        XCTAssertEqual(model.shareLinks.map(\.id), [String(repeating: "a", count: 64)])

        let requests = ShareLinkURLProtocol.requestBodies()
        XCTAssertEqual(requests.count, 4)
        XCTAssertEqual(try requests.map { try requestInput(from: $0).method }, [
            "createShareLink", "createShareLink", "listCollaborators", "listShareLinks"
        ])
        XCTAssertEqual(try requestInput(from: requests[0]).input["role"] as? String, "build")
        XCTAssertEqual(try requestInput(from: requests[1]).input["role"] as? String, "build")
    }
}
