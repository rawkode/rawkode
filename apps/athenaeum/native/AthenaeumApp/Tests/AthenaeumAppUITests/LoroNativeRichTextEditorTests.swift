#if os(macOS)
import AppKit
import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumCore
import AthenaeumDomain

final class LoroNativeRichTextEditorTests: XCTestCase {
    private let marks = NSAttributedString.Key("dev.athenaeum.rich.marks.v1")
    private let referenceKey = NSAttributedString.Key("dev.athenaeum.rich.reference.v1")
    private let block = NSAttributedString.Key("dev.athenaeum.rich.block.v1")

    func testRenderedStorageContainsOnlyCodecMarkersAndRoundTripsRichDocument() throws {
        let document = richDocument()
        let editor = LoroNativeRichTextEditorController(document: document, isEditable: true)
        let storage = editor.testingStorage()
        storage.enumerateAttributes(in: NSRange(location: 0, length: storage.length)) { attributes, _, _ in
            XCTAssertTrue(Set(attributes.keys).isSubset(of: [marks, referenceKey, block, .init("dev.athenaeum.rich.separator-before.v1"), .init("dev.athenaeum.rich.separator-after.v1")]))
            XCTAssertNil(attributes[.font]); XCTAssertNil(attributes[.paragraphStyle]); XCTAssertNil(attributes[.foregroundColor])
        }
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(storage), document)
    }

    func testFormattingCommandChangesOnlyMarkerAndCanonicallyRoundTrips() throws {
        var published: [LoroNativeRichDocumentV1] = []
        let editor = LoroNativeRichTextEditorController(document: paragraph("hello"), isEditable: true, onDocumentChange: { published.append($0) })
        editor.testingSelect(NSRange(location: 0, length: 5))
        editor.toggle(mark: .strong)
        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(editor.testingStorage()), editor.testingDocument())
        XCTAssertEqual(editor.testingDocument().semantic.blocks, [.paragraph([.init(text: "hello", marks: [.strong])])])
    }

    func testRichFormattingShortcutsApplyOnlySupportedCanonicalMarks() throws {
        var published: [LoroNativeRichDocumentV1] = []
        let editor = LoroNativeRichTextEditorController(
            document: paragraph("hello"),
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )
        editor.testingSelect(NSRange(location: 0, length: 5))

        XCTAssertTrue(editor.testingHandleFormattingShortcut(charactersIgnoringModifiers: "b", modifierFlags: .command))
        XCTAssertTrue(editor.testingHandleFormattingShortcut(charactersIgnoringModifiers: "i", modifierFlags: .command))
        XCTAssertEqual(published.count, 2)
        XCTAssertEqual(editor.testingDocument().semantic.blocks, [
            .paragraph([.init(text: "hello", marks: [.emphasis, .strong])])
        ])
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(editor.testingStorage()), editor.testingDocument())
    }

    func testRichFormattingShortcutsLeaveUnsupportedAndEmptySelectionEventsToAppKit() {
        var published = 0
        let editor = LoroNativeRichTextEditorController(
            document: paragraph("hello"),
            isEditable: true,
            onDocumentChange: { _ in published += 1 }
        )
        editor.testingSelect(NSRange(location: 0, length: 0))
        XCTAssertFalse(editor.testingHandleFormattingShortcut(charactersIgnoringModifiers: "b", modifierFlags: .command))
        editor.testingSelect(NSRange(location: 0, length: 5))
        XCTAssertFalse(editor.testingHandleFormattingShortcut(charactersIgnoringModifiers: "u", modifierFlags: .command))
        XCTAssertFalse(editor.testingHandleFormattingShortcut(charactersIgnoringModifiers: "b", modifierFlags: [.command, .option]))
        XCTAssertEqual(editor.testingDocument(), paragraph("hello"))
        XCTAssertEqual(published, 0)
    }

    func testDisabledRichFormattingShortcutIsConsumedWithoutMutation() {
        var rejected: [LoroNativeRichTextEditorController.Rejection] = []
        let editor = LoroNativeRichTextEditorController(
            document: paragraph("hello"),
            isEditable: false,
            onRejectedInput: { rejected.append($0) }
        )
        editor.testingSelect(NSRange(location: 0, length: 5))
        XCTAssertTrue(editor.testingHandleFormattingShortcut(charactersIgnoringModifiers: "b", modifierFlags: .command))
        XCTAssertEqual(editor.testingDocument(), paragraph("hello"))
        XCTAssertEqual(rejected, [.disabled])
    }

    func testRichFormattingShortcutDoesNotDisturbMarkedTextComposition() {
        var published = 0
        let source = paragraph("hello")
        let editor = LoroNativeRichTextEditorController(
            document: source,
            isEditable: true,
            onDocumentChange: { _ in published += 1 }
        )
        editor.testingSetMarkedText("intermediate", selectedRange: NSRange(location: 12, length: 0), replacementRange: NSRange(location: 2, length: 0))

        XCTAssertTrue(editor.testingHandleFormattingShortcut(charactersIgnoringModifiers: "b", modifierFlags: .command))
        XCTAssertEqual(editor.testingDocument(), source)
        XCTAssertEqual(editor.testingCompositionReplacement(), "intermediate")
        XCTAssertEqual(published, 0)
    }

    func testPlainPasteIntoEmptyDocumentProducesDeterministicParagraphBlocks() {
        var published: [LoroNativeRichDocumentV1] = []
        let editor = LoroNativeRichTextEditorController(document: paragraph(""), isEditable: true, onDocumentChange: { published.append($0) })
        editor.testingReplace(NSRange(location: 0, length: 0), with: "\nfirst\n\nlast\n")
        XCTAssertEqual(editor.testingDocument().semantic.blocks, [
            .paragraph([]), .paragraph([.init(text: "first")]), .paragraph([]), .paragraph([.init(text: "last")]), .paragraph([])
        ])
        XCTAssertEqual(published.count, 1)
    }

    func testReferencePasteAndReplacementFailClosedWithoutChangingTheMacEditor() {
        var published = 0
        let source = referenceParagraph()
        let editor = LoroNativeRichTextEditorController(document: source, isEditable: true, onDocumentChange: { _ in published += 1 })

        editor.testingPastePlainText("x", at: NSRange(location: 6, length: 0))
        editor.testingReplace(NSRange(location: 5, length: 1), with: "A")

        XCTAssertEqual(editor.testingDocument(), source)
        XCTAssertEqual(published, 0)
    }

    func testReferenceInsertionSeamPublishesTypedAtomicRunAndSelection() throws {
        var published: [LoroNativeRichDocumentV1] = []
        let editor = LoroNativeRichTextEditorController(
            document: paragraph("Meet @pr now"),
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )

        editor.testingInsert(reference: reference(), replacingUTF16Range: NSRange(location: 5, length: 3))

        let expected = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([
            .init(text: "Meet "),
            .init(text: "Alice", reference: reference()),
            .init(text: " now")
        ])]))
        XCTAssertEqual(editor.testingDocument(), expected)
        XCTAssertEqual(editor.testingSelection(), .init(location: 10, length: 0))
        XCTAssertEqual(published, [expected])
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(editor.testingStorage()), expected)
    }

    func testMentionContextCapturesTheAtQueryAndRejectsInlineEmailText() throws {
        let attributed = try LoroNativeRichTextCodec.attributedString(for: paragraph("Meet @al"))
        let context = LoroNativeRichTextMentionContext.detect(
            in: attributed,
            selection: NSRange(location: attributed.length, length: 0)
        )
        XCTAssertEqual(context?.query, "al")
        XCTAssertEqual(context?.utf16Range, NSRange(location: 5, length: 3))

        let email = try LoroNativeRichTextCodec.attributedString(for: paragraph("mail@alice"))
        XCTAssertNil(LoroNativeRichTextMentionContext.detect(
            in: email,
            selection: NSRange(location: email.length, length: 0)
        ))
    }

    func testSupertagContextCapturesHashQueryAndRejectsInlineHashText() throws {
        let attributed = try LoroNativeRichTextCodec.attributedString(for: paragraph("Meet #pro"))
        let context = LoroNativeRichTextSupertagContext.detect(
            in: attributed,
            selection: NSRange(location: attributed.length, length: 0),
            trigger: .supertag
        )
        XCTAssertEqual(context?.trigger, .supertag)
        XCTAssertEqual(context?.query, "pro")
        XCTAssertEqual(context?.utf16Range, NSRange(location: 5, length: 4))

        let inlineHash = try LoroNativeRichTextCodec.attributedString(for: paragraph("C#lang"))
        XCTAssertNil(LoroNativeRichTextSupertagContext.detect(
            in: inlineHash,
            selection: NSRange(location: inlineHash.length, length: 0),
            trigger: .supertag
        ))
    }

    func testSupertagInsertionIsTypedAndCannotBeAdmittedThroughMentionTrigger() throws {
        var supertagContexts: [LoroNativeRichTextSupertagContext] = []
        var rejected: [LoroNativeRichTextEditorController.Rejection] = []
        var published: [LoroNativeRichDocumentV1] = []
        var acknowledgements: [LoroNativeRichTextInlineReferenceInsertionAcknowledgement] = []
        var deliveryOrder: [String] = []
        let editor = LoroNativeRichTextEditorController(
            document: paragraph("Meet #pr"),
            isEditable: true,
            onDocumentChange: { published.append($0); deliveryOrder.append("document") },
            onRejectedInput: { rejected.append($0) },
            onSupertagQueryChange: { context in if let context { supertagContexts.append(context) } },
            onInlineReferenceInserted: { acknowledgements.append($0); deliveryOrder.append("acknowledgement") }
        )

        editor.testingSelect(NSRange(location: 8, length: 0))
        let context = try XCTUnwrap(supertagContexts.last)
        let tag = supertagReference()

        editor.testingApplySupertagInsertion(.init(
            generation: context.generation,
            utf16Range: context.utf16Range,
            reference: tag,
            trigger: .mention
        ))
        XCTAssertEqual(editor.testingDocument(), paragraph("Meet #pr"))
        XCTAssertEqual(published, [])
        XCTAssertEqual(rejected, [.invalidEdit])
        XCTAssertEqual(acknowledgements, [])

        editor.testingApplySupertagInsertion(.init(
            generation: context.generation,
            utf16Range: context.utf16Range,
            reference: reference(),
            trigger: .supertag
        ))
        XCTAssertEqual(editor.testingDocument(), paragraph("Meet #pr"))
        XCTAssertEqual(published, [])
        XCTAssertEqual(rejected, [.invalidEdit, .invalidEdit])
        XCTAssertEqual(acknowledgements, [])

        let command = LoroNativeRichTextSupertagInsertion(
            commandID: UUID(),
            generation: context.generation,
            utf16Range: context.utf16Range,
            reference: tag,
            trigger: .supertag
        )
        editor.testingApplySupertagInsertion(command)
        let expected = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([
            .init(text: "Meet "), .init(text: "Project", reference: tag)
        ])]))
        XCTAssertEqual(editor.testingDocument(), expected)
        XCTAssertEqual(published, [expected])
        XCTAssertEqual(acknowledgements, [.init(command)])
        XCTAssertEqual(deliveryOrder, ["document", "acknowledgement"])
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(editor.testingStorage()), expected)
    }

    func testStaleMentionInsertionIsRejectedAfterTheQueryChanges() throws {
        var contexts: [LoroNativeRichTextMentionContext] = []
        var rejected: [LoroNativeRichTextEditorController.Rejection] = []
        var published: [LoroNativeRichDocumentV1] = []
        let editor = LoroNativeRichTextEditorController(
            document: paragraph("Meet @al"),
            isEditable: true,
            onDocumentChange: { published.append($0) },
            onRejectedInput: { rejected.append($0) },
            onMentionQueryChange: { context in if let context { contexts.append(context) } }
        )

        editor.testingSelect(NSRange(location: 8, length: 0))
        let stale = try XCTUnwrap(contexts.last)
        editor.testingReplace(NSRange(location: 5, length: 3), with: "@alice")
        let current = try XCTUnwrap(contexts.last)
        XCTAssertGreaterThan(current.generation, stale.generation)
        XCTAssertNotEqual(current.utf16Range, stale.utf16Range)

        editor.testingApplyMentionInsertion(.init(
            generation: stale.generation,
            utf16Range: stale.utf16Range,
            reference: reference()
        ))

        XCTAssertEqual(editor.testingDocument(), paragraph("Meet @alice"))
        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(rejected, [.invalidEdit])
    }

    func testStaleMentionInsertionIsRejectedAfterParentDocumentAdoption() throws {
        var contexts: [LoroNativeRichTextMentionContext] = []
        var rejected: [LoroNativeRichTextEditorController.Rejection] = []
        let editor = LoroNativeRichTextEditorController(
            document: paragraph("Meet @al"),
            isEditable: true,
            onRejectedInput: { rejected.append($0) },
            onMentionQueryChange: { context in if let context { contexts.append(context) } }
        )

        editor.testingSelect(NSRange(location: 8, length: 0))
        let stale = try XCTUnwrap(contexts.last)
        editor.update(document: paragraph("Meet @al now"), isEditable: true)
        let current = try XCTUnwrap(contexts.last)
        XCTAssertGreaterThan(current.generation, stale.generation)

        editor.testingApplyMentionInsertion(.init(
            generation: stale.generation,
            utf16Range: stale.utf16Range,
            reference: reference()
        ))

        XCTAssertEqual(editor.testingDocument(), paragraph("Meet @al now"))
        XCTAssertEqual(rejected, [.invalidEdit])
    }

    func testMentionInsertionIsRejectedWhileCompositionOrReadOnlyModeOwnsTheEditor() throws {
        var contexts: [LoroNativeRichTextMentionContext] = []
        var rejected: [LoroNativeRichTextEditorController.Rejection] = []
        let editor = LoroNativeRichTextEditorController(
            document: paragraph("Meet @al"),
            isEditable: true,
            onRejectedInput: { rejected.append($0) },
            onMentionQueryChange: { context in if let context { contexts.append(context) } }
        )
        editor.testingSelect(NSRange(location: 8, length: 0))
        let context = try XCTUnwrap(contexts.last)
        let command = LoroNativeRichTextMentionInsertion(
            generation: context.generation,
            utf16Range: context.utf16Range,
            reference: reference()
        )

        editor.testingBeginComposition(range: NSRange(location: 8, length: 0))
        editor.testingApplyMentionInsertion(command)
        XCTAssertEqual(editor.testingDocument(), paragraph("Meet @al"))
        XCTAssertEqual(rejected, [.invalidEdit])

        editor.testingEndComposition()
        editor.update(document: paragraph("Meet @al"), isEditable: false)
        editor.testingApplyMentionInsertion(command)
        XCTAssertEqual(editor.testingDocument(), paragraph("Meet @al"))
        XCTAssertEqual(rejected, [.invalidEdit, .disabled])
    }

    func testReferenceActivationIsTypedAndDoesNotExposeAProjectionIdentifier() {
        var opened: LoroCanonicalSemanticValueV1.InlineReference?
        let editor = LoroNativeRichTextEditorController(document: referenceParagraph(), isEditable: true, onOpenReference: { opened = $0 })
        XCTAssertFalse(editor.testingOpenReference(atUTF16Offset: 1), "ordinary text is not intercepted")
        XCTAssertTrue(editor.testingOpenReference(atUTF16Offset: 6), "the native hit resolves only the typed marker")
        XCTAssertEqual(opened, reference())
    }

    func testReferenceKeyboardActivationUsesTheCurrentSelectionOnly() {
        var opened = 0
        let editor = LoroNativeRichTextEditorController(document: referenceParagraph(), isEditable: true, onOpenReference: { _ in opened += 1 })
        editor.testingSelect(NSRange(location: 6, length: 0))
        XCTAssertTrue(editor.testingHandleFormattingShortcut(charactersIgnoringModifiers: "\r", modifierFlags: .command))
        editor.testingSelect(NSRange(location: 1, length: 0))
        XCTAssertFalse(editor.testingHandleFormattingShortcut(charactersIgnoringModifiers: "\r", modifierFlags: .command))
        XCTAssertEqual(opened, 1)
    }

    func testDisabledDelegateVetoIsSynchronousAndDoesNotPublish() {
        var rejected: [LoroNativeRichTextEditorController.Rejection] = []
        var published = 0
        let editor = LoroNativeRichTextEditorController(document: paragraph("x"), isEditable: false, onDocumentChange: { _ in published += 1 }, onRejectedInput: { rejected.append($0) })
        let allowed = editor.textView(NSTextView(), shouldChangeTextIn: NSRange(location: 0, length: 0), replacementString: "y")
        XCTAssertFalse(allowed); XCTAssertEqual(editor.testingDocument(), paragraph("x")); XCTAssertEqual(published, 0); XCTAssertEqual(rejected, [.disabled])
    }

    func testOrdinaryDelegateEditRendersOnceAndVetoesTextKitReplay() throws {
        var published: [LoroNativeRichDocumentV1] = []
        let editor = LoroNativeRichTextEditorController(
            document: paragraph("x"),
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )

        let textKitMayReplay = editor.textView(
            NSTextView(),
            shouldChangeTextIn: NSRange(location: 1, length: 0),
            replacementString: "y"
        )

        let expected = paragraph("xy")
        XCTAssertFalse(textKitMayReplay, "the controller has already rendered the only admitted edit")
        XCTAssertEqual(editor.testingDocument(), expected)
        XCTAssertEqual(published, [expected])
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(editor.testingStorage()), expected)
    }

    func testDisabledMarkedTextIsRejectedBeforeDisplayOrSemanticMutation() {
        var rejected: [LoroNativeRichTextEditorController.Rejection] = []
        var published = 0
        let editor = LoroNativeRichTextEditorController(document: paragraph("x"), isEditable: false, onDocumentChange: { _ in published += 1 }, onRejectedInput: { rejected.append($0) })
        let displayed = editor.testingDisplayedString()
        editor.testingSetMarkedText("y", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: 1, length: 0))
        XCTAssertEqual(editor.testingDisplayedString(), displayed)
        XCTAssertEqual(editor.testingDocument(), paragraph("x"))
        XCTAssertEqual(published, 0)
        XCTAssertEqual(rejected, [.disabled])
    }

    func testEqualParentRenderDoesNotResetScalarSelectionAndExternalReplacementPreservesIt() {
        let editor = LoroNativeRichTextEditorController(document: paragraph("A😀B"), isEditable: true)
        let selection = NSRange(location: 1, length: 2)
        editor.testingSelect(selection)
        editor.update(document: paragraph("A😀B"), isEditable: true)
        XCTAssertEqual(editor.testingStorage().string, "A😀B")
        editor.update(document: paragraph("A😀C"), isEditable: true)
        XCTAssertEqual(editor.testingStorage().string, "A😀C")
        XCTAssertEqual(try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: selection, in: editor.testingStorage()), .init(location: 1, length: 1))
    }

    func testSupertagMutationTogglePreservesSelectionAndRestoresCapturedFocusRequest() {
        let document = paragraph("A😀B")
        let editor = LoroNativeRichTextEditorController(document: document, isEditable: true)
        let selection = LoroNativeRichTextSelection(location: 1, length: 1)
        editor.testingSelect(NSRange(location: 1, length: 2))
        XCTAssertEqual(editor.testingSelection(), selection)

        editor.update(document: document, isEditable: false)
        XCTAssertEqual(editor.testingSelection(), selection, "disabling the editor must not lose its semantic selection")

        var focusAttempts = 0
        editor.testingSetFocusAttempt {
            focusAttempts += 1
            return true
        }
        editor.testingRequestFocus(generation: 1, selection: selection)
        XCTAssertEqual(focusAttempts, 0, "a disabled editor cannot consume the restoration request")

        editor.update(document: document, isEditable: true)
        XCTAssertEqual(focusAttempts, 1)
        XCTAssertEqual(editor.testingCompletedFocusGeneration(), 1)
        XCTAssertEqual(editor.testingSelection(), selection, "re-enabled focus must restore the captured semantic selection")
    }

    func testUnacknowledgedLocalProposalDefersDifferentParentDocument() {
        let editor = LoroNativeRichTextEditorController(document: paragraph("base"), isEditable: true)
        editor.testingReplace(NSRange(location: 4, length: 0), with: " local")
        editor.update(document: paragraph("remote"), isEditable: true)
        XCTAssertEqual(editor.testingDocument(), paragraph("base local"))
        editor.update(document: paragraph("base local"), isEditable: true)
        editor.update(document: paragraph("remote"), isEditable: true)
        XCTAssertEqual(editor.testingDocument(), paragraph("remote"))
    }

    func testMarkedTextHooksFlushOnceFromMarkerOnlySnapshotAndDefersParentUpdate() {
        var published: [LoroNativeRichDocumentV1] = []
        let source = richDocument()
        let editor = LoroNativeRichTextEditorController(document: source, isEditable: true, onDocumentChange: { published.append($0) })
        // Exercise GuardedRichTextView's real marked-text overrides rather than the controller
        // composition seam: an IME may put arbitrary display attributes in this transient text.
        let hostileMarkedText = NSAttributedString(string: "!", attributes: [
            .font: NSFont.boldSystemFont(ofSize: 31),
            .link: URL(string: "https://example.invalid")!,
            .init("untrusted.composition.attribute"): "must-not-persist"
        ])
        editor.testingSetMarkedText(hostileMarkedText, selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: 4, length: 0))
        XCTAssertEqual(editor.testingCompositionReplacement(), "!")
        editor.update(document: paragraph("remote"), isEditable: true)
        XCTAssertEqual(editor.testingDocument(), source)
        editor.testingUnmarkText()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(editor.testingDocument().semantic.blocks[0], .heading(level: 1, runs: [.init(text: "titl!e", marks: [.code, .strong])]))
        XCTAssertNoThrow(try LoroNativeRichTextCodec.decode(editor.testingStorage()))
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(published.count, 1, "programmatic render after composition must not republish")
    }

    func testInsertTextFinalizesMarkedTextWithFinalPlainStringExactlyOnce() {
        var published: [LoroNativeRichDocumentV1] = []
        let editor = LoroNativeRichTextEditorController(document: richDocument(), isEditable: true, onDocumentChange: { published.append($0) })
        editor.testingSetMarkedText("intermediate", selectedRange: NSRange(location: 12, length: 0), replacementRange: NSRange(location: 4, length: 0))
        let final = NSAttributedString(string: "final", attributes: [.font: NSFont.boldSystemFont(ofSize: 31), .init("untrusted.final.attribute"): "must-not-persist"])
        editor.testingInsertText(final, replacementRange: NSRange(location: 4, length: 0))
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(editor.testingDocument().semantic.blocks[0], .heading(level: 1, runs: [.init(text: "titlfinale", marks: [.code, .strong])]))
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(published.count, 1)
    }

    func testSupersededCompositionFlushCannotCommitANewComposition() {
        var published: [LoroNativeRichDocumentV1] = []
        let source = richDocument()
        let editor = LoroNativeRichTextEditorController(document: source, isEditable: true, onDocumentChange: { published.append($0) })
        editor.testingSetMarkedText("intermediate-A", selectedRange: NSRange(location: 14, length: 0), replacementRange: NSRange(location: 4, length: 0))
        editor.testingInsertText("A", replacementRange: NSRange(location: 4, length: 0))
        editor.testingUnmarkText()
        editor.testingSetMarkedText("intermediate-B", selectedRange: NSRange(location: 14, length: 0), replacementRange: NSRange(location: 4, length: 0))
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(editor.testingDocument(), source)
        XCTAssertEqual(published.count, 0, "A's queued flush must not commit B's active composition")
        editor.testingInsertText("B", replacementRange: NSRange(location: 4, length: 0))
        editor.testingUnmarkText()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(editor.testingDocument().semantic.blocks[0], .heading(level: 1, runs: [.init(text: "titlBe", marks: [.code, .strong])]))
        XCTAssertEqual(published.count, 1)
    }

    func testDisablingDuringMarkedCompositionCancelsPendingCommitAndRestoresAdmittedDisplay() {
        var published = 0
        let source = richDocument()
        let editor = LoroNativeRichTextEditorController(document: source, isEditable: true, onDocumentChange: { _ in published += 1 })
        editor.testingSetMarkedText("intermediate", selectedRange: NSRange(location: 12, length: 0), replacementRange: NSRange(location: 4, length: 0))
        editor.update(document: source, isEditable: false)
        XCTAssertEqual(editor.testingDocument(), source)
        XCTAssertEqual(editor.testingDisplayedString(), "title\nbody")
        editor.testingUnmarkText()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(editor.testingDocument(), source)
        XCTAssertEqual(editor.testingDisplayedString(), "title\nbody")
        XCTAssertEqual(published, 0)
    }

    func testParentReplacementDuringMarkedTextIsAppliedOnlyAfterSynchronousCancellation() {
        let source = paragraph("today")
        let nextDay = paragraph("tomorrow")
        let editor = LoroNativeRichTextEditorController(document: source, isEditable: true)
        editor.testingSetMarkedText("draft", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 5, length: 0))

        // A date/navigation-like update must not decode or lose marked text. The controller
        // queues the parent document, then cancellation reconciles it from the engine boundary.
        editor.update(document: nextDay, isEditable: false)

        XCTAssertEqual(editor.testingDocument(), nextDay)
        XCTAssertEqual(editor.testingDisplayedString(), "tomorrow")
    }

    func testMultilineInsertionSplitsExistingMarkedHeadingWithoutMarkerOnSeparator() throws {
        let editor = LoroNativeRichTextEditorController(document: richDocument(), isEditable: true)
        editor.testingReplace(NSRange(location: 4, length: 0), with: "\nnext")
        let document = editor.testingDocument()
        XCTAssertEqual(document.semantic.blocks[0], .heading(level: 1, runs: [.init(text: "titl", marks: [.code, .strong])]))
        XCTAssertEqual(document.semantic.blocks[1], .paragraph([.init(text: "nexte", marks: [.code, .strong])]))
        XCTAssertEqual(try LoroNativeRichTextCodec.decode(editor.testingStorage()), document)
    }

    func testEmojiSurrogateInteriorIsRejectedWithoutMutation() {
        var published = 0
        let source = paragraph("A😀B")
        let editor = LoroNativeRichTextEditorController(document: source, isEditable: true, onDocumentChange: { _ in published += 1 })
        editor.testingReplace(NSRange(location: 2, length: 0), with: "x")
        XCTAssertEqual(editor.testingDocument(), source)
        XCTAssertEqual(published, 0)
    }

    func testCrossBlockRangeIsRejectedAtomicallyWithoutMutation() {
        var published = 0
        let source = richDocument()
        let editor = LoroNativeRichTextEditorController(document: source, isEditable: true, onDocumentChange: { _ in published += 1 })
        // The range includes the canonical separator between the heading and paragraph.
        editor.testingReplace(NSRange(location: 4, length: 2), with: "x")
        XCTAssertEqual(editor.testingDocument(), source)
        XCTAssertEqual(published, 0)
    }

    func testInsertionIntoTerminalEncodedEmptyHeadingPreservesHeadingKind() {
        let source = LoroNativeRichDocumentV1(semantic: .init(blocks: [.heading(level: 2, runs: [])]))
        let editor = LoroNativeRichTextEditorController(document: source, isEditable: true)
        editor.testingReplace(NSRange(location: 0, length: 0), with: "title")
        XCTAssertEqual(editor.testingDocument().semantic.blocks, [.heading(level: 2, runs: [.init(text: "title")])])
        XCTAssertNoThrow(try LoroNativeRichTextCodec.decode(editor.testingStorage()))
    }

    func testEditableFocusRequestWaitsForItsNativeAttachmentSignalAndConsumesOnlyOnce() {
        let editor = LoroNativeRichTextEditorController(document: paragraph("focus"), isEditable: true)
        editor.testingRequestFocus(generation: 1)
        XCTAssertEqual(editor.testingCompletedFocusGeneration(), 0)
        var responderAttempts = 0
        editor.testingSetFocusAttempt {
            responderAttempts += 1
            return true
        }
        // This is the same controller entry point GuardedRichTextView calls from
        // `viewDidMoveToWindow`; XCTest does not create a foreground AppKit window.
        editor.testingNotifyViewDidMoveToWindow()
        XCTAssertEqual(responderAttempts, 1)
        XCTAssertEqual(editor.testingCompletedFocusGeneration(), 1)
        editor.testingRequestFocus(generation: 1)
        XCTAssertEqual(editor.testingCompletedFocusGeneration(), 1)
        XCTAssertEqual(responderAttempts, 1)
    }

    func testNativeFocusChangesAreForwardedForWritingSurfacePresentation() {
        var changes: [Bool] = []
        let editor = LoroNativeRichTextEditorController(
            document: paragraph("focus"),
            isEditable: true,
            onFocusChange: { changes.append($0) }
        )

        editor.testingNotifyFocusChanged(true)
        editor.testingNotifyFocusChanged(false)

        XCTAssertEqual(changes, [true, false])
    }

    func testDisabledFocusRequestIsDeferredUntilTheEditorBecomesEditable() {
        let editor = LoroNativeRichTextEditorController(document: paragraph("focus"), isEditable: false)
        editor.testingRequestFocus(generation: 1)
        var responderAttempts = 0
        editor.testingSetFocusAttempt {
            responderAttempts += 1
            return true
        }
        editor.testingNotifyViewDidMoveToWindow()
        XCTAssertEqual(responderAttempts, 0)
        XCTAssertEqual(editor.testingCompletedFocusGeneration(), 0)
        editor.update(document: paragraph("focus"), isEditable: true)
        XCTAssertEqual(responderAttempts, 1)
        XCTAssertEqual(editor.testingCompletedFocusGeneration(), 1)
    }

    private func paragraph(_ text: String) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.paragraph(text.isEmpty ? [] : [.init(text: text)])]))
    }

    private func richDocument() -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [
            .heading(level: 1, runs: [.init(text: "title", marks: [.code, .strong])]),
            .paragraph([.init(text: "body", marks: [.emphasis])])
        ]))
    }

    private func reference() -> LoroCanonicalSemanticValueV1.InlineReference {
        .init(kind: .entity, id: try! EntityId(validating: "10000000-0000-4000-8000-000000000001"), label: "Alice")
    }

    private func supertagReference() -> LoroCanonicalSemanticValueV1.InlineReference {
        .init(kind: .supertag, id: try! EntityId(validating: "10000000-0000-4000-8000-000000000002"), label: "Project")
    }

    private func referenceParagraph() -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.paragraph([
            .init(text: "Meet "), .init(text: "Alice", reference: reference()), .init(text: " today")
        ])]))
    }
}
#endif
