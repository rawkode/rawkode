import Foundation

public struct ContextPerson: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var emails: [String]
    public init(id: String, name: String, emails: [String]) { self.id = id; self.name = name; self.emails = emails }
}
public struct RepositoryActivity: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var repository: String
    public var title: String
    public var kind: String
    public var actor: String
    public var action: String
    public var date: Date
    public var url: URL?
    public var summary: String
    public var number: Int?
    public init(id: String, repository: String, title: String, kind: String, actor: String, action: String, date: Date, url: URL?, summary: String = "", number: Int? = nil) {
        self.id = id; self.repository = repository; self.title = title; self.kind = kind; self.actor = actor; self.action = action; self.date = date; self.url = url; self.summary = summary; self.number = number
    }
}
public struct ContextSectionFreshness: Codable, Equatable, Sendable {
    public var lastAttemptAt: Date
    public var lastSuccessAt: Date?
    public var isPartial: Bool
    public var retainedCache: Bool
    public var error: String?
}
public struct ContextFreshness: Codable, Equatable, Sendable {
    public var calendar: ContextSectionFreshness
    public var people: ContextSectionFreshness
    public var github: ContextSectionFreshness
}

public struct ConnectedContext: Codable, Equatable, Sendable {
    public var snapshot: ContextSnapshot
    public var people: [ContextPerson]
    public var activity: [RepositoryActivity]
    public var partial: Bool
    /// Optional so existing on-device caches remain readable.
    public var freshness: ContextFreshness?
    /// Widgets and Watch snapshots do not yet encode section-level failure state.
    public var canPublishCalendar: Bool {
        if let calendar = freshness?.calendar { return !calendar.isPartial && calendar.lastSuccessAt != nil }
        return !partial
    }
    public init(snapshot: ContextSnapshot, people: [ContextPerson], activity: [RepositoryActivity], partial: Bool, freshness: ContextFreshness? = nil) {
        self.snapshot = snapshot; self.people = people; self.activity = activity; self.partial = partial; self.freshness = freshness
    }

    public static func decode(_ data: Data, day: String, now: Date = .now,
        ownerID: String? = nil, previousOwnerID: String? = nil, previous: ConnectedContext? = nil) throws -> ConnectedContext {
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
            return RepositoryActivity(id: "\(item["connectionId"] ?? ""):\(item["id"] ?? "")", repository: item["repository"] as? String ?? "Unknown repository", title: item["title"] as? String ?? "Untitled activity", kind: item["kind"] as? String ?? "activity", actor: item["actor"] as? String ?? "", action: item["action"] as? String ?? "", date: date(item["createdAt"] as? String) ?? .distantPast, url: ["https", "http"].contains(candidate?.scheme ?? "") ? candidate : nil, summary: item["summary"] as? String ?? "", number: item["number"] as? Int)
        }.sorted { $0.date > $1.date }
        // Cache eligibility is checked here as well as at the store boundary.
        // A different day/owner must never fill holes in this response.
        let cached = ownerID?.isEmpty == false && ownerID == previousOwnerID && previous?.snapshot.day == day ? previous : nil
        let errors = envelope["errors"] as? [[String: Any]] ?? []
        let knownFields: Set<String> = ["googleEvents", "googleEventsPartial", "googlePeople", "githubActivity", "githubActivityPartial"]
        let unknownFailure = errors.contains { error in
            guard let path = error["path"] as? [Any], path.count >= 3,
                  path[0] as? String == "me", path[1] as? String == "today",
                  let field = path[2] as? String else { return true }
            return !knownFields.contains(field)
        }
        let fails: (Set<String>) -> Bool = { fields in
            unknownFailure || errors.contains { error in
                guard let path = error["path"] as? [Any], path.count >= 3,
                      let field = path[2] as? String else { return false }
                return fields.contains(field)
            }
        }
        let calendarFailed = today["googleEvents"] as? [[String: Any]] == nil ||
            (today["googleEventsPartial"] as? Bool == true) || fails(["googleEvents", "googleEventsPartial"])
        // Today's people include calendar attendees; incomplete events mean an incomplete people projection.
        let peopleFailed = calendarFailed || today["googlePeople"] as? [[String: Any]] == nil || fails(["googlePeople"])
        let githubFailed = today["githubActivity"] as? [[String: Any]] == nil ||
            (today["githubActivityPartial"] as? Bool != false) || fails(["githubActivity", "githubActivityPartial"])
        let status: (Bool, ContextSectionFreshness?, String) -> ContextSectionFreshness = { failed, old, name in
            let lastSuccess = old.map { $0.lastSuccessAt } ?? cached.map { $0.snapshot.fetchedAt }
            return ContextSectionFreshness(lastAttemptAt: now, lastSuccessAt: failed ? lastSuccess : now,
                isPartial: failed, retainedCache: failed && cached != nil,
                error: failed ? "\(name) could not fully refresh." : nil)
        }
        let freshness = ContextFreshness(
            calendar: status(calendarFailed, cached?.freshness?.calendar, "Calendar"),
            people: status(peopleFailed, cached?.freshness?.people, "People"),
            github: status(githubFailed, cached?.freshness?.github, "GitHub"))
        let mergedEvents = calendarFailed ? retainingMissing(events, from: cached?.snapshot.events ?? [], id: \.id) : events
        let mergedPeople = peopleFailed ? retainingMissing(people, from: cached?.people ?? [], id: \.id) : people
        let mergedActivity = (githubFailed ? retainingMissing(activity, from: cached?.activity ?? [], id: \.id) : activity)
            .sorted { $0.date > $1.date }
        return ConnectedContext(snapshot: ContextSnapshot(day: day, fetchedAt: freshness.calendar.lastSuccessAt ?? now, events: mergedEvents),
            people: mergedPeople, activity: mergedActivity, partial: calendarFailed || peopleFailed || githubFailed, freshness: freshness)
    }
}

/// Incomplete responses can update known items, but cannot prove a missing item was deleted.
private func retainingMissing<Value, ID: Hashable>(_ incoming: [Value], from cached: [Value], id: KeyPath<Value, ID>) -> [Value] {
    let received = Set(incoming.map { $0[keyPath: id] })
    return incoming + cached.filter { !received.contains($0[keyPath: id]) }
}
