import SwiftUI

private enum DrawingTool: String, CaseIterable, Identifiable {
    case select, pen, rectangle, ellipse, arrow, text
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var symbol: String {
        switch self {
        case .select: return "cursorarrow"
        case .pen: return "pencil.tip"
        case .rectangle: return "rectangle"
        case .ellipse: return "circle"
        case .arrow: return "arrow.up.right"
        case .text: return "textformat"
        }
    }
    var kind: DrawingElement.Kind? { DrawingElement.Kind(rawValue: rawValue) }
}

struct DrawingEditor: View {
    @State private var draft: DrawingDocument
    @State private var tool: DrawingTool = .pen
    @State private var ink: DrawingInk = .graphite
    @State private var label = "A new thought"
    @State private var activeElement: DrawingElement?
    @State private var selection: UUID?
    @State private var gestureStart: DrawingDocument?
    @State private var moveOriginal: DrawingElement?
    @State private var undoStack: [DrawingDocument] = []
    @State private var redoStack: [DrawingDocument] = []
    let onSave: (DrawingDocument) -> Void
    let onCancel: () -> Void

    init(document: DrawingDocument, onSave: @escaping (DrawingDocument) -> Void,
         onCancel: @escaping () -> Void) {
        _draft = State(initialValue: document)
        self.onSave = onSave
        self.onCancel = onCancel
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("Drawing").font(.title2.weight(.semibold))
                Spacer()
                Text("A little room to think visually.").foregroundStyle(.secondary)
            }
            HStack(spacing: 14) {
                Picker("Tool", selection: $tool) {
                    ForEach(DrawingTool.allCases) { tool in
                        Image(systemName: tool.symbol).tag(tool).help(tool.label)
                            .accessibilityLabel(tool.label)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 310)
                .onChange(of: tool) { _, _ in selection = nil }
                HStack(spacing: 7) {
                    ForEach(DrawingInk.allCases) { color in
                        Button { ink = color } label: {
                            Circle().fill(color.color).frame(width: 18, height: 18)
                                .padding(4)
                                .overlay(Circle().strokeBorder(ink == color ? Color.accentColor : .clear, lineWidth: 2))
                        }
                        .buttonStyle(.plain).help(color.label).accessibilityLabel(color.label)
                    }
                }
                Spacer()
                Button(action: undo) { Image(systemName: "arrow.uturn.backward") }
                    .disabled(undoStack.isEmpty).help("Undo").keyboardShortcut("z", modifiers: .command)
                Button(action: redo) { Image(systemName: "arrow.uturn.forward") }
                    .disabled(redoStack.isEmpty).help("Redo").keyboardShortcut("z", modifiers: [.command, .shift])
                Button("Clear") { mutate { $0.elements.removeAll() }; selection = nil }
                    .disabled(draft.elements.isEmpty)
            }
            HStack {
                Text(hint).font(.callout).foregroundStyle(.secondary)
                Spacer()
                if tool == .text {
                    TextField("Label text", text: $label).frame(width: 230)
                        .textFieldStyle(.roundedBorder)
                }
                if selection != nil {
                    Button("Delete selected", role: .destructive, action: deleteSelection)
                }
            }
            .frame(height: 26)
            GeometryReader { geometry in
                DrawingSurface(document: draft, activeElement: activeElement, selection: selection, showGrid: true)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { changed($0, size: geometry.size) }
                        .onEnded { ended($0, size: geometry.size) })
                    .onDeleteCommand(perform: deleteSelection)
            }
            .frame(height: 420)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
            HStack {
                Text("\(draft.elements.count) elements").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                Button("Save Drawing") { onSave(draft) }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 940, height: 650)
    }

    private var hint: String {
        switch tool {
        case .select: return "Click a shape to select it. Drag to move."
        case .text: return "Type a label, then click to place it."
        case .pen: return "Click and drag to sketch freely."
        case .rectangle: return "Click and drag to draw a rectangle."
        default: return "Click and drag to draw an \(tool.label.lowercased())."
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
                activeElement = DrawingElement(kind: kind, ink: ink, points: [DrawingPoint(start)], text: label)
            }
        }
        if tool == .select, let original = moveOriginal,
           let index = draft.elements.firstIndex(where: { $0.id == original.id }) {
            draft.elements[index] = original.moved(by: CGSize(width: current.x - start.x, height: current.y - start.y))
        } else if tool == .pen {
            if let last = activeElement?.points.last,
               hypot(last.x - current.x, last.y - current.y) > 1.5 {
                activeElement?.points.append(DrawingPoint(current))
            }
        } else if tool != .text, tool != .select {
            activeElement?.points = [DrawingPoint(start), DrawingPoint(current)]
        }
    }

    private func ended(_ value: DragGesture.Value, size: CGSize) {
        changed(value, size: size)
        if let element = activeElement {
            let isMeaningful = element.kind == .pen || (element.kind == .text && !element.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                || (element.kind != .text && max(element.bounds.width, element.bounds.height) > 3)
            if isMeaningful { draft.elements.append(element) }
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
