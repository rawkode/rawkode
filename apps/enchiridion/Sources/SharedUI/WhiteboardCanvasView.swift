import EnchiridionCore
import SwiftUI

@MainActor
struct WhiteboardCanvasView: View {
  let store: LibraryStore
  let definition: LiveQueryDefinition
  let items: [LiveQueryItem]
  let openPage: (PageID) -> Void

  @State private var workingDocument: WhiteboardDocument
  @State private var activeTool: WhiteboardTool = .select
  @State private var selection: Set<WhiteboardElementID> = []
  @State private var undoStack: [WhiteboardDocument] = []
  @State private var redoStack: [WhiteboardDocument] = []
  @State private var draft: WhiteboardElement?
  @State private var draftPoints: [WhiteboardPoint] = []
  @State private var transientPan: CGSize = .zero
  @State private var gestureMagnification: CGFloat = 1
  @State private var isMagnifying = false
  @State private var suppressDragUntil = Date.distantPast
  @State private var moveBaseline: WhiteboardDocument?
  @State private var deferredDocument: WhiteboardDocument?
  @State private var isPersisting = false
  @State private var showingHelp = false
  @State private var editingElementID: WhiteboardElementID?
  @State private var editingText = ""
  @State private var dismissedError: String?
  @FocusState private var canvasIsFocused: Bool

  init(
    store: LibraryStore,
    definition: LiveQueryDefinition,
    items: [LiveQueryItem],
    openPage: @escaping (PageID) -> Void
  ) {
    self.store = store
    self.definition = definition
    self.items = items
    self.openPage = openPage
    _workingDocument = State(initialValue: store.whiteboardDocuments[definition.id] ?? .empty)
  }

  var body: some View {
    GeometryReader { proxy in
      let size = proxy.size
      let camera = camera
      let displayElements = visibleElements
      let renderedElements = onscreenElements(displayElements, in: size, camera: camera)
      let pageIndex = pagesByID
      ZStack {
        ZStack {
          ZStack {
            Color(white: 0.975)
              .contentShape(Rectangle())

            WhiteboardDrawingLayer(
              elements: renderedElements,
              draft: draft,
              selectedIDs: selection,
              camera: camera
            )

            if displayElements.isEmpty, draft == nil {
              WhiteboardEmptyState()
                .allowsHitTesting(false)
            }
          }
          .gesture(canvasDragGesture(in: size))

          ForEach(renderedElements) { element in
            WhiteboardElementOverlay(
              element: element,
              page: page(for: element, in: pageIndex),
              screenRect: camera.screenRect(for: element.bounds, in: size),
              zoom: camera.zoom,
              isSelected: selection.contains(element.id),
              select: { additive in select(element.id, additive: additive) },
              moveChanged: { moveChanged(element.id, delta: $0) },
              moveEnded: { moveEnded(delta: $0) },
              nudge: { nudge(element.id, by: $0) },
              delete: { deleteElements([element.id]) },
              editText: { beginEditing(element) },
              openPage: openPage,
              disconnect: { disconnect(element.id, endpoint: $0) }
            )
            .zIndex(Double(element.zIndex + 1))
          }
          .allowsHitTesting(activeTool == .select && !isPersisting)
        }
        .simultaneousGesture(magnificationGesture(in: size))

        chrome(size: size)
      }
      .coordinateSpace(name: "whiteboard-canvas")
      .clipped()
      .focusable()
      .focused($canvasIsFocused)
      .onTapGesture { canvasIsFocused = true }
      .onKeyPress(phases: .down, action: handleKeyPress)
      .task(id: pageIDSignature) { await reconcilePageCards() }
      .onChange(of: store.whiteboardDocuments[definition.id]) { _, document in
        guard let document else { return }
        receive(document)
      }
      .onChange(of: store.whiteboardError) { _, error in
        guard error != nil else { return }
        isPersisting = false
        workingDocument = store.whiteboardDocuments[definition.id] ?? workingDocument
        dismissedError = nil
      }
      .alert("Edit Canvas Text", isPresented: editingTextIsPresented) {
        TextField("Text", text: $editingText, axis: .vertical)
        Button("Cancel", role: .cancel) { editingElementID = nil }
        Button("Save Text") { saveEditedText() }
      } message: {
        Text("Text stays private with this saved view.")
      }
    }
    .background(Color(white: 0.975))
  }

  private var camera: WhiteboardCamera {
    var viewport = workingDocument.viewport
    viewport.zoom = min(
      max(viewport.zoom * Double(gestureMagnification), WhiteboardLimits.minimumZoom),
      WhiteboardLimits.maximumZoom
    )
    return WhiteboardCamera(viewport: viewport, transientPan: transientPan)
  }

  private var pageIDs: [PageID] {
    items.compactMap { item in
      guard case .page(let page) = item else { return nil }
      return page.id
    }
  }

  private var displayedPageIDs: [PageID] {
    Array(pageIDs.prefix(WhiteboardLimits.maximumPageCards))
  }

  private var displayedPageIDSet: Set<PageID> { Set(displayedPageIDs) }

  private var visibleElements: [WhiteboardElement] {
    let filtered = workingDocument.elements.filter { element in
      guard case .page(let pageID) = element.kind else { return true }
      return displayedPageIDSet.contains(pageID)
    }
    let boundsByID = Dictionary(uniqueKeysWithValues: filtered.map { ($0.id, $0.bounds) })
    return filtered.map { element in
      guard case .arrow(var arrow) = element.kind else { return element }
      if let start = arrow.start, let bounds = boundsByID[start.elementID], !arrow.points.isEmpty {
        arrow.points[0] = anchoredPoint(start.anchor, in: bounds)
      }
      if let end = arrow.end, let bounds = boundsByID[end.elementID], !arrow.points.isEmpty {
        arrow.points[arrow.points.count - 1] = anchoredPoint(end.anchor, in: bounds)
      }
      var resolved = element
      resolved.kind = .arrow(arrow)
      resolved.bounds = bounds(containing: arrow.points)
      return resolved
    }
  }

  private var pagesByID: [PageID: PageSnapshot] {
    Dictionary(uniqueKeysWithValues: store.pages.map { ($0.id, $0) })
  }

  private var pageIDSignature: String {
    displayedPageIDs.map(\.rawValue).joined(separator: "\u{0}")
  }

  private var editingTextIsPresented: Binding<Bool> {
    Binding(
      get: { editingElementID != nil },
      set: { if !$0 { editingElementID = nil } }
    )
  }

  @ViewBuilder
  private func chrome(size: CGSize) -> some View {
    VStack(spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        WhiteboardToolPalette(selection: $activeTool)
        Spacer(minLength: 8)
        WhiteboardHistoryControls(
          canUndo: !undoStack.isEmpty && !isPersisting,
          canRedo: !redoStack.isEmpty && !isPersisting,
          canDelete: canDeleteSelection && !isPersisting,
          undo: undo,
          redo: redo,
          delete: deleteSelection
        )
        Button { showingHelp.toggle() } label: {
          Label("Canvas Help", systemImage: "questionmark.circle")
            .labelStyle(.iconOnly)
            .frame(minWidth: chromeControlSize, minHeight: chromeControlSize)
        }
        .buttonStyle(.plain)
        .padding(4)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .help("Canvas Help")
      }

      HStack(alignment: .top) {
        if let error = presentedError {
          WhiteboardNotice(
            title: "Canvas change was not saved",
            message: error,
            systemImage: "exclamationmark.triangle",
            dismiss: { dismissedError = error }
          )
        } else if pageIDs.count > WhiteboardLimits.maximumPageCards {
          WhiteboardNotice(
            title: "Showing the first \(WhiteboardLimits.maximumPageCards) pages",
            message: "Refine this live view to place a different set of page cards. Drawings are unaffected.",
            systemImage: "rectangle.stack.badge.exclamationmark",
            dismiss: nil
          )
        }
        Spacer()
        if showingHelp {
          WhiteboardHelpCard { showingHelp = false }
        }
      }

      Spacer()

      HStack {
        Text(activeTool.help)
          .font(.caption)
          .foregroundStyle(Color.black.opacity(0.62))
          .padding(.horizontal, 9)
          .padding(.vertical, 6)
          .background(Color.white.opacity(0.88), in: Capsule())
        Spacer()
        WhiteboardViewControls(
          zoom: camera.zoom,
          zoomOut: { setZoom(camera.zoom - 0.15) },
          zoomIn: { setZoom(camera.zoom + 0.15) },
          setZoom: setZoom,
          resetView: resetView,
          fitAll: { fitAll(in: size) },
          arrangeCards: arrangePageCards
        )
      }
    }
    .padding(12)
    .zIndex(10_000)
  }

  private var chromeControlSize: CGFloat {
    #if os(iOS)
    44
    #else
    28
    #endif
  }

  private var presentedError: String? {
    guard let error = store.whiteboardError, error != dismissedError else { return nil }
    return error
  }

  private var canDeleteSelection: Bool {
    selection.contains { id in
      guard let element = workingDocument.element(id: id) else { return false }
      if case .page = element.kind { return false }
      return true
    }
  }

  private func onscreenElements(
    _ elements: [WhiteboardElement],
    in size: CGSize,
    camera: WhiteboardCamera
  ) -> [WhiteboardElement] {
    let viewport = CGRect(origin: .zero, size: size).insetBy(dx: -220, dy: -220)
    return elements.filter { viewport.intersects(camera.screenRect(for: $0.bounds, in: size)) }
  }

  private func page(
    for element: WhiteboardElement,
    in pagesByID: [PageID: PageSnapshot]
  ) -> PageSnapshot? {
    guard case .page(let pageID) = element.kind else { return nil }
    return pagesByID[pageID]
  }

  private func reconcilePageCards() async {
    let existing = Set(workingDocument.elements.compactMap { element -> PageID? in
      guard case .page(let pageID) = element.kind else { return nil }
      return pageID
    })
    guard !Set(displayedPageIDs).isSubset(of: existing), !isPersisting else { return }
    isPersisting = true
    let receipt = await performMutation(recordHistory: false) { revision in
      await store.reconcileWhiteboardPageCards(
        displayedPageIDs,
        in: definition.id,
        expectedRevision: revision
      )
    }
    if let receipt, receipt.after.revision != receipt.before.revision {
      // Query membership is authoritative. Clear session history so undo cannot restore a
      // pre-reconcile document that omits a required, intentionally non-deletable page card.
      undoStack.removeAll()
      redoStack.removeAll()
    }
  }

  private func canvasDragGesture(in size: CGSize) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .named("whiteboard-canvas"))
      .onChanged { value in
        canvasIsFocused = true
        guard !isPersisting, !isMagnifying, Date() >= suppressDragUntil else { return }
        switch activeTool {
        case .select:
          if value.translation == .zero { selection.removeAll() }
        case .hand:
          transientPan = value.translation
        case .pen:
          updateFreehandDraft(at: camera.canvasPoint(for: value.location, in: size))
        case .rectangle, .ellipse, .diamond, .arrow:
          updateShapeDraft(from: value.startLocation, to: value.location, in: size)
        case .text, .sticky:
          break
        }
      }
      .onEnded { value in
        let wasSuppressed = isMagnifying || Date() < suppressDragUntil
        if wasSuppressed || isPersisting {
          cancelTransientDrag()
          return
        }
        switch activeTool {
        case .select:
          selection.removeAll()
        case .hand:
          finishPan(value.translation)
        case .pen, .rectangle, .ellipse, .diamond, .arrow:
          commitDraft()
        case .text, .sticky:
          createTextElement(at: camera.canvasPoint(for: value.location, in: size), tool: activeTool)
        }
      }
  }

  private func magnificationGesture(in size: CGSize) -> some Gesture {
    MagnifyGesture()
      .onChanged { value in
        guard !isPersisting else { return }
        if !isMagnifying {
          isMagnifying = true
          suppressDragUntil = .distantFuture
          cancelTransientDrag()
        }
        gestureMagnification = value.magnification
      }
      .onEnded { value in
        let requestedZoom = CGFloat(workingDocument.viewport.zoom) * value.magnification
        gestureMagnification = 1
        isMagnifying = false
        // DragGesture end delivery can follow MagnifyGesture end delivery. Keep the drag
        // suppressed briefly so pinch remains the sole owner of an overlapping interaction.
        suppressDragUntil = Date().addingTimeInterval(0.2)
        guard !isPersisting else { return }
        setZoom(requestedZoom)
      }
  }

  private func cancelTransientDrag() {
    transientPan = .zero
    draft = nil
    draftPoints.removeAll()
    if let moveBaseline {
      workingDocument = moveBaseline
      self.moveBaseline = nil
    }
  }

  private func updateFreehandDraft(at point: WhiteboardPoint) {
    if let last = draftPoints.last {
      let distance = hypot(point.x - last.x, point.y - last.y)
      guard distance >= max(1.5, 3 / camera.zoom) else { return }
    }
    if draftPoints.count >= WhiteboardLimits.maximumPointsPerElement / 2 {
      draftPoints = draftPoints.enumerated().compactMap { index, point in index.isMultiple(of: 2) ? point : nil }
    }
    draftPoints.append(point)
    guard draftPoints.count >= 2 else { return }
    draft = WhiteboardElement(
      kind: .freehand(draftPoints),
      bounds: bounds(containing: draftPoints),
      style: drawingStyle,
      zIndex: workingDocument.elements.count
    )
  }

  private func updateShapeDraft(from start: CGPoint, to end: CGPoint, in size: CGSize) {
    let startPoint = camera.canvasPoint(for: start, in: size)
    let endPoint = camera.canvasPoint(for: end, in: size)
    let elementBounds = bounds(from: startPoint, to: endPoint)
    let kind: WhiteboardElementKind
    switch activeTool {
    case .rectangle: kind = .rectangle
    case .ellipse: kind = .ellipse
    case .diamond: kind = .diamond
    case .arrow:
      kind = .arrow(
        WhiteboardArrow(
          points: [startPoint, endPoint],
          start: connectionEndpoint(at: startPoint),
          end: connectionEndpoint(at: endPoint)
        )
      )
    case .select, .hand, .pen, .text, .sticky:
      return
    }
    draft = WhiteboardElement(
      kind: kind,
      bounds: elementBounds,
      style: shapeStyle,
      zIndex: workingDocument.elements.count
    )
  }

  private func commitDraft() {
    guard var element = draft else {
      draftPoints.removeAll()
      return
    }
    draft = nil
    draftPoints.removeAll()
    let isValid: Bool
    switch element.kind {
    case .freehand(let points): isValid = pathDistance(points) >= 3
    case .arrow(let arrow): isValid = pathDistance(arrow.points) >= 3
    case .rectangle, .ellipse, .diamond:
      isValid = element.bounds.width >= 3 && element.bounds.height >= 3
    case .page, .text, .sticky:
      isValid = true
    }
    guard isValid else { return }
    element.zIndex = workingDocument.elements.count
    selection = [element.id]
    activeTool = .select
    startMutation {
      await performMutation(optimisticElements: [element]) { revision in
        await store.upsertWhiteboardElements([element], in: definition.id, expectedRevision: revision)
      }
    }
  }

  private func createTextElement(at point: WhiteboardPoint, tool: WhiteboardTool) {
    let isSticky = tool == .sticky
    let element = WhiteboardElement(
      kind: isSticky ? .sticky("Note") : .text("Text"),
      bounds: .init(x: point.x, y: point.y, width: isSticky ? 220 : 200, height: isSticky ? 150 : 64),
      style: WhiteboardStyle(
        strokeColor: "#1f2937",
        fillColor: isSticky ? "#fff3b0" : "#ffffff00",
        strokeWidth: 2,
        roughness: 0,
        fontSize: 18
      ),
      zIndex: workingDocument.elements.count
    )
    selection = [element.id]
    activeTool = .select
    startMutation {
      let receipt = await performMutation(optimisticElements: [element]) { revision in
        await store.upsertWhiteboardElements([element], in: definition.id, expectedRevision: revision)
      }
      if receipt != nil { beginEditing(element) }
    }
  }

  private var drawingStyle: WhiteboardStyle {
    WhiteboardStyle(strokeColor: "#334155", strokeWidth: 2.2, roughness: 0)
  }

  private var shapeStyle: WhiteboardStyle {
    WhiteboardStyle(
      strokeColor: "#334155",
      fillColor: "#eef2ff",
      strokeWidth: 2,
      roughness: 0
    )
  }

  private func bounds(from start: WhiteboardPoint, to end: WhiteboardPoint) -> WhiteboardBounds {
    let minX = min(start.x, end.x)
    let minY = min(start.y, end.y)
    return .init(
      x: minX,
      y: minY,
      width: max(abs(end.x - start.x), 1),
      height: max(abs(end.y - start.y), 1)
    )
  }

  private func bounds(containing points: [WhiteboardPoint]) -> WhiteboardBounds {
    guard let first = points.first else { return .init(x: 0, y: 0, width: 1, height: 1) }
    var minX = first.x
    var maxX = first.x
    var minY = first.y
    var maxY = first.y
    for point in points.dropFirst() {
      minX = min(minX, point.x)
      maxX = max(maxX, point.x)
      minY = min(minY, point.y)
      maxY = max(maxY, point.y)
    }
    return .init(x: minX, y: minY, width: max(maxX - minX, 1), height: max(maxY - minY, 1))
  }

  private func connectionEndpoint(at point: WhiteboardPoint) -> WhiteboardConnectionEndpoint? {
    guard let target = visibleElements.reversed().first(where: {
      guard case .arrow = $0.kind else {
        return point.x >= $0.bounds.minX && point.x <= $0.bounds.maxX
          && point.y >= $0.bounds.minY && point.y <= $0.bounds.maxY
      }
      return false
    }) else { return nil }
    return WhiteboardConnectionEndpoint(
      elementID: target.id,
      anchor: .init(
        x: min(max((point.x - target.bounds.x) / target.bounds.width, 0), 1),
        y: min(max((point.y - target.bounds.y) / target.bounds.height, 0), 1)
      )
    )
  }

  private func anchoredPoint(_ anchor: WhiteboardPoint, in bounds: WhiteboardBounds) -> WhiteboardPoint {
    .init(
      x: bounds.x + bounds.width * anchor.x,
      y: bounds.y + bounds.height * anchor.y
    )
  }

  private func pathDistance(_ points: [WhiteboardPoint]) -> Double {
    zip(points, points.dropFirst()).reduce(0) { distance, pair in
      distance + hypot(pair.1.x - pair.0.x, pair.1.y - pair.0.y)
    }
  }

  private func select(_ id: WhiteboardElementID, additive: Bool) {
    if additive {
      if !selection.insert(id).inserted { selection.remove(id) }
    } else {
      selection = [id]
    }
    canvasIsFocused = true
  }

  private func moveChanged(_ id: WhiteboardElementID, delta: CGSize) {
    guard !isPersisting, !isMagnifying, Date() >= suppressDragUntil else { return }
    if !selection.contains(id) { selection = [id] }
    if moveBaseline == nil { moveBaseline = workingDocument }
    guard let baseline = moveBaseline else { return }
    var preview = baseline
    preview.elements = baseline.elements.map { element in
      guard selection.contains(element.id) else { return element }
      return element.translated(x: Double(delta.width), y: Double(delta.height))
    }
    workingDocument = preview
  }

  private func moveEnded(delta: CGSize) {
    guard let baseline = moveBaseline else { return }
    moveBaseline = nil
    guard !isMagnifying, Date() >= suppressDragUntil, !isPersisting else {
      workingDocument = baseline
      return
    }
    let moves = selection.map {
      WhiteboardElementMove(elementID: $0, deltaX: Double(delta.width), deltaY: Double(delta.height))
    }
    guard !moves.isEmpty, delta != .zero else {
      workingDocument = baseline
      applyDeferredDocumentIfNeeded()
      return
    }
    let optimistic = workingDocument
    startMutation {
      await performMutation(from: baseline, optimistic: optimistic) { revision in
        await store.moveWhiteboardElements(moves, in: definition.id, expectedRevision: revision)
      }
    }
  }

  private func nudge(_ id: WhiteboardElementID, by delta: CGSize) {
    guard !isPersisting else { return }
    if !selection.contains(id) { selection = [id] }
    let moves = selection.map {
      WhiteboardElementMove(elementID: $0, deltaX: Double(delta.width), deltaY: Double(delta.height))
    }
    var optimistic = workingDocument
    optimistic.elements = optimistic.elements.map { element in
      guard selection.contains(element.id) else { return element }
      return element.translated(x: Double(delta.width), y: Double(delta.height))
    }
    startMutation {
      await performMutation(optimistic: optimistic) { revision in
        await store.moveWhiteboardElements(moves, in: definition.id, expectedRevision: revision)
      }
    }
  }

  private func deleteSelection() {
    deleteElements(selection)
  }

  private func deleteElements(_ ids: Set<WhiteboardElementID>) {
    let deletableIDs = ids.filter { id in
      guard let element = workingDocument.element(id: id) else { return false }
      if case .page = element.kind { return false }
      return true
    }
    guard !deletableIDs.isEmpty, !isPersisting else { return }
    var optimistic = workingDocument
    optimistic.elements.removeAll { deletableIDs.contains($0.id) }
    optimistic.normalizeElementOrder()
    selection.subtract(deletableIDs)
    startMutation {
      await performMutation(optimistic: optimistic) { revision in
        await store.deleteWhiteboardElements(Set(deletableIDs), in: definition.id, expectedRevision: revision)
      }
    }
  }

  private func disconnect(_ id: WhiteboardElementID, endpoint: WhiteboardArrowEndpoint) {
    guard !isPersisting else { return }
    var optimistic = workingDocument
    guard let index = optimistic.elements.firstIndex(where: { $0.id == id }),
      case .arrow(var arrow) = optimistic.elements[index].kind
    else { return }
    switch endpoint {
    case .start: arrow.start = nil
    case .end: arrow.end = nil
    }
    optimistic.elements[index].kind = .arrow(arrow)
    startMutation {
      await performMutation(optimistic: optimistic) { revision in
        await store.disconnectWhiteboardArrow(
          id,
          endpoint: endpoint,
          in: definition.id,
          expectedRevision: revision
        )
      }
    }
  }

  private func beginEditing(_ element: WhiteboardElement) {
    switch element.kind {
    case .text(let value), .sticky(let value):
      editingText = value
      editingElementID = element.id
    case .page, .freehand, .rectangle, .ellipse, .diamond, .arrow:
      break
    }
  }

  private func saveEditedText() {
    guard let id = editingElementID, !isPersisting,
      let index = workingDocument.elements.firstIndex(where: { $0.id == id })
    else {
      editingElementID = nil
      return
    }
    var element = workingDocument.elements[index]
    switch element.kind {
    case .text: element.kind = .text(editingText)
    case .sticky: element.kind = .sticky(editingText)
    case .page, .freehand, .rectangle, .ellipse, .diamond, .arrow:
      editingElementID = nil
      return
    }
    editingElementID = nil
    startMutation {
      await performMutation(optimisticElements: [element]) { revision in
        await store.upsertWhiteboardElements([element], in: definition.id, expectedRevision: revision)
      }
    }
  }

  @discardableResult
  private func performMutation(
    recordHistory: Bool = true,
    optimisticElements: [WhiteboardElement] = [],
    operation: @escaping (Int64) async -> WhiteboardMutationReceipt?
  ) async -> WhiteboardMutationReceipt? {
    var optimistic = workingDocument
    for element in optimisticElements {
      if let index = optimistic.elements.firstIndex(where: { $0.id == element.id }) {
        optimistic.elements[index] = element
      } else {
        optimistic.elements.append(element)
      }
    }
    optimistic.normalizeElementOrder()
    return await performMutation(
      from: workingDocument,
      optimistic: optimistic,
      recordHistory: recordHistory,
      operation: operation
    )
  }

  @discardableResult
  private func performMutation(
    optimistic: WhiteboardDocument,
    recordHistory: Bool = true,
    operation: @escaping (Int64) async -> WhiteboardMutationReceipt?
  ) async -> WhiteboardMutationReceipt? {
    await performMutation(
      from: workingDocument,
      optimistic: optimistic,
      recordHistory: recordHistory,
      operation: operation
    )
  }

  @discardableResult
  private func performMutation(
    from before: WhiteboardDocument,
    optimistic: WhiteboardDocument? = nil,
    recordHistory: Bool = true,
    operation: @escaping (Int64) async -> WhiteboardMutationReceipt?
  ) async -> WhiteboardMutationReceipt? {
    if var optimistic {
      optimistic.revision = before.revision + 1
      workingDocument = optimistic
    }
    let receipt = await operation(before.revision)
    isPersisting = false
    guard let receipt else {
      workingDocument = store.whiteboardDocuments[definition.id] ?? before
      deferredDocument = nil
      return nil
    }
    workingDocument = receipt.after
    if recordHistory, receipt.after.revision != receipt.before.revision {
      pushUndo(receipt.before)
      redoStack.removeAll()
    }
    applyDeferredDocumentIfNeeded()
    return receipt
  }

  private func startMutation(_ operation: @escaping @MainActor () async -> Void) {
    guard !isPersisting else { return }
    isPersisting = true
    Task { await operation() }
  }

  private func undo() {
    guard !isPersisting, let target = undoStack.popLast() else { return }
    isPersisting = true
    let current = workingDocument
    var replacement = target
    replacement.viewport = current.viewport
    replacement.revision = current.revision + 1
    workingDocument = replacement
    Task {
      let receipt = await store.replaceWhiteboardDocument(
        replacement,
        for: definition.id,
        expectedRevision: current.revision
      )
      isPersisting = false
      guard let receipt else {
        pushUndo(target)
        workingDocument = store.whiteboardDocuments[definition.id] ?? current
        return
      }
      pushRedo(current)
      workingDocument = receipt.after
    }
  }

  private func redo() {
    guard !isPersisting, let target = redoStack.popLast() else { return }
    isPersisting = true
    let current = workingDocument
    var replacement = target
    replacement.viewport = current.viewport
    replacement.revision = current.revision + 1
    workingDocument = replacement
    Task {
      let receipt = await store.replaceWhiteboardDocument(
        replacement,
        for: definition.id,
        expectedRevision: current.revision
      )
      isPersisting = false
      guard let receipt else {
        pushRedo(target)
        workingDocument = store.whiteboardDocuments[definition.id] ?? current
        return
      }
      pushUndo(current)
      workingDocument = receipt.after
    }
  }

  private func finishPan(_ translation: CGSize) {
    let zoom = max(CGFloat(workingDocument.viewport.zoom), 0.001)
    var viewport = workingDocument.viewport
    viewport.center = viewport.center.translated(
      x: -Double(translation.width / zoom),
      y: -Double(translation.height / zoom)
    )
    transientPan = .zero
    persistViewport(viewport)
  }

  private func setZoom(_ requestedZoom: CGFloat) {
    guard !isPersisting else { return }
    var viewport = workingDocument.viewport
    viewport.zoom = min(
      max(Double(requestedZoom), WhiteboardLimits.minimumZoom),
      WhiteboardLimits.maximumZoom
    )
    persistViewport(viewport)
  }

  private func resetView() {
    persistViewport(.init(center: .init(x: 0, y: 0), zoom: 1))
  }

  private func fitAll(in size: CGSize) {
    guard !isPersisting, size.width > 0, size.height > 0 else { return }
    guard let contentBounds = visibleElements.map(\.bounds).reduce(nil, { partial, bounds in
      partial.map { $0.union(bounds) } ?? bounds
    }) else {
      resetView()
      return
    }
    let padding = 48.0
    let zoom = min(
      WhiteboardLimits.maximumZoom,
      max(
        WhiteboardLimits.minimumZoom,
        min(
          Double(size.width) / max(contentBounds.width + padding * 2, 1),
          Double(size.height) / max(contentBounds.height + padding * 2, 1)
        )
      )
    )
    persistViewport(.init(center: contentBounds.centerPoint, zoom: zoom))
  }

  private func persistViewport(_ viewport: WhiteboardViewport) {
    guard !isPersisting else { return }
    var optimistic = workingDocument
    optimistic.viewport = viewport.clamped()
    startMutation {
      await performMutation(optimistic: optimistic, recordHistory: false) { revision in
        await store.updateWhiteboardViewport(
          optimistic.viewport,
          in: definition.id,
          expectedRevision: revision
        )
      }
    }
  }

  private func arrangePageCards() {
    guard !isPersisting else { return }
    startMutation {
      await performMutation { revision in
        await store.resetWhiteboardPageCards(
          displayedPageIDs,
          in: definition.id,
          expectedRevision: revision
        )
      }
    }
  }

  private func receive(_ document: WhiteboardDocument) {
    if isPersisting { return }
    if moveBaseline != nil || draft != nil || transientPan != .zero || gestureMagnification != 1 {
      deferredDocument = document
      return
    }
    guard document.revision != workingDocument.revision else { return }
    workingDocument = document
    undoStack.removeAll()
    redoStack.removeAll()
  }

  private func pushUndo(_ document: WhiteboardDocument) {
    undoStack.append(document)
    trimSessionHistory()
  }

  private func pushRedo(_ document: WhiteboardDocument) {
    redoStack.append(document)
    trimSessionHistory()
  }

  private func trimSessionHistory() {
    // Session-local undo is intentionally shallow. Core limits each encoded document to 900 KB,
    // so 12 entries per stack keeps the combined worst case below 22 MB without serializing old
    // snapshots on the main actor after every pen stroke.
    let maximumSnapshotsPerStack = 12
    if undoStack.count > maximumSnapshotsPerStack {
      undoStack.removeFirst(undoStack.count - maximumSnapshotsPerStack)
    }
    if redoStack.count > maximumSnapshotsPerStack {
      redoStack.removeFirst(redoStack.count - maximumSnapshotsPerStack)
    }
  }

  private func applyDeferredDocumentIfNeeded() {
    guard let deferredDocument else { return }
    self.deferredDocument = nil
    if deferredDocument.revision > workingDocument.revision {
      workingDocument = deferredDocument
      undoStack.removeAll()
      redoStack.removeAll()
    }
  }

  private func handleKeyPress(_ press: KeyPress) -> KeyPress.Result {
    if press.modifiers.contains(.command), press.characters.lowercased() == "z" {
      if press.modifiers.contains(.shift) { redo() } else { undo() }
      return .handled
    }
    if press.modifiers.isEmpty || press.modifiers == .shift {
      switch press.key {
      case .delete, .deleteForward:
        deleteSelection()
        return .handled
      case .escape:
        selection.removeAll()
        activeTool = .select
        draft = nil
        draftPoints.removeAll()
        return .handled
      case .leftArrow:
        nudgeSelection(dx: -keyboardNudge(press), dy: 0)
        return .handled
      case .rightArrow:
        nudgeSelection(dx: keyboardNudge(press), dy: 0)
        return .handled
      case .upArrow:
        nudgeSelection(dx: 0, dy: -keyboardNudge(press))
        return .handled
      case .downArrow:
        nudgeSelection(dx: 0, dy: keyboardNudge(press))
        return .handled
      default:
        if press.modifiers.isEmpty,
          let tool = WhiteboardTool.allCases.first(where: { $0.key == press.key })
        {
          activeTool = tool
          return .handled
        }
      }
    }
    return .ignored
  }

  private func keyboardNudge(_ press: KeyPress) -> CGFloat {
    press.modifiers.contains(.shift) ? 28 : 4
  }

  private func nudgeSelection(dx: CGFloat, dy: CGFloat) {
    guard let id = selection.first else { return }
    nudge(id, by: CGSize(width: dx, height: dy))
  }
}

private struct WhiteboardEmptyState: View {
  var body: some View {
    ContentUnavailableView {
      Label("Blank Canvas", systemImage: "scribble.variable")
    } description: {
      Text("Choose a drawing tool, add a note, or wait for page cards from this live view.")
    }
    .foregroundStyle(Color.black.opacity(0.72))
  }
}

private struct WhiteboardNotice: View {
  let title: String
  let message: String
  let systemImage: String
  let dismiss: (() -> Void)?

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: systemImage)
        .foregroundStyle(Color.orange)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.subheadline.weight(.semibold))
        Text(message).font(.caption).foregroundStyle(.secondary)
      }
      if let dismiss {
        Button("Dismiss", systemImage: "xmark", action: dismiss)
          .labelStyle(.iconOnly)
          .buttonStyle(.plain)
      }
    }
    .padding(10)
    .frame(maxWidth: 420, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}
