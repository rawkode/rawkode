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
    container.underlineStyle = container.automergeMarks?.contains {
      $0.name == PageDocument.pageReferenceMark
    } == true ? .single : nil
  }
}
