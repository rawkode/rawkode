import ApsidesCore
import Foundation
import SwiftUI

/// Where the caret lives: one text segment of one block.
struct NoteFocus: Hashable {
    var path: NotePath
    var segment: Int = 0
}

/// A workspace entity the mention menu can insert.
struct EntityMatch: Identifiable, Hashable {
    var id: String
    var label: String
}

/// Search for `@` and `#` menus. The app supplies the authenticated session; previews supply fixtures.
protocol EntityDirectory: Sendable {
    func search(_ query: String) async throws -> [EntityMatch]
}

struct NoSuchDirectory: EntityDirectory {
    func search(_ query: String) async throws -> [EntityMatch] { [] }
}

struct SlashMenuState: Equatable {
    var path: NotePath
    /// Characters of the paragraph covered by `/query`.
    var range: Range<Int>
    var query: String
    var selected = 0
}

struct EntityMenuState: Equatable {
    var path: NotePath
    var trigger: Character
    var range: Range<Int>
    var query: String
    var matches: [EntityMatch] = []
    var loading = false
    var error: String?
    var selected = 0
}

struct SlashCommand: Identifiable, Hashable {
    enum Action: Hashable {
        case style(BlockStyle), list(NoteNode.Kind), component(NoteComponent.Kind)
    }
    var id: String { label }
    var label: String
    var detail: String
    var symbol: String
    var action: Action

    /// The same menu the web editor offers, minus task creation, which needs a mutation this app lacks.
    static let all: [SlashCommand] = [
        SlashCommand(label: "Text", detail: "Plain paragraph", symbol: "text.alignleft", action: .style(.paragraph)),
        SlashCommand(label: "Heading 1", detail: "Type # followed by space", symbol: "1.square", action: .style(.heading(1))),
        SlashCommand(label: "Heading 2", detail: "Type ## followed by space", symbol: "2.square", action: .style(.heading(2))),
        SlashCommand(label: "Heading 3", detail: "Type ### followed by space", symbol: "3.square", action: .style(.heading(3))),
        SlashCommand(label: "Quote", detail: "Type > followed by space", symbol: "text.quote", action: .style(.quote)),
        SlashCommand(label: "Bulleted list", detail: "Type - followed by space", symbol: "list.bullet", action: .list(.bulletList)),
        SlashCommand(label: "Numbered list", detail: "Type 1. followed by space", symbol: "list.number", action: .list(.orderedList)),
        SlashCommand(label: "Checklist", detail: "Checkboxes in this note · type [] then space", symbol: "checklist", action: .list(.taskList)),
        SlashCommand(label: "Code block", detail: "Code stays editable", symbol: "chevron.left.forwardslash.chevron.right", action: .style(.code)),
        SlashCommand(label: "D2 diagram", detail: "A diagram from source", symbol: "point.3.connected.trianglepath.dotted", action: .component(.diagram)),
        SlashCommand(label: "Mermaid diagram", detail: "Flows and sequences", symbol: "arrow.triangle.branch", action: .component(.mermaid)),
        SlashCommand(label: "Drawing", detail: "Pen, shapes, and text", symbol: "pencil.tip.crop.circle", action: .component(.drawing)),
        SlashCommand(label: "Link or video", detail: "Save a link or play imported media", symbol: "link", action: .component(.link)),
    ]

    static func matching(_ query: String) -> [SlashCommand] {
        let needle = query.lowercased()
        return all.filter { needle.isEmpty || $0.label.lowercased().contains(needle) }
    }
}

/// The editing session for one note. The Tiptap tree is the only state; every
/// view derives from it and every keystroke is committed back through here.
@MainActor
final class NoteEditorModel: ObservableObject {
    @Published private(set) var document: NoteDocument
    /// Increments on every document change; hosts debounce saves on it.
    @Published private(set) var revision = 0
    @Published var focus: NoteFocus?
    /// A caret the focused segment should adopt once it is focused.
    @Published var pendingCaret: NoteCaret?
    @Published var slashMenu: SlashMenuState?
    @Published var entityMenu: EntityMenuState?
    @Published var editingComponent: NoteComponent?
    @Published var errorMessage: String?
    @Published private(set) var canUndo = false
    @Published private(set) var canRedo = false
    /// The focused segment's current selection, as paragraph character offsets.
    var selectionRanges: [Range<Int>] = []
    var selectionSegment: NoteFocus?

    let directory: EntityDirectory
    private var undoStack: [NoteDocument] = []
    private var redoStack: [NoteDocument] = []
    private var searchTask: Task<Void, Never>?

    init(document: NoteDocument, directory: EntityDirectory = NoSuchDirectory()) {
        self.document = document
        self.directory = directory
    }

    // MARK: Document mutation

    /// Replace the whole document, for example after a reload from the server.
    func replaceDocument(_ document: NoteDocument) {
        undoStack.removeAll(); redoStack.removeAll()
        canUndo = false; canRedo = false
        slashMenu = nil; entityMenu = nil
        self.document = document
        revision += 1
    }

    func setDocumentWithoutUndo(_ next: NoteDocument) {
        guard next != document else { return }
        document = next
        revision += 1
    }

    private func mutate(undoable: Bool = true, _ body: (inout NoteDocument) -> Void) {
        let before = document
        var next = document
        body(&next)
        guard next != document else { return }
        if undoable {
            undoStack.append(before)
            if undoStack.count > 200 { undoStack.removeFirst() }
            redoStack.removeAll()
        }
        document = next
        revision += 1
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
    }

    func undo() {
        guard let previous = undoStack.popLast() else { return }
        redoStack.append(document)
        document = previous
        revision += 1
        canUndo = !undoStack.isEmpty; canRedo = true
        clampFocus()
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(document)
        document = next
        revision += 1
        canUndo = true; canRedo = !redoStack.isEmpty
        clampFocus()
    }

    private func clampFocus() {
        if let focus, document.node(at: focus.path)?.type.isTextBlock != true {
            self.focus = document.blocks.first.map { NoteFocus(path: $0.path) }
        }
    }

    private func setFocus(_ caret: NoteCaret?) {
        guard let caret else { return }
        let text = NoteInlineText.attributed(document.node(at: caret.path)?.children ?? [])
        let segments = NoteInlineText.segments(text)
        var index = 0
        for (position, segment) in segments.enumerated() {
            if case .text(_, let range) = segment, range.lowerBound <= caret.offset, caret.offset <= range.upperBound { index = position; break }
        }
        focus = NoteFocus(path: caret.path, segment: index)
        pendingCaret = caret
    }

    // MARK: Text segments

    /// The projected, unstyled text of one block for the views to style and edit.
    func inlineText(at path: NotePath) -> AttributedString {
        NoteInlineText.attributed(document.node(at: path)?.children ?? [])
    }

    /// Commit an edited text segment. Newlines split the block; typed shortcuts and triggers are applied.
    func commitText(_ text: AttributedString, at path: NotePath, segment range: Range<Int>, previous: AttributedString) {
        guard let node = document.node(at: path), node.type == .paragraph || node.type == .heading else { return }
        let string = String(text.characters)
        if let newline = text.characters.firstIndex(of: "\n") {
            // The software keyboard's Return arrives as text; with a menu open it picks the item instead.
            if slashMenu?.path == path || entityMenu?.path == path, chooseMenuSelection() { return }
            let head = AttributedString(text[text.startIndex..<newline])
            let tail = AttributedString(text[text.index(afterCharacter: newline)...])
            if node.type == .paragraph, range.lowerBound == 0, let language = NoteShortcuts.fenceLanguage(paragraphText: String(head.characters) + String(tail.characters)) {
                var target = path
                mutate { document in
                    if let lifted = NoteEditing.setBlockType(&document, at: path, style: .code) {
                        NoteEditing.setCodeText(&document, at: lifted, "")
                        NoteEditing.setLanguage(&document, at: lifted, language)
                        target = lifted
                    }
                }
                setFocus(NoteCaret(target))
                return
            }
            mutate { document in
                NoteEditing.replaceCharacters(&document, at: path, range: range, with: head + tail)
            }
            enter(at: NoteCaret(path, offset: range.lowerBound + head.characters.count))
            return
        }
        // The view echoes model-driven changes back; those carry no new keystroke.
        guard NoteInlineText.replacing(node.children, characters: range, with: text) != node.children else { return }
        let previousString = String(previous.characters)
        let insertedCount = string.count - previousString.count
        let caret = insertedCount > 0 ? commonPrefixCount(previousString, string) + insertedCount : commonPrefixCount(previousString, string)
        mutate { document in NoteEditing.replaceCharacters(&document, at: path, range: range, with: text) }
        let beforeCaret = String(string.prefix(caret))
        let typed = insertedCount == 1 ? string.dropFirst(caret - 1).first : nil
        if typed == " ", node.type == .paragraph, range.lowerBound == 0, let shortcut = NoteShortcuts.blockShortcut(prefix: beforeCaret) {
            applyBlockShortcut(shortcut, at: path, prefixLength: caret)
            return
        }
        if insertedCount == 1, let inline = NoteShortcuts.inlineShortcut(before: beforeCaret) {
            let start = range.lowerBound + inline.range.lowerBound
            var replacement = AttributedString(inline.text)
            NoteInlineText.set(inline.mark, enabled: true, in: &replacement, range: replacement.startIndex..<replacement.endIndex)
            mutate { document in
                NoteEditing.replaceCharacters(&document, at: path, range: start..<(range.lowerBound + inline.range.upperBound), with: replacement)
            }
            setFocus(NoteCaret(path, offset: start + inline.text.count))
            return
        }
        updateMenus(at: path, caret: range.lowerBound + caret, segmentStart: range.lowerBound)
    }

    private func commonPrefixCount(_ a: String, _ b: String) -> Int {
        var count = 0
        for (x, y) in zip(a, b) { guard x == y else { break }; count += 1 }
        return count
    }

    func commitCode(_ text: String, at path: NotePath) {
        mutate { document in NoteEditing.setCodeText(&document, at: path, text) }
    }

    /// Called by the focused segment whenever its selection moves.
    func selectionChanged(at path: NotePath, segment: Int, segmentStart: Int, ranges: [Range<Int>]) {
        selectionSegment = NoteFocus(path: path, segment: segment)
        selectionRanges = ranges.map { ($0.lowerBound + segmentStart)..<($0.upperBound + segmentStart) }
        if ranges.count == 1, ranges[0].isEmpty {
            updateMenus(at: path, caret: ranges[0].lowerBound + segmentStart, segmentStart: segmentStart)
        } else {
            slashMenu = nil; entityMenu = nil
        }
    }

    private func updateMenus(at path: NotePath, caret: Int?, segmentStart: Int = 0) {
        guard let caret, let node = document.node(at: path) else { slashMenu = nil; entityMenu = nil; return }
        let text = NoteInlineText.attributed(node.children)
        let segmentText = String(text.characters.prefix(caret).suffix(caret - segmentStart))
        if node.type == .paragraph, segmentStart == 0, let trigger = NoteShortcuts.slashTrigger(before: segmentText) {
            entityMenu = nil
            if slashMenu?.query != trigger.query || slashMenu?.path != path {
                slashMenu = SlashMenuState(path: path, range: trigger.range, query: trigger.query)
            }
            return
        }
        slashMenu = nil
        if let trigger = NoteShortcuts.entityTrigger(before: segmentText) {
            let range = (trigger.range.lowerBound + segmentStart)..<(trigger.range.upperBound + segmentStart)
            if entityMenu?.query != trigger.query || entityMenu?.path != path || entityMenu?.trigger != trigger.character {
                entityMenu = EntityMenuState(path: path, trigger: trigger.character, range: range, query: trigger.query, loading: true)
                search(trigger.query)
            }
            return
        }
        entityMenu = nil
    }

    private func search(_ query: String) {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(180))
            guard !Task.isCancelled, let self else { return }
            do {
                let matches = try await directory.search(query)
                guard !Task.isCancelled, entityMenu?.query == query else { return }
                entityMenu?.matches = matches
                entityMenu?.loading = false
                entityMenu?.selected = 0
            } catch {
                guard !Task.isCancelled, entityMenu?.query == query else { return }
                entityMenu?.loading = false
                entityMenu?.error = error.localizedDescription
            }
        }
    }

    // MARK: Keys

    func enter(at caret: NoteCaret) {
        slashMenu = nil; entityMenu = nil
        var result: NoteCaret?
        mutate { document in result = NoteEditing.splitBlock(&document, at: caret) }
        setFocus(result)
    }

    func insertHardBreak(at caret: NoteCaret) {
        var result: NoteCaret?
        mutate { document in result = NoteEditing.insertInline(&document, [.hardBreak()], at: caret) }
        setFocus(result)
    }

    /// Backspace at the start of a segment: remove the component before it, or join with the previous block.
    func backspaceAtStart(_ focus: NoteFocus) {
        let segments = NoteInlineText.segments(inlineText(at: focus.path))
        if focus.segment > 0, case .component(let component, _) = segments[focus.segment - 1] {
            removeComponent(component)
            return
        }
        var result: NoteCaret?
        mutate { document in result = NoteEditing.joinBackward(&document, at: focus.path) }
        setFocus(result)
    }

    /// Remove the focused block outright; the software keyboard offers no Backspace-at-start signal.
    func deleteFocusedBlock() {
        guard let focus, document.blocks.count > 1 else { return }
        // Earlier paths are unaffected by removing a later block, so the anchor stays valid.
        let anchor = document.blockBefore(focus.path)?.path
        mutate { document in NoteEditing.removeCollapsing(&document, at: focus.path) }
        guard let target = anchor.flatMap({ document.block(at: $0) }) ?? document.blocks.first else { return }
        setFocus(NoteCaret(target.path, offset: document.inlineCount(at: target.path)))
    }

    func mergeFocusedBlockWithPrevious() {
        guard let focus else { return }
        backspaceAtStart(focus)
    }

    func deleteAtEnd(_ focus: NoteFocus) {
        let segments = NoteInlineText.segments(inlineText(at: focus.path))
        if focus.segment + 1 < segments.count, case .component(let component, _) = segments[focus.segment + 1] {
            removeComponent(component)
            return
        }
        var result: NoteCaret?
        mutate { document in result = NoteEditing.joinForward(&document, at: focus.path) }
        setFocus(result)
    }

    func moveFocus(from path: NotePath, forward: Bool) {
        guard let target = forward ? document.blockAfter(path) : document.blockBefore(path) else { return }
        setFocus(NoteCaret(target.path, offset: forward ? 0 : document.inlineCount(at: target.path)))
    }

    func indent() {
        guard let focus else { return }
        var result: NoteCaret?
        mutate { document in result = NoteEditing.sinkListItem(&document, at: focus.path) }
        setFocus(result)
    }

    func outdent() {
        guard let focus, let itemPath = focus.path.parent, document.node(at: itemPath)?.type.isListItem == true else { return }
        var result: NoteCaret?
        mutate { document in result = NoteEditing.liftListItem(&document, itemPath: itemPath) }
        setFocus(result)
    }

    // MARK: Block commands

    var focusedBlock: NoteBlock? { focus.flatMap { document.block(at: $0.path) } }

    var activeStyle: BlockStyle {
        guard let block = focusedBlock else { return .paragraph }
        switch block.node.type {
        case .heading: return .heading(block.node.attrs?.level ?? 1)
        case .codeBlock: return .code
        default: return block.quoteDepth > 0 ? .quote : .paragraph
        }
    }

    func setBlockStyle(_ style: BlockStyle) {
        guard let focus else { return }
        var result: NotePath?
        mutate { document in result = NoteEditing.setBlockType(&document, at: focus.path, style: style) }
        if result == nil, style == .code {
            errorMessage = "This block contains content that cannot be converted safely. Move the component to its own paragraph first."
        }
        setFocus(result.map { NoteCaret($0) })
    }

    func toggleList(_ kind: NoteNode.Kind) {
        guard let focus else { return }
        var result: NoteCaret?
        mutate { document in result = NoteEditing.toggleList(&document, at: focus.path, kind: kind) }
        setFocus(result)
    }

    func toggleTask(itemPath: NotePath) {
        mutate { document in NoteEditing.toggleTask(&document, itemPath: itemPath) }
    }

    func setAlignment(_ alignment: String?) {
        guard let focus else { return }
        mutate { document in NoteEditing.setAlignment(&document, at: focus.path, alignment) }
    }

    func setLanguage(_ language: String, at path: NotePath) {
        mutate(undoable: false) { document in NoteEditing.setLanguage(&document, at: path, language) }
    }

    func exitCodeBlock(at path: NotePath) {
        var result: NoteCaret?
        mutate { document in result = NoteEditing.insertParagraphAfter(&document, path: path) }
        setFocus(result)
    }

    private func applyBlockShortcut(_ shortcut: NoteShortcuts.BlockShortcut, at path: NotePath, prefixLength: Int) {
        var result: NoteCaret?
        mutate { document in
            NoteEditing.replaceCharacters(&document, at: path, range: 0..<prefixLength, with: AttributedString())
            switch shortcut {
            case .heading(let level): result = NoteEditing.setBlockType(&document, at: path, style: .heading(level)).map { NoteCaret($0) }
            case .quote: result = NoteEditing.setBlockType(&document, at: path, style: .quote).map { NoteCaret($0) }
            case .bullet: result = NoteEditing.toggleList(&document, at: path, kind: .bulletList)
            case .ordered(let start):
                result = NoteEditing.toggleList(&document, at: path, kind: .orderedList)
                if let listPath = result?.path.parent?.parent, start != 1 {
                    document.update(at: listPath) { $0.attrs?.start = start }
                }
            case .task(let checked):
                result = NoteEditing.toggleList(&document, at: path, kind: .taskList)
                if checked, let itemPath = result?.path.parent { NoteEditing.toggleTask(&document, itemPath: itemPath) }
            case .code(let language):
                result = NoteEditing.setBlockType(&document, at: path, style: .code).map { NoteCaret($0) }
                if let target = result?.path { NoteEditing.setLanguage(&document, at: target, language) }
            }
        }
        slashMenu = nil
        setFocus(result ?? NoteCaret(path))
    }

    // MARK: Marks

    func markState(_ kind: NoteMark.Kind) -> NoteInlineText.MarkState {
        guard let focus, selectionSegment == focus else { return .none }
        let text = inlineText(at: focus.path)
        let ranges = selectionRanges.map { NoteInlineText.index(in: text, offset: $0.lowerBound)..<NoteInlineText.index(in: text, offset: $0.upperBound) }
        if ranges.allSatisfy(\.isEmpty), let first = ranges.first, first.lowerBound > text.startIndex {
            let before = text.characters.index(before: first.lowerBound)..<first.lowerBound
            return NoteInlineText.state(of: kind, in: text, ranges: [before])
        }
        return NoteInlineText.state(of: kind, in: text, ranges: ranges)
    }

    func toggleMark(_ kind: NoteMark.Kind) {
        withSelection { text, ranges in NoteInlineText.toggle(kind, in: &text, ranges: ranges) }
    }

    func setLink(_ href: String?) {
        withSelection { text, ranges in NoteInlineText.setLink(href, in: &text, ranges: ranges) }
    }

    func updateTextStyle(_ update: @escaping (inout NoteAttributes) -> Void) {
        withSelection { text, ranges in NoteInlineText.updateTextStyle(in: &text, ranges: ranges, update) }
    }

    private func withSelection(_ body: (inout AttributedString, [Range<AttributedString.Index>]) -> Void) {
        guard let focus, selectionSegment == focus, let node = document.node(at: focus.path), node.type != .codeBlock else { return }
        var text = NoteInlineText.attributed(node.children)
        var ranges = selectionRanges.map { NoteInlineText.index(in: text, offset: $0.lowerBound)..<NoteInlineText.index(in: text, offset: $0.upperBound) }
        if ranges.allSatisfy(\.isEmpty) {
            // No selection: format the word around the caret, as there is no typing-attribute API.
            guard let caret = ranges.first?.lowerBound, let word = wordRange(in: text, around: caret) else { return }
            ranges = [word]
        }
        body(&text, ranges)
        mutate { document in NoteEditing.setInline(&document, at: focus.path, NoteInlineText.inline(text)) }
    }

    private func wordRange(in text: AttributedString, around index: AttributedString.Index) -> Range<AttributedString.Index>? {
        let characters = text.characters
        var lower = index, upper = index
        while lower > characters.startIndex, !characters[characters.index(before: lower)].isWhitespace { lower = characters.index(before: lower) }
        while upper < characters.endIndex, !characters[upper].isWhitespace { upper = characters.index(after: upper) }
        return lower < upper ? lower..<upper : nil
    }

    // MARK: Menus

    var slashMatches: [SlashCommand] { slashMenu.map { SlashCommand.matching($0.query) } ?? [] }

    func moveMenuSelection(by delta: Int) {
        if slashMenu != nil {
            let count = max(1, slashMatches.count)
            slashMenu?.selected = ((slashMenu?.selected ?? 0) + delta + count) % count
        } else if let menu = entityMenu {
            let count = max(1, menu.matches.count)
            entityMenu?.selected = (menu.selected + delta + count) % count
        }
    }

    /// Return or Tab while a menu is open; true when the key was consumed.
    func chooseMenuSelection() -> Bool {
        if let menu = slashMenu {
            guard slashMatches.indices.contains(menu.selected) else { return false }
            choose(slashMatches[menu.selected])
            return true
        }
        if let menu = entityMenu {
            guard menu.matches.indices.contains(menu.selected) else { return false }
            choose(menu.matches[menu.selected])
            return true
        }
        return false
    }

    func dismissMenus() { slashMenu = nil; entityMenu = nil }

    func choose(_ command: SlashCommand) {
        guard let menu = slashMenu else { return }
        slashMenu = nil
        var caret: NoteCaret? = NoteCaret(menu.path, offset: menu.range.lowerBound)
        mutate { document in
            NoteEditing.replaceCharacters(&document, at: menu.path, range: menu.range, with: AttributedString())
            switch command.action {
            case .style(let style): caret = NoteEditing.setBlockType(&document, at: menu.path, style: style).map { NoteCaret($0) }
            case .list(let kind): caret = NoteEditing.toggleList(&document, at: menu.path, kind: kind)
            case .component(let kind):
                let component = NoteComponent.default(kind)
                caret = NoteEditing.insertComponent(&document, component, at: NoteCaret(menu.path, offset: menu.range.lowerBound))
                editingComponent = component
            }
        }
        setFocus(caret)
    }

    func choose(_ match: EntityMatch) {
        guard let menu = entityMenu else { return }
        entityMenu = nil
        let reference = EntityReference.canonical(id: match.id, label: match.label, trigger: menu.trigger)
        var caret: NoteCaret?
        mutate { document in
            NoteEditing.replaceCharacters(&document, at: menu.path, range: menu.range, with: AttributedString())
            caret = NoteEditing.insertEntity(&document, reference, at: NoteCaret(menu.path, offset: menu.range.lowerBound))
        }
        setFocus(caret)
    }

    // MARK: Components

    func insertComponent(_ kind: NoteComponent.Kind) {
        let component = NoteComponent.default(kind)
        var caret: NoteCaret?
        mutate { document in
            let target: NoteCaret
            if let focus, let block = document.block(at: focus.path), block.node.type != .codeBlock {
                let offset = selectionSegment == focus ? (selectionRanges.first?.upperBound ?? document.inlineCount(at: focus.path)) : document.inlineCount(at: focus.path)
                target = NoteCaret(focus.path, offset: offset)
            } else {
                document.content.append(.paragraph())
                target = NoteCaret(NotePath(document.content.count - 1))
            }
            caret = NoteEditing.insertComponent(&document, component, at: target)
        }
        setFocus(caret)
        editingComponent = component
    }

    func commit(_ component: NoteComponent) {
        mutate { document in _ = NoteEditing.updateComponent(&document, component) }
        editingComponent = nil
    }

    func removeComponent(_ component: NoteComponent) {
        mutate { document in _ = NoteEditing.removeComponent(&document, id: component.id) }
        if editingComponent?.id == component.id { editingComponent = nil }
    }
}
