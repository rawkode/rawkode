import Foundation

@MainActor
final class DirectoryPresentationController {
  private var presenter: VisibleDirectoryPresenter?
  private var refreshTask: Task<Void, Never>?

  func observe(_ url: URL, onChange: @escaping @MainActor () -> Void) {
    stop()
    let presenter = VisibleDirectoryPresenter(url: url) { [weak self] in
      self?.refreshTask?.cancel()
      self?.refreshTask = Task { @MainActor in
        try? await Task.sleep(for: .milliseconds(180))
        guard !Task.isCancelled else { return }
        onChange()
      }
    }
    self.presenter = presenter
    NSFileCoordinator.addFilePresenter(presenter)
  }

  func stop() {
    refreshTask?.cancel()
    refreshTask = nil
    if let presenter { NSFileCoordinator.removeFilePresenter(presenter) }
    presenter = nil
  }

  deinit {
    if let presenter { NSFileCoordinator.removeFilePresenter(presenter) }
  }
}

private final class VisibleDirectoryPresenter: NSObject, NSFilePresenter, @unchecked Sendable {
  let presentedItemURL: URL?
  let presentedItemOperationQueue: OperationQueue
  private let onChange: @MainActor () -> Void

  init(url: URL, onChange: @escaping @MainActor () -> Void) {
    presentedItemURL = url
    presentedItemOperationQueue = OperationQueue()
    presentedItemOperationQueue.maxConcurrentOperationCount = 1
    presentedItemOperationQueue.qualityOfService = .utility
    self.onChange = onChange
  }

  func presentedItemDidChange() { publish() }
  func presentedSubitemDidAppear(at url: URL) { publish() }
  func presentedSubitem(at oldURL: URL, didMoveTo newURL: URL) { publish() }
  func presentedSubitemDidChange(at url: URL) { publish() }
  func presentedSubitemDidDisappear(at url: URL) { publish() }

  private func publish() {
    Task { @MainActor [onChange] in onChange() }
  }
}
