import EnchiridionCore
import SwiftUI

struct CalendarAgendaRow: View {
  let item: CalendarAgendaItem
  let selectedDay: Date
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
      NavigationLink(value: task.id) { CalendarAgendaTaskRow(task: task, placement: placement) }
        .buttonStyle(.plain)
    }
  }
}

private struct CalendarAgendaEventRow: View {
  let event: CalendarEventSnapshot
  let selectedDay: Date
  let openOccurrenceNote: () -> Void
  let openSeriesNote: (() -> Void)?

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Text(timeRange)
        .font(.caption.monospacedDigit().weight(.medium))
        .foregroundStyle(.secondary)
        .frame(width: 72, alignment: .trailing)
        .padding(.top, 2)
      Circle()
        .fill(.tint)
        .frame(width: 8, height: 8)
        .padding(.top, 5)
        .accessibilityHidden(true)
      Button(action: openOccurrenceNote) {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 5) {
            Text(event.title).font(.body.weight(.semibold)).foregroundStyle(.primary).lineLimit(2)
            if event.url != nil {
              Image(systemName: "video").foregroundStyle(.secondary).accessibilityLabel("Video link")
            }
          }
          if let location = event.location, !location.isEmpty {
            Label(location, systemImage: "mappin.and.ellipse")
              .font(.caption).foregroundStyle(.secondary).lineLimit(1)
          }
          Label(event.calendarTitle, systemImage: "calendar")
            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityHint("Open linked event note")
      Spacer(minLength: 0)
      if let openSeriesNote {
        Button(action: openSeriesNote) { Image(systemName: "rectangle.stack") }
          .buttonStyle(.borderless)
          .accessibilityLabel("Open series notes")
      }
    }
    .padding(12)
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

private struct CalendarAgendaTaskRow: View {
  let task: TaskItem
  let placement: CalendarTaskPlacement

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "checkmark.circle")
        .foregroundStyle(.secondary).font(.title3).padding(.top, 1).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(task.page.displayTitle).font(.body.weight(.semibold)).foregroundStyle(.primary).lineLimit(2)
        if let scheduledAt = placement.scheduledAt {
          Label(scheduledLabel(for: scheduledAt), systemImage: "calendar")
            .font(.caption).foregroundStyle(.secondary)
        }
        if placement.deadline != nil {
          Label("Deadline", systemImage: "flag")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
    }
    .padding(12)
    .accessibilityLabel("Task, \(task.page.displayTitle), \(placement.accessibilitySummary)")
    .accessibilityHint("Open task note")
  }

  private func scheduledLabel(for date: Date) -> String {
    placement.scheduleGranularity == .dateOnly
      ? "Scheduled · date only"
      : "Scheduled · \(date.formatted(date: .omitted, time: .shortened))"
  }
}

struct CalendarAgendaSection<Content: View>: View {
  let title: String
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      VStack(spacing: 0) { content }
        .background(.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(.separator.opacity(0.55))
        }
    }
  }
}

struct CalendarAgendaPlaceholder: View {
  var body: some View {
    CalendarAgendaSection(title: "Agenda") {
      ForEach(0..<4, id: \.self) { _ in
        HStack(spacing: 12) {
          Text("09:30–10:15").font(.caption.monospacedDigit()).frame(width: 72, alignment: .trailing)
          Circle().frame(width: 8, height: 8)
          VStack(alignment: .leading, spacing: 5) {
            Text("Calendar event title")
            Text("Calendar source").font(.caption)
          }
          Spacer()
        }
        .padding(12)
      }
    }
    .redacted(reason: .placeholder)
    .accessibilityLabel("Loading calendar")
  }
}
