import ApsidesCore
import SwiftUI

/// A section's own success time; old caches deliberately make no freshness claim.
struct ContextFreshnessCaption: View {
    let freshness: ContextSectionFreshness?
    var legacyDate: Date? = nil
    var refreshFailed = false
    var legacyPartial = false
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn

    private var message: String {
        let success = freshness?.lastSuccessAt ?? (freshness == nil ? legacyDate : nil)
        let partial = freshness?.isPartial ?? legacyPartial
        let prefix = refreshFailed || freshness?.retainedCache == true ? "Cached · " : (partial ? "Partial · " : "")
        if let success {
            return prefix + "Last updated " + success.formatted(date: .abbreviated, time: .shortened)
        }
        if partial { return "Refresh incomplete" }
        if refreshFailed { return "Cached · Refresh unavailable" }
        return "Saved context · Update time unavailable"
    }
    var body: some View {
        Text(message).font(.caption).foregroundStyle(theme.secondary)
            .accessibilityIdentifier("contextFreshness")
    }
}

struct ContextConnectionView: View {
    @ObservedObject var store: WorkspaceStore
    var freshness: ContextSectionFreshness? = nil
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if store.snapshot != nil {
                ContextFreshnessCaption(freshness: freshness, refreshFailed: store.contextRefreshError != nil,
                                        legacyPartial: store.context?.partial == true)
            } else {
                Text("Bring your day into focus").font(.system(.title2, design: .serif))
                Text("Connect your Enchiridion account for calendar, people, and GitHub context. Your local writing stays available offline.").foregroundStyle(theme.ink)
                Button("Connect account") { store.settingsPresented = true }
            }
            if let error = store.connectionError { Text(error).font(.callout) }
        }.padding(.vertical, 8).foregroundStyle(theme.ink).listRowBackground(theme.canvas)
    }
}
struct PeopleView: View {
    @ObservedObject var store: WorkspaceStore
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @State private var query = ""
    private var people: [ContextPerson] {
        (store.context?.people ?? []).filter { query.isEmpty || ($0.name + " " + $0.emails.joined(separator: " ")).localizedCaseInsensitiveContains(query) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    var body: some View {
        List {
            Section {
                if people.isEmpty && !query.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else if people.isEmpty && store.context != nil {
                    ContentUnavailableView("No people today", systemImage: "person.2", description: Text("People linked to this day appear here."))
                }
                ForEach(people) { person in
                    NavigationLink { PersonDetailView(person: person) } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(person.name).font(.body.weight(.medium))
                            if let email = person.emails.first { Text(email).font(.callout).foregroundStyle(.secondary) }
                        }
                    }
                }
            } footer: { ContextConnectionView(store: store, freshness: store.context?.freshness?.people) }
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
            Section {
                if !query.isEmpty && !repositories.contains(where: { $0.localizedCaseInsensitiveContains(query) }) {
                    ContentUnavailableView.search(text: query)
                } else if repositories.isEmpty && store.context != nil {
                    ContentUnavailableView {
                        Label { Text("No GitHub activity") } icon: { GitHubMark().frame(width: 40, height: 40) }
                    } description: { Text("Repositories with activity appear here.") }
                }
                ForEach(repositories.filter { query.isEmpty || $0.localizedCaseInsensitiveContains(query) }, id: \.self) { repository in
                    NavigationLink {
                        RepositoryTimeline(repository: repository, items: (store.context?.activity ?? []).filter { $0.repository == repository }, freshness: store.context?.freshness?.github, refreshFailed: store.contextRefreshError != nil)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(repository).font(.body.weight(.medium))
                            Text(activityCount((store.context?.activity ?? []).filter { $0.repository == repository }.count)).font(.caption).foregroundStyle(theme.ink)
                        }
                    }
                }
            } footer: { ContextConnectionView(store: store, freshness: store.context?.freshness?.github) }
        }.modifier(ContextListAppearance(theme: theme)).navigationTitle("GitHub").searchable(text: $query, prompt: "Find a repository")
        .toolbar { Button { Task { await store.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(store.refreshing) }
    }
}
struct RepositoryTimeline: View {
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    let repository: String
    let items: [RepositoryActivity]
    var freshness: ContextSectionFreshness? = nil
    var refreshFailed = false
    @State private var type = ""
    @State private var query = ""
    private var matching: [RepositoryActivity] {
        items.filter { (type.isEmpty || $0.kind == type) && (query.isEmpty || ($0.title + " " + $0.actor).localizedCaseInsensitiveContains(query)) }
            .sorted { $0.date > $1.date }
    }
    var body: some View {
        List {
            Section {
                if matching.isEmpty {
                    if !query.isEmpty { ContentUnavailableView.search(text: query) }
                    else { ContentUnavailableView("No matching activity", systemImage: "line.3.horizontal.decrease", description: Text(type.isEmpty ? "There is no activity in this repository for this day." : "Choose another activity type or show all types.")) }
                }
                ForEach(matching) { item in
                    NavigationLink {
                        ScrollView { GitHubActivityCard(item: item).padding() }.navigationTitle("Activity")
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item.title).font(.body.weight(.medium)).lineLimit(2)
                            Text([activityKind(item.kind), humanized(item.action), item.actor].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            Text(item.date, format: .dateTime.month(.abbreviated).day().hour().minute()).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } footer: { ContextFreshnessCaption(freshness: freshness, refreshFailed: refreshFailed) }
        }.modifier(ContextListAppearance(theme: theme)).navigationTitle(repository)
            .searchable(text: $query, prompt: "Title or person")
            .toolbar {
                Menu {
                    Picker("Activity type", selection: $type) {
                        Text("All types").tag("")
                        ForEach(Array(Set(items.map(\.kind))).sorted(), id: \.self) { Text(activityKind($0, plural: true)).tag($0) }
                    }
                } label: { Label("Filter activity", systemImage: "line.3.horizontal.decrease") }
            }
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

struct GitHubMark: View {
    var body: some View {
        Image("GitHubMark").resizable().scaledToFit().accessibilityHidden(true)
    }
}

struct GitHubActivityCard: View {
    let item: RepositoryActivity
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    private var resource: String {
        activityKind(item.kind) + (item.number.map { " #\($0)" } ?? "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 10) {
                GitHubMark().frame(width: 22, height: 22)
                Text(item.repository).font(.subheadline.weight(.medium)).textSelection(.enabled)
            }.foregroundStyle(theme.secondary)
            VStack(alignment: .leading, spacing: 8) {
                Text(item.title).font(.system(.title2, design: .serif).weight(.semibold)).textSelection(.enabled)
                Text([resource, humanized(item.action)].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.subheadline.weight(.medium)).foregroundStyle(theme.accent)
            }
            if !item.summary.isEmpty {
                Text(item.summary).font(.body).foregroundStyle(theme.ink).textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 4) {
                if !item.actor.isEmpty { Text("By \(item.actor)") }
                Text(item.date, format: .dateTime.day().month(.abbreviated).hour().minute())
            }.font(.caption).foregroundStyle(theme.secondary)
            if let url = item.url {
                Link(destination: url) {
                    Label("Open on GitHub", systemImage: "arrow.up.right")
                        .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                }.accessibilityIdentifier("openGitHubActivity")
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
            .background(theme.canvas, in: .rect(cornerRadius: 24))
    }
}
