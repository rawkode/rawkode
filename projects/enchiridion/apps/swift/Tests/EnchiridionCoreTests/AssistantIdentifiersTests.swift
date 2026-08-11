// AssistantIdentifiersTests.swift
// EnchiridionCoreTests
//
// Minimal coverage for the identity wrapper types in
// `Sources/EnchiridionCore/AssistantIdentifiers.swift`. These are plain
// `RawRepresentable` value types with no logic beyond equality/hashing, so
// this file exists mainly to pin their `Equatable`/`Hashable` semantics
// (equal raw values compare equal; distinct raw values do not) for the
// follow-on tasks (#66/#67/#68) that will key dictionaries and sets by
// these types.

import Foundation
import XCTest

@testable import EnchiridionCore

final class AssistantIdentifiersTests: XCTestCase {
  func testRealtimeInputTurnIDEqualityIsByRawValue() {
    XCTAssertEqual(RealtimeInputTurnID(rawValue: "turn-1"), RealtimeInputTurnID(rawValue: "turn-1"))
    XCTAssertNotEqual(
      RealtimeInputTurnID(rawValue: "turn-1"), RealtimeInputTurnID(rawValue: "turn-2"))
  }

  func testAssistantToolCallIDEqualityIsByRawValue() {
    XCTAssertEqual(AssistantToolCallID(rawValue: "call-1"), AssistantToolCallID(rawValue: "call-1"))
    XCTAssertNotEqual(
      AssistantToolCallID(rawValue: "call-1"), AssistantToolCallID(rawValue: "call-2"))
  }

  func testAssistantToolCallIDIsUsableAsADictionaryKey() {
    var ledger: [AssistantToolCallID: Int] = [:]
    ledger[AssistantToolCallID(rawValue: "call-1")] = 1
    ledger[AssistantToolCallID(rawValue: "call-2")] = 2

    XCTAssertEqual(ledger[AssistantToolCallID(rawValue: "call-1")], 1)
    XCTAssertEqual(ledger[AssistantToolCallID(rawValue: "call-2")], 2)
    XCTAssertNil(ledger[AssistantToolCallID(rawValue: "call-3")])
  }
}
