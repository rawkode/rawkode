import SwiftUI

struct CalendarHeader: View {
  let selectedDay: Date
  let showDatePicker: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Button(action: showDatePicker) {
        VStack(alignment: .leading, spacing: 2) {
          Text(selectedDay.formatted(.dateTime.month(.wide).year()))
            .font(.system(.largeTitle, design: .rounded, weight: .bold))
            .foregroundStyle(.primary)
          Text(selectedDay.formatted(.dateTime.weekday(.wide).day()))
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Choose date, currently \(selectedDay.formatted(date: .long, time: .omitted))")

      Spacer(minLength: 12)

      Label("Read-only", systemImage: "lock")
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.thinMaterial, in: Capsule())
        .accessibilityHint("Events can be opened as linked Enchiridion notes")
    }
  }
}

struct CalendarFilterMenu: View {
  let calendarTitles: [String]
  @Binding var selectedCalendarTitles: Set<String>

  var body: some View {
    Menu {
      Button(action: showAllCalendars) {
        Label("All calendars", systemImage: selectedCalendarTitles.isEmpty ? "checkmark" : "calendar")
      }
      if !calendarTitles.isEmpty {
        Divider()
        ForEach(calendarTitles, id: \.self) { title in
          Button { toggle(title) } label: {
            Label(title, systemImage: selectedCalendarTitles.contains(title) ? "checkmark" : "calendar")
          }
        }
      }
    } label: {
      Label("Filter calendars", systemImage: "line.3.horizontal.decrease.circle")
    }
    .accessibilityLabel("Filter calendars")
  }

  private func showAllCalendars() { selectedCalendarTitles.removeAll() }

  private func toggle(_ title: String) {
    if selectedCalendarTitles.contains(title) {
      selectedCalendarTitles.remove(title)
    } else {
      selectedCalendarTitles.insert(title)
    }
  }
}

struct CalendarDatePicker: View {
  @Binding var selectedDay: Date
  let dismiss: () -> Void

  var body: some View {
    NavigationStack {
      DatePicker("Choose a day", selection: $selectedDay, displayedComponents: .date)
        .datePickerStyle(.graphical)
        .padding()
        .navigationTitle("Choose Date")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button("Done", action: dismiss)
          }
        }
    }
    .presentationDetents([.medium])
  }
}
