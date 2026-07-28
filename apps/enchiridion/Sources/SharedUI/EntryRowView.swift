import EnchiridionCore
import SwiftUI

struct PageRowView: View {
  let page: PageSnapshot
  var calendarContext: CalendarPageContext?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text(page.displayTitle)
          .font(.headline)
          .lineLimit(1)
        if page.isPinned {
          Image(systemName: "pin.fill")
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Pinned")
        }
      }
      if let subtitle = calendarSubtitle {
        Text(subtitle)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      if !page.preview.isEmpty {
        Text(page.preview)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
      if calendarContext == nil {
        Text(page.modifiedAt, format: .relative(presentation: .named))
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
    }
    .padding(.vertical, 4)
  }

  private var calendarSubtitle: String? {
    guard let calendarContext else { return nil }
    switch calendarContext.kind {
    case .series:
      return "Series notes"
    case .occurrence:
      guard let event = calendarContext.event else { return nil }
      return event.startDate.formatted(
        date: .abbreviated,
        time: event.isAllDay ? .omitted : .shortened
      )
    }
  }
}
