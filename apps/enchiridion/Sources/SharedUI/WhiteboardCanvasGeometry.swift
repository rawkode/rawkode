import EnchiridionCore
import SwiftUI

struct WhiteboardCamera {
  var center: CGPoint
  var zoom: CGFloat
  var transientPan: CGSize = .zero

  init(viewport: WhiteboardViewport, transientPan: CGSize = .zero) {
    center = CGPoint(x: viewport.center.x, y: viewport.center.y)
    zoom = CGFloat(viewport.zoom)
    self.transientPan = transientPan
  }

  func screenPoint(for point: WhiteboardPoint, in viewportSize: CGSize) -> CGPoint {
    CGPoint(
      x: viewportSize.width / 2 + (CGFloat(point.x) - center.x) * zoom + transientPan.width,
      y: viewportSize.height / 2 + (CGFloat(point.y) - center.y) * zoom + transientPan.height
    )
  }

  func canvasPoint(for point: CGPoint, in viewportSize: CGSize) -> WhiteboardPoint {
    WhiteboardPoint(
      x: Double(center.x + (point.x - viewportSize.width / 2 - transientPan.width) / zoom),
      y: Double(center.y + (point.y - viewportSize.height / 2 - transientPan.height) / zoom)
    )
  }

  func screenRect(for bounds: WhiteboardBounds, in viewportSize: CGSize) -> CGRect {
    let origin = screenPoint(for: .init(x: bounds.x, y: bounds.y), in: viewportSize)
    return CGRect(
      x: origin.x,
      y: origin.y,
      width: CGFloat(bounds.width) * zoom,
      height: CGFloat(bounds.height) * zoom
    )
  }
}

extension WhiteboardViewport {
  static let canvasDefault = WhiteboardViewport(center: .init(x: 480, y: 320), zoom: 1)

  func clamped() -> Self {
    .init(
      center: center,
      zoom: min(max(zoom, WhiteboardLimits.minimumZoom), WhiteboardLimits.maximumZoom)
    )
  }
}

extension WhiteboardBounds {
  init(_ rect: CGRect) {
    self.init(
      x: Double(rect.minX),
      y: Double(rect.minY),
      width: Double(rect.width),
      height: Double(rect.height)
    )
  }

  var centerPoint: WhiteboardPoint { .init(x: midX, y: midY) }
}

extension Color {
  init(whiteboardHex value: String, fallback: Color) {
    let trimmed = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard (trimmed.count == 6 || trimmed.count == 8), let raw = UInt64(trimmed, radix: 16) else {
      self = fallback
      return
    }
    let hasAlpha = trimmed.count == 8
    let red = Double((raw >> (hasAlpha ? 24 : 16)) & 0xff) / 255
    let green = Double((raw >> (hasAlpha ? 16 : 8)) & 0xff) / 255
    let blue = Double((raw >> (hasAlpha ? 8 : 0)) & 0xff) / 255
    let alpha = hasAlpha ? Double(raw & 0xff) / 255 : 1
    self = Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
  }
}
