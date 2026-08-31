import Foundation
import AthenaeumDomain

// Phase 5 native stage ("Extend AthenaeumDomain/AthenaeumRPC with the new schemas/methods... a
// calendar day view... and a bookmarks capture affordance") — the native client for
// `workspace-durable-object.ts`'s eight Phase 5 Cap'n Web methods (`connectGoogleCalendar`,
// `googleCalendarOAuthCallback`, `disconnectGoogleCalendar`, `syncGoogleCalendar`,
// `listCalendarEvents`, `linkCalendarEventToNode`, `createBookmark`, `listBookmarks` —
// `packages/domain/src/gatekeeper-rpc.ts`). Same `rpc(_:_:)` dispatch / hand-rolled
// "RPC*"-prefixed decode-struct convention as `WorkspaceRPCClient+Sharing.swift`/
// `WorkspaceRPCClient+Graph.swift` — deliberately its own ad-hoc decode types here (not
// `AthenaeumDomain`'s `Codable` mirrors), matching every other `WorkspaceRPCClient+*.swift` extension
// file's existing precedent (see e.g. `WorkspaceRPCClient+Sharing.swift`'s `RPCCollaboratorInfo` vs.
// `AthenaeumDomain`'s `CollaboratorInfo` — the two packages are deliberately not unified yet, per
// `AthenaeumDomain/Sources/AthenaeumDomain/RpcError.swift`'s own top doc comment: "a future stage
// should have AthenaeumRPC depend on this package's DomainError instead of maintaining its own
// copy... out of this stage's scope").
//
// **What this native stage's "minimum real slice" ships in the app UI** (per the task's own
// scoping): a calendar day view (`listCalendarEvents`) with server-authoritative binding status and
// sync-now control, plus a bookmarks capture affordance (`createBookmark`/`listBookmarks`) — see
// `CalendarDayView.swift`/`BookmarksView.swift` (`AthenaeumAppUI`). All eight methods are
// implemented here (mechanical, same pattern as every other method), and all eight were
// independently proven end-to-end against the real backend
// (`connectGoogleCalendar`/`googleCalendarOAuthCallback`/`syncGoogleCalendar` to seed real
// `calendarEvents` rows via the scripted calendar double, `listCalendarEvents` with a real
// `[from, to)` window filter, `createBookmark`/`listBookmarks`, `linkCalendarEventToNode`, and
// `disconnectGoogleCalendar`; see `Phase5Driver.swift`'s own verification transcript in this
// stage's report) — but only `listCalendarEvents`/`listGatekeeperBindings`/`syncGoogleCalendar`/
// `createBookmark`/`listBookmarks` are wired into the shipped app UI this pass. `connectGoogleCalendar`/
// `googleCalendarOAuthCallback` (real native
// OAuth browser-redirect handling) and a `disconnectGoogleCalendar`/`linkCalendarEventToNode` UI
// affordance are explicitly out of scope for the app-UI slice this pass (verified only via the CLI
// driver) — see this stage's report for why (no real Google OAuth client/account in this
// environment, and "minimum real slice" scoping).

/// Mirrors `AthenaeumDomain`'s `CalendarEventTime` (`calendar-event.ts`'s `Schema.Union`) —
/// hand-decoded on the shared `kind` discriminant, same tagged-union convention as
/// `WorkspaceRPCClient+Sharing.swift`'s `RPCPermissionEdge`.
public enum RPCCalendarEventTime: Sendable, Equatable {
    case date(date: String)
    case dateTime(dateTime: String, timeZone: String?)

    init(_ value: CapnWebValue) throws {
        guard let kind = try value.field("kind").stringValue else {
            throw CapnWebError.malformedMessage("malformed CalendarEventTime (missing kind): \(value)")
        }
        switch kind {
        case "date":
            guard let date = try value.field("date").stringValue else {
                throw CapnWebError.malformedMessage("malformed CalendarEventTime(date): \(value)")
            }
            self = .date(date: date)
        case "dateTime":
            guard let dateTime = try value.field("dateTime").stringValue else {
                throw CapnWebError.malformedMessage("malformed CalendarEventTime(dateTime): \(value)")
            }
            self = .dateTime(dateTime: dateTime, timeZone: try value.field("timeZone").stringValue)
        default:
            throw CapnWebError.malformedMessage("unknown CalendarEventTime kind: \(kind)")
        }
    }

    func toWire() -> CapnWebValue {
        switch self {
        case .date(let date):
            return .object(["kind": .string("date"), "date": .string(date)])
        case .dateTime(let dateTime, let timeZone):
            var fields: [String: CapnWebValue] = ["kind": .string("dateTime"), "dateTime": .string(dateTime)]
            fields["timeZone"] = timeZone.map(CapnWebValue.string) ?? .undefined
            return .object(fields)
        }
    }

    /// The wall-clock instant this time value represents, best-effort — matches
    /// `AthenaeumDomain.CalendarEventTime.isoString`'s convenience.
    public var isoString: String {
        switch self {
        case .date(let date): return date
        case .dateTime(let dateTime, _): return dateTime
        }
    }
}

/// Mirrors `AthenaeumDomain`'s `CalendarEventAttendee`.
public struct RPCCalendarEventAttendee: Sendable, Equatable {
    public let email: String
    public let displayName: String?

    init(_ value: CapnWebValue) throws {
        guard let email = try value.field("email").stringValue else {
            throw CapnWebError.malformedMessage("malformed CalendarEventAttendee: \(value)")
        }
        self.email = email
        self.displayName = try value.field("displayName").stringValue
    }
}

/// Mirrors `AthenaeumDomain`'s `CalendarEvent` — see `calendar-event.ts`'s own header comment for
/// the recurring-event identity (`seriesId`/`occurrenceId`/`masterRecordId`) rationale.
public struct RPCCalendarEvent: Sendable, Equatable {
    public let id: String
    public let workspaceId: String
    public let providerEventId: String
    public let seriesId: String?
    public let occurrenceId: String?
    public let masterRecordId: String?
    public let title: String
    public let start: RPCCalendarEventTime
    public let end: RPCCalendarEventTime
    public let attendees: [RPCCalendarEventAttendee]
    public let status: String
    public let linkedNodeId: String?
    public let syncedAt: String

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let providerEventId = try value.field("providerEventId").stringValue,
              let title = try value.field("title").stringValue,
              let status = try value.field("status").stringValue,
              let syncedAt = try value.field("syncedAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed CalendarEvent: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.providerEventId = providerEventId
        self.seriesId = try value.field("seriesId").stringValue
        self.occurrenceId = try value.field("occurrenceId").stringValue
        self.masterRecordId = try value.field("masterRecordId").stringValue
        self.title = title
        self.start = try RPCCalendarEventTime(value.field("start"))
        self.end = try RPCCalendarEventTime(value.field("end"))
        self.attendees = try (value.field("attendees").arrayValue ?? []).map(RPCCalendarEventAttendee.init)
        self.status = status
        self.linkedNodeId = try value.field("linkedNodeId").stringValue
        self.syncedAt = syncedAt
    }
}

/// Mirrors `AthenaeumDomain`'s `Bookmark`.
public struct RPCBookmark: Sendable, Equatable {
    public let id: String
    public let workspaceId: String
    public let url: String
    public let title: String?
    public let capturedAt: String
    public let linkedNodeId: String?

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let url = try value.field("url").stringValue,
              let capturedAt = try value.field("capturedAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed Bookmark: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.url = url
        self.title = try value.field("title").stringValue
        self.capturedAt = capturedAt
        self.linkedNodeId = try value.field("linkedNodeId").stringValue
    }
}

/// Mirrors `AthenaeumDomain`'s `GatekeeperBinding` — the `googleCalendarOAuthCallback` response
/// shape. `config` is left as the raw `CapnWebValue` (its own `calendarId`/`mode` fields, matching
/// `GoogleCalendarBindingConfig`) since this is the only call site that needs it, and a single
/// gatekeeper kind exists today (`gatekeeper-binding.ts`'s own "extensible, one member today").
public struct RPCGatekeeperBinding: Sendable, Equatable {
    public let id: String
    public let workspaceId: String
    public let gatekeeperKind: String
    public let boundBy: String
    public let calendarId: String?
    public let mode: String?
    public let createdAt: String

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let gatekeeperKind = try value.field("gatekeeperKind").stringValue,
              let boundBy = try value.field("boundBy").stringValue,
              let createdAt = try value.field("createdAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed GatekeeperBinding: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.gatekeeperKind = gatekeeperKind
        self.boundBy = boundBy
        let config = try value.field("config")
        self.calendarId = try config.field("calendarId").stringValue
        self.mode = try config.field("mode").stringValue
        self.createdAt = createdAt
    }
}

/// Sanitized management projection returned by `listGatekeeperBindings`. It intentionally has no
/// account, credential, or provider connection identity.
public struct RPCGatekeeperBindingSummary: Sendable, Equatable {
    public let id: String
    public let workspaceId: String
    public let gatekeeperKind: String
    public let mode: String
    public let createdAt: String
    /// Privacy-safe provider account alias. `nil` preserves old-server compatibility.
    public let accountAlias: String?

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let gatekeeperKind = try value.field("gatekeeperKind").stringValue,
              let mode = try value.field("mode").stringValue,
              let createdAt = try value.field("createdAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed GatekeeperBindingSummary: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.gatekeeperKind = gatekeeperKind
        self.mode = mode
        self.createdAt = createdAt
        self.accountAlias = try value.field("accountAlias").stringValue
    }
}

/// Opaque completion handle returned by the Workspace-owned OAuth admission.
public struct RPCGoogleCalendarConnectionAttempt: Sendable, Equatable {
    public let attemptHandle: String
}

/// Safe completion projection; provider codes, state, tokens, and custody receipts never cross it.
public enum RPCGoogleCalendarConnectionCompletion: Sendable, Equatable {
    case pending
    case connected(binding: RPCGatekeeperBindingSummary)
    case failed
    case expired

    init(_ value: CapnWebValue) throws {
        guard let status = try value.field("status").stringValue else {
            throw CapnWebError.malformedMessage("malformed Google Calendar completion (missing status): \(value)")
        }
        switch status {
        case "pending": self = .pending
        case "connected": self = .connected(binding: try RPCGatekeeperBindingSummary(value.field("binding")))
        case "failed": self = .failed
        case "expired": self = .expired
        default: throw CapnWebError.malformedMessage("unknown Google Calendar completion status: \(status)")
        }
    }
}

extension WorkspaceRPCClient {
    // MARK: - Google Calendar: connect / disconnect / sync

    /// Creates/replays an authenticated, provenance-bearing OAuth admission. The returned handle
    /// is opaque and stable across retries; native callers may retain it locally for polling.
    public func beginGoogleCalendarConnection(
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution
    ) async throws -> RPCGoogleCalendarConnectionAttempt {
        let result = try await rpc("beginGoogleCalendarConnection", [
            "requestId": .string(requestId),
            "commitMessage": .string(commitMessage),
            "attribution": .object([
                "version": .string(attribution.version),
                "kind": .string(attribution.kind),
                "surface": attribution.surface.map(CapnWebValue.string) ?? .undefined,
                "jobId": attribution.jobId.map(CapnWebValue.string) ?? .undefined,
                "runId": attribution.runId.map(CapnWebValue.string) ?? .undefined,
                "source": attribution.source.map(CapnWebValue.string) ?? .undefined
            ])
        ])
        guard let attemptHandle = try result.field("attemptHandle").stringValue else {
            throw CapnWebError.malformedMessage("beginGoogleCalendarConnection response missing attemptHandle")
        }
        return RPCGoogleCalendarConnectionAttempt(attemptHandle: attemptHandle)
    }

    /// Issues a one-time, first-party launch URL. It is not a provider authorization URL.
    public func issueGoogleCalendarLaunch(attemptHandle: String) async throws -> URL {
        let result = try await rpc("issueGoogleCalendarLaunch", ["attemptHandle": .string(attemptHandle)])
        guard let raw = try result.field("fixedLaunchUrl").stringValue, let url = URL(string: raw) else {
            throw CapnWebError.malformedMessage("issueGoogleCalendarLaunch response missing fixedLaunchUrl")
        }
        return url
    }

    /// Reads the owner-fenced completion projection for an opaque stable handle.
    public func getGoogleCalendarConnectionCompletion(
        attemptHandle: String
    ) async throws -> RPCGoogleCalendarConnectionCompletion {
        let result = try await rpc("getGoogleCalendarConnectionCompletion", ["attemptHandle": .string(attemptHandle)])
        return try RPCGoogleCalendarConnectionCompletion(result)
    }

    /// `role` gate: `"build"` (`workspace-durable-object.ts`'s Phase 5 section) — requires a real
    /// caller (`init(bearerCredential:)`).
    public func connectGoogleCalendar() async throws -> (authorizationUrl: String, state: String) {
        let result = try await rpc("connectGoogleCalendar", [:])
        guard let authorizationUrl = try result.field("authorizationUrl").stringValue,
              let state = try result.field("state").stringValue
        else { throw CapnWebError.malformedMessage("connectGoogleCalendar response missing authorizationUrl/state") }
        return (authorizationUrl, state)
    }

    /// Completes the OAuth exchange and finalizes the `GatekeeperBinding` for `calendarId`/`mode`
    /// in the same call (`gatekeeper-rpc.ts`'s own header comment). `mode` is `"selected"` or
    /// `"allVisible"` (`docs/observers.md`'s Strategy B/C split).
    public func googleCalendarOAuthCallback(
        code: String,
        state: String,
        calendarId: String,
        mode: String
    ) async throws -> RPCGatekeeperBinding {
        let result = try await rpc("googleCalendarOAuthCallback", [
            "code": .string(code),
            "state": .string(state),
            "calendarId": .string(calendarId),
            "mode": .string(mode)
        ])
        return try RPCGatekeeperBinding(result.field("binding"))
    }

    /// Not wired into the shipped app UI this pass (no disconnect affordance yet) — see this
    /// file's top doc comment. Proven live by `Phase5Driver`'s `disconnect-calendar` subcommand.
    public func disconnectGoogleCalendar(bindingId: String) async throws -> Bool {
        let result = try await rpc("disconnectGoogleCalendar", ["bindingId": .string(bindingId)])
        return try result.field("disconnected").boolValue ?? false
    }

    /// Manually triggers an incremental sync pass for `bindingId` — see `gatekeeper-rpc.ts`'s own
    /// doc comment: returns only an acknowledgement, not the synced events themselves (the native
    /// day view re-reads `listCalendarEvents` after the acknowledgement).
    public func syncGoogleCalendar(bindingId: String) async throws -> Bool {
        let result = try await rpc("syncGoogleCalendar", ["bindingId": .string(bindingId)])
        return try result.field("triggered").boolValue ?? false
    }

    // MARK: - Google Calendar: reads

    /// Lists this workspace's synced `CalendarEvent` rows, optionally bounded to `[from, to)`
    /// (ISO-8601 strings) — the read `CalendarDayView` (`AthenaeumAppUI`) drives.
    public func listCalendarEvents(from: String? = nil, to: String? = nil) async throws -> [RPCCalendarEvent] {
        var args: [String: CapnWebValue] = [:]
        args["from"] = from.map(CapnWebValue.string) ?? .undefined
        args["to"] = to.map(CapnWebValue.string) ?? .undefined
        let result = try await rpc("listCalendarEvents", args)
        return try (result.field("events").arrayValue ?? []).map(RPCCalendarEvent.init)
    }

    /// Lists server-authoritative, sanitized binding summaries for management surfaces.
    public func listGatekeeperBindings() async throws -> [RPCGatekeeperBindingSummary] {
        let result = try await rpc("listGatekeeperBindings", ["workspaceId": .string(workspaceId)])
        return try (result.field("bindings").arrayValue ?? []).map(RPCGatekeeperBindingSummary.init)
    }

    /// Not wired into the shipped app UI this pass (no linking affordance yet) — see this file's
    /// top doc comment. Proven live by `Phase5Driver`'s `link-calendar-event` subcommand.
    public func linkCalendarEventToNode(calendarEventId: String, nodeId: String, requestId: String, commitMessage: String, attribution: MutationAttribution) async throws -> RPCCalendarEvent {
        let result = try await rpc("linkCalendarEventToNode", [
            "calendarEventId": .string(calendarEventId),
            "nodeId": .string(nodeId),
            "requestId": .string(requestId),
            "commitMessage": .string(commitMessage),
            "attribution": .object([
                "version": .string(attribution.version),
                "kind": .string(attribution.kind),
                "surface": attribution.surface.map(CapnWebValue.string) ?? .undefined,
                "jobId": attribution.jobId.map(CapnWebValue.string) ?? .undefined,
                "runId": attribution.runId.map(CapnWebValue.string) ?? .undefined,
                "source": attribution.source.map(CapnWebValue.string) ?? .undefined
            ])
        ])
        return try RPCCalendarEvent(result.field("calendarEvent"))
    }

    // MARK: - Bookmarks

    /// Captures a new bookmark (`bookmark.ts`) — the write half of the bookmarks capture
    /// affordance (`AthenaeumAppUI`'s `BookmarksView`).
    public func createBookmark(
        url: String,
        title: String? = nil,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution
    ) async throws -> RPCBookmark {
        var args: [String: CapnWebValue] = [
            "url": .string(url),
            "requestId": .string(requestId),
            "commitMessage": .string(commitMessage),
            "attribution": .object([
                "version": .string(attribution.version),
                "kind": .string(attribution.kind),
                "surface": attribution.surface.map(CapnWebValue.string) ?? .undefined,
                "jobId": attribution.jobId.map(CapnWebValue.string) ?? .undefined,
                "runId": attribution.runId.map(CapnWebValue.string) ?? .undefined,
                "source": attribution.source.map(CapnWebValue.string) ?? .undefined
            ])
        ]
        args["title"] = title.map(CapnWebValue.string) ?? .undefined
        let result = try await rpc("createBookmark", args)
        return try RPCBookmark(result.field("bookmark"))
    }

    public func listBookmarks() async throws -> [RPCBookmark] {
        let result = try await rpc("listBookmarks", [:])
        return try (result.field("bookmarks").arrayValue ?? []).map(RPCBookmark.init)
    }
}
