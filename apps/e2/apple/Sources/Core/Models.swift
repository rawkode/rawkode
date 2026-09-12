import Foundation

public enum CaptureSource: String, Codable, Sendable { case phone, mac, watch, shortcut, workspace }

/// Immutable once saved: an ID can safely be delivered more than once.
public struct Capture: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var text: String
    public var createdAt: Date
    public var source: CaptureSource
    public init(id: UUID = UUID(), text: String, createdAt: Date = .now, source: CaptureSource) {
        self.id = id; self.text = text; self.createdAt = createdAt; self.source = source
    }
}

public struct DayDraft: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var text: String
    public var updatedAt: Date
    public init(id: String, text: String = "", updatedAt: Date = .now) {
        self.id = id; self.text = text; self.updatedAt = updatedAt
    }
}

public struct AgendaEvent: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var start: Date?
    public var end: Date?
    public var allDay: Bool
    public var calendar: String?
    public init(id: String, title: String, start: Date? = nil, end: Date? = nil, allDay: Bool = false, calendar: String? = nil) {
        self.id = id; self.title = title; self.start = start; self.end = end; self.allDay = allDay; self.calendar = calendar
    }
}

public struct ContextSnapshot: Codable, Equatable, Sendable {
    public var day: String
    public var fetchedAt: Date
    public var events: [AgendaEvent]
    public init(day: String, fetchedAt: Date = .now, events: [AgendaEvent] = []) {
        self.day = day; self.fetchedAt = fetchedAt; self.events = events
    }
    public func nextEvent(at date: Date) -> AgendaEvent? {
        events.filter { !$0.allDay && ($0.end ?? $0.start ?? .distantPast) > date }
            .sorted { ($0.start ?? .distantFuture) < ($1.start ?? .distantFuture) }.first
    }
}

public struct Vault: Codable, Equatable, Sendable {
    public var version: Int = 1
    public var drafts: [DayDraft] = []
    public var captureDraft: String = ""
    public var captures: [Capture] = []
    public var archived: Set<UUID> = []
    /// Receipts mean durably stored on iPhone, not uploaded to the server.
    public var phoneReceipts: Set<UUID> = []
    public var uploaded: Set<UUID> = []
    public var context: ContextSnapshot?
    public var accountID: String?
    public init() {}
}

public enum DayIdentity {
    public static func key(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }
    public static func bounds(_ date: Date, calendar: Calendar = .current) -> (Date, Date) {
        let start = calendar.startOfDay(for: date)
        return (start, calendar.date(byAdding: .day, value: 1, to: start)!)
    }
}
