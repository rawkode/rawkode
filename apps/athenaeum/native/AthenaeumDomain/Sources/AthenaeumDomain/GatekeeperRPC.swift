import Foundation

// Phase 5 native stage — mirrors `packages/domain/src/gatekeeper-rpc.ts`'s eight input/output
// wire-schema pairs, `Schema.Class`, diffed by `schema-diff.ts` (see `MIRRORED_CLASSES`). See that
// TS file's own header comment for the OAuth-flow shape / role-gating rationale — these Swift
// types only need to round-trip the wire shape, not reimplement any of that.
//
// Not every method these input/output pairs describe is wired onto `WorkspaceRPCClient` this stage
// (see `WorkspaceRPCClient+Calendar.swift`'s own header comment for exactly which of the eight methods
// this native stage's "calendar day view + bookmarks capture" slice actually exercises) — these
// types are mirrored in full regardless, matching this package's existing "mirror the schema even
// before every consumer exists" convention (`sharing-rpc.ts`'s own Swift mirrors predate this
// package too).

// --- Google Calendar: connect / disconnect / sync ---------------------------------------------

public struct ConnectGoogleCalendarInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct ConnectGoogleCalendarOutput: Codable, Hashable, Sendable {
    public let authorizationUrl: String
    public let state: String
    public init(authorizationUrl: String, state: String) {
        self.authorizationUrl = authorizationUrl
        self.state = state
    }
}

public struct GoogleCalendarOAuthCallbackInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let code: String
    public let state: String
    public let calendarId: String
    public let mode: String
    public init(workspaceId: EntityId, code: String, state: String, calendarId: String, mode: String) {
        self.workspaceId = workspaceId
        self.code = code
        self.state = state
        self.calendarId = calendarId
        self.mode = mode
    }
}

public struct GoogleCalendarOAuthCallbackOutput: Codable, Hashable, Sendable {
    public let binding: GatekeeperBinding
    public init(binding: GatekeeperBinding) { self.binding = binding }
}

public struct DisconnectGoogleCalendarInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let bindingId: EntityId
    public init(workspaceId: EntityId, bindingId: EntityId) {
        self.workspaceId = workspaceId
        self.bindingId = bindingId
    }
}

public struct DisconnectGoogleCalendarOutput: Codable, Hashable, Sendable {
    public let disconnected: Bool
    public init(disconnected: Bool) { self.disconnected = disconnected }
}

public struct SyncGoogleCalendarInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let bindingId: EntityId
    public init(workspaceId: EntityId, bindingId: EntityId) {
        self.workspaceId = workspaceId
        self.bindingId = bindingId
    }
}

public struct SyncGoogleCalendarOutput: Codable, Hashable, Sendable {
    public let triggered: Bool
    public init(triggered: Bool) { self.triggered = triggered }
}

public struct ListGatekeeperBindingsInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct ListGatekeeperBindingsOutput: Codable, Hashable, Sendable {
    public let bindings: [GatekeeperBindingSummary]
    public init(bindings: [GatekeeperBindingSummary]) { self.bindings = bindings }
}

// --- Google Calendar: reads --------------------------------------------------------------------

public struct ListCalendarEventsInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let from: IsoDateTimeString?
    public let to: IsoDateTimeString?
    public init(workspaceId: EntityId, from: IsoDateTimeString? = nil, to: IsoDateTimeString? = nil) {
        self.workspaceId = workspaceId
        self.from = from
        self.to = to
    }
}

public struct ListCalendarEventsOutput: Codable, Hashable, Sendable {
    public let events: [CalendarEvent]
    public init(events: [CalendarEvent]) { self.events = events }
}

public struct LinkCalendarEventToNodeInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let calendarEventId: EntityId
    public let nodeId: EntityId
    public init(workspaceId: EntityId, calendarEventId: EntityId, nodeId: EntityId) {
        self.workspaceId = workspaceId
        self.calendarEventId = calendarEventId
        self.nodeId = nodeId
    }
}

public struct LinkCalendarEventToNodeOutput: Codable, Hashable, Sendable {
    public let calendarEvent: CalendarEvent
    public init(calendarEvent: CalendarEvent) { self.calendarEvent = calendarEvent }
}

// --- Bookmarks -----------------------------------------------------------------------------------

public struct CreateBookmarkInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let url: BookmarkUrl
    public let title: String?
    public let requestId: String
    public let commitMessage: String
    public let attribution: MutationAttribution
    public init(
        workspaceId: EntityId,
        url: BookmarkUrl,
        title: String? = nil,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution
    ) {
        self.workspaceId = workspaceId
        self.url = url
        self.title = title
        self.requestId = requestId
        self.commitMessage = commitMessage
        self.attribution = attribution
    }
}

public struct CreateBookmarkOutput: Codable, Hashable, Sendable {
    public let bookmark: Bookmark
    public init(bookmark: Bookmark) { self.bookmark = bookmark }
}

public struct ListBookmarksInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct ListBookmarksOutput: Codable, Hashable, Sendable {
    public let bookmarks: [Bookmark]
    public init(bookmarks: [Bookmark]) { self.bookmarks = bookmarks }
}
