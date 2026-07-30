import SwiftUI

struct FileInspectorView: View {
  @Bindable var session: BrowserSession

  private var items: [FileItem] { session.selectedItems }

  var body: some View {
    Group {
      if items.count == 1, let item = items.first {
        ScrollView {
          VStack(alignment: .leading, spacing: 15) {
            EmbeddedQuickLookView(url: item.url)
              .frame(minHeight: 190, idealHeight: 230, maxHeight: 280)
              .background(ScoutTheme.quietFill)
              .clipShape(.rect(cornerRadius: 9))
              .overlay { RoundedRectangle(cornerRadius: 9).stroke(ScoutTheme.separator) }
              .accessibilityLabel("Preview of \(item.name)")

            VStack(alignment: .leading, spacing: 4) {
              Text(item.name)
                .font(.headline)
                .lineLimit(3)
              Text(item.kindDescription)
                .font(.callout)
                .foregroundStyle(.secondary)
            }

            HStack(spacing: 7) {
              InspectorAction(title: "Open", systemImage: "arrow.up.forward.app") {
                Task { await session.openSelection() }
              }
              InspectorAction(title: "Preview", systemImage: "eye") {
                QuickLookPanelController.shared.preview([item.url])
              }
              Menu {
                Button("Rename", systemImage: "pencil") { session.beginRename() }
                Button("Edit Tags", systemImage: "tag") { session.beginEditingTags() }
                Divider()
                Button("Move to Trash", systemImage: "trash", role: .destructive) {
                  Task { await session.trashSelection() }
                }
              } label: {
                Image(systemName: "ellipsis")
                  .frame(width: 28, height: 26)
              }
              .menuStyle(.borderlessButton)
              .menuIndicator(.hidden)
              .help("More Actions")
            }

            InspectorSection(title: "Information") {
              Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                inspectorRow("Size", item.formattedSize)
                inspectorRow("Modified", item.formattedModificationDate)
                inspectorRow("Access", item.isWritable ? "Read & Write" : "Read Only")
              }
            }

            InspectorSection(title: "Location") {
              Text(item.url.deletingLastPathComponent().path(percentEncoded: false))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .lineLimit(4)
                .truncationMode(.middle)
            }

            if !item.tags.isEmpty {
              InspectorSection(title: "Tags") {
                FlowLayout(spacing: 5) {
                  ForEach(item.tags, id: \.self) { tag in
                    Text(tag)
                      .font(.caption)
                      .padding(.horizontal, 7)
                      .padding(.vertical, 3)
                      .background(ScoutTheme.selection, in: .capsule)
                  }
                }
              }
            }
          }
          .padding(14)
        }
      } else {
        InspectorEmptyState(count: items.count)
      }
    }
    .background(ScoutTheme.elevated)
  }

  @ViewBuilder
  private func inspectorRow(_ label: LocalizedStringKey, _ value: String) -> some View {
    GridRow {
      Text(label).foregroundStyle(.secondary)
      Text(value).textSelection(.enabled).lineLimit(2).truncationMode(.middle)
    }
    .font(.caption)
  }
}

private struct InspectorAction: View {
  let title: LocalizedStringKey
  let systemImage: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(title, systemImage: systemImage)
        .font(.caption.weight(.medium))
        .frame(maxWidth: .infinity)
        .frame(height: 24)
    }
    .buttonStyle(.bordered)
  }
}

private struct InspectorSection<Content: View>: View {
  let title: LocalizedStringKey
  @ViewBuilder let content: () -> Content

  init(title: LocalizedStringKey, @ViewBuilder content: @escaping () -> Content) {
    self.title = title
    self.content = content
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      content()
    }
    .padding(.top, 2)
  }
}

private struct InspectorEmptyState: View {
  let count: Int

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: count == 0 ? "sidebar.right" : "square.stack.3d.up")
        .font(.system(size: 27, weight: .light))
        .foregroundStyle(ScoutTheme.accent)
      Text(count == 0 ? "Nothing Selected" : "\(count) Items Selected")
        .font(.headline)
      Text(count == 0 ? "Select a file to preview it and inspect its details." : "File actions apply to the entire selection.")
        .font(.callout)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 220)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(24)
  }
}

private struct FlowLayout: Layout {
  let spacing: CGFloat
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    layout(proposal: proposal, subviews: subviews).size
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let result = layout(proposal: ProposedViewSize(width: bounds.width, height: bounds.height), subviews: subviews)
    for (index, point) in result.points.enumerated() {
      subviews[index].place(
        at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
        proposal: .unspecified
      )
    }
  }
  private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
    let width = proposal.width ?? 300
    var x: CGFloat = 0
    var y: CGFloat = 0
    var rowHeight: CGFloat = 0
    var points: [CGPoint] = []
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x + size.width > width, x > 0 {
        x = 0
        y += rowHeight + spacing
        rowHeight = 0
      }
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
        .foregroundStyle(notice.isError ? Color.orange : ScoutTheme.accent)
      VStack(alignment: .leading, spacing: 1) {
        Text(notice.title).font(.callout.weight(.medium))
        Text(notice.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }
      Spacer()
      if notice.canUndo { Button("Undo", action: undo) }
      Button(action: dismiss) {
        Image(systemName: "xmark")
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Dismiss")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(ScoutTheme.chrome)
  }
}

struct PathNavigatorSheet: View {
  @Binding var path: String
  let navigate: () -> Void
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Label("Go to Folder", systemImage: "location")
        .font(.headline)
      TextField("Exact path", text: $path)
        .font(.system(.body, design: .monospaced))
        .focused($focused)
        .onSubmit(navigate)
      HStack {
        Spacer()
        Button("Go", action: navigate).keyboardShortcut(.defaultAction)
      }
    }
    .padding(20)
    .frame(width: 520)
    .background(ScoutTheme.elevated)
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
      HStack {
        Spacer()
        Button("Rename", action: rename).keyboardShortcut(.defaultAction).disabled(name.isEmpty)
      }
    }
    .padding(20)
    .frame(width: 420)
    .background(ScoutTheme.elevated)
    .onAppear { focused = true }
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
      HStack {
        Spacer()
        Button("Apply", action: save).keyboardShortcut(.defaultAction)
      }
    }
    .padding(20)
    .frame(width: 420)
    .background(ScoutTheme.elevated)
    .onAppear { focused = true }
  }
}
