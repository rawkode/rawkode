import Foundation

/// One RPC call to include in a batch: `mainStub.<method>(argsObject)` — Athenaeum's entire
/// current RPC surface (`packages/backend/src/workspace-durable-object.ts`'s `WorkspaceRpcApi`) takes
/// exactly one argument, a plain object, so this client doesn't model capnweb's general
/// multi-positional-argument call shape.
public struct CapnWebCall: Sendable {
    public let method: String
    public let args: CapnWebValue

    public init(method: String, args: CapnWebValue) {
        self.method = method
        self.args = args
    }
}

/// A minimal client for capnweb's **HTTP batch** transport (`newHttpBatchRpcSession`/
/// `newHttpBatchRpcResponse` in capnweb's own source) — see
/// `apps/athenaeum/native/docs/decisions.md` for why HTTP batch (not the WebSocket transport,
/// and not a hand-rolled implementation of capnweb's full capability-passing protocol) is the
/// right scope for this client.
///
/// One `sendBatch` call = one HTTP POST = one or more independent RPC calls against the workspace's
/// main stub (`WorkspaceRpcApi`, `newWorkersRpcResponse`'s `localMain`), each getting its own
/// `push`/`pull` pair. This client deliberately does **not** implement cross-call promise
/// pipelining (using one call's still-unresolved result as another call's argument within the
/// same batch) — every method in Athenaeum's current RPC surface takes only workspace-scoped ids the
/// caller already has, none of them need to reference another call's *pending* result to be
/// constructed, so pipelining would be unused surface area, not a real capability gap. A future
/// stage that finds a genuine need for it should extend `CapnWebCall`/`sendBatch`, not treat its
/// absence here as an oversight.
///
/// ## Message correlation (why call N always gets id N)
///
/// capnweb's session protocol numbers imports/exports by the *order* push/pull messages occur,
/// with import/export `0` permanently reserved for the session's "main" object (the client's
/// `imports[0]` mirrors the server's `exports[0]`, both pointing at the root stub — see
/// `RpcSessionImpl`'s constructor in capnweb's source). Each subsequent `push` of a call
/// allocates the next sequential id on both sides in lock-step: the client's local
/// `imports.length` at push time equals the server's `exports.length` at the moment it processes
/// that same push. Concretely, for a batch of `calls[0...n]` sent in order, call `i` (0-indexed)
/// is assigned id `i + 1`, and the server's `resolve`/`reject` for that call is tagged with that
/// same id. This is *not* a capnweb-documented invariant — it's read directly out of
/// `RpcSessionImpl.sendCall`/`ensureResolvingExport` (`node_modules/capnweb/dist/index.js`) and
/// confirmed empirically (`decisions.md`'s transcript sends two independent calls in one batch
/// and observes ids `1`/`2` come back correctly correlated).
public final class CapnWebBatchClient: Sendable {
    private let baseURL: URL
    private let urlSession: URLSession
    /// Phase 4 addition: an optional dev-auth Bearer credential (`DevSignInOutput.credential`,
    /// `AthenaeumDomain`'s `auth.ts` mirror), sent on every request as `Authorization: Bearer
    /// <credential>` — the identical header `dev-auth.ts#extractBearerCredential` checks first,
    /// before its `?token=` query-parameter fallback (this client, unlike a browser `WebSocket`,
    /// can set arbitrary headers on a plain HTTP POST, so it never needs that fallback). `nil`
    /// (the default) reproduces every pre-Phase-4 call byte-for-byte — an anonymous connection,
    /// exactly as before this stage.
    private let bearerCredential: String?

    public init(baseURL: URL, urlSession: URLSession = .shared, bearerCredential: String? = nil) {
        self.baseURL = baseURL
        self.urlSession = urlSession
        self.bearerCredential = bearerCredential
    }

    /// Sends `calls` as one HTTP-batch request and returns one result per call, in the same
    /// order `calls` was given (not necessarily the order the server's response lines arrived
    /// in — this method sorts server responses back into call order before returning).
    public func sendBatch(_ calls: [CapnWebCall]) async throws -> [Result<CapnWebValue, CapnWebError>] {
        guard !calls.isEmpty else { return [] }

        var lines: [String] = []
        lines.reserveCapacity(calls.count * 2)
        for call in calls {
            // `["pipeline", 0, [methodName], [argsValue]]` — a call on import 0 (the main stub),
            // at path `[methodName]` (a single-element property path — the backend exposes each
            // RPC method as a direct method on `WorkspaceRpcApi`, not nested under a sub-object), with
            // one positional argument.
            let pipelineExpr: [Any] = ["pipeline", 0, [call.method], [call.args.toWireJSON()]]
            lines.append(try CapnWebValue.encodeMessageLine(["push", pipelineExpr]))
        }
        // Every `pull` is sent after every `push` in this client's batches (rather than
        // interleaved push/pull/push/pull) — capnweb's `BatchServerTransport.receive()` just pops
        // messages off a queue in the order the body listed them, so both orderings are valid;
        // grouping pulls together after all pushes matches how `newHttpBatchRpcSession`'s own
        // `Promise.all` usage pattern in the capnweb README naturally produces its wire bytes
        // (every call queued, then every awaited result pulled).
        for index in 1...calls.count {
            lines.append(try CapnWebValue.encodeMessageLine(["pull", index]))
        }

        var request = URLRequest(url: baseURL)
        request.httpMethod = "POST"
        request.httpBody = lines.joined(separator: "\n").data(using: .utf8)
        if let bearerCredential {
            request.setValue("Bearer \(bearerCredential)", forHTTPHeaderField: "Authorization")
        }

        let (responseData, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let body = String(data: responseData, encoding: .utf8) ?? ""
            throw CapnWebError.httpError(status: status, body: body)
        }

        let responseText = String(data: responseData, encoding: .utf8) ?? ""
        var resultsById: [Int: Result<CapnWebValue, CapnWebError>] = [:]
        if !responseText.isEmpty {
            for rawLine in responseText.split(separator: "\n", omittingEmptySubsequences: true) {
                guard let lineData = String(rawLine).data(using: .utf8) else { continue }
                let parsed = try JSONSerialization.jsonObject(with: lineData)
                guard let msg = parsed as? [Any], let tag = msg.first as? String else { continue }
                switch tag {
                case "resolve":
                    guard msg.count > 2, let id = (msg[1] as? NSNumber)?.intValue else { continue }
                    resultsById[id] = .success(try CapnWebValue.fromWireJSON(msg[2]))
                case "reject":
                    guard msg.count > 2, let id = (msg[1] as? NSNumber)?.intValue else { continue }
                    let value = try CapnWebValue.fromWireJSON(msg[2])
                    if case let .error(name, message) = value {
                        resultsById[id] = .failure(.remoteError(name: name, message: message))
                    } else {
                        resultsById[id] = .failure(.malformedMessage("reject payload wasn't a tagged error: \(value)"))
                    }
                default:
                    // "release"/"abort"/other session-management messages: none are expected as a
                    // top-level response to a batch that only ever pushes plain-value calls and
                    // never exports a capability of its own for the server to release.
                    continue
                }
            }
        }

        return try (1...calls.count).map { id in
            guard let result = resultsById[id] else {
                throw CapnWebError.missingResult(callId: id)
            }
            return result
        }
    }

    /// Convenience for the common one-call case.
    public func call(_ method: String, args: CapnWebValue) async throws -> CapnWebValue {
        let results = try await sendBatch([CapnWebCall(method: method, args: args)])
        switch results[0] {
        case .success(let value): return value
        case .failure(let error): throw error
        }
    }
}
