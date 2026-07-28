import EnchiridionCore
import SwiftUI

struct CalendarEventRow: View {
  let event: CalendarEventSnapshot
  var showsDate = false

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      RoundedRectangle(cornerRadius: 2)
        .fill(.tint)
        .frame(width: 3)
      VStack(alignment: .leading, spacing: 3) {
        Text(event.title).font(.headline).lineLimit(1)
        Text(event.isAllDay
          ? (showsDate ? event.startDate.formatted(date: .abbreviated, time: .omitted) : "All day")
          : event.startDate.formatted(date: showsDate ? .abbreviated : .omitted, time: .shortened))
          .font(.caption)
          .foregroundStyle(.secondary)
        if let location = event.location, !location.isEmpty {
          Label(location, systemImage: "mappin.and.ellipse")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
    }
    .padding(.vertical, 3)
  }
}
