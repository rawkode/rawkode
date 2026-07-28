import EnchiridionCore
import SwiftUI

struct WhiteboardElementOverlay: View {
  let element: WhiteboardElement
  let page: PageSnapshot?
  let screenRect: CGRect
  let zoom: CGFloat
  let isSelected: Bool
  let select: (Bool) -> Void
  let moveChanged: (CGSize) -> Void
  let moveEnded: (CGSize) -> Void
  let nudge: (CGSize) -> Void
  let delete: () -> Void
  let editText: () -> Void
  let openPage: (PageID) -> Void
  let disconnect: (WhiteboardArrowEndpoint) -> Void

  var body: some View {
    content
      .frame(width: max(1, screenRect.width), height: max(1, screenRect.height))
      .padding(lineHitPadding)
      .position(x: screenRect.midX, y: screenRect.midY)
      .gesture(selectionGesture)
      .onTapGesture { select(false) }
      .onTapGesture(count: 2, perform: primaryAction)
      .contextMenu { contextMenu }
      .accessibilityElement(children: elementHasReadableContent ? .combine : .ignore)
      .accessibilityLabel(accessibilityLabel)
      .accessibilityHint(accessibilityHint)
      .accessibilityAddTraits(isSelected ? .isSelected : [])
      .accessibilityActions {
        Button(primaryActionTitle, action: primaryAction)
        Button("Move left") { nudge(CGSize(width: -28, height: 0)) }
        Button("Move right") { nudge(CGSize(width: 28, height: 0)) }
        Button("Move up") { nudge(CGSize(width: 0, height: -28)) }
        Button("Move down") { nudge(CGSize(width: 0, height: 28)) }
        if isDeletable {
          Button("Delete", role: .destructive, action: delete)
        }
      }
  }

  @ViewBuilder
  private var content: some View {
    switch element.kind {
    case .page:
      if zoom < 0.42 {
        RoundedRectangle(cornerRadius: max(2, 8 * zoom), style: .continuous)
          .fill(Color.white)
          .overlay {
            RoundedRectangle(cornerRadius: max(2, 8 * zoom), style: .continuous)
              .stroke(Color.black.opacity(0.18), lineWidth: 1)
          }
          .contentShape(Rectangle())
      } else {
        WhiteboardPageCard(page: page, zoom: zoom)
          .contentShape(Rectangle())
      }
    case .text(let value):
      if zoom < 0.42 {
        RoundedRectangle(cornerRadius: 2, style: .continuous)
          .fill(Color(whiteboardHex: element.style.strokeColor, fallback: .primary).opacity(0.28))
          .padding(.vertical, max(1, screenRect.height * 0.36))
      } else {
        Text(value.isEmpty ? "Text" : value)
          .font(.system(size: max(10, CGFloat(element.style.fontSize) * zoom)))
          .foregroundStyle(Color(whiteboardHex: element.style.strokeColor, fallback: .primary))
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .padding(max(4, 8 * zoom))
          .contentShape(Rectangle())
      }
    case .sticky(let value):
      if zoom < 0.42 {
        RoundedRectangle(cornerRadius: max(2, 8 * zoom), style: .continuous)
          .fill(
            Color(whiteboardHex: element.style.fillColor, fallback: Color.yellow.opacity(0.18))
              .opacity(element.style.opacity)
          )
          .overlay {
            RoundedRectangle(cornerRadius: max(2, 8 * zoom), style: .continuous)
              .stroke(Color.black.opacity(0.18), lineWidth: 1)
          }
      } else {
        Text(value.isEmpty ? "Note" : value)
          .font(.system(size: max(10, CGFloat(element.style.fontSize) * zoom)))
          .foregroundStyle(Color(whiteboardHex: element.style.strokeColor, fallback: .primary))
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .padding(max(6, 12 * zoom))
          .background(
            Color(whiteboardHex: element.style.fillColor, fallback: Color.yellow.opacity(0.18))
              .opacity(element.style.opacity),
            in: RoundedRectangle(cornerRadius: max(5, 10 * zoom), style: .continuous)
          )
          .overlay {
            RoundedRectangle(cornerRadius: max(5, 10 * zoom), style: .continuous)
              .stroke(Color(whiteboardHex: element.style.strokeColor, fallback: .secondary).opacity(0.42), lineWidth: max(1, zoom))
          }
          .contentShape(Rectangle())
      }
    case .freehand, .arrow:
      WhiteboardVectorHitShape(element: element)
        .stroke(
          Color.black.opacity(0.001),
          style: StrokeStyle(
            lineWidth: max(18, CGFloat(element.style.strokeWidth) * zoom + 12),
            lineCap: .round,
            lineJoin: .round
          )
        )
    case .rectangle, .ellipse, .diamond:
      WhiteboardVectorHitShape(element: element)
        .fill(Color.black.opacity(0.001))
    }
  }

  @ViewBuilder
  private var contextMenu: some View {
    Button("Move left", systemImage: "arrow.left") { nudge(CGSize(width: -28, height: 0)) }
    Button("Move right", systemImage: "arrow.right") { nudge(CGSize(width: 28, height: 0)) }
    Button("Move up", systemImage: "arrow.up") { nudge(CGSize(width: 0, height: -28)) }
    Button("Move down", systemImage: "arrow.down") { nudge(CGSize(width: 0, height: 28)) }

    switch element.kind {
    case .page(let pageID):
      Divider()
      Button("Open Page", systemImage: "arrow.up.right.square") { openPage(pageID) }
    case .text, .sticky:
      Divider()
      Button("Edit Text", systemImage: "character.cursor.ibeam") { editText() }
    case .arrow(let arrow):
      if arrow.start != nil || arrow.end != nil {
        Divider()
        if arrow.start != nil {
          Button("Disconnect Start", systemImage: "point.topleft.down.curvedto.point.bottomright.up") {
            disconnect(.start)
          }
        }
        if arrow.end != nil {
          Button("Disconnect End", systemImage: "point.topleft.down.curvedto.point.bottomright.up") {
            disconnect(.end)
          }
        }
      }
    case .freehand, .rectangle, .ellipse, .diamond:
      EmptyView()
    }

    if isDeletable {
      Divider()
      Button("Delete", systemImage: "trash", role: .destructive, action: delete)
    }
  }

  private var selectionGesture: some Gesture {
    DragGesture(minimumDistance: 3)
      .onChanged { value in
        select(false)
        moveChanged(
          CGSize(
            width: value.translation.width / zoom,
            height: value.translation.height / zoom
          )
        )
      }
      .onEnded { value in
        moveEnded(
          CGSize(
            width: value.translation.width / zoom,
            height: value.translation.height / zoom
          )
        )
      }
  }

  private var elementHasReadableContent: Bool {
    switch element.kind {
    case .page, .text, .sticky: true
    case .freehand, .rectangle, .ellipse, .diamond, .arrow: false
    }
  }

  private var isDeletable: Bool {
    if case .page = element.kind { return false }
    return true
  }

  private var lineHitPadding: CGFloat {
    switch element.kind {
    case .freehand, .arrow: 12
    case .page, .rectangle, .ellipse, .diamond, .text, .sticky: 0
    }
  }

  private var accessibilityHint: String {
    if case .page = element.kind {
      return "Select or move this page card. Use Open Page to read it."
    }
    return "Select this element. More actions can move, edit, or remove it."
  }

  private var accessibilityLabel: String {
    switch element.kind {
    case .page: "Page card, \(page?.displayTitle ?? "missing page")"
    case .freehand: "Freehand drawing"
    case .rectangle: "Rectangle"
    case .ellipse: "Ellipse"
    case .diamond: "Diamond"
    case .text(let value): "Text, \(value.isEmpty ? "empty" : value)"
    case .sticky(let value): "Note, \(value.isEmpty ? "empty" : value)"
    case .arrow: "Arrow"
    }
  }

  private var primaryActionTitle: String {
    switch element.kind {
    case .page: "Open Page"
    case .text, .sticky: "Edit Text"
    case .freehand, .rectangle, .ellipse, .diamond, .arrow: "Select"
    }
  }

  private func primaryAction() {
    switch element.kind {
    case .page(let pageID): openPage(pageID)
    case .text, .sticky: editText()
    case .freehand, .rectangle, .ellipse, .diamond, .arrow: select(false)
    }
  }
}

private struct WhiteboardVectorHitShape: Shape {
  let element: WhiteboardElement

  func path(in rect: CGRect) -> Path {
    let bounds = element.bounds
    let scaleX = rect.width / max(CGFloat(bounds.width), 1)
    let scaleY = rect.height / max(CGFloat(bounds.height), 1)
    func localPoint(_ point: WhiteboardPoint) -> CGPoint {
      CGPoint(
        x: CGFloat(point.x - bounds.x) * scaleX,
        y: CGFloat(point.y - bounds.y) * scaleY
      )
    }

    switch element.kind {
    case .freehand(let points):
      return linePath(points, point: localPoint)
    case .arrow(let arrow):
      return linePath(arrow.points, point: localPoint)
    case .rectangle:
      return Path(rect)
    case .ellipse:
      return Path(ellipseIn: rect)
    case .diamond:
      var path = Path()
      path.move(to: CGPoint(x: rect.midX, y: rect.minY))
      path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
      path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
      path.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
      path.closeSubpath()
      return path
    case .page, .text, .sticky:
      return Path(rect)
    }
  }

  private func linePath(
    _ points: [WhiteboardPoint],
    point: (WhiteboardPoint) -> CGPoint
  ) -> Path {
    var path = Path()
    guard let first = points.first else { return path }
    path.move(to: point(first))
    for value in points.dropFirst() { path.addLine(to: point(value)) }
    return path
  }
}

private struct WhiteboardPageCard: View {
  let page: PageSnapshot?
  let zoom: CGFloat

  var body: some View {
    VStack(alignment: .leading, spacing: max(3, 7 * zoom)) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: page?.isPinned == true ? "pin.fill" : "doc.text")
          .foregroundStyle(page?.isPinned == true ? Color.accentColor : Color.black.opacity(0.52))
        Text(page?.displayTitle ?? "Missing page")
          .font(.system(size: max(11, 15 * zoom), weight: .semibold))
          .foregroundStyle(Color.black.opacity(0.88))
          .lineLimit(2)
        Spacer(minLength: 0)
      }

      if let preview = page?.preview, !preview.isEmpty {
        Text(preview)
          .font(.system(size: max(9, 12 * zoom)))
          .foregroundStyle(Color.black.opacity(0.58))
          .lineLimit(3)
      } else {
        Text(page == nil ? "This page is no longer available." : "No text yet")
          .font(.system(size: max(9, 12 * zoom)))
          .foregroundStyle(Color.black.opacity(0.4))
      }

      Spacer(minLength: 0)

      if let modifiedAt = page?.modifiedAt {
        Text(modifiedAt, format: .relative(presentation: .named))
          .font(.system(size: max(8, 10 * zoom)))
          .foregroundStyle(Color.black.opacity(0.4))
      }
    }
    .padding(max(7, 12 * zoom))
    .background(Color.white, in: RoundedRectangle(cornerRadius: max(6, 12 * zoom), style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: max(6, 12 * zoom), style: .continuous)
        .stroke(Color.black.opacity(0.16), lineWidth: 1)
    }
  }
}
