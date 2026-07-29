import EnchiridionCore
import SwiftUI

/// A small task affordance above the daily editor. The note remains the main
/// workspace; this context only carries work that belongs to the selected day.
struct DailyTaskContext: View {
  let store: LibraryStore
  let day: Date
  let includingOverdue: Bool
  let openTask: (PageID) -> Void
  let viewAll: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var isExpanded = true

  private let visibleLimit = 3

  var body: some View {
    let tasks = store.tasks(on: day, includingOverdue: includingOverdue)
    if !tasks.isEmpty {
      VStack(spacing: 0) {
        HStack(spacing: 10) {
          Button {
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.18)) {
              isExpanded.toggle()
            }
          } label: {
            HStack(spacing: 8) {
              Image(systemName: "checkmark.circle")
                .foregroundStyle(.tint)
              Text("Tasks")
                .font(.subheadline.weight(.semibold))
              Text(tasks.count, format: .number)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.quaternary, in: Capsule())
              Image(systemName: "chevron.down")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .rotationEffect(isExpanded ? .zero : .degrees(-90))
            }
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(isExpanded ? "Collapse daily tasks" : "Expand daily tasks")

          Spacer(minLength: 8)

          Button("View all", systemImage: "arrow.up.right") { viewAll() }
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.medium))
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)

        if isExpanded {
          Divider().padding(.leading, 16)
          VStack(spacing: 0) {
            ForEach(Array(tasks.prefix(visibleLimit))) { task in
              DailyTaskContextRow(
                store: store,
                task: task,
                selectedDay: day,
                open: { openTask(task.id) }
              )
              if task.id != tasks.prefix(visibleLimit).last?.id {
                Divider().padding(.leading, 50)
              }
            }
          }
          .transition(.opacity.combined(with: .move(edge: .top)))

          if tasks.count > visibleLimit {
            Button("View \(tasks.count - visibleLimit) more") { viewAll() }
              .font(.caption.weight(.medium))
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.leading, 50)
              .padding(.vertical, 7)
              .buttonStyle(.plain)
              .foregroundStyle(.tint)
          }
        }
      }
      .background(.bar)
      .overlay(alignment: .bottom) { Divider() }
      .accessibilityElement(children: .contain)
    }
  }
}

private struct DailyTaskContextRow: View {
  let store: LibraryStore
  let task: TaskItem
  let selectedDay: Date
  let open: () -> Void

  private let calendar = Calendar.current

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Button {
        Task { await store.completeTask(task.id) }
      } label: {
        Image(systemName: "circle")
          .font(.title3)
          .foregroundStyle(.secondary)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Complete \(task.page.displayTitle)")

      Button(action: open) {
        VStack(alignment: .leading, spacing: 3) {
          Text(task.page.displayTitle)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.primary)
            .lineLimit(1)

          if !contextLabels.isEmpty {
            HStack(spacing: 8) {
              ForEach(contextLabels, id: \.text) { label in
                Label(label.text, systemImage: label.symbol)
                  .foregroundStyle(label.isUrgent ? Color.red : Color.secondary)
              }
            }
            .font(.caption)
            .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityHint("Open task")
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
  }

  private var contextLabels: [ContextLabel] {
    var labels: [ContextLabel] = []
    let selectedInterval = calendar.dateInterval(of: .day, for: selectedDay)

    if let scheduledAt = task.data.scheduledAt {
      let isEarlier = selectedInterval.map { scheduledAt < $0.start } == true
      if isEarlier {
        labels.append(ContextLabel(text: "Scheduled earlier", symbol: "calendar", isUrgent: false))
      } else if task.data.scheduleGranularity == .dateOnly {
        labels.append(ContextLabel(text: "Scheduled", symbol: "calendar", isUrgent: false))
      } else {
        labels.append(
          ContextLabel(
            text: scheduledAt.formatted(date: .omitted, time: .shortened),
            symbol: "calendar",
            isUrgent: false
          )
        )
      }
    }

    if let deadline = task.data.deadline {
      let isOverdue = selectedInterval.map { deadline < $0.start } == true
      labels.append(
        ContextLabel(
          text: isOverdue ? "Overdue" : "Due",
          symbol: "flag",
          isUrgent: isOverdue
        )
      )
    }
    return labels
  }
}

private struct ContextLabel: Hashable {
  let text: String
  let symbol: String
  let isUrgent: Bool
}

struct DailyTaskListScreen: View {
  let store: LibraryStore
  let day: Date
  let includingOverdue: Bool

  @State private var editingTaskID: PageID?

  var body: some View {
    let tasks = store.tasks(on: day, includingOverdue: includingOverdue)
    List {
      if tasks.isEmpty {
        ContentUnavailableView(
          "All clear",
          systemImage: "checkmark.circle",
          description: Text("Nothing is scheduled or due for this day.")
        )
        .listRowSeparator(.hidden)
      } else {
        ForEach(tasks) { task in
          TaskRow(store: store, task: task, open: { editingTaskID = task.id })
        }
      }
    }
    .listStyle(.inset)
    .navigationTitle(navigationTitle)
    .sheet(item: $editingTaskID) { pageID in
      NavigationStack { TaskDetailScreen(store: store, pageID: pageID) }
    }
  }

  private var navigationTitle: String {
    if Calendar.current.isDateInToday(day) { return "Today" }
    return day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
  }
}
