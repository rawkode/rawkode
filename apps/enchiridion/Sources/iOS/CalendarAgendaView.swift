import EnchiridionCore
import SwiftUI

struct CalendarAgendaView: View {
  let selectedDay: Date
  let items: [CalendarAgendaItem]
  let isLoading: Bool
  let error: String?
  let isSearching: Bool
  let calendar: Calendar
  let openOccurrenceNote: (CalendarEventSnapshot) -> Void
  let openSeriesNote: (CalendarEventSnapshot) -> Void

  private var allDayItems: [CalendarAgendaItem] { items.filter(\.isAllDay) }
  private var timedItems: [CalendarAgendaItem] { items.filter { !$0.isAllDay } }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      CalendarAgendaTitle(selectedDay: selectedDay, error: error, calendar: calendar)
      CalendarAgendaContent(
        selectedDay: selectedDay,
        allDayItems: allDayItems,
        timedItems: timedItems,
        isLoading: isLoading,
        error: error,
        isSearching: isSearching,
        openOccurrenceNote: openOccurrenceNote,
        openSeriesNote: openSeriesNote
      )
    }
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
}
