import Foundation

public struct ContextPerson: Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var emails: [String]
    public init(id: String, name: String, emails: [String]) { self.id = id; self.name = name; self.emails = emails }
}
public struct RepositoryActivity: Identifiable, Equatable, Sendable {
    public var id: String
    public var repository: String
    public var title: String
    public var kind: String
    public var actor: String
    public var action: String
    public var date: Date
    public var url: URL?
    public init(id: String, repository: String, title: String, kind: String, actor: String, action: String, date: Date, url: URL?) {
        self.id = id; self.repository = repository; self.title = title; self.kind = kind; self.actor = actor; self.action = action; self.date = date; self.url = url
    }
}
public struct ConnectedContext: Sendable {
    public var snapshot: ContextSnapshot
    public var people: [ContextPerson]
    public var activity: [RepositoryActivity]
    public var partial: Bool
    public init(snapshot: ContextSnapshot, people: [ContextPerson], activity: [RepositoryActivity], partial: Bool) {
        self.snapshot = snapshot; self.people = people; self.activity = activity; self.partial = partial
    }

    public static func decode(_ data: Data, day: String, now: Date = .now) throws -> ConnectedContext {
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = envelope["data"] as? [String: Any],
              let me = payload["me"] as? [String: Any],
              let today = me["today"] as? [String: Any] else {
            throw CocoaError(.coderReadCorrupt)
        }
        let date: (String?) -> Date? = { value in
            guard let value else { return nil }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        }
        let events = (today["googleEvents"] as? [[String: Any]] ?? []).map { item in
            let rawStart = item["start"] as? String
            return AgendaEvent(id: "\(item["connectionId"] ?? ""):\(item["calendarId"] ?? ""):\(item["id"] ?? "")", title: item["summary"] as? String ?? "Untitled event", start: date(rawStart), end: date(item["end"] as? String), allDay: rawStart?.count == 10, calendar: item["calendarName"] as? String, calendarColor: item["calendarColor"] as? String)
        }
        let people = (today["googlePeople"] as? [[String: Any]] ?? []).map { item in
            ContextPerson(id: "\(item["connectionId"] ?? ""):\(item["id"] ?? "")", name: item["displayName"] as? String ?? "Unnamed person", emails: item["emails"] as? [String] ?? [])
        }
        let activity = (today["githubActivity"] as? [[String: Any]] ?? []).map { item in
            let candidate = URL(string: item["url"] as? String ?? "")
            return RepositoryActivity(id: "\(item["connectionId"] ?? ""):\(item["id"] ?? "")", repository: item["repository"] as? String ?? "Unknown repository", title: item["title"] as? String ?? "Untitled activity", kind: item["kind"] as? String ?? "activity", actor: item["actor"] as? String ?? "", action: item["action"] as? String ?? "", date: date(item["createdAt"] as? String) ?? .distantPast, url: ["https", "http"].contains(candidate?.scheme ?? "") ? candidate : nil)
        }.sorted { $0.date > $1.date }
        return ConnectedContext(snapshot: ContextSnapshot(day: day, fetchedAt: now, events: events), people: people, activity: activity, partial: (today["googleEventsPartial"] as? Bool ?? false) || envelope["errors"] != nil)
    }
}
