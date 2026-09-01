#if os(iOS)
import Foundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

@MainActor
final class LoroNativeRichTextEditorUIKitTests: XCTestCase {
    func testPlainTextProviderIsAllowedAndRichAndAttachmentProvidersAreRejected() {
        let plain = NSItemProvider(object: "plain" as NSString)
        let rich = NSItemProvider()
        rich.registerDataRepresentation(forTypeIdentifier: UTType.rtf.identifier, visibility: .all) { completion in
            completion(Data(), nil)
            return nil
        }
        let attachment = NSItemProvider(object: UIImage(systemName: "paperclip")!)

        XCTAssertTrue(LoroNativeRichTextEditorUIKitController.testingAllowsOnlyLonePlainTextProvider(plain))
        XCTAssertFalse(LoroNativeRichTextEditorUIKitController.testingAllowsOnlyLonePlainTextProvider(rich))
        XCTAssertFalse(LoroNativeRichTextEditorUIKitController.testingAllowsOnlyLonePlainTextProvider(attachment))
    }

    func testCompositionPublishesExactlyOnceFromCapturedSemanticBase() {
        let source = heading("title", marks: [.code, .strong])
        var published: [LoroNativeRichDocumentV1] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: source,
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )

        controller.testingBeginComposition(range: NSRange(location: 4, length: 0))
        controller.testingChangeComposition("intermediate")
        controller.testingFinalizeComposition("final")
        controller.testingEndComposition()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        XCTAssertEqual(controller.testingDocument(), heading("titlfinale", marks: [.code, .strong]))
        XCTAssertEqual(published.count, 1)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(published.count, 1)
    }

    func testParentReplacementCancelsCompositionBeforeRenderingNextDocument() {
        let source = paragraph("today")
        let next = paragraph("tomorrow")
        let controller = LoroNativeRichTextEditorUIKitController(document: source, isEditable: true)

        controller.testingBeginComposition(range: NSRange(location: 5, length: 0))
        controller.testingChangeComposition("draft")
        controller.testingUpdate(document: next, isEditable: false)

        XCTAssertEqual(controller.testingDocument(), next)
    }

    func testChecklistInsertionAdoptsExactAcknowledgementAndMovesFocusIntoEmptyItem() throws {
        let source = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([.init(text: "before", marks: [.strong])]),
            .heading(level: 2, runs: [.init(text: "after")])
        ]))
        var commands: [LoroNativeRichTaskListInsertionCommand] = []
        var published: [LoroNativeRichDocumentV1] = []
        var rejected: [LoroNativeRichTextEditorRejection] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: source,
            isEditable: true,
            onDocumentChange: { published.append($0) },
            onTaskListInsertion: { commands.append($0) },
            onRejectedInput: { rejected.append($0) }
        )

        controller.testingSelect(NSRange(location: 2, length: 0))
        let command = try XCTUnwrap(controller.testingTaskListInsertion())
        let acknowledged = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([.init(text: "before", marks: [.strong])]),
            .taskList([.init(checked: false, runs: [])]),
            .heading(level: 2, runs: [.init(text: "after")])
        ]))
        let acknowledgement = try XCTUnwrap(
            LoroNativeRichTaskListInsertionAcknowledgement(command: command, document: acknowledged)
        )

        controller.applyTaskListInsertionAcknowledgement(acknowledgement)

        XCTAssertEqual(commands, [command])
        XCTAssertEqual(controller.testingDocument(), acknowledged)
        XCTAssertEqual(controller.testingSelection(), .init(location: 7, length: 0))
        XCTAssertTrue(published.isEmpty)
        XCTAssertTrue(rejected.isEmpty)
    }

    func testChecklistInsertionCancellationIsKeyedToThePendingCommand() throws {
        let controller = LoroNativeRichTextEditorUIKitController(document: paragraph("before"), isEditable: true)
        controller.testingSelect(NSRange(location: 2, length: 0))
        let command = try XCTUnwrap(controller.testingTaskListInsertion())

        XCTAssertFalse(
            controller.applyTaskListInsertionCancellation(
                .init(commandID: UUID(), reason: .stale)
            ),
            "a cancellation for another command must not consume the pending request"
        )
        XCTAssertTrue(
            controller.applyTaskListInsertionCancellation(
                .init(commandID: command.commandID, reason: .rejected)
            )
        )
        XCTAssertFalse(
            controller.applyTaskListInsertionCancellation(
                .init(commandID: command.commandID, reason: .rejected)
            ),
            "the same cancellation must be idempotent"
        )
    }

    func testAcknowledgedParentDocumentRetainsThePublishedSemanticValueWithoutASecondWrite() throws {
        let source = heading("title", marks: [.code, .strong])
        var published: [LoroNativeRichDocumentV1] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: source,
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )

        controller.testingReplace(NSRange(location: 5, length: 0), with: " today")
        let persisted = try XCTUnwrap(published.first)
        controller.testingUpdate(document: persisted, isEditable: true)

        XCTAssertEqual(persisted, heading("title today", marks: [.code, .strong]))
        XCTAssertEqual(controller.testingDocument(), persisted)
        XCTAssertEqual(published, [persisted])
    }

    func testBlockStyleControlUsesLiveSelectionAndPublishesOneSemanticDocument() {
        let source = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([.init(text: "title", marks: [.strong])]),
            .heading(level: 2, runs: [.init(text: "notes")])
        ]))
        var published: [LoroNativeRichDocumentV1] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: source,
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )
        controller.testingSelect(NSRange(location: 1, length: 2))

        XCTAssertEqual(controller.blockStyleState(), .init(current: .text, isEnabled: true))
        XCTAssertTrue(controller.testingRequestBlockStyle(.h1))
        let expected = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .heading(level: 1, runs: [.init(text: "title", marks: [.strong])]),
            .heading(level: 2, runs: [.init(text: "notes")])
        ]))
        XCTAssertEqual(controller.testingDocument(), expected)
        XCTAssertEqual(controller.testingSelection(), .init(location: 1, length: 2))
        XCTAssertEqual(published, [expected])
        XCTAssertFalse(controller.blockStyleState().isEnabled, "a pending local proposal disables a second style mutation until the parent acknowledges it")
    }

    func testBlockStyleMenuUsesFrozenTargetWhenSelectionMovesBeforeChoice() {
        let source = LoroNativeRichDocumentV1(semantic: .init(blocks: [
            .paragraph([.init(text: "title")]),
            .paragraph([.init(text: "notes")])
        ]))
        var published: [LoroNativeRichDocumentV1] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: source,
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )
        let host = LoroNativeRichTextEditorUIKitHostView(controller: controller, textView: controller.makeTextView())
        controller.testingSelect(NSRange(location: 1, length: 0))
        XCTAssertTrue(host.testingCaptureStyleMenuTarget())

        // A menu can move focus to another range before its action runs. The action must still
        // use the target captured when the menu opened, not this later selection.
        controller.testingSelect(NSRange(location: 7, length: 0))
        XCTAssertTrue(host.testingApplyStyleFromMenu(.h1))
        XCTAssertEqual(controller.testingDocument(), .init(semantic: .init(blocks: [
            .heading(level: 1, runs: [.init(text: "title")]),
            .paragraph([.init(text: "notes")])
        ])))
        XCTAssertEqual(published.count, 1)
    }

    func testOrdinaryDelegateEditRendersOnceAndVetoesUIKitReplay() {
        var published: [LoroNativeRichDocumentV1] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: paragraph("x"),
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )

        let textKitMayReplay = controller.textView(
            UITextView(),
            shouldChangeTextIn: NSRange(location: 1, length: 0),
            replacementText: "y"
        )

        let expected = paragraph("xy")
        XCTAssertFalse(textKitMayReplay, "the controller has already rendered the only admitted edit")
        XCTAssertEqual(controller.testingDocument(), expected)
        XCTAssertEqual(published, [expected])
    }

    func testReferencePasteAndActivationStayAtTheTypedUIKitBoundary() {
        let source = referenceParagraph()
        var opened: LoroCanonicalSemanticValueV1.InlineReference?
        let controller = LoroNativeRichTextEditorUIKitController(
            document: source,
            isEditable: true,
            onOpenReference: { opened = $0 }
        )

        controller.testingPastePlainText("x", at: NSRange(location: 6, length: 0))
        XCTAssertFalse(controller.testingOpenReference(atUTF16Offset: 1))
        XCTAssertTrue(controller.testingOpenReference(atUTF16Offset: 6))

        XCTAssertEqual(controller.testingDocument(), source)
        XCTAssertEqual(opened, reference())
    }

    func testReferenceInsertionSeamPublishesTypedAtomicRunAndSelection() {
        var published: [LoroNativeRichDocumentV1] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: paragraph("Meet @pr now"),
            isEditable: true,
            onDocumentChange: { published.append($0) }
        )

        controller.testingInsert(reference: reference(), replacingUTF16Range: NSRange(location: 5, length: 3))

        let expected = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([
            .init(text: "Meet "),
            .init(text: "Project", reference: reference()),
            .init(text: " now")
        ])]))
        XCTAssertEqual(controller.testingDocument(), expected)
        XCTAssertEqual(controller.testingSelection(), .init(location: 12, length: 0))
        XCTAssertEqual(published, [expected])
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
        var rejected: [LoroNativeRichTextEditorRejection] = []
        var published: [LoroNativeRichDocumentV1] = []
        var acknowledgements: [LoroNativeRichTextInlineReferenceInsertionAcknowledgement] = []
        var deliveryOrder: [String] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: paragraph("Meet #pr"),
            isEditable: true,
            onDocumentChange: { published.append($0); deliveryOrder.append("document") },
            onRejectedInput: { rejected.append($0) },
            onSupertagQueryChange: { context in if let context { supertagContexts.append(context) } },
            onInlineReferenceInserted: { acknowledgements.append($0); deliveryOrder.append("acknowledgement") }
        )

        controller.testingSelect(NSRange(location: 8, length: 0))
        let context = try XCTUnwrap(supertagContexts.last)
        let tag = reference()

        controller.testingApplySupertagInsertion(.init(
            generation: context.generation,
            utf16Range: context.utf16Range,
            reference: tag,
            trigger: .mention
        ))
        XCTAssertEqual(controller.testingDocument(), paragraph("Meet #pr"))
        XCTAssertEqual(published, [])
        XCTAssertEqual(rejected, [.invalidEdit])
        XCTAssertEqual(acknowledgements, [])

        controller.testingApplySupertagInsertion(.init(
            generation: context.generation,
            utf16Range: context.utf16Range,
            reference: .init(
                kind: .entity,
                id: try! EntityId(validating: "10000000-0000-4000-8000-000000000001"),
                label: "Alice"
            ),
            trigger: .supertag
        ))
        XCTAssertEqual(controller.testingDocument(), paragraph("Meet #pr"))
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
        controller.testingApplySupertagInsertion(command)
        let expected = LoroNativeRichDocumentV1(semantic: .init(blocks: [.paragraph([
            .init(text: "Meet "), .init(text: "Project", reference: tag)
        ])]))
        XCTAssertEqual(controller.testingDocument(), expected)
        XCTAssertEqual(published, [expected])
        XCTAssertEqual(acknowledgements, [.init(command)])
        XCTAssertEqual(deliveryOrder, ["document", "acknowledgement"])
    }

    func testStaleMentionInsertionIsRejectedAfterTheQueryChanges() throws {
        var contexts: [LoroNativeRichTextMentionContext] = []
        var rejected: [LoroNativeRichTextEditorRejection] = []
        var published: [LoroNativeRichDocumentV1] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: paragraph("Meet @al"),
            isEditable: true,
            onDocumentChange: { published.append($0) },
            onRejectedInput: { rejected.append($0) },
            onMentionQueryChange: { context in if let context { contexts.append(context) } }
        )

        controller.testingSelect(NSRange(location: 8, length: 0))
        let stale = try XCTUnwrap(contexts.last)
        controller.testingReplace(NSRange(location: 5, length: 3), with: "@alice")
        let current = try XCTUnwrap(contexts.last)
        XCTAssertGreaterThan(current.generation, stale.generation)
        XCTAssertNotEqual(current.utf16Range, stale.utf16Range)

        controller.testingApplyMentionInsertion(.init(
            generation: stale.generation,
            utf16Range: stale.utf16Range,
            reference: reference()
        ))

        XCTAssertEqual(controller.testingDocument(), paragraph("Meet @alice"))
        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(rejected, [.invalidEdit])
    }

    func testStaleMentionInsertionIsRejectedAfterParentDocumentAdoption() throws {
        var contexts: [LoroNativeRichTextMentionContext] = []
        var rejected: [LoroNativeRichTextEditorRejection] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: paragraph("Meet @al"),
            isEditable: true,
            onRejectedInput: { rejected.append($0) },
            onMentionQueryChange: { context in if let context { contexts.append(context) } }
        )

        controller.testingSelect(NSRange(location: 8, length: 0))
        let stale = try XCTUnwrap(contexts.last)
        controller.testingUpdate(document: paragraph("Meet @al now"), isEditable: true)
        let current = try XCTUnwrap(contexts.last)
        XCTAssertGreaterThan(current.generation, stale.generation)

        controller.testingApplyMentionInsertion(.init(
            generation: stale.generation,
            utf16Range: stale.utf16Range,
            reference: reference()
        ))

        XCTAssertEqual(controller.testingDocument(), paragraph("Meet @al now"))
        XCTAssertEqual(rejected, [.invalidEdit])
    }

    func testMentionInsertionIsRejectedWhileCompositionOrReadOnlyModeOwnsTheEditor() throws {
        var contexts: [LoroNativeRichTextMentionContext] = []
        var rejected: [LoroNativeRichTextEditorRejection] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: paragraph("Meet @al"),
            isEditable: true,
            onRejectedInput: { rejected.append($0) },
            onMentionQueryChange: { context in if let context { contexts.append(context) } }
        )
        controller.testingSelect(NSRange(location: 8, length: 0))
        let context = try XCTUnwrap(contexts.last)
        let command = LoroNativeRichTextMentionInsertion(
            generation: context.generation,
            utf16Range: context.utf16Range,
            reference: reference()
        )

        controller.testingBeginComposition(range: NSRange(location: 8, length: 0))
        controller.testingApplyMentionInsertion(command)
        XCTAssertEqual(controller.testingDocument(), paragraph("Meet @al"))
        XCTAssertEqual(rejected, [.invalidEdit])

        controller.testingEndComposition()
        controller.testingUpdate(document: paragraph("Meet @al"), isEditable: false)
        controller.testingApplyMentionInsertion(command)
        XCTAssertEqual(controller.testingDocument(), paragraph("Meet @al"))
        XCTAssertEqual(rejected, [.invalidEdit, .disabled])
    }

    func testReferenceKeyboardSelectionActivationUsesOnlyTheTypedMarker() {
        var opened = 0
        let controller = LoroNativeRichTextEditorUIKitController(document: referenceParagraph(), isEditable: true, onOpenReference: { _ in opened += 1 })
        controller.testingOpenReference(atUTF16Offset: 6)
        XCTAssertEqual(opened, 1)
    }

    func testNativeFocusChangesAreForwardedForWritingSurfacePresentation() {
        var changes: [Bool] = []
        let controller = LoroNativeRichTextEditorUIKitController(
            document: paragraph("focus"),
            isEditable: true,
            onFocusChange: { changes.append($0) }
        )

        controller.testingNotifyFocusChanged(true)
        controller.testingNotifyFocusChanged(false)

        XCTAssertEqual(changes, [true, false])
    }

    func testSupertagMutationTogglePreservesSelectionAndRestoresCapturedFocusRequest() {
        let document = paragraph("A😀B")
        let controller = LoroNativeRichTextEditorUIKitController(document: document, isEditable: true)
        let selection = LoroNativeRichTextSelection(location: 1, length: 1)
        controller.testingSelect(NSRange(location: 1, length: 2))
        XCTAssertEqual(controller.testingSelection(), selection)

        controller.testingUpdate(document: document, isEditable: false)
        XCTAssertEqual(controller.testingSelection(), selection, "disabling the editor must not lose its semantic selection")

        var focusAttempts = 0
        controller.testingSetFocusAttempt {
            focusAttempts += 1
            return true
        }
        controller.testingRequestFocus(generation: 1, selection: selection)
        XCTAssertEqual(focusAttempts, 0, "a disabled editor cannot consume the restoration request")

        controller.testingUpdate(document: document, isEditable: true)
        XCTAssertEqual(focusAttempts, 1)
        XCTAssertEqual(controller.testingCompletedFocusGeneration(), 1)
        XCTAssertEqual(controller.testingSelection(), selection, "re-enabled focus must restore the captured semantic selection")
    }

    func testHostedUIKitSupertagPickerCapturesFocusBeforePresentationAndRestoresAfterSuccess() throws {
        try exerciseHostedUIKitSupertagPicker(shouldFail: false)
    }

    func testHostedUIKitSupertagPickerCapturesFocusBeforePresentationAndRestoresAfterFailure() throws {
        try exerciseHostedUIKitSupertagPicker(shouldFail: true)
    }

    private func exerciseHostedUIKitSupertagPicker(shouldFail: Bool) throws {
        let node = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e62")
        let tag = RPCTag(id: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e63", name: "Person", builtin: false)
        let state = LoroNativeRichEditorState(
            document: .init(semantic: .init(blocks: [.paragraph([.init(text: "A😀B")])])),
            route: .init(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64)),
            replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64))
        )
        let probe = HostedUIKitSupertagPickerProbe()
        let host = UIHostingController(rootView: HostedUIKitSupertagPickerHarness(state: state, tag: tag, shouldFail: shouldFail, probe: probe))
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }

        guard let editor = findUIKitTextView(withString: "A😀B", in: window) else {
            return XCTFail("expected the hosted UIKit rich editor")
        }
        XCTAssertTrue(editor.becomeFirstResponder())
        editor.selectedRange = NSRange(location: 1, length: 2)
        editor.delegate?.textViewDidChangeSelection?(editor)
        pumpUIKitRunLoop(until: { probe.editorFocused && probe.selection != nil })

        guard let picker = findUIKitButton(withIdentifier: "test-daily-note-supertag-picker-trigger", in: window) else {
            return XCTFail("expected the hosted UIKit picker trigger")
        }
        picker.sendActions(for: .touchUpInside)
        pumpUIKitRunLoop(until: { probe.capturedFocused })
        XCTAssertEqual(probe.capturedSelection, .init(location: 1, length: 1))

        // UIHostingController keeps pure SwiftUI popover controls in a virtual accessibility
        // tree, so a unit-hosted UIKit test cannot reliably activate that row as a UIButton.
        // The native trigger below drives the same capture and assignment closures while the
        // production picker remains mounted; the AppKit host test exercises the real popover.
        pumpUIKitRunLoop(until: {
            findUIKitButton(withIdentifier: "test-daily-note-supertag-\(tag.id)", in: window) != nil
        })
        guard let tagButton = findUIKitButton(withIdentifier: "test-daily-note-supertag-\(tag.id)", in: window) else {
            return XCTFail("expected the hosted UIKit Supertag choice trigger")
        }
        tagButton.sendActions(for: .touchUpInside)
        pumpUIKitRunLoop(until: { probe.mutationEntered && probe.finished })
        XCTAssertEqual(probe.selectionDuringMutation, .init(location: 1, length: 1))
        XCTAssertTrue(probe.restoredFocused || editor.isFirstResponder, "the same hosted editor must retain or regain first responder")
        let restoredSelection = try XCTUnwrap(
            try? LoroNativeRichTextCodec.scalarSelection(forUTF16Range: editor.selectedRange, in: editor.attributedText)
        )
        XCTAssertEqual(restoredSelection, .init(location: 1, length: 1))
        XCTAssertEqual(probe.didFail, shouldFail)
    }

    private func paragraph(_ text: String) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.paragraph([.init(text: text)])]))
    }

    private func heading(_ text: String, marks: [LoroCanonicalSemanticValueV1.Mark]) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.heading(level: 1, runs: [.init(text: text, marks: marks)])]))
    }

    private func reference() -> LoroCanonicalSemanticValueV1.InlineReference {
        .init(kind: .supertag, id: try! EntityId(validating: "10000000-0000-4000-8000-000000000002"), label: "Project")
    }

    private func referenceParagraph() -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.paragraph([
            .init(text: "Meet "), .init(text: "Project", reference: reference())
        ])]))
    }
}

@MainActor
private final class HostedUIKitSupertagPickerProbe: ObservableObject {
    var editorFocused = false
    var selection: LoroNativeRichTextSelection?
    var capturedFocused = false
    var capturedSelection: LoroNativeRichTextSelection?
    var mutationEntered = false
    var selectionDuringMutation: LoroNativeRichTextSelection?
    var finished = false
    var restoredFocused = false
    var didFail = false
}

@MainActor
private struct HostedUIKitSupertagPickerHarness: View {
    let state: LoroNativeRichEditorState
    let tag: RPCTag
    let shouldFail: Bool
    @ObservedObject var probe: HostedUIKitSupertagPickerProbe
    @State private var editorIsEditable = true
    @State private var editorIsFocused = false
    @State private var selection: LoroNativeRichTextSelection?
    @State private var focusGeneration = 0
    @State private var pickerPresented = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            LoroNativeRichTextEditorUIKit(
                state: state,
                isEditable: editorIsEditable,
                focusRequestGeneration: focusGeneration,
                focusRequestSelection: probe.capturedSelection,
                onDocumentChange: { _ in },
                onSelectionChange: {
                    selection = $0
                    probe.selection = $0
                },
                onRejectedInput: { _ in },
                onFocusChange: {
                    editorIsFocused = $0
                    probe.editorFocused = $0
                    if $0 && probe.mutationEntered {
                        probe.restoredFocused = true
                    }
                },
                onOpenReference: { _ in }
            )
            .frame(height: 260)

            DailyNoteSupertagPicker(
                tags: [tag],
                appliedTagIds: [],
                isDisabled: !editorIsEditable,
                onWillAssign: {
                    probe.capturedFocused = editorIsFocused
                    probe.capturedSelection = selection
                },
                onAssign: { _ in
                    probe.mutationEntered = true
                    probe.selectionDuringMutation = probe.capturedSelection
                    editorIsEditable = false
                    probe.didFail = shouldFail
                    editorIsEditable = true
                    focusGeneration &+= 1
                    probe.finished = true
                }
            )

            // This explicit UIKit bridge is test-only. UIHostingController exposes SwiftUI's
            // popover controls as virtual accessibility nodes, not reliable UIButtons, so the
            // hosted regression uses a real UIKit control to exercise the same callback boundary.
            HostedUIKitPickerTrigger(
                identifier: "test-daily-note-supertag-picker-trigger",
                title: "Choose a Supertag",
                action: {
                    probe.capturedFocused = editorIsFocused
                    probe.capturedSelection = selection
                    pickerPresented = true
                }
            )
            if pickerPresented {
                HostedUIKitPickerTrigger(
                    identifier: "test-daily-note-supertag-\(tag.id)",
                    title: tag.name,
                    action: {
                        probe.mutationEntered = true
                        probe.selectionDuringMutation = probe.capturedSelection
                        editorIsEditable = false
                        probe.didFail = shouldFail
                        editorIsEditable = true
                        focusGeneration &+= 1
                        probe.finished = true
                    }
                )
            }
        }
        .padding()
    }
}

@MainActor
private struct HostedUIKitPickerTrigger: UIViewRepresentable {
    let identifier: String
    let title: String
    let action: () -> Void

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        button.accessibilityIdentifier = identifier
        button.setTitle(title, for: .normal)
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        button.accessibilityIdentifier = identifier
        button.setTitle(title, for: .normal)
    }
}

@MainActor
private func findUIKitTextView(withString string: String, in root: UIView) -> UITextView? {
    if let textView = root as? UITextView, textView.text == string { return textView }
    for child in root.subviews {
        if let found = findUIKitTextView(withString: string, in: child) { return found }
    }
    return nil
}

@MainActor
private func findUIKitButton(withIdentifier identifier: String, in root: UIView) -> UIButton? {
    if let button = root as? UIButton, button.accessibilityIdentifier == identifier { return button }
    for child in root.subviews {
        if let found = findUIKitButton(withIdentifier: identifier, in: child) { return found }
    }
    return nil
}

@MainActor
private func pumpUIKitRunLoop(until predicate: @escaping @MainActor () -> Bool) {
    let deadline = Date().addingTimeInterval(2)
    while !predicate() && Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
}
#endif
