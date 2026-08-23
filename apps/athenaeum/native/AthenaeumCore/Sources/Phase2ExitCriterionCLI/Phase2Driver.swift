import Foundation
import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

// Phase 2 exit-criterion driver.
//
// Verifies, for real, the plan's own Phase 2 exit criterion (`i-ve-tried-to-build-proud-thacker.md`
// §"Verification"): "the same workspace syncs correctly between the web client and a native macOS
// build, verified by editing the same note concurrently on both and confirming Automerge merge
// produces the expected result, plus a forced epoch-mismatch (simulated restore) correctly
// triggers recovery-inventory bootstrap on the native client."
//
// This is a *process-per-step* CLI, not a single long-running test binary, because the other half
// of the scenario (the real web client) is driven separately, from outside Swift entirely, via
// chrome-devtools MCP browser automation — the two have to be interleaved by an external
// orchestrator so a genuine concurrent-edit ordering can be staged deterministically. Each
// subcommand below does exactly one step and exits; state that must survive between steps (the
// node/page rows, the Automerge doc snapshot bytes, the sync-feed cursor) is persisted to a real
// on-disk SQLite `LocalWorkspaceStore` (`--db <path>`), exactly the way a real native app's process
// would persist it across launches — this is not a simulation shortcut, it's the same
// durable-before-sync store `AthenaeumCore`'s own live tests use.
//
// Every subcommand talks to the real backend over the real `AthenaeumRPC` HTTP-batch transport —
// nothing here is stubbed or mocked.

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("ERROR: \(message)\n".utf8))
    exit(1)
}

func requireArg(_ args: [String], _ index: Int, _ name: String) -> String {
    guard args.count > index else { fail("missing required argument: \(name)") }
    return args[index]
}

func optionValue(_ args: [String], _ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

@main
struct Phase2Driver {
    static func main() async {
        do {
            try await run()
        } catch {
            fail("\(error)")
        }
    }

    static func run() async throws {
        var args = Array(CommandLine.arguments.dropFirst())
        guard !args.isEmpty else {
            fail("usage: phase2-driver <subcommand> [args] --db <path> --backend <url> --workspace <id> --node <id>")
        }
        let subcommand = args.removeFirst()

        let dbPath = optionValue(CommandLine.arguments.map { $0 }, "--db") ?? ProcessInfo.processInfo.environment["ATHENAEUM_DB_PATH"]
        let backendURLString = optionValue(CommandLine.arguments.map { $0 }, "--backend") ?? ProcessInfo.processInfo.environment["ATHENAEUM_BACKEND_URL"]
        let workspaceIdString = optionValue(CommandLine.arguments.map { $0 }, "--workspace") ?? ProcessInfo.processInfo.environment["ATHENAEUM_WORKSPACE_ID"]
        let nodeIdString = optionValue(CommandLine.arguments.map { $0 }, "--node") ?? ProcessInfo.processInfo.environment["ATHENAEUM_NODE_ID"]

        guard let dbPath else { fail("--db <path> (or ATHENAEUM_DB_PATH) is required") }
        guard let backendURLString else { fail("--backend <url> (or ATHENAEUM_BACKEND_URL) is required") }
        guard let workspaceIdString else { fail("--workspace <id> (or ATHENAEUM_WORKSPACE_ID) is required") }

        let workspaceId = try EntityId(validating: workspaceIdString)
        guard let apiURL = URL(string: "\(backendURLString)/api/workspace/\(workspaceId.rawValue)") else {
            fail("invalid backend URL: \(backendURLString)")
        }
        let rpcClient = WorkspaceRPCClient(baseURL: apiURL, workspaceId: workspaceId.rawValue)
        let localStore = try LocalWorkspaceStore(path: dbPath)

        // Strip recognized `--flag value` pairs out of the positional-argument list so
        // subcommands below can use plain positional args for their own payloads (e.g. the text
        // to insert) without the driver's own plumbing flags getting in the way.
        var positional: [String] = []
        var i = 0
        let flagsWithValues: Set<String> = ["--db", "--backend", "--workspace", "--node"]
        while i < args.count {
            if flagsWithValues.contains(args[i]) {
                i += 2
            } else {
                positional.append(args[i])
                i += 1
            }
        }

        switch subcommand {
        case "resolve":
            // Resolve-or-create the node + page, then run one real Automerge sync round trip to
            // pull whatever the server already has into a fresh local replica — mirrors
            // `DailyNote.tsx`'s `resolveDailyNote` / `WorkspaceSyncClient.resolveOrCreatePage`.
            guard let nodeIdString else { fail("--node <id> (or ATHENAEUM_NODE_ID) is required for 'resolve'") }
            let nodeId = try EntityId(validating: nodeIdString)
            let title = positional.first ?? "Daily Note"
            let pageStore = PageDocumentStore()
            let syncClient = WorkspaceSyncClient(localStore: localStore, pageStore: pageStore, rpcClient: rpcClient, workspaceId: workspaceId)

            _ = try await syncClient.resolveOrCreateNode(id: nodeId, title: title)
            let session = SyncSessionHandle()
            let text = try await syncClient.resolveOrCreatePage(nodeId: nodeId, session: session)
            print("RESOLVED_TEXT: \(text.debugDescription)")

        case "apply-edit":
            // Apply a local Automerge edit ONLY — deliberately does not sync. This is the
            // building block for staging genuine CRDT concurrency: call this from a local replica
            // that has not yet observed the other side's edit.
            guard let nodeIdString else { fail("--node <id> is required for 'apply-edit'") }
            let nodeId = try EntityId(validating: nodeIdString)
            let index = Int(requireArg(positional, 0, "index")) ?? 0
            let deleteCount = Int(requireArg(positional, 1, "deleteCount")) ?? 0
            let insertText = requireArg(positional, 2, "insertText")

            let pageStore = PageDocumentStore()
            guard let bytes = try await localStore.pageDocBytes(nodeId: nodeId) else {
                fail("no locally-persisted page snapshot for \(nodeId.rawValue) — run 'resolve' first")
            }
            try await pageStore.loadFromSnapshot(nodeId: nodeId, bytes: bytes)
            let syncClient = WorkspaceSyncClient(localStore: localStore, pageStore: pageStore, rpcClient: rpcClient, workspaceId: workspaceId)
            let text = try await syncClient.applyLocalEdit(nodeId: nodeId, index: index, deleteCount: deleteCount, insertText: insertText)
            print("LOCAL_TEXT_AFTER_EDIT: \(text.debugDescription)")

        case "sync":
            // Run a real sync-session round trip from the persisted local replica: pulls in
            // whatever the server has (including edits from other peers made independently — this
            // is where CRDT merge actually happens) and pushes any local-only edits up.
            guard let nodeIdString else { fail("--node <id> is required for 'sync'") }
            let nodeId = try EntityId(validating: nodeIdString)
            let pageStore = PageDocumentStore()
            guard let bytes = try await localStore.pageDocBytes(nodeId: nodeId) else {
                fail("no locally-persisted page snapshot for \(nodeId.rawValue) — run 'resolve' first")
            }
            try await pageStore.loadFromSnapshot(nodeId: nodeId, bytes: bytes)
            let syncClient = WorkspaceSyncClient(localStore: localStore, pageStore: pageStore, rpcClient: rpcClient, workspaceId: workspaceId)
            let session = SyncSessionHandle()
            let text = try await syncClient.syncPage(nodeId: nodeId, session: session)
            print("MERGED_TEXT_AFTER_SYNC: \(text.debugDescription)")

        case "read-local":
            guard let nodeIdString else { fail("--node <id> is required for 'read-local'") }
            let nodeId = try EntityId(validating: nodeIdString)
            let pageStore = PageDocumentStore()
            guard let bytes = try await localStore.pageDocBytes(nodeId: nodeId) else {
                fail("no locally-persisted page snapshot for \(nodeId.rawValue)")
            }
            let text = try await pageStore.loadFromSnapshot(nodeId: nodeId, bytes: bytes)
            print("LOCAL_TEXT: \(text.debugDescription)")

        case "read-server":
            // Independent server-side verification, bypassing `WorkspaceSyncClient`/`PageDocumentStore`
            // entirely — a direct `getPageText` RPC call through a brand-new `WorkspaceRPCClient`.
            guard let nodeIdString else { fail("--node <id> is required for 'read-server'") }
            let (_, text) = try await rpcClient.getPageText(nodeId: nodeIdString)
            print("SERVER_TEXT: \(text.debugDescription)")

        case "create-node":
            // Structured-mutation helper for the epoch-recovery scenario: creates an extra node
            // (via the durable-before-sync `WorkspaceSyncClient.createNode`) so the sync feed has
            // fresh entries to walk after a rotation.
            let title = positional.first ?? "Epoch scenario node"
            let pageStore = PageDocumentStore()
            let syncClient = WorkspaceSyncClient(localStore: localStore, pageStore: pageStore, rpcClient: rpcClient, workspaceId: workspaceId)
            let node = try await syncClient.createNode(title: title)
            print("CREATED_NODE_ID: \(node.id.rawValue)")

        case "catchup":
            // Real `catchUpStructuredSync` — prints the persisted cursor before and after so the
            // orchestrator can prove the epoch actually changed and the cursor was rebuilt, not
            // just silently reused.
            let before = try await localStore.syncFeedCursor(workspaceId: workspaceId)
            print("CURSOR_BEFORE: epoch=\(before?.epoch ?? "<none>") afterCounter=\(before?.afterCounter.map(String.init) ?? "<none>")")

            let pageStore = PageDocumentStore()
            let syncClient = WorkspaceSyncClient(localStore: localStore, pageStore: pageStore, rpcClient: rpcClient, workspaceId: workspaceId)
            let result = try await syncClient.catchUpStructuredSync()
            print("CATCHUP_EPOCH: \(result.epoch)")
            print("CATCHUP_ENTRIES_SEEN: \(result.entriesSeen)")
            print("CATCHUP_BY_KIND: \(result.byEntityKind)")

            let after = try await localStore.syncFeedCursor(workspaceId: workspaceId)
            print("CURSOR_AFTER: epoch=\(after?.epoch ?? "<none>") afterCounter=\(after?.afterCounter.map(String.init) ?? "<none>")")

        case "raw-syncfeed":
            // Low-level, independent-of-`WorkspaceSyncClient` proof that the *server itself* reports
            // `epochMismatch: true` for a deliberately stale `(epoch, afterCounter)` pair — not
            // trusting the client wrapper's own interpretation of that signal.
            let knownEpoch = positional.first
            let afterCounter = positional.count > 1 ? Int(positional[1]) : nil
            let page = try await rpcClient.syncFeed(knownEpoch: knownEpoch, afterCounter: afterCounter, limit: 100)
            print("RAW_EPOCH: \(page.epoch)")
            print("RAW_EPOCH_MISMATCH: \(page.epochMismatch)")
            print("RAW_ENTRY_COUNT: \(page.entries.count)")
            print("RAW_NEXT_AFTER_COUNTER: \(page.nextAfterCounter.map(String.init) ?? "<none>")")

        case "rotate-epoch":
            let newEpoch = try await rpcClient.rotateEpoch()
            print("NEW_EPOCH: \(newEpoch)")

        default:
            fail("unknown subcommand: \(subcommand)")
        }
    }
}
