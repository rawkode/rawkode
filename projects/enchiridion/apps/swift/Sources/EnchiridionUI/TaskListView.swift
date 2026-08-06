// TaskListView.swift
// EnchiridionUI
//
// Task #82 (plan §"Core Product UI (P7)", track 3). A dedicated task
// list screen: every local Task-supertagged page (`LocalGraphStore.
// fetchAllTasks()`, TaskBrowserQuery.swift), grouped into the same
// `TaskBoardColumn` lanes the kanban view uses (TaskBrowserModels.swift) —
// one shared grouping vocabulary for both screens rather than two
// independent ones. Supports marking a task complete (real write via
// `TaskWriteService.toggleCompletion`) and tapping through to the task's
// full page (`TaskDetailEditorSheet`, hosting the real `PageEditorView`).
//
// SELF-CONTAINED BY DESIGN (task brief): takes only a `LocalGraphStore` —
// no navigation-shell/RootView dependency, no callback the caller must
// supply for "open a task." A future integration task presents this view
// somewhere in the app's real navigation; until then, it is fully
// independently usable/testable on its own.

import EnchiridionCore
import EnchiridionStore
import SwiftUI

@MainActor
public struct TaskListView: View {
  private let store: LocalGraphStore

  @State private var items: [TaskListItem] = []
  @State private var loadError: String?
  @State private var isLoading = true
  @State private var selectedPageID: PageID?
  /// Task #90 defense-in-depth: pages with a write currently in flight via
  /// `toggleComplete` below. Guards against a second tap on the same row
  /// firing a second concurrent `TaskWriteService.toggleCompletion` call
  /// before the first has landed — `TaskWriteService`'s own
  /// compare-and-swap is the real correctness guarantee (see that file's
  /// header), but this stops the easy, common way to trigger the race in
  /// the first place (double-tap, or a checkbox tap immediately followed
  /// by another interaction on the same still-stale row).
  @State private var pendingPageIDs: Set<PageID> = []

  public init(store: LocalGraphStore) {
    self.store = store
  }

  public var body: some View {
    Group {
      if isLoading {
        ProgressView()
      } else if let loadError {
        ContentUnavailableView(
          "Couldn't load tasks", systemImage: "exclamationmark.triangle", description: Text(loadError))
      } else if items.isEmpty {
        ContentUnavailableView("No tasks yet", systemImage: "checklist")
      } else {
        List {
          ForEach(TaskBoardColumn.allCases) { column in
            let columnItems = groupedItems[column] ?? []
            if !columnItems.isEmpty {
              Section(column.displayName) {
                ForEach(columnItems) { item in
                  TaskListRow(
                    item: item, isPending: pendingPageIDs.contains(item.pageID),
                    onToggleComplete: { toggleComplete(item) }
                  )
                  .contentShape(Rectangle())
                  .onTapGesture { selectedPageID = item.pageID }
                }
              }
            }
          }
        }
      }
    }
    .task { await reload() }
    .sheet(item: $selectedPageID) { pageID in
      TaskDetailEditorSheet(
        store: store, pageID: pageID, fallbackTitle: title(for: pageID),
        onClose: {
          selectedPageID = nil
          Task { await reload() }
        })
    }
  }

  private var groupedItems: [TaskBoardColumn: [TaskListItem]] {
    let today = Calendar.current.startOfDay(for: Date())
    return Dictionary(grouping: items) {
      TaskBoardColumn.assigned(to: $0, today: today, calendar: .current)
    }
  }

  private func title(for pageID: PageID) -> String {
    items.first { $0.pageID == pageID }?.title ?? "Untitled"
  }

  private func reload() async {
    do {
      items = try store.fetchAllTasks()
        .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
      loadError = nil
    } catch {
      loadError = error.localizedDescription
    }
    isLoading = false
  }

  private func toggleComplete(_ item: TaskListItem) {
    // Ignore a second tap on a row whose write hasn't landed yet — see
    // `pendingPageIDs`'s doc comment.
    guard !pendingPageIDs.contains(item.pageID) else { return }
    pendingPageIDs.insert(item.pageID)
    Task {
      defer { pendingPageIDs.remove(item.pageID) }
      do {
        _ = try await TaskWriteService.toggleCompletion(for: item, in: store)
        await reload()
      } catch {
        loadError = error.localizedDescription
      }
    }
  }
}

private struct TaskListRow: View {
  let item: TaskListItem
  let isPending: Bool
  let onToggleComplete: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Button(action: onToggleComplete) {
        if isPending {
          ProgressView()
            .controlSize(.small)
        } else {
          Image(systemName: item.isActive ? "circle" : "checkmark.circle.fill")
            .foregroundStyle(item.isActive ? Color.secondary : Color.accentColor)
            .imageScale(.large)
        }
      }
      .buttonStyle(.plain)
      .disabled(isPending)

      VStack(alignment: .leading, spacing: 2) {
        Text(item.title)
          .strikethrough(!item.isActive)
          .foregroundStyle(item.isActive ? Color.primary : Color.secondary)
        if let subtitle {
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      Spacer()

      if let priority = item.priority, priority != .low, item.isActive {
        Text(priority.rawValue.capitalized)
          .font(.caption2.weight(.semibold))
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Color.accentColor.opacity(0.15), in: Capsule())
      }
    }
    .padding(.vertical, 2)
  }

  private var subtitle: String? {
    if let deadline = item.deadlineAt {
      return "Due \(deadline.formatted(date: .abbreviated, time: .omitted))"
    }
    if let scheduled = item.scheduledAt {
      return "Scheduled \(scheduled.formatted(date: .abbreviated, time: .shortened))"
    }
    return nil
  }
}
