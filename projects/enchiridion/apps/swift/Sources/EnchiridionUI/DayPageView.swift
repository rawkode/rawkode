// DayPageView.swift
// EnchiridionUI
//
// Task #81 (plan §"Core Product UI (P7)", tracks 1+2). The day-page
// screen: a header with prev/next-day controls and a tap-to-pick date
// picker (both resolving through `DayPageController.goTo`'s deterministic
// `PageID.daily(_:)` path), an agenda strip listing that day's calendar
// events (`DayAgendaLoader`), and the day's actual page content hosted in
// the real `PageEditorView`/`PageEditorController` — no parallel
// page-rendering mechanism, matching the task brief's "a day page is still
// just a page."
//
// SELF-CONTAINED BY DESIGN (task brief, matching `TaskListView`/
// `TaskBoardView`'s precedent): takes only a `LocalGraphStore` (plus the
// same optional `onNavigateToReference`/`suggestPages` hooks
// `PageEditorView` itself already exposes) — no navigation-shell/`RootView`
// dependency. Deliberately NOT wired into `RootView.swift`/app navigation
// here — a separate integration task does that once sibling P7 tracks
// (kanban, Gmail triage, canvas) land.

import EnchiridionCore
import EnchiridionStore
import SwiftUI

public struct DayPageView: View {
  @State private var controller: DayPageController
  @State private var pickerDate: Date
  @State private var isPickerPresented = false

  private let onNavigateToReference: (PageID) -> Void
  private let suggestPages: (String) -> [PageSuggestion]

  public init(
    store: LocalGraphStore,
    day: DayKey = DayKey(date: Date()),
    calendar: Calendar = Calendar(identifier: .gregorian),
    onNavigateToReference: @escaping (PageID) -> Void = { _ in },
    suggestPages: @escaping (String) -> [PageSuggestion] = { _ in [] }
  ) {
    _controller = State(initialValue: DayPageController(store: store, day: day, calendar: calendar))
    _pickerDate = State(initialValue: DayNavigation.dayStart(for: day, calendar: calendar) ?? Date())
    self.onNavigateToReference = onNavigateToReference
    self.suggestPages = suggestPages
  }

  public var body: some View {
    VStack(spacing: 0) {
      navigationHeader
      Divider()
      if !controller.agenda.isEmpty {
        agendaSection
        Divider()
      }
      contentBody
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .task { await controller.load() }
  }

  // MARK: - Header: prev/next + date picker (task point 2)

  private var navigationHeader: some View {
    HStack {
      Button {
        Task { await controller.goToPreviousDay() }
      } label: {
        Image(systemName: "chevron.left")
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("Previous day")

      Spacer()

      Button {
        pickerDate = DayNavigation.dayStart(for: controller.day) ?? Date()
        isPickerPresented = true
      } label: {
        VStack(spacing: 2) {
          Text(controller.dayTitle)
            .font(.headline)
          if !controller.isToday {
            Text("Jump to today available")
              .font(.caption2)
              .foregroundStyle(.secondary)
              .accessibilityHidden(true)
          }
        }
      }
      .buttonStyle(.plain)
      .popover(isPresented: $isPickerPresented) {
        VStack(spacing: 12) {
          DatePicker(
            "Go to day", selection: $pickerDate, displayedComponents: .date
          )
          .datePickerStyle(.graphical)
          .labelsHidden()
          .onChange(of: pickerDate) { _, newValue in
            isPickerPresented = false
            Task { await controller.goTo(date: newValue) }
          }
          if !controller.isToday {
            Button("Today") {
              isPickerPresented = false
              Task { await controller.goToToday() }
            }
          }
        }
        .padding()
        .frame(minWidth: 280)
      }

      Spacer()

      Button {
        Task { await controller.goToNextDay() }
      } label: {
        Image(systemName: "chevron.right")
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("Next day")
    }
    .padding(.horizontal)
    .padding(.vertical, 8)
  }

  // MARK: - Agenda (task point 3)

  private var agendaSection: some View {
    ScrollView(.vertical) {
      VStack(alignment: .leading, spacing: 6) {
        ForEach(controller.agenda, id: \.source.id) { event in
          DayAgendaEventRow(event: event)
        }
      }
      .padding(.horizontal)
      .padding(.vertical, 8)
    }
    .frame(maxHeight: 180)
  }

  // MARK: - Page content (task point 1 — reuses PageEditorController/PageEditorView)

  @ViewBuilder
  private var contentBody: some View {
    if let editor = controller.editor {
      PageEditorView(
        controller: editor, onNavigateToReference: onNavigateToReference, suggestPages: suggestPages)
    } else if let loadError = controller.loadError {
      ContentUnavailableView(
        "Couldn't open this day", systemImage: "exclamationmark.triangle", description: Text(loadError))
    } else {
      ProgressView()
    }
  }
}

private struct DayAgendaEventRow: View {
  let event: AssistantCalendarEvent

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(timeLabel)
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .frame(width: 68, alignment: .leading)
      VStack(alignment: .leading, spacing: 1) {
        Text(event.source.title)
          .font(.subheadline)
        if let location = event.location, !location.isEmpty {
          Text(location)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
    }
  }

  private var timeLabel: String {
    if event.isAllDay { return "All day" }
    guard let start = event.startDate else { return "" }
    return start.formatted(date: .omitted, time: .shortened)
  }
}
