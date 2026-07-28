public enum LibrarySection: String, CaseIterable, Identifiable, Sendable {
  case today
  case calendar
  case allPages
  case pinned
  case trash

  public var id: Self { self }
}
