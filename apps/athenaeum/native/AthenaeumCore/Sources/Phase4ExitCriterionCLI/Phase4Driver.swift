import Foundation
import AthenaeumDomain
import AthenaeumRPC

// Phase 4 exit-criterion driver.
//
// Verifies, for real, the plan's own Phase 4 exit criterion (`i-ve-tried-to-build-proud-thacker.md`
// §"Sharing/observers on workspaces" + this task's own instructions): "native can sign in, see its
// Personal workspace, create a second workspace, and see a workspace shared to it by web" — this CLI is the
// native half of that cross-client verification, matching Phase 2/3's own "process-per-step CLI,
// driven by an external orchestrator alongside a real browser" shape (`Phase3Driver.swift`'s own
// header comment explains the pattern this follows).
//
// Every subcommand talks to the real backend over the real `AthenaeumRPC` HTTP-batch transport and
// the real (dev-only, HMAC-signed, non-OAuth) `POST /api/dev/sign-in` route — nothing here is
// stubbed or mocked. No `AthenaeumCore`/local-SQLite dependency: sign-in and the workspace
// catalog/sharing surface have no local-authority counterpart the way a page/node does.

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
struct Phase4Driver {
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
            fail("usage: phase4-driver <subcommand> [args] --backend <url> [--workspace <id>] [--credential <token>]")
        }
        let subcommand = args.removeFirst()
        let allArgs = CommandLine.arguments.map { $0 }

        let backendURLString = optionValue(allArgs, "--backend") ?? ProcessInfo.processInfo.environment["ATHENAEUM_BACKEND_URL"]
        guard let backendURLString else { fail("--backend <url> (or ATHENAEUM_BACKEND_URL) is required") }
        guard let backendURL = URL(string: backendURLString) else { fail("invalid backend URL: \(backendURLString)") }

        let credential = optionValue(allArgs, "--credential") ?? ProcessInfo.processInfo.environment["ATHENAEUM_CREDENTIAL"]

        let flagsWithValues: Set<String> = [
            "--backend", "--workspace", "--credential", "--title", "--role", "--note", "--keep"
        ]
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

        // Subcommands that talk to the backend Worker's root, not a workspace — handled before
        // `--workspace`/`WorkspaceRPCClient` are required.
        switch subcommand {
        case "sign-in":
            let email = requireArg(positional, 0, "email")
            let result = try await DevAuthClient.signIn(email: email, backendURL: backendURL)
            print("CREDENTIAL: \(result.credential)")
            print("EMAIL: \(result.email)")
            print("ISSUED_AT: \(result.issuedAt)")
            print("EXPIRES_AT: \(result.expiresAt)")
            return

        case "list-workspaces":
            guard let credential else { fail("--credential <token> (or ATHENAEUM_CREDENTIAL) is required for 'list-workspaces'") }
            let client = UserRPCClient(backendURL: backendURL, bearerCredential: credential)
            let workspaces = try await client.listWorkspaces()
            print("WORKSPACE_COUNT: \(workspaces.count)")
            for workspace in workspaces {
                print("WORKSPACE: \(workspace.workspaceId) title=\(workspace.title) role=\(workspace.role) isDefault=\(workspace.isDefault) owner=\(workspace.ownerId)")
            }
            return

        case "create-workspace":
            guard let credential else { fail("--credential <token> (or ATHENAEUM_CREDENTIAL) is required for 'create-workspace'") }
            let title = positional.first ?? "Untitled workspace"
            let client = UserRPCClient(backendURL: backendURL, bearerCredential: credential)
            let workspace = try await client.createWorkspace(title: title)
            print("WORKSPACE_ID: \(workspace.workspaceId)")
            print("WORKSPACE_TITLE: \(workspace.title)")
            print("WORKSPACE_IS_DEFAULT: \(workspace.isDefault)")
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
        let client = WorkspaceRPCClient(baseURL: apiURL, workspaceId: workspaceId.rawValue, bearerCredential: credential)

        switch subcommand {
        case "whoami":
            let result = try await client.whoami()
            print("AUTHENTICATED: \(result.authenticated)")
            print("EMAIL: \(result.email ?? "<none>")")

        case "list-nodes":
            // Independent verification, bypassing workspace-catalog/sharing entirely: a direct
            // `listNodes` call — with or without a credential, since `listNodes` is gated to
            // "use" role only for a real governed (owner-initialized) workspace, and stays fully open
            // for every ungoverned workspace (see `workspace-durable-object.ts`'s own doc comment).
            let nodes = try await client.listNodes()
            print("NODE_COUNT: \(nodes.count)")
            for node in nodes { print("NODE: \(node.id) \(node.title)") }

        case "create-node":
            let title = positional.first ?? "Native driver node"
            let node = try await client.createNode(title: title)
            print("NODE_ID: \(node.id)")
            print("NODE_TITLE: \(node.title)")

        case "add-collaborator":
            let profileId = requireArg(positional, 0, "profileId")
            let role = positional.count > 1 ? positional[1] : (optionValue(allArgs, "--role") ?? "use")
            let note = optionValue(allArgs, "--note")
            let collaborator = try await client.addCollaborator(profileId: profileId, role: role, note: note)
            print("COLLABORATOR: \(collaborator.profileId) role=\(collaborator.role) edges=\(collaborator.edges.count)")

        case "list-collaborators":
            let collaborators = try await client.listCollaborators()
            print("COLLABORATOR_COUNT: \(collaborators.count)")
            for c in collaborators {
                print("COLLABORATOR: \(c.profileId) role=\(c.role) edges=\(c.edges.count)")
            }

        case "preview-remove-collaborator":
            let profileId = requireArg(positional, 0, "profileId")
            let affected = try await client.previewRemoveCollaborator(profileId: profileId)
            print("AFFECTED_COUNT: \(affected.count)")
            for a in affected { print("AFFECTED: \(a.profileId) oldRole=\(a.oldRole) newRole=\(a.newRole ?? "<removed>")") }

        case "remove-collaborator":
            let profileId = requireArg(positional, 0, "profileId")
            let affected = try await client.removeCollaborator(profileId: profileId)
            print("AFFECTED_COUNT: \(affected.count)")
            for a in affected { print("AFFECTED: \(a.profileId) oldRole=\(a.oldRole) newRole=\(a.newRole ?? "<removed>")") }

        case "create-share-link":
            let role = positional.first ?? (optionValue(allArgs, "--role") ?? "use")
            let (key, link) = try await client.createShareLink(role: role, note: optionValue(allArgs, "--note"))
            print("SHARE_KEY: \(key)")
            print("SHARE_LINK_ID: \(link.id)")
            print("SHARE_LINK_ROLE: \(link.role)")

        case "redeem-share-link":
            let key = requireArg(positional, 0, "key")
            let collaborator = try await client.redeemShareLink(key: key)
            print("COLLABORATOR: \(collaborator.profileId) role=\(collaborator.role)")

        case "list-share-links":
            let links = try await client.listShareLinks()
            print("SHARE_LINK_COUNT: \(links.count)")
            for link in links { print("SHARE_LINK: \(link.id) role=\(link.role) revoked=\(link.revoked)") }

        default:
            fail("unknown subcommand: \(subcommand)")
        }
    }
}
