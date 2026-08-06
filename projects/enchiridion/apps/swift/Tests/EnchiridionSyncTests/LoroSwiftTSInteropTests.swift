// LoroSwiftTSInteropTests.swift
// EnchiridionSyncTests
//
// The TS->Swift half of the cross-language interop proof (plan Risk #1's
// most important P0 requirement — see loro-swift-interop.test.ts's header
// comment for the full picture and GenerateLoroInteropFixtures.swift for
// the Swift->TS half). Consumes
// packages/graph-core/src/__fixtures__/loro-interop/ts-exported-snapshot.{bin,expected.json}
// — real `loro-crdt` (WASM) output, generated once via
// `GENERATE_LORO_FIXTURES=1 bun test src/loro-swift-interop.test.ts` from
// workers/vault/ (see that file's header for the exact command) — and
// asserts the real `loro-swift` decode of those exact bytes matches the
// JSON sidecar's expected text, rich-text marks, and map values.
//
// Always runs (no env-var gate): unlike the generator tests, this is pure
// consumption of an already-committed fixture, so it's part of the regular
// `swift test` suite and regresses loudly if a future loro-swift/loro-crdt
// version bump ever breaks wire compatibility.

import Foundation
import Loro
import XCTest

@testable import EnchiridionCore
@testable import EnchiridionSync

final class LoroSwiftTSInteropTests: XCTestCase {
  func testImportsTypeScriptExportedSnapshotViaProductionPath() async throws {
    let bytes = try loadLoroInteropSnapshotBytes(named: "ts-exported-snapshot.bin")
    let expectation = try loadLoroInteropExpectation(named: "ts-exported-snapshot.expected.json")
    XCTAssertEqual(expectation["generatedBy"] as? String, "typescript")

    let bodyContainer = try XCTUnwrap(expectation["bodyContainer"] as? String)
    let mapContainer = try XCTUnwrap(expectation["objectMetadataContainer"] as? String)
    let expectedText = try XCTUnwrap(expectation["bodyText"] as? String)

    // The real production import path: LoroEngine.importBytes, exactly what
    // the sync client calls when a device receives a snapshot/update from
    // the vault. A fresh, empty PageID — this fixture carries its own full
    // history (a snapshot export), so nothing needs to pre-exist locally.
    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000F2")!)
    let engine = LoroEngine()
    let outcome = try await engine.importBytes(bytes, into: pageID)
    XCTAssertTrue(outcome.changedState)
    XCTAssertFalse(outcome.hasPendingDependencies)

    let importedText = await engine.debugTextContent(of: pageID, container: bodyContainer)
    XCTAssertEqual(importedText, expectedText)

    // `LoroEngine`'s public surface is deliberately write/export-oriented
    // (see its file header) and has no accessor for rich-text marks or map
    // values, so — mirroring exactly what GenerateLoroInteropFixtures.swift
    // does on the generating side — a second, independent raw `Loro.LoroDoc`
    // decodes the SAME bytes for that introspection. This still proves real
    // loro-swift decoding of real loro-crdt output; it does not bypass the
    // engine for the parts the engine actually exposes (text content,
    // changedState/pending via importBytes above).
    let readback = LoroDoc()
    let readbackStatus = try readback.`import`(bytes: bytes)
    XCTAssertFalse(readbackStatus.success.isEmpty)

    let actualDeltaJSON = loroValueAsJSON(readback.getText(id: bodyContainer).getRichtextValue())
    let actualMapJSON = loroValueAsJSON(readback.getMap(id: mapContainer).getDeepValue())

    let expectedDelta = try XCTUnwrap(expectation["bodyDelta"])
    let expectedMap = try XCTUnwrap(expectation["objectMetadata"])

    XCTAssertEqual(try canonicalJSONString(actualDeltaJSON), try canonicalJSONString(expectedDelta))
    XCTAssertEqual(try canonicalJSONString(actualMapJSON), try canonicalJSONString(expectedMap))

    // Version-vector shape: the WASM side assigns its own random peer ID on
    // write (loro-storage.ts's "Peer ID" header note; LoroEngine never
    // calls setPeerId either), so exact peer IDs can't be asserted
    // cross-language. What's asserted is that the Swift side decodes a
    // real, non-empty version vector out of TS-produced bytes and that it
    // survives an encode/decode round trip — the version-vector wire format
    // itself is shared, which is exactly what the sync protocol's
    // version-vector exchange depends on.
    let vvBytes = try await engine.versionVector(of: pageID)
    XCTAssertGreaterThan(vvBytes.count, 0)
    let decodedVV = try VersionVector.decode(bytes: vvBytes)
    XCTAssertEqual(decodedVV.encode(), vvBytes)
  }
}
