// ShareViewController.swift
// Enchiridion2iOSShareExtension
//
// P6 "Share extensions" task — iOS half. Deliberately thin: all real
// capture logic (title/body derivation, the `PageDocument`/`LocalGraphStore`
// write path, `NSItemProvider` parsing) lives in the shared
// `EnchiridionShareKit` SPM library (Package.swift); this file is only the
// minimal confirm-capture UI itself, matching the task brief ("a text
// field/confirm-capture UI is plenty, no rich editing needed" — PRODUCT.md's
// "literal capture, interpretation later" already covers the rest).
// Identical in spirit to `Sources/macOSShareExtension/ShareViewController.swift`
// — kept as separate per-platform files rather than shared, the same
// pattern this project already established for its thin per-platform
// app-shell and widget-bundle files.
//
// A plain `UIViewController` (not `SLComposeServiceViewController`) —
// deliberate: the Social-framework compose base class is tightly coupled to
// its social-post-composition UI conventions (a "Post" button, a fixed
// character-count row) that don't fit "confirm what will be captured, with
// the body text editable"; a small custom view controller is less code
// than fighting that base class's assumptions. `extensionContext` comes for
// free from `UIViewController`'s own `NSExtensionRequestHandling`
// conformance — no extra protocol adoption needed.

import EnchiridionShareKit
import UIKit

final class ShareViewController: UIViewController {
  private let titleLabel = UILabel()
  private let bodyTextView = UITextView()
  private let statusLabel = UILabel()
  private let saveButton = UIButton(type: .system)
  private let cancelButton = UIButton(type: .system)

  private var parsedURL: URL?
  private var parsedPageTitle: String?
  private var isSaving = false

  override func viewDidLoad() {
    super.viewDidLoad()
    configureLayout()
    Task { await loadSharedContent() }
  }

  private func configureLayout() {
    view.backgroundColor = .systemBackground

    titleLabel.font = .preferredFont(forTextStyle: .headline)
    titleLabel.text = "Save to Enchiridion"
    titleLabel.numberOfLines = 0

    bodyTextView.font = .preferredFont(forTextStyle: .body)
    bodyTextView.layer.borderColor = UIColor.separator.cgColor
    bodyTextView.layer.borderWidth = 1
    bodyTextView.layer.cornerRadius = 8
    bodyTextView.isEditable = true
    bodyTextView.text = "Loading…"
    bodyTextView.isUserInteractionEnabled = false

    statusLabel.font = .preferredFont(forTextStyle: .footnote)
    statusLabel.textColor = .secondaryLabel
    statusLabel.numberOfLines = 0

    saveButton.setTitle("Save", for: .normal)
    saveButton.addTarget(self, action: #selector(saveTapped), for: .touchUpInside)
    cancelButton.setTitle("Cancel", for: .normal)
    cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

    let buttonRow = UIStackView(arrangedSubviews: [cancelButton, saveButton])
    buttonRow.axis = .horizontal
    buttonRow.distribution = .fillEqually
    buttonRow.spacing = 16

    let stack = UIStackView(arrangedSubviews: [titleLabel, bodyTextView, statusLabel, buttonRow])
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)

    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
      bodyTextView.heightAnchor.constraint(greaterThanOrEqualToConstant: 160),
    ])
  }

  private func attachments() -> [NSItemProvider] {
    (extensionContext?.inputItems as? [NSExtensionItem])?.flatMap { $0.attachments ?? [] } ?? []
  }

  /// Host apps that supply a real page/document title (Safari's "Share…"
  /// is the common case) put it on the `NSExtensionItem` itself, not in an
  /// item provider — `attributedTitle` first (the more specific field),
  /// falling back to `attributedContentText` (some hosts only set this
  /// one). Not every host sets either; `nil` here just means
  /// `ShareCaptureBody.title(for:)` falls through to deriving one from
  /// text/URL instead, same as if `pageTitle` had never existed.
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
    bodyTextView.text = ShareCaptureBody.body(for: input)
    bodyTextView.isUserInteractionEnabled = true
  }

  @objc private func saveTapped() {
    guard !isSaving else { return }
    isSaving = true
    saveButton.isEnabled = false
    statusLabel.text = "Saving…"

    let editedText = bodyTextView.text ?? ""
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
          self.statusLabel.text = "Couldn’t save: \(error.localizedDescription)"
        }
      }
    }
  }

  @objc private func cancelTapped() {
    extensionContext?.cancelRequest(
      withError: NSError(domain: "dev.rawkode.enchiridion2.share", code: 1, userInfo: nil))
  }
}
