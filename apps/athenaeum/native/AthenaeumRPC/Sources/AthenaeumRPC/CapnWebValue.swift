import Foundation

/// A minimal representation of capnweb's (0.11.1) wire *value* grammar — the subset this client
/// hand-implements after reading `capnweb`'s `Devaluator`/`Evaluator` source
/// (`node_modules/capnweb/dist/index.js`, functions `devaluateImpl`/`evaluateImpl`) and
/// empirically confirming the exact JSON shapes against the real running backend (see
/// `apps/athenaeum/native/docs/decisions.md` for the curl transcript this codec was verified
/// against before any Swift code was written).
///
/// Deliberately narrow: this models only the value types Athenaeum's own domain schemas actually
/// put on the wire — JSON primitives, plain objects/arrays, `Uint8Array` (Automerge sync
/// message bytes, `Schema.Uint8ArrayFromSelf`), `undefined` (an omitted `Schema.optional` field),
/// and thrown-error envelopes (`@athenaeum/domain`'s `RpcErrorEnvelope`, see `rpc-error.ts`). It
/// does NOT implement capnweb's capability types (stubs, promises, streams, dates, bigints,
/// Request/Response/Blob/Headers) — none of `WorkspaceRpcApi`'s methods (see
/// `packages/backend/src/workspace-durable-object.ts`) send or receive those, so implementing them
/// would be speculative surface area with nothing to verify it against.
public enum CapnWebValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([CapnWebValue])
    case object([String: CapnWebValue])
    case bytes(Data)
    /// The wire's `["undefined"]` tag — distinct from `.null` (wire `null`). Effect Schema's
    /// `Schema.optional(X)` decodes an *absent* key the same way `JSON.stringify` treats an
    /// object property whose value is JS `undefined`: dropped entirely, not present as `null`.
    /// `.undefined` inside `.object` fields is dropped by `toWireJSON()` for exactly that reason
    /// (see its doc comment); this case mostly matters for round-tripping a bare top-level
    /// `undefined` return value, which none of Athenaeum's current RPC methods produce but which
    /// the codec models anyway since decode-side correctness shouldn't depend on how many callers
    /// happen to hit the case today.
    case undefined
    /// capnweb's thrown-`Error` wire shape: `["error", name, message]` (see `Devaluator`'s
    /// `"error"` case) — capnweb also supports a 4th `stack` and 5th `props` element, which this
    /// client ignores on decode (Athenaeum's own `throwRpcError`/`decodeRpcError` convention,
    /// `packages/backend/src/rpc-boundary.ts` + `packages/domain/src/rpc-error.ts`, carries all
    /// error detail inside `message` as a JSON-encoded `RpcErrorEnvelope` string, never in `stack`
    /// or extra props) and never produces on encode (this client only ever *receives* errors,
    /// never throws domain errors back across the RPC boundary).
    case error(name: String, message: String)

    // MARK: - Convenience constructors

    public static func string(_ value: String?) -> CapnWebValue {
        value.map(CapnWebValue.string) ?? .null
    }

    public static func int(_ value: Int) -> CapnWebValue {
        .number(Double(value))
    }

    // MARK: - Convenience accessors (decode side)

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var intValue: Int? {
        if case .number(let n) = self { return Int(n) }
        return nil
    }

    /// The un-truncated `Double` behind a `.number` — distinct from `intValue` (which truncates),
    /// needed the moment a decoded field can carry a genuine fraction (e.g. `WorkoutSummary
    /// .durationSeconds`, `WorkoutStrengthSet.rpe`, `WorkoutCardioSplit.paceSecondsPerKilometre`
    /// — `workout.ts`) rather than the integer-only fields every decode struct before Phase 7
    /// happened to need.
    public var doubleValue: Double? {
        if case .number(let n) = self { return n }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var arrayValue: [CapnWebValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var objectValue: [String: CapnWebValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    public var bytesValue: Data? {
        if case .bytes(let d) = self { return d }
        return nil
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// Field lookup on `.object`, `.null` for a missing key (matching how a Phase 1
    /// `Schema.optional` field the server omitted decodes) — throws only when `self` isn't an
    /// object at all, which is a genuine shape mismatch, not "field absent".
    public func field(_ key: String) throws -> CapnWebValue {
        guard case .object(let fields) = self else {
            throw CapnWebError.malformedMessage("expected an object to read field \"\(key)\" from, got \(self)")
        }
        return fields[key] ?? .null
    }

    // MARK: - Encoding: Swift value -> capnweb wire JSON (as `Any`, for `JSONSerialization`)

    /// Produces the exact `Any` tree `JSONSerialization.data(withJSONObject:)` should serialize,
    /// matching capnweb's `Devaluator.devaluateImpl` byte-for-byte for every case this codec
    /// models (verified empirically — see decisions.md).
    func toWireJSON() -> Any {
        switch self {
        case .null:
            return NSNull()
        case .bool(let b):
            return b
        case .number(let n):
            return n
        case .string(let s):
            return s
        case .array(let items):
            // `Devaluator`'s "array" case wraps the mapped array in a one-element outer array —
            // the mechanism that disambiguates a plain data array from a tagged special array
            // like `["bytes", ...]` sharing the same JSON `Array` shape.
            return [items.map { $0.toWireJSON() }]
        case .object(let fields):
            var result: [String: Any] = [:]
            for (key, value) in fields {
                // `Devaluator`'s "undefined" case, at object-field position, becomes a real JS
                // `undefined` property value — which `JSON.stringify` (capnweb's own `send()`,
                // for `encodingLevel === "string"`) then omits from the object entirely. Matching
                // that here (dropping the key) rather than emitting `["undefined"]"` keeps this
                // client's request bodies byte-identical to what a real capnweb JS client would
                // send for the same optional-field-omitted input.
                if case .undefined = value { continue }
                result[key] = value.toWireJSON()
            }
            return result
        case .bytes(let data):
            return ["bytes", data.base64EncodedStringWithoutPadding()]
        case .undefined:
            return ["undefined"]
        case .error(let name, let message):
            return ["error", name, message]
        }
    }

    /// Renders `self` as one capnweb wire message line (a JSON array or object at the top
    /// level), the newline-delimited-body atom the HTTP batch transport sends/receives.
    static func encodeMessageLine(_ topLevel: [Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(topLevel) else {
            throw CapnWebError.malformedMessage("not a valid JSON top-level value: \(topLevel)")
        }
        let data = try JSONSerialization.data(withJSONObject: topLevel)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CapnWebError.malformedMessage("JSON encoding produced non-UTF8 data")
        }
        return text
    }

    // MARK: - Decoding: capnweb wire JSON -> Swift value

    /// Inverse of `toWireJSON()`, matching capnweb's `Evaluator.evaluateImpl` for every case this
    /// codec models.
    static func fromWireJSON(_ raw: Any) throws -> CapnWebValue {
        if raw is NSNull {
            return .null
        }
        if let s = raw as? String {
            return .string(s)
        }
        if let n = raw as? NSNumber {
            // `JSONSerialization` bridges both JSON `true`/`false` and JSON numbers to
            // `NSNumber`; only the CFBoolean-backed ones are actually booleans on the wire (a
            // bare Swift `n as? Bool` cast is unreliable here because `NSNumber` bridges to
            // `Bool` for *any* 0/1-valued number too, which would misclassify a legitimate
            // `.number(0)`/`.number(1)` — e.g. `SyncFeedEntry.replicaEpoch` — as a boolean).
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                return .bool(n.boolValue)
            }
            return .number(n.doubleValue)
        }
        if let arr = raw as? [Any] {
            return try fromWireArray(arr)
        }
        if let obj = raw as? [String: Any] {
            var result: [String: CapnWebValue] = [:]
            for (key, value) in obj {
                result[key] = try fromWireJSON(value)
            }
            return .object(result)
        }
        throw CapnWebError.malformedMessage("unrecognized wire JSON value of type \(type(of: raw))")
    }

    private static func fromWireArray(_ arr: [Any]) throws -> CapnWebValue {
        // `Evaluator`'s own disambiguation rule, mirrored exactly: a one-element array whose sole
        // element is itself an array is the "plain array" wrapper: unwrap one level and evaluate
        // the inner array's elements. Anything else is a tagged special array, dispatched on its
        // first (string) element.
        if arr.count == 1, let inner = arr[0] as? [Any] {
            return .array(try inner.map { try fromWireJSON($0) })
        }
        guard let tag = arr.first as? String else {
            throw CapnWebError.malformedMessage("tagged array with non-string tag: \(arr)")
        }
        switch tag {
        case "bytes":
            guard arr.count >= 2 else {
                throw CapnWebError.malformedMessage("malformed [\"bytes\", ...] value: \(arr)")
            }
            guard let b64 = arr[1] as? String, let data = Data(base64EncodedPadded: b64) else {
                throw CapnWebError.malformedMessage("invalid base64 in [\"bytes\", ...] value: \(arr)")
            }
            return .bytes(data)
        case "undefined":
            return .undefined
        case "error":
            guard arr.count >= 3, let name = arr[1] as? String, let message = arr[2] as? String else {
                throw CapnWebError.malformedMessage("malformed [\"error\", ...] value: \(arr)")
            }
            return .error(name: name, message: message)
        default:
            // A tagged type this narrow codec deliberately doesn't model (date/bigint/url/
            // headers/request/response/blob/inf/-inf/nan/stub/pipeline/import/...) — see this
            // file's top doc comment for why that's an explicit, documented scope boundary rather
            // than a gap discovered by accident.
            throw CapnWebError.unsupportedWireType(tag)
        }
    }
}

public enum CapnWebError: Error, Sendable, Equatable {
    case malformedMessage(String)
    case unsupportedWireType(String)
    case httpError(status: Int, body: String)
    /// A `["reject", id, ["error", name, message]]` response, decoded — `message` is expected to
    /// itself be a JSON-encoded `RpcErrorEnvelope` string per `@athenaeum/domain`'s convention
    /// (`rpc-error.ts`); `AthenaeumRPCError.from(remoteError:)` does that second decode.
    case remoteError(name: String, message: String)
    /// The batch response didn't contain a `resolve`/`reject` for every call id this client sent
    /// — a real protocol violation (or a transport that silently dropped part of the response),
    /// distinct from `remoteError` (a well-formed rejection).
    case missingResult(callId: Int)
}

extension Data {
    /// capnweb strips base64 padding on encode (`b64.replace(/=+$/, "")` in `Devaluator`) —
    /// `Data(base64Encoded:)` requires padding, so this re-pads to a multiple of 4 before
    /// decoding. Verified against a real `startPageSync` response's `["bytes", ...]` payload
    /// (unpadded) in `decisions.md`'s transcript.
    init?(base64EncodedPadded string: String) {
        var padded = string
        let remainder = padded.count % 4
        if remainder > 0 {
            padded += String(repeating: "=", count: 4 - remainder)
        }
        self.init(base64Encoded: padded)
    }

    func base64EncodedStringWithoutPadding() -> String {
        base64EncodedString().trimmingCharacters(in: CharacterSet(charactersIn: "="))
    }
}
