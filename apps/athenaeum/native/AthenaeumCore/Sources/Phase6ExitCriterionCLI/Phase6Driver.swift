import Foundation
import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

// Phase 6 native stage exit-criterion driver ("Get the REAL say-synthesized-audio ASR test
// working end-to-end ... from synthetic audio file through your real capture-abstraction
// interface through real on-device ASR through a real RPC call landing a real TranscriptSegment
// on a live local backend").
//
// Same "small subcommand CLI an external orchestrator drives" shape as
// `phase2..5-driver` (see `Phase5Driver.swift`'s own header comment for the pattern this
// follows). Every subcommand talks to the real backend (`wrangler dev`, `packages/backend`) over
// the real `AthenaeumRPC` HTTP-batch transport — nothing here is stubbed or mocked at the RPC
// layer. `--workspace` is any fresh UUID. Ledgered `start-meeting` and transcript appends require
// `--credential <token>` (or `ATHENAEUM_CREDENTIAL`) even for an ungoverned workspace; the token
// supplies the server-derived principal recorded by the command ledger.
//
// `transcribe-say` is the load-bearing subcommand: it decodes a real audio file (in practice, a
// file `say -o file.aiff "..."` genuinely synthesized) through the real, protocol-based
// `SyntheticAudioSource` (`AudioCaptureSource` conformance — the real dependency-injection seam,
// per this task's hard constraint), chunks it via the real `AudioChunker`, transcribes each chunk,
// and appends every non-empty transcript to a real meeting via `WorkspaceRPCClient
// .appendTranscriptSegment` (`MeetingTranscriptionPipeline`, `AthenaeumCore`). `--request-id`
// identifies one meeting-start command; reuse it after an uncertain response so the ledger returns
// the original meeting rather than creating a second session. `--transcriber`
// selects which `OnDeviceTranscriber` drives that pipeline. `--capture-id` identifies one
// audio/configuration run; reuse it after an uncertain transport failure so ledger retries replay
// the same per-chunk request identities. Reusing it with changed input intentionally conflicts.
//
//   --transcriber sfspeech (default): the REAL `SFSpeechRecognizerTranscriber`, wrapping the real
//   `SFSpeechRecognizer`. Per docs/meetings-voice-decisions.md §1.2 (confirmed independently by
//   this stage too, see this stage's report), `SFSpeechRecognizer.requestAuthorization`'s callback
//   never fires without a human physically present to answer the one-time system consent dialog —
//   an environment property, not a code defect. This subcommand does not silently hang forever:
//   each chunk's transcription is raced against `--timeout-seconds` (default 20) and the whole
//   pipeline fails loudly (`ERROR: on-device transcription timed out ...`) rather than hanging, so
//   a human CAN run this exact subcommand on a real Mac, answer the one prompt when it appears,
//   and watch the rest of the pipeline (chunking -> ASR -> RPC -> persisted TranscriptSegment)
//   complete for real — the gap this leaves is named exactly, not hidden.
//
//   --transcriber echo: a NAMED, explicit test double (mirrors `phase5-driver`'s own
//   `enable-scripted-calendar` precedent for "a real fixture double, not hidden") that returns a
//   fixed transcript per chunk with no ASR engine and no TCC permission involved at all — proves
//   the REST of the pipeline (real file decode, real `AudioCaptureSource`/`AudioChunker`, real
//   `appendTranscriptSegment` RPC call, real persisted `TranscriptSegmentRecord` readable back via
//   `getMeeting`) end-to-end against the real live backend, isolating the on-device-ASR TCC gap as
//   the ONLY unverified link in the chain rather than leaving the whole chain unverified because of
//   it.

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("ERROR: \(message)\n".utf8))
    exit(1)
}

func requireArg(_ args: [String], _ index: Int, _ name: String) -> String {
    guard args.count > index else { fail("missing required argument: \(name)") }
    return args[index]
}

func optionValue(_ args: [String], _ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

/// A named, explicit test double (see this file's header comment) — never silently substituted
/// for the real `SFSpeechRecognizerTranscriber`; only used when `--transcriber echo` is passed
/// explicitly.
private final class EchoTranscriber: OnDeviceTranscriber {
    func transcribe(_ chunk: AudioChunk) async throws -> TranscriptionResult {
        TranscriptionResult(text: "[echo] \(chunk.samples.count) samples @ \(chunk.sampleRate)Hz", confidence: 1.0)
    }
}

/// Races a real `OnDeviceTranscriber.transcribe(_:)` call against a timeout so this driver fails
/// loudly instead of hanging forever when (as confirmed for THIS environment, see this file's
/// header comment) `SFSpeechRecognizer`'s authorization callback never fires.
private struct TimedOutTranscribing: Error, CustomStringConvertible {
    let seconds: Double
    var description: String { "on-device transcription timed out after \(seconds)s (no human present to answer the Speech Recognition permission prompt? see docs/meetings-voice-decisions.md §1.2)" }
}

/// Minimal `NSLock`-backed box, same pattern `SFSpeechRecognizerTranscriber.swift`'s own private
/// `Locked<T>` uses for the identical reason: guarding a flag written from a non-actor-isolated
/// callback/Task boundary.
private final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T
    init(_ value: T) { self._value = value }
    var value: T {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); defer { lock.unlock() }; _value = newValue }
    }
}

/// Races `inner.transcribe(_:)` against a timeout WITHOUT structured concurrency's implicit
/// "await every child task before returning" behavior (`withThrowingTaskGroup`'s scope-exit
/// waits for every task it spawned, even cancelled ones — the wrong shape here, since a real
/// `SFSpeechRecognizer` call whose completion callback never fires, per this file's header
/// comment, would never let that implicit wait complete, hanging this whole driver process
/// forever instead of failing loudly after `seconds`). Both the real transcription attempt and
/// the timer run as UNSTRUCTURED `Task`s launched from inside the continuation closure below, so
/// this function's `await` returns as soon as either one resumes the continuation — the loser
/// (in practice, always the real `SFSpeechRecognizer` call in this environment) is deliberately
/// abandoned to finish or never finish on its own; this process exits shortly after regardless,
/// which is the correct and sufficient cleanup for a short-lived CLI.
private struct TimeoutTranscriber: OnDeviceTranscriber {
    let inner: OnDeviceTranscriber
    let seconds: Double

    func transcribe(_ chunk: AudioChunk) async throws -> TranscriptionResult {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<TranscriptionResult, Error>) in
            let resumed = Locked(false)
            Task {
                do {
                    let result = try await inner.transcribe(chunk)
                    if resumed.value == false {
                        resumed.value = true
                        continuation.resume(returning: result)
                    }
                } catch {
                    if resumed.value == false {
                        resumed.value = true
                        continuation.resume(throwing: error)
                    }
                }
            }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                if resumed.value == false {
                    resumed.value = true
                    continuation.resume(throwing: TimedOutTranscribing(seconds: seconds))
                }
            }
        }
    }
}

@main
struct Phase6Driver {
    static func main() async {
        do {
            try await run()
        } catch {
            fail("\(error)")
        }
    }

    static func run() async throws {
        var args = Array(CommandLine.arguments.dropFirst())
        guard !args.isEmpty else {
            fail("usage: phase6-driver <subcommand> [args] --backend <url> --workspace <id>")
        }
        let subcommand = args.removeFirst()
        let allArgs = CommandLine.arguments.map { $0 }

        let backendURLString = optionValue(allArgs, "--backend") ?? ProcessInfo.processInfo.environment["ATHENAEUM_BACKEND_URL"]
        guard let backendURLString else { fail("--backend <url> (or ATHENAEUM_BACKEND_URL) is required") }

        let workspaceIdString = optionValue(allArgs, "--workspace") ?? ProcessInfo.processInfo.environment["ATHENAEUM_WORKSPACE_ID"]
        guard let workspaceIdString else { fail("--workspace <id> (or ATHENAEUM_WORKSPACE_ID) is required") }
        let workspaceId = try EntityId(validating: workspaceIdString)
        guard let apiURL = URL(string: "\(backendURLString)/api/workspace/\(workspaceId.rawValue)") else {
            fail("invalid backend URL: \(backendURLString)")
        }
        let credential = optionValue(allArgs, "--credential") ?? ProcessInfo.processInfo.environment["ATHENAEUM_CREDENTIAL"]
        let client = WorkspaceRPCClient(baseURL: apiURL, workspaceId: workspaceId.rawValue, bearerCredential: credential)

        let flagsWithValues: Set<String> = [
            "--backend", "--workspace", "--credential", "--meeting", "--request-id", "--capture-id", "--transcriber", "--timeout-seconds", "--max-chunk-seconds", "--min-chunk-seconds"
        ]
        var positional: [String] = []
        var i = 0
        while i < args.count {
            if flagsWithValues.contains(args[i]) {
                i += 2
            } else {
                positional.append(args[i])
                i += 1
            }
        }

        switch subcommand {
        case "start-meeting":
            let title = requireArg(positional, 0, "title")
            guard credential != nil else { fail("--credential <token> (or ATHENAEUM_CREDENTIAL) is required for 'start-meeting'") }
            let requestId = optionValue(allArgs, "--request-id") ?? UUID().uuidString
            guard !requestId.isEmpty, requestId.count <= 200, requestId.unicodeScalars.allSatisfy(\.isASCII) else {
                fail("--request-id must contain 1...200 ASCII characters")
            }
            print("REQUEST_ID: \(requestId)")
            let meeting = try await client.startMeeting(
                title: title,
                requestId: requestId,
                commitMessage: "Start a meeting session from the Phase 6 driver.",
                attribution: MutationAttribution(kind: "humanUi", surface: "macos")
            )
            print("MEETING_ID: \(meeting.id)")
            print("TITLE: \(meeting.title)")
            print("STARTED_AT: \(meeting.startedAt)")

        case "end-meeting":
            let meetingId = requireArg(positional, 0, "meetingId")
            let endedAt = ISO8601DateFormatter().string(from: Date())
            let meeting = try await client.endMeeting(meetingId: meetingId, endedAt: endedAt)
            print("MEETING_ID: \(meeting.id)")
            print("ENDED_AT: \(meeting.endedAt ?? "<none>")")

        case "get-meeting":
            let meetingId = requireArg(positional, 0, "meetingId")
            let (meeting, segments, speakers) = try await client.getMeeting(meetingId: meetingId)
            print("MEETING_ID: \(meeting.id)")
            print("TITLE: \(meeting.title)")
            print("SEGMENT_COUNT: \(segments.count)")
            for segment in segments.sorted(by: { $0.startOffsetMs < $1.startOffsetMs }) {
                print("SEGMENT: [\(segment.startOffsetMs)-\(segment.endOffsetMs)ms] source=\(segment.source) text=\"\(segment.text)\"")
            }
            print("SPEAKER_COUNT: \(speakers.count)")

        case "list-meetings":
            let meetings = try await client.listMeetings()
            print("MEETING_COUNT: \(meetings.count)")
            for meeting in meetings {
                print("MEETING: \(meeting.id) title=\"\(meeting.title)\" startedAt=\(meeting.startedAt) endedAt=\(meeting.endedAt ?? "<in progress>")")
            }

        case "transcribe-say":
            let audioPath = requireArg(positional, 0, "audioFilePath")
            guard let meetingId = optionValue(allArgs, "--meeting") else { fail("--meeting <id> is required") }
            guard credential != nil else { fail("--credential <token> (or ATHENAEUM_CREDENTIAL) is required for 'transcribe-say'") }
            let transcriberName = optionValue(allArgs, "--transcriber") ?? "sfspeech"
            let captureId = optionValue(allArgs, "--capture-id") ?? UUID().uuidString
            let timeoutSeconds = Double(optionValue(allArgs, "--timeout-seconds") ?? "20") ?? 20
            let minChunk = Double(optionValue(allArgs, "--min-chunk-seconds") ?? "1.5") ?? 1.5
            let maxChunk = Double(optionValue(allArgs, "--max-chunk-seconds") ?? "5") ?? 5

            let fileURL = URL(fileURLWithPath: audioPath)
            let source = try SyntheticAudioSource(fileURL: fileURL, origin: .microphone)
            print("DECODED_BLOCKS: \(source.allBlocks.count) from \(fileURL.lastPathComponent)")
            print("CAPTURE_ID: \(captureId)")

            let baseTranscriber: OnDeviceTranscriber
            switch transcriberName {
            case "sfspeech":
                if #available(macOS 13.0, *) {
                    baseTranscriber = SFSpeechRecognizerTranscriber()
                } else {
                    fail("SFSpeechRecognizerTranscriber requires macOS 13+")
                }
            case "echo":
                baseTranscriber = EchoTranscriber()
            default:
                fail("unknown --transcriber '\(transcriberName)' (expected sfspeech or echo)")
            }
            let transcriber = TimeoutTranscriber(inner: baseTranscriber, seconds: timeoutSeconds)

            let pipeline = MeetingTranscriptionPipeline(transcriber: transcriber)
            do {
                let appended = try await pipeline.transcribeAndAppend(
                    blocks: source.allBlocks,
                    chunkerConfig: AudioChunkerConfig(minChunkDurationSeconds: minChunk, maxChunkDurationSeconds: maxChunk),
                    sink: client,
                    meetingId: meetingId,
                    skipSilentChunks: true,
                    captureId: captureId,
                    commitMessage: "Capture transcript segment from the Phase 6 meeting transcription pipeline.",
                    attribution: MutationAttribution(kind: "humanUi", surface: "macos")
                )
                print("APPENDED_SEGMENT_COUNT: \(appended.count)")
                for (segment, result) in appended {
                    print("APPENDED: id=\(segment.id) [\(segment.startOffsetMs)-\(segment.endOffsetMs)ms] confidence=\(result.confidence) text=\"\(result.text)\"")
                }
                if appended.isEmpty {
                    print("NOTE: zero segments appended (empty/silent-only transcript, or every chunk was skipped) — this is a real, not a failed, outcome.")
                }
            } catch {
                fail("transcribe-say pipeline failed: \(error)")
            }

        default:
            fail("unknown subcommand: \(subcommand)")
        }
    }
}
