import SwiftUI
import AppKit

extension DrawingInk {
    var color: Color {
        switch self {
        case .graphite: return .primary
        case .blue: return .blue
        case .purple: return .purple
        case .orange: return .orange
        case .green: return .green
        case .red: return .red
        }
    }
}

extension DrawingElement {
    var path: Path {
        guard let first = points.first else { return Path() }
        return Path { path in
            switch kind {
            case .rectangle:
                path.addRoundedRect(in: bounds, cornerSize: CGSize(width: 10, height: 10))
            case .ellipse:
                path.addEllipse(in: bounds)
            case .pen:
                path.move(to: first.cgPoint)
                if points.count == 1 { path.addLine(to: CGPoint(x: first.x + 0.1, y: first.y)) }
                for point in points.dropFirst() { path.addLine(to: point.cgPoint) }
            case .arrow:
                guard let last = points.last else { return }
                path.move(to: first.cgPoint)
                path.addLine(to: last.cgPoint)
                let angle = atan2(last.y - first.y, last.x - first.x)
                for offset in [-0.45, 0.45] {
                    path.move(to: last.cgPoint)
                    path.addLine(to: CGPoint(x: last.x - cos(angle + offset) * 18,
                                            y: last.y - sin(angle + offset) * 18))
                }
            case .text: break
            }
        }
    }

    func contains(_ point: CGPoint) -> Bool {
        switch kind {
        case .rectangle, .ellipse, .text:
            return bounds.insetBy(dx: -8, dy: -8).contains(point)
        case .pen, .arrow:
            return path.strokedPath(StrokeStyle(lineWidth: max(16, lineWidth), lineCap: .round)).contains(point)
        }
    }
}

struct DrawingTransform {
    let scale: CGFloat
    let offset: CGPoint

    init(size: CGSize) {
        scale = max(0.01, min(size.width / DrawingDocument.worldSize.width,
                              size.height / DrawingDocument.worldSize.height))
        offset = CGPoint(x: (size.width - DrawingDocument.worldSize.width * scale) / 2,
                         y: (size.height - DrawingDocument.worldSize.height * scale) / 2)
    }

    func worldPoint(_ point: CGPoint) -> CGPoint {
        CGPoint(x: min(max((point.x - offset.x) / scale, 0), DrawingDocument.worldSize.width),
                y: min(max((point.y - offset.y) / scale, 0), DrawingDocument.worldSize.height))
    }
}

struct DrawingPreview: View {
    let document: DrawingDocument

    var body: some View {
        DrawingSurface(document: document)
            .accessibilityLabel("Drawing with \(document.elements.count) elements")
    }
}

struct DrawingSurface: View {
    let document: DrawingDocument
    var activeElement: DrawingElement? = nil
    var selection: UUID? = nil
    var showGrid = false

    var body: some View {
        Canvas { context, size in
            let transform = DrawingTransform(size: size)
            context.translateBy(x: transform.offset.x, y: transform.offset.y)
            context.scaleBy(x: transform.scale, y: transform.scale)
            if showGrid {
                var dots = Path()
                for x in stride(from: 20, through: 880, by: 20) {
                    for y in stride(from: 20, through: 400, by: 20) {
                        dots.addEllipse(in: CGRect(x: Double(x), y: Double(y), width: 1.5, height: 1.5))
                    }
                }
                context.fill(dots, with: .color(.secondary.opacity(0.22)))
            }
            for element in document.elements {
                render(element, context: &context)
            }
            if let activeElement { render(activeElement, context: &context) }
            if let selected = document.elements.first(where: { $0.id == selection }) {
                context.stroke(Path(roundedRect: selected.bounds.insetBy(dx: -8, dy: -8), cornerRadius: 5),
                               with: .color(.accentColor), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        .clipped()
    }

    private func render(_ element: DrawingElement, context: inout GraphicsContext) {
        if element.kind == .text, let point = element.points.first {
            context.draw(Text(element.text).font(.system(size: 21, weight: .medium, design: .rounded))
                .foregroundStyle(element.ink.color), at: point.cgPoint, anchor: .topLeading)
        } else {
            context.stroke(element.path, with: .color(element.ink.color),
                           style: StrokeStyle(lineWidth: element.lineWidth, lineCap: .round, lineJoin: .round))
        }
    }
}
