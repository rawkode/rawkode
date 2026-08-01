import Foundation
import EnchiridionCore
import SwiftUI

@available(iOS 26.0, macOS 26.0, *)
struct PageReferencePalette: Hashable, Sendable {
  let foregroundColor: Color

  init(contrast: ColorSchemeContrast) {
    foregroundColor = Color(
      contrast == .increased
        ? "PageReferenceForegroundHighContrast"
        : "PageReferenceForeground"
    )
  }
}

@available(iOS 26.0, macOS 26.0, *)
struct PageReferenceTextFormattingDefinition: AttributedTextFormattingDefinition {
  struct Scope: AttributeScope {
    let foundation: AttributeScopes.FoundationAttributes
    let foregroundColor: AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
    let underlineStyle: AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute
    let automergeMarks: PageRichTextAttributes.AutomergeMarks
  }

  let palette: PageReferencePalette

  var body: some AttributedTextFormattingDefinition<Scope> {
    ValueConstraint(
      for: \.underlineStyle,
      values: [nil, .single],
      default: nil
    )
    PageReferenceForegroundConstraint(foregroundColor: palette.foregroundColor)
    PageReferenceUnderlineConstraint()
  }
}

@available(iOS 26.0, macOS 26.0, *)
private struct PageReferenceForegroundConstraint: AttributedTextValueConstraint {
  typealias Scope = PageReferenceTextFormattingDefinition.Scope
  typealias AttributeKey = AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute

  let foregroundColor: Color

  func constrain(_ container: inout Attributes) {
    container.foregroundColor = container.automergeMarks?.contains {
      $0.name == PageDocument.pageReferenceMark
    } == true ? foregroundColor : nil
  }
}

@available(iOS 26.0, macOS 26.0, *)
private struct PageReferenceUnderlineConstraint: AttributedTextValueConstraint {
  typealias Scope = PageReferenceTextFormattingDefinition.Scope
  typealias AttributeKey = AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute

  func constrain(_ container: inout Attributes) {
    // TextEditor owns selection and text input. A reference is intentionally
    // not underlined there because it cannot be followed without moving the
    // insertion point. Browse mode adds an underline only to its transient
    // link projection.
    container.underlineStyle = nil
  }
}

@available(iOS 26.0, macOS 26.0, *)
enum PageReferenceBrowseLink {
  struct Destination: Hashable, Sendable {
    let vaultID: VaultID
    let pageID: PageID
  }

  private static let scheme = "enchiridion-reference"
  private static let host = "page"

  static func url(for destination: Destination) -> URL? {
    guard let vault = encoded(destination.vaultID.rawValue),
      let page = encoded(destination.pageID.rawValue)
    else { return nil }

    var components = URLComponents()
    components.scheme = scheme
    components.host = host
    components.queryItems = [
      URLQueryItem(name: "vault", value: vault),
      URLQueryItem(name: "page", value: page),
    ]
    return components.url
  }

  static func destination(from url: URL) -> Destination? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.scheme == scheme,
      components.host == host,
      components.port == nil,
      components.user == nil,
      components.password == nil,
      components.path.isEmpty,
      components.fragment == nil,
      let queryItems = components.queryItems,
      queryItems.count == 2,
      let vault = uniqueValue(named: "vault", in: queryItems).flatMap(decoded),
      let page = uniqueValue(named: "page", in: queryItems).flatMap(decoded),
      isValidIdentifier(vault),
      isValidIdentifier(page)
    else { return nil }

    return Destination(vaultID: VaultID(rawValue: vault), pageID: PageID(rawValue: page))
  }

  private static func encoded(_ value: String) -> String? {
    guard isValidIdentifier(value) else { return nil }
    return Data(value.utf8)
      .base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func decoded(_ value: String) -> String? {
    guard !value.isEmpty,
      value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
    else { return nil }

    let base64 = value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let padded = base64.padding(
      toLength: ((base64.count + 3) / 4) * 4,
      withPad: "=",
      startingAt: 0
    )
    guard let data = Data(base64Encoded: padded), let decoded = String(data: data, encoding: .utf8) else {
      return nil
    }
    return decoded
  }

  private static func uniqueValue(named name: String, in items: [URLQueryItem]) -> String? {
    let values = items.compactMap { $0.name == name ? $0.value : nil }
    guard values.count == 1 else { return nil }
    return values[0]
  }

  private static func isValidIdentifier(_ value: String) -> Bool {
    !value.isEmpty
      && value.utf8.count <= 512
      && value.unicodeScalars.allSatisfy { $0.properties.generalCategory != .control }
  }
}

@available(iOS 26.0, macOS 26.0, *)
enum PageReferenceBrowseProjection {
  static func make(
    from body: AttributedString,
    vaultID: VaultID,
    palette: PageReferencePalette,
    isDestinationLive: (PageID) -> Bool
  ) -> AttributedString {
    PageReferenceBrowseRenderPlan.resolve(
      from: body,
      vaultID: vaultID,
      liveTarget: { pageID in
        isDestinationLive(pageID)
          ? .init(pageID: pageID, displayTitle: nil, supertags: [])
          : nil
      }
    )
    .attributedString(palette: palette)
  }
}
