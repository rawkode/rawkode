import AppKit
import EnchiridionCore
import OSLog
import Social
import UniformTypeIdentifiers

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

@objc(MacShareViewController)
final class MacShareViewController: SLComposeServiceViewController {
  private static let maximumSharedURLs = 12
  private static let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion.mac-task-share",
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
    !isLoadingSharedContent && !sharedURLs.isEmpty
  }

  override func didSelectPost() {
    let urls = sharedURLs
    guard !urls.isEmpty else {
      Self.logger.error("bookmark_no_urls text_representation_count=\(sharedText.count, privacy: .public)")
      validationAlert("Sharing plain text is not supported yet. Share one or more web links instead.")
      return
    }

    guard urls.count <= Self.maximumSharedURLs else {
      Self.logger.error("bookmark_too_many_urls url_count=\(urls.count, privacy: .public) maximum_count=\(Self.maximumSharedURLs, privacy: .public)")
      validationAlert("Enchiridion can save up to 12 web links at once.")
      return
    }

    let invalidCount = urls.filter { BookmarkURLKey(submittedURL: $0.absoluteString) == nil }.count
    guard invalidCount == 0 else {
      Self.logger.error("bookmark_invalid url_count=\(urls.count, privacy: .public) invalid_count=\(invalidCount, privacy: .public)")
      validationAlert("Enchiridion can only save valid web links. Remove the \(invalidCount) invalid link\(invalidCount == 1 ? "" : "s") and try again.")
      return
    }

    Task { @MainActor [weak self] in
      guard let self else { return }
      var saved = 0
      do {
        let inbox = try CaptureInboxStore(path: CaptureInboxStore.defaultPath())
        let registry = try VaultRegistry(path: VaultRegistry.defaultCatalogPath())
        let vaultID = try registry.snapshot().defaultCaptureVaultID
        let capturedAt = Date()
        var calendar = Calendar.current
        calendar.timeZone = .current
        let note = combinedText

        for (index, url) in urls.enumerated() {
          let request = BookmarkCaptureRequest(
            captureID: captureID(for: url, index: index),
            submittedURL: url.absoluteString,
            note: note,
            capturedAt: capturedAt,
            dayKey: DayKey(date: capturedAt, calendar: calendar),
            timeZoneIdentifier: calendar.timeZone.identifier,
            source: "share-extension",
            platform: "macOS",
            vaultID: vaultID
          )
          _ = try await inbox.enqueue(
            captureID: request.captureID,
            request: request,
            vaultID: vaultID
          )
          saved += 1
        }
        Self.logger.notice("bookmark_save_success enqueued_count=\(saved, privacy: .public)")
        extensionContext?.completeRequest(returningItems: nil)
      } catch {
        if saved > 0 {
          Self.logger.error("bookmark_enqueue_failure_partial enqueued_count=\(saved, privacy: .public) requested_count=\(urls.count, privacy: .public)")
        } else {
          Self.logger.error("bookmark_queue_or_setup_failure requested_count=\(urls.count, privacy: .public)")
        }
        let savedMessage = savedCountMessage(saved: saved, total: urls.count)
        validationAlert("\(savedMessage) Enchiridion could not durably save the remaining link\(urls.count == 1 ? "" : "s"). \(error.localizedDescription)")
      }
    }
  }

  private var combinedText: String? {
    let typedText = contentText.trimmingCharacters(in: .whitespacesAndNewlines)
    let parts = ([typedText] + sharedText)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
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
    let urlProviders = providers.filter {
      $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
    }
    let textProviders = providers.filter {
      !$0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
        && $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
    }
    let group = DispatchGroup()
    let accumulator = SharedContentAccumulator()

    for (index, provider) in urlProviders.enumerated() {
      group.enter()
      provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in
          let url = item as? URL ?? (item as? NSURL).map { $0 as URL }
            ?? (item as? String).flatMap(URL.init(string:))
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
      self?.sharedURLs = loaded.urls
      self?.sharedText = loaded.text
      self?.isLoadingSharedContent = false
      Self.logger.notice(
        "share_content_loaded provider_count=\(providers.count, privacy: .public) url_representations=\(urlProviders.count, privacy: .public) text_representations=\(textProviders.count, privacy: .public) loaded_urls=\(loaded.urls.count, privacy: .public) loaded_text=\(loaded.text.count, privacy: .public)"
      )
      self?.validateContent()
    }
  }

  private func savedCountMessage(saved: Int, total: Int) -> String {
    guard saved > 0 else { return "" }
    return "\(saved) of \(total) links were saved."
  }

  private func validationAlert(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Couldn’t Save Bookmark"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.runModal()
  }
}
