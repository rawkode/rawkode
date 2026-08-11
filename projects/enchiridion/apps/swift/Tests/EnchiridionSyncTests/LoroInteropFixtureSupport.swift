// LoroInteropFixtureSupport.swift
// EnchiridionSyncTests
//
// Shared helpers for the Loro Swift<->TypeScript cross-language interop
// fixture pair (GenerateLoroInteropFixtures.swift generates
// swift-exported-snapshot.{bin,expected.json}; LoroSwiftTSInteropTests.swift
// consumes ts-exported-snapshot.{bin,expected.json}). See
// workers/vault/src/loro-swift-interop.test.ts's header comment for the
// full picture of both directions.

import Foundation
import Loro

/// Resolves `packages/graph-core/src/__fixtures__/loro-interop/`, the
/// shared fixture directory both apps/swift and workers/vault read from —
/// same approach as GoldenIdsTests.swift's `loadFixture()`, resolved
/// relative to this file's own location via `#filePath` so both sides can
/// never accidentally read two different copies.
func loroInteropFixtureDirectory(from filePath: StaticString = #filePath) -> URL {
  let thisFileDir = ("\(filePath)" as NSString).deletingLastPathComponent
  // apps/swift/Tests/EnchiridionSyncTests -> (up 4) -> projects/enchiridion
  // -> packages/graph-core/src/__fixtures__/loro-interop
  let path = (thisFileDir as NSString).appendingPathComponent(
    "../../../../packages/graph-core/src/__fixtures__/loro-interop"
  )
  return URL(fileURLWithPath: (path as NSString).standardizingPath)
}

/// Converts a decoded `LoroValue` (as returned by
/// `LoroText.getRichtextValue()` / `LoroMap.getDeepValue()`) into a
/// `JSONSerialization`-compatible value (`NSNull`/`Bool`/`Int`/`Double`/
/// `String`/`[Any]`/`[String: Any]`). Mirrors exactly what `loro-crdt`'s
/// native `toDelta()` / `getShallowValue()` output already looks like on
/// the JS/WASM side (verified empirically — see
/// GenerateLoroInteropFixtures.swift's header comment) — no separate,
/// hand-rolled encoding convention needs to be documented for the fixture
/// sidecar format, both sides just describe the identical Loro delta/value
/// shape in JSON.
func loroValueAsJSON(_ value: LoroValue) -> Any {
  switch value {
  case .null: return NSNull()
  case .bool(let b): return b
  case .double(let d): return d
  case .i64(let i): return Int(i)
  case .binary(let data): return data.base64EncodedString()
  case .string(let s): return s
  case .list(let items): return items.map(loroValueAsJSON)
  case .map(let dict): return dict.mapValues { loroValueAsJSON($0) }
  case .container(let id): return String(describing: id)
  }
}

/// Canonicalizes any JSONSerialization-compatible value (or a value decoded
/// FROM JSON via `JSONSerialization.jsonObject`) into a stable string with
/// sorted keys, so two independently-built structures can be compared for
/// deep equality via plain string equality instead of a hand-written
/// recursive `Any`-comparison function.
func canonicalJSONString(_ value: Any) throws -> String {
  let wrapped: Any
  if value is [Any] || value is [String: Any] {
    wrapped = value
  } else {
    // JSONSerialization requires an Array or Dictionary top-level object.
    wrapped = ["value": value]
  }
  let data = try JSONSerialization.data(withJSONObject: wrapped, options: [.sortedKeys])
  return String(decoding: data, as: UTF8.self)
}

enum LoroInteropFixtureError: Error {
  case missingFile(URL)
}

/// Loads and JSON-decodes one of the checked-in `*.expected.json` sidecars.
func loadLoroInteropExpectation(named fileName: String, from filePath: StaticString = #filePath)
  throws -> [String: Any]
{
  let url = loroInteropFixtureDirectory(from: filePath).appendingPathComponent(fileName)
  guard let data = FileManager.default.contents(atPath: url.path) else {
    throw LoroInteropFixtureError.missingFile(url)
  }
  let json = try JSONSerialization.jsonObject(with: data)
  guard let dict = json as? [String: Any] else {
    throw LoroInteropFixtureError.missingFile(url)
  }
  return dict
}

/// Loads one of the checked-in `*.bin` fixture files.
func loadLoroInteropSnapshotBytes(named fileName: String, from filePath: StaticString = #filePath)
  throws -> Data
{
  let url = loroInteropFixtureDirectory(from: filePath).appendingPathComponent(fileName)
  guard let data = FileManager.default.contents(atPath: url.path) else {
    throw LoroInteropFixtureError.missingFile(url)
  }
  return data
}
