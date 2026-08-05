import EnchiridionCore
import OSLog
import Social
import UniformTypeIdentifiers
import UIKit

private final class SharedContentAccumulator: @unchecked Sendable {
  private let lock = NSLock()
  private var urls: [(Int, URL)] = []
  private var text: [(Int, String)] = []

  func append(url: URL, at index: Int) {
    lock.withLock { urls.append((index, url)) }
  }

  func append(text value: String, at index: Int) {
    lock.withLock { text.append((index, value)) }
  }

  func snapshot() -> (urls: [URL], text: [String]) {
    lock.withLock {
      (
        urls.sorted { $0.0 < $1.0 }.map(\.1),
        text.sorted { $0.0 < $1.0 }.map(\.1)
      )
    }
  }
}

@objc(ShareViewController)
final class ShareViewController: SLComposeServiceViewController {
  private static let maximumSharedURLs = 12
  private static let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion.task-share",
    category: "share-extension"
  )

  private var sharedText: [String] = []
  private var sharedURLs: [URL] = []
  private var isLoadingSharedContent = true
  private var captureIDs: [String: UUID] = [:]

  override func presentationAnimationDidFinish() {
    super.presentationAnimationDidFinish()
    Self.logger.notice("share_launch input_items=\(self.extensionContext?.inputItems.count ?? 0, privacy: .public)")
    loadSharedContent()
  }

  override func isContentValid() -> Bool {
    guard !isLoadingSharedContent else { return false }
    guard !hasTooManyValidURLs else { return false }
    if !sharedURLs.isEmpty { return true }
    return TaskSystemCapture.draft(text: combinedText, urls: []) != nil
  }

  override func didSelectPost() {
    guard !isLoadingSharedContent else {
      validationAlert("Enchiridion is still loading the shared content.")
      return
    }

    guard !hasTooManyValidURLs else {
      Self.logger.error("bookmark_too_many_urls url_count=\(self.sharedURLs.count, privacy: .public) maximum_count=\(Self.maximumSharedURLs, privacy: .public)")
      bookmarkAlert("Enchiridion can save up to 12 valid web links at once.")
      return
    }

    if !sharedURLs.isEmpty {
      saveBookmarks(sharedURLs)
      return
    }

    // Text-only sharing remains the legacy Inbox Task path. URL-bearing shares never reach it.
    guard let draft = TaskSystemCapture.draft(text: combinedText, urls: []) else {
      validationAlert("Add text or a link before saving.")
      return
    }

    Task { @MainActor in
      do {
        let context = try VaultRepositoryContext.open(.defaultCapture)
        let mutations = TaskMutationCoordinator(
          repository: context.repository,
          effects: .live(surface: .shareExtension, vaultID: context.vault.id)
        )
        switch await mutations.create(draft) {
        case .success:
          Self.logger.notice("task_save_success")
          extensionContext?.completeRequest(returningItems: nil)
        case .failure(let failure):
          throw failure
        }
      } catch {
        Self.logger.error("task_save_failure")
        validationAlert("Enchiridion couldn’t save this task. Open the app once, then try again.")
      }
    }
  }

  override func configurationItems() -> [Any]! { [] }

  private var combinedText: String? {
    let typedText = contentText.trimmingCharacters(in: .whitespacesAndNewlines)
    let parts = ([typedText] + sharedText)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
  }

  private var hasTooManyValidURLs: Bool {
    sharedURLs.lazy
      .filter { BookmarkURLKey(submittedURL: $0.absoluteString) != nil }
      .count > Self.maximumSharedURLs
  }

  private func saveBookmarks(_ urls: [URL]) {
    let invalidURLs = urls.filter { BookmarkURLKey(submittedURL: $0.absoluteString) == nil }
    guard invalidURLs.isEmpty else {
      Self.logger.error("bookmark_invalid url_count=\(urls.count, privacy: .public) invalid_count=\(invalidURLs.count, privacy: .public)")
      bookmarkAlert("Only valid http or https links can be saved as bookmarks.")
      return
    }

    let note = combinedText
    let now = Date()
    var calendar = Calendar.current
    calendar.timeZone = .current
    let dayKey = DayKey(date: now, calendar: calendar)
    let timeZoneIdentifier = TimeZone.current.identifier

    Task { @MainActor in
      var committed = 0
      do {
        // Open the shared inbox first so a missing App Group fails closed before the catalog
        // helper can consider any process-private legacy fallback.
        let inbox = try CaptureInboxStore(path: CaptureInboxStore.defaultPath())
        // This resolves the route from catalog state once. The extension intentionally never opens graph.sqlite.
        let registry = try VaultRegistry(path: VaultRegistry.defaultCatalogPath())
        let vaultID = try registry.snapshot().defaultCaptureVaultID

        for (index, url) in urls.enumerated() {
          let captureID = captureID(for: url, index: index)
          let request = BookmarkCaptureRequest(
            captureID: captureID,
            submittedURL: url.absoluteString,
            note: note,
            capturedAt: now,
            dayKey: dayKey,
            timeZoneIdentifier: timeZoneIdentifier,
            source: "share-extension",
            platform: "iOS",
            vaultID: vaultID
          )
          _ = try await inbox.enqueue(captureID: captureID, request: request, vaultID: vaultID, now: now)
          committed += 1
        }
        Self.logger.notice("bookmark_save_success enqueued_count=\(committed, privacy: .public)")
        extensionContext?.completeRequest(returningItems: nil)
      } catch {
        if committed > 0 {
          Self.logger.error("bookmark_enqueue_failure_partial enqueued_count=\(committed, privacy: .public) requested_count=\(urls.count, privacy: .public)")
          bookmarkAlert("Saved \(committed) of \(urls.count) bookmarks. The remaining links were not saved; try again.")
        } else {
          Self.logger.error("bookmark_queue_or_setup_failure requested_count=\(urls.count, privacy: .public)")
          bookmarkAlert("Enchiridion couldn’t open the bookmark queue. Open the app once, then try again.")
        }
      }
    }
  }

  private func captureID(for url: URL, index: Int) -> UUID {
    let key = "\(index):\(url.absoluteString)"
    if let existing = captureIDs[key] { return existing }
    let id = UUID()
    captureIDs[key] = id
    return id
  }

  private func loadSharedContent() {
    let providers = (extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? [])
      .flatMap { $0.attachments ?? [] }
    let urlProviders = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }
    let textProviders = providers.filter {
      !$0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
        && $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
    }
    let group = DispatchGroup()
    let accumulator = SharedContentAccumulator()

    for (index, provider) in urlProviders.enumerated() {
      group.enter()
      provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in
        let url = item as? URL ?? (item as? String).flatMap(URL.init(string:))
        if let url {
          accumulator.append(url: url, at: index)
        }
        group.leave()
      }
    }
    for (index, provider) in textProviders.enumerated() {
      group.enter()
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, _ in
        let text = item as? String ?? (item as? NSAttributedString)?.string
        if let text {
          accumulator.append(text: text, at: index)
        }
        group.leave()
      }
    }
    group.notify(queue: .main) { [weak self] in
      let loaded = accumulator.snapshot()
      guard let self else { return }
      self.sharedURLs = loaded.urls
      self.sharedText = loaded.text
      self.isLoadingSharedContent = false
      Self.logger.notice(
        "share_content_loaded provider_count=\(providers.count, privacy: .public) url_representations=\(urlProviders.count, privacy: .public) text_representations=\(textProviders.count, privacy: .public) loaded_urls=\(loaded.urls.count, privacy: .public) loaded_text=\(loaded.text.count, privacy: .public)"
      )
      self.validateContent()

      if self.hasTooManyValidURLs {
        self.bookmarkAlert("Enchiridion can save up to 12 valid web links at once.")
      }
    }
  }

  private func validationAlert(_ message: String) {
    let alert = UIAlertController(title: "Couldn’t Save Task", message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default))
    present(alert, animated: true)
  }

  private func bookmarkAlert(_ message: String) {
    let alert = UIAlertController(title: "Couldn’t Save Bookmark", message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default))
    present(alert, animated: true)
  }
}
