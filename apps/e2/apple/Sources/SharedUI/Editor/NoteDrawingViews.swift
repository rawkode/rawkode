import ApsidesCore
import SwiftUI

extension DrawingInk {
    var color: Color { Color(hex: hex) }
}

extension DrawingElement {
    var rect: CGRect {
        let box = bounds
        return CGRect(x: box.x, y: box.y, width: box.width, height: box.height)
    }

    var path: Path {
        guard let first = points.first else { return Path() }
        return Path { path in
            switch kind {
            case .rectangle:
                path.addRoundedRect(in: rect, cornerSize: CGSize(width: 10, height: 10))
            case .ellipse:
                path.addEllipse(in: rect)
            case .pen:
                path.move(to: CGPoint(x: first.x, y: first.y))
                if points.count == 1 { path.addLine(to: CGPoint(x: first.x + 0.1, y: first.y)) }
                for point in points.dropFirst() { path.addLine(to: CGPoint(x: point.x, y: point.y)) }
            case .arrow:
                guard let last = points.last else { return }
                path.move(to: CGPoint(x: first.x, y: first.y))
                path.addLine(to: CGPoint(x: last.x, y: last.y))
                let angle = atan2(last.y - first.y, last.x - first.x)
                for offset in [-0.45, 0.45] {
                    path.move(to: CGPoint(x: last.x, y: last.y))
                    path.addLine(to: CGPoint(x: last.x - cos(angle + offset) * 18, y: last.y - sin(angle + offset) * 18))
                }
            case .text:
                break
            }
        }
    }

    func contains(_ point: CGPoint) -> Bool {
        switch kind {
        case .rectangle, .ellipse, .text:
            return rect.insetBy(dx: -8, dy: -8).contains(point)
        case .pen, .arrow:
            return path.strokedPath(StrokeStyle(lineWidth: max(16, lineWidth), lineCap: .round)).contains(point)
        }
    }
}

/// Maps the fixed 900×420 world onto whatever size the surface was given.
struct DrawingTransform {
    let scale: CGFloat
    let offset: CGPoint

    init(size: CGSize) {
        scale = max(0.01, min(size.width / DrawingDocument.worldWidth, size.height / DrawingDocument.worldHeight))
        offset = CGPoint(x: (size.width - DrawingDocument.worldWidth * scale) / 2, y: (size.height - DrawingDocument.worldHeight * scale) / 2)
    }

    func worldPoint(_ point: CGPoint) -> CGPoint {
        CGPoint(x: min(max((point.x - offset.x) / scale, 0), DrawingDocument.worldWidth),
                y: min(max((point.y - offset.y) / scale, 0), DrawingDocument.worldHeight))
    }
}

struct DrawingSurface: View {
    let document: DrawingDocument
    let theme: ApsidesTheme
    var activeElement: DrawingElement? = nil
    var selection: String? = nil
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
                context.fill(dots, with: .color(theme.secondary.opacity(0.35)))
            }
            for element in document.elements { render(element, context: &context) }
            if let activeElement { render(activeElement, context: &context) }
            if let selected = document.elements.first(where: { $0.id == selection }) {
                context.stroke(Path(roundedRect: selected.rect.insetBy(dx: -8, dy: -8), cornerRadius: 5),
                               with: .color(theme.accent), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
            }
        }
        .background(theme.base)
        .clipped()
    }

    private func render(_ element: DrawingElement, context: inout GraphicsContext) {
        if element.kind == .text, let point = element.points.first {
            context.draw(Text(element.text).font(.system(size: 21, weight: .medium, design: .rounded)).foregroundStyle(element.ink.color),
                         at: CGPoint(x: point.x, y: point.y), anchor: .topLeading)
        } else {
            context.stroke(element.path, with: .color(element.ink.color),
                           style: StrokeStyle(lineWidth: element.lineWidth, lineCap: .round, lineJoin: .round))
        }
    }
}

private enum DrawingTool: String, CaseIterable, Identifiable {
    case select, pen, rectangle, ellipse, arrow, text
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var symbol: String {
        switch self {
        case .select: "cursorarrow"
        case .pen: "pencil.tip"
        case .rectangle: "rectangle"
        case .ellipse: "circle"
        case .arrow: "arrow.up.right"
        case .text: "textformat"
        }
    }
    var kind: DrawingElement.Kind? { DrawingElement.Kind(rawValue: rawValue) }
}

/// Pen, shapes, arrows and labels in the shared 900×420 coordinate space, with its own undo.
struct DrawingEditor: View {
    let component: NoteComponent
    let theme: ApsidesTheme
    let onSave: (NoteComponent) -> Void
    let onCancel: () -> Void

    @State private var draft: DrawingDocument
    @State private var title: String
    @State private var tool: DrawingTool = .pen
    @State private var ink: DrawingInk = .graphite
    @State private var label = "A new thought"
    @State private var activeElement: DrawingElement?
    @State private var selection: String?
    @State private var gestureStart: DrawingDocument?
    @State private var moveOriginal: DrawingElement?
    @State private var undoStack: [DrawingDocument] = []
    @State private var redoStack: [DrawingDocument] = []

    init(component: NoteComponent, theme: ApsidesTheme, onSave: @escaping (NoteComponent) -> Void, onCancel: @escaping () -> Void) {
        self.component = component; self.theme = theme; self.onSave = onSave; self.onCancel = onCancel
        _draft = State(initialValue: component.drawing ?? DrawingDocument())
        _title = State(initialValue: component.title)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Title", text: $title).textFieldStyle(.roundedBorder)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        Picker("Tool", selection: $tool) {
                            ForEach(DrawingTool.allCases) { tool in
                                Image(systemName: tool.symbol).tag(tool).accessibilityLabel(tool.label)
                            }
                        }
                        .pickerStyle(.segmented).frame(width: 300)
                        .onChange(of: tool) { _, _ in selection = nil }
                        HStack(spacing: 6) {
                            ForEach(DrawingInk.allCases) { color in
                                Button { ink = color } label: {
                                    Circle().fill(color.color).frame(width: 18, height: 18).padding(4)
                                        .overlay(Circle().strokeBorder(ink == color ? theme.accent : .clear, lineWidth: 2))
                                }
                                .buttonStyle(.plain).accessibilityLabel(color.label)
                            }
                        }
                        if tool == .text {
                            TextField("Label text", text: $label).textFieldStyle(.roundedBorder).frame(width: 200)
                        }
                        if selection != nil { Button("Delete selected", role: .destructive, action: deleteSelection) }
                        Button("Clear", role: .destructive) { mutate { $0.elements.removeAll() }; selection = nil }.disabled(draft.elements.isEmpty)
                    }
                }
                Text(hint).font(.caption).foregroundStyle(theme.secondary)
                GeometryReader { geometry in
                    DrawingSurface(document: draft, theme: theme, activeElement: activeElement, selection: selection, showGrid: true)
                        .contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 0)
                            .onChanged { changed($0, size: geometry.size) }
                            .onEnded { ended($0, size: geometry.size) })
                }
                .aspectRatio(DrawingDocument.worldWidth / DrawingDocument.worldHeight, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(theme.secondary.opacity(0.4)))
                .accessibilityLabel("Drawing canvas with \(draft.elements.count) elements")
                Text("\(draft.elements.count) elements").font(.caption).foregroundStyle(theme.secondary)
            }
            .padding(16)
            .background(theme.canvas)
            .navigationTitle("Drawing")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                ToolbarItemGroup(placement: .automatic) {
                    Button(action: undo) { Image(systemName: "arrow.uturn.backward") }.disabled(undoStack.isEmpty).accessibilityLabel("Undo")
                    Button(action: redo) { Image(systemName: "arrow.uturn.forward") }.disabled(redoStack.isEmpty).accessibilityLabel("Redo")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var updated = component
                        updated.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
                        if updated.title.isEmpty { updated.title = "Drawing" }
                        updated.drawing = draft
                        onSave(updated)
                    }
                    .disabled(draft.elements.count > 2_000)
                }
            }
        }
    }

    private var hint: String {
        switch tool {
        case .select: "Tap a shape to select it. Drag to move."
        case .text: "Type a label, then tap to place it."
        case .pen: "Drag to sketch freely."
        case .rectangle: "Drag to draw a rectangle."
        default: "Drag to draw an \(tool.label.lowercased())."
        }
    }

    private func changed(_ value: DragGesture.Value, size: CGSize) {
        let transform = DrawingTransform(size: size)
        let start = transform.worldPoint(value.startLocation)
        let current = transform.worldPoint(value.location)
        if gestureStart == nil {
            gestureStart = draft
            if tool == .select {
                moveOriginal = draft.elements.last { $0.contains(start) }
                selection = moveOriginal?.id
            } else if let kind = tool.kind {
                activeElement = DrawingElement(kind: kind, ink: ink, points: [DrawingPoint(x: start.x, y: start.y)], text: label)
            }
        }
        if tool == .select, let original = moveOriginal, let index = draft.elements.firstIndex(where: { $0.id == original.id }) {
            draft.elements[index] = original.moved(dx: current.x - start.x, dy: current.y - start.y)
        } else if tool == .pen {
            if let last = activeElement?.points.last, hypot(last.x - current.x, last.y - current.y) > 1.5 {
                activeElement?.points.append(DrawingPoint(x: current.x, y: current.y))
            }
        } else if tool != .text, tool != .select {
            activeElement?.points = [DrawingPoint(x: start.x, y: start.y), DrawingPoint(x: current.x, y: current.y)]
        }
    }

    private func ended(_ value: DragGesture.Value, size: CGSize) {
        changed(value, size: size)
        if let element = activeElement {
            let meaningful = element.kind == .pen
                || (element.kind == .text && !element.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                || (element.kind != .text && max(element.bounds.width, element.bounds.height) > 3)
            if meaningful { draft.elements.append(element) }
        }
        if let before = gestureStart, before != draft { remember(before) }
        activeElement = nil
        gestureStart = nil
        moveOriginal = nil
    }

    private func mutate(_ edit: (inout DrawingDocument) -> Void) {
        let before = draft
        edit(&draft)
        if before != draft { remember(before) }
    }

    private func remember(_ document: DrawingDocument) {
        undoStack.append(document)
        if undoStack.count > 100 { undoStack.removeFirst() }
        redoStack.removeAll()
    }

    private func deleteSelection() {
        guard let selection else { return }
        mutate { $0.elements.removeAll { $0.id == selection } }
        self.selection = nil
    }

    private func undo() {
        guard let previous = undoStack.popLast() else { return }
        redoStack.append(draft)
        draft = previous
        selection = nil
    }

    private func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(draft)
        draft = next
        selection = nil
    }
}
