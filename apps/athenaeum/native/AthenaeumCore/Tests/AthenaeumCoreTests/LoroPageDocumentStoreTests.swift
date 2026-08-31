import CryptoKit
import Foundation
import XCTest
import Loro
import AthenaeumDomain
@testable import AthenaeumCore

final class LoroPageDocumentStoreTests: XCTestCase {
    // Captured from the Worker-side `createEmptyLoroPage` contract (loro-crdt 1.14.1), not
    // assembled by Swift. It includes `attributes`, an empty paragraph, and the canonical text.
    static let workerCanonicalSnapshotBase64 = "bG9ybwAAAAAAAAAAAAAAAL+XJWMAA0QBAABMT1JPAAALAAsBEAH8oDxkq4HFHgEBAAAAAAAFAQAAAQAkBwQBAAAKBAEAAAwEAAAABAQAAQAIBAAAAAoEAAAADgQAAQASZg1zY2hlbWFWZXJzaW9uCG5vZGVOYW1lCmF0dHJpYnV0ZXMKaXNBbWdCbG9jawhjaGlsZHJlbhZhdGhlbmFldW0tcGFnZS1tZXRhLXYxGGF0aGVuYWV1bS1wcm9zZW1pcnJvci12MQAgAQQMFQACAAIBBAIAAgEECgEACAIBBwgCAQcCFgsCFgEAJAMBBQNkb2MJAAIJAQcBCQAFCXBhcmFncmFwaAkAAgkBBwEJAgACAGZyAfzB8qG2teDiHhQAAgB2dgH8wfKhtrXg4h4WAADwAAABAwCypM5TAQAAAAUAAAAMAB7FgatkPKD8AAAAAAACAHZ2qjcHnSEBAACrAQAATE9STwAEIk0YYECCVwEAAPd1AAIBABhhdGhlbmFldW0tcHJvc2VtaXJyb3ItdjEBAQppc0FtZ0Jsb2NrAQAAAfygPGSrgcUeAAMJBAAFAAAAAAMBAfzB8qG2teDiHggCAwphdHRyaWJ1dGVzBwH8wfKhtrXg4h4OAQhub2RlTmFtZQQJcGFyYWdyYXBoCGNoaWxkcmVuKgAnEgJlAOcHAAkABgkEAAcAAAAABGkAHwqZAAc2CAANQgBfBAAAAAHhAAsHfAAlCgF7ALgBAwIBAAIBCgIBAFAAEAlQAAuJAAdBABYUegADQQASFEEAFAI4AWcKAAAAAgXKAFASAgAAA6cAAAIARxgAgBaLAfgPYWdlLW1ldGEtdjEAAQABDXNjaGVtYVZlcnNpb24DKQFfAAAaAIDGAQY/AAEAmAEEFwSYAU8DZG9jkgEBGAhpAPAIAgAEAAEAADgAoQDRACEBYgGLAcYBCAAAAAAANH9LUAEAAAAFAAAADQAA/KA8ZKuBxR4CAAAAARoAgBhhdGhlbmFldW0tcHJvc2VtaXJyb3ItdjEcZA0VbwEAAAAAAAA="

    func testCapturedWorkerCanonicalSnapshotPreparesAndPublishes() async throws {
        let snapshot = try XCTUnwrap(Data(base64Encoded: Self.workerCanonicalSnapshotBase64))
        let nodeId = try id()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: snapshot)
        XCTAssertEqual(prepared.validation, LoroPageSchemaValidation(schemaVersion: 1, hasCanonicalPageContainers: true))
        try await store.publish(nodeId: nodeId, prepared: prepared)
        let published = try await store.publishedState(nodeId: nodeId)
        XCTAssertEqual(published?.snapshotBytes, prepared.snapshotBytes)
        await XCTAssertThrowsErrorAsync(try await nativePlainEditable(store, nodeId: nodeId)) {
            XCTAssertEqual($0 as? LoroPageProjectionError, .pageNotPublished(nodeId))
        }
        try await installAcceptedLiteral(store, nodeId: nodeId, prepared: prepared)
        let editable = try await nativePlainEditable(store, nodeId: nodeId)
        XCTAssertEqual(editable.text, "")
    }
    func testCanonicalSnapshotRoundTripsAcrossPublish() async throws {
        let nodeId = try id()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: try canonicalSnapshot())
        XCTAssertEqual(prepared.validation, LoroPageSchemaValidation(schemaVersion: 1, hasCanonicalPageContainers: true))
        try await store.publish(nodeId: nodeId, prepared: prepared)
        let published = try await store.publishedState(nodeId: nodeId)
        XCTAssertEqual(published?.snapshotBytes, prepared.snapshotBytes)
    }

    func testBlankBootstrapCannotBePreparedOrPublished() async throws {
        let bootstrap = try await LoroPageDocumentStore().loadEmptyReplica()
        XCTAssertNotNil(bootstrap)
    }

    func testMalformedInputsAndWrongNodePreservePublishedState() async throws {
        let nodeId = try id()
        let otherNodeId = try id()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: try canonicalSnapshot())
        try await store.publish(nodeId: nodeId, prepared: prepared)
        await XCTAssertThrowsErrorAsync(try await store.prepare(nodeId: nodeId, snapshot: Data([0xff]))) { error in
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .malformedSnapshot)
        }
        await XCTAssertThrowsErrorAsync(try await store.prepare(nodeId: nodeId, snapshot: prepared.snapshotBytes, serverVersion: Data([0xff]))) { error in
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .malformedVersionVector)
        }
        await XCTAssertThrowsErrorAsync(try await store.publish(nodeId: otherNodeId, prepared: prepared)) { error in
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .preparedStateDoesNotMatchNode)
        }
        let stillPublished = try await store.publishedState(nodeId: nodeId)
        XCTAssertEqual(stillPublished?.snapshotBytes, prepared.snapshotBytes)
    }

    func testStructuralValidationAcceptsOpaqueChildren() async throws {
        let nodeId = try id()
        let doc = try canonicalDocument()
        doc.configTextStyle(textStyle: projectionTextStyleConfig())
        let children = doc.getMap(id: "athenaeum-prosemirror-v1").get(key: "children")!.asLoroList()!
        let arbitrary = try children.insertMapContainer(pos: 0, child: LoroMap())
        try arbitrary.insert(key: "nodeName", v: "custom-content")
        doc.commit()
        _ = try await LoroPageDocumentStore().prepare(nodeId: nodeId, snapshot: try doc.export(mode: .snapshot))
    }

    func testPublishedProjectionUsesActorReplicaAndProjectsSupportedMarks() async throws {
        let nodeId = try id()
        let doc = try canonicalDocument()
        doc.configTextStyle(textStyle: projectionTextStyleConfig())
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        let children = root.get(key: "children")!.asLoroList()!
        let paragraph = try children.insertMapContainer(pos: 0, child: LoroMap())
        try paragraph.insert(key: "nodeName", v: "paragraph")
        _ = try paragraph.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        let inline = try paragraph.getOrCreateListContainer(key: "children", child: LoroList())
        let text = try inline.insertTextContainer(pos: 0, child: LoroText())
        try text.pushStr(s: "Hello")
        try text.mark(from: 0, to: 5, key: "strong", value: LoroValue.map(value: [:]))
        doc.commit()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: try doc.export(mode: .snapshot))
        try await store.publish(nodeId: nodeId, prepared: prepared)
        let projected = try await store.projectPublished(nodeId: nodeId, route: .init(nodeId: nodeId, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "a", count: 64)), isDirty: false)
        XCTAssertEqual(projected.root, .document([.paragraph([.text("Hello", marks: [.strong])])]))
        XCTAssertEqual(projected.replica.snapshotSHA256, prepared.localSnapshotSHA256)
        XCTAssertFalse(projected.replica.versionVectorSHA256.isEmpty)
    }

    func testMeetingPreparationUnknownBlockProjectsItsSafeChildrenOnly() throws {
        let document = try canonicalDocument()
        let root = document.getMap(id: "athenaeum-prosemirror-v1")
        let children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
        let preparation = try children.insertMapContainer(pos: 0, child: LoroMap())
        try preparation.insert(key: "nodeName", v: "unknownBlock")
        let attributes = try preparation.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        try attributes.insert(key: "unknownBlock", v: LoroValue.map(value: [
            "type": .string(value: "athenaeum-meeting-prep"),
            "parents": .list(value: []),
            "attrs": .map(value: [
                "schemaVersion": .i64(value: 1),
                "localDate": .string(value: "2026-08-27"),
                "occurrenceKey": .string(value: String(repeating: "a", count: 64))
            ]),
            "isEmbed": .bool(value: false)
        ]))
        let preparationChildren = try preparation.getOrCreateListContainer(key: "children", child: LoroList())
        let (_, inline) = try appendParagraph(to: preparationChildren)
        let text = try inline.insertTextContainer(pos: 0, child: LoroText())
        try text.pushStr(s: "Meeting preparation")
        document.commit()

        var projector = LoroPageProjector(limits: LoroPageProjectionLimits())
        XCTAssertEqual(try projector.project(document), .document([
            .meetingPreparation(
                try XCTUnwrap(LoroMeetingPreparationIdentity(localDate: "2026-08-27", occurrenceKey: String(repeating: "a", count: 64))),
                children: [.paragraph([.text("Meeting preparation", marks: [])])]
            )
        ]))
    }

    func testMeetingPreparationIdentityRejectsMalformedDateAndOccurrenceKey() {
        let key = String(repeating: "a", count: 64)
        XCTAssertNotNil(LoroMeetingPreparationIdentity(localDate: "2026-02-28", occurrenceKey: key))
        XCTAssertNil(LoroMeetingPreparationIdentity(localDate: "2026-02-30", occurrenceKey: key))
        XCTAssertNil(LoroMeetingPreparationIdentity(localDate: "2026-2-28", occurrenceKey: key))
        XCTAssertNil(LoroMeetingPreparationIdentity(localDate: "2026-02-28", occurrenceKey: key.uppercased()))
        XCTAssertNil(LoroMeetingPreparationIdentity(localDate: "2026-02-28", occurrenceKey: String(repeating: "a", count: 63)))
    }

    func testArbitraryUnknownBlockRemainsUnsupported() throws {
        let document = try canonicalDocument()
        let root = document.getMap(id: "athenaeum-prosemirror-v1")
        let children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
        let block = try children.insertMapContainer(pos: 0, child: LoroMap())
        try block.insert(key: "nodeName", v: "unknownBlock")
        _ = try block.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        let blockChildren = try block.getOrCreateListContainer(key: "children", child: LoroList())
        _ = try appendParagraph(to: blockChildren)
        document.commit()

        var projector = LoroPageProjector(limits: LoroPageProjectionLimits())
        XCTAssertEqual(try projector.project(document), .document([.unsupported]))
    }

    func testOversizedImportedUpdateFailsBeforePublishing() async throws {
        let nodeId = try id()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: try canonicalSnapshot())
        try await store.publish(nodeId: nodeId, prepared: prepared)
        await XCTAssertThrowsErrorAsync(try await store.prepare(nodeId: nodeId, snapshot: prepared.snapshotBytes, applying: Data(repeating: 0, count: LoroPageProjectionLimits().maxUpdateBytes + 1))) { error in
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .inputTooLarge)
        }
        let retained = try await store.publishedState(nodeId: nodeId)
        XCTAssertEqual(retained?.snapshotBytes, prepared.snapshotBytes)
    }

    func testCheckedInWebCorpusProjectsExactSafeASTAndRejectsMalformedKnownContent() async throws {
        let corpus = try Self.checkedInCorpus()
        XCTAssertEqual(corpus.format, "athenaeum-loro-prosemirror-v1-corpus")
        XCTAssertEqual(corpus.corpusVersion, 1)
        XCTAssertEqual(corpus.generator.loroCrdt, "1.14.1")
        XCTAssertEqual(corpus.generator.loroProsemirror, "0.4.4")
        XCTAssertEqual(corpus.generator.schema, "athenaeum-rich-text-v1")

        for fixture in corpus.fixtures {
            let snapshot = try XCTUnwrap(Data(base64Encoded: fixture.snapshotBase64), "invalid base64 for \(fixture.id)")
            XCTAssertEqual(Self.sha256(snapshot), fixture.snapshotSHA256, "fixture hash drifted: \(fixture.id)")

            let nodeId = try id()
            let store = LoroPageDocumentStore()
            let prepared = try await store.prepare(nodeId: nodeId, snapshot: snapshot)
            try await store.publish(nodeId: nodeId, prepared: prepared)
            let route = projectionRoute(nodeId)

            if fixture.valid {
                let expected = try XCTUnwrap(fixture.expectedProjection, "missing expected projection for \(fixture.id)").nativeNode()
                let projected = try await store.projectPublished(nodeId: nodeId, route: route, isDirty: false)
                XCTAssertEqual(projected.root, expected, "native projection drifted: \(fixture.id)")
            } else {
                XCTAssertEqual(fixture.expectedFailure, "malformed-known-content", "unexpected negative fixture: \(fixture.id)")
                await XCTAssertThrowsErrorAsync(try await store.projectPublished(nodeId: nodeId, route: route, isDirty: false)) { error in
                    XCTAssertEqual(error as? LoroPageProjectionError, .malformedKnownContent, "wrong failure for \(fixture.id)")
                }
            }
        }
    }

    func testNativeProjectionRejectsHeadingLevel4() throws {
        try assertMalformedKnownProjection(headingDocument(level: 4))
    }

    func testNativeProjectionRejectsHeadingLevel5() throws {
        try assertMalformedKnownProjection(headingDocument(level: 5))
    }

    func testNativeProjectionRejectsHeadingLevel6() throws {
        try assertMalformedKnownProjection(headingDocument(level: 6))
    }

    func testNativeProjectionRejectsForbiddenKnownAttribute() throws {
        let document = try documentWithParagraphs(1)
        try firstParagraph(in: document).getOrCreateMapContainer(key: "attributes", child: LoroMap()).insert(key: "forbidden", v: true)
        document.commit()
        try assertMalformedKnownProjection(document)
    }

    func testNativeProjectionRejectsBlockNodeInsideParagraph() throws {
        let document = try documentWithParagraphs(1)
        let paragraph = try firstParagraph(in: document)
        let inline = try XCTUnwrap(paragraph.get(key: "children")?.asLoroList())
        let block = try inline.insertMapContainer(pos: 0, child: LoroMap())
        try block.insert(key: "nodeName", v: "paragraph")
        _ = try block.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        _ = try block.getOrCreateListContainer(key: "children", child: LoroList())
        document.commit()
        try assertMalformedKnownProjection(document)
    }

    func testNativeProjectionRejectsMalformedKnownMarkPayload() throws {
        let document = try documentWithText("x")
        let text = try firstText(in: document)
        // The configured rich-text style registry is required for Loro to retain this mark.
        try text.mark(from: 0, to: 1, key: "strong", value: "not-a-mark-record")
        document.commit()
        try assertMalformedKnownProjection(document)
    }

    func testPreFFIByteLimitsRejectEveryImportedPayloadAndRetainPublishedReplica() async throws {
        let nodeId = try id()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: try canonicalSnapshot())
        try await store.publish(nodeId: nodeId, prepared: prepared)
        let limits = LoroPageProjectionLimits()

        await XCTAssertThrowsErrorAsync(try await store.prepare(
            nodeId: nodeId,
            snapshot: Data(repeating: 0, count: limits.maxSnapshotBytes + 1)
        )) { error in
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .inputTooLarge)
        }
        await XCTAssertThrowsErrorAsync(try await store.prepare(
            nodeId: nodeId,
            snapshot: prepared.snapshotBytes,
            applying: Data(repeating: 0, count: limits.maxUpdateBytes + 1)
        )) { error in
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .inputTooLarge)
        }
        await XCTAssertThrowsErrorAsync(try await store.prepare(
            nodeId: nodeId,
            snapshot: prepared.snapshotBytes,
            serverVersion: Data(repeating: 0, count: limits.maxVersionVectorBytes + 1)
        )) { error in
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .inputTooLarge)
        }

        let retained = try await store.publishedState(nodeId: nodeId)
        XCTAssertEqual(retained?.snapshotBytes, prepared.snapshotBytes)
    }

    func testProjectionEnforcesDepthNodeChildAttributeRunMarkAndUTF8Limits() throws {
        XCTAssertEqual(LoroPageProjectionLimits().version, LoroPageProjectionLimits.currentVersion)

        try assertProjectionLimit(
            nestedParagraphDocument(depth: 2),
            limits: testLimits(maxDepth: 1)
        )
        try assertProjectionLimit(
            documentWithParagraphs(2),
            limits: testLimits(maxNodes: 2)
        )
        try assertProjectionLimit(
            documentWithParagraphs(2),
            limits: testLimits(maxChildren: 1)
        )

        let attributeDocument = try documentWithParagraphs(1)
        let attributeParagraph = try firstParagraph(in: attributeDocument)
        let attributeMap = try XCTUnwrap(attributeParagraph.get(key: "attributes")?.asLoroMap())
        try attributeMap.insert(key: "isAmgBlock", v: false)
        try attributeMap.insert(key: "unknownAttrs", v: LoroValue.map(value: [:]))
        attributeDocument.commit()
        try assertProjectionLimit(attributeDocument, limits: testLimits(maxAttributes: 1))

        let runDocument = try documentWithText("ab")
        let runText = try firstText(in: runDocument)
        try runText.mark(from: 1, to: 2, key: "strong", value: LoroValue.map(value: [:]))
        runDocument.commit()
        try assertProjectionLimit(runDocument, limits: testLimits(maxTextRuns: 1))

        let markDocument = try documentWithText("x")
        let markText = try firstText(in: markDocument)
        try markText.mark(from: 0, to: 1, key: "strong", value: LoroValue.map(value: [:]))
        try markText.mark(from: 0, to: 1, key: "code", value: LoroValue.map(value: [:]))
        markDocument.commit()
        try assertProjectionLimit(markDocument, limits: testLimits(maxMarks: 1))

        try assertProjectionLimit(
            documentWithText("é"),
            limits: testLimits(maxUTF8Bytes: 1)
        )
    }

    func testReplicaWitnessUsesCanonicalSemanticVersionVectorDigest() async throws {
        let nodeId = try id()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: try documentWithParagraphs(1).export(mode: .snapshot))
        try await store.publish(nodeId: nodeId, prepared: prepared)
        let projection = try await store.projectPublished(nodeId: nodeId, route: projectionRoute(nodeId), isDirty: false)

        XCTAssertEqual(projection.replica.snapshotSHA256, prepared.localSnapshotSHA256)
        XCTAssertEqual(projection.replica.versionVectorSHA256, try VersionVectorIdentity.digest(encodedVersionVector: prepared.versionBytes))
        XCTAssertNotEqual(projection.replica.versionVectorSHA256, Self.sha256(prepared.versionBytes), "the replica witness must not be a raw VV wire hash")
    }

    func testNativePlainV1AttachesOfficialShapeTextAndKeepsItWhenDeletedToEmpty() async throws {
        let nodeId = try id()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: try documentWithParagraphs(1).export(mode: .snapshot))
        try await store.publish(nodeId: nodeId, prepared: prepared)
        try await installAcceptedLiteral(store, nodeId: nodeId, prepared: prepared)
        let initial = try await nativePlainEditable(store, nodeId: nodeId)
        XCTAssertEqual(initial.text, "")
        XCTAssertEqual(initial.scalarCount, 0)

        let written = try await store.replaceNativePlainLoroEditableV1(
            nodeId: nodeId, route: initial.route, persistedReplica: initial.replica,
            publishedReplica: initial.replica, isDirty: false, scalarRange: 0..<0, replacement: "hello"
        )
        XCTAssertEqual(written.text, "hello")
        XCTAssertEqual(written.route.storageVersion, 1, "the accepted descriptor remains unchanged by a local draft")
        let observationAfterDraft = try await store.publishedState(nodeId: nodeId)
        XCTAssertEqual(observationAfterDraft?.snapshotBytes, prepared.snapshotBytes, "a local draft must not promote raw observation bytes")
        let accepted = try await store.prepare(nodeId: nodeId, snapshot: try documentWithText("hello").export(mode: .snapshot))
        try await store.publish(nodeId: nodeId, prepared: accepted)
        try await installAcceptedLiteral(store, nodeId: nodeId, prepared: accepted, storageVersion: 7)
        let acceptedReplica = LoroPageReplicaWitness(snapshotSHA256: accepted.localSnapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: accepted.versionBytes))
        let acceptedRoute = LoroPageRouteWitness(nodeId: nodeId, format: .loroV1, storageVersion: 7, schemaVersion: 1, snapshotSHA256: accepted.localSnapshotSHA256)
        let emptied = try await store.replaceNativePlainLoroEditableV1(
            nodeId: nodeId, route: acceptedRoute, persistedReplica: acceptedReplica,
            publishedReplica: acceptedReplica, isDirty: false, scalarRange: 0..<5, replacement: ""
        )
        XCTAssertEqual(emptied.text, "")
        XCTAssertEqual(emptied.route, acceptedRoute)
        let maybeSnapshot = try await store.publishedState(nodeId: nodeId)
        let snapshot = try XCTUnwrap(maybeSnapshot?.snapshotBytes)
        let reloaded = LoroDoc()
        _ = try reloaded.import(bytes: snapshot)
        XCTAssertNotNil(try firstText(in: reloaded), "empty v1 pages retain their attached LoroText")
    }

    func testNativePlainV1UsesUnicodeScalarOffsetsAndRejectsNewlinesAndNoOps() async throws {
        let nodeId = try id()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: try documentWithText("A😀e\u{301}Z").export(mode: .snapshot))
        try await store.publish(nodeId: nodeId, prepared: prepared)
        try await installAcceptedLiteral(store, nodeId: nodeId, prepared: prepared)
        let initial = try await nativePlainEditable(store, nodeId: nodeId)
        XCTAssertEqual(initial.scalarCount, 5)
        await XCTAssertThrowsErrorAsync(try await store.replaceNativePlainLoroEditableV1(
            nodeId: nodeId, route: initial.route, persistedReplica: initial.replica,
            publishedReplica: initial.replica, isDirty: false, scalarRange: 1..<2, replacement: "\n"
        )) { XCTAssertEqual($0 as? LoroPageDocumentStoreError, .nativePlainTextNewlineUnsupported) }
        await XCTAssertThrowsErrorAsync(try await store.replaceNativePlainLoroEditableV1(
            nodeId: nodeId, route: initial.route, persistedReplica: initial.replica,
            publishedReplica: initial.replica, isDirty: false, scalarRange: 0..<1, replacement: "A"
        )) { XCTAssertEqual($0 as? LoroPageDocumentStoreError, .nativePlainTextNoOp) }
        let changed = try await store.replaceNativePlainLoroEditableV1(
            nodeId: nodeId, route: initial.route, persistedReplica: initial.replica,
            publishedReplica: initial.replica, isDirty: false, scalarRange: 1..<4, replacement: "✨"
        )
        XCTAssertEqual(changed.text, "A✨Z")
        XCTAssertEqual(changed.scalarCount, 3)
    }

    func testNativePlainV1RejectsUnknownRootAndWitnessOrDirtyMismatches() async throws {
        let nodeId = try id()
        let doc = try documentWithParagraphs(1)
        _ = doc.getMap(id: "unknown-top-level-container")
        doc.commit()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: try doc.export(mode: .snapshot))
        try await store.publish(nodeId: nodeId, prepared: prepared)
        let replica = LoroPageReplicaWitness(snapshotSHA256: prepared.localSnapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: prepared.versionBytes))
        let route = LoroPageRouteWitness(nodeId: nodeId, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: prepared.localSnapshotSHA256)
        await XCTAssertThrowsErrorAsync(try await installAcceptedLiteral(store, nodeId: nodeId, prepared: prepared)) {
            XCTAssertEqual($0 as? LoroPageDocumentStoreError, .nativePlainTextIneligible)
        }
        await XCTAssertThrowsErrorAsync(try await store.nativePlainLoroEditableV1(nodeId: nodeId, route: route, persistedReplica: replica, publishedReplica: replica, isDirty: false)) {
            XCTAssertEqual($0 as? LoroPageProjectionError, .pageNotPublished(nodeId))
        }
        await XCTAssertThrowsErrorAsync(try await store.nativePlainLoroEditableV1(nodeId: nodeId, route: route, persistedReplica: replica, publishedReplica: replica, isDirty: true)) {
            XCTAssertEqual($0 as? LoroPageDocumentStoreError, .nativePlainTextDirty)
        }
    }

    func testNativePlainV1RejectsNonCanonicalAttributes() async throws {
        let nodeId = try id()
        let doc = try documentWithParagraphs(1)
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        let attributes = try XCTUnwrap(root.get(key: "attributes")?.asLoroMap())
        try attributes.insert(key: "unknownAttrs", v: LoroValue.map(value: [:]))
        doc.commit()
        let store = LoroPageDocumentStore()
        let prepared = try await store.prepare(nodeId: nodeId, snapshot: try doc.export(mode: .snapshot))
        try await store.publish(nodeId: nodeId, prepared: prepared)
        let replica = LoroPageReplicaWitness(snapshotSHA256: prepared.localSnapshotSHA256, versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: prepared.versionBytes))
        let route = LoroPageRouteWitness(nodeId: nodeId, format: .loroV1, storageVersion: 9, schemaVersion: 1, snapshotSHA256: prepared.localSnapshotSHA256)
        await XCTAssertThrowsErrorAsync(try await installAcceptedLiteral(store, nodeId: nodeId, prepared: prepared)) {
            XCTAssertEqual($0 as? LoroPageDocumentStoreError, .nativePlainTextIneligible)
        }
        await XCTAssertThrowsErrorAsync(try await store.nativePlainLoroEditableV1(nodeId: nodeId, route: route, persistedReplica: replica, publishedReplica: replica, isDirty: false)) {
            XCTAssertEqual($0 as? LoroPageProjectionError, .pageNotPublished(nodeId))
        }
    }

    func testVersionVectorIdentityFixtureIsCrossRuntimeContract() throws {
        let fixture = try Self.versionVectorIdentityFixture()
        let encoded = try XCTUnwrap(Data(base64Encoded: fixture.encodedVersionVectorBase64))
        let vector = try VersionVector.decode(bytes: encoded)
        let entries = try vector.toHashmap().map { entry -> (peer: UInt64, counter: Int32) in
            (peer: entry.key, counter: try XCTUnwrap(Int32(exactly: entry.value)))
        }

        XCTAssertEqual(fixture.format, "athenaeum.loro-version-vector-identity.v1")
        XCTAssertEqual(entries.sorted { $0.peer < $1.peer }.map { .init(peer: String($0.peer), counter: $0.counter) }, fixture.entries)
        XCTAssertEqual(fixture.entries.map(\.peer), ["2", "10"])
        XCTAssertEqual(fixture.entries.map(\.counter), [3, 4])
        XCTAssertEqual(try VersionVectorIdentity.canonicalPreimageBytes(entries: entries), Data(fixture.canonicalPreimage.utf8))
        XCTAssertEqual(try VersionVectorIdentity.digest(encodedVersionVector: encoded), fixture.sha256)
        XCTAssertEqual(try VersionVectorIdentity.digest(entries: entries), fixture.sha256)
        XCTAssertEqual(try VersionVectorIdentity.canonicalPreimageBytes(entries: []), Data("[]".utf8))
        XCTAssertThrowsError(try VersionVectorIdentity.digest(encodedVersionVector: Data([0xff])))
        XCTAssertThrowsError(try VersionVectorIdentity.canonicalPreimageBytes(entries: [(peer: 2, counter: -1)])) { error in
            XCTAssertEqual(error as? VersionVectorIdentityError, .negativeCounter)
        }
    }

    func testPostPersistPublicationFailurePreservesCacheAndDurableCandidate() async throws {
        let workspaceId = try id()
        let nodeId = try id()
        let cache = LoroPageDocumentStore()
        let valid = try await cache.prepare(nodeId: nodeId, snapshot: try canonicalSnapshot())
        try await cache.publish(nodeId: nodeId, prepared: valid)

        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await local.upsertNode(Node(id: nodeId, workspaceId: workspaceId, title: "Loro", createdAt: "2026-08-20T00:00:00Z"), dirty: false)
        try await local.upsertLoroPage(
            LoroPageLocalState(
                prepared: valid,
                dirty: true,
                observedDescriptorStorageVersion: 1,
                observedDescriptorSnapshotSHA256: String(repeating: "a", count: 64)
            )
        )

        // The test target can forge an internal value; production callers cannot. This models a
        // corrupt post-persistence handoff and proves `publish` does not replace the cache.
        let forged = LoroPreparedPageState(
            nodeId: nodeId,
            snapshotBytes: valid.snapshotBytes,
            versionBytes: Data([0xff]),
            localSnapshotSHA256: valid.localSnapshotSHA256,
            validation: valid.validation
        )
        await XCTAssertThrowsErrorAsync(try await cache.publish(nodeId: nodeId, prepared: forged)) { error in
            XCTAssertEqual(error as? LoroPageDocumentStoreError, .malformedVersionVector)
        }
        let cached = try await cache.publishedState(nodeId: nodeId)
        let durable = try await local.loroPage(nodeId: nodeId)
        XCTAssertEqual(cached?.snapshotBytes, valid.snapshotBytes)
        XCTAssertEqual(durable?.snapshotBytes, valid.snapshotBytes)
        XCTAssertEqual(durable?.localSnapshotSHA256, valid.localSnapshotSHA256)
    }

    private func id() throws -> EntityId { try EntityId(validating: UUID().uuidString.lowercased()) }
    private func canonicalSnapshot() throws -> Data { try canonicalDocument().export(mode: .snapshot) }
    private func canonicalDocument() throws -> LoroDoc {
        let doc = LoroDoc()
        let metadata = doc.getMap(id: "athenaeum-page-meta-v1")
        try metadata.insert(key: "schemaVersion", v: 1)
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        try root.insert(key: "nodeName", v: "doc")
        let rootAttributes = try root.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        try rootAttributes.insert(key: "isAmgBlock", v: false)
        _ = try root.getOrCreateListContainer(key: "children", child: LoroList())
        doc.commit()
        return doc
    }

    private func projectionRoute(_ nodeId: EntityId) -> LoroPageRouteWitness {
        .init(
            nodeId: nodeId,
            format: .loroV1,
            storageVersion: 1,
            schemaVersion: 1,
            snapshotSHA256: String(repeating: "a", count: 64)
        )
    }

    /// Mirrors the production recovery boundary: read observations are not authoring authority.
    /// Tests must obtain LocalStore's sealed accepted-page proof before installing a literal token.
    private func installAcceptedLiteral(
        _ documents: LoroPageDocumentStore,
        nodeId: EntityId,
        prepared: LoroPreparedPageState,
        storageVersion: Int = 1
    ) async throws {
        let workspaceId = try id()
        let local = try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
        try await local.upsertNode(
            .init(
                id: nodeId,
                workspaceId: workspaceId,
                title: "literal recovery fixture",
                createdAt: try IsoDateTimeString(validating: "2026-08-20T00:00:00Z")
            ),
            dirty: false
        )
        try await local.upsertLoroPage(.init(
            prepared: prepared,
            dirty: false,
            observedDescriptorStorageVersion: storageVersion,
            observedDescriptorSnapshotSHA256: prepared.localSnapshotSHA256
        ))
        let maybeEvidence = try await local.acceptedLoroPageEvidence(workspaceId: workspaceId, nodeId: nodeId)
        let evidence = try XCTUnwrap(maybeEvidence)
        try await documents.installAcceptedLiteral(evidence)
    }

    private func nativePlainEditable(_ store: LoroPageDocumentStore, nodeId: EntityId) async throws -> NativePlainLoroEditableV1 {
        let maybeState = try await store.publishedState(nodeId: nodeId)
        let state = try XCTUnwrap(maybeState)
        let replica = LoroPageReplicaWitness(
            snapshotSHA256: state.localSnapshotSHA256,
            versionVectorSHA256: try VersionVectorIdentity.digest(encodedVersionVector: state.versionBytes)
        )
        return try await store.nativePlainLoroEditableV1(
            nodeId: nodeId,
            route: .init(nodeId: nodeId, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: state.localSnapshotSHA256),
            persistedReplica: replica,
            publishedReplica: replica,
            isDirty: false
        )
    }

    private func documentWithParagraphs(_ count: Int) throws -> LoroDoc {
        let doc = try canonicalDocument()
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        let children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
        for _ in 0..<count {
            _ = try appendParagraph(to: children)
        }
        doc.commit()
        return doc
    }

    private func headingDocument(level: Int) throws -> LoroDoc {
        let doc = try canonicalDocument()
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        let children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
        let heading = try children.insertMapContainer(pos: 0, child: LoroMap())
        try heading.insert(key: "nodeName", v: "heading")
        let attributes = try heading.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        try attributes.insert(key: "level", v: level)
        _ = try heading.getOrCreateListContainer(key: "children", child: LoroList())
        doc.commit()
        return doc
    }

    private func documentWithText(_ value: String) throws -> LoroDoc {
        let doc = try canonicalDocument()
        doc.configTextStyle(textStyle: projectionTextStyleConfig())
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        let children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
        let (_, inline) = try appendParagraph(to: children)
        let text = try inline.insertTextContainer(pos: 0, child: LoroText())
        try text.pushStr(s: value)
        doc.commit()
        return doc
    }

    private func nestedParagraphDocument(depth: Int) throws -> LoroDoc {
        let doc = try canonicalDocument()
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        var children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
        for _ in 0..<depth {
            let blockquote = try children.insertMapContainer(pos: children.len(), child: LoroMap())
            try blockquote.insert(key: "nodeName", v: "blockquote")
            _ = try blockquote.getOrCreateMapContainer(key: "attributes", child: LoroMap())
            children = try blockquote.getOrCreateListContainer(key: "children", child: LoroList())
        }
        _ = try appendParagraph(to: children)
        doc.commit()
        return doc
    }

    private func appendParagraph(to children: LoroList) throws -> (LoroMap, LoroList) {
        let paragraph = try children.insertMapContainer(pos: children.len(), child: LoroMap())
        try paragraph.insert(key: "nodeName", v: "paragraph")
        let paragraphAttributes = try paragraph.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        try paragraphAttributes.insert(key: "isAmgBlock", v: false)
        let inline = try paragraph.getOrCreateListContainer(key: "children", child: LoroList())
        return (paragraph, inline)
    }

    private func firstParagraph(in doc: LoroDoc) throws -> LoroMap {
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        let children = try XCTUnwrap(root.get(key: "children")?.asLoroList())
        return try XCTUnwrap(children.get(index: 0)?.asLoroMap())
    }

    private func firstText(in doc: LoroDoc) throws -> LoroText {
        let paragraph = try firstParagraph(in: doc)
        let children = try XCTUnwrap(paragraph.get(key: "children")?.asLoroList())
        return try XCTUnwrap(children.get(index: 0)?.asLoroText())
    }

    private func projectionTextStyleConfig() -> StyleConfigMap {
        let config = StyleConfigMap.defaultRichTextConfig()
        config.insert(key: "strong", value: config.get(key: "bold")!)
        return config
    }

    private func assertProjectionLimit(
        _ document: LoroDoc,
        limits: LoroPageProjectionLimits,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        var projector = LoroPageProjector(limits: limits)
        XCTAssertThrowsError(try projector.project(document), file: file, line: line) { error in
            XCTAssertEqual(error as? LoroPageProjectionError, .limitExceeded, file: file, line: line)
        }
    }

    private func assertMalformedKnownProjection(
        _ document: LoroDoc,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        var projector = LoroPageProjector(limits: .init())
        XCTAssertThrowsError(try projector.project(document), file: file, line: line) { error in
            XCTAssertEqual(error as? LoroPageProjectionError, .malformedKnownContent, file: file, line: line)
        }
    }

    private func testLimits(
        maxDepth: Int = 32,
        maxNodes: Int = 100,
        maxChildren: Int = 100,
        maxTextRuns: Int = 100,
        maxMarks: Int = 16,
        maxAttributes: Int = 64,
        maxUTF8Bytes: Int = 1_000
    ) -> LoroPageProjectionLimits {
        .init(
            version: LoroPageProjectionLimits.currentVersion,
            maxSnapshotBytes: 1_024,
            maxUpdateBytes: 1_024,
            maxVersionVectorBytes: 1_024,
            maxDepth: maxDepth,
            maxNodes: maxNodes,
            maxChildren: maxChildren,
            maxTextRuns: maxTextRuns,
            maxMarks: maxMarks,
            maxAttributes: maxAttributes,
            maxUTF8Bytes: maxUTF8Bytes
        )
    }

    private static func checkedInCorpus() throws -> CheckedInLoroProjectionCorpus {
        let source = URL(fileURLWithPath: #filePath)
        let corpusURL = source
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("packages/web/src/fixtures/loro-prosemirror-v1-corpus.json")
        return try JSONDecoder().decode(CheckedInLoroProjectionCorpus.self, from: Data(contentsOf: corpusURL))
    }

    private static func versionVectorIdentityFixture() throws -> CheckedInVersionVectorIdentityFixture {
        let source = URL(fileURLWithPath: #filePath)
        let fixtureURL = source
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("fixtures/loro-version-vector-identity.json")
        return try JSONDecoder().decode(CheckedInVersionVectorIdentityFixture.self, from: Data(contentsOf: fixtureURL))
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

}

private struct CheckedInVersionVectorIdentityFixture: Decodable {
    let format: String
    let encodedVersionVectorBase64: String
    let entries: [Entry]
    let canonicalPreimage: String
    let sha256: String

    struct Entry: Decodable, Equatable {
        let peer: String
        let counter: Int32
    }
}

private struct CheckedInLoroProjectionCorpus: Decodable {
    let format: String
    let corpusVersion: Int
    let generator: Generator
    let fixtures: [Fixture]

    struct Generator: Decodable {
        let loroCrdt: String
        let loroProsemirror: String
        let schema: String
    }

    struct Fixture: Decodable {
        let id: String
        let valid: Bool
        let snapshotSHA256: String
        let snapshotBase64: String
        let expectedProjection: ExpectedProjection?
        let expectedFailure: String?
    }

    struct ExpectedProjection: Decodable {
        let kind: String
        let text: String?
        let level: Int?
        let marks: [String]?
        let children: [ExpectedProjection]?

        func nativeNode() throws -> LoroPageProjectionNode {
            switch kind {
            case "document":
                return .document(try childrenOrEmpty().map { try $0.nativeNode() })
            case "paragraph":
                return .paragraph(try childrenOrEmpty().map { try $0.nativeNode() })
            case "heading":
                guard let level else { throw CheckedInCorpusError.malformedExpectedProjection }
                return .heading(level: level, children: try childrenOrEmpty().map { try $0.nativeNode() })
            case "text":
                guard let text else { throw CheckedInCorpusError.malformedExpectedProjection }
                return .text(text, marks: try (marks ?? []).map { rawMark in
                    guard let mark = LoroPageProjectionMark(rawValue: rawMark) else {
                        throw CheckedInCorpusError.malformedExpectedProjection
                    }
                    return mark
                })
            default:
                throw CheckedInCorpusError.malformedExpectedProjection
            }
        }

        private func childrenOrEmpty() -> [ExpectedProjection] { children ?? [] }
    }
}

private enum CheckedInCorpusError: Error {
    case malformedExpectedProjection
}

private func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, _ handler: (Error) -> Void) async {
    do { _ = try await expression(); XCTFail("expected error") } catch { handler(error) }
}
