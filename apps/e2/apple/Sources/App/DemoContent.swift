import ApsidesCore
import Foundation

enum DemoContent {
    static var context: ConnectedContext {
        let now = Date(), start = Calendar.current.startOfDay(for: now)
        let hour: (Double) -> Date = { start.addingTimeInterval($0 * 3600) }
        let events = [
            AgendaEvent(id: "1", title: "Design review", start: hour(12), end: hour(13), calendar: "Work"),
            AgendaEvent(id: "4", title: "Platform office hours", start: hour(12.5), end: hour(13.5), calendar: "Team"),
            AgendaEvent(id: "5", title: "Release week", start: nil, end: nil, allDay: true, calendar: "Work"),
            AgendaEvent(id: "6", title: "Catch up with Ada", start: hour(10), end: hour(10.5), calendar: "Work"),
            AgendaEvent(id: "7", title: "Make room to write", start: hour(9), end: hour(10), calendar: "Personal"),
            AgendaEvent(id: "2", title: "A walk and a thought", start: hour(14), end: hour(14.5), calendar: "Personal"),
            AgendaEvent(id: "3", title: "Plan next week", start: hour(16), end: hour(17), calendar: "Work")
        ]
        return ConnectedContext(snapshot: ContextSnapshot(day: DayIdentity.key(now), events: events), people: [ContextPerson(id: "ada", name: "Ada Lovelace", emails: ["ada@example.test"])], activity: [RepositoryActivity(id: "a", repository: "rawkode/apsides", title: "Keep the thought, wherever you are", kind: "pullRequest", actor: "rawkode", action: "opened", date: now, url: nil)], partial: false)
    }
}
