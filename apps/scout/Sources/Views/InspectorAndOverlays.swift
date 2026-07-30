import SwiftUI

struct FileInspectorView: View {
  let items: [FileItem]

  var body: some View {
    if items.count == 1, let item = items.first {
      VStack(alignment: .leading, spacing: 16) {
        EmbeddedQuickLookView(url: item.url)
          .frame(minHeight: 210, idealHeight: 260)
          .clipShape(.rect(cornerRadius: 9))
          .accessibilityLabel("Preview of \(item.name)")

        VStack(alignment: .leading, spacing: 5) {
          Text(item.name)
            .font(.headline)
            .lineLimit(3)
          Text(item.kindDescription)
            .foregroundStyle(.secondary)
        }

        Divider()

        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
          inspectorRow("Size", item.formattedSize)
          inspectorRow("Modified", item.formattedModificationDate)
          inspectorRow("Where", item.url.deletingLastPathComponent().path(percentEncoded: false))
          inspectorRow("Access", item.isWritable ? "Read & Write" : "Read Only")
        }
        .font(.caption)

        if !item.tags.isEmpty {
          FlowLayout(spacing: 5) {
            ForEach(item.tags, id: \.self) { tag in
              Text(tag).font(.caption).padding(.horizontal, 7).padding(.vertical, 3).background(.quaternary, in: .capsule)
            }
          }
        }
        Spacer()
      }
      .padding(14)
    } else {
      ContentUnavailableView(
        items.isEmpty ? "Nothing Selected" : "\(items.count) Items Selected",
        systemImage: items.isEmpty ? "sidebar.right" : "square.stack.3d.up",
        description: Text(items.isEmpty ? "Select a file to preview it and inspect its details." : "Actions apply to the entire selection.")
      )
    }
  }

  @ViewBuilder
  private func inspectorRow(_ label: LocalizedStringKey, _ value: String) -> some View {
    GridRow {
      Text(label).foregroundStyle(.secondary)
      Text(value).textSelection(.enabled).lineLimit(2).truncationMode(.middle)
    }
  }
}

private struct FlowLayout: Layout {
  let spacing: CGFloat
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    layout(proposal: proposal, subviews: subviews).size
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let result = layout(proposal: ProposedViewSize(width: bounds.width, height: bounds.height), subviews: subviews)
    for (index, point) in result.points.enumerated() { subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified) }
  }
  private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
    let width = proposal.width ?? 300
    var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
    var points: [CGPoint] = []
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x + size.width > width, x > 0 { x = 0; y += rowHeight + spacing; rowHeight = 0 }
      points.append(CGPoint(x: x, y: y))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
    return (CGSize(width: width, height: y + rowHeight), points)
  }
}

struct OperationNoticeView: View {
  let notice: OperationNotice
  let undo: () -> Void
  let dismiss: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: notice.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
        .foregroundStyle(notice.isError ? Color.orange : Color.accentColor)
      VStack(alignment: .leading, spacing: 1) {
        Text(notice.title).font(.callout.weight(.medium))
        Text(notice.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }
      Spacer()
      if notice.canUndo { Button("Undo", action: undo) }
      Button(action: dismiss) { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("Dismiss")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(.bar)
    .overlay(alignment: .top) { Divider() }
  }
}

struct PathNavigatorSheet: View {
  @Binding var path: String
  let navigate: () -> Void
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Go to Folder").font(.headline)
      TextField("Exact path", text: $path)
        .font(.system(.body, design: .monospaced))
        .focused($focused)
        .onSubmit(navigate)
      HStack { Spacer(); Button("Go", action: navigate).keyboardShortcut(.defaultAction) }
    }
    .padding(20)
    .frame(width: 520)
    .onAppear { focused = true }
  }
}

struct RenameSheet: View {
  @Binding var name: String
  let rename: () -> Void
  @FocusState private var focused: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Rename Item").font(.headline)
      TextField("Name", text: $name).focused($focused).onSubmit(rename)
      HStack { Spacer(); Button("Rename", action: rename).keyboardShortcut(.defaultAction).disabled(name.isEmpty) }
    }
    .padding(20).frame(width: 420).onAppear { focused = true }
  }
}

struct TagEditorSheet: View {
  @Binding var tags: String
  let save: () -> Void
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Tags").font(.headline)
      Text("Separate tags with commas.").font(.caption).foregroundStyle(.secondary)
      TextField("work, important", text: $tags).focused($focused).onSubmit(save)
      HStack { Spacer(); Button("Apply", action: save).keyboardShortcut(.defaultAction) }
    }
    .padding(20).frame(width: 420).onAppear { focused = true }
  }
}
