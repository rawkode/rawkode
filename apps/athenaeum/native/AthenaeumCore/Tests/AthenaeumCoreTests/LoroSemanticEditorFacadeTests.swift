import XCTest
import Loro
import AthenaeumDomain
import AthenaeumRPC
@testable import AthenaeumCore

final class LoroSemanticEditorFacadeTests: XCTestCase {
    func testNormalConsumerCanCompileRichValueOnlyFacade() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let temporary = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("athenaeum-core-rich-public-surface-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary.appendingPathComponent("Sources/Consumer"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let domain = root.deletingLastPathComponent().appendingPathComponent("AthenaeumDomain")
        let package = """
        // swift-tools-version:5.9
        import PackageDescription
        let package = Package(name: "Consumer", platforms: [.macOS(.v13)], dependencies: [.package(path: "\(root.path)"), .package(path: "\(domain.path)")], targets: [.executableTarget(name: "Consumer", dependencies: [.product(name: "AthenaeumCore", package: "AthenaeumCore"), .product(name: "AthenaeumDomain", package: "AthenaeumDomain")])])
        """
        let source = """
        import AthenaeumCore
        import AthenaeumDomain
        func edit(_ client: WorkspaceSyncClient, node: EntityId) async throws {
            let proposal = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([.init(text: "value")])]))
            if case let .editable(base) = try await client.loroNativeRichEditorEligibility(nodeId: node) {
                _ = try await client.submitNativeRichDocumentV1(nodeId: node, base: base, proposed: proposal, commitMessage: "consumer edit")
            }
            _ = try await client.recoverAcceptedLoroRichLiteralForEditing(nodeId: node)
        }
        """
        try package.write(to: temporary.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)
        try source.write(to: temporary.appendingPathComponent("Sources/Consumer/main.swift"), atomically: true, encoding: .utf8)
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["swift", "build"]; process.currentDirectoryURL = temporary
        try process.run(); process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        let removedOverload = source.replacingOccurrences(of: ", commitMessage: \"consumer edit\"", with: "")
        try removedOverload.write(to: temporary.appendingPathComponent("Sources/Consumer/main.swift"), atomically: true, encoding: .utf8)
        let oldProcess = Process(); oldProcess.executableURL = URL(fileURLWithPath: "/usr/bin/env"); oldProcess.arguments = ["swift", "build"]; oldProcess.currentDirectoryURL = temporary
        try oldProcess.run(); oldProcess.waitUntilExit()
        XCTAssertNotEqual(oldProcess.terminationStatus, 0, "the former no-message rich overload must not remain public")
    }

    func testRichFacadeAdmitsPlainLiteralAsCanonicalParagraphAndSubmitsValueOnlyDocument() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        guard case let .editable(base) = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node) else { return XCTFail("rich facade must admit a plain literal as a canonical paragraph") }
        XCTAssertEqual(base.document.semantic, .init(blocks: [.paragraph([])]))

        let proposed = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .heading(level: 2, runs: [.init(text: "Heading", marks: [.strong])]),
            .paragraph([.init(text: "body", marks: [.emphasis])])
        ]))
        await fixture.fake.acceptSubmittedIntent()
        let result = try await client.submitNativeRichDocumentV1(nodeId: fixture.node, base: base, proposed: proposed, commitMessage: "  Rich edit  ")
        XCTAssertEqual(result, .submitted)
        let calls = await fixture.fake.calls()
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].intent.commitMessage, "Rich edit")
        XCTAssertEqual(calls[0].intent.attribution, .humanUi(surface: "macos"))
        XCTAssertFalse(calls[0].intent.requestId.isEmpty)
    }

    func testAcceptedRichPlainResultRecoversThenSupportsNextPlainEdit() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        guard case let .editable(richBase) = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node) else {
            return XCTFail("fixture must begin rich-editable")
        }

        await fixture.fake.acceptSubmittedIntent()
        let richResult = try await client.submitNativeRichDocumentV1(
            nodeId: fixture.node,
            base: richBase,
            proposed: .init(semantic: .init(blocks: [.paragraph([.init(text: "rich plain")])])),
            commitMessage: "rich plain"
        )
        XCTAssertEqual(richResult, .submitted)

        await fixture.documents.invalidateLiteralCache(nodeId: fixture.node)
        guard case .editable = try await client.recoverAcceptedLoroRichLiteralForEditing(nodeId: fixture.node) else {
            return XCTFail("accepted rich evidence must explicitly recover literal authority")
        }
        guard case let .editable(plainBase) = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node) else {
            return XCTFail("recovered canonical paragraph must support the next plain edit")
        }

        await fixture.fake.acceptSubmittedIntent()
        let plainResult = try await client.submitNativePlainText(nodeId: fixture.node, base: plainBase, proposedText: "rich plain!")
        XCTAssertEqual(plainResult, .submitted)
    }

    func testRichFacadeRejectsStaleAndInvalidValuesBeforeCandidateOrTransport() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        guard case let .editable(base) = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node) else { return XCTFail("fixture must be rich editable") }
        let stale = LoroNativeRichEditorState(document: base.document, route: .init(nodeId: base.route.nodeId, format: base.route.format, storageVersion: base.route.storageVersion + 1, schemaVersion: base.route.schemaVersion, snapshotSHA256: base.route.snapshotSHA256), replica: base.replica)
        let valid = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([.init(text: "changed")])]))
        let staleResult = try await client.submitNativeRichDocumentV1(nodeId: fixture.node, base: stale, proposed: valid, commitMessage: "edit")
        XCTAssertEqual(staleResult, .staleEditorState)
        let malformed = LoroNativeRichDocumentV1(semantic: .init(blocks: [.heading(level: 4, runs: [.init(text: "bad")])]))
        let malformedResult = try await client.submitNativeRichDocumentV1(nodeId: fixture.node, base: base, proposed: malformed, commitMessage: "edit")
        XCTAssertEqual(malformedResult, .invalidProposedDocument)
        let calls = await fixture.fake.calls()
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertTrue(calls.isEmpty)
        XCTAssertNil(checkpoint)
    }

    func testRichFacadeRejectsLineBreakRunsBeforeCandidateCheckpointOrTransport() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        guard case let .editable(base) = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node) else { return XCTFail("fixture must be rich editable") }
        let pageBefore = try await fixture.local.loroPage(nodeId: fixture.node)

        for separator in ["\n", "\r"] {
            let invalid = LoroNativeRichDocumentV1(semantic: .init(blocks: [
                .heading(level: 1, runs: [.init(text: "before\(separator)after", marks: [.strong])])
            ]))
            let result = try await client.submitNativeRichDocumentV1(nodeId: fixture.node, base: base, proposed: invalid, commitMessage: "reject line break")
            let pageAfter = try await fixture.local.loroPage(nodeId: fixture.node)
            let checkpointAfter = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
            let candidateAfter = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
            let calls = await fixture.fake.calls()
            XCTAssertEqual(result, .invalidProposedDocument)
            XCTAssertEqual(pageAfter, pageBefore)
            XCTAssertNil(checkpointAfter)
            XCTAssertNil(candidateAfter)
            XCTAssertTrue(calls.isEmpty)
        }
    }

    func testPersistedRichLineBreakLiteralIsIneligibleWithoutMutation() async throws {
        for (index, separator) in ["\n", "\r"].enumerated() {
            let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
            let snapshot = try deterministicNativeLiteralSnapshot(
                text: "before\(separator)after",
                blockName: "heading",
                headingLevel: 1,
                peer: 700_001 + UInt64(index)
            )

            do {
                _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: snapshot)
                XCTFail("rich literal with a text-run line break must not be admitted")
            } catch {
                XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativeRichTextIneligible)
            }

            let persisted = try await deterministicPersistedLocalState(fixture, snapshot: snapshot)
            do {
                _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: persisted.snapshotBytes)
                XCTFail("persisted rich literal with a text-run line break must not be admitted")
            } catch {
                XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativeRichTextIneligible)
            }
            try await fixture.local.upsertLoroPage(persisted)
            let before = try await fixture.local.loroPage(nodeId: fixture.node)
            let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
            let result = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node)
            let after = try await fixture.local.loroPage(nodeId: fixture.node)
            let checkpointAfter = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
            let candidateAfter = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
            let calls = await fixture.fake.calls()

            XCTAssertEqual(result, .ineligible)
            XCTAssertEqual(after, before)
            XCTAssertNil(checkpointAfter)
            XCTAssertNil(candidateAfter)
            XCTAssertTrue(calls.isEmpty)
        }
    }

    func testPersistedPlainShapedLineBreakLiteralIsIneligibleWithoutMutation() async throws {
        for (index, separator) in ["\n", "\r"].enumerated() {
            let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
            let snapshot = try deterministicNativeLiteralSnapshot(
                text: "before\(separator)after",
                blockName: "paragraph",
                headingLevel: nil,
                peer: 700_101 + UInt64(index)
            )
            do {
                _ = try await fixture.documents.validateNativeRichLoroCandidateV1(nodeId: fixture.node, snapshot: snapshot)
                XCTFail("plain-shaped rich literal with a text-run line break must not be admitted")
            } catch {
                XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativeRichTextIneligible)
            }
            let persisted = try await deterministicPersistedLocalState(fixture, snapshot: snapshot)
            try await fixture.local.upsertLoroPage(persisted)
            let before = try await fixture.local.loroPage(nodeId: fixture.node)
            let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)

            let result = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node)
            let after = try await fixture.local.loroPage(nodeId: fixture.node)
            let checkpointAfter = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
            let candidateAfter = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
            let calls = await fixture.fake.calls()

            XCTAssertEqual(result, .ineligible)
            XCTAssertEqual(after, before)
            XCTAssertNil(checkpointAfter)
            XCTAssertNil(candidateAfter)
            XCTAssertTrue(calls.isEmpty)
        }
    }

    func testRichCommitMessagePreflightCanonicalizesAndRejectsInvalidWithoutEffects() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        guard case let .editable(base) = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node) else { return XCTFail("fixture must be editable") }
        let changed = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([.init(text: "changed")])]))
        for invalid in [" \u{00A0}\u{FEFF}\n", String(repeating: "x", count: 501), String(repeating: "😀", count: 251)] {
            let result = try await client.submitNativeRichDocumentV1(nodeId: fixture.node, base: base, proposed: changed, commitMessage: invalid)
            XCTAssertEqual(result, .invalidCommitMessage)
        }
        let callsBeforeValid = await fixture.fake.calls()
        let checkpointBeforeValid = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertTrue(callsBeforeValid.isEmpty)
        XCTAssertNil(checkpointBeforeValid)
        await fixture.fake.acceptSubmittedIntent()
        let validResult = try await client.submitNativeRichDocumentV1(nodeId: fixture.node, base: base, proposed: changed, commitMessage: " \u{FEFF} Canonical rich edit \u{00A0}")
        let callsAfterValid = await fixture.fake.calls()
        XCTAssertEqual(validResult, .submitted)
        XCTAssertEqual(callsAfterValid.first?.intent.commitMessage, "Canonical rich edit")
    }

    func testRichRetainedRetryPreservesCanonicalMessageAndRequestIdentity() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make(error: .unknown)
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        guard case let .editable(base) = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node) else { return XCTFail("fixture must be editable") }
        let proposed = LoroNativeRichDocumentV1(semantic: .init(blocks: [.heading(level: 1, runs: [.init(text: "retry")])]))
        let first = try await client.submitNativeRichDocumentV1(nodeId: fixture.node, base: base, proposed: proposed, commitMessage: " \u{FEFF} Retry rich edit \u{00A0}")
        XCTAssertEqual(first, .checkpointResolutionRequired(.retainedRetry))
        let firstCalls = await fixture.fake.calls()
        let firstCall = try XCTUnwrap(firstCalls.first)
        XCTAssertEqual(firstCall.intent.commitMessage, "Retry rich edit")
        _ = try await client.retryRetainedLoroSemanticCheckpoint(nodeId: fixture.node)
        let calls = await fixture.fake.calls()
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].intent.requestId, calls[1].intent.requestId)
        XCTAssertEqual(calls[1].intent.commitMessage, "Retry rich edit")
    }

    func testRichRecoveryUsesSeparateAcceptedLiteralSeamAndPlainRecoveryStaysStrict() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let route = fixture.candidate.route
        let replica = LoroPageReplicaWitness(snapshotSHA256: route.snapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: fixture.candidate.checkpoint.baseVersionVector))
        let rich = try await fixture.documents.prepareNativeRichSemanticCandidateV1(nodeId: fixture.node, route: route, persistedReplica: replica, publishedReplica: replica, isDirty: false, workspaceId: fixture.workspace, intent: try .init(requestId: "rich-recover", commitMessage: "Edit daily note", attribution: .humanUi(surface: "macos")), proposed: .init(semantic: .init(blocks: [.heading(level: 1, runs: [.init(text: "rich", marks: [.strong])])])))
        await fixture.fake.acceptSubmittedIntent()
        let accepted = try await fixture.machine.submit(rich)
        XCTAssertEqual(accepted, .committed)
        await fixture.documents.invalidateLiteralCache(nodeId: fixture.node)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        do { _ = try await client.recoverAcceptedLoroLiteralForEditing(nodeId: fixture.node); XCTFail("plain recovery must remain strict") }
        catch { XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativePlainTextIneligible) }
        guard case let .editable(state) = try await client.recoverAcceptedLoroRichLiteralForEditing(nodeId: fixture.node) else { return XCTFail("rich recovery must restore rich authority") }
        XCTAssertEqual(state.document.semantic, rich.semantic)
    }

    func testRichEligibilityUsesExactAcceptedBytesAcrossCacheInvalidationAndRecovery() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        guard case let .editable(base) = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node) else { return XCTFail("fixture must be editable") }
        let noChange = try await client.submitNativeRichDocumentV1(nodeId: fixture.node, base: base, proposed: base.document, commitMessage: "edit")
        XCTAssertEqual(noChange, .noChange)
        let callsBeforeCommit = await fixture.fake.calls()
        XCTAssertTrue(callsBeforeCommit.isEmpty)
        await fixture.documents.failNextLiteralPublicationForTesting()
        await fixture.fake.acceptSubmittedIntent()
        let changed = LoroNativeRichDocumentV1(semantic: .init(blocks: [.heading(level: 1, runs: [.init(text: "changed")])]))
        let committed = try await client.submitNativeRichDocumentV1(nodeId: fixture.node, base: base, proposed: changed, commitMessage: "edit")
        XCTAssertEqual(committed, .submittedNeedsReload)
        let acceptedPageOptional = try await fixture.local.loroPage(nodeId: fixture.node)
        let acceptedPage = try XCTUnwrap(acceptedPageOptional)
        let acceptedCheckpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let callsAfterCommit = await fixture.fake.calls()
        let closedEligibility = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node)
        let closedSubmit = try await client.submitNativeRichDocumentV1(nodeId: fixture.node, base: base, proposed: changed, commitMessage: "edit")
        XCTAssertEqual(closedEligibility, .ineligible)
        XCTAssertEqual(closedSubmit, .ineligible)
        let pageAfterClosure = try await fixture.local.loroPage(nodeId: fixture.node)
        let checkpointAfterClosure = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let callsAfterClosure = await fixture.fake.calls()
        XCTAssertEqual(pageAfterClosure, acceptedPage)
        XCTAssertEqual(checkpointAfterClosure, acceptedCheckpoint)
        XCTAssertEqual(callsAfterClosure, callsAfterCommit)
        guard case .editable = try await client.recoverAcceptedLoroRichLiteralForEditing(nodeId: fixture.node) else { return XCTFail("explicit rich recovery must reopen authoring") }
        let pageAfterRecovery = try await fixture.local.loroPage(nodeId: fixture.node)
        let checkpointAfterRecovery = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let callsAfterRecovery = await fixture.fake.calls()
        XCTAssertEqual(pageAfterRecovery, acceptedPage)
        XCTAssertEqual(checkpointAfterRecovery, acceptedCheckpoint)
        XCTAssertEqual(callsAfterRecovery, callsAfterCommit)
    }

    func testPersistedReplicaInspectionPreservesNoncanonicalRawDurableBytesWithoutSideEffects() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let source = LoroDoc()
        _ = try source.import(bytes: fixture.baseSnapshot)
        let rawUpdate = try source.export(mode: .updates(from: VersionVector()))
        let inspection = try await fixture.documents.inspectPersistedReplicaV1(snapshot: rawUpdate)
        let reexported = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: rawUpdate)
        XCTAssertNotEqual(inspection.snapshotSHA256, reexported.localSnapshotSHA256)
        XCTAssertEqual(inspection.pageSchemaVersion, 1)

        let rawDurable = LoroPageLocalState(
            nodeId: fixture.node,
            pageSchemaVersion: inspection.pageSchemaVersion,
            snapshotBytes: rawUpdate,
            localSnapshotSHA256: inspection.snapshotSHA256,
            dirty: false,
            observedDescriptorStorageVersion: 1,
            observedDescriptorSnapshotSHA256: inspection.snapshotSHA256
        )
        try await fixture.local.upsertLoroPage(rawDurable)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        let result = try await client.loroNativeRichEditorEligibility(nodeId: fixture.node)
        let pageAfter = try await fixture.local.loroPage(nodeId: fixture.node)
        let checkpointAfter = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let callsAfter = await fixture.fake.calls()
        XCTAssertEqual(result, .ineligible, "inspection must not mint literal authority")
        XCTAssertEqual(pageAfter, rawDurable)
        XCTAssertNil(checkpointAfter)
        XCTAssertTrue(callsAfter.isEmpty)
    }

    func testNormalConsumerCannotCompileRuntimeFactoryOrRawSemanticSymbols() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let temporary = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("athenaeum-core-public-surface-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary.appendingPathComponent("Sources/Consumer"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let domain = root.deletingLastPathComponent().appendingPathComponent("AthenaeumDomain")
        let package = """
        // swift-tools-version:5.9
        import PackageDescription
        let package = Package(name: "Consumer", platforms: [.macOS(.v13)], dependencies: [.package(path: "\(root.path)"), .package(path: "\(domain.path)")], targets: [.executableTarget(name: "Consumer", dependencies: [.product(name: "AthenaeumCore", package: "AthenaeumCore"), .product(name: "AthenaeumDomain", package: "AthenaeumDomain")])])
        """
        let source = """
        import AthenaeumCore
        import AthenaeumDomain
        let runtime: LoroSemanticRuntime? = nil
        let raw: LoroSemanticCandidate? = nil
        func oldFactory(_ client: WorkspaceSyncClient, _ intent: LoroMutationIntentV1) async throws {
            _ = try await client.makeLoroSemanticRuntime(intent: intent)
        }
        """
        try package.write(to: temporary.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)
        try source.write(to: temporary.appendingPathComponent("Sources/Consumer/main.swift"), atomically: true, encoding: .utf8)
        let output = temporary.appendingPathComponent("build.log")
        FileManager.default.createFile(atPath: output.path, contents: nil)
        let handle = try FileHandle(forWritingTo: output)
        defer { try? handle.close() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["swift", "build"]
        process.currentDirectoryURL = temporary
        process.standardOutput = handle
        process.standardError = handle
        try process.run()
        process.waitUntilExit()
        let diagnostics = try String(contentsOf: output)
        XCTAssertNotEqual(process.terminationStatus, 0)
        XCTAssertTrue(diagnostics.contains("cannot find type 'LoroSemanticRuntime'"), diagnostics)
        XCTAssertTrue(diagnostics.contains("cannot find type 'LoroSemanticCandidate'"), diagnostics)
        XCTAssertTrue(diagnostics.contains("makeLoroSemanticRuntime") && (diagnostics.contains("inaccessible due to 'internal' protection level") || diagnostics.contains("is inaccessible")), diagnostics)
    }
    func testScalarMinimalReplacementPreservesCombiningAndEmojiBoundaries() {
        let insertion = WorkspaceSyncClient.nativePlainReplacement(from: "a🙂b", to: "a🙂✨b")
        XCTAssertEqual(insertion.baseRange, 2..<2)
        XCTAssertEqual(insertion.proposedMiddle, "✨")

        let combining = WorkspaceSyncClient.nativePlainReplacement(from: "e\u{301}x", to: "e\u{301}🙂x")
        XCTAssertEqual(combining.baseRange, 2..<2)
        XCTAssertEqual(combining.proposedMiddle, "🙂")

        let deletion = WorkspaceSyncClient.nativePlainReplacement(from: "a🙂b", to: "ab")
        XCTAssertEqual(deletion.baseRange, 1..<2)
        XCTAssertEqual(deletion.proposedMiddle, "")
    }

    func testCheckpointValidationUsesLiteralBaseBindingAndStrictSemanticCandidateEquivalence() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        // Loro 1.13.3 canonicalizes this fixture's snapshot bytes. Production stress still
        // exercises independently constructed replicas; this unit contract proves the literal
        // base witness remains bound while candidate acceptance is semantic rather than export-byte based.
        for _ in 0..<3 {
            let prepared = try await fixture.documents.validateCheckpointCandidate(nodeId: fixture.node, baseSnapshot: fixture.candidate.baseSnapshot, baseVersionVector: fixture.candidate.baseVersionVector, route: fixture.candidate.route, candidateSnapshot: fixture.candidate.snapshot, update: fixture.candidate.update)
            XCTAssertEqual(try VersionVectorIdentity.digest(encodedVersionVector: prepared.versionBytes), try VersionVectorIdentity.digest(encodedVersionVector: fixture.candidateResultVersionVector))
        }
        do {
            _ = try await fixture.documents.validateCheckpointCandidate(nodeId: fixture.node, baseSnapshot: fixture.candidate.snapshot, baseVersionVector: fixture.candidate.baseVersionVector, route: fixture.candidate.route, candidateSnapshot: fixture.candidate.snapshot, update: fixture.candidate.update)
            XCTFail("a literal base whose digest does not match the accepted route must be rejected")
        } catch {
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativePlainTextWitnessMismatch)
        }
        do {
            _ = try await fixture.documents.validateCheckpointCandidate(nodeId: fixture.node, baseSnapshot: fixture.candidate.baseSnapshot, baseVersionVector: fixture.candidate.baseVersionVector, route: fixture.candidate.route, candidateSnapshot: fixture.freshAuthority.snapshot, update: fixture.candidate.update)
            XCTFail("a valid but semantically different strict-plain candidate must be rejected")
        } catch {
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .nativePlainTextWitnessMismatch)
        }
    }

    func testUnauthenticatedAdmissionHidesRetainedCheckpointWithoutDecoding() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make(error: .unknown)
        _ = try await fixture.machine.submit(fixture.candidate)
        let connection = try SQLite3Connection(path: fixture.local.path)
        try connection.run("UPDATE loro_pages SET snapshot_bytes = ? WHERE node_id = ?;", [.blob(Data([0x00])), .text(fixture.node.rawValue)])
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { false }, semanticTransport: fixture.fake)
        let eligibility = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
        XCTAssertEqual(eligibility, .unauthenticated)
        let calls = await fixture.fake.calls()
        XCTAssertEqual(calls.count, 1)
    }

    func testPostFreezeTransportAuthorizationDenialReturnsRetainedDisposition() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make(error: .authorizationDenied)
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        guard case let .editable(base) = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node) else { return XCTFail("fixture must be editable") }
        let result = try await client.submitNativePlainText(nodeId: fixture.node, base: base, proposedText: "changed")
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertEqual(result, .checkpointResolutionRequired(.retainedRetry))
        XCTAssertEqual(checkpoint?.state, .retainedRetry)
    }

    func testCacheInvalidatedCommitRequiresExplicitLiteralRecoveryBeforeAnotherEdit() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let client = WorkspaceSyncClient(
            localStore: fixture.local,
            loroTransport: EmptyTransport(),
            workspaceId: fixture.workspace,
            semanticAuthentication: { true },
            semanticTransport: fixture.fake,
            loroStore: fixture.documents
        )
        guard case let .editable(base) = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node) else {
            return XCTFail("fixture literal must be editable before the failpoint")
        }
        await fixture.documents.failNextLiteralPublicationForTesting()
        let first = try await client.submitNativePlainText(nodeId: fixture.node, base: base, proposedText: "changed")
        XCTAssertEqual(first, .submittedNeedsReload)
        let callsAfterCommit = await fixture.fake.calls()
        XCTAssertEqual(callsAfterCommit.count, 1)
        let publishedAfterFailure = try await fixture.documents.publishedState(nodeId: fixture.node)
        XCTAssertNil(publishedAfterFailure)

        let eligibility = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
        XCTAssertEqual(eligibility, .ineligible, "eligibility must not re-install literal authority")
        let second = try await client.submitNativePlainText(nodeId: fixture.node, base: base, proposedText: "again")
        XCTAssertEqual(second, .ineligible, "submit must remain closed without explicit recovery")
        let callsAfterBlockedSubmit = await fixture.fake.calls()
        XCTAssertEqual(callsAfterBlockedSubmit.count, callsAfterCommit.count)

        let recovered = try await client.recoverAcceptedLoroLiteralForEditing(nodeId: fixture.node)
        guard case .editable = recovered else {
            return XCTFail("explicit accepted-row recovery must restore literal authority")
        }
        let callsAfterRecovery = await fixture.fake.calls()
        XCTAssertEqual(callsAfterRecovery.count, callsAfterCommit.count)
    }

    func testStaleTextRouteAndReplicaAreClosedPreflightsWithoutCandidateOrTransport() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        guard case let .editable(base) = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node) else { return XCTFail("fixture must be editable") }
        let alteredRoute = LoroPageRouteWitness(nodeId: base.route.nodeId, format: base.route.format, storageVersion: base.route.storageVersion + 1, schemaVersion: base.route.schemaVersion, snapshotSHA256: base.route.snapshotSHA256)
        let alteredReplica = LoroPageReplicaWitness(snapshotSHA256: base.replica.snapshotSHA256, versionVectorSHA256: String(repeating: "0", count: 64))
        let staleStates = [
            LoroNativePlainEditorState(text: "stale", scalarCount: 5, route: base.route, replica: base.replica),
            LoroNativePlainEditorState(text: base.text, scalarCount: base.scalarCount, route: alteredRoute, replica: base.replica),
            LoroNativePlainEditorState(text: base.text, scalarCount: base.scalarCount, route: base.route, replica: alteredReplica)
        ]
        for stale in staleStates {
            let result = try await client.submitNativePlainText(nodeId: fixture.node, base: stale, proposedText: "changed")
            XCTAssertEqual(result, .staleEditorState)
        }
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidate = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let calls = await fixture.fake.calls()
        XCTAssertNil(checkpoint)
        XCTAssertNil(candidate)
        XCTAssertTrue(calls.isEmpty)
    }

    func testValueOnlySubmissionCreatesFixedCoreIntentAndNeverReturnsUpdate() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        try await fixture.documents.publish(nodeId: fixture.node, prepared: prepared)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake, loroStore: fixture.documents)
        let eligibility = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
        guard case let .editable(base) = eligibility else { return XCTFail("fixture must be editable") }

        await fixture.fake.acceptSubmittedIntent()
        let result = try await client.submitNativePlainText(nodeId: fixture.node, base: base, proposedText: "changed")
        let calls = await fixture.fake.calls()
        XCTAssertEqual(result, .submitted)
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].intent.commitMessage, "Edit daily note")
        XCTAssertEqual(calls[0].intent.attribution, .humanUi(surface: "macos"))
        XCTAssertNotEqual(calls[0].intent.requestId, "id")
        XCTAssertFalse(calls[0].intent.requestId.isEmpty)
    }

    func testNoChangeAndNewlineAreValueOnlyPreflightsWithoutPersistenceOrTransport() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        let descriptor = PageDocumentDescriptor.nativeLoro(nodeId: fixture.node, storageVersion: 1, loro: .init(schemaVersion: 1, snapshotSha256: prepared.localSnapshotSHA256))
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EditableTransport(descriptor: descriptor, snapshot: prepared.snapshotBytes, version: prepared.versionBytes), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake)
        _ = try await client.syncLoroPageReadOnly(nodeId: fixture.node)
        let beforeRecovery = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
        XCTAssertEqual(beforeRecovery, .ineligible)
        let eligibility = try await client.recoverAcceptedLoroLiteralForEditing(nodeId: fixture.node)
        guard case let .editable(base) = eligibility else { return XCTFail("fixture must be editable") }
        let noChange = try await client.submitNativePlainText(nodeId: fixture.node, base: base, proposedText: base.text)
        let newline = try await client.submitNativePlainText(nodeId: fixture.node, base: base, proposedText: "bad\ntext")
        XCTAssertEqual(noChange, .noChange)
        XCTAssertEqual(newline, .invalidProposedText)
        let checkpoint = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidate = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertNil(checkpoint)
        XCTAssertNil(candidate)
        let calls = await fixture.fake.calls()
        XCTAssertTrue(calls.isEmpty)
    }

    func testStartupInFlightReplaysExactFrozenCheckpointAfterAuthentication() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make(error: .unknown)
        _ = try await fixture.machine.submit(fixture.candidate)
        _ = try await fixture.local.transitionLoroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node, from: .retainedRetry, to: .inFlight)
        let beforeOptional = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let before = try XCTUnwrap(beforeOptional)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true }, semanticTransport: fixture.fake)
        let resolution = try await client.recoverInFlightLoroSemanticCheckpoint(nodeId: fixture.node)
        XCTAssertEqual(resolution, LoroSemanticCheckpointResolution.retainedRetry)
        let calls = await fixture.fake.calls()
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[1].intent, before.intent)
        XCTAssertEqual(calls[1].update, before.update)
        XCTAssertEqual(calls[1].baseVersionVectorSHA256, before.baseVersionVectorSHA256)
    }

    func testRetainedStartupDoesNotAuthenticateOrDispatchAndExplicitRetryReplaysFrozenCheckpoint() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make(error: .unknown)
        _ = try await fixture.machine.submit(fixture.candidate)
        let auth = FacadeAuth()
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { await auth.authenticate() }, semanticTransport: fixture.fake)
        let startup = try await client.recoverInFlightLoroSemanticCheckpoint(nodeId: fixture.node)
        XCTAssertEqual(startup, LoroSemanticCheckpointResolution.retainedRetry)
        let authAfterStartup = await auth.count()
        XCTAssertEqual(authAfterStartup, 0)
        let callsBeforeRetry = await fixture.fake.calls()
        XCTAssertEqual(callsBeforeRetry.count, 1)
        let retry = try await client.retryRetainedLoroSemanticCheckpoint(nodeId: fixture.node)
        XCTAssertEqual(retry, LoroSemanticCheckpointResolution.retainedRetry)
        let calls = await fixture.fake.calls()
        let authAfterRetry = await auth.count()
        XCTAssertEqual(authAfterRetry, 1)
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].update, calls[1].update)
        XCTAssertEqual(calls[0].intent, calls[1].intent)
    }

    func testEligibilityWaitsForSameNodeReadLeaseBeforeAuthenticating() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let readTransport = BlockingDescriptorTransport()
        let auth = CountingAuth()
        let client = WorkspaceSyncClient(
            localStore: fixture.local,
            loroTransport: readTransport,
            workspaceId: fixture.workspace,
            semanticAuthentication: { await auth.authenticate() }
        )

        let read = Task { try await client.syncLoroPageReadOnly(nodeId: fixture.node) }
        await readTransport.waitForDescriptorRequest()
        let eligibilityStarted = StartSignal()
        let eligibility = Task {
            await eligibilityStarted.signal()
            return try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
        }
        await eligibilityStarted.wait()
        let authBeforeRelease = await auth.count()
        let descriptorsBeforeRelease = await readTransport.descriptorRequests()
        XCTAssertEqual(authBeforeRelease, 0, "eligibility must not pass the shared lease while read sync owns it")
        XCTAssertEqual(descriptorsBeforeRelease, 1)

        await readTransport.releaseDescriptor()
        do { _ = try await read.value; XCTFail("blocked read transport must fail after release") } catch {}
        let eligibilityResult = try await eligibility.value
        let authAfterRelease = await auth.count()
        XCTAssertEqual(eligibilityResult, .ineligible)
        XCTAssertEqual(authAfterRelease, 1)
    }

    func testEligibilityWaitsForSameNodeRecoveryLeaseBeforeAuthenticating() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make(error: .unknown)
        _ = try await fixture.machine.submit(fixture.candidate)
        _ = try await fixture.local.transitionLoroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node, from: .retainedRetry, to: .inFlight)
        let auth = BlockingFirstAuth()
        let client = WorkspaceSyncClient(
            localStore: fixture.local,
            loroTransport: EmptyTransport(),
            workspaceId: fixture.workspace,
            semanticAuthentication: { await auth.authenticate() },
            semanticTransport: fixture.fake
        )

        let recovery = Task { try await client.recoverInFlightLoroSemanticCheckpoint(nodeId: fixture.node) }
        await auth.waitForFirstAuthentication()
        let eligibilityStarted = StartSignal()
        let eligibility = Task {
            await eligibilityStarted.signal()
            return try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
        }
        await eligibilityStarted.wait()
        let authBeforeRelease = await auth.count()
        let callsBeforeRelease = await fixture.fake.calls()
        XCTAssertEqual(authBeforeRelease, 1, "eligibility must wait behind in-flight recovery")
        XCTAssertEqual(callsBeforeRelease.count, 1, "recovery has not reached semantic transport")

        await auth.releaseFirstAuthentication()
        let recoveryResult = try await recovery.value
        let eligibilityResult = try await eligibility.value
        let authAfterRelease = await auth.count()
        let callsAfterRelease = await fixture.fake.calls()
        XCTAssertEqual(recoveryResult, .deniedAuthorizationOrSession)
        XCTAssertEqual(eligibilityResult, .checkpointResolutionRequired(.inFlight))
        XCTAssertEqual(authAfterRelease, 2, "admission authenticates before resolving a retained checkpoint")
        XCTAssertEqual(callsAfterRelease.count, 1)
    }

    func testEligibilityReturnsEditableForCleanStrictPlainPublishedReplicaWithoutMutation() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let snapshot = try LoroSemanticCheckpointStateMachineTests.Fixture.snapshot(text: "hello")
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: snapshot)
        try await fixture.local.upsertLoroPage(.init(prepared: prepared, dirty: false, observedDescriptorStorageVersion: 1, observedDescriptorSnapshotSHA256: prepared.localSnapshotSHA256))
        let descriptor = PageDocumentDescriptor.nativeLoro(nodeId: fixture.node, storageVersion: 1, loro: .init(schemaVersion: 1, snapshotSha256: prepared.localSnapshotSHA256))
        let transport = EditableTransport(descriptor: descriptor, snapshot: prepared.snapshotBytes, version: prepared.versionBytes)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: transport, workspaceId: fixture.workspace, semanticAuthentication: { true })
        _ = try await client.syncLoroPageReadOnly(nodeId: fixture.node)
        let localBeforeOptional = try await fixture.local.loroPage(nodeId: fixture.node)
        let localBefore = try XCTUnwrap(localBeforeOptional)

        let beforeRecovery = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
        XCTAssertEqual(beforeRecovery, .ineligible)
        let result = try await client.recoverAcceptedLoroLiteralForEditing(nodeId: fixture.node)
        let localAfter = try await fixture.local.loroPage(nodeId: fixture.node)
        let checkpointAfter = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidateAfter = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let expectedRoute = LoroPageRouteWitness(nodeId: fixture.node, format: .loroV1, storageVersion: localBefore.observedDescriptorStorageVersion, schemaVersion: localBefore.pageSchemaVersion, snapshotSHA256: localBefore.observedDescriptorSnapshotSHA256)
        let expectedReplica = LoroPageReplicaWitness(snapshotSHA256: prepared.localSnapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: prepared.versionBytes))
        guard case let .editable(state) = result else {
            return XCTFail("clean strict plain Loro page with matching published replica must be editable")
        }
        XCTAssertEqual(state.text, "hello")
        XCTAssertEqual(state.scalarCount, 5)
        XCTAssertEqual(state.route, expectedRoute)
        XCTAssertEqual(state.replica, expectedReplica)
        XCTAssertEqual(localAfter, localBefore)
        XCTAssertNil(checkpointAfter)
        XCTAssertNil(candidateAfter)
    }

    func testEligibilityThrowsInvalidLoroPageStateForDirtyForgedMatchingPersistedHashesWithoutMutation() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let connection = try SQLite3Connection(path: fixture.local.path)
        let forgedHash = String(repeating: "f", count: 64)
        let originalPage = try await fixture.local.loroPage(nodeId: fixture.node)
        let derivedHash = try XCTUnwrap(originalPage).localSnapshotSHA256
        XCTAssertNotEqual(forgedHash, derivedHash)
        try connection.run(
            "UPDATE loro_pages SET local_snapshot_sha256 = ?, observed_descriptor_snapshot_sha256 = ?, dirty = 1 WHERE node_id = ?;",
            [.text(forgedHash), .text(forgedHash), .text(fixture.node.rawValue)]
        )
        let corruptedBefore = try await fixture.local.loroPage(nodeId: fixture.node)
        let checkpointBefore = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidateBefore = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true })

        do {
            _ = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
            XCTFail("forged durable Loro hashes must fail as storage corruption")
        } catch {
            XCTAssertEqual(error as? LocalWorkspaceStoreError, .invalidLoroPageState)
        }
        let corruptedAfter = try await fixture.local.loroPage(nodeId: fixture.node)
        let checkpointAfter = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidateAfter = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertEqual(corruptedAfter, corruptedBefore)
        XCTAssertEqual(checkpointAfter, checkpointBefore)
        XCTAssertEqual(candidateAfter, candidateBefore)
    }

    func testEligibilityThrowsMalformedDirtySnapshotRatherThanReturningIneligibleAndDoesNotMutatePersistence() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let connection = try SQLite3Connection(path: fixture.local.path)
        try connection.run("UPDATE loro_pages SET snapshot_bytes = ?, dirty = 1 WHERE node_id = ?;", [.blob(Data([0x00])), .text(fixture.node.rawValue)])
        let pageBeforeFailure = try await fixture.local.loroPage(nodeId: fixture.node)
        let client = WorkspaceSyncClient(
            localStore: fixture.local,
            loroTransport: EmptyTransport(),
            workspaceId: fixture.workspace,
            semanticAuthentication: { true }
        )

        do {
            _ = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
            XCTFail("malformed durable Loro snapshot must not be downgraded to ineligible")
        } catch {
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .malformedSnapshot)
        }
        let pageAfterFailure = try await fixture.local.loroPage(nodeId: fixture.node)
        let checkpointAfterFailure = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidateAfterFailure = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertEqual(pageAfterFailure, pageBeforeFailure)
        XCTAssertNil(checkpointAfterFailure)
        XCTAssertNil(candidateAfterFailure)
    }

    func testDirtyButWellFormedEligibilityReturnsIneligibleWithoutPersistenceMutation() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let prepared = try await fixture.documents.prepare(nodeId: fixture.node, snapshot: fixture.baseSnapshot)
        let dirty = LoroPageLocalState(prepared: prepared, dirty: true, observedDescriptorStorageVersion: 1, observedDescriptorSnapshotSHA256: prepared.localSnapshotSHA256)
        try await fixture.local.upsertLoroPage(dirty)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true })

        let result = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
        let pageAfterEligibility = try await fixture.local.loroPage(nodeId: fixture.node)
        let checkpointAfterEligibility = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidateAfterEligibility = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertEqual(result, .ineligible)
        XCTAssertEqual(pageAfterEligibility, dirty)
        XCTAssertNil(checkpointAfterEligibility)
        XCTAssertNil(candidateAfterEligibility)
    }

    func testUnauthenticatedEligibilityDoesNotDecodeMalformedDurablePage() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
        let connection = try SQLite3Connection(path: fixture.local.path)
        try connection.run("UPDATE loro_pages SET snapshot_bytes = ? WHERE node_id = ?;", [.blob(Data([0x00])), .text(fixture.node.rawValue)])
        let before = try rawLoroPage(connection, nodeId: fixture.node)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { false })

        let result = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
        let checkpointAfter = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidateAfter = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertEqual(result, .unauthenticated)
        XCTAssertEqual(try rawLoroPage(connection, nodeId: fixture.node), before)
        XCTAssertNil(checkpointAfter)
        XCTAssertNil(candidateAfter)
    }

    func testCheckpointEligibilityPrecedesMalformedDurablePageDecode() async throws {
        let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make(error: .unknown)
        _ = try await fixture.machine.submit(fixture.candidate)
        let checkpointOptional = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let checkpoint = try XCTUnwrap(checkpointOptional)
        let candidateBefore = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        let connection = try SQLite3Connection(path: fixture.local.path)
        try connection.run("UPDATE loro_pages SET snapshot_bytes = ? WHERE node_id = ?;", [.blob(Data([0x00])), .text(fixture.node.rawValue)])
        let before = try rawLoroPage(connection, nodeId: fixture.node)
        let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true })

        let result = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
        let checkpointAfter = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
        let candidateAfter = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
        XCTAssertEqual(result, .checkpointResolutionRequired(.init(checkpoint)))
        XCTAssertEqual(try rawLoroPage(connection, nodeId: fixture.node), before)
        XCTAssertEqual(checkpointAfter, checkpoint)
        XCTAssertEqual(candidateAfter, candidateBefore)
    }

    func testEligibilityRejectsInvalidDurablePageScalarsWithoutMutation() async throws {
        let corruptions: [(String, String, [SQLiteValue])] = [
            ("malformed local hash", "local_snapshot_sha256 = ?", [.text("bad")]),
            ("blob local hash", "local_snapshot_sha256 = ?", [.blob(Data(repeating: 0x61, count: 64))]),
            ("malformed observed hash", "observed_descriptor_snapshot_sha256 = ?", [.text("BAD")]),
            ("zero page schema", "page_schema_version = ?", [.int(0)]),
            ("zero observed storage version", "observed_descriptor_storage_version = ?", [.int(0)]),
            ("invalid dirty encoding", "dirty = ?", [.int(2)]),
            ("empty snapshot", "snapshot_bytes = ?", [.blob(Data())])
        ]

        for (name, assignment, values) in corruptions {
            let fixture = try await LoroSemanticCheckpointStateMachineTests.Fixture.make()
            let connection = try SQLite3Connection(path: fixture.local.path)
            try connection.exec("PRAGMA ignore_check_constraints = ON;")
            try connection.run("UPDATE loro_pages SET \(assignment) WHERE node_id = ?;", values + [.text(fixture.node.rawValue)])
            try connection.exec("PRAGMA ignore_check_constraints = OFF;")
            let before = try rawLoroPage(connection, nodeId: fixture.node)
            let client = WorkspaceSyncClient(localStore: fixture.local, loroTransport: EmptyTransport(), workspaceId: fixture.workspace, semanticAuthentication: { true })

            do {
                _ = try await client.loroNativePlainEditorEligibility(nodeId: fixture.node)
                XCTFail("\(name) must be reported as durable state corruption")
            } catch {
                XCTAssertEqual(error as? LocalWorkspaceStoreError, .invalidLoroPageState)
            }
            let checkpointAfter = try await fixture.local.loroCheckpoint(workspaceId: fixture.workspace, nodeId: fixture.node)
            let candidateAfter = try await fixture.local.frozenCandidateEvidence(workspaceId: fixture.workspace, nodeId: fixture.node)
            XCTAssertEqual(try rawLoroPage(connection, nodeId: fixture.node), before, "\(name) must not cause a repair write")
            XCTAssertNil(checkpointAfter)
            XCTAssertNil(candidateAfter)
        }
    }

    private func rawLoroPage(_ connection: SQLite3Connection, nodeId: EntityId) throws -> [String] {
        try connection.query(
            "SELECT typeof(page_schema_version), length(snapshot_bytes), local_snapshot_sha256, typeof(dirty), dirty, typeof(observed_descriptor_storage_version), observed_descriptor_storage_version, observed_descriptor_snapshot_sha256 FROM loro_pages WHERE node_id = ?;",
            [.text(nodeId.rawValue)]
        ) { statement in
            [columnText(statement, 0), String(columnInt(statement, 1)), columnText(statement, 2), columnText(statement, 3), String(columnInt(statement, 4)), columnText(statement, 5), String(columnInt(statement, 6)), columnText(statement, 7)]
        }.first ?? []
    }

    private func deterministicNativeLiteralSnapshot(
        text: String,
        blockName: String,
        headingLevel: Int?,
        peer: UInt64
    ) throws -> Data {
        let doc = LoroDoc()
        try doc.setPeerId(peer: peer)
        try doc.getMap(id: "athenaeum-page-meta-v1").insert(key: "schemaVersion", v: 1)

        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        try root.insert(key: "nodeName", v: "doc")
        try root.getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "isAmgBlock", v: false)
        let child = try root.getOrCreateListContainer(key: "children", child: LoroList()).insertMapContainer(pos: 0, child: LoroMap())
        try child.insert(key: "nodeName", v: blockName)
        let attributes = try child.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        try attributes.insert(key: "isAmgBlock", v: false)
        if let headingLevel {
            try attributes.insert(key: "level", v: headingLevel)
        }
        let inline = try child.getOrCreateListContainer(key: "children", child: LoroList())
        try inline.insertTextContainer(pos: 0, child: LoroText()).pushStr(s: text)
        doc.commit()
        return try doc.export(mode: .snapshot)
    }

    /// Test-only durable-row construction preserves the deterministic raw literal.  It uses the
    /// same value-only persisted-replica inspection as eligibility, never a snapshot re-export.
    private func deterministicPersistedLocalState(
        _ fixture: LoroSemanticCheckpointStateMachineTests.Fixture,
        snapshot: Data
    ) async throws -> LoroPageLocalState {
        let inspection = try await fixture.documents.inspectPersistedReplicaV1(snapshot: snapshot)
        return .init(
            nodeId: fixture.node,
            pageSchemaVersion: inspection.pageSchemaVersion,
            snapshotBytes: snapshot,
            localSnapshotSHA256: inspection.snapshotSHA256,
            dirty: false,
            observedDescriptorStorageVersion: 1,
            observedDescriptorSnapshotSHA256: inspection.snapshotSHA256
        )
    }

    actor FacadeAuth { var uses = 0; func authenticate() -> Bool { uses += 1; return true }; func count() -> Int { uses } }

    actor CountingAuth { var uses = 0; func authenticate() -> Bool { uses += 1; return true }; func count() -> Int { uses } }

    actor StartSignal {
        private var signalled = false
        private var waiter: CheckedContinuation<Void, Never>?
        func signal() { signalled = true; waiter?.resume(); waiter = nil }
        func wait() async { if signalled { return }; await withCheckedContinuation { waiter = $0 } }
    }

    actor BlockingFirstAuth {
        private var uses = 0
        private var firstWaiter: CheckedContinuation<Void, Never>?
        private var release: CheckedContinuation<Void, Never>?
        func authenticate() async -> Bool {
            uses += 1
            guard uses == 1 else { return true }
            firstWaiter?.resume(); firstWaiter = nil
            await withCheckedContinuation { release = $0 }
            return false
        }
        func waitForFirstAuthentication() async { if uses > 0 { return }; await withCheckedContinuation { firstWaiter = $0 } }
        func releaseFirstAuthentication() { release?.resume(); release = nil }
        func count() -> Int { uses }
    }

    actor BlockingDescriptorTransport: LoroWorkspaceTransport {
        private var requests = 0
        private var requestWaiter: CheckedContinuation<Void, Never>?
        private var release: CheckedContinuation<Void, Never>?
        func getPageDocumentDescriptor(nodeId: String) async throws -> PageDocumentDescriptor {
            requests += 1
            requestWaiter?.resume(); requestWaiter = nil
            await withCheckedContinuation { release = $0 }
            throw LoroSemanticCheckpointTransportError.unknown
        }
        func waitForDescriptorRequest() async { if requests > 0 { return }; await withCheckedContinuation { requestWaiter = $0 } }
        func releaseDescriptor() { release?.resume(); release = nil }
        func descriptorRequests() -> Int { requests }
        func createLoroPage(nodeId: String, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor { throw LoroSemanticCheckpointTransportError.unknown }
        func startLoroPageSync(nodeId: String, sessionId: String) async throws -> StartLoroPageSyncOutput { throw LoroSemanticCheckpointTransportError.unknown }
        func loroPageReadSyncMessage(nodeId: String, sessionId: String, ordinal: Int, clientVersion: Data) async throws -> LoroPageSyncMessageOutput { throw LoroSemanticCheckpointTransportError.unknown }
    }

    actor EmptyTransport: LoroWorkspaceTransport {
        func getPageDocumentDescriptor(nodeId: String) async throws -> PageDocumentDescriptor { throw LoroSemanticCheckpointTransportError.unknown }
        func createLoroPage(nodeId: String, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor { throw LoroSemanticCheckpointTransportError.unknown }
        func startLoroPageSync(nodeId: String, sessionId: String) async throws -> StartLoroPageSyncOutput { throw LoroSemanticCheckpointTransportError.unknown }
        func loroPageReadSyncMessage(nodeId: String, sessionId: String, ordinal: Int, clientVersion: Data) async throws -> LoroPageSyncMessageOutput { throw LoroSemanticCheckpointTransportError.unknown }
    }

    actor EditableTransport: LoroWorkspaceTransport {
        let descriptor: PageDocumentDescriptor
        let snapshot: Data
        let version: Data

        init(descriptor: PageDocumentDescriptor, snapshot: Data, version: Data) {
            self.descriptor = descriptor
            self.snapshot = snapshot
            self.version = version
        }

        func getPageDocumentDescriptor(nodeId: String) async throws -> PageDocumentDescriptor { descriptor }
        func createLoroPage(nodeId: String, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor { descriptor }
        func startLoroPageSync(nodeId: String, sessionId: String) async throws -> StartLoroPageSyncOutput {
            .init(sessionId: sessionId, message: snapshot, serverVersion: version)
        }
        func loroPageReadSyncMessage(nodeId: String, sessionId: String, ordinal: Int, clientVersion: Data) async throws -> LoroPageSyncMessageOutput {
            .init(sessionId: sessionId, ordinal: ordinal, update: Data(), serverVersion: version, converged: true, reset: false)
        }
    }
}
