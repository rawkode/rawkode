import Foundation
import LoroInteroperabilityProbeSupport
import Loro
import XCTest

final class LoroInteroperabilityProbeTests: XCTestCase {
    // Captured from the Worker-side `createEmptyLoroPage` contract (loro-crdt 1.14.1), not
    // assembled by Swift. It retains this probe-specific fixture after the tests leave Core.
    private static let workerCanonicalSnapshotBase64 = "bG9ybwAAAAAAAAAAAAAAAL+XJWMAA0QBAABMT1JPAAALAAsBEAH8oDxkq4HFHgEBAAAAAAAFAQAAAQAkBwQBAAAKBAEAAAwEAAAABAQAAQAIBAAAAAoEAAAADgQAAQASZg1zY2hlbWFWZXJzaW9uCG5vZGVOYW1lCmF0dHJpYnV0ZXMKaXNBbWdCbG9jawhjaGlsZHJlbhZhdGhlbmFldW0tcGFnZS1tZXRhLXYxGGF0aGVuYWV1bS1wcm9zZW1pcnJvci12MQAgAQQMFQACAAIBBAIAAgEECgEACAIBBwgCAQcCFgsCFgEAJAMBBQNkb2MJAAIJAQcBCQAFCXBhcmFncmFwaAkAAgkBBwEJAgACAGZyAfzB8qG2teDiHhQAAgB2dgH8wfKhtrXg4h4WAADwAAABAwCypM5TAQAAAAUAAAAMAB7FgatkPKD8AAAAAAACAHZ2qjcHnSEBAACrAQAATE9STwAEIk0YYECCVwEAAPd1AAIBABhhdGhlbmFldW0tcHJvc2VtaXJyb3ItdjEBAQppc0FtZ0Jsb2NrAQAAAfygPGSrgcUeAAMJBAAFAAAAAAMBAfzB8qG2teDiHggCAwphdHRyaWJ1dGVzBwH8wfKhtrXg4h4OAQhub2RlTmFtZQQJcGFyYWdyYXBoCGNoaWxkcmVuKgAnEgJlAOcHAAkABgkEAAcAAAAABGkAHwqZAAc2CAANQgBfBAAAAAHhAAsHfAAlCgF7ALgBAwIBAAIBCgIBAFAAEAlQAAuJAAdBABYUegADQQASFEEAFAI4AWcKAAAAAgXKAFASAgAAA6cAAAIARxgAgBaLAfgPYWdlLW1ldGEtdjEAAQABDXNjaGVtYVZlcnNpb24DKQFfAAAaAIDGAQY/AAEAmAEEFwSYAU8DZG9jkgEBGAhpAPAIAgAEAAEAADgAoQDRACEBYgGLAcYBCAAAAAAANH9LUAEAAAAFAAAADQAA/KA8ZKuBxR4CAAAAARoAgBhhdGhlbmFldW0tcHJvc2VtaXJyb3ItdjEcZA0VbwEAAAAAAAA="
    func testImportsSnapshotAndExportsNonEmptyUpdateAndVersion() async throws {
        let source = try serverPage()
        let seed = canonicalPageText(in: source)
        try seed.insert(pos: 0, s: "server")
        source.commit()

        let output = try await LoroInteroperabilityProbe().makeTextUpdate(
            snapshot: try source.export(mode: .snapshot),
            serverVersion: source.oplogVv().encode(),
            text: " native"
        )

        XCTAssertFalse(output.update.isEmpty)
        XCTAssertFalse(output.clientVersion.isEmpty)
        XCTAssertFalse(output.snapshot.isEmpty)
        XCTAssertEqual(output.insertedTextUTF8Count, 7)

        let reloaded = LoroDoc()
        _ = try reloaded.import(bytes: output.snapshot)
        XCTAssertFalse(reloaded.oplogVv().encode().isEmpty)
        XCTAssertEqual(canonicalPageText(in: reloaded).toString(), "server native")
    }

    func testRejectsMalformedSnapshot() async {
        do {
            _ = try await LoroInteroperabilityProbe().makeTextUpdate(snapshot: Data([0, 1, 2]), serverVersion: nil, text: "x")
            XCTFail("expected malformed snapshot")
        } catch let error as LoroInteroperabilityProbeError {
            XCTAssertEqual(error, .malformedSnapshot)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testRejectsMalformedServerVersion() async throws {
        let source = try serverPage()
        let snapshot = try source.export(mode: .snapshot)
        do {
            _ = try await LoroInteroperabilityProbe().makeTextUpdate(snapshot: snapshot, serverVersion: Data([0xff, 0xff, 0xff]), text: "x")
            XCTFail("expected malformed server version")
        } catch let error as LoroInteroperabilityProbeError {
            XCTAssertEqual(error, .malformedServerVersion)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testPublicBoundaryContainsOnlyValueTypes() async throws {
        let source = try serverPage()
        let output = try await LoroInteroperabilityProbe().makeTextUpdate(
            snapshot: try source.export(mode: .snapshot),
            serverVersion: nil,
            text: "x"
        )
        let _: Data = output.update
        let _: Data = output.clientVersion
        let _: Data = output.snapshot
        let _: Int = output.insertedTextUTF8Count
    }

    func testRejectsSnapshotWithoutCanonicalPageContainers() async throws {
        let nonPage = LoroDoc()
        _ = nonPage.getText(id: "unrelated")
        nonPage.commit()
        do {
            _ = try await LoroInteroperabilityProbe().makeTextUpdate(
                snapshot: try nonPage.export(mode: .snapshot), serverVersion: nil, text: "x"
            )
            XCTFail("expected canonical page schema rejection")
        } catch let error as LoroInteroperabilityProbeError {
            XCTAssertEqual(error, .unsupportedPageSchema)
        }
    }

    func testReplaceUsesUnicodeScalarOffsetsAndExportsDelta() async throws {
        let source = try serverPage()
        let text = canonicalPageText(in: source)
        try text.insert(pos: 0, s: "A😀e\u{301}Z")
        source.commit()
        let output = try await LoroInteroperabilityProbe().replaceTextUpdate(
            snapshot: try source.export(mode: .snapshot), serverVersion: source.oplogVv().encode(),
            text: "✨", rangeStart: 1, rangeLength: 3
        )
        let reloaded = LoroDoc()
        _ = try reloaded.import(bytes: output.snapshot)
        XCTAssertEqual(canonicalPageText(in: reloaded).toString(), "A✨Z")
        XCTAssertFalse(output.update.isEmpty)
    }

    func testStrictReplaceMutatesCapturedWorkerEmptyPageAndRetainsCanonicalContainers() async throws {
        let initial = try XCTUnwrap(Data(base64Encoded: Self.workerCanonicalSnapshotBase64))
        let first = try await LoroInteroperabilityProbe().replaceTextUpdate(snapshot: initial, serverVersion: nil, text: "x", rangeStart: 0, rangeLength: 0)
        let second = try await LoroInteroperabilityProbe().replaceTextUpdate(snapshot: first.snapshot, serverVersion: nil, text: "", rangeStart: 0, rangeLength: 1)
        let doc = LoroDoc()
        _ = try doc.import(bytes: second.snapshot)
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        XCTAssertEqual(root.get(key: "attributes")?.asLoroMap()?.get(key: "isAmgBlock")?.asValue(), .bool(value: false))
        let paragraph = try XCTUnwrap(root.get(key: "children")?.asLoroList()?.get(index: 0)?.asLoroMap())
        XCTAssertEqual(paragraph.get(key: "attributes")?.asLoroMap()?.get(key: "isAmgBlock")?.asValue(), .bool(value: false))
        let inline = try XCTUnwrap(paragraph.get(key: "children")?.asLoroList())
        XCTAssertEqual(inline.len(), 1)
        XCTAssertEqual(try XCTUnwrap(inline.get(index: 0)?.asLoroText()).toString(), "")
    }

    func testStrictReplaceRejectsMarkedCanonicalPage() async throws {
        let source = try serverPage()
        let style = StyleConfigMap.defaultRichTextConfig()
        try style.insert(key: "strong", value: style.get(key: "bold")!)
        source.configTextStyle(textStyle: style)
        let text = canonicalPageText(in: source)
        try text.insert(pos: 0, s: "marked")
        try text.mark(from: 0, to: 1, key: "strong", value: true)
        source.commit()
        do {
            _ = try await LoroInteroperabilityProbe().replaceTextUpdate(snapshot: try source.export(mode: .snapshot), serverVersion: nil, text: "!", rangeStart: 0, rangeLength: 0)
            XCTFail("marked canonical page must be rejected")
        } catch let error as LoroInteroperabilityProbeError {
            XCTAssertEqual(error, .invalidPageStructure)
        }
    }

    private func serverPage() throws -> LoroDoc {
        let doc = LoroDoc()
        let metadata = doc.getMap(id: "athenaeum-page-meta-v1")
        try metadata.insert(key: "schemaVersion", v: 1)
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        try root.insert(key: "nodeName", v: "doc")
        let rootAttributes = try root.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        try rootAttributes.insert(key: "isAmgBlock", v: false)
        let children = try root.getOrCreateListContainer(key: "children", child: LoroList())
        let paragraph = try children.insertMapContainer(pos: 0, child: LoroMap())
        try paragraph.insert(key: "nodeName", v: "paragraph")
        let paragraphAttributes = try paragraph.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        try paragraphAttributes.insert(key: "isAmgBlock", v: false)
        let paragraphChildren = try paragraph.getOrCreateListContainer(key: "children", child: LoroList())
        _ = try paragraphChildren.insertTextContainer(pos: 0, child: LoroText())
        doc.commit()
        return doc
    }

    private func canonicalPageText(in doc: LoroDoc) -> LoroText {
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        return root.get(key: "children")!.asLoroList()!.get(index: 0)!.asLoroMap()!
            .get(key: "children")!.asLoroList()!.get(index: 0)!.asLoroText()!
    }
}
