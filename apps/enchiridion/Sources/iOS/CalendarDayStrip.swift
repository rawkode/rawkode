import EnchiridionCore
import SwiftUI

struct CalendarDayStrip: View {
  private static let leadingDayBuffer = 28
  private static let trailingDayBuffer = 56
  private static let visibleDayCount: CGFloat = 7

  let selectedDay: Date
  let events: [CalendarEventSnapshot]
  let calendar: Calendar
  let selectDay: (Date) -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var timelineStartDay: Date

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
    let startOfSelectedDay = calendar.startOfDay(for: selectedDay)
    _timelineStartDay = State(
      initialValue: calendar.date(
        byAdding: .day,
        value: -Self.leadingDayBuffer,
        to: startOfSelectedDay
      ) ?? startOfSelectedDay
    )
  }

  private var days: [CalendarDayStripItem] {
    (0...(Self.leadingDayBuffer + Self.trailingDayBuffer)).compactMap { offset in
      guard let date = calendar.date(byAdding: .day, value: offset, to: timelineStartDay)
      else { return nil }
      return CalendarDayStripItem(
        date: date, id: CalendarDayStripItem.id(for: date, calendar: calendar))
    }
  }

  private var timelineEndDay: Date {
    calendar.date(
      byAdding: .day,
      value: Self.leadingDayBuffer + Self.trailingDayBuffer,
      to: timelineStartDay
    ) ?? timelineStartDay
  }

  var body: some View {
    GeometryReader { proxy in
      ScrollViewReader { scrollProxy in
        ScrollView(.horizontal, showsIndicators: false) {
          LazyHStack(spacing: 0) {
            ForEach(days) { day in
              CalendarDayButton(
                day: day.date,
                events: CalendarAgendaDate.events(on: day.date, in: events, calendar: calendar),
                isSelected: calendar.isDate(day.date, inSameDayAs: selectedDay),
                isToday: calendar.isDateInToday(day.date)
              ) {
                selectDay(day.date)
              }
              .id(day.id)
              .frame(width: proxy.size.width / Self.visibleDayCount)
              .overlay(alignment: .trailing) {
                Rectangle()
                  .fill(.separator.opacity(0.45))
                  .frame(width: 1, height: 56)
                  .accessibilityHidden(true)
              }
            }
          }
        }
        .scrollDisabled(true)
        .frame(width: proxy.size.width, height: 84)
        .contentShape(Rectangle())
        .simultaneousGesture(weekSwipe)
        .onAppear {
          scroll(scrollProxy, to: calendar.startOfDay(for: selectedDay), animated: false)
        }
        .onChange(of: selectedDay) { _, newDay in
          moveSelection(to: newDay, with: scrollProxy)
        }
      }
    }
    .frame(height: 84)
    .background(RosePinePalette.calendarBackground)
    .overlay(alignment: .top) { Divider() }
    .overlay(alignment: .bottom) { Divider() }
    .tint(RosePinePalette.calendarAccent)
    .accessibilityLabel("Selected date and upcoming days")
    .accessibilityHint("Swipe left or right to change week")
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

      selectDay(nextDay)
    }
  }

  private func moveSelection(to date: Date, with proxy: ScrollViewProxy) {
    let day = calendar.startOfDay(for: date)
    guard day < timelineStartDay || day > timelineEndDay else {
      scroll(proxy, to: day, animated: true)
      return
    }

    let newTimelineStartDay = calendar.date(
      byAdding: .day,
      value: -Self.leadingDayBuffer,
      to: day
    ) ?? day
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) {
      timelineStartDay = newTimelineStartDay
    }

    Task { @MainActor in
      await Task.yield()
      scroll(proxy, to: day, animated: false)
    }
  }

  private func scroll(_ proxy: ScrollViewProxy, to day: Date, animated: Bool) {
    let changes = {
      proxy.scrollTo(CalendarDayStripItem.id(for: day, calendar: calendar), anchor: .leading)
    }
    guard animated, !reduceMotion else {
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction, changes)
      return
    }
    withAnimation(.easeInOut(duration: 0.26), changes)
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
  let events: [CalendarEventSnapshot]
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

        CalendarEventDensity(events: events)
      }
      .frame(maxWidth: .infinity)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(day.formatted(.dateTime.weekday(.wide).month(.wide).day().year()))
    .accessibilityValue(
      events.isEmpty ? "No events" : "\(events.count) \(events.count == 1 ? "event" : "events")"
    )
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}

private struct CalendarEventDensity: View {
  private static let maximumDotCount = 4

  let events: [CalendarEventSnapshot]

  private var visibleEvents: [CalendarEventSnapshot] {
    Array(events.prefix(Self.maximumDotCount))
  }

  var body: some View {
    HStack(spacing: 2) {
      ForEach(visibleEvents.indices, id: \.self) { index in
        Circle()
          .fill(CalendarSourceColor.color(for: visibleEvents[index].calendarColorHex))
          .frame(width: 4, height: 4)
      }
    }
    .frame(height: 4)
    .accessibilityHidden(true)
  }
}
