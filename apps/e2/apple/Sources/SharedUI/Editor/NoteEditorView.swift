import ApsidesCore
import SwiftUI

/// The native document surface: blocks, formatting bar, slash and mention menus,
/// and the component editors. Persistence belongs to the host view.
struct NoteEditorView: View {
    @ObservedObject var model: NoteEditorModel
    @FocusState private var focus: NoteFocus?
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @State private var linkPrompt = false
    @State private var linkURL = ""

    var body: some View {
        let blocks = model.document.blocks
        let placeholder = blocks.count == 1 && blocks[0].node.isEmptyTextBlock && blocks[0].node.type == .paragraph
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(blocks) { block in
                    NoteBlockRow(model: model, block: block, focus: $focus, theme: theme, showsPlaceholder: placeholder)
                }
                Color.clear.frame(height: 280).contentShape(Rectangle())
                    .onTapGesture { focusEnd(blocks) }
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 20).padding(.top, 12)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(theme.canvas)
        .foregroundStyle(theme.ink)
        .tint(theme.accent)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            NoteEditorToolbar(model: model, theme: theme, addLink: { linkURL = ""; linkPrompt = true })
        }
        .onChange(of: model.focus) { _, value in if value != focus { focus = value } }
        .onChange(of: focus) { _, value in if value != model.focus { model.focus = value } }
        .onAppear { if model.focus == nil, let first = blocks.first { model.focus = NoteFocus(path: first.path) } }
        .sheet(item: $model.editingComponent) { component in
            NoteComponentEditor(component: component, theme: theme, onSave: model.commit, onCancel: { model.editingComponent = nil })
        }
        .alert("Link", isPresented: $linkPrompt) {
            TextField("https://example.com", text: $linkURL)
                .autocorrectionDisabled()
            Button("Add") { if NoteValidation.httpURL(linkURL, mail: true) != nil { model.setLink(linkURL) } }
            Button("Remove link", role: .destructive) { model.setLink(nil) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Applies to the selected text, or the word at the caret. HTTP(S) and mailto links only.")
        }
        .alert("Couldn’t complete that", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private func focusEnd(_ blocks: [NoteBlock]) {
        guard let last = blocks.last else { return }
        if last.node.type == .codeBlock || !last.node.children.isEmpty {
            model.appendParagraph()
        } else {
            model.focus = NoteFocus(path: last.path, segment: max(0, NoteInlineText.segments(model.inlineText(at: last.path)).count - 1))
        }
    }
}

extension NoteEditorModel {
    /// Tapping below the last block keeps writing in a fresh paragraph.
    func appendParagraph() {
        let path = NotePath(document.content.count)
        var next = document
        next.content.append(.paragraph())
        // An empty trailing paragraph is not worth an undo step.
        setDocumentWithoutUndo(next)
        focus = NoteFocus(path: path)
        pendingCaret = NoteCaret(path)
    }
}

/// Formatting controls in one horizontally scrolling bar, above the keyboard on iPhone.
struct NoteEditorToolbar: View {
    @ObservedObject var model: NoteEditorModel
    let theme: ApsidesTheme
    let addLink: () -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                styleMenu
                Divider().frame(height: 22)
                control("list.bullet", "Bulleted list", active: model.focusedBlock?.listKind == .bulletList) { model.toggleList(.bulletList) }
                control("list.number", "Numbered list", active: model.focusedBlock?.listKind == .orderedList) { model.toggleList(.orderedList) }
                control("checklist", "Checklist", active: model.focusedBlock?.listKind == .taskList) { model.toggleList(.taskList) }
                control("decrease.indent", "Outdent", active: false) { model.outdent() }.disabled(model.focusedBlock?.itemPath == nil)
                control("increase.indent", "Indent", active: false) { model.indent() }.disabled(model.focusedBlock?.itemPath == nil)
                Divider().frame(height: 22)
                control("bold", "Bold", active: model.markState(.bold) == .all) { model.toggleMark(.bold) }
                control("italic", "Italic", active: model.markState(.italic) == .all) { model.toggleMark(.italic) }
                control("underline", "Underline", active: model.markState(.underline) == .all) { model.toggleMark(.underline) }
                control("strikethrough", "Strikethrough", active: model.markState(.strike) == .all) { model.toggleMark(.strike) }
                control("chevron.left.forwardslash.chevron.right", "Inline code", active: model.markState(.code) == .all) { model.toggleMark(.code) }
                control("link", "Link", active: model.markState(.link) == .all, action: addLink)
                Divider().frame(height: 22)
                insertMenu
                blockMenu
                Divider().frame(height: 22)
                control("arrow.uturn.backward", "Undo", active: false) { model.undo() }.disabled(!model.canUndo)
                control("arrow.uturn.forward", "Redo", active: false) { model.redo() }.disabled(!model.canRedo)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .foregroundStyle(theme.ink)
        .accessibilityLabel("Formatting")
    }

    private func control(_ symbol: String, _ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .frame(width: 36, height: 32)
                .background(active ? theme.accent.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var styleMenu: some View {
        Menu {
            Picker("Block style", selection: Binding(get: { model.activeStyle }, set: { model.setBlockStyle($0) })) {
                Text("Text").tag(BlockStyle.paragraph)
                Text("Heading 1").tag(BlockStyle.heading(1))
                Text("Heading 2").tag(BlockStyle.heading(2))
                Text("Heading 3").tag(BlockStyle.heading(3))
                Text("Quote").tag(BlockStyle.quote)
                Text("Code block").tag(BlockStyle.code)
            }
            Divider()
            Menu("Alignment") {
                Button("Default") { model.setAlignment(nil) }
                Button("Left") { model.setAlignment("left") }
                Button("Center") { model.setAlignment("center") }
                Button("Right") { model.setAlignment("right") }
                Button("Justify") { model.setAlignment("justify") }
            }
        } label: {
            HStack(spacing: 4) {
                Text(styleLabel).font(.system(size: 14, weight: .medium))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .padding(.horizontal, 10).frame(height: 32)
            .background(theme.ink.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        }
        .menuStyle(.button).buttonStyle(.plain)
        .accessibilityLabel("Paragraph style")
    }

    private var styleLabel: String {
        switch model.activeStyle {
        case .paragraph: "Text"
        case .heading(let level): "Heading \(level)"
        case .quote: "Quote"
        case .code: "Code"
        }
    }

    /// Block actions the iPhone keyboard cannot express with keys.
    private var blockMenu: some View {
        Menu {
            Button("Line break", systemImage: "return") {
                if let focus = model.focus, let range = model.selectionRanges.first, model.selectionSegment == focus {
                    model.insertHardBreak(at: NoteCaret(focus.path, offset: range.lowerBound))
                }
            }
            Button("Merge with previous block", systemImage: "arrow.up.to.line") { model.mergeFocusedBlockWithPrevious() }
            Button("Delete block", systemImage: "trash", role: .destructive) { model.deleteFocusedBlock() }
        } label: {
            Image(systemName: "ellipsis.circle").font(.system(size: 15, weight: .medium)).frame(width: 36, height: 32)
        }
        .menuStyle(.button).buttonStyle(.plain)
        .disabled(model.focus == nil)
        .accessibilityLabel("Block actions")
    }

    private var insertMenu: some View {
        Menu {
            Button("D2 diagram", systemImage: "point.3.connected.trianglepath.dotted") { model.insertComponent(.diagram) }
            Button("Mermaid diagram", systemImage: "arrow.triangle.branch") { model.insertComponent(.mermaid) }
            Button("Drawing", systemImage: "pencil.tip.crop.circle") { model.insertComponent(.drawing) }
            Button("Link or video", systemImage: "link") { model.insertComponent(.link) }
        } label: {
            Image(systemName: "plus").font(.system(size: 15, weight: .medium)).frame(width: 36, height: 32)
        }
        .menuStyle(.button).buttonStyle(.plain)
        .accessibilityLabel("Insert")
    }
}
