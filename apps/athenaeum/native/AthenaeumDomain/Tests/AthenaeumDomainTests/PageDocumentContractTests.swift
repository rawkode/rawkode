import XCTest
@testable import AthenaeumDomain

final class PageDocumentContractTests: XCTestCase {
    private let nodeId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"

    func testAllLegalDescriptorVariantsRoundTrip() throws {
        let automerge = #"{"docId":"doc","headsHash":"heads","bytesSha256":"bytes"}"#
        let loro = #"{"schemaVersion":1,"snapshotSha256":"snapshot"}"#
        let variants = [
            #"{"nodeId":"\#(nodeId)","storageVersion":1,"activeFormat":"automerge-v1","automerge":\#(automerge)}"#,
            #"{"nodeId":"\#(nodeId)","storageVersion":2,"activeFormat":"loro-v1","automerge":\#(automerge),"loro":\#(loro)}"#,
            #"{"nodeId":"\#(nodeId)","storageVersion":3,"activeFormat":"loro-v1","loro":\#(loro)}"#
        ]
        for json in variants {
            let descriptor = try JSONDecoder().decode(PageDocumentDescriptor.self, from: Data(json.utf8))
            try assertRoundTrips(descriptor)
        }
    }

    func testIllegalDescriptorPresenceAndWitnessesFailClosed() {
        let invalid = [
            #"{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","storageVersion":1,"activeFormat":"automerge-v1","automerge":{"docId":"d","headsHash":"h","bytesSha256":"b"},"loro":null}"#,
            #"{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","storageVersion":1,"activeFormat":"automerge-v1","automerge":{"docId":"d","headsHash":"h","bytesSha256":"b"},"loro":{"schemaVersion":1,"snapshotSha256":"s"}}"#,
            #"{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","storageVersion":1,"activeFormat":"loro-v1","automerge":null,"loro":{"schemaVersion":1,"snapshotSha256":"s"}}"#,
            #"{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","storageVersion":1,"activeFormat":"automerge-v1","automerge":{"docId":"d","headsHash":"h"}}"#,
            #"{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","storageVersion":1,"activeFormat":"loro-v1","loro":{"schemaVersion":1}}"#,
            #"{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","storageVersion":0,"activeFormat":"loro-v1","loro":{"schemaVersion":1,"snapshotSha256":"s"}}"#,
            #"{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","storageVersion":1,"activeFormat":"loro-v1","loro":{"schemaVersion":0,"snapshotSha256":"s"}}"#,
            #"{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","storageVersion":1,"activeFormat":"loro-v1","loro":{"schemaVersion":1,"snapshotSha256":""}}"#,
            #"{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","storageVersion":1,"activeFormat":"automerge-v1","automerge":{"docId":"","headsHash":"h","bytesSha256":"b"}}"#
        ]
        for json in invalid {
            XCTAssertThrowsError(try JSONDecoder().decode(PageDocumentDescriptor.self, from: Data(json.utf8)), json)
        }
    }

    func testLoroRpcModelsRoundTripIncludingOptionalUpdate() throws {
        let workspace = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let node = try EntityId(validating: nodeId)
        try assertRoundTrips(StartLoroPageSyncInput(workspaceId: workspace, nodeId: node, sessionId: "session"))
        try assertRoundTrips(StartLoroPageSyncOutput(sessionId: "session", message: Data([1]), serverVersion: Data([2])))
        try assertRoundTrips(LoroPageSyncMessageInput(workspaceId: workspace, nodeId: node, sessionId: "session", ordinal: 0, update: Data([3]), clientVersion: Data([4])))
        try assertRoundTrips(LoroPageSyncMessageOutput(sessionId: "session", ordinal: 1, update: nil, serverVersion: Data([5]), converged: true, reset: false))
    }

    func testLegacyProjectionRequiresAReadOnlyLegacyDescriptor() throws {
        let workspace = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let node = try EntityId(validating: nodeId)
        let descriptor = PageDocumentDescriptor.legacy(
            nodeId: node,
            storageVersion: 1,
            automerge: AutomergePageDocumentDescriptor(docId: "doc", headsHash: "heads", bytesSha256: "bytes")
        )
        let projection = try GetLegacyPageProjectionOutput(
            content: .plainText(""), descriptor: descriptor, readOnly: true, migrationRequired: true
        )
        try assertRoundTrips(GetLegacyPageProjectionInput(workspaceId: workspace, nodeId: node))
        try assertRoundTrips(projection)
        XCTAssertThrowsError(try GetLegacyPageProjectionOutput(
            content: .plainText("legacy"), descriptor: descriptor, readOnly: false, migrationRequired: true
        ))
        XCTAssertThrowsError(try GetLegacyPageProjectionOutput(
            content: .plainText("legacy"),
            descriptor: .nativeLoro(nodeId: node, storageVersion: 1, loro: LoroPageDocumentDescriptor(schemaVersion: 1, snapshotSha256: "snapshot")),
            readOnly: true,
            migrationRequired: true
        ))
        let invalidWire = #"{"content":{"kind":"plainText","text":"legacy"},"readOnly":false,"migrationRequired":true,"descriptor":{"nodeId":"\#(nodeId)","storageVersion":1,"activeFormat":"automerge-v1","automerge":{"docId":"doc","headsHash":"heads","bytesSha256":"bytes"}}}"#
        XCTAssertThrowsError(try JSONDecoder().decode(GetLegacyPageProjectionOutput.self, from: Data(invalidWire.utf8)))

        try assertRoundTrips(try GetLegacyPageProjectionOutput(content: .richTextUnsupported, descriptor: descriptor, readOnly: true, migrationRequired: true))
        try assertRoundTrips(try GetLegacyPageProjectionOutput(content: .tooLarge, descriptor: descriptor, readOnly: true, migrationRequired: true))
        XCTAssertThrowsError(try JSONDecoder().decode(
            LegacyPageProjectionContent.self,
            from: Data(#"{"kind":"richTextUnsupported","text":"must not leak"}"#.utf8)
        ))
        XCTAssertThrowsError(try JSONEncoder().encode(
            LegacyPageProjectionContent.plainText(String(repeating: "a", count: LegacyPageProjectionContent.maximumPlainTextUTF8Bytes + 1))
        ))
    }

    func testSemanticLoroCommitMatchesC1BoundsAndCanonicalization() throws {
        let workspace = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let node = try EntityId(validating: nodeId)
        let hash = String(repeating: "a", count: 64)
        let intent = try LoroMutationIntentV1(
            requestId: " request ",
            commitMessage: " commit ",
            attribution: .system(source: " native ")
        )
        XCTAssertEqual(intent.requestId, "request")
        XCTAssertEqual(intent.commitMessage, "commit")
        XCTAssertEqual(intent.attribution, .system(source: "native"))
        XCTAssertNoThrow(try CommitLoroPageContentInput(
            workspaceId: workspace, nodeId: node, intent: intent, expectedStorageVersion: 1,
            expectedSnapshotSHA256: hash, expectedVersionVector: Data([1]), expectedVersionVectorIdentitySHA256: hash, update: Data([2])
        ))
        XCTAssertNoThrow(try CommitLoroPageContentInput(
            workspaceId: workspace, nodeId: node, intent: intent,
            expectedStorageVersion: LoroWireSafeInteger.maximum,
            expectedSnapshotSHA256: hash, expectedVersionVector: Data([1]), expectedVersionVectorIdentitySHA256: hash, update: Data([2])
        ))
        XCTAssertThrowsError(try CommitLoroPageContentInput(
            workspaceId: workspace, nodeId: node, intent: intent,
            expectedStorageVersion: LoroWireSafeInteger.maximum + 1,
            expectedSnapshotSHA256: hash, expectedVersionVector: Data([1]), expectedVersionVectorIdentitySHA256: hash, update: Data([2])
        ))
        XCTAssertThrowsError(try CommitLoroPageContentInput(
            workspaceId: workspace, nodeId: node, intent: intent, expectedStorageVersion: 1,
            expectedSnapshotSHA256: String(repeating: "A", count: 64), expectedVersionVector: Data([1]), expectedVersionVectorIdentitySHA256: hash, update: Data([2])
        ))
        XCTAssertThrowsError(try CommitLoroPageContentInput(
            workspaceId: workspace, nodeId: node, intent: intent, expectedStorageVersion: 1,
            expectedSnapshotSHA256: hash, expectedVersionVector: Data([1]), expectedVersionVectorIdentitySHA256: String(repeating: "A", count: 64), update: Data([2])
        ))
        XCTAssertFalse(LoroMutationWire.isDigest(String(repeating: "١", count: 64)))
        XCTAssertEqual(
            LoroMutationWire.sha256Hex(Data()),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )

        let surrogatePair = String(repeating: "😀", count: 100)
        XCTAssertNoThrow(try LoroMutationIntentV1(
            requestId: surrogatePair,
            commitMessage: String(repeating: "😀", count: 250),
            attribution: .agentJob(jobId: surrogatePair, runId: surrogatePair)
        ))
        XCTAssertThrowsError(try LoroMutationIntentV1(
            requestId: String(repeating: "😀", count: 101),
            commitMessage: "commit",
            attribution: .humanUi(surface: "macos")
        ))
        XCTAssertThrowsError(try LoroMutationIntentV1(
            requestId: "request",
            commitMessage: "commit",
            attribution: .system(source: String(repeating: "😀", count: 101))
        ))
        XCTAssertEqual(
            try LoroMutationIntentV1(
                requestId: "\u{FEFF}semantic\u{FEFF}",
                commitMessage: "commit",
                attribution: .humanUi(surface: "macos")
            ).requestId,
            "semantic"
        )
        XCTAssertEqual(
            trimECMAScriptWhitespace("\u{2028}\u{00A0}\u{FEFF}semantic\u{FEFF}\u{00A0}\u{2028}"),
            "semantic"
        )
    }

    func testLoroCommitMessageUsesECMAScriptWhitespaceAndUTF16Boundary() throws {
        XCTAssertEqual(try LoroCommitMessageV1("\u{2028}\u{00A0}\u{FEFF} message \u{FEFF}\u{00A0}\u{2028}").value, "message")
        XCTAssertEqual((try LoroCommitMessageV1(String(repeating: "😀", count: 250))).value.utf16.count, 500)
        XCTAssertThrowsError(try LoroCommitMessageV1(String(repeating: "😀", count: 251)))
        XCTAssertThrowsError(try LoroCommitMessageV1("\u{00A0}\u{FEFF}\n"))
    }

    func testServerDerivedMigrationRequiresCanonicalIntentAndCompleteWitness() throws {
        let workspace = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let node = try EntityId(validating: nodeId)
        let intent = try LoroMutationIntentV1(
            requestId: " migration-request ",
            commitMessage: " migrate legacy page ",
            attribution: .system(source: " native ")
        )
        let input = try MigrateLegacyPageInput(
            workspaceId: workspace,
            nodeId: node,
            expectedStorageVersion: LoroWireSafeInteger.maximum,
            expectedAutomerge: .init(docId: "doc", headsHash: "heads", bytesSha256: "bytes"),
            intent: intent
        )
        XCTAssertEqual(input.intent.requestId, "migration-request")
        XCTAssertEqual(input.intent.commitMessage, "migrate legacy page")
        XCTAssertThrowsError(try MigrateLegacyPageInput(
            workspaceId: workspace,
            nodeId: node,
            expectedStorageVersion: LoroWireSafeInteger.maximum + 1,
            expectedAutomerge: .init(docId: "doc", headsHash: "heads", bytesSha256: "bytes"),
            intent: intent
        ))
        XCTAssertThrowsError(try MigrateLegacyPageInput(
            workspaceId: workspace,
            nodeId: node,
            expectedStorageVersion: 1,
            expectedAutomerge: .init(docId: "", headsHash: "heads", bytesSha256: "bytes"),
            intent: intent
        ))
    }

    func testCreationIntentCanonicalizesRequestIdLikeThePublicTypeScriptWire() {
        let intent = CreationIntent(
            requestId: " \n native-loro-request \t ",
            commitMessage: "Create native Loro page",
            attribution: MutationAttribution(kind: "humanUi", surface: "rich-text-editor")
        )
        XCTAssertEqual(intent.requestId, "native-loro-request")
    }

    func testPageFormatMismatchEnvelopeRoundTripsExactly() {
        let error = DomainError.pageFormatMismatch(nodeId: "n1", expected: .loroV1, actual: .automergeV1)
        XCTAssertEqual(decodeRpcError(encodeRpcError(error)), error)
    }
}
