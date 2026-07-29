import EnchiridionCore
import SwiftUI

struct CalendarDayStrip: View {
  let selectedDay: Date
  let events: [CalendarEventSnapshot]
  let calendar: Calendar
  let selectDay: (Date) -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var selectedDayID: String { CalendarDayStripItem.id(for: selectedDay, calendar: calendar) }
  private var days: [CalendarDayStripItem] {
    CalendarDayStripItem.days(around: selectedDay, calendar: calendar)
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(spacing: 8) {
          ForEach(days) { day in
            CalendarDayButton(
              day: day.date,
              density: CalendarAgendaDate.eventDensity(on: day.date, in: events, calendar: calendar),
              isSelected: day.id == selectedDayID,
              isToday: calendar.isDateInToday(day.date)
            ) {
              selectDay(day.date)
            }
            .id(day.id)
          }
        }
        .padding(10)
      }
      .onAppear { scroll(to: selectedDayID, using: proxy, animated: false) }
      .onChange(of: selectedDayID) { _, dayID in
        scroll(to: dayID, using: proxy, animated: true)
      }
    }
    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .accessibilityLabel("Days around selected date")
  }

  private func scroll(to dayID: String, using proxy: ScrollViewProxy, animated: Bool) {
    Task { @MainActor in
      await Task.yield()
      if animated && !reduceMotion {
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(dayID, anchor: .center) }
      } else {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { proxy.scrollTo(dayID, anchor: .center) }
      }
    }
  }
}

private struct CalendarDayStripItem: Identifiable {
  let date: Date
  let id: String

  static func days(around day: Date, calendar: Calendar) -> [Self] {
    (-14...14).compactMap { offset in
      guard let date = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: day)) else {
        return nil
      }
      return .init(date: date, id: id(for: date, calendar: calendar))
    }
  }

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
        Text(day.formatted(.dateTime.weekday(.narrow))).font(.caption2.weight(.semibold))
        Text(day.formatted(.dateTime.day())).font(.headline.monospacedDigit())
        CalendarEventDensity(density: density, isSelected: isSelected)
      }
      .frame(minWidth: 44)
      .padding(.vertical, 8)
      .foregroundStyle(isSelected ? AnyShapeStyle(.background) : AnyShapeStyle(.primary))
      .background {
        if isSelected { Capsule().fill(.tint) }
        else if isToday { Capsule().strokeBorder(.tint, lineWidth: 1) }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(day.formatted(.dateTime.weekday(.wide).month(.wide).day().year()))
    .accessibilityValue(density == 0 ? "No events" : "\(density) \(density == 1 ? "event" : "events")")
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
          .fill(isSelected ? AnyShapeStyle(.background) : AnyShapeStyle(.tint))
          .frame(width: 4, height: 4)
      }
    }
    .frame(height: 4)
    .accessibilityHidden(true)
  }
}
