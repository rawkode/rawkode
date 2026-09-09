import Foundation
import CoreGraphics

struct DrawingDocument: Codable, Equatable {
    static let worldSize = CGSize(width: 900, height: 420)
    var elements: [DrawingElement] = []

    static var sample: DrawingDocument {
        DrawingDocument(elements: [
            .init(kind: .rectangle, ink: .blue, points: [.init(x: 92, y: 120), .init(x: 310, y: 265)]),
            .init(kind: .text, ink: .graphite, points: [.init(x: 133, y: 178)], text: "A small idea"),
            .init(kind: .arrow, ink: .graphite, points: [.init(x: 328, y: 190), .init(x: 540, y: 190)]),
            .init(kind: .text, ink: .graphite, points: [.init(x: 369, y: 148)], text: "make room"),
            .init(kind: .ellipse, ink: .orange, points: [.init(x: 560, y: 105), .init(x: 812, y: 285)]),
            .init(kind: .text, ink: .graphite, points: [.init(x: 614, y: 178)], text: "Something new"),
            .init(kind: .pen, ink: .purple, points: [
                .init(x: 144, y: 295), .init(x: 165, y: 301), .init(x: 195, y: 297),
                .init(x: 222, y: 303), .init(x: 249, y: 297), .init(x: 276, y: 302),
            ]),
        ])
    }
}

struct DrawingPoint: Codable, Equatable {
    var x: Double
    var y: Double

    var cgPoint: CGPoint { CGPoint(x: x, y: y) }
    init(x: Double, y: Double) { self.x = x; self.y = y }
    init(_ point: CGPoint) { x = point.x; y = point.y }
}

enum DrawingInk: String, Codable, CaseIterable, Identifiable {
    case graphite, blue, purple, orange, green, red
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct DrawingElement: Codable, Equatable, Identifiable {
    enum Kind: String, Codable { case pen, rectangle, ellipse, arrow, text }

    var id = UUID()
    var kind: Kind
    var ink: DrawingInk = .graphite
    var points: [DrawingPoint]
    var text: String = ""
    var lineWidth: Double = 3

    var bounds: CGRect {
        guard let first = points.first else { return .zero }
        if kind == .text {
            return CGRect(x: first.x, y: first.y, width: max(36, Double(text.count) * 12), height: 30)
        }
        let xs = points.map(\.x)
        let ys = points.map(\.y)
        return CGRect(x: xs.min() ?? 0, y: ys.min() ?? 0,
                      width: (xs.max() ?? 0) - (xs.min() ?? 0),
                      height: (ys.max() ?? 0) - (ys.min() ?? 0))
    }

    func moved(by delta: CGSize) -> DrawingElement {
        var copy = self
        let dx = min(max(delta.width, -bounds.minX), DrawingDocument.worldSize.width - bounds.maxX)
        let dy = min(max(delta.height, -bounds.minY), DrawingDocument.worldSize.height - bounds.maxY)
        copy.points = points.map { DrawingPoint(x: $0.x + dx, y: $0.y + dy) }
        return copy
    }
}
