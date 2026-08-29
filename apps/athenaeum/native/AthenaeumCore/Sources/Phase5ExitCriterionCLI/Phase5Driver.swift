import Foundation
import AthenaeumDomain
import AthenaeumRPC

// Phase 5 native stage exit-criterion driver.
//
// Verifies, for real, this stage's own scope ("extend the minimum real slice: a calendar day view
// ... and a bookmarks capture affordance... confirm via a CLI-driver-style test that native can
// list bookmarks/calendar events created via the scripted double") — same "process-per-step CLI,
// driven by an external orchestrator" shape as `Phase2Driver`/`Phase3Driver`/`Phase4Driver` (see
// `Phase4Driver.swift`'s own header comment for the pattern this follows).
//
// This driver exposes all eight Phase 5 RPC methods as subcommands (not just the two the shipped
// app UI wires up — `listCalendarEvents`/`createBookmark`/`listBookmarks`, see
// `CalendarDayView.swift`/`BookmarksView.swift`), so the OAuth-connect/callback/sync/link/
// disconnect surface is independently proven end-to-end even though this stage's app-UI slice
// deliberately doesn't ship a UI affordance for those yet.
//
// Every subcommand talks to the real backend over the real `AthenaeumRPC` HTTP-batch transport and
// the real dev-auth route — nothing here is stubbed or mocked. The one deliberate exception, named
// explicitly (not hidden): `enable-scripted-calendar`/`disable-scripted-calendar` hit the backend's
// own `/__dev__/enable-scripted-calendar` route (`packages/backend/src/index.ts`), which installs
// `makeDevScriptedCalendarGatekeeperClient()` — a fixture Google Calendar double — in place of the
// real `GATEKEEPER_GOOGLE_CALENDAR` service binding, for the identical reason the web-stage
// verification used it: **no real Google OAuth client id/secret exists in this environment, and no
// real Google account is available** (this task's own hard constraint). Everything downstream of
// that double — the OAuth state round trip, the `GatekeeperBinding` write, the calendar-merge sync,
// the `calendarEvents` rows, the bookmarks capture — is real backend logic exercised over real Cap'n
// Web RPC, not simulated by this driver.

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

/// Plain HTTP GET against one of the backend's `/__dev__/*` routes — these are not Cap'n Web RPC
/// methods (see `index.ts`'s own routing: they're checked before the `/api/workspace/:id` match), so
/// this is a bare `URLSession` call, same "plain JSON/text HTTP, not a batch RPC call" choice
/// `DevAuthClient.swift` makes for `/api/dev/sign-in`.
func hitDevRoute(_ path: String, backendURL: URL) async throws -> String {
    var request = URLRequest(url: backendURL.appendingPathComponent(path))
    request.httpMethod = "GET"
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        fail("\(path) failed: HTTP \(status)")
    }
    return String(data: data, encoding: .utf8) ?? ""
}

@main
struct Phase5Driver {
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
            fail("usage: phase5-driver <subcommand> [args] --backend <url> [--workspace <id>] [--credential <token>]")
        }
        let subcommand = args.removeFirst()
        let allArgs = CommandLine.arguments.map { $0 }

        let backendURLString = optionValue(allArgs, "--backend") ?? ProcessInfo.processInfo.environment["ATHENAEUM_BACKEND_URL"]
        guard let backendURLString else { fail("--backend <url> (or ATHENAEUM_BACKEND_URL) is required") }
        guard let backendURL = URL(string: backendURLString) else { fail("invalid backend URL: \(backendURLString)") }

        let credential = optionValue(allArgs, "--credential") ?? ProcessInfo.processInfo.environment["ATHENAEUM_CREDENTIAL"]

        let flagsWithValues: Set<String> = [
            "--backend", "--workspace", "--credential", "--calendar-id", "--mode", "--code", "--title", "--from", "--to", "--request-id"
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

        // Subcommands that talk to the backend Worker's root, not a workspace.
        switch subcommand {
        case "sign-in":
            let email = requireArg(positional, 0, "email")
            let result = try await DevAuthClient.signIn(email: email, backendURL: backendURL)
            print("CREDENTIAL: \(result.credential)")
            print("EMAIL: \(result.email)")
            return

        case "enable-scripted-calendar":
            let body = try await hitDevRoute("/__dev__/enable-scripted-calendar", backendURL: backendURL)
            print("RESPONSE: \(body)")
            return

        case "disable-scripted-calendar":
            let body = try await hitDevRoute("/__dev__/disable-scripted-calendar", backendURL: backendURL)
            print("RESPONSE: \(body)")
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
        case "connect-calendar":
            let (authorizationUrl, state) = try await client.connectGoogleCalendar()
            print("AUTHORIZATION_URL: \(authorizationUrl)")
            print("STATE: \(state)")

        case "callback-calendar":
            let state = requireArg(positional, 0, "state")
            let calendarId = optionValue(allArgs, "--calendar-id") ?? "primary"
            let mode = optionValue(allArgs, "--mode") ?? "selected"
            let code = optionValue(allArgs, "--code") ?? "native-driver-code"
            let binding = try await client.googleCalendarOAuthCallback(
                code: code, state: state, calendarId: calendarId, mode: mode
            )
            print("BINDING_ID: \(binding.id)")
            print("GATEKEEPER_KIND: \(binding.gatekeeperKind)")
            print("CALENDAR_ID: \(binding.calendarId ?? "<none>")")
            print("MODE: \(binding.mode ?? "<none>")")

        case "sync-calendar":
            let bindingId = requireArg(positional, 0, "bindingId")
            let triggered = try await client.syncGoogleCalendar(bindingId: bindingId)
            print("TRIGGERED: \(triggered)")

        case "seed-calendar":
            // Convenience: connect -> callback -> sync in one process, against the scripted
            // double (see this file's header comment) — mirrors the exact sequence the web stage
            // verified live in a real browser, minus the browser.
            let calendarId = optionValue(allArgs, "--calendar-id") ?? "primary"
            let mode = optionValue(allArgs, "--mode") ?? "selected"
            let (_, state) = try await client.connectGoogleCalendar()
            let binding = try await client.googleCalendarOAuthCallback(
                code: "native-driver-code", state: state, calendarId: calendarId, mode: mode
            )
            let triggered = try await client.syncGoogleCalendar(bindingId: binding.id)
            print("BINDING_ID: \(binding.id)")
            print("TRIGGERED: \(triggered)")

        case "disconnect-calendar":
            let bindingId = requireArg(positional, 0, "bindingId")
            let disconnected = try await client.disconnectGoogleCalendar(bindingId: bindingId)
            print("DISCONNECTED: \(disconnected)")

        case "list-calendar-events":
            let from = optionValue(allArgs, "--from")
            let to = optionValue(allArgs, "--to")
            let events = try await client.listCalendarEvents(from: from, to: to)
            print("EVENT_COUNT: \(events.count)")
            for event in events.sorted(by: { $0.start.isoString < $1.start.isoString }) {
                let attendeeEmails = event.attendees.map(\.email).joined(separator: ",")
                print("EVENT: \(event.id) title=\"\(event.title)\" start=\(event.start.isoString) end=\(event.end.isoString) status=\(event.status) attendees=[\(attendeeEmails)]")
            }

        case "link-calendar-event":
            let calendarEventId = requireArg(positional, 0, "calendarEventId")
            let nodeId = requireArg(positional, 1, "nodeId")
            let event = try await client.linkCalendarEventToNode(calendarEventId: calendarEventId, nodeId: nodeId)
            print("CALENDAR_EVENT_ID: \(event.id)")
            print("LINKED_NODE_ID: \(event.linkedNodeId ?? "<none>")")

        case "create-bookmark":
            let url = requireArg(positional, 0, "url")
            let title = optionValue(allArgs, "--title")
            let bookmark = try await client.createBookmark(
                url: url,
                title: title,
                // Supplying --request-id lets a diagnostic rerun replay the same capture after an
                // uncertain response; absent the flag, each intentional CLI invocation is new.
                requestId: optionValue(allArgs, "--request-id") ?? UUID().uuidString.lowercased(),
                commitMessage: "Capture this bookmark from the Phase 5 driver.",
                attribution: MutationAttribution(version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos")
            )
            print("BOOKMARK_ID: \(bookmark.id)")
            print("BOOKMARK_URL: \(bookmark.url)")
            print("BOOKMARK_TITLE: \(bookmark.title ?? "<none>")")

        case "list-bookmarks":
            let bookmarks = try await client.listBookmarks()
            print("BOOKMARK_COUNT: \(bookmarks.count)")
            for bookmark in bookmarks {
                print("BOOKMARK: \(bookmark.id) url=\(bookmark.url) title=\(bookmark.title ?? "<none>") capturedAt=\(bookmark.capturedAt)")
            }

        default:
            fail("unknown subcommand: \(subcommand)")
        }
    }
}
