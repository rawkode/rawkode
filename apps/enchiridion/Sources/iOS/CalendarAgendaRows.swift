import EnchiridionCore
import SwiftUI

struct CalendarAgendaRow: View {
  let item: CalendarAgendaItem
  let selectedDay: Date
  let suggestion: DayCapacitySuggestion?
  let scheduleTask: (TaskItem, Date) -> Void
  let openOccurrenceNote: (CalendarEventSnapshot) -> Void
  let openSeriesNote: (CalendarEventSnapshot) -> Void

  @ViewBuilder
  var body: some View {
    switch item {
    case .event(let event):
      CalendarAgendaEventRow(
        event: event,
        selectedDay: selectedDay,
        openOccurrenceNote: { openOccurrenceNote(event) },
        openSeriesNote: event.identity.series == nil ? nil : { openSeriesNote(event) }
      )
    case .task(let task, let placement):
      VStack(spacing: 0) {
        NavigationLink(value: task.id) { CalendarAgendaTaskRow(task: task, placement: placement) }
          .buttonStyle(.plain)
        if let suggestion {
          Divider().padding(.leading, 44)
          Button {
            scheduleTask(task, suggestion.interval.start)
          } label: {
            HStack {
              Label(suggestionLabel(suggestion.interval), systemImage: "calendar.badge.plus")
              Spacer(minLength: 8)
              Text("Schedule").fontWeight(.semibold)
            }
            .font(.caption)
            .padding(.leading, 44)
            .padding(.trailing, 12)
            .padding(.vertical, 9)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .foregroundStyle(.tint)
          .accessibilityLabel(
            "Schedule \(task.page.displayTitle), \(suggestionLabel(suggestion.interval))"
          )
          .accessibilityHint("Assigns this time to the task without changing your calendar")
        }
      }
    }
  }

  private func suggestionLabel(_ interval: DayCapacityInterval) -> String {
    let start = interval.start.formatted(date: .omitted, time: .shortened)
    let end = interval.end.formatted(date: .omitted, time: .shortened)
    return "Suggested \(start)–\(end)"
  }
}

private struct CalendarAgendaEventRow: View {
  let event: CalendarEventSnapshot
  let selectedDay: Date
  let openOccurrenceNote: () -> Void
  let openSeriesNote: (() -> Void)?

  @Environment(\.openURL) private var openURL

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Circle()
        .fill(CalendarSourceColor.color(for: event.calendarColorHex))
        .frame(width: 9, height: 9)
        .padding(.top, 7)
        .accessibilityHidden(true)
      Button(action: openOccurrenceNote) {
        VStack(alignment: .leading, spacing: 4) {
          Text(timeRange)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
          Text(event.title)
            .font(.body.weight(.semibold))
            .foregroundStyle(.primary)
            .lineLimit(3)
          HStack(spacing: 5) {
            if let location = event.location, !location.isEmpty {
              Text(location)
                .lineLimit(1)
            }
            if let location = event.location, !location.isEmpty {
              Text("·")
            }
            Text(event.calendarTitle)
              .lineLimit(1)
          }
          .font(.caption)
          .foregroundStyle(.secondary)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityHint("Open linked event note")
      Spacer(minLength: 0)
      VStack(alignment: .trailing, spacing: 8) {
        if let url = event.url {
          Button { openURL(url) } label: {
            Text("Join")
              .font(.caption.weight(.semibold))
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
          .accessibilityLabel("Join \(event.title)")
        }
        if let openSeriesNote {
          Button(action: openSeriesNote) {
            Image(systemName: "note.text")
              .font(.body.weight(.medium))
          }
          .buttonStyle(.borderless)
          .foregroundStyle(.secondary)
          .accessibilityLabel("Open series notes")
        }
      }
    }
    .padding(.vertical, 14)
    .overlay(alignment: .bottom) {
      Divider()
        .padding(.leading, 28)
        .opacity(0.45)
    }
    .accessibilityElement(children: .contain)
  }

  private var timeRange: String {
    if event.isAllDay { return "All day" }
    if event.startDate < selectedDay { return "Continues" }
    let start = event.startDate.formatted(date: .omitted, time: .shortened)
    let end = event.endDate.formatted(date: .omitted, time: .shortened)
    return "\(start)–\(end)"
  }
}

enum CalendarSourceColor {
  static func color(for hex: String?) -> Color {
    guard let hex else { return RosePinePalette.calendarAccent }
    let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")).uppercased()
    guard value.count == 6, let rgb = UInt64(value, radix: 16) else {
      return RosePinePalette.calendarAccent
    }
    return Color(
      red: Double((rgb >> 16) & 0xFF) / 255,
      green: Double((rgb >> 8) & 0xFF) / 255,
      blue: Double(rgb & 0xFF) / 255
    )
  }
}

private struct CalendarAgendaTaskRow: View {
  let task: TaskItem
  let placement: CalendarTaskPlacement

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "checklist")
        .foregroundStyle(.tint).font(.title3).padding(.top, 1).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(task.page.displayTitle).font(.body.weight(.semibold)).foregroundStyle(.primary)
          .lineLimit(2)
        if let scheduledAt = placement.scheduledAt {
          Label(scheduledLabel(for: scheduledAt), systemImage: "calendar")
            .font(.caption).foregroundStyle(.secondary)
        }
        if placement.deadline != nil {
          Label("Deadline", systemImage: "flag")
            .font(.caption).foregroundStyle(.secondary)
        }
        if let estimatedMinutes = placement.estimatedMinutes, estimatedMinutes > 0 {
          Label("\(estimatedMinutes) min", systemImage: "timer")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
    }
    .padding(.vertical, 13)
    .overlay(alignment: .bottom) {
      Divider()
        .padding(.leading, 42)
        .opacity(0.45)
    }
    .accessibilityLabel("Task, \(task.page.displayTitle), \(placement.accessibilitySummary)")
    .accessibilityHint("Open task note")
  }

  private func scheduledLabel(for date: Date) -> String {
    if !placement.isScheduledOnDisplayedDay {
      return "Scheduled · \(date.formatted(date: .abbreviated, time: .shortened))"
    }
    return placement.scheduleGranularity == .dateOnly
      ? "Scheduled · date only"
      : "Scheduled · \(date.formatted(date: .omitted, time: .shortened))"
  }
}

struct CalendarAgendaSection<Content: View>: View {
  let title: String
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title.uppercased())
        .font(.caption2.weight(.bold))
        .foregroundStyle(.secondary)
      VStack(spacing: 0) { content }
    }
  }
}

struct CalendarAgendaPlaceholder: View {
  var body: some View {
    CalendarAgendaSection(title: "Agenda") {
      ForEach(0..<4, id: \.self) { _ in
        HStack(spacing: 12) {
          Circle().frame(width: 8, height: 8)
          VStack(alignment: .leading, spacing: 5) {
            Text("09:30–10:15").font(.subheadline.weight(.semibold))
            Text("Calendar event title")
            Text("Calendar source").font(.caption)
          }
          Spacer()
        }
        .padding(.vertical, 13)
      }
    }
    .redacted(reason: .placeholder)
    .accessibilityLabel("Loading calendar")
  }
}
