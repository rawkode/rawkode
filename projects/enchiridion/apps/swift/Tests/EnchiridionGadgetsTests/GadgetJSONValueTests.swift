// GadgetJSONValueTests.swift
// EnchiridionGadgetsTests
//
// `GadgetJSONValue` is the value tree every capability request/response
// payload flows through — both directions of `init(any:)`/`toFoundation()`
// need to round-trip correctly, and `init(any:)` must reject (not crash
// on) anything outside the JSON-representable subset, since its real input
// is untrusted gadget JS via `WKScriptMessage.body`.

import Foundation
import XCTest

@testable import EnchiridionGadgets

final class GadgetJSONValueTests: XCTestCase {
  func testInitFromStringNumberBoolNull() {
    XCTAssertEqual(GadgetJSONValue(any: "hello"), .string("hello"))
    XCTAssertEqual(GadgetJSONValue(any: 42), .number(42))
    XCTAssertEqual(GadgetJSONValue(any: 3.14), .number(3.14))
    XCTAssertEqual(GadgetJSONValue(any: true), .bool(true))
    XCTAssertEqual(GadgetJSONValue(any: false), .bool(false))
    XCTAssertEqual(GadgetJSONValue(any: NSNull()), .null)
  }

  func testInitDistinguishesBoolFromNumericNSNumber() {
    // The classic Objective-C bridging trap: `NSNumber(value: true)` and
    // `NSNumber(value: 1)` are both `NSNumber`, but only one should decode
    // as `.bool`. See GadgetJSONValue.swift's `init(any:)` doc comment for
    // why this needs `CFGetTypeID`, not `as? Bool`.
    let boolNumber = NSNumber(value: true)
    let oneNumber = NSNumber(value: 1)
    XCTAssertEqual(GadgetJSONValue(any: boolNumber), .bool(true))
    XCTAssertEqual(GadgetJSONValue(any: oneNumber), .number(1))
  }

  func testInitFromNestedArrayAndObject() {
    let raw: [String: Any] = [
      "tagID": "task",
      "limit": 10,
      "includeDeleted": false,
      "tags": ["a", "b"],
      "nested": ["x": NSNull()],
    ]
    guard case .object(let fields)? = GadgetJSONValue(any: raw) else {
      return XCTFail("expected .object")
    }
    XCTAssertEqual(fields["tagID"], .string("task"))
    XCTAssertEqual(fields["limit"], .number(10))
    XCTAssertEqual(fields["includeDeleted"], .bool(false))
    XCTAssertEqual(fields["tags"], .array([.string("a"), .string("b")]))
    XCTAssertEqual(fields["nested"], .object(["x": .null]))
  }

  func testInitRejectsUnrepresentableValueWithoutCrashing() {
    struct NotJSON {}
    // An opaque Swift value nothing in `init(any:)`'s switch matches —
    // must return nil, never trap.
    XCTAssertNil(GadgetJSONValue(any: NotJSON()))
    XCTAssertNil(GadgetJSONValue(any: Date()))
  }

  func testInitRejectsArrayContainingAnUnrepresentableValue() {
    struct NotJSON {}
    let raw: [Any] = ["ok", NotJSON()]
    XCTAssertNil(GadgetJSONValue(any: raw))
  }

  func testInitRejectsObjectContainingAnUnrepresentableValue() {
    struct NotJSON {}
    let raw: [String: Any] = ["ok": "fine", "bad": NotJSON()]
    XCTAssertNil(GadgetJSONValue(any: raw))
  }

  func testStringValueForKeyOnObject() {
    let value = GadgetJSONValue.object(["pageID": .string("daily:2026-08-06")])
    XCTAssertEqual(value.stringValue(forKey: "pageID"), "daily:2026-08-06")
    XCTAssertNil(value.stringValue(forKey: "missing"))
  }

  func testStringValueForKeyOnNonObjectReturnsNil() {
    XCTAssertNil(GadgetJSONValue.string("x").stringValue(forKey: "pageID"))
    XCTAssertNil(GadgetJSONValue.null.stringValue(forKey: "pageID"))
  }

  func testJSONStringRoundTripsThroughJSONSerialization() throws {
    let value = GadgetJSONValue.object([
      "id": .string("req-1"),
      "ok": .bool(true),
      "result": .array([.number(1), .string("two"), .null]),
    ])
    let json = try value.jsonString()
    let decoded = try JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed])
    guard let roundTripped = GadgetJSONValue(any: decoded) else {
      return XCTFail("round-tripped JSON should decode back into GadgetJSONValue")
    }
    XCTAssertEqual(roundTripped, value)
  }

  func testJSONStringEscapesSpecialCharacters() throws {
    let value = GadgetJSONValue.string("quote\" backslash\\ newline\n unicode 🎉")
    let json = try value.jsonString()
    let decoded = try JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed]) as? String
    XCTAssertEqual(decoded, "quote\" backslash\\ newline\n unicode 🎉")
  }

  // MARK: - Bounded recursion (unbounded JSON recursion fix)
  //
  // `init(any:)` is `indirect enum`-backed recursion with no natural base
  // case for `.array`/`.object` other than "no more nested containers" —
  // see `GadgetJSONValue.maxNestingDepth`'s doc comment for why 32 was
  // chosen and how the depth count works. These tests pin that contract:
  // a structure nested past the cap must return `nil` cleanly (this is as
  // close as an XCTest can get to asserting "does not crash" — the
  // meaningful assertion is that a shape deliberately built to exceed the
  // cap still returns a normal Optional, not a trap), and a structure at
  // exactly the cap must still parse, so the fix doesn't accidentally
  // reject real, merely-deeply-nested gadget payloads.

  /// Builds `levels` nested single-element arrays around a leaf value,
  /// e.g. `nestedArrays(levels: 2)` -> `[[0]]`. `levels` counts how many
  /// `.array` containers are entered before reaching the leaf, matching
  /// how `init(any:depth:)` increments `depth` once per array it recurses
  /// into.
  private func nestedArrays(levels: Int) -> Any {
    var value: Any = 0
    for _ in 0..<levels {
      value = [value]
    }
    return value
  }

  func testInitRejectsArrayNestedOneLevelPastTheCapWithoutCrashing() {
    let pastCap = nestedArrays(levels: GadgetJSONValue.maxNestingDepth + 1)
    XCTAssertNil(GadgetJSONValue(any: pastCap), "one level past the cap should be rejected")
  }

  func testInitRejectsArrayNestedFarPastTheCapWithoutCrashing() {
    // Deliberately built to be adversarial, not just barely over the
    // line — a real attacker would not stop at cap+1.
    let wayPastCap = nestedArrays(levels: 5_000)
    XCTAssertNil(GadgetJSONValue(any: wayPastCap), "a deeply adversarial structure should return nil cleanly, not crash")
  }

  func testInitAcceptsArrayNestedExactlyAtTheCap() {
    let atCap = nestedArrays(levels: GadgetJSONValue.maxNestingDepth)
    guard let parsed = GadgetJSONValue(any: atCap) else {
      return XCTFail("nesting exactly at the cap should still parse (don't break real deeply-nested gadget payloads)")
    }
    // Sanity-check it's the shape we think it is by unwrapping one level.
    guard case .array(let outer) = parsed, outer.count == 1 else {
      return XCTFail("expected a single-element array at the outermost level")
    }
    _ = outer
  }

  func testInitAcceptsArrayNestedOneLevelUnderTheCap() {
    let underCap = nestedArrays(levels: GadgetJSONValue.maxNestingDepth - 1)
    XCTAssertNotNil(GadgetJSONValue(any: underCap), "nesting comfortably under the cap must always parse")
  }

  /// Same cap, but via `.object` nesting rather than `.array` — both
  /// container cases share the same `depth` check in `init(any:depth:)`.
  private func nestedObjects(levels: Int) -> Any {
    var value: Any = "leaf"
    for _ in 0..<levels {
      value = ["child": value]
    }
    return value
  }

  func testInitRejectsObjectNestedPastTheCapWithoutCrashing() {
    let pastCap = nestedObjects(levels: GadgetJSONValue.maxNestingDepth + 1)
    XCTAssertNil(GadgetJSONValue(any: pastCap))
  }

  func testInitAcceptsObjectNestedExactlyAtTheCap() {
    let atCap = nestedObjects(levels: GadgetJSONValue.maxNestingDepth)
    XCTAssertNotNil(GadgetJSONValue(any: atCap))
  }

  /// A mixed array/object shape realistic of an actual gadget payload
  /// (e.g. a `graph.query` result: an array of node objects, each with a
  /// nested `fields` object) parses fine — the cap should never bite an
  /// ordinary shallow-to-moderate real payload.
  func testInitAcceptsRealisticMixedGadgetPayloadShape() {
    let raw: [String: Any] = [
      "nodes": [
        [
          "id": "task_1",
          "fields": ["title": "Buy milk", "tags": ["errand", "home"]],
          "edges": [["type": "blocks", "target": ["id": "task_2", "fields": ["title": "Deliver milk"]]]],
        ]
      ]
    ]
    XCTAssertNotNil(GadgetJSONValue(any: raw))
  }
}
