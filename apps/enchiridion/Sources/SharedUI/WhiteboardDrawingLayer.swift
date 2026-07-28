import EnchiridionCore
import SwiftUI

struct WhiteboardDrawingLayer: View {
  let elements: [WhiteboardElement]
  let draft: WhiteboardElement?
  let selectedIDs: Set<WhiteboardElementID>
  let camera: WhiteboardCamera

  var body: some View {
    Canvas(rendersAsynchronously: true) { context, size in
      drawGrid(in: &context, size: size)
      let boundsByID = Dictionary(uniqueKeysWithValues: elements.map { ($0.id, $0.bounds) })
      for element in elements {
        draw(element, boundsByID: boundsByID, in: &context, size: size)
      }
      if let draft {
        draw(draft, boundsByID: boundsByID, in: &context, size: size, isDraft: true)
      }
      drawSelection(in: &context, size: size)
    }
    .accessibilityHidden(true)
  }

  private func drawGrid(in context: inout GraphicsContext, size: CGSize) {
    var spacing: CGFloat = 28
    while spacing * camera.zoom < 16 { spacing *= 4 }
    let topLeft = camera.canvasPoint(for: .zero, in: size)
    let bottomRight = camera.canvasPoint(for: CGPoint(x: size.width, y: size.height), in: size)
    let startX = floor(CGFloat(topLeft.x) / spacing) * spacing
    let startY = floor(CGFloat(topLeft.y) / spacing) * spacing
    let endX = CGFloat(bottomRight.x) + spacing
    let endY = CGFloat(bottomRight.y) + spacing
    var x = startX
    var dots = Path()
    let diameter = max(1.2, min(2, camera.zoom * 1.4))

    while x <= endX {
      var y = startY
      while y <= endY {
        let point = camera.screenPoint(for: .init(x: Double(x), y: Double(y)), in: size)
        dots.addEllipse(
          in: CGRect(
            x: point.x - diameter / 2,
            y: point.y - diameter / 2,
            width: diameter,
            height: diameter
          )
        )
        y += spacing
      }
      x += spacing
    }
    context.fill(dots, with: .color(Color.black.opacity(0.13)))
  }

  private func draw(
    _ element: WhiteboardElement,
    boundsByID: [WhiteboardElementID: WhiteboardBounds],
    in context: inout GraphicsContext,
    size: CGSize,
    isDraft: Bool = false
  ) {
    let strokeColor = Color(whiteboardHex: element.style.strokeColor, fallback: .primary)
      .opacity(element.style.opacity * (isDraft ? 0.58 : 1))
    let fillColor = Color(whiteboardHex: element.style.fillColor, fallback: .clear)
      .opacity(element.style.opacity * (isDraft ? 0.45 : 1))
    let lineWidth = max(1, CGFloat(element.style.strokeWidth) * camera.zoom)
    let strokeStyle = StrokeStyle(
      lineWidth: lineWidth,
      lineCap: .round,
      lineJoin: .round,
      dash: dashPattern(for: element.style.strokeStyle, lineWidth: lineWidth)
    )

    switch element.kind {
    case .page, .text, .sticky:
      return
    case .freehand(let points):
      let path = path(for: points, in: size)
      context.stroke(path, with: .color(strokeColor), style: strokeStyle)
    case .rectangle:
      drawShape(Path(camera.screenRect(for: element.bounds, in: size)), fill: fillColor, stroke: strokeColor, style: strokeStyle, context: &context)
    case .ellipse:
      let path = Path(ellipseIn: camera.screenRect(for: element.bounds, in: size))
      drawShape(path, fill: fillColor, stroke: strokeColor, style: strokeStyle, context: &context)
    case .diamond:
      let rect = camera.screenRect(for: element.bounds, in: size)
      var path = Path()
      path.move(to: CGPoint(x: rect.midX, y: rect.minY))
      path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
      path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
      path.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
      path.closeSubpath()
      drawShape(path, fill: fillColor, stroke: strokeColor, style: strokeStyle, context: &context)
    case .arrow(let arrow):
      drawArrow(arrow, boundsByID: boundsByID, stroke: strokeColor, style: strokeStyle, context: &context, size: size)
    }
  }

  private func drawShape(
    _ path: Path,
    fill: Color,
    stroke: Color,
    style: StrokeStyle,
    context: inout GraphicsContext
  ) {
    context.fill(path, with: .color(fill))
    context.stroke(path, with: .color(stroke), style: style)
  }

  private func path(for points: [WhiteboardPoint], in size: CGSize) -> Path {
    var path = Path()
    guard let first = points.first else { return path }
    path.move(to: camera.screenPoint(for: first, in: size))
    for point in points.dropFirst() {
      path.addLine(to: camera.screenPoint(for: point, in: size))
    }
    return path
  }

  private func drawArrow(
    _ arrow: WhiteboardArrow,
    boundsByID: [WhiteboardElementID: WhiteboardBounds],
    stroke: Color,
    style: StrokeStyle,
    context: inout GraphicsContext,
    size: CGSize
  ) {
    let points = resolvedArrowPoints(arrow, boundsByID: boundsByID)
    guard points.count >= 2 else { return }
    context.stroke(path(for: points, in: size), with: .color(stroke), style: style)

    let tip = camera.screenPoint(for: points[points.count - 1], in: size)
    let preceding = camera.screenPoint(for: points[points.count - 2], in: size)
    let angle = atan2(tip.y - preceding.y, tip.x - preceding.x)
    let length = max(9, min(18, 11 * camera.zoom))
    var head = Path()
    head.move(to: tip)
    head.addLine(
      to: CGPoint(
        x: tip.x - length * cos(angle - .pi / 6),
        y: tip.y - length * sin(angle - .pi / 6)
      )
    )
    head.move(to: tip)
    head.addLine(
      to: CGPoint(
        x: tip.x - length * cos(angle + .pi / 6),
        y: tip.y - length * sin(angle + .pi / 6)
      )
    )
    context.stroke(head, with: .color(stroke), style: style)
  }

  private func resolvedArrowPoints(
    _ arrow: WhiteboardArrow,
    boundsByID: [WhiteboardElementID: WhiteboardBounds]
  ) -> [WhiteboardPoint] {
    var points = arrow.points
    guard !points.isEmpty else { return points }
    if let start = arrow.start, let bounds = boundsByID[start.elementID] {
      points[0] = anchoredPoint(start.anchor, in: bounds)
    }
    if let end = arrow.end, let bounds = boundsByID[end.elementID] {
      points[points.count - 1] = anchoredPoint(end.anchor, in: bounds)
    }
    return points
  }

  private func anchoredPoint(_ anchor: WhiteboardPoint, in bounds: WhiteboardBounds) -> WhiteboardPoint {
    .init(
      x: bounds.x + bounds.width * anchor.x,
      y: bounds.y + bounds.height * anchor.y
    )
  }

  private func drawSelection(in context: inout GraphicsContext, size: CGSize) {
    for element in elements where selectedIDs.contains(element.id) {
      let rect = camera.screenRect(for: element.bounds, in: size).insetBy(dx: -4, dy: -4)
      context.stroke(
        Path(roundedRect: rect, cornerRadius: 7),
        with: .color(.accentColor),
        style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])
      )
    }
  }

  private func dashPattern(for style: WhiteboardStrokeStyle, lineWidth: CGFloat) -> [CGFloat] {
    switch style {
    case .solid: []
    case .dashed: [lineWidth * 4, lineWidth * 3]
    case .dotted: [lineWidth, lineWidth * 2.5]
    }
  }
}
