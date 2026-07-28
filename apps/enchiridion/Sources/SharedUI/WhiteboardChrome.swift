import SwiftUI

struct WhiteboardToolPalette: View {
  @Binding var selection: WhiteboardTool

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 2) {
        ForEach(WhiteboardTool.allCases) { tool in
          Button {
            selection = tool
          } label: {
            Label(tool.title, systemImage: tool.systemImage)
              .labelStyle(.iconOnly)
              .frame(minWidth: toolControlSize, minHeight: toolControlSize)
              .contentShape(Rectangle())
          }
          .buttonStyle(WhiteboardToolButtonStyle(isSelected: selection == tool))
          .help("\(tool.help) (\(tool.keyLabel))")
          .accessibilityLabel(tool.title)
          .accessibilityHint(tool.help)
          .accessibilityAddTraits(selection == tool ? .isSelected : [])
        }
      }
    }
    .scrollIndicators(.hidden)
    .padding(4)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Canvas tools")
  }

  private var toolControlSize: CGFloat {
    #if os(iOS)
    44
    #else
    28
    #endif
  }
}

struct WhiteboardHistoryControls: View {
  let canUndo: Bool
  let canRedo: Bool
  let canDelete: Bool
  let undo: () -> Void
  let redo: () -> Void
  let delete: () -> Void

  var body: some View {
    HStack(spacing: 2) {
      control("Undo", systemImage: "arrow.uturn.backward", isEnabled: canUndo, action: undo)
      control("Redo", systemImage: "arrow.uturn.forward", isEnabled: canRedo, action: redo)
      Divider().frame(height: 18)
      control("Delete selection", systemImage: "trash", isEnabled: canDelete, action: delete)
    }
    .padding(4)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private func control(
    _ title: String,
    systemImage: String,
    isEnabled: Bool,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Label(title, systemImage: systemImage)
        .labelStyle(.iconOnly)
        .frame(minWidth: chromeControlSize, minHeight: chromeControlSize)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!isEnabled)
    .help(title)
    .accessibilityLabel(title)
  }

  private var chromeControlSize: CGFloat {
    #if os(iOS)
    44
    #else
    28
    #endif
  }
}

struct WhiteboardViewControls: View {
  let zoom: CGFloat
  let zoomOut: () -> Void
  let zoomIn: () -> Void
  let setZoom: (CGFloat) -> Void
  let resetView: () -> Void
  let fitAll: () -> Void
  let arrangeCards: () -> Void

  var body: some View {
    HStack(spacing: 2) {
      control("Zoom out", systemImage: "minus", action: zoomOut)

      Menu {
        ForEach([50, 75, 100, 125, 150, 200], id: \.self) { percent in
          Button("\(percent)%") { setZoom(CGFloat(percent) / 100) }
        }
        Divider()
        Button("Reset View", action: resetView)
        Button("Fit All", action: fitAll)
        Button("Arrange Page Cards", action: arrangeCards)
      } label: {
        Text(zoom, format: .percent.precision(.fractionLength(0)))
          .monospacedDigit()
          .frame(minWidth: 48, minHeight: chromeControlSize)
      }
      #if os(macOS)
      .menuStyle(.borderlessButton)
      #endif
      .accessibilityLabel("Canvas zoom")
      .accessibilityValue(Text(zoom, format: .percent.precision(.fractionLength(0))))

      control("Zoom in", systemImage: "plus", action: zoomIn)
      Divider().frame(height: 18)
      control("Fit all elements", systemImage: "arrow.up.left.and.arrow.down.right", action: fitAll)
      control("Reset view", systemImage: "scope", action: resetView)
    }
    .padding(4)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private func control(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Label(title, systemImage: systemImage)
        .labelStyle(.iconOnly)
        .frame(minWidth: chromeControlSize, minHeight: chromeControlSize)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help(title)
    .accessibilityLabel(title)
  }

  private var chromeControlSize: CGFloat {
    #if os(iOS)
    44
    #else
    28
    #endif
  }
}

struct WhiteboardHelpCard: View {
  let dismiss: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Label("Canvas Help", systemImage: "questionmark.circle")
          .font(.headline)
        Spacer()
        Button("Dismiss", systemImage: "xmark", action: dismiss)
          .labelStyle(.iconOnly)
          .buttonStyle(.plain)
      }

      Text("Choose a tool, then drag on the canvas. Select an element to move or delete it. Arrows can connect shapes, notes, and page cards.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      #if os(macOS)
      Text("Press V, H, P, R, O, D, X, T, or A to change tools. Use arrow keys to nudge a selection, Delete to remove it, and Command-Z or Command-Shift-Z for history.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      #else
      Text("Pinch to zoom. Use the Hand tool to pan, or drag a selected element to move it. VoiceOver actions can move and remove each element.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      #endif
    }
    .padding(14)
    .frame(maxWidth: 360)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .accessibilityElement(children: .contain)
  }
}

private struct WhiteboardToolButtonStyle: ButtonStyle {
  let isSelected: Bool

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
      .background(
        isSelected ? Color.accentColor.opacity(0.14) : Color.clear,
        in: RoundedRectangle(cornerRadius: 7, style: .continuous)
      )
      .opacity(configuration.isPressed ? 0.72 : 1)
  }
}
