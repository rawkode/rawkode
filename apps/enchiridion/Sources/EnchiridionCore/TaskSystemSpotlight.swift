#if canImport(CoreSpotlight)
import CoreSpotlight
#endif
import Foundation

public enum TaskSystemSpotlight {
  private static let domainIdentifier = "dev.rawkode.enchiridion.tasks"

  static func searchableIdentifier(for pageID: PageID) -> String { pageID.rawValue }

  static func contentURL(for pageID: PageID) -> URL? {
    TaskReminderScheduler.taskURL(for: pageID)
  }

  public static func index(_ page: PageSnapshot) async {
#if canImport(CoreSpotlight)
    guard let task = page.taskData, task.state == .active else {
      await remove(page.id)
      return
    }
    let attributes = CSSearchableItemAttributeSet(itemContentType: "public.item")
    attributes.title = page.displayTitle
    attributes.contentDescription = "Active Enchiridion task"
    attributes.dueDate = task.deadline
    attributes.keywords = task.tags + (task.priority == .none ? [] : [task.priority.rawValue])
    attributes.contentURL = contentURL(for: page.id)
    let item = CSSearchableItem(
      uniqueIdentifier: searchableIdentifier(for: page.id),
      domainIdentifier: domainIdentifier,
      attributeSet: attributes
    )
    try? await CSSearchableIndex.default().indexSearchableItems([item])
#endif
  }

  public static func remove(_ pageID: PageID) async {
#if canImport(CoreSpotlight)
    try? await CSSearchableIndex.default().deleteSearchableItems(
      withIdentifiers: [pageID.rawValue]
    )
#endif
  }

  /// Rebuilds the task domain from repository state. This is the single
  /// canonical indexing path used at app startup and after local reloads.
  public static func reconcile(_ pages: [PageSnapshot]) async {
#if canImport(CoreSpotlight)
    let activeTasks = pages.filter {
      $0.deletedAt == nil && $0.taskData?.state == .active
    }
    try? await CSSearchableIndex.default().deleteSearchableItems(
      withDomainIdentifiers: [domainIdentifier]
    )
    for page in activeTasks { await index(page) }
#endif
  }
}
