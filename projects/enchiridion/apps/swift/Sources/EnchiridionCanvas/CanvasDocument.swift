// CanvasDocument.swift
// EnchiridionCanvas
//
// The canvas stroke/shape serialization format — P7 "native drawing
// canvas" task (plan §Core Product UI (P7), track 5). This is the exact
// bytes `CanvasBlobStore` uploads/downloads as a content-addressed blob
// via `EnchiridionBlobs` (see that file's header for the blob-integration
// story) — never stored in supertag properties (`supertags/canvas`'s
// `index.ts` header explains why: wrong shape, potentially large).
//
// FORMAT (JSON, versioned, documented here as the source of truth):
//
//   {
//     "format": "enchiridion/canvas",
//     "schemaVersion": 1,
//     "canvasSize": { "width": 1024, "height": 768 },
//     "elements": [
//       { "type": "stroke", "id": "el_...", "points": [{"x":0,"y":0}, ...], "style": {...} },
//       { "type": "rectangle", "id": "el_...", "origin": {"x":.., "y":..}, "size": {"width":.., "height":..}, "style": {...} },
//       { "type": "ellipse", ... same shape as rectangle ... },
//       { "type": "line", "id": "el_...", "start": {...}, "end": {...}, "style": {...} },
//       { "type": "arrow", ... same shape as line ... },
//       { "type": "text", "id": "el_...", "position": {...}, "content": "...", "fontSize": 17, "color": "#000000ff" }
//     ]
//   }
//
// `style` (`CanvasStrokeStyle`) is `{ "strokeColor": "#rrggbbaa", "fillColor":
// "#rrggbbaa"|null, "lineWidth": <double> }`. Colors are `#rrggbbaa` hex
// strings (`CanvasColor`), not four separate `Double` components — a
// string is compact, human-diffable, and byte-for-byte deterministic
// across encodes (no float-formatting drift between two encoders/platforms
// producing the "same" 0.33333... component differently), which matters
// for this file's own golden round-trip tests
// (`Tests/EnchiridionCanvasTests/CanvasDocumentSerializationTests.swift`)
// and for the "1 MiB per CRDT change" style determinism concerns already
// established elsewhere in this codebase
// (`EnchiridionCore/JSONEncoder.enchiridion`'s `.sortedKeys` for the same
// reason).
//
// `elements` order IS z-order (later elements draw on top) — no separate
// z-index field. `CanvasElementID` gives every element stable identity
// across undo/redo and edits (`CanvasHistory.swift`) independent of its
// position in the array.
//
// v1 SHAPE SET (plan's exact scope boundary — do not add shapes beyond
// this without a scope decision): freehand strokes, rectangle, ellipse,
// line, arrow, text labels. Explicitly no shape-binding (an arrow's
// start/end are plain points, never a reference to another element's id),
// no layers (`elements` is the only ordering/grouping there is), no
// per-element opacity/gradient/dash-pattern styling beyond
// `CanvasStrokeStyle`'s three fields.

import Foundation

// MARK: - Geometry primitives

/// A canvas's logical drawing-surface size in points, independent of any
/// view's current zoom — `CanvasEditorView`'s pan/zoom state is a pure
/// presentation concern (`CanvasViewport.swift`) and never touches this.
public struct CanvasSize: Codable, Hashable, Sendable {
  public var width: Double
  public var height: Double

  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
  }

  /// A reasonable default for a freshly created canvas page — large enough
  /// for a first sketch without immediately needing to pan, small enough
  /// to not look empty on a phone screen.
  public static let defaultSize = CanvasSize(width: 1024, height: 768)
}

public struct CanvasPoint: Codable, Hashable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

// MARK: - Element identity

/// Stable per-element identity, independent of the element's position in
/// `CanvasDocument.elements` (which is z-order, not identity) — needed so
/// `CanvasHistory`'s undo/redo and any future "select and move this
/// element" interaction can address one specific element across edits.
public struct CanvasElementID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public static func random() -> Self {
    .init(rawValue: "el_\(UUID().uuidString.lowercased())")
  }
}

// MARK: - Color

/// A `#rrggbbaa` hex color string — see this file's header for why a
/// string, not four `Double` components.
public struct CanvasColor: RawRepresentable, Codable, Hashable, Sendable {
  public let rawValue: String

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public static let black = CanvasColor(rawValue: "#000000ff")
  public static let white = CanvasColor(rawValue: "#ffffffff")
  public static let red = CanvasColor(rawValue: "#ff3b30ff")
  public static let blue = CanvasColor(rawValue: "#007affff")
  public static let clear = CanvasColor(rawValue: "#00000000")
}

/// The stroke/fill/width a drawn element renders with. Deliberately three
/// fields only — no dash pattern, gradient, or opacity-beyond-alpha
/// (`CanvasColor`'s alpha channel already covers the common "faded
/// highlighter" case) — advanced per-element styling is explicitly out of
/// v1 scope (plan: "advanced styling ... out of scope").
public struct CanvasStrokeStyle: Codable, Hashable, Sendable {
  public var strokeColor: CanvasColor
  public var fillColor: CanvasColor?
  public var lineWidth: Double

  public init(strokeColor: CanvasColor, fillColor: CanvasColor? = nil, lineWidth: Double = 2) {
    self.strokeColor = strokeColor
    self.fillColor = fillColor
    self.lineWidth = lineWidth
  }

  public static let `default` = CanvasStrokeStyle(strokeColor: .black, fillColor: nil, lineWidth: 2)
}

// MARK: - Element payloads

/// A freehand pen stroke — an ordered polyline of points, rendered as a
/// single connected `Path`. `points` is never empty for a committed
/// stroke (a zero/one-point drag never gets committed to the document —
/// see `CanvasEditorView`'s gesture handling), but this type itself
/// doesn't enforce that; it's a capture-time policy, not a serialization
/// invariant.
public struct CanvasStroke: Codable, Hashable, Sendable {
  public var id: CanvasElementID
  public var points: [CanvasPoint]
  public var style: CanvasStrokeStyle

  public init(id: CanvasElementID = .random(), points: [CanvasPoint], style: CanvasStrokeStyle = .default) {
    self.id = id
    self.points = points
    self.style = style
  }
}

/// A rectangle or ellipse — both are an axis-aligned frame (`origin` +
/// `size`); which shape it draws as is `CanvasElement`'s `.rectangle` vs.
/// `.ellipse` case, not a field on this type (mirrors how `.line`/`.arrow`
/// share `CanvasLineSegment` below).
public struct CanvasShape: Codable, Hashable, Sendable {
  public var id: CanvasElementID
  public var origin: CanvasPoint
  public var size: CanvasSize
  public var style: CanvasStrokeStyle

  public init(
    id: CanvasElementID = .random(), origin: CanvasPoint, size: CanvasSize,
    style: CanvasStrokeStyle = .default
  ) {
    self.id = id
    self.origin = origin
    self.size = size
    self.style = style
  }
}

/// A straight line or arrow — both are a `start`/`end` point pair; which
/// one it draws as (a plain line vs. one with an arrowhead at `end`) is
/// `CanvasElement`'s `.line` vs. `.arrow` case. Deliberately NOT
/// shape-binding (`start`/`end` are plain points, never another element's
/// `CanvasElementID`) — plan's explicit v1 out-of-scope list: "shape-
/// binding arrows".
public struct CanvasLineSegment: Codable, Hashable, Sendable {
  public var id: CanvasElementID
  public var start: CanvasPoint
  public var end: CanvasPoint
  public var style: CanvasStrokeStyle

  public init(
    id: CanvasElementID = .random(), start: CanvasPoint, end: CanvasPoint,
    style: CanvasStrokeStyle = .default
  ) {
    self.id = id
    self.start = start
    self.end = end
    self.style = style
  }
}

/// A plain text label anchored at `position` (its top-left corner).
public struct CanvasText: Codable, Hashable, Sendable {
  public var id: CanvasElementID
  public var position: CanvasPoint
  public var content: String
  public var fontSize: Double
  public var color: CanvasColor

  public init(
    id: CanvasElementID = .random(), position: CanvasPoint, content: String, fontSize: Double = 17,
    color: CanvasColor = .black
  ) {
    self.id = id
    self.position = position
    self.content = content
    self.fontSize = fontSize
    self.color = color
  }
}

// MARK: - CanvasElement (the discriminated union)

/// One drawn element. A hand-written `Codable` conformance (below) so the
/// wire format is a flat, tagged-union JSON object (`{"type": "stroke",
/// ...}`) rather than Swift's default single-key-wrapper encoding for enums
/// with associated values (`{"stroke": {...}}`) — the flat shape is what
/// this file's header documents as the format and is what a
/// non-Swift reader (were one ever needed) would expect from a `type`
/// discriminator.
public enum CanvasElement: Hashable, Sendable, Identifiable {
  case stroke(CanvasStroke)
  case rectangle(CanvasShape)
  case ellipse(CanvasShape)
  case line(CanvasLineSegment)
  case arrow(CanvasLineSegment)
  case text(CanvasText)

  public var id: CanvasElementID {
    switch self {
    case .stroke(let value): value.id
    case .rectangle(let value): value.id
    case .ellipse(let value): value.id
    case .line(let value): value.id
    case .arrow(let value): value.id
    case .text(let value): value.id
    }
  }

  public var style: CanvasStrokeStyle? {
    switch self {
    case .stroke(let value): value.style
    case .rectangle(let value): value.style
    case .ellipse(let value): value.style
    case .line(let value): value.style
    case .arrow(let value): value.style
    case .text: nil
    }
  }
}

extension CanvasElement: Codable {
  private enum Kind: String, Codable {
    case stroke, rectangle, ellipse, line, arrow, text
  }

  private enum CodingKeys: String, CodingKey {
    case type
    // stroke
    case id, points, style
    // rectangle / ellipse (CanvasShape)
    case origin, size
    // line / arrow (CanvasLineSegment)
    case start, end
    // text
    case position, content, fontSize, color
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try container.decode(Kind.self, forKey: .type)
    let elementID = try container.decode(CanvasElementID.self, forKey: .id)
    switch kind {
    case .stroke:
      self = .stroke(
        CanvasStroke(
          id: elementID,
          points: try container.decode([CanvasPoint].self, forKey: .points),
          style: try container.decode(CanvasStrokeStyle.self, forKey: .style)))
    case .rectangle, .ellipse:
      let shape = CanvasShape(
        id: elementID,
        origin: try container.decode(CanvasPoint.self, forKey: .origin),
        size: try container.decode(CanvasSize.self, forKey: .size),
        style: try container.decode(CanvasStrokeStyle.self, forKey: .style))
      self = kind == .rectangle ? .rectangle(shape) : .ellipse(shape)
    case .line, .arrow:
      let segment = CanvasLineSegment(
        id: elementID,
        start: try container.decode(CanvasPoint.self, forKey: .start),
        end: try container.decode(CanvasPoint.self, forKey: .end),
        style: try container.decode(CanvasStrokeStyle.self, forKey: .style))
      self = kind == .line ? .line(segment) : .arrow(segment)
    case .text:
      self = .text(
        CanvasText(
          id: elementID,
          position: try container.decode(CanvasPoint.self, forKey: .position),
          content: try container.decode(String.self, forKey: .content),
          fontSize: try container.decode(Double.self, forKey: .fontSize),
          color: try container.decode(CanvasColor.self, forKey: .color)))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .stroke(let value):
      try container.encode(Kind.stroke, forKey: .type)
      try container.encode(value.id, forKey: .id)
      try container.encode(value.points, forKey: .points)
      try container.encode(value.style, forKey: .style)
    case .rectangle(let value):
      try container.encode(Kind.rectangle, forKey: .type)
      try container.encode(value.id, forKey: .id)
      try container.encode(value.origin, forKey: .origin)
      try container.encode(value.size, forKey: .size)
      try container.encode(value.style, forKey: .style)
    case .ellipse(let value):
      try container.encode(Kind.ellipse, forKey: .type)
      try container.encode(value.id, forKey: .id)
      try container.encode(value.origin, forKey: .origin)
      try container.encode(value.size, forKey: .size)
      try container.encode(value.style, forKey: .style)
    case .line(let value):
      try container.encode(Kind.line, forKey: .type)
      try container.encode(value.id, forKey: .id)
      try container.encode(value.start, forKey: .start)
      try container.encode(value.end, forKey: .end)
      try container.encode(value.style, forKey: .style)
    case .arrow(let value):
      try container.encode(Kind.arrow, forKey: .type)
      try container.encode(value.id, forKey: .id)
      try container.encode(value.start, forKey: .start)
      try container.encode(value.end, forKey: .end)
      try container.encode(value.style, forKey: .style)
    case .text(let value):
      try container.encode(Kind.text, forKey: .type)
      try container.encode(value.id, forKey: .id)
      try container.encode(value.position, forKey: .position)
      try container.encode(value.content, forKey: .content)
      try container.encode(value.fontSize, forKey: .fontSize)
      try container.encode(value.color, forKey: .color)
    }
  }
}

// MARK: - CanvasDocument

public enum CanvasDocumentError: Error, Equatable, Sendable, LocalizedError {
  case invalidFormat(String)
  case unsupportedSchemaVersion(Int)

  public var errorDescription: String? {
    switch self {
    case .invalidFormat(let format): "Unrecognized canvas document format \"\(format)\"."
    case .unsupportedSchemaVersion(let version): "Unsupported canvas document schema version \(version)."
    }
  }
}

/// The full serialized shape of one canvas's content — this is what
/// `CanvasBlobStore` uploads/downloads as blob bytes. See this file's
/// header for the documented wire format.
public struct CanvasDocument: Hashable, Sendable {
  public static let format = "enchiridion/canvas"
  public static let schemaVersion = 1

  public var canvasSize: CanvasSize
  public var elements: [CanvasElement]

  public init(canvasSize: CanvasSize = .defaultSize, elements: [CanvasElement] = []) {
    self.canvasSize = canvasSize
    self.elements = elements
  }
}

extension CanvasDocument: Codable {
  private enum CodingKeys: String, CodingKey {
    case format, schemaVersion, canvasSize, elements
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let storedFormat = try container.decode(String.self, forKey: .format)
    guard storedFormat == Self.format else {
      throw CanvasDocumentError.invalidFormat(storedFormat)
    }
    let storedVersion = try container.decode(Int.self, forKey: .schemaVersion)
    guard storedVersion == Self.schemaVersion else {
      throw CanvasDocumentError.unsupportedSchemaVersion(storedVersion)
    }
    self.canvasSize = try container.decode(CanvasSize.self, forKey: .canvasSize)
    self.elements = try container.decode([CanvasElement].self, forKey: .elements)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(Self.format, forKey: .format)
    try container.encode(Self.schemaVersion, forKey: .schemaVersion)
    try container.encode(canvasSize, forKey: .canvasSize)
    try container.encode(elements, forKey: .elements)
  }
}

// MARK: - Encoding helpers

/// Canonical JSON coding for `CanvasDocument` — `.sortedKeys` so two
/// encodes of the logically-identical document produce byte-identical
/// output (this file's golden round-trip tests rely on this, and it keeps
/// re-uploads of an unchanged canvas content-addressing to the same
/// `BlobID`, avoiding a spurious duplicate blob per save).
public enum CanvasDocumentCoding {
  public static func encode(_ document: CanvasDocument) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(document)
  }

  public static func decode(_ data: Data) throws -> CanvasDocument {
    try JSONDecoder().decode(CanvasDocument.self, from: data)
  }
}
