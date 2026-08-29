import XCTest
import AthenaeumRPC
@testable import AthenaeumAppUI

@MainActor
final class AgentChatTitleTests: XCTestCase {
    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
    }

    func testNormalizesWhitespaceWithoutChangingShortPrompt() {
        XCTAssertEqual(
            AgentEditViewModel.chatTitleFromMessage("  Prepare   the standup\nfor tomorrow  "),
            "Prepare the standup for tomorrow"
        )
    }

    func testTruncatesLongPromptToReadableTitle() {
        let title = AgentEditViewModel.chatTitleFromMessage(String(repeating: "A", count: 200))
        XCTAssertEqual(title.count, 48)
        XCTAssertTrue(title.hasSuffix("…"))
    }

    func testProvidesFallbackForWhitespaceOnlyPrompt() {
        XCTAssertEqual(AgentEditViewModel.chatTitleFromMessage(" \n\t "), "New chat")
    }

    func testGenericSendFailureSuppressesUnderlyingTransportDetailsAndPreservesDraftGuidance() {
        let error = PrivateTransportError()
        let message = AgentEditViewModel.describeSendError(error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm that your message was sent. Your draft is still here. " +
                "Review the chat before taking another action."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testNamedChatCreationFailureSuppressesUnderlyingTransportDetailsAndPreservesTitleGuidance() {
        let error = PrivateTransportError()
        let message = AgentEditViewModel.namedChatCreationFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm that the chat was created. Your title is still here. Review existing chats before creating another."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testFirstMessageChatCreationFailureSuppressesUnderlyingTransportDetailsAndPreservesDraftGuidance() {
        let error = PrivateTransportError()
        let message = AgentEditViewModel.firstMessageChatCreationFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm that the chat was created. Your message is still here. Review existing chats before taking another action."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testChatListLoadFailureSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = AgentEditViewModel.chatListLoadFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "Chats couldn’t be loaded. Nothing has been changed. Retry to check your conversations."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testChatDetailLoadFailureSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = AgentEditViewModel.chatDetailLoadFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "This chat couldn’t be loaded. Nothing has been changed. Select it again or reload conversations."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testEmptyChatStateAndFirstPromptRequireLoadedEmptyCatalog() {
        XCTAssertTrue(
            AgentEditViewModel.isLoadedEmptyChatCatalog(chatsAreEmpty: true, status: .loaded)
        )
        XCTAssertFalse(
            AgentEditViewModel.isLoadedEmptyChatCatalog(chatsAreEmpty: true, status: .idle)
        )
        XCTAssertFalse(
            AgentEditViewModel.isLoadedEmptyChatCatalog(chatsAreEmpty: true, status: .loading)
        )
        XCTAssertFalse(
            AgentEditViewModel.isLoadedEmptyChatCatalog(
                chatsAreEmpty: true,
                status: .error("private catalog response")
            )
        )
        XCTAssertFalse(
            AgentEditViewModel.isLoadedEmptyChatCatalog(chatsAreEmpty: false, status: .loaded)
        )
    }

    func testRapidChatListRetryActivationRejectsDuplicatesAndRestoresRetryAffordance() {
        var isRetryInFlight = false

        XCTAssertTrue(
            ChatListRetryPresentation.canStartRetry(
                isRetryInFlight: isRetryInFlight
            )
        )
        XCTAssertEqual(
            ChatListRetryPresentation.retryTitle(
                isRetryInFlight: isRetryInFlight
            ),
            "Retry"
        )

        isRetryInFlight = true
        XCTAssertFalse(
            ChatListRetryPresentation.canStartRetry(
                isRetryInFlight: isRetryInFlight
            )
        )
        XCTAssertEqual(
            ChatListRetryPresentation.retryTitle(
                isRetryInFlight: isRetryInFlight
            ),
            "Retrying…"
        )

        isRetryInFlight = false
        XCTAssertTrue(
            ChatListRetryPresentation.canStartRetry(
                isRetryInFlight: isRetryInFlight
            )
        )
        XCTAssertEqual(
            ChatListRetryPresentation.retryTitle(
                isRetryInFlight: isRetryInFlight
            ),
            "Retry"
        )
    }

    func testRapidNamedChatCreationActivationRejectsDuplicatesUntilItsCompletion() {
        var isCreationInFlight = false

        XCTAssertTrue(
            ChatNamedCreationPresentation.canStartCreation(
                isModelCreating: false,
                isCreationInFlight: isCreationInFlight
            )
        )
        XCTAssertFalse(
            ChatNamedCreationPresentation.isCreating(
                isModelCreating: false,
                isCreationInFlight: isCreationInFlight
            )
        )

        isCreationInFlight = true
        XCTAssertFalse(
            ChatNamedCreationPresentation.canStartCreation(
                isModelCreating: false,
                isCreationInFlight: isCreationInFlight
            )
        )
        XCTAssertTrue(
            ChatNamedCreationPresentation.isCreating(
                isModelCreating: false,
                isCreationInFlight: isCreationInFlight
            )
        )

        isCreationInFlight = false
        XCTAssertTrue(
            ChatNamedCreationPresentation.canStartCreation(
                isModelCreating: false,
                isCreationInFlight: isCreationInFlight
            )
        )
        XCTAssertFalse(
            ChatNamedCreationPresentation.isCreating(
                isModelCreating: false,
                isCreationInFlight: isCreationInFlight
            )
        )
        XCTAssertFalse(
            ChatNamedCreationPresentation.canStartCreation(
                isModelCreating: true,
                isCreationInFlight: false
            )
        )
        XCTAssertTrue(
            ChatNamedCreationPresentation.isCreating(
                isModelCreating: true,
                isCreationInFlight: false
            )
        )
    }

    func testRapidChatComposerActivationRejectsReturnAndSendDuplicatesUntilCompletion() {
        var isSendInFlight = false

        XCTAssertTrue(
            ChatComposerSendPresentation.canStartSend(
                isModelSending: false,
                isModelCreating: false,
                isSendInFlight: isSendInFlight
            )
        )
        XCTAssertEqual(
            ChatComposerSendPresentation.actionTitle(
                isModelSending: false,
                isModelCreating: false,
                isSendInFlight: isSendInFlight,
                hasSelectedChat: true
            ),
            "Send"
        )

        isSendInFlight = true
        XCTAssertFalse(
            ChatComposerSendPresentation.canStartSend(
                isModelSending: false,
                isModelCreating: false,
                isSendInFlight: isSendInFlight
            )
        )
        XCTAssertEqual(
            ChatComposerSendPresentation.actionTitle(
                isModelSending: false,
                isModelCreating: false,
                isSendInFlight: isSendInFlight,
                hasSelectedChat: true
            ),
            "Sending…"
        )
        XCTAssertEqual(
            ChatComposerSendPresentation.actionTitle(
                isModelSending: false,
                isModelCreating: false,
                isSendInFlight: isSendInFlight,
                hasSelectedChat: false
            ),
            "Starting…"
        )

        isSendInFlight = false
        XCTAssertFalse(
            ChatComposerSendPresentation.canStartSend(
                isModelSending: true,
                isModelCreating: false,
                isSendInFlight: isSendInFlight
            )
        )
        XCTAssertEqual(
            ChatComposerSendPresentation.actionTitle(
                isModelSending: true,
                isModelCreating: false,
                isSendInFlight: isSendInFlight,
                hasSelectedChat: true
            ),
            "Sending…"
        )
        XCTAssertFalse(
            ChatComposerSendPresentation.canStartSend(
                isModelSending: false,
                isModelCreating: true,
                isSendInFlight: isSendInFlight
            )
        )
        XCTAssertEqual(
            ChatComposerSendPresentation.actionTitle(
                isModelSending: false,
                isModelCreating: true,
                isSendInFlight: isSendInFlight,
                hasSelectedChat: false
            ),
            "Starting…"
        )

        XCTAssertTrue(
            ChatComposerSendPresentation.canStartSend(
                isModelSending: false,
                isModelCreating: false,
                isSendInFlight: isSendInFlight
            )
        )
    }

    func testRapidChatDetailActivationKeepsTheFirstPendingChatUntilItCompletes() {
        let firstChatId = "chat-first"
        let secondChatId = "chat-second"
        var pendingChatId: String? = firstChatId

        XCTAssertFalse(
            ChatDetailSelectionPresentation.canStartSelection(pendingChatId: pendingChatId)
        )

        pendingChatId = ChatDetailSelectionPresentation.pendingChatId(
            afterCompleting: secondChatId,
            pendingChatId: pendingChatId
        )
        XCTAssertEqual(pendingChatId, firstChatId)

        pendingChatId = ChatDetailSelectionPresentation.pendingChatId(
            afterCompleting: firstChatId,
            pendingChatId: pendingChatId
        )
        XCTAssertNil(pendingChatId)
        XCTAssertTrue(
            ChatDetailSelectionPresentation.canStartSelection(pendingChatId: pendingChatId)
        )
    }

    func testRapidPendingDecisionActivationKeepsTheFirstDecisionUntilItCompletes() {
        var pendingDecision: ChatPendingDecision? = .accept

        XCTAssertFalse(
            ChatPendingDecisionPresentation.canStartDecision(pendingDecision: pendingDecision)
        )

        pendingDecision = ChatPendingDecisionPresentation.pendingDecision(
            afterCompleting: .revert,
            pendingDecision: pendingDecision
        )
        XCTAssertEqual(pendingDecision, .accept)

        pendingDecision = ChatPendingDecisionPresentation.pendingDecision(
            afterCompleting: .accept,
            pendingDecision: pendingDecision
        )
        XCTAssertNil(pendingDecision)
        XCTAssertTrue(
            ChatPendingDecisionPresentation.canStartDecision(pendingDecision: pendingDecision)
        )
    }

    func testPendingChangesAcceptFailureSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = AgentEditViewModel.pendingChangesAcceptFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm that the pending changes were accepted. Review this chat before taking another action."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testPendingChangesRevertFailureSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = AgentEditViewModel.pendingChangesRevertFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm that the pending changes were reverted. Review this chat before taking another action."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testModelUnavailableSendFailureRetainsExplicitConfigurationGuidance() {
        let message = AgentEditViewModel.describeSendError(
            AthenaeumDomainError.unexpectedError(
                message: "ModelClient.converse failed: ModelUnavailable: private provider detail"
            )
        )

        XCTAssertEqual(
            message,
            "The agent model isn't configured in this environment (no ANTHROPIC_API_KEY " +
                "secret) — this is expected, not a bug. See docs/agent-model-client.md."
        )
        XCTAssertFalse(message.contains("private provider detail"))
    }
}
