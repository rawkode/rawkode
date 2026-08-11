// CanvasEditorView.swift
// EnchiridionCanvas
//
// The SwiftUI drawing surface itself — `Canvas`/`Path` + gesture
// recognizers, per the task's explicit constraint: "PencilKit is
// iOS-only; this app targets macOS too. Build the renderer on SwiftUI's
// `Canvas`/`Path` + gesture recognizers (`DragGesture` at minimum), not
// PencilKit." No `import PencilKit` anywhere in this module.
//
// CROSS-PLATFORM GESTURE DESIGN (see `CanvasEditorViewModel.swift`'s
// header for the drag-gesture half of this reasoning):
//   - Drawing (pen/rectangle/ellipse/line/arrow): one `DragGesture
//     (minimumDistance: 0)` attached to the drawing surface. Fires
//     identically for a finger drag, an Apple Pencil drag, or a
//     mouse-button-down-drag — SwiftUI's `DragGesture` already abstracts
//     over iOS touch/pencil and macOS mouse input at this level, so
//     there is no `#if os(iOS)`/`#if os(macOS)` branch in the gesture
//     wiring itself.
//   - Zoom: `MagnificationGesture`, which maps to a pinch (iOS/iPadOS
//     touch, or trackpad pinch on macOS) on both platforms without
//     platform-specific code.
//   - Pan: routed through an explicit `.pan` tool (same convention
//     Excalidraw/Freeform use) rather than trying to infer "this
//     single-touch drag means pan, not draw" from input characteristics
//     alone — Apple Pencil vs. finger vs. mouse have no single reliable
//     signal for that distinction across both platforms (a mouse has no
//     "number of touch points" to disambiguate from a trackpad two-finger
//     pan the way iOS can), so an explicit mode switch is the honest,
//     robust choice rather than a heuristic that would behave
//     inconsistently per platform/input device.
//   - Text: tap-to-place (`.onTapGesture`) then an inline `TextField`
//     overlay — text entry itself is standard platform text input
//     (the system keyboard on iOS, a hardware/software keyboard on
//     macOS), not something this module reimplements.
//
// TESTABILITY NOTE (matches this codebase's existing convention — see
// e.g. `EnchiridionUITests`' header: "Visual/interaction behavior ...
// is out of reach for a plain `swift test` run and is not covered
// here"): this file's gesture WIRING (translating a `DragGesture`
// callback into calls on `CanvasEditorViewModel`) has no simulator/host
// app in this environment to drive it, so it is exercised by compilation
// only. The interaction LOGIC those callbacks delegate to
// (`beginStroke`/`updateStroke`/`endStroke`/tool switching/undo/redo) is
// the part `CanvasEditorViewModel.swift` deliberately keeps SwiftUI-free
// specifically so `Tests/EnchiridionCanvasTests/
// CanvasEditorViewModelTests.swift` CAN exercise it directly.

import SwiftUI

/// The full canvas editor: toolbar + drawing surface + pan/zoom, over a
/// `CanvasEditorViewModel`. Embeddable directly in a page (per the task
/// brief: "a native SwiftUI drawing canvas ... that can be embedded in a
/// page") — this view owns no navigation chrome of its own (no
/// `NavigationStack`/toolbar-placement assumptions), so a host page can
/// drop it into whatever container it wants.
public struct CanvasEditorView: View {
  @Bindable private var viewModel: CanvasEditorViewModel

  @State private var scale: CGFloat = 1
  @State private var offset: CGSize = .zero
  @GestureState private var magnifyBy: CGFloat = 1
  @GestureState private var panTranslation: CGSize = .zero

  @State private var pendingTextEntry: PendingTextEntry?

  public init(viewModel: CanvasEditorViewModel) {
    self.viewModel = viewModel
  }

  public var body: some View {
    VStack(spacing: 0) {
      toolbar
      Divider()
      drawingSurface
    }
  }

  // MARK: - Toolbar

  private var toolbar: some View {
    HStack(spacing: 12) {
      Picker("Tool", selection: $viewModel.activeTool) {
        ForEach(CanvasTool.allCases) { tool in
          Text(tool.displayName).tag(tool)
        }
      }
      .pickerStyle(.segmented)

      Spacer(minLength: 8)

      Button {
        viewModel.undo()
      } label: {
        Label("Undo", systemImage: "arrow.uturn.backward")
      }
      .disabled(!viewModel.canUndo)

      Button {
        viewModel.redo()
      } label: {
        Label("Redo", systemImage: "arrow.uturn.forward")
      }
      .disabled(!viewModel.canRedo)
    }
    .labelStyle(.iconOnly)
    .padding(8)
  }

  // MARK: - Drawing surface

  private var drawingSurface: some View {
    GeometryReader { _ in
      ZStack(alignment: .topLeading) {
        Canvas { context, _ in
          for element in viewModel.elements {
            draw(element, in: &context)
          }
          if let draft = viewModel.draftElement {
            draw(draft, in: &context)
          }
        }
        .frame(width: viewModel.canvasSize.width, height: viewModel.canvasSize.height)
        .background(Color.white)
        .gesture(drawingGesture)
        .simultaneousGesture(textPlacementGesture)
        .simultaneousGesture(panGesture)

        if let pending = pendingTextEntry {
          TextField(
            "Text", text: Binding(
              get: { pending.text },
              set: { pendingTextEntry?.text = $0 }
            )
          )
          .textFieldStyle(.plain)
          .padding(4)
          .background(Color.white)
          .border(Color.accentColor)
          .position(x: pending.point.x, y: pending.point.y)
          .onSubmit {
            viewModel.commitText(pending.text, at: pending.point)
            pendingTextEntry = nil
          }
        }
      }
      .scaleEffect(scale * magnifyBy, anchor: .topLeading)
      .offset(
        x: offset.width + (viewModel.activeTool == .pan ? panTranslation.width : 0),
        y: offset.height + (viewModel.activeTool == .pan ? panTranslation.height : 0)
      )
    }
    .clipped()
    .gesture(magnificationGesture)
  }

  // MARK: - Gestures

  /// Drives element creation for every drawing tool. `.pan`/`.select`/
  /// `.text` are excluded up front — `.pan` gets its own gesture below
  /// (updating `offset` instead of the document), `.select` has no
  /// wired behavior yet (see `CanvasTool.select`'s doc comment), and
  /// `.text` commits via the tap gesture + inline `TextField` above, not
  /// a drag.
  private var drawingGesture: some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .local)
      .onChanged { value in
        guard Self.isDraftTool(viewModel.activeTool) else { return }
        let point = CanvasPoint(x: value.location.x, y: value.location.y)
        if viewModel.draftElement == nil {
          viewModel.beginStroke(at: point)
        } else {
          viewModel.updateStroke(to: point)
        }
      }
      .onEnded { _ in
        guard Self.isDraftTool(viewModel.activeTool) else { return }
        viewModel.endStroke()
      }
  }

  /// Places a new text element at the tapped point — a `SpatialTapGesture`
  /// (not the location-less `.onTapGesture(perform:)`) so the placement
  /// point is available at all. Attached via `.simultaneousGesture` so it
  /// never competes for exclusivity with `drawingGesture` on the same
  /// view; both are effectively mutually exclusive anyway by tool
  /// (`drawingGesture`'s handlers no-op when `activeTool == .text`, and
  /// this one no-ops otherwise).
  private var textPlacementGesture: some Gesture {
    SpatialTapGesture()
      .onEnded { value in
        guard viewModel.activeTool == .text else { return }
        pendingTextEntry = PendingTextEntry(
          point: CanvasPoint(x: value.location.x, y: value.location.y), text: "")
      }
  }

  /// Pans the viewport while the `.pan` tool is active. A second
  /// `DragGesture` on the same drawing surface as `drawingGesture`,
  /// gated by tool so exactly one of the two ever has an effect for any
  /// given drag — see this file's header on why panning is an explicit
  /// tool rather than an implicit single-touch heuristic.
  ///
  /// Task #92 (adversarial-review finding, MEDIUM) fix — COORDINATE-SPACE
  /// MISMATCH between this gesture's `translation` and `offset`:
  ///   - This `DragGesture` uses `coordinateSpace: .local`, and is
  ///     attached (via `.gesture`/`.simultaneousGesture` on `Canvas`,
  ///     above) to a view that sits INSIDE `.scaleEffect(scale *
  ///     magnifyBy, ...)` in `drawingSurface`'s modifier chain below.
  ///     SwiftUI maps a touch/pointer's physical position through the
  ///     inverse of any ancestor `scaleEffect` before reporting it to a
  ///     gesture on the scaled subtree, so at zoom `Z` a `D`-physical-point
  ///     drag reports `value.translation` of `D / Z` points here — already
  ///     inverse-scaled, which is exactly what `drawingGesture` above
  ///     wants (canvas-space stroke coordinates independent of zoom).
  ///   - `offset`, by contrast, is applied via `.offset(...)` chained
  ///     AFTER (outside) that same `.scaleEffect(...)` — i.e. it moves the
  ///     already-scaled content around in the PARENT's coordinate space,
  ///     one `offset` point per physical screen point, un-scaled.
  ///   Accumulating the raw (inverse-scaled) `translation` straight into
  ///   `offset` therefore under-shoots the finger/pointer at zoom > 1
  ///   (sluggish) and over-shoots at zoom < 1 (too fast), compounding
  ///   across repeated pans at different zoom levels since it accumulates
  ///   into persistent `@State`. Multiplying the translation by the
  ///   CURRENT `scale` before it reaches `offset` converts it back into
  ///   the same screen-space unit `offset` is defined in, so panning
  ///   tracks 1:1 regardless of zoom. Uses the committed `scale`, not
  ///   `scale * magnifyBy` — `panGesture` and `magnificationGesture` are
  ///   single-touch-drag vs. pinch respectively (this file's header), so
  ///   they don't meaningfully co-occur; using the live composite would
  ///   double-count zoom in the one edge case they did.
  private var panGesture: some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .local)
      .updating($panTranslation) { value, state, _ in
        guard viewModel.activeTool == .pan else { return }
        state = Self.panOffsetDelta(translation: value.translation, scale: scale)
      }
      .onEnded { value in
        guard viewModel.activeTool == .pan else { return }
        let delta = Self.panOffsetDelta(translation: value.translation, scale: scale)
        offset.width += delta.width
        offset.height += delta.height
      }
  }

  /// The pure coordinate-space conversion `panGesture` needs (see its doc
  /// comment above for the full reasoning) — factored out specifically so
  /// it's unit-testable without a live `DragGesture`/host app, matching
  /// this file's header's note that the gesture WIRING itself has no such
  /// coverage in this environment, unlike the pure math it delegates to.
  static func panOffsetDelta(translation: CGSize, scale: CGFloat) -> CGSize {
    CGSize(width: translation.width * scale, height: translation.height * scale)
  }

  private var magnificationGesture: some Gesture {
    MagnificationGesture()
      .updating($magnifyBy) { value, state, _ in
        state = value
      }
      .onEnded { value in
        scale = max(0.1, min(8, scale * value))
      }
  }

  private static func isDraftTool(_ tool: CanvasTool) -> Bool {
    switch tool {
    case .pen, .rectangle, .ellipse, .line, .arrow: true
    case .select, .pan, .text: false
    }
  }

  // MARK: - Rendering

  private func draw(_ element: CanvasElement, in context: inout GraphicsContext) {
    switch element {
    case .stroke(let stroke):
      guard let style = element.style else { return }
      var path = Path()
      guard let first = stroke.points.first else { return }
      path.move(to: CGPoint(x: first.x, y: first.y))
      for point in stroke.points.dropFirst() {
        path.addLine(to: CGPoint(x: point.x, y: point.y))
      }
      context.stroke(
        path, with: .color(style.strokeColor.swiftUIColor),
        style: StrokeStyle(lineWidth: style.lineWidth, lineCap: .round, lineJoin: .round))

    case .rectangle(let shape):
      let rect = CGRect(x: shape.origin.x, y: shape.origin.y, width: shape.size.width, height: shape.size.height)
      let path = Path(rect)
      draw(path, style: shape.style, in: &context)

    case .ellipse(let shape):
      let rect = CGRect(x: shape.origin.x, y: shape.origin.y, width: shape.size.width, height: shape.size.height)
      let path = Path(ellipseIn: rect)
      draw(path, style: shape.style, in: &context)

    case .line(let segment):
      var path = Path()
      path.move(to: CGPoint(x: segment.start.x, y: segment.start.y))
      path.addLine(to: CGPoint(x: segment.end.x, y: segment.end.y))
      context.stroke(
        path, with: .color(segment.style.strokeColor.swiftUIColor),
        style: StrokeStyle(lineWidth: segment.style.lineWidth, lineCap: .round))

    case .arrow(let segment):
      var path = Path()
      path.move(to: CGPoint(x: segment.start.x, y: segment.start.y))
      path.addLine(to: CGPoint(x: segment.end.x, y: segment.end.y))
      path.addPath(Self.arrowheadPath(from: segment.start, to: segment.end))
      context.stroke(
        path, with: .color(segment.style.strokeColor.swiftUIColor),
        style: StrokeStyle(lineWidth: segment.style.lineWidth, lineCap: .round, lineJoin: .round))

    case .text(let text):
      let resolved = context.resolve(
        Text(text.content).font(.system(size: text.fontSize)).foregroundColor(text.color.swiftUIColor))
      context.draw(resolved, at: CGPoint(x: text.position.x, y: text.position.y), anchor: .topLeading)
    }
  }

  private func draw(_ path: Path, style: CanvasStrokeStyle, in context: inout GraphicsContext) {
    if let fillColor = style.fillColor {
      context.fill(path, with: .color(fillColor.swiftUIColor))
    }
    context.stroke(
      path, with: .color(style.strokeColor.swiftUIColor),
      style: StrokeStyle(lineWidth: style.lineWidth, lineCap: .round, lineJoin: .round))
  }

  /// A simple two-stroke arrowhead at `end`, angled back from the line
  /// direction — the plain-point-pair arrow this module implements (no
  /// shape binding — see `CanvasLineSegment`'s doc comment).
  private static func arrowheadPath(from start: CanvasPoint, to end: CanvasPoint) -> Path {
    let dx = end.x - start.x
    let dy = end.y - start.y
    let length = (dx * dx + dy * dy).squareRoot()
    guard length > 0 else { return Path() }
    let angle = atan2(dy, dx)
    let headLength: Double = 12
    let headAngle: Double = .pi / 7

    let leftAngle = angle + .pi - headAngle
    let rightAngle = angle + .pi + headAngle
    let left = CGPoint(x: end.x + headLength * cos(leftAngle), y: end.y + headLength * sin(leftAngle))
    let right = CGPoint(x: end.x + headLength * cos(rightAngle), y: end.y + headLength * sin(rightAngle))

    var path = Path()
    path.move(to: left)
    path.addLine(to: CGPoint(x: end.x, y: end.y))
    path.addLine(to: right)
    return path
  }
}

/// A tap-to-place text entry awaiting its content, before it's committed
/// to the document as a `CanvasElement.text`.
private struct PendingTextEntry {
  var point: CanvasPoint
  var text: String
}

extension CanvasColor {
  /// Parses this `#rrggbbaa` hex string into a SwiftUI `Color`. Falls back
  /// to opaque black for a malformed string (never crashes on bad data —
  /// e.g. a hand-edited/corrupted blob) rather than throwing, since this
  /// is a rendering-time convenience, not a validating parser.
  public var swiftUIColor: Color {
    let hex = rawValue.hasPrefix("#") ? String(rawValue.dropFirst()) : rawValue
    guard hex.count == 8, let value = UInt64(hex, radix: 16) else { return .black }
    let r = Double((value >> 24) & 0xFF) / 255
    let g = Double((value >> 16) & 0xFF) / 255
    let b = Double((value >> 8) & 0xFF) / 255
    let a = Double(value & 0xFF) / 255
    return Color(red: r, green: g, blue: b, opacity: a)
  }
}
