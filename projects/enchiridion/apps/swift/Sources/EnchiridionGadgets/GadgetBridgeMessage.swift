// GadgetBridgeMessage.swift
// EnchiridionGadgets
//
// The bridge's wire vocabulary — deliberately narrow (task brief: "a
// narrow postMessage bridge"). A gadget's JS sends exactly one shape in:
//
//   { id: string, type: "graph.query" | "graph.propose" |
//     "gatekeeper.google.calendar.read" | "schedule.cron",
//     view?: string, params?: <JSON> }
//
// and the native side sends exactly one shape back (GadgetBridgeResponse,
// below this type). There is no second message family, no arbitrary RPC
// method name, no free-form path/verb the JS chooses — every field here
// maps directly onto `GadgetCapabilityType`/`GadgetCapabilityScope`
// (GadgetCapabilityTypes.swift), which is itself the closed vocabulary the
// server enforces. This is what "the bridge is the ONLY channel in or out"
// (task brief) actually looks like in code: a fixed, parseable shape in,
// a fixed shape out, nothing else reachable from the WebView's JS context
// (see GadgetWebViewHost.swift for how the WebView's OWN network access is
// separately disabled — this file only covers the bridge's message shape,
// not the network-isolation half of that boundary).
//
// PARSING NEVER TRAPS: `WKScriptMessage.body` (GadgetBridgeMessageHandler
// .swift's actual input) comes from untrusted gadget JS — a gadget can
// `postMessage` literally anything JS can express (wrong types, missing
// fields, extra junk, a bare string, `undefined`/`null` itself). Every
// parse failure below becomes a typed `GadgetBridgeParseError` via
// `Result`, never a forced unwrap/crash — this is the "malformed/
// unexpected message shapes ... are rejected safely, not crashing the
// bridge" requirement, and it is enforced by this file's types alone (no
// `try!`/`as!` anywhere on this path).

import Foundation

/// One capability request decoded from the WebView's `postMessage` call.
/// `id` is opaque to this module — it exists purely so the JS-side shim
/// (GadgetBridgeJavaScriptShim.swift) can correlate an async response with
/// the `Promise` it created; nothing here validates its uniqueness or
/// format beyond "non-empty string, present".
public struct GadgetBridgeRequest: Sendable, Equatable {
  public let id: String
  public let capabilityType: GadgetCapabilityType
  /// Required for `.graphQuery` (the pre-defined view name), unused by the
  /// other capability types. Modeled as `String?` rather than one field per
  /// capability type because only `graph.query` needs it — see
  /// `graph-query-views.ts`'s `GRAPH_QUERY_VIEWS` for the server's view
  /// registry this names into.
  public let view: String?
  public let params: GadgetJSONValue?

  public init(id: String, capabilityType: GadgetCapabilityType, view: String? = nil, params: GadgetJSONValue? = nil) {
    self.id = id
    self.capabilityType = capabilityType
    self.view = view
    self.params = params
  }
}

/// Why a `postMessage` body failed to parse into a `GadgetBridgeRequest`.
/// Kept as data (not a thrown error) because a parse failure still needs a
/// best-effort response delivered back into the WebView when possible —
/// see `GadgetBridgeMalformedRequest` below.
public enum GadgetBridgeParseError: Error, Sendable, Equatable {
  /// `message.body` wasn't even a `[String: Any]` — e.g. the gadget called
  /// `postMessage("hello")` or `postMessage(42)` instead of an object.
  case notAnObject
  /// No usable `"id"` string field — see `GadgetBridgeMalformedRequest`'s
  /// doc comment for why this one is treated specially.
  case missingID
  /// No usable `"type"` string field.
  case missingType
  /// `"type"` was present but isn't one of `GadgetCapabilityType`'s raw
  /// values.
  case unknownType(String)
  /// `"params"` was present but isn't JSON-representable (see
  /// `GadgetJSONValue.init(any:)`).
  case invalidParams
}

/// A parse failure paired with whatever `id` could still be recovered.
/// `id == nil` only when the body isn't an object at all, or has no usable
/// `id` field — in that case there is no way to correlate a response with
/// the JS `Promise` that sent it, so `GadgetBridgeMessageHandler` drops it
/// (logged, not delivered) rather than guessing. Every OTHER failure case
/// still carries the request's `id`, so the JS side's `Promise` can be
/// rejected with a real error instead of hanging forever.
public struct GadgetBridgeMalformedRequest: Error, Sendable, Equatable {
  public let id: String?
  public let error: GadgetBridgeParseError
}

extension GadgetBridgeRequest {
  /// Parses a `WKScriptMessage.body`-shaped `Any` into a
  /// `GadgetBridgeRequest`. Never throws/traps — every failure path
  /// returns `.failure`, matching this file's header ("parsing never
  /// traps").
  public static func parse(messageBody: Any) -> Result<GadgetBridgeRequest, GadgetBridgeMalformedRequest> {
    guard let dictionary = messageBody as? [String: Any] else {
      return .failure(GadgetBridgeMalformedRequest(id: nil, error: .notAnObject))
    }
    guard let id = dictionary["id"] as? String, !id.isEmpty else {
      return .failure(GadgetBridgeMalformedRequest(id: nil, error: .missingID))
    }
    guard let typeRaw = dictionary["type"] as? String else {
      return .failure(GadgetBridgeMalformedRequest(id: id, error: .missingType))
    }
    guard let capabilityType = GadgetCapabilityType(rawValue: typeRaw) else {
      return .failure(GadgetBridgeMalformedRequest(id: id, error: .unknownType(typeRaw)))
    }
    let view = dictionary["view"] as? String

    var params: GadgetJSONValue?
    if let rawParams = dictionary["params"] {
      guard let converted = GadgetJSONValue(any: rawParams) else {
        return .failure(GadgetBridgeMalformedRequest(id: id, error: .invalidParams))
      }
      params = converted
    }

    return .success(GadgetBridgeRequest(id: id, capabilityType: capabilityType, view: view, params: params))
  }
}

/// The response delivered back into the WebView (via `evaluateJavaScript`
/// — see GadgetBridgeJavaScriptShim.swift). Always carries the originating
/// request's `id` so the JS shim can resolve/reject the matching
/// `Promise`; exactly one of `.success`/`.failure` — there is no
/// partial/ambiguous outcome a gadget could misinterpret as success.
public struct GadgetBridgeResponse: Sendable, Equatable {
  public enum Outcome: Sendable, Equatable {
    case success(GadgetJSONValue)
    /// `code` is a short machine-checkable string (`"capability_denied"`,
    /// `"invalid_request"`, `"transport_error"`) — see
    /// `GadgetBridge.DenialCode` and `GadgetBridgeMessageHandler` for the
    /// codes actually produced. `message` is human-readable, safe to
    /// surface in a gadget's own UI.
    case failure(code: String, message: String)
  }

  public let id: String
  public let outcome: Outcome

  public init(id: String, outcome: Outcome) {
    self.id = id
    self.outcome = outcome
  }

  /// The JSON-object form injected into the WebView:
  /// `{"id": ..., "ok": true, "result": ...}` or
  /// `{"id": ..., "ok": false, "error": {"code": ..., "message": ...}}`.
  public var jsonValue: GadgetJSONValue {
    switch outcome {
    case .success(let result):
      return .object(["id": .string(id), "ok": .bool(true), "result": result])
    case .failure(let code, let message):
      return .object([
        "id": .string(id), "ok": .bool(false),
        "error": .object(["code": .string(code), "message": .string(message)]),
      ])
    }
  }
}
