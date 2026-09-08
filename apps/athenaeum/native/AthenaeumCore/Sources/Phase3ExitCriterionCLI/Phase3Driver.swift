import Foundation
import AthenaeumDomain
import AthenaeumRPC

// Phase 3 exit-criterion driver.
//
// Verifies, for real, the plan's own Phase 3 exit criterion (`i-ve-tried-to-build-proud-thacker.md`
// §"Verification"): "an agent chat creates/links multiple notes and graph entities in one turn,
// the changes are reviewable (accept/revert) in both clients" — this CLI is the native half of
// that ("both clients"; the web half is `ChatPanel.tsx`, verified in-browser by the earlier web
// stage). Same *process-per-step* CLI shape as `phase2-driver` (`Phase2Driver.swift`'s own header
// comment explains why): each subcommand does exactly one step and exits, so an external
// orchestrator can interleave steps (and, for this driver, the backend's temporary
// `/__dev__/enable-scripted-model` route — see `index.ts`'s own doc comment) deterministically.
//
// Every subcommand talks to the real backend over the real `AthenaeumRPC` HTTP-batch transport —
// nothing here is stubbed or mocked. The one thing that *is* a test double, same as every other
// stage's verification of `AgentEditService`, is the model behind `sendChatMessage` itself (no
// real LLM API key is available in this environment, per this task's hard constraint) — this
// driver's `enable-scripted-model`/`disable-scripted-model` subcommands install/clear a
// deterministic `ModelClientScripted` script server-side via the backend's dev-only routes (see
// `packages/backend/src/index.ts`'s own doc comment on those two routes for the full rationale),
// the same mechanism `agent-edit.test.ts` uses in-process and the web stage used via
// chrome-devtools MCP against a live browser.

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
struct Phase3Driver {
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
            fail("usage: phase3-driver <subcommand> [args] --backend <url> [--workspace <id>] [--token <bearer>]")
        }
        let subcommand = args.removeFirst()
        let allArgs = CommandLine.arguments.map { $0 }

        let backendURLString = optionValue(allArgs, "--backend") ?? ProcessInfo.processInfo.environment["ATHENAEUM_BACKEND_URL"]
        guard let backendURLString else { fail("--backend <url> (or ATHENAEUM_BACKEND_URL) is required") }
        guard let backendURL = URL(string: backendURLString) else { fail("invalid backend URL: \(backendURLString)") }

        let flagsWithValues: Set<String> = ["--backend", "--workspace", "--token", "--title", "--binding", "--predicate", "--value"]
        var positional: [String] = []
        var i = 0
        while i < args.count {
            if flagsWithValues.contains(args[i]) {
                i += 2
            } else {
                positional.append(args[i])
                i += 1
            }
        }

        // These two subcommands talk to the backend Worker's root, not a workspace — handled before
        // `--workspace`/`WorkspaceRPCClient` are required.
        switch subcommand {
        case "enable-scripted-model":
            var queryItems: [URLQueryItem] = []
            if let title = optionValue(allArgs, "--title") { queryItems.append(URLQueryItem(name: "title", value: title)) }
            if let binding = optionValue(allArgs, "--binding") { queryItems.append(URLQueryItem(name: "binding", value: binding)) }
            if let predicate = optionValue(allArgs, "--predicate") { queryItems.append(URLQueryItem(name: "predicateId", value: predicate)) }
            if let value = optionValue(allArgs, "--value") { queryItems.append(URLQueryItem(name: "value", value: value)) }
            var components = URLComponents(
                url: backendURL.appendingPathComponent("__dev__/enable-scripted-model"),
                resolvingAgainstBaseURL: false
            )!
            components.queryItems = queryItems.isEmpty ? nil : queryItems
            let (_, response) = try await URLSession.shared.data(from: components.url!)
            print("ENABLE_SCRIPTED_MODEL_STATUS: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            return

        case "disable-scripted-model":
            let (_, response) = try await URLSession.shared.data(
                from: backendURL.appendingPathComponent("__dev__/disable-scripted-model")
            )
            print("DISABLE_SCRIPTED_MODEL_STATUS: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            return

        default:
            break
        }

        let workspaceIdString = optionValue(allArgs, "--workspace") ?? ProcessInfo.processInfo.environment["ATHENAEUM_WORKSPACE_ID"]
        guard let workspaceIdString else { fail("--workspace <id> (or ATHENAEUM_WORKSPACE_ID) is required for '\(subcommand)'") }
        let workspaceId = try EntityId(validating: workspaceIdString)
        guard let apiURL = URL(string: "\(backendURLString)/api/workspace/\(workspaceId.rawValue)") else {
            fail("invalid backend URL: \(backendURLString)")
        }
        let bearerCredential = optionValue(allArgs, "--token") ?? ProcessInfo.processInfo.environment["ATHENAEUM_TOKEN"]
        let client = WorkspaceRPCClient(baseURL: apiURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)

        switch subcommand {
        case "create-chat":
            let title = positional.first ?? "Native driver chat"
            let chat = try await client.createChat(title: title)
            print("CHAT_ID: \(chat.id)")

        case "list-chats":
            let chats = try await client.listChats()
            print("CHAT_COUNT: \(chats.count)")
            for chat in chats { print("CHAT: \(chat.id) \(chat.title)") }

        case "send-message":
            let chatId = requireArg(positional, 0, "chatId")
            let text = requireArg(positional, 1, "text")
            let (messages, changesSequences) = try await client.sendChatMessage(chatId: chatId, text: text)
            print("MESSAGE_COUNT: \(messages.count)")
            print("CHANGES_SEQUENCES: \(changesSequences)")
            if let last = messages.last {
                print("LAST_MESSAGE: [\(last.role)] \(last.content)")
            }

        case "list-pending":
            let chatId = requireArg(positional, 0, "chatId")
            let pending = try await client.listPendingChanges(chatId: chatId)
            print("PENDING_NODE_COUNT: \(pending.nodes.count)")
            print("PENDING_FACT_COUNT: \(pending.facts.count)")
            print("PENDING_EDGE_COUNT: \(pending.edges.count)")
            for node in pending.nodes {
                let sequence = node.pending?.sequence.map(String.init) ?? "<unstamped>"
                print("PENDING_NODE: \(node.id) title=\(node.title) sequence=\(sequence)")
            }
            for fact in pending.facts {
                print("PENDING_FACT: \(fact.id) node=\(fact.nodeId) predicate=\(fact.predicateId)")
            }
            for edge in pending.edges {
                print("PENDING_EDGE: \(edge.id) \(edge.sourceNodeId) -> \(edge.targetNodeId)")
            }

        case "accept":
            let chatId = requireArg(positional, 0, "chatId")
            let review = try await client.getChatReview(chatId: chatId)
            let sequences = review.items.filter { $0.lane == "structured" && $0.stamped && $0.actionable }.map(\.sequence)
            guard let mergeThrough = sequences.max() else { fail("chat has no actionable structured changes") }
            _ = try await client.decideChatReview(chatId: chatId, operation: "accept", sequenceBoundary: mergeThrough, expectedWitness: review.witness, requestId: UUID().uuidString, message: "Accept the reviewed structured changes from the native phase-3 driver.", provenance: "native.phase3-exit-criterion")
            print("MERGED_THROUGH: \(mergeThrough)")

        case "revert":
            let chatId = requireArg(positional, 0, "chatId")
            let review = try await client.getChatReview(chatId: chatId)
            let sequences = review.items.filter { $0.lane == "structured" && $0.stamped && $0.actionable }.map(\.sequence)
            guard let revertFrom = sequences.min() else { fail("chat has no actionable structured changes") }
            _ = try await client.decideChatReview(chatId: chatId, operation: "revert", sequenceBoundary: revertFrom, expectedWitness: review.witness, requestId: UUID().uuidString, message: "Revert the reviewed structured changes from the native phase-3 driver.", provenance: "native.phase3-exit-criterion")
            print("REVERTED_FROM: \(revertFrom)")

        case "list-nodes":
            // Independent verification, bypassing the chat/pending machinery entirely: a direct
            // `listNodes` call, to prove a node is (or isn't) really visible mainline.
            let nodes = try await client.listNodes()
            print("NODE_COUNT: \(nodes.count)")
            for node in nodes { print("NODE: \(node.id) \(node.title)") }

        default:
            fail("unknown subcommand: \(subcommand)")
        }
    }
}
