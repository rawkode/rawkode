import AppIntents
import EnchiridionCore
import SwiftUI
import WidgetKit

private struct TodayTaskSummary: Identifiable, Sendable {
  var id: String
  var title: String
  var deadline: Date?
}

private struct TodayTasksEntry: TimelineEntry {
  var date: Date
  var tasks: [TodayTaskSummary]
  var errorMessage: String?
}

private struct TodayTasksProvider: TimelineProvider {
  func placeholder(in context: Context) -> TodayTasksEntry {
    TodayTasksEntry(
      date: Date(),
      tasks: [
        TodayTaskSummary(id: "one", title: "Review today", deadline: nil),
        TodayTaskSummary(id: "two", title: "Plan tomorrow", deadline: nil),
      ]
    )
  }

  func getSnapshot(
    in context: Context,
    completion: @escaping @Sendable (TodayTasksEntry) -> Void
  ) {
    Task { completion(await loadEntry()) }
  }

  func getTimeline(
    in context: Context,
    completion: @escaping @Sendable (Timeline<TodayTasksEntry>) -> Void
  ) {
    Task {
      let entry = await loadEntry()
      let refresh = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date(timeIntervalSinceNow: 900)
      completion(Timeline(entries: [entry], policy: .after(refresh)))
    }
  }

  private func loadEntry() async -> TodayTasksEntry {
    do {
      let repository = try LibraryRepository(path: LibraryRepository.defaultLocalPath())
      let pages = try await repository.pages(with: BuiltInSupertags.task)
      let tasks = TaskQuery.items(from: pages, selection: .smart(.today))
        .prefix(8)
        .map {
          TodayTaskSummary(
            id: $0.id.rawValue,
            title: $0.page.displayTitle,
            deadline: $0.data.deadline
          )
        }
      return TodayTasksEntry(date: Date(), tasks: tasks)
    } catch {
      return TodayTasksEntry(
        date: Date(),
        tasks: [],
        errorMessage: "Open Enchiridion to finish setup."
      )
    }
  }
}

struct CompleteTodayTaskWidgetIntent: AppIntent {
  static let title: LocalizedStringResource = "Complete Today Task"
  static let description = IntentDescription("Marks a task complete from the Today widget.")
  static let openAppWhenRun = false

  @Parameter(title: "Task ID")
  var taskID: String

  init() {}

  init(taskID: String) {
    self.taskID = taskID
  }

  func perform() async throws -> some IntentResult {
    let repository = try LibraryRepository(path: LibraryRepository.defaultLocalPath())
    let mutations = TaskMutationCoordinator(
      repository: repository,
      effects: .live(surface: .widgetExtension)
    )
    switch await mutations.complete(PageID(rawValue: taskID)) {
    case .success:
      return .result()
    case .failure(let failure):
      throw failure
    }
  }
}

private struct TodayTasksWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: TodayTasksEntry

  private var visibleTasks: ArraySlice<TodayTaskSummary> {
    entry.tasks.prefix(family == .systemSmall ? 2 : 5)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Label("Today", systemImage: "sun.max.fill")
          .font(.headline)
        Spacer()
        Link(destination: URL(string: "enchiridion://tasks/inbox?quickAdd=1")!) {
          Image(systemName: "plus.circle.fill")
            .font(.title3)
        }
        .accessibilityLabel("Quick add task")
      }

      if let errorMessage = entry.errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.secondary)
      } else if visibleTasks.isEmpty {
        Spacer(minLength: 0)
        Label("Nothing scheduled", systemImage: "checkmark.circle")
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer(minLength: 0)
      } else {
        ForEach(visibleTasks) { task in
          Button(intent: CompleteTodayTaskWidgetIntent(taskID: task.id)) {
            HStack(spacing: 7) {
              Image(systemName: "circle")
                .foregroundStyle(.secondary)
              Text(task.title)
                .lineLimit(1)
                .privacySensitive()
              Spacer(minLength: 0)
              if let deadline = task.deadline {
                Text("Due \(deadline.formatted(.dateTime.month(.abbreviated).day()))")
                  .font(.caption2)
                  .foregroundStyle(.secondary)
                  .privacySensitive()
              }
            }
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Complete \(task.title)")
        }
        Spacer(minLength: 0)
      }
    }
    .containerBackground(.fill.tertiary, for: .widget)
    .widgetURL(URL(string: "enchiridion://tasks/today"))
  }
}

struct EnchiridionTodayTasksWidget: Widget {
  let kind = TaskWidgetIdentifiers.todayTasks

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: TodayTasksProvider()) { entry in
      TodayTasksWidgetView(entry: entry)
    }
    .configurationDisplayName("Today Tasks")
    .description("View and complete today’s Enchiridion tasks.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
