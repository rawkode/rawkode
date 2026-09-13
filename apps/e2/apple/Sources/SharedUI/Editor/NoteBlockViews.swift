import ApsidesCore
import SwiftUI

/// One paragraph, heading or code block with its list marker and quote bar.
struct NoteBlockRow: View {
    @ObservedObject var model: NoteEditorModel
    let block: NoteBlock
    var focus: FocusState<NoteFocus?>.Binding
    let theme: ApsidesTheme
    let showsPlaceholder: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            marker
            content
        }
        .padding(.leading, CGFloat(block.listDepth) * 22 + CGFloat(block.quoteDepth) * 16)
        .overlay(alignment: .leading) {
            if block.quoteDepth > 0 {
                RoundedRectangle(cornerRadius: 2).fill(theme.secondary.opacity(0.5)).frame(width: 3)
                    .padding(.leading, CGFloat(block.listDepth) * 22 + CGFloat(block.quoteDepth - 1) * 16 + 2)
            }
        }
        .overlay(alignment: .bottomLeading) { menus }
        .zIndex(model.slashMenu?.path == block.path || model.entityMenu?.path == block.path ? 1 : 0)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var marker: some View {
        switch block.marker {
        case .bullet:
            Text("•").font(.system(size: 17, weight: .bold)).foregroundStyle(theme.secondary).frame(width: 24, alignment: .trailing)
                .accessibilityHidden(true)
        case .number(let number):
            Text("\(number).").font(.system(size: 15, weight: .medium, design: .rounded)).monospacedDigit()
                .foregroundStyle(theme.secondary).frame(width: 28, alignment: .trailing)
                .accessibilityLabel("Item \(number)")
        case .task(let checked):
            Button {
                if let itemPath = block.itemPath { model.toggleTask(itemPath: itemPath) }
            } label: {
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 18)).foregroundStyle(checked ? theme.accent : theme.secondary)
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(checked ? "Completed task" : "Open task")
            .accessibilityHint("Toggles the checkbox")
        case nil:
            if block.listDepth > 0 { Color.clear.frame(width: 24, height: 1) }
        }
    }

    @ViewBuilder private var content: some View {
        if block.node.type == .codeBlock {
            NoteCodeBlockView(model: model, block: block, focus: focus, theme: theme)
        } else {
            NoteParagraphView(model: model, block: block, focus: focus, theme: theme, showsPlaceholder: showsPlaceholder)
        }
    }

    @ViewBuilder private var menus: some View {
        if let menu = model.slashMenu, menu.path == block.path {
            NoteSlashMenu(model: model, menu: menu, theme: theme)
                .alignmentGuide(.bottom) { $0[.top] }
        } else if let menu = model.entityMenu, menu.path == block.path {
            NoteEntityMenu(model: model, menu: menu, theme: theme)
                .alignmentGuide(.bottom) { $0[.top] }
        }
    }
}

/// Inline content laid out as editable text between component cards.
struct NoteParagraphView: View {
    @ObservedObject var model: NoteEditorModel
    let block: NoteBlock
    var focus: FocusState<NoteFocus?>.Binding
    let theme: ApsidesTheme
    let showsPlaceholder: Bool

    private var alignment: TextAlignment {
        switch block.node.attrs?.textAlign {
        case "center": .center
        case "right": .trailing
        default: .leading
        }
    }

    var body: some View {
        let segments = NoteInlineText.segments(model.inlineText(at: block.path))
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                switch segment {
                case .text(let text, let range):
                    NoteTextSegmentView(model: model, block: block, segmentIndex: index, segmentText: text, range: range,
                                        alignment: alignment, focus: focus, theme: theme,
                                        placeholder: showsPlaceholder && index == 0 ? "What’s on your mind? Type / for blocks, @ to mention." : nil)
                case .component(let component, _):
                    NoteComponentCard(component: component, theme: theme, edit: { model.editingComponent = component },
                                      delete: { model.removeComponent(component) })
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A `TextEditor` bound to the note. The document owns the text: every edit is
/// committed through the model and the visible string is re-derived from it.
struct NoteTextSegmentView: View {
    @ObservedObject var model: NoteEditorModel
    let block: NoteBlock
    let segmentIndex: Int
    let segmentText: AttributedString
    let range: Range<Int>
    let alignment: TextAlignment
    var focus: FocusState<NoteFocus?>.Binding
    let theme: ApsidesTheme
    let placeholder: String?

    @State private var text: AttributedString
    @State private var selection = AttributedTextSelection()

    init(model: NoteEditorModel, block: NoteBlock, segmentIndex: Int, segmentText: AttributedString, range: Range<Int>,
         alignment: TextAlignment, focus: FocusState<NoteFocus?>.Binding, theme: ApsidesTheme, placeholder: String?) {
        self.model = model; self.block = block; self.segmentIndex = segmentIndex; self.segmentText = segmentText; self.range = range
        self.alignment = alignment; self.focus = focus; self.theme = theme; self.placeholder = placeholder
        _text = State(initialValue: NoteTextPresentation.styled(segmentText, base: NoteBaseFont.base(for: block), theme: theme))
    }

    private var focusID: NoteFocus { NoteFocus(path: block.path, segment: segmentIndex) }
    private var base: NoteBaseFont { NoteBaseFont.base(for: block) }
    private var isFocused: Bool { focus.wrappedValue == focusID }

    var body: some View {
        TextEditor(text: $text, selection: $selection)
            .attributedTextFormattingDefinition(NoteFormattingDefinition(base: base, theme: theme))
            .font(.system(size: base.size, weight: base.weight, design: base.design))
            .foregroundStyle(theme.ink)
            .multilineTextAlignment(alignment)
            .scrollContentBackground(.hidden)
            .scrollDisabled(true)
            .fixedSize(horizontal: false, vertical: true)
            .focused(focus, equals: focusID)
            .overlay(alignment: .topLeading) {
                if let placeholder, text.characters.isEmpty {
                    Text(placeholder).font(.system(size: base.size)).foregroundStyle(theme.secondary)
                        .padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
                }
            }
            .onKeyPress(phases: .down, action: handle)
            .onChange(of: text) { previous, value in
                model.commitText(value, at: block.path, segment: range, previous: previous)
            }
            .onChange(of: segmentText) { _, value in
                if NoteInlineText.inline(text) != NoteInlineText.inline(value) {
                    text = NoteTextPresentation.styled(value, base: base, theme: theme)
                }
                adoptPendingCaret()
            }
            .onChange(of: selection) { _, value in report(value) }
            .onChange(of: model.pendingCaret) { _, _ in adoptPendingCaret() }
            .onChange(of: isFocused) { _, focused in if focused { adoptPendingCaret(); report(selection) } }
            .onAppear { adoptPendingCaret() }
            .accessibilityIdentifier("noteText")
            .accessibilityLabel(block.node.type == .heading ? "Heading \(block.node.attrs?.level ?? 1)" : "Paragraph")
    }

    private func offsets(_ value: AttributedTextSelection) -> [Range<Int>] {
        switch value.indices(in: text) {
        case .insertionPoint(let index):
            let offset = NoteInlineText.offset(in: text, of: index)
            return [offset..<offset]
        case .ranges(let ranges):
            return ranges.ranges.map { NoteInlineText.offset(in: text, of: $0.lowerBound)..<NoteInlineText.offset(in: text, of: $0.upperBound) }
        }
    }

    private func report(_ value: AttributedTextSelection) {
        guard isFocused else { return }
        model.selectionChanged(at: block.path, segment: segmentIndex, segmentStart: range.lowerBound, ranges: offsets(value))
    }

    private func adoptPendingCaret() {
        guard isFocused, let caret = model.pendingCaret, caret.path == block.path else { return }
        if NoteInlineText.inline(text) != NoteInlineText.inline(segmentText) {
            text = NoteTextPresentation.styled(segmentText, base: base, theme: theme)
        }
        let local = caret.offset - range.lowerBound
        guard local >= 0, local <= text.characters.count else { return }
        selection = AttributedTextSelection(insertionPoint: NoteInlineText.index(in: text, offset: local))
        model.pendingCaret = nil
    }

    private func handle(_ press: KeyPress) -> KeyPress.Result {
        let ranges = offsets(selection)
        let caret = ranges.count == 1 && ranges[0].isEmpty ? ranges[0].lowerBound : nil
        let menuOpen = model.slashMenu?.path == block.path || model.entityMenu?.path == block.path
        if menuOpen {
            switch press.key {
            case .upArrow: model.moveMenuSelection(by: -1); return .handled
            case .downArrow: model.moveMenuSelection(by: 1); return .handled
            case .return, .tab: return model.chooseMenuSelection() ? .handled : .ignored
            case .escape: model.dismissMenus(); return .handled
            default: break
            }
        }
        if press.modifiers.contains(.command), press.modifiers.isDisjoint(with: [.option, .control]) {
            switch press.characters.lowercased() {
            case "b": model.toggleMark(.bold); return .handled
            case "i": model.toggleMark(.italic); return .handled
            case "u": model.toggleMark(.underline); return .handled
            case "e": model.toggleMark(.code); return .handled
            default: break
            }
        }
        switch press.key {
        case .return where press.modifiers.contains(.shift):
            if let caret { model.insertHardBreak(at: NoteCaret(block.path, offset: range.lowerBound + caret)) }
            return .handled
        case .delete where caret == 0:
            model.backspaceAtStart(focusID)
            return .handled
        case .deleteForward where caret == text.characters.count:
            model.deleteAtEnd(focusID)
            return .handled
        case .upArrow where caret == 0 && press.modifiers.isEmpty:
            model.moveFocus(from: block.path, forward: false)
            return .handled
        case .downArrow where caret == text.characters.count && press.modifiers.isEmpty:
            model.moveFocus(from: block.path, forward: true)
            return .handled
        case .tab:
            if block.itemPath != nil { press.modifiers.contains(.shift) ? model.outdent() : model.indent() }
            return .handled
        case .escape:
            model.dismissMenus()
            return .handled
        default:
            return .ignored
        }
    }
}

/// Code stays plain text; Return inserts a newline and the block is left explicitly.
struct NoteCodeBlockView: View {
    @ObservedObject var model: NoteEditorModel
    let block: NoteBlock
    var focus: FocusState<NoteFocus?>.Binding
    let theme: ApsidesTheme
    @State private var text: String

    init(model: NoteEditorModel, block: NoteBlock, focus: FocusState<NoteFocus?>.Binding, theme: ApsidesTheme) {
        self.model = model; self.block = block; self.focus = focus; self.theme = theme
        _text = State(initialValue: block.node.children.first?.text ?? "")
    }

    private var focusID: NoteFocus { NoteFocus(path: block.path) }
    private var language: Binding<String> {
        Binding(get: { block.node.attrs?.language ?? "" }, set: { model.setLanguage($0, at: block.path) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                TextField("Language", text: language)
                    .textFieldStyle(.plain).font(.caption.monospaced()).foregroundStyle(theme.secondary).frame(maxWidth: 160)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Code language")
                Spacer()
                Button("Exit block") { model.exitCodeBlock(at: block.path) }
                    .font(.caption).buttonStyle(.borderless).foregroundStyle(theme.secondary)
            }
            .padding(.horizontal, 10).padding(.top, 6)
            TextEditor(text: $text)
                .font(.system(size: 14, design: .monospaced))
                .foregroundStyle(theme.ink)
                .autocorrectionDisabled()
                .scrollContentBackground(.hidden)
                .scrollDisabled(true)
                .fixedSize(horizontal: false, vertical: true)
                .focused(focus, equals: focusID)
                .onChange(of: text) { _, value in model.commitCode(value, at: block.path) }
                .onChange(of: block.node) { _, node in
                    let stored = node.children.first?.text ?? ""
                    if stored != text { text = stored }
                }
                .onKeyPress(phases: .down) { press in
                    switch press.key {
                    case .delete where text.isEmpty: model.backspaceAtStart(focusID); return .handled
                    case .upArrow where text.isEmpty: model.moveFocus(from: block.path, forward: false); return .handled
                    case .downArrow where text.isEmpty: model.moveFocus(from: block.path, forward: true); return .handled
                    default: return .ignored
                    }
                }
                .padding(.horizontal, 6).padding(.bottom, 4)
                .accessibilityIdentifier("noteCode")
                .accessibilityLabel("Code block")
        }
        .background(theme.ink.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Menus

struct NoteSlashMenu: View {
    @ObservedObject var model: NoteEditorModel
    let menu: SlashMenuState
    let theme: ApsidesTheme

    var body: some View {
        let matches = model.slashMatches
        NoteMenuFrame(theme: theme) {
            if matches.isEmpty {
                Text("No blocks match “\(menu.query)”").font(.callout).foregroundStyle(theme.secondary).padding(12)
            }
            ForEach(Array(matches.enumerated()), id: \.element.id) { index, command in
                Button { model.choose(command) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: command.symbol).frame(width: 22).foregroundStyle(theme.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(command.label).font(.body.weight(.medium))
                            Text(command.detail).font(.caption).foregroundStyle(theme.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(index == menu.selected ? theme.accent.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(index == menu.selected ? .isSelected : [])
            }
        }
        .accessibilityLabel("Insert a block")
    }
}

struct NoteEntityMenu: View {
    @ObservedObject var model: NoteEditorModel
    let menu: EntityMenuState
    let theme: ApsidesTheme

    var body: some View {
        NoteMenuFrame(theme: theme) {
            Text(menu.trigger == "@" ? "Mention an entity" : "Link an entity")
                .font(.caption.weight(.semibold)).foregroundStyle(theme.secondary).padding(.horizontal, 12).padding(.top, 10)
            if menu.loading {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Searching…") }
                    .font(.callout).foregroundStyle(theme.secondary).padding(12)
            } else if let error = menu.error {
                Text(error).font(.callout).foregroundStyle(theme.secondary).padding(12)
            } else if menu.matches.isEmpty {
                Text(menu.query.isEmpty ? "Type to search your workspace." : "No entities match “\(menu.query)”. Refine the search or create it on the web.")
                    .font(.callout).foregroundStyle(theme.secondary).padding(12)
            }
            ForEach(Array(menu.matches.enumerated()), id: \.element.id) { index, match in
                Button { model.choose(match) } label: {
                    HStack {
                        Text(match.label).font(.body)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(index == menu.selected ? theme.accent.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(index == menu.selected ? .isSelected : [])
            }
        }
        .accessibilityLabel(menu.trigger == "@" ? "Mention an entity" : "Link an entity")
    }
}

private struct NoteMenuFrame<Content: View>: View {
    let theme: ApsidesTheme
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) { content }.padding(4)
        }
        .frame(width: 300)
        .frame(maxHeight: 280)
        .background(theme.base, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(theme.secondary.opacity(0.3)))
        .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
        .padding(.top, 6)
        .foregroundStyle(theme.ink)
    }
}
