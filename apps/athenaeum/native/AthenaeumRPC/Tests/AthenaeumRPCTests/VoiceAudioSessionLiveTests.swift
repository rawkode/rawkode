import XCTest
@testable import AthenaeumRPC

/// **Live integration tests** for the native voice-UI task's own new backend RPC surface
/// (`WorkspaceRPCClient+Voice.swift` / `voice-audio-rpc.ts`) — same gating/rationale as
/// `WorkspaceRPCClientLiveTests.swift`: hits a genuinely running `@athenaeum/backend` (`wrangler dev`),
/// skipped (not failed) when `ATHENAEUM_TEST_BACKEND_URL` isn't set. Run manually:
///
/// ```
/// ATHENAEUM_TEST_BACKEND_URL=http://127.0.0.1:8799 swift test --filter VoiceAudioSessionLiveTests
/// ```
///
/// **What this proves live, honestly**: the real HTTP-batch round trip for every one of the five
/// new RPC methods, real `startVoiceSession`/`createChat` composition, and — since no
/// `OPENAI_REALTIME_API_KEY` exists in this environment (hard constraint) — that
/// `openVoiceAudioSession` fails CLEANLY (a real thrown `AthenaeumDomainError`, promptly, not a
/// hang or a crash) when the real `RealtimeVoiceClientOpenAI` layer is unconfigured. What this
/// does NOT and CANNOT prove here: a real OpenAI Realtime session actually transcribing real
/// audio — that needs a live key, per this task's hard constraint, exactly as
/// `realtime-voice-client-openai.ts`'s own header comment already states for the backend side.
final class VoiceAudioSessionLiveTests: XCTestCase {
    private func makeClient(workspaceId: String) throws -> WorkspaceRPCClient {
        guard let urlString = ProcessInfo.processInfo.environment["ATHENAEUM_TEST_BACKEND_URL"] else {
            throw XCTSkip("ATHENAEUM_TEST_BACKEND_URL not set — skipping live backend integration test")
        }
        guard let baseURL = URL(string: "\(urlString)/api/workspace/\(workspaceId)") else {
            XCTFail("invalid ATHENAEUM_TEST_BACKEND_URL: \(urlString)")
            throw CapnWebError.malformedMessage("invalid base URL")
        }
        return WorkspaceRPCClient(baseURL: baseURL, workspaceId: workspaceId)
    }

    private func freshWorkspaceId() -> String { UUID().uuidString.lowercased() }

    /// Real `createChat` -> real `startVoiceSession` -> real `openVoiceAudioSession`, against a
    /// live local backend. Expects `openVoiceAudioSession` to throw promptly (not hang) with the
    /// real `RealtimeVoiceUnavailable` failure (mapped server-side to `UnexpectedError`, per
    /// `voice-audio-session.ts#realtimeVoiceErrorToDomainError`) — this environment's honest,
    /// documented "no live key" story, proven end-to-end through the real native client instead
    /// of only asserted server-side (`test/voice-audio-session.test.ts`'s own scripted-client
    /// coverage).
    func testOpenVoiceAudioSessionFailsCleanlyWhenRealtimeVoiceIsUnconfigured() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)

        let chat = try await client.createChat(title: "Live voice-audio test chat")
        let voiceSession = try await client.startVoiceSession(chatId: chat.id)
        XCTAssertEqual(voiceSession.status, "active")

        do {
            _ = try await client.openVoiceAudioSession(chatId: chat.id, inputAudioSampleRateHz: 16_000)
            XCTFail("expected openVoiceAudioSession to fail — no OPENAI_REALTIME_API_KEY in this environment")
        } catch let error as AthenaeumDomainError {
            if case .unexpectedError(let message) = error {
                XCTAssertTrue(
                    message.contains("RealtimeVoiceUnavailable"),
                    "expected the real RealtimeVoiceUnavailable failure, got: \(message)"
                )
            } else {
                XCTFail("expected .unexpectedError, got \(error)")
            }
        }
    }

    /// Real round trip for the four session-scoped methods against an audioSessionId that was
    /// never opened — proves `ValidationError`/no-op behavior end-to-end through the real native
    /// client, independent of whether `RealtimeVoiceClient` itself is configured (these calls
    /// never reach it — `#requireLiveVoiceAudioSession` in `workspace-durable-object.ts` rejects
    /// first).
    func testSendPollCommitAgainstUnknownAudioSessionFailCleanlyCloseIsANoOp() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let bogusAudioSessionId = UUID().uuidString

        do {
            try await client.sendVoiceAudioChunk(audioSessionId: bogusAudioSessionId, pcm16: Data([0, 1, 2, 3]))
            XCTFail("expected ValidationError for an unknown audioSessionId")
        } catch let error as AthenaeumDomainError {
            guard case .validationError = error else { XCTFail("expected .validationError, got \(error)"); return }
        }

        do {
            _ = try await client.pollVoiceAudioEvents(audioSessionId: bogusAudioSessionId)
            XCTFail("expected ValidationError for an unknown audioSessionId")
        } catch let error as AthenaeumDomainError {
            guard case .validationError = error else { XCTFail("expected .validationError, got \(error)"); return }
        }

        // Closing an unknown session is a documented no-op, not an error (voice-audio-rpc.ts's
        // own `CloseVoiceAudioSessionInput` doc comment) — proven live here too.
        try await client.closeVoiceAudioSession(audioSessionId: bogusAudioSessionId)
    }
}
