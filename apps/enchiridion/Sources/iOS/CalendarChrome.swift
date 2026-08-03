import SwiftUI

struct CalendarFilterMenu: View {
  let calendarTitles: [String]
  @Binding var selectedCalendarTitles: Set<String>

  var body: some View {
    Menu {
      Button(action: showAllCalendars) {
        Label(
          "All calendars", systemImage: selectedCalendarTitles.isEmpty ? "checkmark" : "calendar")
      }
      if !calendarTitles.isEmpty {
        Divider()
        ForEach(calendarTitles, id: \.self) { title in
          Button {
            toggle(title)
          } label: {
            Label(
              title, systemImage: selectedCalendarTitles.contains(title) ? "checkmark" : "calendar")
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
