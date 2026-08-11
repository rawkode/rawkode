// ShareViewController.swift
// Enchiridion2MacShareExtension
//
// P6 "Share extensions" task — macOS half. See
// `Sources/iOSShareExtension/ShareViewController.swift`'s header for the
// full rationale (identical shape, AppKit instead of UIKit). `extensionContext`
// comes for free from `NSViewController`'s own `NSExtensionRequestHandling`
// conformance — no extra protocol adoption needed, no XIB/storyboard
// required since this view is built entirely in code.

import AppKit
import EnchiridionShareKit

final class ShareViewController: NSViewController {
  private let titleLabel = NSTextField(labelWithString: "Save to Enchiridion")
  private let bodyTextView = NSTextView()
  private let statusLabel = NSTextField(labelWithString: "")
  private let saveButton = NSButton(title: "Save", target: nil, action: nil)
  private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)

  private var parsedURL: URL?
  private var parsedPageTitle: String?
  private var isSaving = false

  override func loadView() {
    view = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 320))
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    configureLayout()
    Task { await loadSharedContent() }
  }

  private func configureLayout() {
    titleLabel.font = .boldSystemFont(ofSize: NSFont.systemFontSize)

    let scrollView = NSScrollView()
    scrollView.hasVerticalScroller = true
    scrollView.borderType = .bezelBorder
    bodyTextView.isEditable = true
    bodyTextView.isSelectable = true
    bodyTextView.string = "Loading…"
    bodyTextView.isAutomaticQuoteSubstitutionEnabled = false
    scrollView.documentView = bodyTextView

    statusLabel.textColor = .secondaryLabelColor
    statusLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)

    saveButton.target = self
    saveButton.action = #selector(saveTapped)
    saveButton.keyEquivalent = "\r"
    cancelButton.target = self
    cancelButton.action = #selector(cancelTapped)
    cancelButton.keyEquivalent = "\u{1b}"

    let buttonRow = NSStackView(views: [cancelButton, saveButton])
    buttonRow.orientation = .horizontal
    buttonRow.spacing = 12

    let stack = NSStackView(views: [titleLabel, scrollView, statusLabel, buttonRow])
    stack.orientation = .vertical
    stack.spacing = 12
    stack.alignment = .leading
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)

    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
      scrollView.widthAnchor.constraint(equalTo: stack.widthAnchor),
      scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 180),
      buttonRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
    ])
  }

  private func attachments() -> [NSItemProvider] {
    (extensionContext?.inputItems as? [NSExtensionItem])?.flatMap { $0.attachments ?? [] } ?? []
  }

  /// See the iOS counterpart's identical method for why both
  /// `attributedTitle`/`attributedContentText` are checked, in that order.
  private func extensionItemPageTitle() -> String? {
    guard let items = extensionContext?.inputItems as? [NSExtensionItem] else { return nil }
    for item in items {
      if let title = item.attributedTitle?.string, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return title
      }
    }
    for item in items {
      if let text = item.attributedContentText?.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return text
      }
    }
    return nil
  }

  private func loadSharedContent() async {
    let input = await ShareExtensionContextParsing.input(
      from: attachments(), pageTitle: extensionItemPageTitle())
    parsedURL = input.url
    parsedPageTitle = input.pageTitle
    bodyTextView.string = ShareCaptureBody.body(for: input)
  }

  @objc private func saveTapped() {
    guard !isSaving else { return }
    isSaving = true
    saveButton.isEnabled = false
    statusLabel.stringValue = "Saving…"

    let editedText = bodyTextView.string
    let input = ShareCaptureInput(
      text: editedText.isEmpty ? nil : editedText, url: parsedURL, pageTitle: parsedPageTitle)

    Task {
      do {
        _ = try await ShareCapture.captureIntoAppGroupStore(input)
        await MainActor.run {
          self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        }
      } catch {
        await MainActor.run {
          self.isSaving = false
          self.saveButton.isEnabled = true
          self.statusLabel.stringValue = "Couldn’t save: \(error.localizedDescription)"
        }
      }
    }
  }

  @objc private func cancelTapped() {
    extensionContext?.cancelRequest(
      withError: NSError(domain: "dev.rawkode.enchiridion2.share", code: 1, userInfo: nil))
  }
}
