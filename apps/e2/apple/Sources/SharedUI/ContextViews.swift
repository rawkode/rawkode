import ApsidesCore
import SwiftUI

struct ContextConnectionView: View {
    @ObservedObject var store: WorkspaceStore
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let snapshot = store.snapshot {
                Text("Updated \(snapshot.fetchedAt.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(theme.ink)
            } else {
                Text("Bring your day into focus").font(.system(.title2, design: .serif))
                Text("Connect your Apsides account for calendar, people, and GitHub context. Your local writing stays available offline.").foregroundStyle(theme.ink)
                Button("Connect account") { store.settingsPresented = true }
            }
            if let error = store.connectionError { Text(error).font(.callout).foregroundStyle(theme.ink) }
            if store.context?.partial == true { Label("Some services could not refresh.", systemImage: "exclamationmark.triangle").font(.callout) }
        }.padding(.vertical, 8).foregroundStyle(theme.ink).listRowBackground(theme.canvas)
    }
}
struct PeopleView: View {
    @ObservedObject var store: WorkspaceStore
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @State private var query = ""
    var body: some View {
        List {
            ContextConnectionView(store: store)
            ForEach((store.context?.people ?? []).filter { query.isEmpty || ($0.name + $0.emails.joined()).localizedCaseInsensitiveContains(query) }.sorted { $0.name < $1.name }) { person in
                NavigationLink { PersonDetailView(person: person) } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(person.name).font(.body.weight(.medium))
                        if let email = person.emails.first { Text(email).font(.callout).foregroundStyle(theme.ink) }
                    }
                }.padding(.vertical, 7).listRowBackground(theme.canvas)
            }
        }.modifier(ContextListAppearance(theme: theme)).navigationTitle("People").searchable(text: $query, prompt: "Name or email")
        .toolbar { Button { Task { await store.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(store.refreshing) }
    }
}
struct RepositoryListView: View {
    @ObservedObject var store: WorkspaceStore
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @State private var query = ""
    var repositories: [String] { Array(NSOrderedSet(array: (store.context?.activity ?? []).map(\.repository))) as? [String] ?? [] }
    var body: some View {
        #if os(macOS)
        NavigationStack { repositoryList }
        #else
        repositoryList
        #endif
    }
    private var repositoryList: some View {
            List {
                ContextConnectionView(store: store)
                ForEach(repositories.filter { query.isEmpty || $0.localizedCaseInsensitiveContains(query) }, id: \.self) { repository in
                    NavigationLink {
                        RepositoryTimeline(repository: repository, items: (store.context?.activity ?? []).filter { $0.repository == repository })
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(repository).font(.body.weight(.medium))
                            Text(activityCount((store.context?.activity ?? []).filter { $0.repository == repository }.count)).font(.caption).foregroundStyle(theme.ink)
                        }.padding(.vertical, 9).listRowBackground(theme.canvas)
                    }.listRowBackground(theme.canvas)
                }
            }.modifier(ContextListAppearance(theme: theme)).navigationTitle("GitHub").searchable(text: $query, prompt: "Find a repository")
            .toolbar { Button { Task { await store.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(store.refreshing) }
    }
}
struct RepositoryTimeline: View {
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    let repository: String
    let items: [RepositoryActivity]
    @State private var type = ""
    var body: some View {
        List {
            Picker("Activity type", selection: $type) {
                Text("All types").tag("")
                ForEach(Array(Set(items.map(\.kind))).sorted(), id: \.self) { Text(activityKind($0, plural: true)).tag($0) }
            }.listRowBackground(theme.canvas)
            ForEach(items.filter { type.isEmpty || $0.kind == type }.sorted { $0.date > $1.date }) { item in
                HStack(alignment: .top, spacing: 16) {
                    Text(item.date, format: .dateTime.hour().minute()).font(.caption.monospacedDigit()).foregroundStyle(theme.ink)
                    VStack(alignment: .leading, spacing: 7) {
                        if let url = item.url { Link(item.title, destination: url) } else { Text(item.title) }
                        Text([activityKind(item.kind), humanized(item.action), item.actor].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(theme.ink)
                    }
                }.padding(.vertical, 9).listRowBackground(theme.canvas)
            }
        }.modifier(ContextListAppearance(theme: theme)).navigationTitle(repository)
    }
}

private struct ContextListAppearance: ViewModifier {
    let theme: ApsidesTheme
    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .background(theme.canvas)
            .foregroundStyle(theme.ink)
            .tint(theme.accent)
    }
}

private func activityCount(_ count: Int) -> String {
    count == 1 ? "1 activity" : "\(count) activities"
}

private func activityKind(_ kind: String, plural: Bool = false) -> String {
    switch kind {
    case "pullRequest": plural ? "Pull requests" : "Pull request"
    case "issue": plural ? "Issues" : "Issue"
    case "commit": plural ? "Commits" : "Commit"
    case "push": plural ? "Pushes" : "Push"
    case "release": plural ? "Releases" : "Release"
    case "review": plural ? "Reviews" : "Review"
    case "comment": plural ? "Comments" : "Comment"
    default: humanized(kind)
    }
}

private func humanized(_ value: String) -> String {
    value.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
        .replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: "-", with: " ")
        .capitalized
}
