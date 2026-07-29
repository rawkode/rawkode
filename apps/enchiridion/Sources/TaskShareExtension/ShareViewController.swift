import EnchiridionCore
import Social
import UniformTypeIdentifiers
import UIKit

@objc(ShareViewController)
final class ShareViewController: SLComposeServiceViewController {
  private var sharedText: [String] = []
  private var sharedURLs: [URL] = []

  override func presentationAnimationDidFinish() {
    super.presentationAnimationDidFinish()
    loadSharedContent()
  }

  override func isContentValid() -> Bool {
    TaskSystemCapture.draft(text: combinedText, urls: sharedURLs) != nil
  }

  override func didSelectPost() {
    guard let draft = TaskSystemCapture.draft(text: combinedText, urls: sharedURLs) else {
      validationAlert("Add text or a link before saving.")
      return
    }

    Task { @MainActor in
      do {
        let repository = try LibraryRepository(path: LibraryRepository.defaultLocalPath())
        let page = try await repository.createTask(draft)
        await TaskSystemSpotlight.index(page)
        extensionContext?.completeRequest(returningItems: nil)
      } catch {
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

  private func loadSharedContent() {
    let extensionItems = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
    for provider in extensionItems.flatMap({ $0.attachments ?? [] }) {
      if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
        provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] item, _ in
          let url = item as? URL ?? (item as? String).flatMap(URL.init(string:))
          guard let url else { return }
          DispatchQueue.main.async {
            self?.sharedURLs.append(url)
            self?.validateContent()
          }
        }
      } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
        provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { [weak self] item, _ in
          let text = item as? String ?? (item as? NSAttributedString)?.string
          guard let text else { return }
          DispatchQueue.main.async {
            self?.sharedText.append(text)
            self?.validateContent()
          }
        }
      }
    }
  }

  private func validationAlert(_ message: String) {
    let alert = UIAlertController(title: "Couldn’t Save Task", message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default))
    present(alert, animated: true)
  }
}
