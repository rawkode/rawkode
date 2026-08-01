import Foundation
import EnchiridionCore
import SwiftUI

@available(iOS 26.0, macOS 26.0, *)
struct PageReferenceBrowseSupertag: Hashable, Sendable {
  let id: SupertagID
  let name: String
  let symbolName: String
  let isBuiltIn: Bool

  init(id: SupertagID, name: String, symbolName: String, isBuiltIn: Bool) {
    self.id = id
    self.name = name
    self.symbolName = symbolName
    self.isBuiltIn = isBuiltIn
  }
}

@available(iOS 26.0, macOS 26.0, *)
struct PageReferenceBrowseLiveTarget: Hashable, Sendable {
  let pageID: PageID
  let displayTitle: String?
  let supertags: [PageReferenceBrowseSupertag]

  init(
    pageID: PageID,
    displayTitle: String?,
    supertags: [PageReferenceBrowseSupertag]
  ) {
    self.pageID = pageID
    self.displayTitle = displayTitle
    self.supertags = supertags
  }
}

@available(iOS 26.0, macOS 26.0, *)
struct PageReferenceBrowsePresentation: Hashable, Sendable {
  let pageID: PageID
  let label: String
  let fallbackLabel: String
  let typeName: String?
  let symbolName: String?
  let url: URL?

  var accessibilityLabel: String {
    guard let typeName else { return label }
    return "\(typeName), \(label)"
  }
}

@available(iOS 26.0, macOS 26.0, *)
struct PageReferenceBrowseReference: Hashable {
  let presentation: PageReferenceBrowsePresentation
  let source: AttributedString
}

@available(iOS 26.0, macOS 26.0, *)
struct PageReferenceBrowseRenderPlan: Hashable {
  enum Segment: Hashable {
    case text(AttributedString)
    case reference(PageReferenceBrowseReference)
  }

  let segments: [Segment]

  static func resolve(
    from body: AttributedString,
    vaultID: VaultID,
    liveTarget: (PageID) -> PageReferenceBrowseLiveTarget?
  ) -> Self {
    var cleaned = body
    let ranges = cleaned.runs.map(\.range)

    // Browse can only open the vault-scoped URLs created below. Imported,
    // stale, and automatic data-detector links are never allowed through this
    // projection.
    for range in ranges {
      cleaned[range].link = nil
    }

    var segments: [Segment] = []
    var ordinary = AttributedString()
    var reference: (destination: PageReferenceDestination, source: AttributedString)?

    func appendOrdinary() {
      guard !ordinary.characters.isEmpty else { return }
      segments.append(.text(ordinary))
      ordinary = AttributedString()
    }

    func appendReference() {
      guard let pendingReference = reference else { return }
      let fallback = nonEmpty(pendingReference.destination.label) ?? String(pendingReference.source.characters)
      let target = liveTarget(pendingReference.destination.pageID)
      let presentation: PageReferenceBrowsePresentation
      if let target, target.pageID == pendingReference.destination.pageID {
        let primary = primaryPresentationSupertag(in: target.supertags)
        presentation = .init(
          pageID: pendingReference.destination.pageID,
          label: nonEmpty(target.displayTitle) ?? fallback,
          fallbackLabel: fallback,
          typeName: primary?.name,
          symbolName: primary?.symbolName,
          url: PageReferenceBrowseLink.url(
            for: .init(vaultID: vaultID, pageID: pendingReference.destination.pageID)
          )
        )
      } else {
        presentation = .init(
          pageID: pendingReference.destination.pageID,
          label: fallback,
          fallbackLabel: fallback,
          typeName: nil,
          symbolName: nil,
          url: nil
        )
      }
      segments.append(.reference(.init(presentation: presentation, source: pendingReference.source)))
      reference = nil
    }

    for range in ranges {
      let source = AttributedString(cleaned[range])
      guard let destination = semanticDestination(in: cleaned[range]) else {
        appendReference()
        ordinary += source
        continue
      }

      appendOrdinary()
      if reference?.destination == destination {
        reference?.source += source
      } else {
        appendReference()
        reference = (destination, source)
      }
    }

    appendReference()
    appendOrdinary()

    return .init(segments: segments)
  }

  func attributedString(palette: PageReferencePalette) -> AttributedString {
    segments.reduce(into: AttributedString()) { projection, segment in
      switch segment {
      case .text(let text):
        projection += text
      case .reference(let reference):
        var text = AttributedString(reference.presentation.label)
        guard let url = reference.presentation.url else {
          projection += text
          return
        }
        text.link = url
        text.foregroundColor = palette.foregroundColor
        text.underlineStyle = .single
        projection += text
      }
    }
  }

  static func primaryPresentationSupertag(
    in supertags: [PageReferenceBrowseSupertag]
  ) -> PageReferenceBrowseSupertag? {
    let builtInPriority: [SupertagID] = [
      .init(rawValue: "person"),
      .init(rawValue: "task"),
      .init(rawValue: "project"),
      .init(rawValue: "event"),
      .init(rawValue: "company"),
      .init(rawValue: "organization"),
      .init(rawValue: "area"),
      .init(rawValue: "place"),
    ]
    for id in builtInPriority {
      if let match = supertags.first(where: { $0.isBuiltIn && $0.id == id }) {
        return match
      }
    }
    return supertags
      .filter { !$0.isBuiltIn }
      .sorted { $0.id.rawValue < $1.id.rawValue }
      .first
  }

  private static func semanticDestination(
    in text: AttributedSubstring
  ) -> PageReferenceDestination? {
    let destinations = (text[PageRichTextAttributes.AutomergeMarks.self] ?? [])
      .compactMap(PageDocument.pageReferenceDestination(from:))
    guard destinations.count == 1 else { return nil }
    return destinations[0]
  }

  private static func nonEmpty(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
