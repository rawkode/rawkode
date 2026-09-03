@_spi(AthenaeumCore) @testable import AthenaeumRPC
import AthenaeumDomain
import Foundation
import XCTest

private final class LoroWireRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requestBodies: [Data] = []
    private var responseBody = Data()

    func reset(responseBody: Data) {
        lock.lock()
        defer { lock.unlock() }
        requestBodies = []
        self.responseBody = responseBody
    }

    func record(_ body: Data) {
        lock.lock()
        defer { lock.unlock() }
        requestBodies.append(body)
    }

    func snapshot() -> (requestBodies: [Data], responseBody: Data) {
        lock.lock()
        defer { lock.unlock() }
        return (requestBodies, responseBody)
    }
}

private final class LoroRecordingURLProtocol: URLProtocol {
    private static let recorder = LoroWireRequestRecorder()

    static func reset(responseBody: Data) {
        recorder.reset(responseBody: responseBody)
    }

    static func requestBodies() -> [Data] {
        recorder.snapshot().requestBodies
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let snapshot = Self.recorder.snapshot()
        Self.recorder.record(requestBody())
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: snapshot.responseBody)
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

final class LoroWireDecoderTests: XCTestCase {
    private let bytes = CapnWebValue.bytes(Data([1, 2]))
    private let digest = String(repeating: "a", count: 64)
    private func start(_ overrides: [String: CapnWebValue] = [:]) -> CapnWebValue { .object(["sessionId": .string("s"), "message": bytes, "serverVersion": bytes].merging(overrides) { $1 }) }
    private func message(_ overrides: [String: CapnWebValue] = [:]) -> CapnWebValue { .object(["sessionId": .string("s"), "ordinal": .number(0), "update": .null, "serverVersion": bytes, "converged": .bool(true), "reset": .bool(false)].merging(overrides) { $1 }) }
    private let nodeId = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    private let workspaceId = "f9ecd920-d30a-4314-9870-3cc80e2efb58"

    private func loroDescriptor(
        nodeId: String? = nil,
        storageVersion: Int = 7,
        schemaVersion: Int = 1,
        snapshotSHA256: String? = nil
    ) -> CapnWebValue {
        .object([
            "nodeId": .string(nodeId ?? self.nodeId),
            "storageVersion": .number(Double(storageVersion)),
            "activeFormat": .string("loro-v1"),
            "loro": .object([
                "schemaVersion": .number(Double(schemaVersion)),
                "snapshotSha256": .string(snapshotSHA256 ?? digest)
            ])
        ])
    }

    private func migratedLoroDescriptor(
        nodeId: String? = nil,
        storageVersion: Int = 2,
        automerge: CapnWebValue? = nil
    ) -> CapnWebValue {
        .object([
            "nodeId": .string(nodeId ?? self.nodeId),
            "storageVersion": .number(Double(storageVersion)),
            "activeFormat": .string("loro-v1"),
            "automerge": automerge ?? .object([
                "docId": .string("legacy-doc"),
                "headsHash": .string("legacy-heads"),
                "bytesSha256": .string("legacy-bytes")
            ]),
            "loro": .object([
                "schemaVersion": .number(1),
                "snapshotSha256": .string(digest)
            ])
        ])
    }

    private func legacyProjection(
        text: String = "",
        content: CapnWebValue? = nil,
        readOnly: Bool = true,
        migrationRequired: Bool = true,
        descriptor: CapnWebValue? = nil
    ) -> CapnWebValue {
        .object([
            "content": content ?? .object(["kind": .string("plainText"), "text": .string(text)]),
            "readOnly": .bool(readOnly),
            "migrationRequired": .bool(migrationRequired),
            "descriptor": descriptor ?? .object([
                "nodeId": .string(nodeId),
                "storageVersion": .number(1),
                "activeFormat": .string("automerge-v1"),
                "automerge": .object([
                    "docId": .string("legacy-doc"),
                    "headsHash": .string("legacy-heads"),
                    "bytesSha256": .string("legacy-bytes")
                ])
            ])
        ])
    }

    private func commitResponse(
        storageVersion: Int = 7,
        descriptor: CapnWebValue? = nil,
        overrides: [String: CapnWebValue] = [:]
    ) -> CapnWebValue {
        .object([
            "descriptor": descriptor ?? loroDescriptor(storageVersion: storageVersion),
            "storageVersion": .number(Double(storageVersion)),
            "resultSnapshotSha256": .string(digest),
            "baseVersionVectorSha256": .string(digest),
            "resultVersionVectorSha256": .string(digest),
            "updateSha256": .string(digest)
        ].merging(overrides) { $1 })
    }

    private func matchingCommitResponse(
        for input: CommitLoroPageContentInput,
        descriptor: CapnWebValue? = nil,
        overrides: [String: CapnWebValue] = [:]
    ) -> CapnWebValue {
        let witnesses: [String: CapnWebValue] = [
            "baseVersionVectorSha256": .string(input.expectedVersionVectorIdentitySHA256),
            "updateSha256": .string(LoroMutationWire.sha256Hex(input.update))
        ]
        return commitResponse(
            storageVersion: input.expectedStorageVersion,
            descriptor: descriptor ?? loroDescriptor(
                nodeId: input.nodeId.rawValue,
                storageVersion: input.expectedStorageVersion
            ),
            overrides: witnesses.merging(overrides) { $1 }
        )
    }

    private func matchingMigrationResponse(
        for input: MigrateLegacyPageInput,
        descriptor: CapnWebValue? = nil
    ) -> CapnWebValue {
        .object(["descriptor": descriptor ?? migratedLoroDescriptor(
            nodeId: input.nodeId.rawValue,
            storageVersion: input.expectedStorageVersion + 1
        )])
    }

    private func decodeLine(_ line: String) throws -> CapnWebValue {
        try CapnWebValue.fromWireJSON(JSONSerialization.jsonObject(with: Data(line.utf8)))
    }

    private func commitInput(workspaceId: String? = nil, expectedStorageVersion: Int = 7) throws -> CommitLoroPageContentInput {
        try CommitLoroPageContentInput(
            workspaceId: try EntityId(validating: workspaceId ?? self.workspaceId),
            nodeId: try EntityId(validating: nodeId),
            intent: try LoroMutationIntentV1(
                requestId: "request-1",
                commitMessage: "Update Loro page",
                attribution: .humanUi(surface: "macos")
            ),
            expectedStorageVersion: expectedStorageVersion,
            expectedSnapshotSHA256: digest,
            expectedVersionVector: Data([1, 2]),
            expectedVersionVectorIdentitySHA256: digest,
            update: Data([3, 4])
        )
    }

    private func migrationInput(workspaceId: String? = nil, expectedStorageVersion: Int = 1) throws -> MigrateLegacyPageInput {
        try MigrateLegacyPageInput(
            workspaceId: try EntityId(validating: workspaceId ?? self.workspaceId),
            nodeId: try EntityId(validating: nodeId),
            expectedStorageVersion: expectedStorageVersion,
            expectedAutomerge: .init(docId: "legacy-doc", headsHash: "legacy-heads", bytesSha256: "legacy-bytes"),
            intent: try LoroMutationIntentV1(
                requestId: "migrate-1",
                commitMessage: "Migrate legacy page",
                attribution: .system(source: "macos-migration")
            )
        )
    }

    private func recordingClient(response: CapnWebValue) throws -> WorkspaceRPCClient {
        let responseLine = try CapnWebValue.encodeMessageLine(["resolve", 1, response.toWireJSON()])
        LoroRecordingURLProtocol.reset(responseBody: Data(responseLine.utf8))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LoroRecordingURLProtocol.self]
        return WorkspaceRPCClient(
            baseURL: URL(string: "http://loro-wire.invalid")!,
            workspaceId: workspaceId,
            urlSession: URLSession(configuration: configuration)
        )
    }

    private func canonicalHTTPBatchFixtureURL() throws -> URL {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let fileManager = FileManager.default

        while directory.path != "/" {
            let fixture = directory.appendingPathComponent("scripts/capnweb-trace/fixtures/canonical-http-batch.ndjson")
            if fileManager.fileExists(atPath: fixture.path) {
                return fixture
            }
            directory.deleteLastPathComponent()
        }

        throw NSError(domain: "LoroWireDecoderTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "canonical Cap'n Web fixture not found"])
    }

    private func conflictEnvelope(_ data: [String: Any], message: String? = "stale") -> String {
        var envelope: [String: Any] = ["tag": "LoroContentConflict", "data": data]
        if let message { envelope["message"] = message }
        return String(data: try! JSONSerialization.data(withJSONObject: envelope), encoding: .utf8)!
    }

    private func validConflictData() -> [String: Any] {
        [
            "nodeId": nodeId,
            "expectedStorageVersion": 1,
            "currentStorageVersion": 2,
            "expectedSnapshotSha256": digest,
            "currentSnapshotSha256": digest,
            "expectedVersionVectorSha256": digest,
            "currentVersionVectorSha256": digest
        ]
    }

    private func semanticCommitRequiredEnvelope(_ data: Any, message: String? = AthenaeumDomain.LORO_SEMANTIC_COMMIT_REQUIRED_MESSAGE) -> String {
        var envelope: [String: Any] = ["tag": "LoroSemanticCommitRequired", "data": data]
        if let message { envelope["message"] = message }
        return String(data: try! JSONSerialization.data(withJSONObject: envelope), encoding: .utf8)!
    }

    private func requestIdentityConflictEnvelope(_ data: Any, message: String? = AthenaeumDomain.LORO_REQUEST_IDENTITY_CONFLICT_MESSAGE) -> String {
        var envelope: [String: Any] = ["tag": "LoroRequestIdentityConflict", "data": data]
        if let message { envelope["message"] = message }
        return String(data: try! JSONSerialization.data(withJSONObject: envelope), encoding: .utf8)!
    }

    private func firstRequestEnvelope(_ body: Data) throws -> [Any] {
        let line = try XCTUnwrap(String(data: body, encoding: .utf8)?.split(separator: "\n").first)
        return try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [Any]
    }

    func testCapturedBytesDecodeAndOnlyUpdateMayBeNull() throws { XCTAssertEqual(try decodeStartLoroPageSyncResponse(start()).message, Data([1,2])); XCTAssertNil(try decodeLoroPageSyncMessageResponse(message()).update) }

    func testCapturedLoroSyncRequestAndResponseUseBytesTags() throws {
        // Raw Cap'n Web NDJSON lines. They exercise the actual `push`/`resolve` envelopes rather
        // than constructing Swift values directly; `bytes` is mandatory for binary fields.
        let request = #"["push",["pipeline",0,["loroPageSyncMessage"],[{"workspaceId":"f9ecd920-d30a-4314-9870-3cc80e2efb58","nodeId":"a9ecd920-d30a-4314-9870-3cc80e2efb58","sessionId":"session-1","ordinal":4,"update":["bytes","AQI"],"clientVersion":["bytes","AwQ"]}]]]"#
        let requestJSON = try JSONSerialization.jsonObject(with: Data(request.utf8)) as! [Any]
        let pipeline = requestJSON[1] as! [Any]
        let arguments = pipeline[3] as! [Any]
        let requestValue = try CapnWebValue.fromWireJSON(arguments[0])
        XCTAssertEqual(try requestValue.field("update").bytesValue, Data([1, 2]))
        XCTAssertEqual(try requestValue.field("clientVersion").bytesValue, Data([3, 4]))

        let response = #"["resolve",1,{"sessionId":"session-1","ordinal":4,"update":["bytes","AQI"],"serverVersion":["bytes","AwQ"],"converged":true,"reset":false}]"#
        let responseJSON = try JSONSerialization.jsonObject(with: Data(response.utf8)) as! [Any]
        XCTAssertEqual(responseJSON[0] as? String, "resolve")
        let decoded = try decodeLoroPageSyncMessageResponse(try CapnWebValue.fromWireJSON(responseJSON[2]))
        XCTAssertEqual(decoded.sessionId, "session-1")
        XCTAssertEqual(decoded.ordinal, 4)
        XCTAssertEqual(decoded.update, Data([1, 2]))
        XCTAssertEqual(decoded.serverVersion, Data([3, 4]))
    }

    func testCanonicalHTTPBatchFixtureMatchesActualClientEmission() async throws {
        let calls = [
            CapnWebCall(method: "startLoroPageSync", args: .object(["fixture": .string("synthetic-start")])),
            CapnWebCall(method: "loroPageSyncMessage", args: .object(["fixture": .string("synthetic-message")])),
            CapnWebCall(method: "getLoroAuthoringAuthority", args: .object(["fixture": .string("synthetic-authority")]))
        ]
        let responseLines = try (1...calls.count)
            .map { try CapnWebValue.encodeMessageLine(["resolve", $0, NSNull()]) }
            .joined(separator: "\n")
        LoroRecordingURLProtocol.reset(responseBody: Data(responseLines.utf8))

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LoroRecordingURLProtocol.self]
        let client = CapnWebBatchClient(
            baseURL: URL(string: "http://loro-wire.invalid")!,
            urlSession: URLSession(configuration: configuration)
        )
        _ = try await client.sendBatch(calls)

        let captured = try XCTUnwrap(LoroRecordingURLProtocol.requestBodies().first)
        let fixture = try Data(contentsOf: canonicalHTTPBatchFixtureURL())
        XCTAssertEqual(captured, fixture)
        let fixtureLines = try XCTUnwrap(String(data: fixture, encoding: .utf8)?.split(separator: "\n").map(String.init))
        XCTAssertEqual(fixtureLines.count, 6)

        let values = try fixtureLines.map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [Any] }
        XCTAssertEqual((values[0][1] as? [Any])?[2] as? [String], ["startLoroPageSync"])
        XCTAssertEqual((values[1][1] as? [Any])?[2] as? [String], ["loroPageSyncMessage"])
        XCTAssertEqual((values[2][1] as? [Any])?[2] as? [String], ["getLoroAuthoringAuthority"])
        for (index, pullId) in (1...3).enumerated() {
            XCTAssertEqual(values[index + 3].first as? String, "pull")
            XCTAssertEqual(values[index + 3][1] as? Int, pullId)
        }

        let fixtureText = try XCTUnwrap(String(data: fixture, encoding: .utf8))
        for forbidden in ["authorization", "bearer", "credential", "token", "snapshot", "content"] {
            XCTAssertFalse(fixtureText.localizedCaseInsensitiveContains(forbidden))
        }
    }

    func testPublicReadSyncAlwaysEncodesAnEmptyUpdate() async throws {
        let client = try recordingClient(response: .object([
            "sessionId": .string("session-1"),
            "ordinal": .number(4),
            "update": .null,
            "serverVersion": .bytes(Data([3, 4])),
            "converged": .bool(true),
            "reset": .bool(false)
        ]))

        _ = try await client.loroPageReadSyncMessage(
            nodeId: "a9ecd920-d30a-4314-9870-3cc80e2efb58",
            sessionId: "session-1",
            ordinal: 4,
            clientVersion: Data([3, 4])
        )

        let body = try XCTUnwrap(LoroRecordingURLProtocol.requestBodies().first)
        let pipeline = try firstRequestEnvelope(body)[1] as! [Any]
        let arguments = pipeline[3] as! [Any]
        let input = try CapnWebValue.fromWireJSON(arguments[0])
        XCTAssertEqual(try input.field("update").bytesValue, Data())
    }

    func testSemanticCommitActualClientEncodesBytesTagsAndSafeReceipt() async throws {
        let requestInput = try commitInput()
        let client = try recordingClient(response: matchingCommitResponse(for: requestInput))
        let receipt = try await client.commitLoroPageContent(requestInput)
        let requestBodies = LoroRecordingURLProtocol.requestBodies()
        XCTAssertEqual(requestBodies.count, 1)
        let request = try XCTUnwrap(requestBodies.first)
        let envelope = try firstRequestEnvelope(request)
        let pipeline = envelope[1] as! [Any]
        XCTAssertEqual(pipeline[2] as? [String], ["commitLoroPageContent"])
        let arguments = pipeline[3] as! [Any]
        let input = try CapnWebValue.fromWireJSON(arguments[0])

        XCTAssertEqual(try input.field("expectedVersionVector").bytesValue, Data([1, 2]))
        XCTAssertEqual(try input.field("update").bytesValue, Data([3, 4]))
        XCTAssertEqual(try input.field("intent").field("attribution").field("kind").stringValue, "humanUi")

        let rawInput = arguments[0] as! [String: Any]
        XCTAssertEqual(rawInput["expectedVersionVector"] as? [String], ["bytes", "AQI"])
        XCTAssertEqual(rawInput["update"] as? [String], ["bytes", "AwQ"])
        XCTAssertNil(rawInput["expectedVersionVectorIdentitySHA256"])

        XCTAssertEqual(receipt.storageVersion, 7)
        XCTAssertEqual(receipt.updateSHA256, LoroMutationWire.sha256Hex(Data([3, 4])))
        XCTAssertFalse(String(describing: receipt).contains("AQI"))
        XCTAssertFalse(String(describing: receipt).contains("AwQ"))
    }

    func testServerDerivedMigrationActualClientEncodesCompleteWitnessWithoutSnapshotBytes() async throws {
        let requestInput = try migrationInput()
        let client = try recordingClient(response: matchingMigrationResponse(for: requestInput))
        let output = try await client.migrateLegacyPage(requestInput)
        XCTAssertEqual(output.descriptor.activeFormat, .loroV1)

        let requestBodies = LoroRecordingURLProtocol.requestBodies()
        XCTAssertEqual(requestBodies.count, 1)
        let request = try XCTUnwrap(requestBodies.first)
        let envelope = try firstRequestEnvelope(request)
        let pipeline = envelope[1] as! [Any]
        XCTAssertEqual(pipeline[2] as? [String], ["migrateLegacyPage"])
        let input = try CapnWebValue.fromWireJSON((pipeline[3] as! [Any])[0])
        guard case .number(let expectedStorageVersion) = try input.field("expectedStorageVersion") else {
            return XCTFail("expected numeric storage version")
        }
        XCTAssertEqual(expectedStorageVersion, 1)
        XCTAssertEqual(try input.field("expectedAutomerge").field("docId").stringValue, "legacy-doc")
        XCTAssertEqual(try input.field("expectedAutomerge").field("headsHash").stringValue, "legacy-heads")
        XCTAssertEqual(try input.field("expectedAutomerge").field("bytesSha256").stringValue, "legacy-bytes")
        XCTAssertEqual(try input.field("intent").field("requestId").stringValue, "migrate-1")
        XCTAssertEqual(try input.field("intent").field("attribution").field("kind").stringValue, "system")
        let rawInput = (pipeline[3] as! [Any])[0] as! [String: Any]
        XCTAssertNil(rawInput["loroSnapshot"])
        XCTAssertNil(rawInput["schemaVersion"])
    }

    func testCommitReceiptBindingRejectsEveryMismatchedWitness() async throws {
        let requestInput = try commitInput()
        let otherNodeId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61"
        let otherDigest = String(repeating: "b", count: 64)
        let cases: [(String, CapnWebValue)] = [
            (
                "commit receipt node mismatch",
                matchingCommitResponse(
                    for: requestInput,
                    descriptor: loroDescriptor(
                        nodeId: otherNodeId,
                        storageVersion: requestInput.expectedStorageVersion
                    )
                )
            ),
            (
                "commit receipt version-vector witness mismatch",
                matchingCommitResponse(
                    for: requestInput,
                    overrides: ["baseVersionVectorSha256": .string(otherDigest)]
                )
            ),
            (
                "commit receipt update witness mismatch",
                matchingCommitResponse(
                    for: requestInput,
                    overrides: ["updateSha256": .string(otherDigest)]
                )
            )
        ]
        for (expectedMessage, response) in cases {
            let client = try recordingClient(response: response)
            do {
                _ = try await client.commitLoroPageContent(requestInput)
                XCTFail("expected \(expectedMessage)")
            } catch let error as CapnWebError {
                XCTAssertEqual(error, .malformedMessage(expectedMessage))
                XCTAssertFalse(expectedMessage.contains("AQI"))
                XCTAssertFalse(expectedMessage.contains("AwQ"))
            }
            XCTAssertEqual(LoroRecordingURLProtocol.requestBodies().count, 1)
        }
    }

    func testMigrationReceiptBindingRejectsEveryMismatchedWitness() async throws {
        let requestInput = try migrationInput()
        let otherNodeId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61"
        let cases: [(String, CapnWebValue)] = [
            (
                "migration receipt node mismatch",
                matchingMigrationResponse(
                    for: requestInput,
                    descriptor: migratedLoroDescriptor(
                        nodeId: otherNodeId,
                        storageVersion: requestInput.expectedStorageVersion + 1
                    )
                )
            ),
            (
                "migration receipt storageVersion must advance",
                matchingMigrationResponse(
                    for: requestInput,
                    descriptor: migratedLoroDescriptor(storageVersion: requestInput.expectedStorageVersion)
                )
            ),
            (
                "migration receipt Automerge witness mismatch",
                matchingMigrationResponse(
                    for: requestInput,
                    descriptor: migratedLoroDescriptor(automerge: .object([
                        "docId": .string("legacy-doc"), "headsHash": .string("changed-heads"), "bytesSha256": .string("legacy-bytes")
                    ]))
                )
            )
        ]
        for (expectedMessage, response) in cases {
            let client = try recordingClient(response: response)
            do {
                _ = try await client.migrateLegacyPage(requestInput)
                XCTFail("expected \(expectedMessage)")
            } catch let error as CapnWebError {
                XCTAssertEqual(error, .malformedMessage(expectedMessage))
                XCTAssertFalse(expectedMessage.contains("BQY"))
            }
            XCTAssertEqual(LoroRecordingURLProtocol.requestBodies().count, 1)
        }
    }

    func testSafeIntegerMaximumEncodesWithoutChangingItsWitness() async throws {
        let maximum = LoroWireSafeInteger.maximum
        let requestInput = try commitInput(expectedStorageVersion: maximum)
        let client = try recordingClient(response: matchingCommitResponse(for: requestInput))
        let receipt = try await client.commitLoroPageContent(requestInput)
        XCTAssertEqual(receipt.storageVersion, maximum)
        let body = try XCTUnwrap(LoroRecordingURLProtocol.requestBodies().first)
        let pipeline = try firstRequestEnvelope(body)[1] as! [Any]
        let input = (pipeline[3] as! [Any])[0] as! [String: Any]
        XCTAssertEqual((input["expectedStorageVersion"] as? NSNumber)?.int64Value, Int64(maximum))
    }

    func testLoroOrdinalRejectsUnsafeValueBeforeTransport() async throws {
        let client = try recordingClient(response: .object([
            "sessionId": .string("session"),
            "ordinal": .number(0),
            "update": .null,
            "serverVersion": .bytes(Data([1])),
            "converged": .bool(true),
            "reset": .bool(false)
        ]))
        do {
            _ = try await client.loroPageSyncMessage(
                nodeId: "node", sessionId: "session",
                ordinal: LoroWireSafeInteger.maximum + 1,
                update: Data([1]), clientVersion: Data([2])
            )
            XCTFail("expected unsafe ordinal rejection")
        } catch let error as CapnWebError {
            XCTAssertEqual(error, .malformedMessage("ordinal must be a safe nonnegative integer"))
        }
        XCTAssertTrue(LoroRecordingURLProtocol.requestBodies().isEmpty)
    }

    func testRequiredFieldsRejectMissingWrongAndNull() { for value in [start(["message": .null]), start(["serverVersion": .string("x")]), message(["sessionId": .null]), message(["converged": .null]), message(["update": .string("x")])] { XCTAssertThrowsError(try { if case .object(let o) = value, o["ordinal"] != nil { _ = try decodeLoroPageSyncMessageResponse(value) } else { _ = try decodeStartLoroPageSyncResponse(value) } }()) } }

    func testMissingUpdateRejectsButExplicitNullIsAccepted() {
        XCTAssertNoThrow(try decodeLoroPageSyncMessageResponse(message(["update": .null])))
        XCTAssertThrowsError(try decodeLoroPageSyncMessageResponse(.object([
            "sessionId": .string("s"), "ordinal": .number(0), "serverVersion": bytes,
            "converged": .bool(true), "reset": .bool(false)
        ])))
    }

    func testOrdinalRejectsFractionalNegativeAndOverflow() {
        XCTAssertThrowsError(try decodeLoroPageSyncMessageResponse(message(["ordinal": .number(0.5)])))
        XCTAssertThrowsError(try decodeLoroPageSyncMessageResponse(message(["ordinal": .number(-1)])))
        XCTAssertThrowsError(try decodeLoroPageSyncMessageResponse(message(["ordinal": .number(Double.greatestFiniteMagnitude)])))
        XCTAssertNoThrow(try decodeLoroPageSyncMessageResponse(message(["ordinal": .number(Double(LoroWireSafeInteger.maximum))])))
        XCTAssertThrowsError(try decodeLoroPageSyncMessageResponse(message(["ordinal": .number(Double(LoroWireSafeInteger.maximum + 1))])))
    }

    func testSemanticLoroIntentRejectsBlankAndIllegalAttribution() {
        XCTAssertThrowsError(try LoroMutationIntentV1(requestId: " ", commitMessage: "meaning", attribution: .humanUi(surface: "macos")))
        XCTAssertThrowsError(try LoroMutationIntentV1(requestId: "id", commitMessage: " ", attribution: .humanUi(surface: "macos")))
        XCTAssertThrowsError(try LoroMutationIntentV1(requestId: "id", commitMessage: "meaning", attribution: .humanUi(surface: "browser-invented")))
        let id = try! EntityId(validating: "01ARZ3NDEKTSV4RRFFQ69G5FAV")
        XCTAssertThrowsError(try CommitLoroPageContentInput(workspaceId: id, nodeId: id, intent: try! LoroMutationIntentV1(requestId: "id", commitMessage: "meaning", attribution: .humanUi(surface: "macos")), expectedStorageVersion: 0, expectedSnapshotSHA256: "A".lowercased(), expectedVersionVector: Data(), expectedVersionVectorIdentitySHA256: String(repeating: "a", count: 64), update: Data()))
    }

    func testLoroContentConflictMapsOnlySafeWitnesses() {
        let message = conflictEnvelope(validConflictData())
        XCTAssertEqual(AthenaeumDomainError.decode(name: "Error", message: message), .loroContentConflict(nodeId: nodeId, expectedStorageVersion: 1, currentStorageVersion: 2, expectedSnapshotSHA256: digest, currentSnapshotSHA256: digest, expectedVersionVectorSHA256: digest, currentVersionVectorSHA256: digest, message: "stale"))
    }

    func testLoroContentConflictRejectsMalformedTrustedFields() {
        let invalids: [[String: Any]] = [
            {
                var data = self.validConflictData(); data.removeValue(forKey: "nodeId"); return data
            }(),
            {
                var data = self.validConflictData(); data["nodeId"] = " "; return data
            }(),
            {
                var data = self.validConflictData(); data["nodeId"] = "not-an-entity"; return data
            }(),
            {
                var data = self.validConflictData(); data["expectedStorageVersion"] = 0; return data
            }(),
            {
                var data = self.validConflictData(); data["currentStorageVersion"] = LoroWireSafeInteger.maximum + 1; return data
            }(),
            {
                var data = self.validConflictData(); data["expectedSnapshotSha256"] = String(repeating: "A", count: 64); return data
            }(),
            {
                var data = self.validConflictData(); data.removeValue(forKey: "currentVersionVectorSha256"); return data
            }()
        ]
        for data in invalids {
            let envelope = conflictEnvelope(data)
            XCTAssertEqual(
                AthenaeumDomainError.decode(name: "Error", message: envelope),
                .unrecognizedRemoteError(name: "Error", message: envelope)
            )
        }
        let emptyMessage = conflictEnvelope(validConflictData(), message: " ")
        XCTAssertEqual(
            AthenaeumDomainError.decode(name: "Error", message: emptyMessage),
            .unrecognizedRemoteError(name: "Error", message: emptyMessage)
        )
        let validation = #"{"tag":"ValidationError","message":"identity conflict","data":{}}"#
        XCTAssertEqual(AthenaeumDomainError.decode(name: "Error", message: validation), .validationError(message: "identity conflict"))
    }

    func testLoroSemanticCommitRequiredDecodesCapturedRemoteError() {
        let message = semanticCommitRequiredEnvelope(["nodeId": nodeId])
        let remote = CapnWebError.remoteError(name: "Error", message: message)
        XCTAssertEqual(
            remote.asDomainError() as? AthenaeumDomainError,
            .loroSemanticCommitRequired(nodeId: nodeId)
        )
    }

    func testLoroSemanticCommitRequiredRejectsMalformedRemoteEnvelopes() {
        let invalids = [
            semanticCommitRequiredEnvelope(["nodeId": nodeId], message: "wrong"),
            semanticCommitRequiredEnvelope([:]),
            semanticCommitRequiredEnvelope(["nodeId": "not-an-entity"]),
            semanticCommitRequiredEnvelope(["nodeId": nodeId, "content": "forbidden"]),
            semanticCommitRequiredEnvelope([]),
            semanticCommitRequiredEnvelope(["nodeId": nodeId], message: nil),
            #"{"tag":"LoroSemanticCommitRequired","message":"Loro page content updates must use commitLoroPageContent.","data":{"nodeId":"a9ecd920-d30a-4314-9870-3cc80e2efb58"},"content":"forbidden"}"#,
            #"{"tag":"LoroSemanticCommitRequired","message":"Loro page content updates must use commitLoroPageContent.","data":{"nodeId":"a9ecd920-d30a-4314-9870-3cc80e2efb58"},"actor":"forbidden"}"#,
            #"{"tag":"LoroSemanticCommitRequired","message":"Loro page content updates must use commitLoroPageContent.","data":{"nodeId":"a9ecd920-d30a-4314-9870-3cc80e2efb58"},"bytes":"forbidden"}"#
        ]
        for message in invalids {
            XCTAssertEqual(
                AthenaeumDomainError.decode(name: "Error", message: message),
                .unrecognizedRemoteError(name: "Error", message: message)
            )
        }
    }

    func testLoroRequestIdentityConflictDecodesCapturedRemoteError() {
        let message = requestIdentityConflictEnvelope(["nodeId": nodeId, "requestId": "semantic-commit"])
        let remote = CapnWebError.remoteError(name: "Error", message: message)
        XCTAssertEqual(
            remote.asDomainError() as? AthenaeumDomainError,
            .loroRequestIdentityConflict(nodeId: nodeId, requestId: "semantic-commit")
        )
    }

    func testLoroRequestIdentityConflictRejectsMalformedRemoteEnvelopes() {
        let invalids = [
            requestIdentityConflictEnvelope(["nodeId": nodeId, "requestId": "semantic-commit"], message: "wrong"),
            requestIdentityConflictEnvelope([:]),
            requestIdentityConflictEnvelope(["nodeId": "not-an-entity", "requestId": "semantic-commit"]),
            requestIdentityConflictEnvelope(["nodeId": nodeId, "requestId": " "]),
            requestIdentityConflictEnvelope(["nodeId": nodeId, "requestId": " semantic-commit "]),
            requestIdentityConflictEnvelope(["nodeId": nodeId, "requestId": "semantic-commit", "content": "forbidden"]),
            requestIdentityConflictEnvelope(["nodeId": nodeId]),
            #"{"tag":"LoroRequestIdentityConflict","message":"Loro request identity was already used for a different command.","data":{"nodeId":"a9ecd920-d30a-4314-9870-3cc80e2efb58","requestId":"semantic-commit"},"bytes":"forbidden"}"#
        ]
        for message in invalids {
            XCTAssertEqual(
                AthenaeumDomainError.decode(name: "Error", message: message),
                .unrecognizedRemoteError(name: "Error", message: message)
            )
        }
    }

    func testLoroRequestIdentityConflictUsesTypeScriptUTF16RequestIdLimit() {
        let accepted = requestIdentityConflictEnvelope(["nodeId": nodeId, "requestId": String(repeating: "😀", count: 100)])
        let rejected = requestIdentityConflictEnvelope(["nodeId": nodeId, "requestId": String(repeating: "😀", count: 101)])
        XCTAssertEqual(
            AthenaeumDomainError.decode(name: "Error", message: accepted),
            .loroRequestIdentityConflict(nodeId: nodeId, requestId: String(repeating: "😀", count: 100))
        )
        XCTAssertEqual(
            AthenaeumDomainError.decode(name: "Error", message: rejected),
            .unrecognizedRemoteError(name: "Error", message: rejected)
        )
    }

    func testLoroRequestIdentityConflictRejectsBOMWrappedRequestId() {
        for requestId in ["\u{FEFF}semantic", "semantic\u{FEFF}"] {
            let message = requestIdentityConflictEnvelope(["nodeId": nodeId, "requestId": requestId])
            XCTAssertFalse(AthenaeumDomain.isECMAScriptTrimmed(requestId))
            XCTAssertEqual(
                AthenaeumDomainError.decode(name: "Error", message: message),
                .unrecognizedRemoteError(name: "Error", message: message)
            )
        }
    }

    func testSemanticCommitReceiptRejectsMalformedFields() {
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(.object([:])))
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(commitResponse(overrides: ["storageVersion": .null])))
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(commitResponse(overrides: ["storageVersion": .number(7.5)])))
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(commitResponse(overrides: ["resultSnapshotSha256": .string(String(repeating: "A", count: 64))])))
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(commitResponse(overrides: ["updateSha256": .bytes(Data([1]))])))
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(commitResponse(overrides: ["descriptor": .null])))
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(commitResponse(overrides: ["storageVersion": .number(8)])))
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(commitResponse(
            descriptor: .object([
                "nodeId": .string(nodeId),
                "storageVersion": .number(7),
                "activeFormat": .string("automerge-v1"),
                "automerge": .object(["docId": .string("doc"), "headsHash": .string("heads"), "bytesSha256": .string("bytes")])
            ])
        )))
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(commitResponse(
            descriptor: loroDescriptor(snapshotSHA256: String(repeating: "b", count: 64))
        )))
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(commitResponse(
            descriptor: loroDescriptor(snapshotSHA256: "not-a-digest")
        )))
        XCTAssertNoThrow(try decodeCommitLoroPageContentResponse(commitResponse(storageVersion: LoroWireSafeInteger.maximum)))
        XCTAssertThrowsError(try decodeCommitLoroPageContentResponse(commitResponse(storageVersion: LoroWireSafeInteger.maximum + 1)))
    }

    func testMigrationReceiptRejectsMissingOrLegacyDescriptor() {
        XCTAssertThrowsError(try decodeMigrateLegacyPageResponse(.object([:])))
        XCTAssertThrowsError(try decodeMigrateLegacyPageResponse(.object([
            "descriptor": .object([
                "nodeId": .string(nodeId),
                "storageVersion": .number(1),
                "activeFormat": .string("automerge-v1"),
                "automerge": .object(["docId": .string("doc"), "headsHash": .string("heads"), "bytesSha256": .string("bytes")])
            ])
        ])))
    }

    func testLegacyProjectionDecoderAcceptsEmptyTextAndFailsClosed() throws {
        let projection = try decodeLegacyPageProjectionResponse(legacyProjection())
        XCTAssertEqual(projection.content, .plainText(""))
        XCTAssertTrue(projection.readOnly)
        XCTAssertTrue(projection.migrationRequired)
        XCTAssertThrowsError(try decodeLegacyPageProjectionResponse(legacyProjection(readOnly: false)))
        XCTAssertThrowsError(try decodeLegacyPageProjectionResponse(legacyProjection(migrationRequired: false)))
        XCTAssertThrowsError(try decodeLegacyPageProjectionResponse(legacyProjection(descriptor: loroDescriptor())))
        XCTAssertThrowsError(try decodeLegacyPageProjectionResponse(.object([:])))
        XCTAssertEqual(
            try decodeLegacyPageProjectionResponse(legacyProjection(content: .object(["kind": .string("richTextUnsupported")]))).content,
            .richTextUnsupported
        )
        XCTAssertEqual(
            try decodeLegacyPageProjectionResponse(legacyProjection(content: .object(["kind": .string("tooLarge")]))).content,
            .tooLarge
        )
        XCTAssertThrowsError(try decodeLegacyPageProjectionResponse(legacyProjection(content: .object([
            "kind": .string("richTextUnsupported"), "text": .string("hidden raw text")
        ]))))
    }

    func testSemanticIntentCanonicalizesEverySemanticString() throws {
        let intent = try LoroMutationIntentV1(requestId: " request ", commitMessage: " commit ", attribution: .agentJob(jobId: " job ", runId: " run "))
        XCTAssertEqual(intent.requestId, "request")
        XCTAssertEqual(intent.commitMessage, "commit")
        XCTAssertEqual(intent.attribution, .agentJob(jobId: "job", runId: "run"))
        XCTAssertFalse(LoroMutationWire.isDigest(String(repeating: "١", count: 64)))
        let surrogatePair = String(repeating: "😀", count: 100)
        XCTAssertNoThrow(try LoroMutationIntentV1(requestId: surrogatePair, commitMessage: String(repeating: "😀", count: 250), attribution: .system(source: surrogatePair)))
        XCTAssertThrowsError(try LoroMutationIntentV1(requestId: String(repeating: "😀", count: 101), commitMessage: "commit", attribution: .humanUi(surface: "macos")))
        XCTAssertThrowsError(try LoroMutationIntentV1(requestId: "request", commitMessage: String(repeating: "😀", count: 251), attribution: .humanUi(surface: "macos")))
        XCTAssertThrowsError(try LoroMutationIntentV1(requestId: "request", commitMessage: "commit", attribution: .agentJob(jobId: String(repeating: "😀", count: 101), runId: "run")))
        XCTAssertThrowsError(try LoroMutationIntentV1(requestId: "request", commitMessage: "commit", attribution: .system(source: String(repeating: "😀", count: 101))))
    }

    func testSemanticCommitWorkspaceMismatchDoesNotReachTransport() async throws {
        let client = try recordingClient(response: commitResponse())
        let mismatchedWorkspaceId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61"
        do {
            _ = try await client.commitLoroPageContent(try commitInput(workspaceId: mismatchedWorkspaceId))
            XCTFail("expected client/input workspace mismatch")
        } catch let error as LoroMutationWireError {
            XCTAssertEqual(error, .workspaceMismatch)
        }
        XCTAssertTrue(LoroRecordingURLProtocol.requestBodies().isEmpty)
    }

    func testServerDerivedMigrationWorkspaceMismatchDoesNotReachTransport() async throws {
        let client = try recordingClient(response: .object(["descriptor": loroDescriptor()]))
        let mismatchedWorkspaceId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61"
        do {
            _ = try await client.migrateLegacyPage(try migrationInput(workspaceId: mismatchedWorkspaceId))
            XCTFail("expected client/input workspace mismatch")
        } catch let error as LoroMutationWireError {
            XCTAssertEqual(error, .workspaceMismatch)
        }
        XCTAssertTrue(LoroRecordingURLProtocol.requestBodies().isEmpty)
    }

    func testPublicLoroReadMethodsRejectEmptyRequiredIdentifiersBeforeTransport() async {
        let client = WorkspaceRPCClient(
            baseURL: URL(string: "http://127.0.0.1:9")!,
            workspaceId: "f9ecd920-d30a-4314-9870-3cc80e2efb58"
        )

        do {
            _ = try await client.startLoroPageSync(nodeId: "", sessionId: "session")
            XCTFail("expected local nodeId validation")
        } catch let error as CapnWebError {
            XCTAssertEqual(error, .malformedMessage("missing/invalid nodeId"))
        } catch {
            XCTFail("unexpected error \(error)")
        }

        do {
            _ = try await client.loroPageReadSyncMessage(
                nodeId: "node", sessionId: "", ordinal: 0, clientVersion: Data()
            )
            XCTFail("expected local sessionId validation")
        } catch let error as CapnWebError {
            XCTAssertEqual(error, .malformedMessage("missing/invalid sessionId"))
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}
