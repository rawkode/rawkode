import Foundation
import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A Browse-only TextKit projection for semantic references.
///
/// SwiftUI owns the immutable render plan and navigation state. TextKit only
/// renders that plan, supplies the inline symbol attachment, and exposes each
/// semantic reference as its own accessible link. The attachment is omitted
/// from the accessibility tree, so it remains decorative.
@available(iOS 26.0, macOS 26.0, *)
struct SemanticBrowseText: View {
  let plan: PageReferenceBrowseRenderPlan
  let onOpenURL: (URL) -> Void
  private let palette: PageReferencePalette?

  @Environment(\.colorSchemeContrast) private var colorSchemeContrast
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  init(
    plan: PageReferenceBrowseRenderPlan,
    palette: PageReferencePalette? = nil,
    onOpenURL: @escaping (URL) -> Void
  ) {
    self.plan = plan
    self.palette = palette
    self.onOpenURL = onOpenURL
  }

  var body: some View {
    PlatformSemanticBrowseText(
      plan: plan,
      palette: palette ?? .init(contrast: colorSchemeContrast),
      dynamicTypeSize: dynamicTypeSize,
      onOpenURL: onOpenURL
    )
  }
}

@available(iOS 26.0, macOS 26.0, *)
enum PageReferenceBrowseLinkRouter {
  @discardableResult
  static func route(_ candidate: Any, onOpenURL: (URL) -> Void) -> Bool {
    guard let url = candidate as? URL,
      PageReferenceBrowseLink.destination(from: url) != nil
    else { return false }
    onOpenURL(url)
    return true
  }
}

@available(iOS 26.0, macOS 26.0, *)
struct PageReferenceBrowseAccessibilityMetadata: Hashable {
  let location: Int
  let length: Int
  let label: String
  let url: URL?

  var range: NSRange { NSRange(location: location, length: length) }
  var isLink: Bool { url != nil }
}

#if canImport(UIKit)
@available(iOS 26.0, *)
struct PlatformSemanticBrowseText: UIViewRepresentable {
  let plan: PageReferenceBrowseRenderPlan
  let palette: PageReferencePalette
  let dynamicTypeSize: DynamicTypeSize
  let onOpenURL: (URL) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onOpenURL: onOpenURL) }

  func makeUIView(context: Context) -> SemanticBrowseTextView {
    let textView = SemanticBrowseTextView()
    textView.backgroundColor = .clear
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.dataDetectorTypes = []
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.adjustsFontForContentSizeCategory = true
    textView.isAccessibilityElement = false
    textView.delegate = context.coordinator
    return textView
  }

  func updateUIView(_ textView: SemanticBrowseTextView, context: Context) {
    // Keeping this dependency explicit causes SwiftUI to rebuild native fonts
    // when the user changes Dynamic Type.
    _ = dynamicTypeSize
    context.coordinator.onOpenURL = onOpenURL
    let layout = PageReferenceBrowseNativeText.makeLayout(from: plan, palette: palette)
    textView.apply(layout: layout, palette: palette, onOpenURL: onOpenURL)
  }

  func sizeThatFits(
    _ proposal: ProposedViewSize,
    uiView: SemanticBrowseTextView,
    context: Context
  ) -> CGSize? {
    let width = proposal.width ?? uiView.bounds.width
    guard width > 0 else { return nil }
    return uiView.sizeThatFits(.init(width: width, height: .greatestFiniteMagnitude))
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    var onOpenURL: (URL) -> Void

    init(onOpenURL: @escaping (URL) -> Void) {
      self.onOpenURL = onOpenURL
    }

    func textView(
      _ textView: UITextView,
      primaryActionFor textItem: UITextItem,
      defaultAction: UIAction
    ) -> UIAction? {
      guard case .link(let url) = textItem.content,
        PageReferenceBrowseLink.destination(from: url) != nil
      else { return nil }
      return UIAction { [weak self] _ in
        guard let self else { return }
        _ = PageReferenceBrowseLinkRouter.route(url, onOpenURL: self.onOpenURL)
      }
    }
  }
}

@available(iOS 26.0, *)
final class SemanticBrowseTextView: UITextView {
  private var metadata: [PageReferenceBrowseAccessibilityMetadata] = []
  private var semanticElements: [Any] = []
  private var onOpenURL: (URL) -> Void = { _ in }

  override var accessibilityElements: [Any]? {
    get { semanticElements }
    set { semanticElements = newValue ?? [] }
  }

  func apply(
    layout: PageReferenceBrowseNativeLayout,
    palette: PageReferencePalette,
    onOpenURL: @escaping (URL) -> Void
  ) {
    self.onOpenURL = onOpenURL
    font = UIFont.preferredFont(forTextStyle: .body)
    textColor = .label
    linkTextAttributes = PageReferenceBrowseNativeText.linkAttributes(for: palette)
    if !attributedText.isEqual(to: layout.attributedText) {
      attributedText = layout.attributedText
    }
    metadata = layout.accessibilityMetadata
    // The callback can change even when the text does not. Rebuild so each
    // accessibility link activates the current Browse destination.
    rebuildAccessibilityElements()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    rebuildAccessibilityElements()
  }

  private func rebuildAccessibilityElements() {
    semanticElements = metadata.compactMap { metadata in
      guard let frame = accessibilityFrame(for: metadata.range) else { return nil }
      let element = SemanticBrowseAccessibilityElement(
        accessibilityContainer: self,
        url: metadata.url,
        onOpenURL: onOpenURL
      )
      element.accessibilityLabel = metadata.label
      element.accessibilityTraits = metadata.isLink ? .link : .staticText
      element.accessibilityFrameInContainerSpace = frame
      return element
    }
  }

  private func accessibilityFrame(for range: NSRange) -> CGRect? {
    guard range.length > 0,
      let start = position(from: beginningOfDocument, offset: range.location),
      let end = position(from: beginningOfDocument, offset: NSMaxRange(range)),
      let textRange = textRange(from: start, to: end)
    else { return nil }

    let frames = selectionRects(for: textRange).map(\.rect).filter { !$0.isNull && !$0.isEmpty }
    guard let first = frames.first else { return nil }
    return frames.dropFirst().reduce(first) { $0.union($1) }
  }
}

@available(iOS 26.0, *)
private final class SemanticBrowseAccessibilityElement: UIAccessibilityElement {
  private let url: URL?
  private let onOpenURL: (URL) -> Void

  init(
    accessibilityContainer: Any,
    url: URL?,
    onOpenURL: @escaping (URL) -> Void
  ) {
    self.url = url
    self.onOpenURL = onOpenURL
    super.init(accessibilityContainer: accessibilityContainer)
  }

  override func accessibilityActivate() -> Bool {
    guard let url else { return false }
    return PageReferenceBrowseLinkRouter.route(url, onOpenURL: onOpenURL)
  }
}

@available(iOS 26.0, *)
struct PageReferenceBrowseNativeLayout {
  let attributedText: NSAttributedString
  let accessibilityMetadata: [PageReferenceBrowseAccessibilityMetadata]
}

@available(iOS 26.0, *)
enum PageReferenceBrowseNativeText {
  static func make(from plan: PageReferenceBrowseRenderPlan, palette: PageReferencePalette) -> NSAttributedString {
    makeLayout(from: plan, palette: palette).attributedText
  }

  static func makeLayout(
    from plan: PageReferenceBrowseRenderPlan,
    palette: PageReferencePalette
  ) -> PageReferenceBrowseNativeLayout {
    let typography = Typography(palette: palette)
    let result = NSMutableAttributedString()
    var accessibilityMetadata: [PageReferenceBrowseAccessibilityMetadata] = []

    for segment in plan.segments {
      switch segment {
      case .text(let source):
        let text = typography.makeText(from: source)
        let location = result.length
        result.append(text)
        appendAccessibilityMetadata(
          label: text.string,
          location: location,
          length: text.length,
          url: nil,
          into: &accessibilityMetadata
        )
      case .reference(let reference):
        appendAttachment(for: reference.presentation, typography: typography, to: result)
        let label = typography.makeLabel(for: reference)
        let location = result.length
        result.append(label)
        appendAccessibilityMetadata(
          label: reference.presentation.accessibilityLabel,
          location: location,
          length: label.length,
          url: reference.presentation.url,
          into: &accessibilityMetadata
        )
      }
    }

    return .init(attributedText: result, accessibilityMetadata: accessibilityMetadata)
  }

  static func linkAttributes(for palette: PageReferencePalette) -> [NSAttributedString.Key: Any] {
    let color = UIColor(palette.foregroundColor)
    return [
      .foregroundColor: color,
      .underlineColor: color,
      .underlineStyle: NSUnderlineStyle.single.rawValue,
    ]
  }

  private static func appendAttachment(
    for presentation: PageReferenceBrowsePresentation,
    typography: Typography,
    to result: NSMutableAttributedString
  ) {
    guard let symbolName = presentation.symbolName,
      let image = UIImage(systemName: symbolName)
    else { return }

    let attachment = NSTextAttachment(image: image)
    attachment.bounds = .init(
      x: 0,
      y: typography.symbolBaselineOffset,
      width: typography.symbolSize,
      height: typography.symbolSize
    )
    result.append(NSAttributedString(attachment: attachment))
    result.append(NSAttributedString(string: " ", attributes: [.font: typography.bodyFont]))
  }

  private static func appendAccessibilityMetadata(
    label: String,
    location: Int,
    length: Int,
    url: URL?,
    into metadata: inout [PageReferenceBrowseAccessibilityMetadata]
  ) {
    guard length > 0, !label.isEmpty else { return }
    metadata.append(.init(location: location, length: length, label: label, url: url))
  }

  private struct Typography {
    let palette: PageReferencePalette
    let bodyFont: UIFont

    init(palette: PageReferencePalette) {
      self.palette = palette
      bodyFont = UIFont.preferredFont(forTextStyle: .body)
    }

    var symbolSize: CGFloat { ceil(bodyFont.pointSize) }
    var symbolBaselineOffset: CGFloat { floor((bodyFont.descender + bodyFont.capHeight - symbolSize) / 2) }

    func makeText(from source: AttributedString) -> NSMutableAttributedString {
      makeText(from: source, inheritedIntent: nil, inheritedColor: nil)
    }

    func makeLabel(for reference: PageReferenceBrowseReference) -> NSMutableAttributedString {
      let sourceLabel = String(reference.source.characters)
      let label: NSMutableAttributedString
      if sourceLabel == reference.presentation.label {
        label = makeText(from: reference.source)
      } else if let range = reference.source.runs.first?.range {
        let firstRun = reference.source[range]
        label = makeText(
          from: AttributedString(reference.presentation.label),
          inheritedIntent: firstRun.inlinePresentationIntent,
          inheritedColor: firstRun.foregroundColor
        )
      } else {
        label = makeText(from: AttributedString(reference.presentation.label))
      }

      guard let url = reference.presentation.url else { return label }
      var attributes = PageReferenceBrowseNativeText.linkAttributes(for: palette)
      attributes[.link] = url
      if let typeName = reference.presentation.typeName {
        attributes[.accessibilityTextCustom] = [typeName]
      }
      label.addAttributes(attributes, range: NSRange(location: 0, length: label.length))
      return label
    }

    private func makeText(
      from source: AttributedString,
      inheritedIntent: InlinePresentationIntent?,
      inheritedColor: Color?
    ) -> NSMutableAttributedString {
      let result = NSMutableAttributedString()
      for run in source.runs {
        let text = AttributedString(source[run.range])
        let native = NSMutableAttributedString(attributedString: NSAttributedString(text))
        native.addAttributes(
          attributes(
            intent: inheritedIntent ?? run.inlinePresentationIntent,
            color: inheritedColor ?? run.foregroundColor
          ),
          range: NSRange(location: 0, length: native.length)
        )
        result.append(native)
      }
      return result
    }

    private func attributes(
      intent: InlinePresentationIntent?,
      color: Color?
    ) -> [NSAttributedString.Key: Any] {
      var attributes: [NSAttributedString.Key: Any] = [
        .font: font(for: intent),
        .foregroundColor: color.map(UIColor.init) ?? UIColor.label,
      ]
      if intent?.contains(.strikethrough) == true {
        attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
      }
      return attributes
    }

    private func font(for intent: InlinePresentationIntent?) -> UIFont {
      var font = intent?.contains(.code) == true
        ? UIFont.monospacedSystemFont(ofSize: bodyFont.pointSize, weight: .regular)
        : bodyFont
      var traits = font.fontDescriptor.symbolicTraits
      if intent?.contains(.stronglyEmphasized) == true { traits.insert(.traitBold) }
      if intent?.contains(.emphasized) == true { traits.insert(.traitItalic) }
      if let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
        font = UIFont(descriptor: descriptor, size: 0)
      }
      return font
    }
  }
}
#elseif canImport(AppKit)
@available(macOS 26.0, *)
struct PlatformSemanticBrowseText: NSViewRepresentable {
  let plan: PageReferenceBrowseRenderPlan
  let palette: PageReferencePalette
  let dynamicTypeSize: DynamicTypeSize
  let onOpenURL: (URL) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onOpenURL: onOpenURL) }

  func makeNSView(context: Context) -> SemanticBrowseTextView {
    let textView = SemanticBrowseTextView()
    textView.isEditable = false
    textView.isSelectable = true
    textView.isRichText = true
    textView.isAutomaticLinkDetectionEnabled = false
    textView.drawsBackground = false
    textView.textContainerInset = .zero
    textView.textContainer?.lineFragmentPadding = 0
    textView.textContainer?.widthTracksTextView = true
    textView.setAccessibilityElement(false)
    textView.delegate = context.coordinator
    return textView
  }

  func updateNSView(_ textView: SemanticBrowseTextView, context: Context) {
    _ = dynamicTypeSize
    context.coordinator.onOpenURL = onOpenURL
    let layout = PageReferenceBrowseNativeText.makeLayout(from: plan, palette: palette)
    textView.apply(layout: layout, palette: palette, onOpenURL: onOpenURL)
  }

  final class Coordinator: NSObject, NSTextViewDelegate {
    var onOpenURL: (URL) -> Void

    init(onOpenURL: @escaping (URL) -> Void) {
      self.onOpenURL = onOpenURL
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
      PageReferenceBrowseLinkRouter.route(link, onOpenURL: onOpenURL)
    }
  }
}

@available(macOS 26.0, *)
final class SemanticBrowseTextView: NSTextView {
  private var metadata: [PageReferenceBrowseAccessibilityMetadata] = []
  private var semanticChildren: [Any] = []
  private var onOpenURL: (URL) -> Void = { _ in }

  override func isAccessibilityElement() -> Bool { false }
  override func accessibilityChildren() -> [Any]? { semanticChildren }

  func apply(
    layout: PageReferenceBrowseNativeLayout,
    palette: PageReferencePalette,
    onOpenURL: @escaping (URL) -> Void
  ) {
    self.onOpenURL = onOpenURL
    font = NSFont.preferredFont(forTextStyle: .body)
    textColor = .labelColor
    linkTextAttributes = PageReferenceBrowseNativeText.linkAttributes(for: palette)
    if !attributedString().isEqual(to: layout.attributedText) {
      textStorage?.setAttributedString(layout.attributedText)
    }
    metadata = layout.accessibilityMetadata
    // The callback can change even when the text does not. Rebuild so each
    // accessibility link activates the current Browse destination.
    rebuildAccessibilityChildren()
  }

  override func layout() {
    super.layout()
    rebuildAccessibilityChildren()
  }

  private func rebuildAccessibilityChildren() {
    semanticChildren = metadata.compactMap { metadata in
      guard let frame = accessibilityFrame(for: metadata.range) else { return nil }
      let element = SemanticBrowseAccessibilityElement(
        parent: self,
        url: metadata.url,
        onOpenURL: onOpenURL
      )
      element.setAccessibilityLabel(metadata.label)
      element.setAccessibilityRole(metadata.isLink ? .link : .staticText)
      element.setAccessibilityFrameInParentSpace(frame)
      if let url = metadata.url { element.setAccessibilityURL(url) }
      return element
    }
  }

  private func accessibilityFrame(for range: NSRange) -> NSRect? {
    guard range.length > 0,
      let layoutManager,
      let textContainer
    else { return nil }
    let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
    guard glyphRange.length > 0 else { return nil }
    let rect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
    guard !rect.isEmpty else { return nil }
    return rect.offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
  }
}

@available(macOS 26.0, *)
private final class SemanticBrowseAccessibilityElement: NSAccessibilityElement {
  private let url: URL?
  private let onOpenURL: (URL) -> Void

  init(parent: Any, url: URL?, onOpenURL: @escaping (URL) -> Void) {
    self.url = url
    self.onOpenURL = onOpenURL
    super.init()
    setAccessibilityParent(parent)
  }

  override func accessibilityPerformPress() -> Bool {
    guard let url else { return false }
    return PageReferenceBrowseLinkRouter.route(url, onOpenURL: onOpenURL)
  }
}

@available(macOS 26.0, *)
struct PageReferenceBrowseNativeLayout {
  let attributedText: NSAttributedString
  let accessibilityMetadata: [PageReferenceBrowseAccessibilityMetadata]
}

@available(macOS 26.0, *)
enum PageReferenceBrowseNativeText {
  static func make(from plan: PageReferenceBrowseRenderPlan, palette: PageReferencePalette) -> NSAttributedString {
    makeLayout(from: plan, palette: palette).attributedText
  }

  static func makeLayout(
    from plan: PageReferenceBrowseRenderPlan,
    palette: PageReferencePalette
  ) -> PageReferenceBrowseNativeLayout {
    let typography = Typography(palette: palette)
    let result = NSMutableAttributedString()
    var accessibilityMetadata: [PageReferenceBrowseAccessibilityMetadata] = []

    for segment in plan.segments {
      switch segment {
      case .text(let source):
        let text = typography.makeText(from: source)
        let location = result.length
        result.append(text)
        appendAccessibilityMetadata(
          label: text.string,
          location: location,
          length: text.length,
          url: nil,
          into: &accessibilityMetadata
        )
      case .reference(let reference):
        appendAttachment(for: reference.presentation, typography: typography, to: result)
        let label = typography.makeLabel(for: reference)
        let location = result.length
        result.append(label)
        appendAccessibilityMetadata(
          label: reference.presentation.accessibilityLabel,
          location: location,
          length: label.length,
          url: reference.presentation.url,
          into: &accessibilityMetadata
        )
      }
    }

    return .init(attributedText: result, accessibilityMetadata: accessibilityMetadata)
  }

  static func linkAttributes(for palette: PageReferencePalette) -> [NSAttributedString.Key: Any] {
    let color = NSColor(palette.foregroundColor)
    return [
      .foregroundColor: color,
      .underlineColor: color,
      .underlineStyle: NSUnderlineStyle.single.rawValue,
    ]
  }

  private static func appendAttachment(
    for presentation: PageReferenceBrowsePresentation,
    typography: Typography,
    to result: NSMutableAttributedString
  ) {
    guard let symbolName = presentation.symbolName,
      let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
    else { return }

    let attachment = NSTextAttachment()
    attachment.image = image
    attachment.bounds = .init(
      x: 0,
      y: typography.symbolBaselineOffset,
      width: typography.symbolSize,
      height: typography.symbolSize
    )
    result.append(NSAttributedString(attachment: attachment))
    result.append(NSAttributedString(string: " ", attributes: [.font: typography.bodyFont]))
  }

  private static func appendAccessibilityMetadata(
    label: String,
    location: Int,
    length: Int,
    url: URL?,
    into metadata: inout [PageReferenceBrowseAccessibilityMetadata]
  ) {
    guard length > 0, !label.isEmpty else { return }
    metadata.append(.init(location: location, length: length, label: label, url: url))
  }

  private struct Typography {
    let palette: PageReferencePalette
    let bodyFont: NSFont

    init(palette: PageReferencePalette) {
      self.palette = palette
      bodyFont = NSFont.preferredFont(forTextStyle: .body)
    }

    var symbolSize: CGFloat { ceil(bodyFont.pointSize) }
    var symbolBaselineOffset: CGFloat { floor((bodyFont.descender + bodyFont.capHeight - symbolSize) / 2) }

    func makeText(from source: AttributedString) -> NSMutableAttributedString {
      makeText(from: source, inheritedIntent: nil, inheritedColor: nil)
    }

    func makeLabel(for reference: PageReferenceBrowseReference) -> NSMutableAttributedString {
      let sourceLabel = String(reference.source.characters)
      let label: NSMutableAttributedString
      if sourceLabel == reference.presentation.label {
        label = makeText(from: reference.source)
      } else if let range = reference.source.runs.first?.range {
        let firstRun = reference.source[range]
        label = makeText(
          from: AttributedString(reference.presentation.label),
          inheritedIntent: firstRun.inlinePresentationIntent,
          inheritedColor: firstRun.foregroundColor
        )
      } else {
        label = makeText(from: AttributedString(reference.presentation.label))
      }

      guard let url = reference.presentation.url else { return label }
      var attributes = PageReferenceBrowseNativeText.linkAttributes(for: palette)
      attributes[.link] = url
      attributes[.accessibilityLink] = url
      label.addAttributes(attributes, range: NSRange(location: 0, length: label.length))
      return label
    }

    private func makeText(
      from source: AttributedString,
      inheritedIntent: InlinePresentationIntent?,
      inheritedColor: Color?
    ) -> NSMutableAttributedString {
      let result = NSMutableAttributedString()
      for run in source.runs {
        let text = AttributedString(source[run.range])
        let native = NSMutableAttributedString(attributedString: NSAttributedString(text))
        native.addAttributes(
          attributes(
            intent: inheritedIntent ?? run.inlinePresentationIntent,
            color: inheritedColor ?? run.foregroundColor
          ),
          range: NSRange(location: 0, length: native.length)
        )
        result.append(native)
      }
      return result
    }

    private func attributes(
      intent: InlinePresentationIntent?,
      color: Color?
    ) -> [NSAttributedString.Key: Any] {
      var attributes: [NSAttributedString.Key: Any] = [
        .font: font(for: intent),
        .foregroundColor: color.map(NSColor.init) ?? NSColor.labelColor,
      ]
      if intent?.contains(.strikethrough) == true {
        attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
      }
      return attributes
    }

    private func font(for intent: InlinePresentationIntent?) -> NSFont {
      var font = intent?.contains(.code) == true
        ? NSFont.monospacedSystemFont(ofSize: bodyFont.pointSize, weight: .regular)
        : bodyFont
      var traits = font.fontDescriptor.symbolicTraits
      if intent?.contains(.stronglyEmphasized) == true { traits.insert(.bold) }
      if intent?.contains(.emphasized) == true { traits.insert(.italic) }
      let descriptor = font.fontDescriptor.withSymbolicTraits(traits)
      font = NSFont(descriptor: descriptor, size: 0) ?? font
      return font
    }
  }
}
#endif
