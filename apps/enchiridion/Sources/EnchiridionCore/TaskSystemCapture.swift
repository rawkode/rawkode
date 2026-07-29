import Foundation

public enum TaskSystemCapture {
  public static let maximumTitleCharacters = 160
  public static let maximumNotesCharacters = 20_000
  public static let maximumURLCount = 12

  /// Converts text and URLs supplied by system surfaces into a conservative
  /// Inbox task. The caller remains responsible for explicit confirmation.
  public static func draft(
    text: String?,
    urls: [URL] = []
  ) -> TaskDraft? {
    let normalizedText = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let acceptedURLs = Array(urls.prefix(maximumURLCount))
    guard !normalizedText.isEmpty || !acceptedURLs.isEmpty else { return nil }

    let firstLine = normalizedText.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    let fallbackTitle = acceptedURLs.first.flatMap { url in
      url.host(percentEncoded: false).flatMap { $0.isEmpty ? nil : $0 }
    } ?? acceptedURLs.first?.absoluteString ?? "Shared item"
    let sourceTitle = firstLine.isEmpty ? fallbackTitle : firstLine
    let title = String(sourceTitle.prefix(maximumTitleCharacters))

    var noteParts: [String] = []
    if !normalizedText.isEmpty,
      normalizedText != title || normalizedText.count > maximumTitleCharacters
    {
      noteParts.append(normalizedText)
    }
    let urlText = acceptedURLs.map(\.absoluteString).filter { value in
      !normalizedText.contains(value)
    }
    if !urlText.isEmpty { noteParts.append(urlText.joined(separator: "\n")) }

    return TaskDraft(
      title: title,
      notes: String(noteParts.joined(separator: "\n\n").prefix(maximumNotesCharacters)),
      data: TaskData(placement: .inbox)
    )
  }
}
