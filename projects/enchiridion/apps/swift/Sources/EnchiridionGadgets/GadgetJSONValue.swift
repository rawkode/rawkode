// GadgetJSONValue.swift
// EnchiridionGadgets
//
// A minimal, hand-rolled JSON value tree. Needed because the bridge's wire
// format (see GadgetBridgeMessage.swift) carries arbitrary, gadget-defined
// `params`/`result` payloads — WKScriptMessage.body arrives as
// `[String: Any]` (bridged from JS by WebKit, restricted to the JSON-ish
// subset WebKit itself allows through `postMessage`: String, NSNumber,
// Bool, NSNull, Array, Dictionary — see `init(any:)` below), and
// `evaluateJavaScript` needs a JSON *string* to inject back. `Codable`
// doesn't fit here on its own: there is no fixed Swift type on either side
// of that boundary to decode into, only "some JSON-shaped value" — the
// same reason every `Any`-based JSON bridge (Vapor's `JSON`,
// `JSONSerialization` itself) reaches for a value-tree type instead.
//
import Foundation

// Deliberately NOT `Codable` — `init(any:)`/`toFoundation()` below already
// cover the one direction this module actually needs (WKScriptMessage.body
// in, JSON string out) using `JSONSerialization`, which is the API WebKit's
// own bridging is built on; adding `Codable` on top would be a second,
// redundant encode/decode path for the same data.
public indirect enum GadgetJSONValue: Sendable, Equatable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  case array([GadgetJSONValue])
  case object([String: GadgetJSONValue])

  /// Converts a WKScriptMessage.body-shaped `Any` (or any JSONSerialization
  /// -compatible value) into a `GadgetJSONValue` tree. Returns `nil` — never
  /// traps — for anything outside the JSON-representable subset, so a
  /// malformed/unexpected payload from untrusted gadget JS is rejected as
  /// data, not a crash. `Bool` is checked via `CFGetTypeID` before the
  /// generic `NSNumber` case: Objective-C bridges `Bool`/`Int`/`Double`
  /// through the same `NSNumber` class, and `as? Bool` alone would also
  /// match `0`/`1`, so distinguishing has to happen at the `CFBoolean`
  /// level, not the Swift-type level.
  ///
  /// Bounded recursion: this type is `indirect enum`, and `.array`/
  /// `.object` recurse one native call frame per nesting level with no
  /// natural base case other than "ran out of nested containers" — a
  /// gadget can `postMessage` (or a server response via
  /// `HTTPGadgetBridgeTransport.send`, which reuses this same initializer)
  /// an adversarially deep nested-array/object structure and drive that
  /// recursion into a native Swift stack overflow, which is an uncatchable
  /// process crash, not a Swift error — directly at odds with this type's
  /// (and GadgetBridgeMessage.swift's) "parsing never traps" contract.
  /// `init(any:)` therefore delegates to the depth-tracked
  /// `init(any:depth:)` below and refuses to recurse past
  /// `maxNestingDepth`, returning `nil` (a clean, typed parse failure) the
  /// same way any other unrepresentable input is rejected.
  public init?(any value: Any) {
    self.init(any: value, depth: 0)
  }

  /// The hard cap on `.array`/`.object` nesting depth `init(any:)` will
  /// recurse into. Chosen as 32 for two reasons: (1) it comfortably covers
  /// every real gadget payload shape this bridge actually carries —
  /// `graph.query`/`graph.propose` params and results are page
  /// property bags, arrays of nodes/facts/edges, and small nested option
  /// objects, which top out at a handful of levels (single digits) even
  /// for a deeply-linked graph view; 32 is a generous multiple of that
  /// with headroom for future capability shapes without needing to be
  /// revisited. (2) it keeps the recursion's native call-stack usage
  /// trivially bounded — 32 stack frames of a small `switch`-based
  /// initializer is negligible next to even the smallest thread stack
  /// (the main thread here, since `GadgetBridgeMessageHandler` and its
  /// `evaluateJavaScript` delivery path are `@MainActor`), while still
  /// stopping a pathological thousands-deep nested array dead well before
  /// it could threaten any real stack size.
  static let maxNestingDepth = 32

  /// Depth-tracked implementation backing `init(any:)` — see that
  /// initializer's doc comment for the public contract and
  /// `maxNestingDepth` for why 32. `depth` is the nesting level already
  /// entered (0 at the top-level call); every recursive call into a
  /// child `.array`/`.object` element increments it by one.
  init?(any value: Any, depth: Int) {
    switch value {
    case is NSNull:
      self = .null
    case let number as NSNumber:
      if CFGetTypeID(number) == CFBooleanGetTypeID() {
        self = .bool(number.boolValue)
      } else {
        self = .number(number.doubleValue)
      }
    case let string as String:
      self = .string(string)
    case let array as [Any]:
      guard depth < GadgetJSONValue.maxNestingDepth else { return nil }
      var converted: [GadgetJSONValue] = []
      converted.reserveCapacity(array.count)
      for element in array {
        guard let value = GadgetJSONValue(any: element, depth: depth + 1) else { return nil }
        converted.append(value)
      }
      self = .array(converted)
    case let dictionary as [String: Any]:
      guard depth < GadgetJSONValue.maxNestingDepth else { return nil }
      var converted: [String: GadgetJSONValue] = [:]
      converted.reserveCapacity(dictionary.count)
      for (key, element) in dictionary {
        guard let value = GadgetJSONValue(any: element, depth: depth + 1) else { return nil }
        converted[key] = value
      }
      self = .object(converted)
    default:
      // Anything else (a raw JS function reference WebKit refused to
      // bridge, an opaque native object, ...) is unrepresentable — reject
      // rather than guess.
      return nil
    }
  }

  /// The `Foundation`-bridged form `JSONSerialization` accepts/produces —
  /// the inverse of `init(any:)`.
  public func toFoundation() -> Any {
    switch self {
    case .string(let value): return value
    case .number(let value): return value
    case .bool(let value): return value
    case .null: return NSNull()
    case .array(let values): return values.map { $0.toFoundation() }
    case .object(let values): return values.mapValues { $0.toFoundation() }
    }
  }

  /// Looks up a string-valued field of a `.object`, or `nil` if this isn't
  /// an object, the key is absent, or the value isn't a string. Used by
  /// `GadgetBridge`'s scope checks (e.g. `graph.propose`'s `params.pageID`)
  /// so those checks read as plain optional chaining instead of repeating
  /// this `switch` inline at every call site.
  public func stringValue(forKey key: String) -> String? {
    guard case .object(let fields) = self, case .string(let value)? = fields[key] else { return nil }
    return value
  }
}

public enum GadgetJSONValueError: Error, Sendable, Equatable {
  case notJSONEncodable
}

extension GadgetJSONValue {
  /// Renders this value as a compact JSON string via `JSONSerialization` —
  /// the same encoder WebKit's own `postMessage` bridging is built on, so
  /// there is one JSON dialect in play across this whole module, not two.
  /// `.fragmentsAllowed` lets a bare `.string`/`.number`/... encode too (not
  /// just `.object`/`.array`), since `result` payloads aren't always an
  /// object.
  public func jsonString() throws -> String {
    let data: Data
    do {
      data = try JSONSerialization.data(withJSONObject: toFoundation(), options: [.fragmentsAllowed])
    } catch {
      throw GadgetJSONValueError.notJSONEncodable
    }
    guard let string = String(data: data, encoding: .utf8) else {
      throw GadgetJSONValueError.notJSONEncodable
    }
    return string
  }
}
