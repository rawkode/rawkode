import Foundation

public struct WhiteboardElementID: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
  public let rawValue: String
  public var id: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public static func random() -> Self {
    .init(rawValue: "element_\(UUID().uuidString.lowercased())")
  }

  public static func pageCard(_ pageID: PageID) -> Self {
    .init(rawValue: "page-card:\(pageID.rawValue)")
  }
}

public struct WhiteboardPoint: Codable, Hashable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }

  public func translated(x deltaX: Double, y deltaY: Double) -> Self {
    .init(x: x + deltaX, y: y + deltaY)
  }
}

public struct WhiteboardSize: Codable, Hashable, Sendable {
  public var width: Double
  public var height: Double

  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
  }
}

public struct WhiteboardBounds: Codable, Hashable, Sendable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  public var minX: Double { x }
  public var minY: Double { y }
  public var maxX: Double { x + width }
  public var maxY: Double { y + height }
  public var midX: Double { x + width / 2 }
  public var midY: Double { y + height / 2 }

  public func translated(x deltaX: Double, y deltaY: Double) -> Self {
    .init(x: x + deltaX, y: y + deltaY, width: width, height: height)
  }

  public func union(_ other: Self) -> Self {
    let left = min(minX, other.minX)
    let top = min(minY, other.minY)
    let right = max(maxX, other.maxX)
    let bottom = max(maxY, other.maxY)
    return .init(x: left, y: top, width: right - left, height: bottom - top)
  }
}

public enum WhiteboardStrokeStyle: String, Codable, CaseIterable, Hashable, Sendable {
  case solid, dashed, dotted
}

public struct WhiteboardStyle: Codable, Hashable, Sendable {
  public var strokeColor: String
  public var fillColor: String
  public var strokeWidth: Double
  public var strokeStyle: WhiteboardStrokeStyle
  public var opacity: Double
  public var roughness: Double
  public var fontSize: Double

  public init(
    strokeColor: String = "#1f2937",
    fillColor: String = "#ffffff00",
    strokeWidth: Double = 2,
    strokeStyle: WhiteboardStrokeStyle = .solid,
    opacity: Double = 1,
    roughness: Double = 1,
    fontSize: Double = 18
  ) {
    self.strokeColor = strokeColor
    self.fillColor = fillColor
    self.strokeWidth = strokeWidth
    self.strokeStyle = strokeStyle
    self.opacity = opacity
    self.roughness = roughness
    self.fontSize = fontSize
  }
}

public struct WhiteboardConnectionEndpoint: Codable, Hashable, Sendable {
  public var elementID: WhiteboardElementID
  /// A normalized anchor within the target element's bounds.
  public var anchor: WhiteboardPoint

  public init(elementID: WhiteboardElementID, anchor: WhiteboardPoint) {
    self.elementID = elementID
    self.anchor = anchor
  }
}

public struct WhiteboardArrow: Codable, Hashable, Sendable {
  public var points: [WhiteboardPoint]
  public var start: WhiteboardConnectionEndpoint?
  public var end: WhiteboardConnectionEndpoint?

  public init(
    points: [WhiteboardPoint],
    start: WhiteboardConnectionEndpoint? = nil,
    end: WhiteboardConnectionEndpoint? = nil
  ) {
    self.points = points
    self.start = start
    self.end = end
  }
}

public enum WhiteboardElementKind: Codable, Hashable, Sendable {
  case page(PageID)
  case freehand([WhiteboardPoint])
  case rectangle
  case ellipse
  case diamond
  case text(String)
  case sticky(String)
  case arrow(WhiteboardArrow)
}

public struct WhiteboardElement: Codable, Hashable, Sendable, Identifiable {
  public var id: WhiteboardElementID
  public var kind: WhiteboardElementKind
  public var bounds: WhiteboardBounds
  public var style: WhiteboardStyle
  /// Lower values render behind higher values. Documents normalize these to a dense range.
  public var zIndex: Int

  public init(
    id: WhiteboardElementID = .random(),
    kind: WhiteboardElementKind,
    bounds: WhiteboardBounds,
    style: WhiteboardStyle = .init(),
    zIndex: Int = 0
  ) {
    self.id = id
    self.kind = kind
    self.bounds = bounds
    self.style = style
    self.zIndex = zIndex
  }

  public func translated(x deltaX: Double, y deltaY: Double) -> Self {
    var copy = self
    copy.bounds = bounds.translated(x: deltaX, y: deltaY)
    switch kind {
    case .freehand(let points):
      copy.kind = .freehand(points.map { $0.translated(x: deltaX, y: deltaY) })
    case .arrow(var arrow):
      arrow.points = arrow.points.map { $0.translated(x: deltaX, y: deltaY) }
      copy.kind = .arrow(arrow)
    case .page, .rectangle, .ellipse, .diamond, .text, .sticky:
      break
    }
    return copy
  }
}

public struct WhiteboardViewport: Codable, Hashable, Sendable {
  public var center: WhiteboardPoint
  public var zoom: Double

  public init(center: WhiteboardPoint = .init(x: 0, y: 0), zoom: Double = 1) {
    self.center = center
    self.zoom = zoom
  }
}

public struct WhiteboardDocument: Codable, Hashable, Sendable {
  public static let currentVersion = 1

  public var version: Int
  public var revision: Int64
  /// Elements are stored back-to-front. `zIndex` is normalized to match this order.
  public var elements: [WhiteboardElement]
  public var viewport: WhiteboardViewport

  public init(
    version: Int = WhiteboardDocument.currentVersion,
    revision: Int64 = 0,
    elements: [WhiteboardElement] = [],
    viewport: WhiteboardViewport = .init()
  ) {
    self.version = version
    self.revision = revision
    self.elements = elements
    self.viewport = viewport
    normalizeElementOrder()
  }

  public static var empty: Self { .init() }
  public var orderedElementIDs: [WhiteboardElementID] { elements.map(\.id) }

  public func element(id: WhiteboardElementID) -> WhiteboardElement? {
    elements.first { $0.id == id }
  }

  public mutating func normalizeElementOrder() {
    elements = elements.enumerated().map { index, element in
      var copy = element
      copy.zIndex = index
      return copy
    }
  }
}

public struct WhiteboardElementMove: Codable, Hashable, Sendable {
  public var elementID: WhiteboardElementID
  public var deltaX: Double
  public var deltaY: Double

  public init(elementID: WhiteboardElementID, deltaX: Double, deltaY: Double) {
    self.elementID = elementID
    self.deltaX = deltaX
    self.deltaY = deltaY
  }
}

public enum WhiteboardArrowEndpoint: String, Codable, Hashable, Sendable {
  case start, end
}

public struct WhiteboardFitMetadata: Codable, Hashable, Sendable {
  public var contentBounds: WhiteboardBounds?
  public var viewport: WhiteboardViewport

  public init(contentBounds: WhiteboardBounds?, viewport: WhiteboardViewport) {
    self.contentBounds = contentBounds
    self.viewport = viewport
  }
}

public struct WhiteboardMutationReceipt: Codable, Hashable, Sendable {
  public var before: WhiteboardDocument
  public var after: WhiteboardDocument

  public init(before: WhiteboardDocument, after: WhiteboardDocument) {
    self.before = before
    self.after = after
  }
}

public enum WhiteboardError: Error, LocalizedError, Equatable {
  case viewNotFound
  case viewDeleted
  case staleRevision(expected: Int64, actual: Int64)
  case elementNotFound(WhiteboardElementID)
  case elementIsNotArrow(WhiteboardElementID)
  case limitExceeded(String)
  case invalid(String)

  public var errorDescription: String? {
    switch self {
    case .viewNotFound: "The live view no longer exists."
    case .viewDeleted: "The live view is deleted."
    case .staleRevision(let expected, let actual):
      "The canvas changed while editing (expected revision \(expected), found \(actual))."
    case .elementNotFound(let id): "Canvas element \(id.rawValue) no longer exists."
    case .elementIsNotArrow(let id): "Canvas element \(id.rawValue) is not an arrow."
    case .limitExceeded(let message), .invalid(let message): message
    }
  }
}

public enum WhiteboardLimits {
  public static let maximumElements = 5_000
  public static let maximumElementsPerMutation = 512
  public static let maximumPageCards = 500
  public static let maximumPointsPerElement = 8_192
  public static let maximumTotalPoints = 100_000
  public static let maximumEncodedBytes = 900_000
  public static let maximumTextLength = 20_000
  public static let maximumIdentifierLength = 512
  public static let maximumCoordinateMagnitude = 1_000_000.0
  public static let maximumDimension = 100_000.0
  public static let minimumZoom = 0.05
  public static let maximumZoom = 8.0
}

public enum WhiteboardDocumentValidator {
  public static func validate(_ document: WhiteboardDocument) throws {
    guard document.version == WhiteboardDocument.currentVersion else {
      throw WhiteboardError.invalid("This canvas uses an unsupported document version.")
    }
    guard document.revision >= 0 else {
      throw WhiteboardError.invalid("Canvas revisions cannot be negative.")
    }
    guard document.elements.count <= WhiteboardLimits.maximumElements else {
      throw WhiteboardError.limitExceeded(
        "A canvas can contain at most \(WhiteboardLimits.maximumElements) elements."
      )
    }
    try validate(viewport: document.viewport)

    let elementIDs = Set(document.elements.map(\.id))
    guard elementIDs.count == document.elements.count else {
      throw WhiteboardError.invalid("Canvas element identifiers must be unique.")
    }
    var totalPoints = 0
    var pageCardIDs: Set<PageID> = []
    for (index, element) in document.elements.enumerated() {
      guard element.zIndex == index else {
        throw WhiteboardError.invalid("Canvas stacking order is not normalized.")
      }
      try validate(element: element, elementIDs: elementIDs)
      switch element.kind {
      case .page(let pageID):
        guard pageCardIDs.insert(pageID).inserted else {
          throw WhiteboardError.invalid("A canvas cannot contain duplicate cards for the same page.")
        }
      case .freehand(let points): totalPoints += points.count
      case .arrow(let arrow): totalPoints += arrow.points.count
      default: break
      }
    }
    guard pageCardIDs.count <= WhiteboardLimits.maximumPageCards else {
      throw WhiteboardError.limitExceeded(
        "A canvas can contain at most \(WhiteboardLimits.maximumPageCards) live-query page cards."
      )
    }
    guard totalPoints <= WhiteboardLimits.maximumTotalPoints else {
      throw WhiteboardError.limitExceeded(
        "A canvas can contain at most \(WhiteboardLimits.maximumTotalPoints) path points."
      )
    }
  }

  public static func validate(viewport: WhiteboardViewport) throws {
    try validate(point: viewport.center)
    guard viewport.zoom.isFinite,
      (WhiteboardLimits.minimumZoom...WhiteboardLimits.maximumZoom).contains(viewport.zoom)
    else {
      throw WhiteboardError.invalid(
        "Canvas zoom must be between \(WhiteboardLimits.minimumZoom) and \(WhiteboardLimits.maximumZoom)."
      )
    }
  }

  public static func validate(size: WhiteboardSize) throws {
    guard size.width.isFinite, size.height.isFinite,
      size.width > 0, size.height > 0,
      size.width <= WhiteboardLimits.maximumDimension,
      size.height <= WhiteboardLimits.maximumDimension
    else { throw WhiteboardError.invalid("The viewport size is outside the supported canvas bounds.") }
  }

  private static func validate(
    element: WhiteboardElement,
    elementIDs: Set<WhiteboardElementID>
  ) throws {
    guard !element.id.rawValue.isEmpty,
      element.id.rawValue.count <= WhiteboardLimits.maximumIdentifierLength
    else { throw WhiteboardError.invalid("Canvas element identifiers are invalid.") }
    try validate(bounds: element.bounds)
    try validate(style: element.style)

    switch element.kind {
    case .page:
      break
    case .freehand(let points):
      try validate(points: points, minimumCount: 2)
    case .rectangle, .ellipse, .diamond:
      break
    case .text(let value), .sticky(let value):
      guard value.count <= WhiteboardLimits.maximumTextLength else {
        throw WhiteboardError.limitExceeded(
          "Canvas text can contain at most \(WhiteboardLimits.maximumTextLength) characters."
        )
      }
    case .arrow(let arrow):
      try validate(points: arrow.points, minimumCount: 2)
      try validate(endpoint: arrow.start, arrowID: element.id, elementIDs: elementIDs)
      try validate(endpoint: arrow.end, arrowID: element.id, elementIDs: elementIDs)
    }
  }

  private static func validate(bounds: WhiteboardBounds) throws {
    try validate(point: .init(x: bounds.x, y: bounds.y))
    guard bounds.width.isFinite, bounds.height.isFinite,
      bounds.width > 0, bounds.height > 0,
      bounds.width <= WhiteboardLimits.maximumDimension,
      bounds.height <= WhiteboardLimits.maximumDimension,
      abs(bounds.maxX) <= WhiteboardLimits.maximumCoordinateMagnitude,
      abs(bounds.maxY) <= WhiteboardLimits.maximumCoordinateMagnitude
    else { throw WhiteboardError.invalid("Canvas element bounds are outside the supported range.") }
  }

  private static func validate(style: WhiteboardStyle) throws {
    guard !style.strokeColor.isEmpty, style.strokeColor.count <= 64,
      !style.fillColor.isEmpty, style.fillColor.count <= 64,
      style.strokeWidth.isFinite, (0.5...64).contains(style.strokeWidth),
      style.opacity.isFinite, (0...1).contains(style.opacity),
      style.roughness.isFinite, (0...3).contains(style.roughness),
      style.fontSize.isFinite, (8...256).contains(style.fontSize)
    else { throw WhiteboardError.invalid("Canvas element styling is outside the supported range.") }
  }

  private static func validate(points: [WhiteboardPoint], minimumCount: Int) throws {
    guard points.count >= minimumCount,
      points.count <= WhiteboardLimits.maximumPointsPerElement
    else {
      throw WhiteboardError.limitExceeded(
        "A canvas path must contain between \(minimumCount) and \(WhiteboardLimits.maximumPointsPerElement) points."
      )
    }
    try points.forEach(validate(point:))
  }

  private static func validate(point: WhiteboardPoint) throws {
    guard point.x.isFinite, point.y.isFinite,
      abs(point.x) <= WhiteboardLimits.maximumCoordinateMagnitude,
      abs(point.y) <= WhiteboardLimits.maximumCoordinateMagnitude
    else { throw WhiteboardError.invalid("Canvas coordinates are outside the supported range.") }
  }

  private static func validate(
    endpoint: WhiteboardConnectionEndpoint?,
    arrowID: WhiteboardElementID,
    elementIDs: Set<WhiteboardElementID>
  ) throws {
    guard let endpoint else { return }
    guard endpoint.elementID != arrowID, elementIDs.contains(endpoint.elementID) else {
      throw WhiteboardError.invalid("Arrow endpoints must reference another canvas element.")
    }
    guard endpoint.anchor.x.isFinite, endpoint.anchor.y.isFinite,
      (0...1).contains(endpoint.anchor.x), (0...1).contains(endpoint.anchor.y)
    else { throw WhiteboardError.invalid("Arrow anchors must be normalized between zero and one.") }
  }
}
