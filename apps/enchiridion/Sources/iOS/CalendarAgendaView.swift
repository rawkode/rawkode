import EnchiridionCore
import SwiftUI

struct CalendarAgendaView: View {
  let selectedDay: Date
  let items: [CalendarAgendaItem]
  let isLoading: Bool
  let error: String?
  let isSearching: Bool
  let calendar: Calendar
  let capacityPlan: DayCapacityPlan
  let scheduleTask: (TaskItem, Date) -> Void
  let openOccurrenceNote: (CalendarEventSnapshot) -> Void
  let openSeriesNote: (CalendarEventSnapshot) -> Void

  private var allDayItems: [CalendarAgendaItem] { items.filter(\.isAllDay) }
  private var timedItems: [CalendarAgendaItem] { items.filter { !$0.isAllDay } }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      CalendarAgendaTitle(selectedDay: selectedDay, error: error, calendar: calendar)
      if !isLoading { CalendarCapacitySummary(plan: capacityPlan) }
      CalendarAgendaContent(
        selectedDay: selectedDay,
        allDayItems: allDayItems,
        timedItems: timedItems,
        isLoading: isLoading,
        error: error,
        isSearching: isSearching,
        capacityPlan: capacityPlan,
        scheduleTask: scheduleTask,
        openOccurrenceNote: openOccurrenceNote,
        openSeriesNote: openSeriesNote
      )
    }
  }
}

private struct CalendarCapacitySummary: View {
  let plan: DayCapacityPlan

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack {
        Label("Day capacity", systemImage: "clock.badge.checkmark")
          .font(.subheadline.weight(.semibold))
        Spacer(minLength: 12)
        Text(plan.overCapacityMinutes > 0
          ? "\(duration(plan.overCapacityMinutes)) over"
          : "\(duration(plan.availableMinutes)) open")
          .font(.subheadline.monospacedDigit().weight(.medium))
          .foregroundStyle(plan.overCapacityMinutes > 0 ? Color.orange : Color.secondary)
      }
      Text("\(duration(plan.plannedMinutes)) planned · \(duration(plan.unscheduledMinutes)) to place")
        .font(.caption)
        .foregroundStyle(.secondary)
      if plan.tasksWithoutEstimates > 0 {
        Text("\(plan.tasksWithoutEstimates) \(plan.tasksWithoutEstimates == 1 ? "task" : "tasks") without estimates")
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
    }
    .padding(12)
    .background(.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(.separator.opacity(0.55))
    }
    .accessibilityElement(children: .combine)
  }

  private func duration(_ minutes: Int) -> String {
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    let remainder = minutes % 60
    return remainder == 0 ? "\(hours)h" : "\(hours)h \(remainder)m"
  }
}

private struct CalendarAgendaTitle: View {
  let selectedDay: Date
  let error: String?
  let calendar: Calendar

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: 3) {
        Text(calendar.isDateInToday(selectedDay) ? "Today" : selectedDay.formatted(.dateTime.weekday(.wide)))
          .font(.title2.weight(.bold))
        Text(selectedDay.formatted(.dateTime.month(.abbreviated).day().year()))
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 12)
      if let error {
        Image(systemName: "exclamationmark.triangle")
          .foregroundStyle(.orange)
          .accessibilityLabel("Calendar error: \(error)")
      }
    }
  }
}

private struct CalendarAgendaContent: View {
  let selectedDay: Date
  let allDayItems: [CalendarAgendaItem]
  let timedItems: [CalendarAgendaItem]
  let isLoading: Bool
  let error: String?
  let isSearching: Bool
  let capacityPlan: DayCapacityPlan
  let scheduleTask: (TaskItem, Date) -> Void
  let openOccurrenceNote: (CalendarEventSnapshot) -> Void
  let openSeriesNote: (CalendarEventSnapshot) -> Void

  var body: some View {
    if isLoading {
      CalendarAgendaPlaceholder()
    } else if allDayItems.isEmpty && timedItems.isEmpty {
      ContentUnavailableView {
        Label(emptyTitle, systemImage: error == nil ? "calendar.badge.checkmark" : "calendar.badge.exclamationmark")
      } description: {
        Text(emptyDescription)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 34)
    } else {
      if !allDayItems.isEmpty {
        CalendarAgendaSection(title: "All day") {
          ForEach(allDayItems) { item in
            CalendarAgendaRow(
              item: item,
              selectedDay: selectedDay,
              suggestion: suggestion(for: item),
              scheduleTask: scheduleTask,
              openOccurrenceNote: openOccurrenceNote,
              openSeriesNote: openSeriesNote
            )
          }
        }
      }
      if !timedItems.isEmpty {
        CalendarAgendaSection(title: allDayItems.isEmpty ? "Agenda" : "Scheduled") {
          ForEach(timedItems) { item in
            CalendarAgendaRow(
              item: item,
              selectedDay: selectedDay,
              suggestion: suggestion(for: item),
              scheduleTask: scheduleTask,
              openOccurrenceNote: openOccurrenceNote,
              openSeriesNote: openSeriesNote
            )
          }
        }
      }
    }
  }

  private var emptyTitle: String {
    if isSearching { return "No matching items" }
    return error == nil ? "Nothing scheduled" : "Calendar unavailable"
  }

  private var emptyDescription: String {
    if isSearching { return "Try a different search or calendar filter." }
    return error ?? "Events and scheduled tasks for this day will appear here."
  }

  private func suggestion(for item: CalendarAgendaItem) -> DayCapacitySuggestion? {
    guard case .task(let task, _) = item else { return nil }
    return capacityPlan.suggestion(for: task.id)
  }
}
