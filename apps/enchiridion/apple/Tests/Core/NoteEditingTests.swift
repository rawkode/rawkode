import XCTest
@testable import EnchiridionCore

final class NoteEditingTests: XCTestCase {
    private func text(_ document: NoteDocument, _ path: NotePath) -> String { document.node(at: path)?.plainText ?? "<missing>" }

    func testLayoutCarriesListNumbersTasksAndQuotes() throws {
        let document = try NoteFixture.document()
        let blocks = document.blocks
        XCTAssertEqual(blocks.map { $0.node.type }.prefix(3), [.heading, .paragraph, .paragraph])
        let numbered = blocks.filter { if case .number = $0.marker { true } else { false } }
        XCTAssertEqual(numbered.map(\.marker), [.number(3), .number(4)])
        XCTAssertEqual(numbered.map(\.listDepth), [2, 2])
        let tasks = blocks.filter { if case .task = $0.marker { true } else { false } }
        XCTAssertEqual(tasks.map(\.marker), [.task(checked: true), .task(checked: false)])
        XCTAssertEqual(tasks.first?.listDepth, 3)
        let quoted = try XCTUnwrap(blocks.first { $0.quoteDepth == 1 })
        XCTAssertEqual(quoted.node.plainText, "A quote within the bullet")
        XCTAssertEqual(quoted.listDepth, 1)
        XCTAssertNil(quoted.marker)
        let second = try XCTUnwrap(blocks.first { $0.node.plainText == "Second paragraph in the same item" })
        XCTAssertNil(second.marker)
        XCTAssertEqual(second.itemPath, NotePath(3, 0))
        try XCTAssertEqual(NoteDocument.decode(document.encoded()), document)
    }

    func testReturnSplitsBlocksAndListItemsLikeProseMirror() throws {
        var document = NoteDocument(content: [.heading(1, [.text("Hello world")])])
        var caret = try XCTUnwrap(NoteEditing.splitBlock(&document, at: NoteCaret(NotePath(0), offset: 5)))
        XCTAssertEqual(document.content.map(\.type), [.heading, .heading])
        XCTAssertEqual(text(document, caret.path), " world")
        caret = try XCTUnwrap(NoteEditing.splitBlock(&document, at: NoteCaret(NotePath(1), offset: 6)))
        XCTAssertEqual(document.content.map(\.type), [.heading, .heading, .paragraph])
        XCTAssertEqual(caret, NoteCaret(NotePath(2)))

        document = NoteDocument(content: [.bulletList([.listItem([.paragraph([.text("one two")]), .bulletList([.listItem([.paragraph([.text("nested")])])])])])])
        caret = try XCTUnwrap(NoteEditing.splitBlock(&document, at: NoteCaret(NotePath(0, 0, 0), offset: 3)))
        XCTAssertEqual(caret, NoteCaret(NotePath(0, 1, 0)))
        XCTAssertEqual(text(document, NotePath(0, 0)), "one")
        XCTAssertEqual(document.node(at: NotePath(0, 1))?.children.map(\.type), [.paragraph, .bulletList])
        XCTAssertEqual(text(document, NotePath(0, 1, 0)), " two")

        document = NoteDocument(content: [.taskList([.taskItem(checked: true, [.paragraph([.text("a")])]), .taskItem(checked: false, [.paragraph()])])])
        caret = try XCTUnwrap(NoteEditing.splitBlock(&document, at: NoteCaret(NotePath(0, 1, 0))))
        XCTAssertEqual(document.content.map(\.type), [.taskList, .paragraph])
        XCTAssertEqual(caret, NoteCaret(NotePath(1)))
        caret = try XCTUnwrap(NoteEditing.splitBlock(&document, at: NoteCaret(NotePath(0, 0, 0), offset: 1)))
        XCTAssertEqual(document.node(at: NotePath(0, 1))?.attrs?.checked, false)

        document = NoteDocument(content: [.blockquote([.paragraph([.text("q")]), .paragraph()])])
        caret = try XCTUnwrap(NoteEditing.splitBlock(&document, at: NoteCaret(NotePath(0, 1))))
        XCTAssertEqual(document.content.map(\.type), [.blockquote, .paragraph])
        XCTAssertEqual(document.node(at: NotePath(0))?.children.count, 1)
        XCTAssertNil(NoteEditing.splitBlock(&document, at: NoteCaret(NotePath(9))))
        try XCTAssertEqual(NoteDocument.decode(document.encoded()), document)
    }

    func testBackspaceJoinsListItemsLiftsFirstItemsAndQuotes() throws {
        var document = NoteDocument(content: [
            .paragraph([.text("intro")]),
            .bulletList([.listItem([.paragraph([.text("one")])]), .listItem([.paragraph([.text("two")]), .bulletList([.listItem([.paragraph([.text("deep")])])])]), .listItem([.paragraph([.text("three")])])]),
        ])
        var caret = try XCTUnwrap(NoteEditing.joinBackward(&document, at: NotePath(1, 1, 0)))
        XCTAssertEqual(caret, NoteCaret(NotePath(1, 0, 0), offset: 3))
        XCTAssertEqual(text(document, NotePath(1, 0, 0)), "onetwo")
        XCTAssertEqual(document.node(at: NotePath(1, 0))?.children.map(\.type), [.paragraph, .bulletList])
        XCTAssertEqual(document.node(at: NotePath(1))?.children.count, 2)

        caret = try XCTUnwrap(NoteEditing.joinBackward(&document, at: NotePath(1, 0, 0)))
        XCTAssertEqual(document.content.map(\.type), [.paragraph, .paragraph, .bulletList, .bulletList])
        XCTAssertEqual(caret, NoteCaret(NotePath(1)))
        XCTAssertEqual(text(document, NotePath(2, 0, 0)), "deep")
        XCTAssertEqual(text(document, NotePath(3, 0, 0)), "three")

        caret = try XCTUnwrap(NoteEditing.joinBackward(&document, at: NotePath(1)))
        XCTAssertEqual(caret, NoteCaret(NotePath(0), offset: 5))
        XCTAssertEqual(text(document, NotePath(0)), "introonetwo")

        // The first item of a list lifts out; a second Backspace joins the previous list's last item.
        caret = try XCTUnwrap(NoteEditing.joinBackward(&document, at: NotePath(2, 0, 0)))
        XCTAssertEqual(caret, NoteCaret(NotePath(2)))
        XCTAssertEqual(document.content.map(\.type), [.paragraph, .bulletList, .paragraph])
        caret = try XCTUnwrap(NoteEditing.joinBackward(&document, at: NotePath(2)))
        XCTAssertEqual(caret, NoteCaret(NotePath(1, 0, 0), offset: 4))
        XCTAssertEqual(text(document, NotePath(1, 0, 0)), "deepthree")
        XCTAssertEqual(document.content.count, 2)

        document = NoteDocument(content: [.blockquote([.paragraph([.text("a")]), .paragraph([.text("b")])]), .codeBlock(language: nil, "code"), .heading(2, [.text("h")])])
        XCTAssertEqual(NoteEditing.joinBackward(&document, at: NotePath(0, 0)), NoteCaret(NotePath(0)))
        XCTAssertEqual(document.content.map(\.type), [.paragraph, .blockquote, .codeBlock, .heading])
        XCTAssertNil(NoteEditing.joinBackward(&document, at: NotePath(0)))
        XCTAssertEqual(NoteEditing.joinBackward(&document, at: NotePath(2)), NoteCaret(NotePath(2)))
        XCTAssertEqual(document.node(at: NotePath(2))?.type, .paragraph)
        XCTAssertEqual(NoteEditing.joinBackward(&document, at: NotePath(3)), NoteCaret(NotePath(2), offset: 4))
        XCTAssertEqual(text(document, NotePath(2)), "codeh")
        try XCTAssertEqual(NoteDocument.decode(document.encoded()), document)
    }

    func testDeleteAtEndJoinsTheNextBlockAndCollapsesEmptyContainers() throws {
        var document = NoteDocument(content: [.paragraph([.text("a")]), .bulletList([.listItem([.paragraph([.text("b")])])]), .paragraph([.text("c")])])
        XCTAssertEqual(NoteEditing.joinForward(&document, at: NotePath(0)), NoteCaret(NotePath(0), offset: 1))
        XCTAssertEqual(document.content.map(\.type), [.paragraph, .paragraph])
        XCTAssertEqual(text(document, NotePath(0)), "ab")
        XCTAssertNil(NoteEditing.joinForward(&document, at: NotePath(1)))
        var code = NoteDocument(content: [.codeBlock(language: "swift", "x"), .paragraph([.component(.default(.link))])])
        XCTAssertNil(NoteEditing.joinForward(&code, at: NotePath(0)))
        code.content[1] = .paragraph([.text("y", marks: [.bold])])
        XCTAssertEqual(NoteEditing.joinForward(&code, at: NotePath(0)), NoteCaret(NotePath(0), offset: 1))
        XCTAssertEqual(code.content, [.codeBlock(language: "swift", "xy")])
    }

    func testForwardDeletePreservesRequiredFirstParagraphInListItems() throws {
        for trailing in [NoteNode.heading(2, [.text("heading")]), .codeBlock(language: "swift", "code")] {
            for task in [false, true] {
                let blocks: [NoteNode] = [.paragraph([.text("first")]), trailing]
                let list = task ? NoteNode.taskList([.taskItem(checked: true, blocks)]) : .bulletList([.listItem(blocks)])
                var document = NoteDocument(content: [.paragraph([.text("before")]), list])
                let original = document
                _ = try document.encoded()
                XCTAssertNil(NoteEditing.joinForward(&document, at: NotePath(0)))
                XCTAssertEqual(document, original, "Refused joins must preserve content, marks and task status")
                try XCTAssertEqual(NoteDocument.decode(document.encoded()), original)
            }
        }
        var allowed = NoteDocument(content: [.paragraph([.text("before")]), .bulletList([
            .listItem([.paragraph([.text("first")]), .paragraph([.text("second")])])
        ])])
        XCTAssertEqual(NoteEditing.joinForward(&allowed, at: NotePath(0)), NoteCaret(NotePath(0), offset: 6))
        XCTAssertEqual(allowed.plainText, "beforefirst\nsecond")
        try XCTAssertEqual(NoteDocument.decode(allowed.encoded()), allowed)
    }

    func testBlockStylesLiftOutOfListsAndQuotesAndClearFonts() throws {
        var document = NoteDocument(content: [.bulletList([
            .listItem([.paragraph([.text("one")])]),
            .listItem([.paragraph([.text("two", marks: [.textStyle(fontFamily: "Menlo", fontSize: "20px", color: "red")])]), .bulletList([.listItem([.paragraph([.text("deep")])])])]),
            .listItem([.paragraph([.text("three")])]),
        ])])
        let path = try XCTUnwrap(NoteEditing.setBlockType(&document, at: NotePath(0, 1, 0), style: .heading(2)))
        XCTAssertEqual(path, NotePath(1))
        XCTAssertEqual(document.content.map(\.type), [.bulletList, .heading, .bulletList])
        XCTAssertEqual(document.node(at: NotePath(2))?.children.count, 2)
        XCTAssertEqual(text(document, NotePath(2, 0, 0)), "")
        XCTAssertEqual(text(document, NotePath(2, 0, 1, 0, 0)), "deep")
        let style = document.node(at: NotePath(1))?.children.first?.mark(.textStyle)?.attrs
        XCTAssertEqual(style?.color, "red")
        XCTAssertNil(style?.fontFamily)

        let quoted = try XCTUnwrap(NoteEditing.setBlockType(&document, at: NotePath(1), style: .quote))
        XCTAssertEqual(quoted, NotePath(1, 0))
        XCTAssertEqual(document.node(at: NotePath(1))?.type, .blockquote)
        let code = try XCTUnwrap(NoteEditing.setBlockType(&document, at: NotePath(1, 0), style: .code))
        XCTAssertEqual(code, NotePath(1))
        XCTAssertEqual(document.node(at: NotePath(1)), .codeBlock(language: nil, "two"))

        var withAtom = NoteDocument(content: [.paragraph([.text("see "), .component(.default(.drawing))])])
        XCTAssertNil(NoteEditing.setBlockType(&withAtom, at: NotePath(0), style: .code))
        XCTAssertEqual(withAtom.content[0].type, .paragraph)
        try XCTAssertEqual(NoteDocument.decode(document.encoded()), document)
    }

    func testListTogglingWrapsMergesSwitchesAndLifts() throws {
        var document = NoteDocument(content: [.bulletList([.listItem([.paragraph([.text("a")])])]), .paragraph([.text("b")]), .bulletList([.listItem([.paragraph([.text("c")])])])])
        var caret = try XCTUnwrap(NoteEditing.toggleList(&document, at: NotePath(1), kind: .bulletList))
        XCTAssertEqual(document.content.count, 1)
        XCTAssertEqual(document.content[0].children.map(\.plainText), ["a", "b", "c"])
        XCTAssertEqual(caret, NoteCaret(NotePath(0, 1, 0)))

        caret = try XCTUnwrap(NoteEditing.toggleList(&document, at: NotePath(0, 1, 0), kind: .taskList))
        XCTAssertEqual(document.content[0].type, .taskList)
        XCTAssertEqual(document.content[0].children.map(\.type), [.taskItem, .taskItem, .taskItem])
        XCTAssertEqual(document.content[0].children[1].attrs?.checked, false)
        XCTAssertEqual(caret, NoteCaret(NotePath(0, 1, 0)))

        caret = try XCTUnwrap(NoteEditing.toggleList(&document, at: NotePath(0, 1, 0), kind: .taskList))
        XCTAssertEqual(document.content.map(\.type), [.taskList, .paragraph, .taskList])
        XCTAssertEqual(caret, NoteCaret(NotePath(1)))

        caret = try XCTUnwrap(NoteEditing.toggleList(&document, at: NotePath(1), kind: .orderedList))
        XCTAssertEqual(document.content.map(\.type), [.taskList, .orderedList, .taskList])
        XCTAssertEqual(document.content[1].attrs?.start, 1)
        XCTAssertEqual(document.content[1].attrs?.nullFields, ["type"])

        var heading = NoteDocument(content: [.heading(1, [.text("h")])])
        _ = NoteEditing.toggleList(&heading, at: NotePath(0), kind: .bulletList)
        XCTAssertEqual(heading.content, [.bulletList([.listItem([.paragraph([.text("h")])])])])
        try XCTAssertEqual(NoteDocument.decode(document.encoded()), document)
    }

    func testTabNestsAndShiftTabLiftsCarryingFollowingItems() throws {
        var document = NoteDocument(content: [.orderedList([.listItem([.paragraph([.text("a")])]), .listItem([.paragraph([.text("b")])]), .listItem([.paragraph([.text("c")])])], start: 3)])
        XCTAssertNil(NoteEditing.sinkListItem(&document, at: NotePath(0, 0, 0)))
        var caret = try XCTUnwrap(NoteEditing.sinkListItem(&document, at: NotePath(0, 1, 0)))
        XCTAssertEqual(caret, NoteCaret(NotePath(0, 0, 1, 0, 0)))
        XCTAssertEqual(document.node(at: NotePath(0, 0, 1))?.type, .orderedList)
        XCTAssertEqual(document.node(at: NotePath(0, 0, 1))?.attrs?.start, 1)
        caret = try XCTUnwrap(NoteEditing.sinkListItem(&document, at: NotePath(0, 1, 0)))
        XCTAssertEqual(caret, NoteCaret(NotePath(0, 0, 1, 1, 0)))
        XCTAssertEqual(document.blocks.map(\.marker), [.number(3), .number(1), .number(2)])

        caret = try XCTUnwrap(NoteEditing.liftListItem(&document, itemPath: NotePath(0, 0, 1, 0)))
        XCTAssertEqual(caret, NoteCaret(NotePath(0, 1, 0)))
        XCTAssertEqual(document.node(at: NotePath(0, 0))?.children.count, 1)
        XCTAssertEqual(document.node(at: NotePath(0, 1))?.children.map(\.type), [.paragraph, .orderedList])
        XCTAssertEqual(text(document, NotePath(0, 1, 1, 0, 0)), "c")

        caret = try XCTUnwrap(NoteEditing.liftListItem(&document, itemPath: NotePath(0, 1)))
        XCTAssertEqual(document.content.map(\.type), [.orderedList, .paragraph, .orderedList])
        XCTAssertEqual(caret, NoteCaret(NotePath(1)))
        XCTAssertEqual(text(document, NotePath(2, 0, 0)), "c")
        NoteEditing.toggleTask(&document, itemPath: NotePath(0, 0))
        XCTAssertNil(document.node(at: NotePath(0, 0))?.attrs?.checked)
        try XCTAssertEqual(NoteDocument.decode(document.encoded()), document)
    }

    func testMixedListOutdentRefusesIncompatibleItemKindsWithoutChangingContent() throws {
        for taskOutside in [false, true] {
            let innerItems: [NoteNode] = taskOutside
                ? [.listItem([.paragraph([.text("inner", marks: [.bold])])]), .listItem([.paragraph([.text("following")])])]
                : [.taskItem(checked: true, [.paragraph([.text("inner", marks: [.bold])])]), .taskItem([.paragraph([.text("following")])])]
            let nested = taskOutside ? NoteNode.bulletList(innerItems) : .taskList(innerItems)
            let outerBlocks: [NoteNode] = [.paragraph([.text("outer")]), nested]
            var document = NoteDocument(content: [taskOutside
                ? .taskList([.taskItem(checked: true, outerBlocks)]) : .bulletList([.listItem(outerBlocks)])])
            let original = document
            _ = try document.encoded()
            XCTAssertNil(NoteEditing.liftListItem(&document, itemPath: NotePath(0, 0, 1, 0)))
            XCTAssertEqual(document, original)
            XCTAssertNil(NoteEditing.joinBackward(&document, at: NotePath(0, 0, 1, 0, 0)))
            XCTAssertEqual(document, original)
            try XCTAssertEqual(NoteDocument.decode(document.encoded()), original)

            NoteEditing.setInline(&document, at: NotePath(0, 0, 1, 0, 0), [])
            let emptyItem = document
            XCTAssertNil(NoteEditing.splitBlock(&document, at: NoteCaret(NotePath(0, 0, 1, 0, 0))))
            XCTAssertEqual(document, emptyItem)
            try XCTAssertEqual(NoteDocument.decode(document.encoded()), emptyItem)
        }
    }

    func testComponentsAndEntitiesInsertUpdateAndRemoveInline() throws {
        var document = try NoteFixture.document()
        var component = try XCTUnwrap(NoteEditing.component(document, id: "10000000-0000-4000-8000-000000000002"))
        component.source = "graph TD; A-->B"
        component.svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"
        XCTAssertTrue(NoteEditing.updateComponent(&document, component))
        XCTAssertEqual(NoteEditing.component(document, id: component.id)?.source, "graph TD; A-->B")
        XCTAssertTrue(NoteEditing.removeComponent(&document, id: "10000000-0000-4000-8000-000000000003"))
        XCTAssertFalse(NoteEditing.removeComponent(&document, id: "10000000-0000-4000-8000-000000000003"))
        XCTAssertEqual(document.components.count, 4)
        let caret = try XCTUnwrap(NoteEditing.insertComponent(&document, .default(.diagram), at: NoteCaret(NotePath(2))))
        XCTAssertEqual(caret, NoteCaret(NotePath(2), offset: 1))
        XCTAssertEqual(document.node(at: NotePath(2))?.children.first?.type, .component)
        let entity = EntityReference.canonical(id: NoteIdentifier.new(), label: "Ada", trigger: "@")
        let after = try XCTUnwrap(NoteEditing.insertEntity(&document, entity, at: NoteCaret(NotePath(0), offset: 6)))
        XCTAssertEqual(after.offset, 6 + "@Ada".count)
        XCTAssertEqual(document.node(at: NotePath(0))?.children.map(\.type), [.text, .entity, .text])
        XCTAssertNil(NoteEditing.insertEntity(&document, entity, at: NoteCaret(NotePath(6))))
        try XCTAssertEqual(NoteDocument.decode(document.encoded()), document)
    }

    func testAlignmentLanguageAndExitFromCode() throws {
        var document = NoteDocument(content: [.paragraph([.text("a")]), .codeBlock(language: nil, "x")])
        NoteEditing.setAlignment(&document, at: NotePath(0), "center")
        XCTAssertEqual(document.content[0].attrs?.textAlign, "center")
        NoteEditing.setAlignment(&document, at: NotePath(0), nil)
        XCTAssertEqual(document.content[0], .paragraph([.text("a")]))
        NoteEditing.setLanguage(&document, at: NotePath(1), "swift")
        XCTAssertEqual(document.content[1].attrs?.language, "swift")
        NoteEditing.setLanguage(&document, at: NotePath(1), "")
        XCTAssertEqual(document.content[1], .codeBlock(language: nil, "x"))
        XCTAssertEqual(NoteEditing.insertParagraphAfter(&document, path: NotePath(1)), NoteCaret(NotePath(2)))
        XCTAssertEqual(document.content.count, 3)
    }
}
