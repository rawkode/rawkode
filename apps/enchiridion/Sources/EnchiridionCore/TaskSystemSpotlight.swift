import Foundation

#if canImport(Darwin)
  import Darwin
#endif

#if canImport(CoreSpotlight)
  import CoreSpotlight
#endif

public enum TaskSpotlightEffectOutcome: Equatable, Sendable {
  case applied
  case unavailable
  case indexingFailed(String)
  case removalFailed(String)
}

public enum TaskSystemSpotlight {
  private static let domainIdentifier = "dev.rawkode.enchiridion.tasks"
  private static let operationLane = TaskSystemExclusiveOperationLane()

  static func searchableIdentifier(for pageID: PageID) -> String { pageID.rawValue }

  static func contentURL(for pageID: PageID) -> URL? {
    TaskReminderScheduler.taskURL(for: pageID)
  }

  @discardableResult
  public static func index(_ page: PageSnapshot) async -> TaskSpotlightEffectOutcome {
    #if canImport(CoreSpotlight)
      do {
        return try await operationLane.perform {
          try await withCrossProcessLock {
            guard let item = searchableItem(for: page) else {
              return await removeWithoutLock(page.id)
            }
            do {
              try await CSSearchableIndex.default().indexSearchableItems([item])
              return .applied
            } catch {
              return .indexingFailed(error.localizedDescription)
            }
          }
        }
      } catch {
        return .indexingFailed(error.localizedDescription)
      }
    #else
      return .unavailable
    #endif
  }

  @discardableResult
  public static func remove(_ pageID: PageID) async -> TaskSpotlightEffectOutcome {
    #if canImport(CoreSpotlight)
      do {
        return try await operationLane.perform {
          try await withCrossProcessLock {
            await removeWithoutLock(pageID)
          }
        }
      } catch {
        return .removalFailed(error.localizedDescription)
      }
    #else
      return .unavailable
    #endif
  }

  /// Rebuilds the task domain from repository state. This is the single
  /// canonical indexing path used at app startup and after local reloads.
  @discardableResult
  public static func reconcile(_ pages: [PageSnapshot]) async -> TaskSpotlightEffectOutcome {
    #if canImport(CoreSpotlight)
      do {
        return try await operationLane.perform {
          try await withCrossProcessLock {
            do {
              try await CSSearchableIndex.default().deleteSearchableItems(
                withDomainIdentifiers: [domainIdentifier]
              )
            } catch {
              return .removalFailed(error.localizedDescription)
            }
            let activeItems = pages.compactMap(searchableItem(for:))
            guard !activeItems.isEmpty else { return .applied }
            do {
              try await CSSearchableIndex.default().indexSearchableItems(activeItems)
              return .applied
            } catch {
              return .indexingFailed(error.localizedDescription)
            }
          }
        }
      } catch {
        return .indexingFailed(error.localizedDescription)
      }
    #else
      return .unavailable
    #endif
  }

  #if canImport(CoreSpotlight)
    private static func searchableItem(for page: PageSnapshot) -> CSSearchableItem? {
      guard page.deletedAt == nil, let task = page.taskData, task.state == .active else {
        return nil
      }
      let attributes = CSSearchableItemAttributeSet(itemContentType: "public.item")
      attributes.title = page.displayTitle
      attributes.contentDescription = "Active Enchiridion task"
      attributes.dueDate = task.deadline
      attributes.keywords =
        task.tags + (task.priority == .none ? [] : [task.priority.rawValue])
      attributes.contentURL = contentURL(for: page.id)
      return CSSearchableItem(
        uniqueIdentifier: searchableIdentifier(for: page.id),
        domainIdentifier: domainIdentifier,
        attributeSet: attributes
      )
    }

    private static func removeWithoutLock(_ pageID: PageID) async -> TaskSpotlightEffectOutcome {
      do {
        try await CSSearchableIndex.default().deleteSearchableItems(
          withIdentifiers: [pageID.rawValue]
        )
        return .applied
      } catch {
        return .removalFailed(error.localizedDescription)
      }
    }

    private static func withCrossProcessLock<Value: Sendable>(
      _ operation: @escaping @Sendable () async -> Value
    ) async throws -> Value {
      let lockPath = try LibraryRepository.defaultLocalPath() + ".spotlight.lock"
      let descriptor = open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
      guard descriptor >= 0 else { throw posixError() }
      defer { close(descriptor) }
      guard flock(descriptor, LOCK_EX) == 0 else { throw posixError() }
      defer { _ = flock(descriptor, LOCK_UN) }
      return await operation()
    }

    private static func posixError() -> NSError {
      NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
  #endif
}
