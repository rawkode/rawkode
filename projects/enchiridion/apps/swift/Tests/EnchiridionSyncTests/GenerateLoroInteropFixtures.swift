// GenerateLoroInteropFixtures.swift
// EnchiridionSyncTests
//
// One-time fixture generator for the Loro Swift<->TypeScript cross-language
// interop proof — the single most important P0 risk this repo previously
// had NO test for (plan Risk #1: "Loro Swift bindings are experimental...
// mitigated by... the CI round-trip golden test"). Every pre-existing Loro
// test round-tripped within one runtime only (LoroEngineTests.swift is
// Swift<->Swift; loro-storage.test.ts is WASM<->WASM). This file produces
// the Swift->TS half of the real fixture pair; see
// workers/vault/src/loro-swift-interop.test.ts's header comment for the
// TS->Swift half and the full picture.
//
// Writes (checked in, NOT regenerated automatically):
//   - packages/graph-core/src/__fixtures__/loro-interop/swift-exported-snapshot.bin
//   - packages/graph-core/src/__fixtures__/loro-interop/swift-exported-snapshot.expected.json
//
// Gated behind the GENERATE_LORO_FIXTURES=1 environment variable so this
// test is SKIPPED (not run, not failed) as part of a normal `swift test`
// invocation, and never rewrites the checked-in fixture as a side effect of
// CI or a routine local test run. Loro assigns each `LoroDoc` a fresh
// random peer ID (LoroEngine never calls `setPeerId` — see its "MARK:
// Document lifecycle" section / this doc's own use of a bare `LoroEngine()`
// below), so an unconditional regeneration would change the fixture's raw
// bytes — though not its decoded meaning — on every test run, which is
// exactly the noisy/unreproducible-diff failure mode a checked-in fixture
// exists to avoid.
//
// To regenerate, from apps/swift/:
//   GENERATE_LORO_FIXTURES=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
//     swift test --filter GenerateLoroInteropFixturesTests
//
// Uses the real `LoroEngine` (EnchiridionSync) — the exact production API a
// device uses — to build the doc and export its snapshot. Container names
// ("body" text, "objectMetadata" map) and the mark vocabulary
// ("bold"/"pageReference") reuse `LoroEngine`'s own conventions
// (LoroEngine.swift's `MarkStyle` enum), matching what a real page doc
// would contain. A second, independent raw `Loro.LoroDoc` is then opened
// purely to read the resulting bytes back out (via
// `getRichtextValue()`/`getDeepValue()`) — mirroring exactly what a
// receiving TS peer's own decode does with these same bytes — so the JSON
// sidecar reflects what was ACTUALLY encoded, not an assumption about what
// should have been encoded. That readback doc does not participate in
// producing the exported bytes.

import EnchiridionCore
import EnchiridionSync
import Foundation
import Loro
import XCTest

final class GenerateLoroInteropFixturesTests: XCTestCase {
  func testGenerateSwiftExportedFixture() async throws {
    try XCTSkipUnless(
      ProcessInfo.processInfo.environment["GENERATE_LORO_FIXTURES"] == "1",
      "set GENERATE_LORO_FIXTURES=1 to (re)generate the checked-in swift-exported-snapshot fixture"
    )

    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000F1")!)
    let engine = LoroEngine()
    try await engine.createDocument(id: pageID)

    // "Hello, Enchiridion" — H(0)e(1)l(2)l(3)o(4),(5) (6)E(7)n(8)c(9)h(10)
    // i(11)r(12)i(13)d(14)i(15)o(16)n(17), length 18. "Hello" = [0,5),
    // "Enchiridion" = [7,18). Plain ASCII throughout so unicode-scalar,
    // UTF-16, and grapheme-cluster positions all coincide — sidesteps any
    // cross-language ambiguity about which position unit a mark range uses.
    let bodyText = "Hello, Enchiridion"
    try await engine.apply(.textInsert(container: "body", position: 0, text: bodyText), to: pageID)
    try await engine.apply(
      .textMark(
        container: "body", range: 0..<5, key: LoroEngine.MarkStyle.bold.rawValue, value: .bool(true)),
      to: pageID
    )
    try await engine.apply(
      .textMark(
        container: "body", range: 7..<18, key: LoroEngine.MarkStyle.pageReference.rawValue,
        value: .string("daily:2026-08-06")),
      to: pageID
    )

    try await engine.apply(
      .mapSet(container: "objectMetadata", key: "title", value: .string("Grocery list")), to: pageID)
    try await engine.apply(
      .mapSet(container: "objectMetadata", key: "priority", value: .int(2)), to: pageID)
    try await engine.apply(
      .mapSet(container: "objectMetadata", key: "done", value: .bool(false)), to: pageID)

    let snapshotBytes = try await engine.exportSnapshot(of: pageID)
    XCTAssertGreaterThan(snapshotBytes.count, 0)

    // Read the exported bytes back out via an independent doc — the same
    // bytes a TS peer will decode — to build the JSON sidecar from reality.
    let readback = LoroDoc()
    let importStatus = try readback.`import`(bytes: snapshotBytes)
    XCTAssertFalse(importStatus.success.isEmpty)

    let deltaJSON = loroValueAsJSON(readback.getText(id: "body").getRichtextValue())
    let mapJSON = loroValueAsJSON(readback.getMap(id: "objectMetadata").getDeepValue())

    let expectation: [String: Any] = [
      "generatedBy": "swift",
      "bodyContainer": "body",
      "objectMetadataContainer": "objectMetadata",
      "bodyText": bodyText,
      "bodyDelta": deltaJSON,
      "objectMetadata": mapJSON,
    ]

    let fixtureDir = loroInteropFixtureDirectory()
    try FileManager.default.createDirectory(at: fixtureDir, withIntermediateDirectories: true)

    try snapshotBytes.write(to: fixtureDir.appendingPathComponent("swift-exported-snapshot.bin"))

    let jsonData = try JSONSerialization.data(
      withJSONObject: expectation, options: [.prettyPrinted, .sortedKeys])
    var jsonWithTrailingNewline = jsonData
    jsonWithTrailingNewline.append(contentsOf: [0x0A])
    try jsonWithTrailingNewline.write(
      to: fixtureDir.appendingPathComponent("swift-exported-snapshot.expected.json"))
  }
}
