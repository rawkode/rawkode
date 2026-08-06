// TaskDetailEditorSheet.swift
// EnchiridionUI
//
// Task #82. Shared "tap a task to open its full page" presentation for
// both `TaskListView` and `TaskBoardView` — loads a `PageEditorController`
// for an EXISTING task page via `PageEditorController.open(...)` (task
// #78's load-persisted-snapshot path) and hosts it in the real
// `PageEditorView`, so a task opened from either screen is the exact same
// editor a user gets from any other page in the app — no separate
// "lightweight task editor" reinvented here.

import EnchiridionCore
import EnchiridionStore
import SwiftUI

struct TaskDetailEditorSheet: View {
  let store: LocalGraphStore
  let pageID: PageID
  /// Used only if `store` genuinely has no persisted snapshot for
  /// `pageID` yet (`PageEditorController.open`'s new-page fallback) — in
  /// practice a task reachable from these screens' query already has one,
  /// so this is a defensive default, not an expected path.
  let fallbackTitle: String
  let onClose: () -> Void

  @State private var controller: PageEditorController?
  @State private var loadError: String?

  var body: some View {
    NavigationStack {
      Group {
        if let controller {
          PageEditorView(controller: controller, onNavigateToReference: { _ in })
        } else if let loadError {
          ContentUnavailableView(
            "Couldn't open task", systemImage: "exclamationmark.triangle", description: Text(loadError))
        } else {
          ProgressView()
        }
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { close() }
        }
      }
    }
    .task { await load() }
  }

  private func load() async {
    do {
      controller = try await PageEditorController.open(
        pageID: pageID, kind: .free, title: fallbackTitle, store: store)
    } catch {
      loadError = error.localizedDescription
    }
  }

  private func close() {
    Task {
      await controller?.flush()
      controller?.invalidate()
      onClose()
    }
  }
}
