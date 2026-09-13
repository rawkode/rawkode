import Foundation

/// The position of a node in the document tree: child indices from the root.
public struct NotePath: Hashable, Sendable, Comparable, CustomStringConvertible {
    public var indices: [Int]
    public init(_ indices: [Int]) { self.indices = indices }
    public init(_ indices: Int...) { self.indices = indices }

    public var depth: Int { indices.count }
    public var last: Int { indices.last ?? 0 }
    public var parent: NotePath? { indices.isEmpty ? nil : NotePath(Array(indices.dropLast())) }
    public func appending(_ index: Int) -> NotePath { NotePath(indices + [index]) }
    public func sibling(_ index: Int) -> NotePath { NotePath(indices.dropLast() + [index]) }
    public func isAncestor(of other: NotePath) -> Bool { other.indices.count > indices.count && Array(other.indices.prefix(indices.count)) == indices }
    public static func < (lhs: NotePath, rhs: NotePath) -> Bool { lhs.indices.lexicographicallyPrecedes(rhs.indices) }
    public var description: String { indices.map(String.init).joined(separator: ".") }
}

public struct NoteCaret: Hashable, Sendable {
    public var path: NotePath
    public var offset: Int
    public init(_ path: NotePath, offset: Int = 0) { self.path = path; self.offset = offset }
}

/// A text-bearing block with the list/quote context the view needs to lay it out.
public struct NoteBlock: Equatable, Sendable, Identifiable {
    public enum Marker: Equatable, Sendable { case bullet, number(Int), task(checked: Bool) }
    public var path: NotePath
    public var node: NoteNode
    /// Enclosing lists, outermost first.
    public var listDepth: Int
    public var quoteDepth: Int
    /// Present on the first paragraph of a list item.
    public var marker: Marker?
    /// The enclosing list item, if any.
    public var itemPath: NotePath?
    public var listKind: NoteNode.Kind?
    public var id: NotePath { path }
}

public enum BlockStyle: Equatable, Sendable, Hashable {
    case paragraph, heading(Int), quote, code
}

// MARK: - Tree access

public extension NoteDocument {
    func node(at path: NotePath) -> NoteNode? {
        var nodes = content
        var current: NoteNode?
        for index in path.indices {
            guard nodes.indices.contains(index) else { return nil }
            current = nodes[index]
            nodes = current?.content ?? []
        }
        return current
    }

    mutating func update(at path: NotePath, _ body: (inout NoteNode) -> Void) {
        Self.update(&content, path: path.indices[...], body)
    }

    private static func update(_ nodes: inout [NoteNode], path: ArraySlice<Int>, _ body: (inout NoteNode) -> Void) {
        guard let index = path.first, nodes.indices.contains(index) else { return }
        if path.count == 1 { body(&nodes[index]); return }
        var children = nodes[index].content ?? []
        update(&children, path: path.dropFirst(), body)
        nodes[index].content = children
    }

    /// Replace the node at `path` with zero or more siblings.
    mutating func replace(at path: NotePath, with nodes: [NoteNode]) {
        guard let parent = path.parent else { return }
        if parent.indices.isEmpty {
            guard content.indices.contains(path.last) else { return }
            content.replaceSubrange(path.last...path.last, with: nodes)
        } else {
            update(at: parent) { node in
                var children = node.content ?? []
                guard children.indices.contains(path.last) else { return }
                children.replaceSubrange(path.last...path.last, with: nodes)
                node.content = children.isEmpty ? nil : children
            }
        }
    }

    /// Insert siblings so the first lands at `path`.
    mutating func insert(_ nodes: [NoteNode], at path: NotePath) {
        guard let parent = path.parent else { return }
        if parent.indices.isEmpty {
            content.insert(contentsOf: nodes, at: min(path.last, content.count))
        } else {
            update(at: parent) { node in
                var children = node.content ?? []
                children.insert(contentsOf: nodes, at: min(path.last, children.count))
                node.content = children
            }
        }
    }

    @discardableResult
    mutating func remove(at path: NotePath) -> NoteNode? {
        guard let removed = node(at: path) else { return nil }
        replace(at: path, with: [])
        return removed
    }

    /// Every paragraph, heading and code block in document order with its layout context.
    var blocks: [NoteBlock] {
        var result: [NoteBlock] = []
        func walk(_ nodes: [NoteNode], base: NotePath, listDepth: Int, quoteDepth: Int, itemPath: NotePath?, listKind: NoteNode.Kind?, marker: NoteBlock.Marker?) {
            for (index, node) in nodes.enumerated() {
                let path = base.appending(index)
                switch node.type {
                case .paragraph, .heading, .codeBlock:
                    result.append(NoteBlock(path: path, node: node, listDepth: listDepth, quoteDepth: quoteDepth,
                                            marker: index == 0 ? marker : nil, itemPath: itemPath, listKind: listKind))
                case .blockquote:
                    walk(node.children, base: path, listDepth: listDepth, quoteDepth: quoteDepth + 1, itemPath: itemPath, listKind: listKind, marker: index == 0 ? marker : nil)
                case .bulletList, .orderedList, .taskList:
                    let start = node.attrs?.start ?? 1
                    for (position, item) in node.children.enumerated() {
                        let itemMarker: NoteBlock.Marker = switch node.type {
                        case .orderedList: .number(start + position)
                        case .taskList: .task(checked: item.attrs?.checked ?? false)
                        default: .bullet
                        }
                        walk(item.children, base: path.appending(position), listDepth: listDepth + 1, quoteDepth: quoteDepth,
                             itemPath: path.appending(position), listKind: node.type, marker: itemMarker)
                    }
                default:
                    continue
                }
            }
        }
        walk(content, base: NotePath([]), listDepth: 0, quoteDepth: 0, itemPath: nil, listKind: nil, marker: nil)
        return result
    }

    func block(at path: NotePath) -> NoteBlock? { blocks.first { $0.path == path } }

    func blockBefore(_ path: NotePath) -> NoteBlock? {
        let all = blocks
        guard let index = all.firstIndex(where: { $0.path == path }), index > 0 else { return nil }
        return all[index - 1]
    }

    func blockAfter(_ path: NotePath) -> NoteBlock? {
        let all = blocks
        guard let index = all.firstIndex(where: { $0.path == path }), index + 1 < all.count else { return nil }
        return all[index + 1]
    }

    func lastTextBlockPath(within path: NotePath) -> NotePath? {
        guard let node = node(at: path) else { return nil }
        if node.type.isTextBlock { return path }
        for index in node.children.indices.reversed() {
            if let found = lastTextBlockPath(within: path.appending(index)) { return found }
        }
        return nil
    }

    func firstTextBlockPath(within path: NotePath) -> NotePath? {
        guard let node = node(at: path) else { return nil }
        if node.type.isTextBlock { return path }
        for index in node.children.indices {
            if let found = firstTextBlockPath(within: path.appending(index)) { return found }
        }
        return nil
    }

    func inlineCount(at path: NotePath) -> Int {
        guard let node = node(at: path) else { return 0 }
        return node.type == .codeBlock ? (node.children.first?.text ?? "").count : NoteInlineText.characterCount(node.children)
    }
}

// MARK: - Editing operations

/// Pure structural edits on the Tiptap tree, mirroring the ProseMirror commands
/// the web editor runs. Each returns where the caret belongs afterwards, or nil
/// when the edit was refused and the document is unchanged.
public enum NoteEditing {
    // MARK: Inline content

    public static func setInline(_ document: inout NoteDocument, at path: NotePath, _ inline: [NoteNode]) {
        document.update(at: path) { $0.content = inline.isEmpty ? nil : inline }
    }

    public static func setCodeText(_ document: inout NoteDocument, at path: NotePath, _ text: String) {
        document.update(at: path) { $0.content = text.isEmpty ? nil : [.text(text)] }
    }

    public static func replaceCharacters(_ document: inout NoteDocument, at path: NotePath, range: Range<Int>, with text: AttributedString) {
        guard let node = document.node(at: path), node.type != .codeBlock else { return }
        setInline(&document, at: path, NoteInlineText.replacing(node.children, characters: range, with: text))
    }

    @discardableResult
    public static func insertInline(_ document: inout NoteDocument, _ nodes: [NoteNode], at caret: NoteCaret) -> NoteCaret? {
        guard let node = document.node(at: caret.path), node.type != .codeBlock else { return nil }
        setInline(&document, at: caret.path, NoteInlineText.inserting(nodes, into: node.children, at: caret.offset))
        return NoteCaret(caret.path, offset: caret.offset + NoteInlineText.characterCount(nodes))
    }

    // MARK: Return

    public static func splitBlock(_ document: inout NoteDocument, at caret: NoteCaret) -> NoteCaret? {
        guard let node = document.node(at: caret.path), node.type == .paragraph || node.type == .heading else { return nil }
        let (before, after) = NoteInlineText.split(node.children, at: caret.offset)
        let parent = caret.path.parent.flatMap { document.node(at: $0) }

        if let parent, parent.type.isListItem, caret.path.last == 0 {
            let itemPath = caret.path.parent!
            if before.isEmpty, after.isEmpty, parent.children.count == 1 {
                return liftListItem(&document, itemPath: itemPath)
            }
            let rest = Array(parent.children.dropFirst())
            var newItem = parent.type == .taskItem ? NoteNode.taskItem(checked: false, [.paragraph(after)]) : .listItem([.paragraph(after)])
            newItem.content = (newItem.content ?? []) + rest
            document.update(at: itemPath) { $0.content = [.paragraph(before)] }
            document.insert([newItem], at: itemPath.sibling(itemPath.last + 1))
            return NoteCaret(itemPath.sibling(itemPath.last + 1).appending(0))
        }

        if let parent, parent.type == .blockquote, before.isEmpty, after.isEmpty, caret.path.last == parent.children.count - 1 {
            let quotePath = caret.path.parent!
            if parent.children.count == 1 {
                document.replace(at: quotePath, with: [.paragraph()])
                return NoteCaret(quotePath)
            }
            document.remove(at: caret.path)
            document.insert([.paragraph()], at: quotePath.sibling(quotePath.last + 1))
            return NoteCaret(quotePath.sibling(quotePath.last + 1))
        }

        let atEnd = after.isEmpty && !before.isEmpty
        var first = node
        first.content = before.isEmpty ? nil : before
        var second = atEnd ? NoteNode.paragraph() : node
        if !atEnd { second.content = after.isEmpty ? nil : after }
        document.replace(at: caret.path, with: [first, second])
        return NoteCaret(caret.path.sibling(caret.path.last + 1))
    }

    /// Return inside a code block keeps the block; this exits it explicitly.
    public static func insertParagraphAfter(_ document: inout NoteDocument, path: NotePath) -> NoteCaret {
        document.insert([.paragraph()], at: path.sibling(path.last + 1))
        return NoteCaret(path.sibling(path.last + 1))
    }

    // MARK: Backspace and Delete at block edges

    public static func joinBackward(_ document: inout NoteDocument, at path: NotePath) -> NoteCaret? {
        guard let node = document.node(at: path), node.type.isTextBlock else { return nil }
        let parentPath = path.parent
        let parent = parentPath.flatMap { document.node(at: $0) }

        if let parent, parent.type.isListItem, path.last == 0 {
            let itemPath = parentPath!
            guard itemPath.last > 0 else { return liftListItem(&document, itemPath: itemPath) }
            let previousItem = itemPath.sibling(itemPath.last - 1)
            guard let target = document.lastTextBlockPath(within: previousItem) else { return nil }
            guard let caret = append(&document, node.children, to: target) else { return nil }
            let rest = Array(parent.children.dropFirst())
            document.update(at: previousItem) { $0.content = ($0.content ?? []) + rest }
            document.remove(at: itemPath)
            return caret
        }

        if let parent, parent.type == .blockquote, path.last == 0 {
            let quotePath = parentPath!
            if parent.children.count == 1 { document.replace(at: quotePath, with: [node]) } else {
                document.remove(at: path)
                document.insert([node], at: quotePath)
            }
            return NoteCaret(quotePath)
        }

        if node.type == .codeBlock { return setBlockType(&document, at: path, style: .paragraph).map { NoteCaret($0) } }

        guard path.last > 0 else {
            if node.type == .heading { return setBlockType(&document, at: path, style: .paragraph).map { NoteCaret($0) } }
            return nil
        }
        guard let target = document.lastTextBlockPath(within: path.sibling(path.last - 1)) else { return nil }
        if document.node(at: target)?.type == .codeBlock, !node.children.isEmpty { return nil }
        guard let caret = append(&document, node.children, to: target) else { return nil }
        document.remove(at: path)
        return caret
    }

    public static func joinForward(_ document: inout NoteDocument, at path: NotePath) -> NoteCaret? {
        guard let node = document.node(at: path), node.type.isTextBlock, let next = document.blockAfter(path) else { return nil }
        if let itemPath = next.itemPath, next.path.last == 0, let item = document.node(at: itemPath), item.children.count > 1,
           item.children[1].type.isTextBlock == false { return nil }
        let end = document.inlineCount(at: path)
        if node.type == .codeBlock {
            guard !next.node.containsAtom else { return nil }
            setCodeText(&document, at: path, (node.children.first?.text ?? "") + NoteInlineText.plainText(next.node.children))
        } else {
            let inline = next.node.type == .codeBlock ? [NoteNode.text(next.node.children.first?.text ?? "")].filter { !($0.text ?? "").isEmpty } : next.node.children
            setInline(&document, at: path, node.children + inline)
        }
        removeCollapsing(&document, at: next.path)
        return NoteCaret(path, offset: end)
    }

    private static func append(_ document: inout NoteDocument, _ inline: [NoteNode], to target: NotePath) -> NoteCaret? {
        guard let node = document.node(at: target) else { return nil }
        let end = document.inlineCount(at: target)
        if node.type == .codeBlock {
            guard !inline.contains(where: { $0.type.isAtom }) else { return nil }
            setCodeText(&document, at: target, (node.children.first?.text ?? "") + NoteInlineText.plainText(inline))
        } else {
            setInline(&document, at: target, node.children + inline)
        }
        return NoteCaret(target, offset: end)
    }

    /// Remove a text block, then any list item, list or quote left empty by it.
    public static func removeCollapsing(_ document: inout NoteDocument, at path: NotePath) {
        document.remove(at: path)
        var current = path.parent
        while let parentPath = current, !parentPath.indices.isEmpty, let parent = document.node(at: parentPath) {
            guard parent.children.isEmpty, parent.type != .paragraph else { break }
            document.remove(at: parentPath)
            current = parentPath.parent
        }
    }

    // MARK: Block styles

    /// `applyBlockStyle` on the web: lift out of lists and quotes, clear inline fonts, set the node type.
    public static func setBlockType(_ document: inout NoteDocument, at path: NotePath, style: BlockStyle) -> NotePath? {
        guard let node = document.node(at: path), node.type.isTextBlock else { return nil }
        if style == .code, node.containsAtom { return nil }
        let lifted = liftToTopLevel(&document, path: path)
        let inline = node.type == .codeBlock ? [NoteNode.text(node.children.first?.text ?? "")].filter { !($0.text ?? "").isEmpty }
            : NoteInlineText.clearingFonts(node.children)
        switch style {
        case .paragraph:
            document.replace(at: lifted, with: [.paragraph(inline)])
            return lifted
        case .heading(let level):
            document.replace(at: lifted, with: [.heading(level, inline)])
            return lifted
        case .quote:
            document.replace(at: lifted, with: [.blockquote([.paragraph(inline)])])
            return lifted.appending(0)
        case .code:
            document.replace(at: lifted, with: [.codeBlock(language: nil, NoteInlineText.plainText(inline))])
            return lifted
        }
    }

    public static func setLanguage(_ document: inout NoteDocument, at path: NotePath, _ language: String?) {
        document.update(at: path) { node in
            var attrs = node.attrs ?? NoteAttributes()
            attrs.language = language?.isEmpty == true ? nil : language
            if attrs.language == nil { attrs.nullFields.insert("language") } else { attrs.nullFields.remove("language") }
            node.attrs = attrs
        }
    }

    public static func setAlignment(_ document: inout NoteDocument, at path: NotePath, _ alignment: String?) {
        guard let node = document.node(at: path), node.type == .paragraph || node.type == .heading else { return }
        document.update(at: path) { node in
            var attrs = node.attrs ?? NoteAttributes()
            attrs.textAlign = alignment
            if alignment == nil { attrs.nullFields.insert("textAlign") } else { attrs.nullFields.remove("textAlign") }
            node.attrs = attrs
        }
    }

    /// Move a text block out of every enclosing list and quote, splitting them around it.
    public static func liftToTopLevel(_ document: inout NoteDocument, path: NotePath) -> NotePath {
        var current = path
        while current.depth > 1, let lifted = liftOnce(&document, path: current) { current = lifted }
        return current
    }

    private static func liftOnce(_ document: inout NoteDocument, path: NotePath) -> NotePath? {
        guard let leaf = document.node(at: path), let parentPath = path.parent, let parent = document.node(at: parentPath) else { return nil }
        let children = parent.children
        let before = Array(children.prefix(path.last))
        let after = Array(children.dropFirst(path.last + 1))
        if parent.type == .blockquote {
            var replacement: [NoteNode] = []
            if !before.isEmpty { replacement.append(.blockquote(before)) }
            replacement.append(leaf)
            if !after.isEmpty { replacement.append(.blockquote(after)) }
            document.replace(at: parentPath, with: replacement)
            return parentPath.sibling(parentPath.last + (before.isEmpty ? 0 : 1))
        }
        guard parent.type.isListItem, let listPath = parentPath.parent, let list = document.node(at: listPath) else { return nil }
        // Content before the block stays in its item; content after it (usually a
        // nested list) starts the list that continues below the lifted block.
        var itemsBefore = Array(list.children.prefix(parentPath.last))
        if !before.isEmpty { var shrunk = parent; shrunk.content = before; itemsBefore.append(shrunk) }
        var itemsAfter = Array(list.children.dropFirst(parentPath.last + 1))
        if !after.isEmpty {
            var trailing = parent
            trailing.content = (after.first?.type.isTextBlock == true ? [] : [.paragraph()]) + after
            itemsAfter.insert(trailing, at: 0)
        }
        var replacement: [NoteNode] = []
        if !itemsBefore.isEmpty { var copy = list; copy.content = itemsBefore; replacement.append(copy) }
        replacement.append(leaf)
        if !itemsAfter.isEmpty { var copy = list; copy.content = itemsAfter; replacement.append(copy) }
        document.replace(at: listPath, with: replacement)
        return listPath.sibling(listPath.last + (itemsBefore.isEmpty ? 0 : 1))
    }

    // MARK: Lists

    public static func toggleList(_ document: inout NoteDocument, at path: NotePath, kind: NoteNode.Kind) -> NoteCaret? {
        guard kind.isList, let node = document.node(at: path), node.type.isTextBlock else { return nil }
        if let itemPath = path.parent, let item = document.node(at: itemPath), item.type.isListItem,
           let listPath = itemPath.parent, let list = document.node(at: listPath) {
            if list.type == kind { return liftListItem(&document, itemPath: itemPath) }
            document.update(at: listPath) { list in
                list.type = kind
                if kind == .orderedList { var attrs = NoteAttributes(start: 1); attrs.nullFields = ["type"]; list.attrs = attrs } else { list.attrs = nil }
                list.content = list.children.map { item in
                    var copy = item
                    copy.type = NoteNode.itemKind(forList: kind)
                    copy.attrs = kind == .taskList ? NoteAttributes(checked: item.attrs?.checked ?? false) : nil
                    return copy
                }
            }
            return NoteCaret(path)
        }
        let inline = node.type == .codeBlock ? [NoteNode.text(node.children.first?.text ?? "")].filter { !($0.text ?? "").isEmpty } : node.children
        let item = kind == .taskList ? NoteNode.taskItem(checked: false, [.paragraph(inline)]) : .listItem([.paragraph(inline)])
        let siblings = path.parent.map { $0.indices.isEmpty ? document.content : (document.node(at: $0)?.children ?? []) } ?? document.content
        var start = path.last, end = path.last
        var items: [NoteNode] = []
        if path.last > 0, siblings[path.last - 1].type == kind { start -= 1; items = siblings[start].children }
        let position = items.count
        items.append(item)
        if path.last + 1 < siblings.count, siblings[path.last + 1].type == kind { end += 1; items += siblings[end].children }
        let list: NoteNode = switch kind {
        case .orderedList: .orderedList(items, start: start < path.last ? siblings[start].attrs?.start : nil)
        case .taskList: .taskList(items)
        default: .bulletList(items)
        }
        for _ in start...end { document.remove(at: path.sibling(start)) }
        document.insert([list], at: path.sibling(start))
        return NoteCaret(path.sibling(start).appending(position).appending(0))
    }

    public static func toggleTask(_ document: inout NoteDocument, itemPath: NotePath) {
        document.update(at: itemPath) { item in
            guard item.type == .taskItem else { return }
            item.attrs = NoteAttributes(checked: !(item.attrs?.checked ?? false))
        }
    }

    /// Tab: nest the item under the previous sibling.
    public static func sinkListItem(_ document: inout NoteDocument, at path: NotePath) -> NoteCaret? {
        guard let itemPath = path.parent, let item = document.node(at: itemPath), item.type.isListItem,
              let listPath = itemPath.parent, let list = document.node(at: listPath), itemPath.last > 0 else { return nil }
        let previousPath = itemPath.sibling(itemPath.last - 1)
        guard let previous = document.node(at: previousPath) else { return nil }
        document.remove(at: itemPath)
        let target: NotePath
        if let lastChild = previous.children.last, lastChild.type == list.type {
            let nestedPath = previousPath.appending(previous.children.count - 1)
            document.update(at: nestedPath) { $0.content = ($0.content ?? []) + [item] }
            target = nestedPath.appending(lastChild.children.count)
        } else {
            var nested = list
            nested.content = [item]
            if list.type == .orderedList { var attrs = NoteAttributes(start: 1); attrs.nullFields = ["type"]; nested.attrs = attrs }
            document.update(at: previousPath) { $0.content = ($0.content ?? []) + [nested] }
            target = previousPath.appending(previous.children.count).appending(0)
        }
        return NoteCaret(target.appending(path.last))
    }

    /// Shift-Tab, Return on an empty item, Backspace at the first item: move the item out one level.
    public static func liftListItem(_ document: inout NoteDocument, itemPath: NotePath) -> NoteCaret? {
        guard let item = document.node(at: itemPath), item.type.isListItem,
              let listPath = itemPath.parent, let list = document.node(at: listPath) else { return nil }
        let following = Array(list.children.dropFirst(itemPath.last + 1))
        if let grandPath = listPath.parent, let grand = document.node(at: grandPath), grand.type.isListItem, let outerListPath = grandPath.parent {
            var lifted = item
            if !following.isEmpty { var nested = list; nested.content = following; lifted.content = (lifted.content ?? []) + [nested] }
            let kept = Array(list.children.prefix(itemPath.last))
            if kept.isEmpty { document.remove(at: listPath) } else { document.update(at: listPath) { $0.content = kept } }
            let target = outerListPath.appending(grandPath.last + 1)
            document.insert([lifted], at: target)
            return NoteCaret(target.appending(0))
        }
        let before = Array(list.children.prefix(itemPath.last))
        var replacement: [NoteNode] = []
        if !before.isEmpty { var copy = list; copy.content = before; replacement.append(copy) }
        replacement += item.children
        if !following.isEmpty { var copy = list; copy.content = following; replacement.append(copy) }
        document.replace(at: listPath, with: replacement)
        let first = listPath.sibling(listPath.last + (before.isEmpty ? 0 : 1))
        return NoteCaret(document.firstTextBlockPath(within: first) ?? first)
    }

    // MARK: Components and entities

    public static func component(_ document: NoteDocument, id: String) -> NoteComponent? {
        document.components.first { $0.id.lowercased() == id.lowercased() }
    }

    public static func updateComponent(_ document: inout NoteDocument, _ component: NoteComponent) -> Bool {
        var found = false
        func visit(_ nodes: inout [NoteNode]) {
            for index in nodes.indices {
                if nodes[index].type == .component, nodes[index].attrs?.component?.id.lowercased() == component.id.lowercased() {
                    nodes[index].attrs?.component = component
                    found = true
                } else if var children = nodes[index].content {
                    visit(&children)
                    nodes[index].content = children
                }
            }
        }
        visit(&document.content)
        return found
    }

    public static func removeComponent(_ document: inout NoteDocument, id: String) -> Bool {
        var found = false
        func visit(_ nodes: inout [NoteNode]) {
            nodes.removeAll { node in
                let matches = node.type == .component && node.attrs?.component?.id.lowercased() == id.lowercased()
                if matches { found = true }
                return matches
            }
            for index in nodes.indices {
                guard var children = nodes[index].content else { continue }
                visit(&children)
                nodes[index].content = children.isEmpty && nodes[index].type.isTextBlock ? nil : children
            }
        }
        visit(&document.content)
        return found
    }

    /// Insert a component at the caret; the web keeps it inline in the paragraph.
    @discardableResult
    public static func insertComponent(_ document: inout NoteDocument, _ component: NoteComponent, at caret: NoteCaret) -> NoteCaret? {
        insertInline(&document, [.component(component)], at: caret)
    }

    @discardableResult
    public static func insertEntity(_ document: inout NoteDocument, _ entity: EntityReference, at caret: NoteCaret) -> NoteCaret? {
        insertInline(&document, [.entity(entity)], at: caret)
    }
}
