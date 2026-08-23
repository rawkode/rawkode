import XCTest
import Automerge
import AthenaeumDomain
@testable import AthenaeumCore

/// Native safety pass (`docs/rich-text-editor-decisions.md` item 6): proves
/// `PageDocumentStore.isRichTextNote`/`applyLocalSplice`'s read-only guard fires correctly for a
/// rich note (by either detection signal) and, just as importantly, that an ordinary flat-text
/// note is completely unaffected — still fully editable, exactly as before this pass.
final class PageDocumentStoreRichTextSafetyTests: XCTestCase {
    /// Real `@automerge/prosemirror`-shaped document bytes: the SAME fixture
    /// `automerge-swift-spike/Tests/AutomergeSpikeTests/RichTextCompatTests.swift` uses, built by
    /// `native/automerge-swift-spike/scratch-block-test/make-rich-doc.mjs` from real
    /// `@automerge/automerge` 3.4.1 `A.splitBlock` calls (the same primitive
    /// `@automerge/prosemirror`'s `traversal.ts` drives) — a heading, a paragraph with one
    /// "strong" mark, and a two-item bullet list. Deliberately has **no** `schemaVersion` key, so
    /// using it here also proves the defense-in-depth block-marker scan works on its own, not just
    /// alongside the version label a real Editor-core-stage document would also carry.
    // swiftlint:disable:next line_length
    private static let richDocBase64 = "hW9Kg3MPK14A7gQBEFU1COj5xhloZk3lMpmyIF4BrorfO+beKrOCv11P4PJA2REYa7Y2xFCLkyRr52Zc2RUHAQIDAhMKIwhABEMEVgINAQUCExEHEyUVgAEhAyM3NAZCL1YxV3qAAQOlAQwHAAcBfAHBAAYFAgZ/An+/uKHUBgYAfwAGAX8ABQEHBwAB2gAAAAHHAAEEQ39EBEkETn9RBFR/VwADxQAAABMAAQIAfwIKAX8AFgF/AAQBfwANAX8ACQF/AAUBAA1/v38ABH8AfwR0ZXh0AEdzBWF0dHJzB2lzRW1iZWQHcGFyZW50cwR0eXBlBWxldmVsBWF0dHJzB2lzRW1iZWQHcGFyZW50cwR0eXBlBWF0dHJzB2lzRW1iZWQHcGFyZW50cwR0eXBlAAF8BWF0dHJzB2lzRW1iZWQHcGFyZW50cwR0eXBlAAHbAAB9AcIAv38KAX49RBUBfjhJAwF+NUwMAX4bZggBfhhpBQECAgIBfn0FAwF/AgIBfQJ/AwIBfgJ/AUcNAQQBfgQACwF/ABYBfwcEAX8HDQF/AAkBfwAGAX0AAQICAXkAAQIBAAECAgF9AAECAgECAAsWfwAWFn8CBBZ/AA0WfwAJFn8ABhZtAAEAdhQAAQCWAQABAJYBtgEAAQCWAbYBSGVhZGluZyBPbmVGaXJzdCBwYXJhZ3JhcGgsIHdpdGggYm9sZCB0ZXh0IGluIGl0Lkl0ZW0gb25lSXRlbSB0d29oZWFkaW5nAXBhcmFncmFwaGxpc3QtaXRlbWJ1bGxldC1saXN0bGlzdC1pdGVtYnVsbGV0LWxpc3TbAAAAJH8Gc3Ryb25nADYG"

    private func nodeId() throws -> EntityId {
        try EntityId(validating: UUID().uuidString.lowercased())
    }

    // MARK: - The control: an ordinary flat-text note is untouched by this pass.

    func testFlatTextNoteRemainsFullyEditable() async throws {
        let serverDoc = Document()
        let textId = try serverDoc.putObject(obj: ObjId.ROOT, key: "text", ty: .Text)
        try serverDoc.spliceText(obj: textId, start: 0, delete: 0, value: "Just plain notes")

        let store = PageDocumentStore()
        let id = try nodeId()
        _ = try await store.loadFromSnapshot(nodeId: id, bytes: serverDoc.save())

        let isRich = try await store.isRichTextNote(nodeId: id)
        XCTAssertFalse(isRich, "an ordinary flat-text note must not be flagged read-only")

        let afterEdit = try await store.applyLocalSplice(nodeId: id, index: 5, deleteCount: 0, insertText: "CRDT ")
        XCTAssertEqual(afterEdit, "Just CRDT plain notes")
    }

    /// A pre-existing note that predates this pass entirely (no `schemaVersion` key at all) is
    /// indistinguishable from an explicit `schemaVersion: 1` doc — both stay fully editable.
    func testNoteWithExplicitSchemaVersionOneRemainsEditable() async throws {
        let serverDoc = Document()
        let textId = try serverDoc.putObject(obj: ObjId.ROOT, key: "text", ty: .Text)
        try serverDoc.spliceText(obj: textId, start: 0, delete: 0, value: "v1 note")
        try serverDoc.put(obj: ObjId.ROOT, key: "schemaVersion", value: .Int(1))

        let store = PageDocumentStore()
        let id = try nodeId()
        _ = try await store.loadFromSnapshot(nodeId: id, bytes: serverDoc.save())

        let isRich = try await store.isRichTextNote(nodeId: id)
        XCTAssertFalse(isRich)
        _ = try await store.applyLocalSplice(nodeId: id, index: 0, deleteCount: 0, insertText: "> ")
    }

    // MARK: - Primary signal: explicit `schemaVersion >= 2` marker.

    func testSchemaVersionTwoMarkerAloneTriggersReadOnlyEvenWithoutBlockMarkers() async throws {
        // A document that, structurally, is still flat text — the marker alone must be enough to
        // fail closed, exactly as the decisions doc specifies ("treat the version label as the
        // primary signal").
        let serverDoc = Document()
        let textId = try serverDoc.putObject(obj: ObjId.ROOT, key: "text", ty: .Text)
        try serverDoc.spliceText(obj: textId, start: 0, delete: 0, value: "looks flat but isn't")
        try serverDoc.put(obj: ObjId.ROOT, key: "schemaVersion", value: .Uint(2))

        let store = PageDocumentStore()
        let id = try nodeId()
        _ = try await store.loadFromSnapshot(nodeId: id, bytes: serverDoc.save())

        let isRich = try await store.isRichTextNote(nodeId: id)
        XCTAssertTrue(isRich)
        await assertReadOnly(store: store, id: id)
    }

    // MARK: - Defense in depth: real block-marker structure, no version label at all.

    /// The load-bearing case: a document shaped exactly like what `@automerge/prosemirror` writes
    /// (real `A.splitBlock`-created block markers — see `richDocBase64`'s doc comment), with no
    /// `schemaVersion` key present. `isRichTextNote` must still detect it via the direct
    /// structural scan, and `applyLocalSplice` must refuse to touch it — this is the exact
    /// document shape `RichTextCompatTests.testNativeSpliceAcrossBlockMarkerDeletesTheMarker`
    /// proved a native local edit can silently corrupt.
    func testRealBlockMarkerStructureTriggersReadOnlyWithoutAnySchemaVersionLabel() async throws {
        guard let bytes = Data(base64Encoded: Self.richDocBase64) else {
            XCTFail("bad base64 fixture")
            return
        }

        let store = PageDocumentStore()
        let id = try nodeId()
        let loadedText = try await store.loadFromSnapshot(nodeId: id, bytes: bytes)
        // Sanity check this is really the garbled-block-marker text `RichTextCompatTests`
        // documents, not some other fixture.
        XCTAssertTrue(loadedText.unicodeScalars.contains { $0.value == 0xFFFC })

        let isRich = try await store.isRichTextNote(nodeId: id)
        XCTAssertTrue(isRich)
        await assertReadOnly(store: store, id: id)

        // Reads remain completely unaffected — only local-write attempts are refused.
        let rereadText = try await store.text(nodeId: id)
        XCTAssertEqual(rereadText, loadedText)
    }

    // MARK: - Adversarial-review fix: real single-paragraph note, primary signal now present.

    /// **Adversarial-review regression test** (blocking finding: the documented primary signal —
    /// a `schemaVersion` marker written by the web editor on every save — was never actually
    /// written anywhere in `packages/web`/`packages/backend`/`packages/domain`, so a real,
    /// freshly-created single-paragraph rich note — the most common real note shape — produced
    /// zero Automerge block-type spans and was therefore completely undetectable as "rich" by the
    /// defense-in-depth structural scan alone; `applyLocalSplice` succeeded instead of throwing).
    ///
    /// Bytes below are real Automerge doc bytes built via
    /// `native/automerge-swift-spike/scratch-block-test/make-single-paragraph-doc.mjs` against the
    /// real `@automerge/automerge` 3.4.1 build `packages/web` uses: `A.from({text:""})` genesis
    /// (same as the server's real `createPage`), "Shipped the daily-note MVP today." spliced in, a
    /// real `A.mark` (bold) over "daily-note MVP ", and `schemaVersion = 2` — all three ops in one
    /// `A.change` commit, exactly mirroring the fix in
    /// `packages/web/src/rich-text/local-doc-handle.ts`'s `LocalDocHandle.change` (content mutation
    /// and the `schemaVersion` stamp land in the SAME Automerge commit, so there is no window where
    /// this note's content exists locally without the marker). Regenerating this script's output
    /// after the fix independently confirms `A.spans(...).some(s => s.type === "block")` is still
    /// `false` — the structural gap the review found is real and unchanged — but `isRichTextNote`
    /// must now return `true` anyway, via the primary signal.
    // swiftlint:disable:next line_length
    private static let singleParagraphWithSchemaVersionDocBase64 = "hW9Kg95kAMwAgwIBECZSpK8oLfBqj/M/ULrpTPoBSr96Lw05kliXZdJGJq3vkhpmft1WZ/FxJKF7euuiZd8HAQIDAhMDIwdAA0MCVgINAQQCBBEEEw8VFiECIw80AkINVg1XIoABAqUBDAIAAgF+ASR+jvqh1AYAfgABfwACBwACIwAAAiMBAAMiAAACfgACDAF/AA4BfwAFAX4Nc2NoZW1hVmVyc2lvbgR0ZXh0ACMlAH4lXA0BfhVsDQF+CHkFAQIjfgEEDQF/Bw4BfwcGAX4UAA0WfwIOFn8ABhYCU2hpcHBlZCB0aGUgZGFpbHktbm90ZSBNVlAgdG9kYXkuJQAAD38Gc3Ryb25nABUB"

    func testRealSingleParagraphRichNoteWithSchemaVersionIsDetectedAsRichAndRefusesNativeEdit() async throws {
        guard let bytes = Data(base64Encoded: Self.singleParagraphWithSchemaVersionDocBase64) else {
            XCTFail("bad base64 fixture")
            return
        }

        let store = PageDocumentStore()
        let id = try nodeId()
        let loadedText = try await store.loadFromSnapshot(nodeId: id, bytes: bytes)
        XCTAssertEqual(loadedText, "Shipped the daily-note MVP today.")
        // Confirms the gap's structural half is still real and unfixed by itself: this note
        // genuinely has no U+FFFC block-marker glyphs, so the defense-in-depth scan alone still
        // finds nothing here.
        XCTAssertFalse(loadedText.unicodeScalars.contains { $0.value == 0xFFFC })

        // THE FIX: the primary signal (`schemaVersion >= 2`, now actually written by the real web
        // client) makes this note correctly detected as rich despite having no block markers at
        // all.
        let isRich = try await store.isRichTextNote(nodeId: id)
        XCTAssertTrue(isRich, "schemaVersion alone must be sufficient — this is exactly the real note shape the review found undetectable before the fix")
        await assertReadOnly(store: store, id: id)

        let rereadText = try await store.text(nodeId: id)
        XCTAssertEqual(rereadText, loadedText)
    }

    private func assertReadOnly(store: PageDocumentStore, id: EntityId) async {
        do {
            _ = try await store.applyLocalSplice(nodeId: id, index: 0, deleteCount: 1, insertText: "")
            XCTFail("expected richTextNoteReadOnlyOnNative")
        } catch PageDocumentStoreError.richTextNoteReadOnlyOnNative(let failedId) {
            XCTAssertEqual(failedId, id)
        } catch {
            XCTFail("expected richTextNoteReadOnlyOnNative, got \(error)")
        }
    }
}
