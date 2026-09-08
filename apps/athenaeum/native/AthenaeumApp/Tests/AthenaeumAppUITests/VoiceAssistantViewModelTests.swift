import XCTest
import AthenaeumRPC
@testable import AthenaeumAppUI

@MainActor
final class VoiceAssistantViewModelTests: XCTestCase {
    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "voice=https://realtime.example/api?credential=private-token"
    }

    func testGenericVoiceFailureSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = VoiceAssistantViewModel.describeError(error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm the voice session state. Review the session before taking another action."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testRealtimeVoiceUnavailableKeepsExplicitConfigurationGuidance() {
        let message = VoiceAssistantViewModel.describeError(
            AthenaeumDomainError.unexpectedError(
                message: "RealtimeVoiceUnavailable: private provider detail"
            )
        )

        XCTAssertEqual(
            message,
            "Voice isn't configured in this environment (no OPENAI_REALTIME_API_KEY " +
                "secret) — this is expected, not a bug. See docs/meetings-voice-decisions.md."
        )
        XCTAssertFalse(message.contains("private provider detail"))
    }

    func testRapidTurnActivationAllowsOnlyOneInFlightSend() {
        var isSending = false

        XCTAssertTrue(VoiceTurnSendPresentation.canStartSend(isSending: isSending))

        isSending = true
        XCTAssertFalse(VoiceTurnSendPresentation.canStartSend(isSending: isSending))

        isSending = false
        XCTAssertTrue(VoiceTurnSendPresentation.canStartSend(isSending: isSending))
    }
}
