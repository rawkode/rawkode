// TaskBoardView.swift
// EnchiridionUI
//
// Task #82 (plan §"Core Product UI (P7)", track 3). The kanban view over
// `TaskBoardColumn`'s six lanes (TaskBrowserModels.swift). Cards are
// draggable between columns; a drop calls `TaskWriteService.move(...)` —
// the same real CRDT-snapshot-persisting write path
// `TaskListView`'s completion toggle uses — and reloads from the store
// afterward, so the board always reflects what's actually on disk rather
// than an optimistic local-only reorder.
//
// Drag payload is the task's `PageID.rawValue` (`String`, which SwiftUI's
// `Transferable` already supports natively) rather than a custom
// `Transferable` type — the payload only needs to identify which task
// moved; everything else the write needs (`currentStatus`, the target
// column) is already known locally in this view/its column subview.
//
// SELF-CONTAINED BY DESIGN (task brief): takes only a `LocalGraphStore`,
// same as `TaskListView` — no navigation-shell dependency; a future
// integration task presents this view somewhere in the app's real
// navigation.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import SwiftUI

@MainActor
public struct TaskBoardView: View {
  private let store: LocalGraphStore

  @State private var items: [TaskListItem] = []
  @State private var loadError: String?
  @State private var isLoading = true
  @State private var selectedPageID: PageID?
  /// Task #90 defense-in-depth: pages with a move currently in flight via
  /// `move` below. Guards against dropping the same still-stale card again
  /// (e.g. onto a second column) before its first move has landed —
  /// `TaskWriteService`'s own compare-and-swap is the real correctness
  /// guarantee (see that file's header), but this stops the easy, common
  /// way to trigger the race in the first place.
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
      } else {
        ScrollView(.horizontal) {
          HStack(alignment: .top, spacing: 16) {
            ForEach(TaskBoardColumn.allCases) { column in
              TaskBoardColumnView(
                column: column,
                items: itemsByColumn[column] ?? [],
                pendingPageIDs: pendingPageIDs,
                onSelect: { selectedPageID = $0.pageID },
                onDrop: { pageIDValue in move(pageIDValue, to: column) }
              )
            }
          }
          .padding()
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

  private var itemsByColumn: [TaskBoardColumn: [TaskListItem]] {
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
      loadError = nil
    } catch {
      loadError = error.localizedDescription
    }
    isLoading = false
  }

  private func move(_ pageIDValue: String, to column: TaskBoardColumn) {
    guard let item = items.first(where: { $0.pageID.rawValue == pageIDValue }) else { return }
    // No optimistic local reassignment here: this fires the real write
    // and only reflects the move once `reload()` afterward re-fetches the
    // persisted state — the card stays in its current column, not the
    // drop target, until the write actually lands. `pendingPageIDs` below
    // dims the card in the meantime so the drop still reads as
    // acknowledged.
    guard !pendingPageIDs.contains(item.pageID) else { return }
    pendingPageIDs.insert(item.pageID)
    Task {
      defer { pendingPageIDs.remove(item.pageID) }
      do {
        _ = try await TaskWriteService.move(
          item.pageID, currentStatus: item.status, to: column, in: store)
        await reload()
      } catch {
        loadError = error.localizedDescription
      }
    }
  }
}

private struct TaskBoardColumnView: View {
  let column: TaskBoardColumn
  let items: [TaskListItem]
  let pendingPageIDs: Set<PageID>
  let onSelect: (TaskListItem) -> Void
  let onDrop: (String) -> Void

  @State private var isTargeted = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(column.displayName)
          .font(.headline)
        Spacer()
        Text("\(items.count)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      ScrollView {
        VStack(spacing: 8) {
          ForEach(items) { item in
            let isPending = pendingPageIDs.contains(item.pageID)
            TaskBoardCard(item: item, isPending: isPending)
              .onTapGesture { if !isPending { onSelect(item) } }
              .draggable(item.pageID.rawValue)
              .allowsHitTesting(!isPending)
          }
        }
      }
    }
    .padding(10)
    .frame(width: 240)
    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(
      RoundedRectangle(cornerRadius: 12)
        .strokeBorder(isTargeted ? Color.accentColor : Color.clear, lineWidth: 2)
    )
    .dropDestination(for: String.self) { droppedValues, _ in
      guard let pageIDValue = droppedValues.first else { return false }
      onDrop(pageIDValue)
      return true
    } isTargeted: { targeted in
      isTargeted = targeted
    }
  }
}

private struct TaskBoardCard: View {
  let item: TaskListItem
  let isPending: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(item.title)
        .font(.subheadline.weight(.medium))
        .strikethrough(!item.isActive)
        .lineLimit(3)

      if let priority = item.priority, priority != .low, item.isActive {
        Text(priority.rawValue.capitalized)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
      }

      if let date = item.deadlineAt ?? item.scheduledAt {
        Text(date.formatted(date: .abbreviated, time: .omitted))
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    .opacity(isPending ? 0.5 : 1)
  }
}
