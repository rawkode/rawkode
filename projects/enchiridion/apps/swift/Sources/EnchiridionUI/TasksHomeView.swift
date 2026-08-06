// TasksHomeView.swift
// EnchiridionUI
//
// Task #85 (P7 integration wave). The real "Tasks" navigation destination:
// a list/kanban TOGGLE over the two already-built, self-contained P7 task
// screens (`TaskListView`/`TaskBoardView`, task #82 — both explicitly
// "SELF-CONTAINED BY DESIGN ... a future integration task presents this
// view somewhere in the app's real navigation," per their own headers).
// This file IS that integration: composition only, no changes to either
// view.
import EnchiridionStore
import SwiftUI

public struct TasksHomeView: View {
  public enum DisplayMode: String, CaseIterable, Identifiable, Sendable {
    case list
    case board

    public var id: String { rawValue }
    public var title: String {
      switch self {
      case .list: "List"
      case .board: "Board"
      }
    }
  }

  private let store: LocalGraphStore

  @State private var displayMode: DisplayMode = .list

  public init(store: LocalGraphStore) {
    self.store = store
  }

  public var body: some View {
    VStack(spacing: 0) {
      Picker("View", selection: $displayMode) {
        ForEach(DisplayMode.allCases) { mode in
          Text(mode.title).tag(mode)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(.horizontal)
      .padding(.top, 8)
      .padding(.bottom, 4)

      Group {
        switch displayMode {
        case .list: TaskListView(store: store)
        case .board: TaskBoardView(store: store)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
}
