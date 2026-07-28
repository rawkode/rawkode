import EnchiridionCore

extension LibrarySection {
  var title: String {
    switch self {
    case .today: "Today"
    case .calendar: "Calendar"
    case .allPages: "All Pages"
    case .pinned: "Pinned"
    case .trash: "Trash"
    }
  }

  var systemImage: String {
    switch self {
    case .today: "sun.max"
    case .calendar: "calendar"
    case .allPages: "books.vertical"
    case .pinned: "pin"
    case .trash: "trash"
    }
  }
}
