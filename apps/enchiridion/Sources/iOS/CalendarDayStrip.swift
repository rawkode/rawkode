import EnchiridionCore
import SwiftUI

struct CalendarDayStrip: View {
  let selectedDay: Date
  let events: [CalendarEventSnapshot]
  let calendar: Calendar
  let selectDay: (Date) -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var displayedStartDay: Date

  init(
    selectedDay: Date,
    events: [CalendarEventSnapshot],
    calendar: Calendar,
    selectDay: @escaping (Date) -> Void
  ) {
    self.selectedDay = selectedDay
    self.events = events
    self.calendar = calendar
    self.selectDay = selectDay
    _displayedStartDay = State(initialValue: calendar.startOfDay(for: selectedDay))
  }

  private var days: [CalendarDayStripItem] {
    (0..<7).compactMap { offset in
      guard let date = calendar.date(byAdding: .day, value: offset, to: displayedStartDay)
      else { return nil }
      return CalendarDayStripItem(
        date: date, id: CalendarDayStripItem.id(for: date, calendar: calendar))
    }
  }

  var body: some View {
    GeometryReader { proxy in
      HStack(spacing: 0) {
        ForEach(days) { day in
          CalendarDayButton(
            day: day.date,
            density: CalendarAgendaDate.eventDensity(
              on: day.date, in: events, calendar: calendar),
            isSelected: calendar.isDate(day.date, inSameDayAs: selectedDay),
            isToday: calendar.isDateInToday(day.date)
          ) {
            selectDay(day.date)
          }
          .frame(width: proxy.size.width / 7)
          .overlay(alignment: .trailing) {
            Rectangle()
              .fill(.separator.opacity(0.45))
              .frame(width: 1, height: 56)
              .accessibilityHidden(true)
          }
        }
      }
      .id(CalendarDayStripItem.id(for: displayedStartDay, calendar: calendar))
      .frame(width: proxy.size.width, height: 84)
      .contentShape(Rectangle())
      .gesture(weekSwipe)
    }
    .frame(height: 84)
    .background(RosePinePalette.calendarBackground)
    .overlay(alignment: .top) { Divider() }
    .overlay(alignment: .bottom) { Divider() }
    .tint(RosePinePalette.calendarAccent)
    .accessibilityLabel("Selected date and upcoming days")
    .accessibilityHint("Swipe left or right to change week")
    .onChange(of: selectedDay) { _, newDay in
      let newStartDay = calendar.startOfDay(for: newDay)
      guard newStartDay != displayedStartDay else { return }
      animate { displayedStartDay = newStartDay }
    }
  }

  private var weekSwipe: some Gesture {
    DragGesture(minimumDistance: 28).onEnded { value in
      guard abs(value.translation.width) > abs(value.translation.height) * 1.2,
        abs(value.translation.width) > 48
      else { return }

      let offset = value.translation.width < 0 ? 7 : -7
      guard let nextDay = calendar.date(
        byAdding: .day, value: offset, to: calendar.startOfDay(for: selectedDay)
      ) else { return }

      animate { displayedStartDay = nextDay }
      selectDay(nextDay)
    }
  }

  private func animate(_ changes: () -> Void) {
    if reduceMotion {
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction, changes)
    } else {
      withAnimation(.easeInOut(duration: 0.18), changes)
    }
  }
}

private struct CalendarDayStripItem: Identifiable {
  let date: Date
  let id: String

  static func id(for day: Date, calendar: Calendar) -> String {
    DayKey(date: day, calendar: calendar).rawValue
  }
}

private struct CalendarDayButton: View {
  let day: Date
  let density: Int
  let isSelected: Bool
  let isToday: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 5) {
        Text(day.formatted(.dateTime.weekday(.abbreviated)).uppercased())
          .font(.caption2.weight(.bold))
          .foregroundStyle(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))

        ZStack {
          Circle()
            .fill(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.clear))
            .frame(width: 36, height: 36)
          Circle()
            .strokeBorder(.tint, lineWidth: 1.5)
            .frame(width: 36, height: 36)
            .opacity(isToday && !isSelected ? 1 : 0)
          Text(day.formatted(.dateTime.day()))
            .font(.body.monospacedDigit().weight(.semibold))
            .foregroundStyle(isSelected ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
        }

        CalendarEventDensity(density: density, isSelected: isSelected)
      }
      .frame(maxWidth: .infinity)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(day.formatted(.dateTime.weekday(.wide).month(.wide).day().year()))
    .accessibilityValue(
      density == 0 ? "No events" : "\(density) \(density == 1 ? "event" : "events")"
    )
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}

private struct CalendarEventDensity: View {
  let density: Int
  let isSelected: Bool

  var body: some View {
    HStack(spacing: 2) {
      ForEach(0..<min(density, 4), id: \.self) { _ in
        Circle()
          .fill(isSelected ? AnyShapeStyle(.white.opacity(0.9)) : AnyShapeStyle(.tint))
          .frame(width: 4, height: 4)
      }
    }
    .frame(height: 4)
    .accessibilityHidden(true)
  }
}
