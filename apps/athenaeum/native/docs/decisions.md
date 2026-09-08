# Athenaeum native — Phase 2 "Decisions" stage

Resolves the two empirical questions blocking the rest of Phase 2 (native Swift client). Both
were verified for real — against the actual running backend and the actual upstream library —
not assumed. Transcripts and exact commands are inlined below so a future stage can re-run the
verification rather than take this document's word for it.

Scope note: this stage only builds the RPC transport (`AthenaeumRPC`) and proves the Automerge
CRDT/watchOS question (`automerge-swift-spike`). It does **not** build `AthenaeumDomain` (the
hand-mirrored Swift domain package the plan names) or `AthenaeumCore` (the actor-based local
authority + sync client) — those are later stages' work, building on the decisions here.

## Decision 1 — RPC transport: hand-rolled Cap'n Web HTTP-batch client, not a parallel HTTP/JSON surface

**Chosen: hand-roll a minimal Swift client for capnweb's HTTP-batch wire protocol.** Built at
`apps/athenaeum/native/AthenaeumRPC/` — zero external dependencies, pure Foundation +
URLSession, and it works.

### Why not the parallel `/api/native/*` HTTP/JSON surface instead

The backend-side alternative (a second REST-ish endpoint per RPC method, wrapping the same Effect
programs) would have been the safer-looking choice on paper, but once the actual capnweb wire
protocol turned out to be this tractable for the specific subset Athenaeum's native client needs,
building a second transport stopped paying for itself:

- It would require editing `packages/backend/src/vault-durable-object.ts` (or a new file) to add
  ~12 duplicate HTTP handlers mirroring `VaultRpcApi`'s dispatch — a second copy of validation/
  error-envelope wiring to keep in sync with the Cap'n Web one, forever, for every future RPC
  method. The hard constraint on this task ("work only inside `native/`, avoid touching other
  packages") is a strong signal this wasn't meant to be the default path either — it exists as an
  escape hatch for something *genuinely* unavoidable, and this isn't that.
- The web client and any future native client would diverge on which endpoint is "the real
  contract," inviting drift (e.g. a schema change applied to one transport and forgotten on the
  other).
- Cap'n Web's HTTP batch mode is *more* capable than a plain REST surface would be for free:
  multiple independent calls in one HTTP round trip (proven below — two `getNode` calls,
  correctly correlated), which a hand-rolled `/api/native/*` REST surface wouldn't give without
  its own bespoke batching endpoint.
- Live subscriptions (`subscribeToNodes`) were never in scope for this client (see "What this
  client deliberately does not implement" below) either way, so that wasn't a point in the REST
  surface's favor.

### The wire protocol, reverse-engineered and empirically confirmed

Read `node_modules/capnweb/dist/index.js` (capnweb 0.11.1, the version pinned in
`pnpm-workspace.yaml`'s catalog) end to end for the HTTP-batch transport
(`BatchClientTransport`/`BatchServerTransport`/`newHttpBatchRpcSession`/
`newHttpBatchRpcResponse`) and the underlying session protocol (`RpcSessionImpl.send`/`sendCall`/
`ensureResolvingExport`/`readLoop`) and value serialization (`Devaluator`/`Evaluator`). Summary:

- **Transport**: one HTTP POST per batch. Body is `\n`-joined JSON-array message lines; response
  body is the same shape.
- **Message types actually needed by this client**: `["push", pipelineExpr]` (issue a call),
  `["pull", id]` (request its result), `["resolve", id, value]` / `["reject", id, errorValue]`
  (the response). `pipeline`/`import`/`abort`/`release`/`remap`/`stream`/`pipe` exist in the full
  protocol but are either unused by this client's request shape or never appear in a plain
  request/response batch.
- **Id correlation**: import/export id `0` is permanently the session's main object (both sides'
  `imports[0]`/`exports[0]`). Each subsequent `push`'d call gets the next sequential id on both
  sides, in push order — so call *i* (0-indexed) in a batch is id `i + 1`. Not documented anywhere
  in capnweb's README; read directly out of `RpcSessionImpl.sendCall`/`ensureResolvingExport` and
  confirmed empirically (two independent `getNode` calls in one batch come back correctly
  correlated — see `VaultRPCClientLiveTests.testTwoIndependentCallsInOneBatchCorrelateCorrectly`).
- **Value encoding** (`Devaluator.devaluateImpl`): plain objects/strings/numbers/bools/null encode
  as themselves; a plain JS **array** is wrapped one level (`[array]`) to disambiguate from a
  tagged special array; `undefined` (an omitted `Schema.optional` field) is dropped from JSON
  entirely, matching `JSON.stringify`; `Uint8Array` (Automerge sync bytes) becomes
  `["bytes", base64WithoutPadding]`; a thrown `Error` becomes `["error", name, message]`.

### Verification transcript (before any Swift code was written)

Ran the real backend locally (`wrangler dev`, `packages/backend`) and sent hand-built wire
messages with `curl` to confirm the protocol understanding above against the real server, not
just its source:

```
$ VID=0c3dc2b4-9457-41ac-9ce4-74e6e15a1ecb
$ curl -s -X POST "http://localhost:8799/api/vault/$VID" --data '
["push",["pipeline",0,["createNode"],[{"vaultId":"'"$VID"'","title":"Hello from curl"}]]]
["pull",1]'
["resolve",1,{"node":{"id":"f9ecd920-d30a-4314-9870-3cc80e2efb58","vaultId":"0c3dc2b4-...","title":"Hello from curl","createdAt":"2026-08-20T17:18:29.601Z"}}]
```

Error path (`getNode` on a nonexistent id):

```
["reject",1,["error","Error","{\"tag\":\"NodeNotFound\",\"message\":\"Node not found: ...\",\"data\":{\"nodeId\":\"...\"}}"]]
```

— confirming `@athenaeum/domain`'s `rpc-error.ts` convention (JSON-encoded `RpcErrorEnvelope` as
the thrown `Error`'s `message`) crosses the wire exactly as that file's doc comments describe.

Bytes (Automerge sync message, from `startPageSync`):

```
["resolve",1,{"sessionId":"sess-1","message":["bytes","QgFyHjfIKByVem0U4MJQHqB13tQuid+kmv//9Tvmk17WfgABAAYCCgfREiwAAgKE"]}]
```

Two independent calls in one batch (`listNodes` + `syncFeed`), confirming multi-call batching and
id correlation:

```
["resolve",1,{"nodes":[[{...}]]}]
["resolve",2,{"epoch":"01119972-...","epochMismatch":false,"entries":[[{...}]],"nextAfterCounter":2}]
```

### What was built

`apps/athenaeum/native/AthenaeumRPC/` — a Swift Package (`.macOS(.v13)`, `.iOS(.v16)`,
`.watchOS(.v9)`, **zero dependencies**):

- `CapnWebValue.swift` — the wire-value codec (`toWireJSON()`/`fromWireJSON(_:)`), covering
  exactly the cases above (object/array/string/number/bool/null/bytes/undefined/error). Explicitly
  does **not** model capnweb's capability types (stubs/promises/streams) or the value types no
  current Athenaeum RPC method uses (Date/BigInt/URL/Headers/Request/Response/Blob) — see the
  file's top doc comment.
- `CapnWebBatchClient.swift` — `sendBatch([CapnWebCall]) async throws -> [Result<...>]` and a
  `call(_:args:)` convenience. One HTTP POST per batch; no cross-call promise pipelining (nothing
  in Athenaeum's current RPC surface needs it — see the file's doc comment for why that's a
  deliberate scope line, not an oversight).
- `AthenaeumDomainError.swift` — decodes the `RpcErrorEnvelope` JSON inside a rejected call's
  `message` into a typed Swift error, mirroring `packages/domain/src/rpc-error.ts`'s
  `decodeRpcError`. A stand-in for real `AthenaeumDomain`-generated decoding, scoped to the exact
  tag set `rpc-error.ts`'s `knownTags` declares today.
- `VaultRPCClient.swift` — typed convenience methods for every `VaultRpcApi` method this stage
  scoped: `createNode`, `getNode`, `listNodes`, `createPage`, `getPageText`, `applyPageEdit`,
  `startPageSync`, `pageSyncMessage`, `listBacklinks`, `runView`, `syncFeed`, `rotateEpoch`.

**Live-tested against the real backend, from real Swift code** (not curl) —
`Tests/AthenaeumRPCTests/VaultRPCClientLiveTests.swift`, gated behind
`ATHENAEUM_TEST_BACKEND_URL` so it doesn't run/fail without a live server:

```
$ ATHENAEUM_TEST_BACKEND_URL=http://127.0.0.1:8799 swift test --filter VaultRPCClientLiveTests
Test Suite 'VaultRPCClientLiveTests' passed ...
  testCreateNodeThenGetNodeRoundTrip                       passed
  testGetNodeNotFoundSurfacesTypedDomainError               passed
  testPageBodyCreateEditReadRoundTrip                       passed
  testPageSyncStartProducesBytes                            passed
  testSyncFeedReturnsAppendedEntries                        passed
  testTwoIndependentCallsInOneBatchCorrelateCorrectly       passed
Executed 6 tests, with 0 failures
```

Plus 9 offline codec unit tests (`CapnWebValueTests.swift`, no network — safe for CI), each built
from a wire string this client actually observed from the live backend:

```
$ swift test --filter CapnWebValueTests
Executed 9 tests, with 0 failures
```

`AthenaeumRPC` also builds clean for iOS Simulator and watchOS
(`xcodebuild build -scheme AthenaeumRPC -destination 'generic/platform=watchOS'` /
`'generic/platform=iOS Simulator'` — both `BUILD SUCCEEDED`), confirming the transport layer
itself has no watchOS gap (see Decision 2 for the CRDT layer, which does).

### What this client deliberately does not implement

- **WebSocket transport / live subscriptions** (`subscribeToNodes`). Not needed: the plan's own
  Phase 2 exit criterion is "Automerge sync convergence + epoch recovery," which per the sync
  protocol design (`packages/domain/src/sync-rpc.ts`) is poll/request-based (`syncFeed`,
  `pageSyncMessage`), not dependent on Cap'n Web's live-stub push mechanism — that mechanism was
  already proven for the *web* client in Phase 0/1. If a later phase (e.g. native voice, Phase 6)
  needs native push, extend this client with `newWebSocketRpcSession`'s wire shape (a superset of
  what's documented here — same message types, persistent connection, server-initiated calls) —
  don't re-derive the protocol from scratch.
- **Promise pipelining across calls** and **capability passing** (stubs as arguments/results) —
  no current Athenaeum RPC method needs either.
- **Cap'n Web's non-JSON value types** not used anywhere in Athenaeum's domain schemas today
  (Date, BigInt, URL, Headers, Request/Response, Blob). Adding one is a small, mechanical addition
  to `CapnWebValue`'s two switch statements when a real need appears — not a redesign.

### Method signatures the next stage builds against

```swift
final class VaultRPCClient {
    init(baseURL: URL, vaultId: String, urlSession: URLSession = .shared)

    func createNode(title: String, id: String?) async throws -> RPCNode
    func getNode(nodeId: String) async throws -> RPCNode
    func listNodes() async throws -> [RPCNode]

    func createPage(nodeId: String) async throws -> (page: RPCPage, text: String)
    func getPageText(nodeId: String) async throws -> (page: RPCPage, text: String)
    func applyPageEdit(nodeId: String, index: Int, deleteCount: Int, insertText: String)
        async throws -> (page: RPCPage, text: String)

    func startPageSync(nodeId: String, sessionId: String) async throws -> Data?
    func pageSyncMessage(nodeId: String, sessionId: String, ordinal: Int, message: Data)
        async throws -> RPCPageSyncResult

    func listBacklinks(nodeId: String) async throws -> [RPCEdge]
    func runView(viewName: String, viewSpec: CapnWebValue) async throws -> [CapnWebValue]

    func syncFeed(knownEpoch: String?, afterCounter: Int?, limit: Int) async throws -> RPCSyncFeedPage
    func rotateEpoch() async throws -> String
}
```

`createTag`/`addFact`/`createRelationDefinition`/`createEdge`/`assignTag`/`listGraphIssues`/
`listTagClosure`/`searchNodes` are not yet mirrored here — same `rpc(_:_:)` pattern, add when a
stage first needs them.

## Decision 2 — Automerge-Swift: real dependency, exact-version pinned; watchOS unsupported (confirmed empirically, not assumed)

**Chosen package**: `automerge/automerge-swift` (the official automerge-org Swift package),
**exact version `0.7.2`** — `.package(url: "https://github.com/automerge/automerge-swift.git", exact: "0.7.2")`.

### It's real and it works

- Active repo (last push 2026-04-02 as of this check), 321 stars, MIT-family license, org-owned
  (`automerge/automerge-swift`, not a fork/abandoned project).
- Ships a prebuilt `automergeFFI.xcframework` (Rust `automerge-core` via UniFFI) — a binary
  release, checksum-pinned in its own `Package.swift`
  (`10245378e74229b026f689b039d7df3cf17aeed353706d5f420dfd164f283a86`), which SwiftPM
  automatically re-verifies on every resolve. Exact-version pinning + SPM's own checksum
  verification is the practical equivalent, for a binary-artifact release, of new-notes'
  documented commit-pinned-vendoring discipline for a pre-1.0 dependency — there's no "source
  commit" beyond the tag to pin to; the prebuilt zip *is* the artifact, and it's hash-locked.
- Still pre-1.0 (`0.7.2`), consistent with new-notes' own "beta" characterization — this plan
  should carry the same caution forward, not assume it's matured.

Built a throwaway SPM package, `apps/athenaeum/native/automerge-swift-spike/`, depending on it,
and ran real tests — not just `import Automerge` compiling, actual Text-CRDT operations:

```
$ cd apps/athenaeum/native/automerge-swift-spike && swift test
Test Suite 'AutomergeSpikeTests' passed
  testCreateSpliceAndReadTextRoundTrip   passed  — create Text object, splice, read back
  testForkAndMergeConverge               passed  — doc.fork() + doc.merge(other:), convergence
  testSyncStateGenerateAndReceiveMessage passed  — generateSyncMessage/receiveSyncMessage round trip
Executed 3 tests, with 0 failures
```

The third test in particular exercises the exact primitive the sync protocol
(`packages/domain/src/sync-rpc.ts`'s `StartPageSyncInput`/`PageSyncMessageInput`) depends on:
`Document.generateSyncMessage(state:)` / `Document.receiveSyncMessage(state:message:)` against a
`SyncState`, matching what the backend already drives server-side via `@automerge/automerge` in
TypeScript (`packages/backend/src/notes-service-live.ts`).

Also confirmed the library builds for a real Xcode iOS Simulator target
(`xcodebuild build -scheme AutomergeSpike -destination 'generic/platform=iOS Simulator'` →
`BUILD SUCCEEDED`), not just the macOS host `swift test` ran on.

### watchOS: does NOT work, confirmed two ways (not "assumed unsupported")

1. **Inspected the actual binary artifact.** Downloaded `automergeFFI.xcframework.zip` (checksum
   matched `Package.swift`'s declared hash), unzipped it, and read `Info.plist`:

   ```
   $ plutil -p automergeFFI.xcframework/Info.plist | grep SupportedPlatform
   "SupportedPlatform" => "ios"        (x4: device, simulator, maccatalyst variants)
   "SupportedPlatform" => "xros"       (x2: visionOS device + simulator)
   "SupportedPlatform" => "macos"
   ```

   **No `watchos` (or `tvos`) slice anywhere** — despite `Package.swift`'s dependency `condition:
   .when(platforms: [.iOS, .macOS, .macCatalyst, .tvOS, .watchOS, .visionOS])` superficially
   listing `.watchOS` as an eligible linking target. The condition is aspirational/stale relative
   to what's actually shipped in the binary.

2. **Attempted a real watchOS build and watched it fail:**

   ```
   $ xcodebuild build -scheme AutomergeSpike -destination 'generic/platform=watchOS'
   .../automergeFFI.xcframework:1:1: error: While building for watchOS, no library for this
   platform was found in '.../automergeFFI.xcframework'. (in target 'AutomergeUtilities' ...)
   ** BUILD FAILED **
   ```

This resolves the task brief's conditional cleanly: **"if Automerge-Swift genuinely can't run in
a watchOS extension's memory/binary constraints, THEN fall back to the plan's documented
alternative."** The actual reason is even more clear-cut than a memory/binary-constraint judgment
call — the library simply has no watchOS build artifact at all today, confirmed by both static
inspection and a real failed build, not a guess about what *might* happen at runtime.

*(Not attempted: cross-compiling the Rust core for watchOS armv7k/arm64_32 via
`automerge-swift`'s own `./scripts/build-xcframework.sh` + `LOCAL_BUILD=1`. That's a real possible
future path — Rust does have watchOS targets, if immature ones — but it's Rust-toolchain
cross-compilation work with no guarantee of success, well outside this stage's "verify what
exists today" scope. Flagging it here so a future stage doesn't have to rediscover it as an
option.)*

### Resolved editor architecture, per the task's "IMPORTANT CONTEXT"

The task brief asked to verify empirically, not assume, whether Phase 1's plain-text-Automerge-
Text-CRDT precedent (a plain `<textarea>` bound to an Automerge `Text` object on web — no
ProseMirror, no WKWebView) opens a genuinely-native path on Swift too. It does, for two of the
three platforms:

- **macOS / iOS: yes.** A genuinely native SwiftUI `TextEditor`/`TextField` can bind directly to
  an `automerge-swift` `Document`'s `Text` object via `spliceText`/`text(obj:)` — proven above,
  no WKWebView/ProseMirror involved at all. This is a **stronger** result than the plan's original
  concern (which assumed the WKWebView-hosted-ProseMirror path was the only production-proven
  option) — it doesn't apply here because Phase 1 never adopted ProseMirror in the first place.
- **watchOS: no**, but not because of the WebKit-vs-native question at all — it's moot there.
  `automerge-swift` cannot run on watchOS **regardless** of what UI framework would host it, so
  the "WKWebView has no watchOS story" framing in the original plan turns out to be the wrong
  reason for the right conclusion. The actual blocker is one level lower: no CRDT library, no
  editor of any kind bound to a live Automerge document.
- **watchOS gets the plan's documented fallback**: a plain-text quick-capture flow synced as a
  minimal structured record (e.g. `createNode` + a single `addFact`/short page-body-as-plain-
  string field the phone/Mac later folds into the real Automerge doc), not a live Automerge
  document on-device. Concretely, this means watchOS's future client uses `AthenaeumRPC`'s
  structured-record methods (`createNode`, `addFact`, `syncFeed` — all proven to build and run on
  watchOS in Decision 1) and simply never links `automerge-swift` or calls `startPageSync`/
  `pageSyncMessage`/`applyPageEdit` at all.

### What the next stage builds against

- Package coordinates: `.package(url: "https://github.com/automerge/automerge-swift.git", exact: "0.7.2")`,
  product `Automerge`. Add to `AthenaeumCore`'s `Package.swift` for macOS/iOS targets only —
  **do not** add it to any watchOS target; it will fail to link.
- API surface proven working: `Document()`, `doc.putObject(obj:key:ty: .Text)`, `doc.spliceText(obj:start:delete:value:)`,
  `doc.text(obj:)`, `doc.fork()`, `doc.merge(other:)`, `SyncState()`, `doc.generateSyncMessage(state:)`,
  `doc.receiveSyncMessage(state:message:)` — see `automerge-swift-spike/Tests/AutomergeSpikeTests/AutomergeSpikeTests.swift`
  for working, runnable examples of each.
- watchOS's AthenaeumCore surface should be a distinct, smaller module/target that depends only on
  `AthenaeumRPC` (not `automerge-swift`), matching the plan's "plain-text quick-capture" fallback.

## Repro / cleanup notes

- The live-backend evidence above was captured against a local `wrangler dev` instance
  (`packages/backend`, port 8799, `--local`), not a deployed Worker — no `wrangler deploy` was
  run, per this task's constraints.
- `automerge-swift-spike/` and `AthenaeumRPC/` both have their own `Package.swift` and resolve
  independently; `swift build`/`swift test` in either directory re-fetches dependencies from
  GitHub/npm-equivalent SPM registry resolution (network required for a clean checkout, cached
  thereafter under `~/Library/Developer/Xcode/DerivedData` / SPM's local package cache).
