# Meetings & voice — architecture decisions

Status: Phase 6 pre-work spike, complete. Resolves the plan's "Phase 6 — Meetings & voice"
phasing bullet ("Transcription and realtime voice, both as agent-tool-calling surfaces reusing
Phase 3's `AgentEditService` unchanged"), scoped per this stage's task: transcription (on-device +
cloud fallback) and realtime voice-to-agent, with speaker clustering as a real spike. On-device
FoundationModels/on-device-LLM assistant mode is explicitly OUT of scope here, per the plan.

This document is organized as the task's two numbered sections, plus a third for the
voice→`AgentEditService` reuse decision, then a summary of what was and wasn't verified live and
exactly what David would need to supply to close each remaining gap.

## 1. Audio capture + on-device ASR + speaker clustering architecture

### 1.1 Capture: ScreenCaptureKit for system audio, AVAudioEngine for microphone — not a Core Audio aggregate-device tap

**Decision: `SCStreamConfiguration.capturesAudio` (ScreenCaptureKit, macOS 13+) for system audio,
`AVAudioEngine`'s input-node tap for the local microphone — two independent capture sources, not
one.**

Investigated this stage (WebSearch/WebFetch against Apple's current ScreenCaptureKit
documentation and WWDC22 "Meet ScreenCaptureKit," cross-checked against a real third-party
open-source implementation found in the same search): `SCStreamConfiguration.capturesAudio` has
captured the OS's mixed system-audio output since macOS 13, under the **same Screen Recording TCC
grant** screen-sharing itself already uses — no separate audio permission, no kernel
extension/driver, no BlackHole-style virtual-device install. This is exactly the audio a meeting's
*remote participants* produce (played out of the Mac's speakers/audio output), which no
microphone tap can ever see.

A Core Audio aggregate-device tap (the pre-macOS-13 way to get system audio, mixing a virtual
loopback device into an aggregate) is real and was considered, but is strictly worse for a 2026
app: it needs either a bundled/installed audio driver (kernel-extension-adjacent complexity,
notarization burden) or CoreAudio's newer per-process taps
(`AudioHardwareCreateProcessTap`, macOS 14.2+), which are lower-level and capture only what
ScreenCaptureKit already gets for free at a higher level, under a permission grant users already
understand ("this app can record my screen").

**The local microphone is a *separate* capture** (`AVAudioEngine`'s input-node tap), not
ScreenCaptureKit's newer combined `captureMicrophone`/`microphoneCaptureDeviceID`
(confirmed via WebSearch: macOS 15+, added WWDC24, with a new `SCStreamOutputType.microphone`
case to distinguish mic frames from system-audio frames in the same stream). Deliberate: using
AVAudioEngine for the mic keeps this package's `Package.swift` minimum at macOS 13 (its existing
floor) rather than forcing macOS 15 just for combined capture, and keeps the two sources'
failure modes independent — system-audio capture failing (e.g. Screen Recording revoked) should
not also take down microphone capture, or vice versa. If a later stage wants to raise the floor to
macOS 15 for lower overhead (one stream instead of two), swapping `AVAudioEngineMicrophoneSource`
for ScreenCaptureKit's combined mode is an isolated change behind the `AudioCaptureSource`
protocol — it does not touch any downstream consumer.

**The real, dependency-injectable interface** (hard constraint: "behind a real Swift
protocol/interface so it CAN be dependency-injected with a test audio source"):

```swift
public protocol AudioCaptureSource: Sendable {
    func start(onBlock: @escaping @Sendable (AudioSampleBlock) -> Void) async throws
    func stop() async
}
```

Three real implementations, all in `native/AthenaeumCore/Sources/AthenaeumCore/Meetings/`:
- `ScreenCaptureKitAudioSource` — real `SCShareableContent`/`SCContentFilter`/
  `SCStreamConfiguration`/`SCStream` usage, type-checks against the real SDK (`swift build`
  succeeds — see §"What was and wasn't verified live" below for what this means and doesn't mean).
- `AVAudioEngineMicrophoneSource` — real `AVAudioEngine` input-node tap.
- `SyntheticAudioSource` — the test double. Decodes an ACTUAL audio file via `AVAudioFile` (in
  practice, a file `say -o file.aiff "..."` genuinely synthesized) and replays it as
  `AudioSampleBlock`s through the identical protocol — this is what makes every downstream test
  in this stage genuine rather than mocked-to-agree-with-itself.

### 1.2 On-device ASR: `SFSpeechRecognizer` — real code, and a real, empirically-confirmed permission finding

**Decision: `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`**, via
`SFSpeechAudioBufferRecognitionRequest` (buffer-append — the correct real API for this pipeline's
actual shape: in-memory `AudioChunk` sample arrays from `AudioChunker`, not files on disk).
`SFSpeechRecognizer` remains the current, correct on-device ASR API on macOS/iOS as of this stage
— no newer replacement API was found.

**The single most important empirical result this stage produced**, per the hard constraint's own
instruction to try this for real and report honestly either way:

**Command sequence, run for real on this machine:**

```
say -v Samantha -o quick_fox.aiff "the quick brown fox jumps over the lazy dog"
afinfo quick_fox.aiff   # confirmed: real AIFF-C, 22050Hz, 16-bit PCM, ~2.7s
```

A standalone Swift SPM executable (`SpeechProbe`) was built and packaged as a real, ad-hoc-signed
`.app` bundle (`codesign --force --sign - --identifier academy.rawkode.athenaeum.speechprobe`,
with a real `NSSpeechRecognitionUsageDescription` in its `Info.plist`), then launched via
`open -a SpeechProbe.app --args <path-to-quick_fox.aiff>` — a proper LaunchServices-registered
app, not a bare command-line binary, specifically to rule out "no bundle identity" as the reason
for a failed prompt. This ran inside a confirmed real, active, logged-in macOS GUI session:

```
$ launchctl print gui/501 | head -5
gui/501 = {
        type = login
        handle = 100015
        active count = 480
        ...
```
(`WindowServer` process confirmed running via `ps aux | grep WindowServer`.)

The probe called `SFSpeechRecognizer.requestAuthorization` for real. The macOS unified log
(`log show --predicate '(process == "SpeechProbe") or (subsystem == "com.apple.TCC")'`) confirms
`tccd` genuinely processed the request:

```
AUTHREQ_ATTRIBUTION: ... requesting={TCCDProcess: identifier=academy.rawkode.athenaeum.speechprobe, ...}
AUTHREQ_SUBJECT: msgID=48612.2, subject=academy.rawkode.athenaeum.speechprobe,
AUTHREQ_PROMPTING: msgID=48612.2, service=kTCCServiceSpeechRecognition, subject=Sub:{academy.rawkode.athenaeum.speechprobe}...
```

`AUTHREQ_PROMPTING` is the load-bearing line: macOS genuinely attempted to show the interactive
consent dialog. But the authorization callback never fired within a 60-second wait, and
`SFSpeechRecognizer.authorizationStatus()` remained `notDetermined` (raw value `0`) throughout —
**because no human was physically present in this automated environment to see and click the
dialog.** (A direct attempt to grant the permission non-interactively by writing to the user's
TCC database was correctly blocked by this environment's own permission system before it could
run — the right outcome; this finding was left as a genuine, unworked-around result rather than
bypassed.)

**Conclusion, stated exactly as the hard constraint asked: yes, `SFSpeechRecognizer` requires an
interactive permission prompt in this environment, even for file-based (non-live-mic)
recognition, and this sandboxed environment cannot satisfy it non-interactively.** This is a
property of *this automated environment* (no human present to click "Allow"), not evidence that
the real app will have this problem — on a real user's Mac, a human sees and answers that same
one-time system dialog normally, exactly like every other TCC-gated Mac app. `say`-synthesized
audio remains the right zero-permission tool for generating REAL speech test fixtures (used
extensively below, for speaker clustering) — the blocker is specifically `SFSpeechRecognizer`'s
own consent flow, not audio synthesis.

**What this means for the pipeline design**: `SFSpeechRecognizerTranscriber`
(`native/AthenaeumCore/Sources/AthenaeumCore/Meetings/SFSpeechRecognizerTranscriber.swift`) is
real, correctly-structured code against the real Speech framework — it type-checks and links
against the real SDK on this machine (`swift build` succeeds, confirmed this stage) — but is
genuinely UNTESTED end-to-end here, for the same reason `ScreenCaptureKitAudioSource` is: no TCC
grant is obtainable non-interactively. Both classes sit behind real protocols
(`AudioCaptureSource`, `OnDeviceTranscriber`) precisely so the rest of the pipeline does not share
this limitation — see §1.4.

**Command reference for David**, to close this gap on a real Mac: run the app once, approve the
one macOS Speech Recognition permission prompt when it appears (Settings → Privacy & Security →
Speech Recognition, or the inline system dialog), same as every other TCC-gated capability.

### 1.3 Chunking, buffering, silence detection: real and fully tested

`AudioChunker` (`Sources/AthenaeumCore/Meetings/AudioChunker.swift`) ingests
`AudioSampleBlock`s and cuts `AudioChunk`s either (a) at a natural silence boundary once a
minimum duration has elapsed (RMS-energy-based, configurable threshold/hold-duration), or (b)
unconditionally at a maximum duration, so one long unbroken speaker still gets transcribed
incrementally. One instance handles one `AudioSampleOrigin` (mixing system-audio and microphone
RMS in one silence detector would corrupt it).

Fully tested (`AudioChunkerTests.swift`, 6 tests, all passing) against both synthetic tone/silence
arrays (deterministic boundary control) and a real `say`-generated speech fixture end-to-end.

### 1.4 Speaker clustering: real pitch-based feature extraction + k-means, proven against real distinct voices

**Decision: time-domain autocorrelation F0 (pitch) estimation per analysis frame, voiced/unvoiced-gated
by normalized correlation strength and an RMS amplitude floor, then k-means (k =
`expectedSpeakerCount`) over each segment's median voiced-frame F0** — a real, minimal spike
per the hard constraint ("you don't need production-grade diarization... but it must be a real,
testable algorithm, not a stub returning a fixed answer"). Pitch is the cheapest, strongest
acoustic cue that two different people's voices differ — the classic first feature real
diarization systems use, without this spike's neural speaker embeddings.

Implementation: `Sources/AthenaeumCore/Meetings/SpeakerClusterer.swift`.
`SpeakerClusterer.extractFeature(_:)` exposes the real intermediate F0 estimate per segment (not
just a final label), and `SpeakerClusterer.cluster(_:expectedSpeakerCount:)` returns one cluster
label per input chunk, `-1` for a chunk with no voiced frames at all (never a fabricated guess).

**Tested against REAL synthesized speech, not synthetic tones** (hard constraint: "test it
against a synthetic multi-segment input, e.g. two different `say` voices, and confirm it actually
distinguishes them"). Five fixtures, genuinely produced this stage and committed as binary test
resources (`native/AthenaeumCore/Tests/AthenaeumCoreTests/Fixtures/`, ~550 KiB total, bundled via
SwiftPM `resources: [.copy("Fixtures")]`):

```
say -v Samantha -o samantha_1.aiff "the quick brown fox jumps over the lazy dog"
say -v Samantha -o samantha_2.aiff "please schedule the follow up for next tuesday afternoon"
say -v Alex     -o alex_1.aiff     "hello world, this is a test of speaker clustering"
say -v Alex     -o alex_2.aiff     "let's push the deadline back by one full week"
say -v Samantha -o silence.aiff    "[[slnc 1000]]"   # 1.1s of genuine silent PCM (control fixture)
```

`Samantha` (US English female) and `Alex` (US English male) are macOS's two most acoustically
distinct built-in voices — not hand-picked beyond "two voices that actually sound like different
people," the real-world case this algorithm needs to handle.

**Measured results from this stage's actual test run** (`SpeakerClustererTests.swift`, run via
`swift test --filter SpeakerClustererTests`):

| fixture | measured median voiced F0 | assigned cluster |
|---|---|---|
| samantha_1 | 177.8 Hz | 1 |
| samantha_2 | 175.0 Hz | 1 |
| alex_1 | 125.3 Hz | 0 |
| alex_2 | 107.6 Hz | 0 |

Both F0 values are well inside the plausible adult-speech range (75–400Hz), the two voices'
ranges are cleanly separated (~50Hz gap, no overlap), and clustering assigned **both Samantha
clips to the same cluster, both Alex clips to the same (different) cluster** — the actual claim
the hard constraint asked to confirm. The silence fixture correctly receives label `-1` (no
voiced frames found), and requesting 2 clusters from only 1 real voiced segment correctly falls
back to a single cluster rather than fabricating a second one from nothing.

**One real bug found and fixed during this verification** (worth recording — this is exactly the
kind of thing "run it for real" catches that reasoning about the algorithm alone would not): the
first implementation gated voiced-frame detection on raw autocorrelation energy (`energy > 1e-6`)
alone. The `[[slnc 1000]]`-generated silence fixture still has nonzero 16-bit-PCM
quantization/dither noise (RMS on the order of 1e-5–1e-6), and normalized autocorrelation on
near-zero-energy noise is numerically unstable — it spuriously exceeded the voiced-correlation
threshold, misclassifying the silent fixture as "voiced" with a fabricated pitch. Fixed by adding
an explicit RMS amplitude gate (`> 0.01`, the same threshold `AudioChunkerConfig`'s own silence
detection already uses) before attempting pitch estimation at all — real dither noise is ~300×
below this floor, real speech in these fixtures is comfortably above it. All 5
`SpeakerClustererTests` pass after the fix.

**Test run summary (this stage, `native/AthenaeumCore`):**

```
$ swift build                                                    # Build complete!
$ swift test --filter "SpeakerClustererTests|AudioChunkerTests|SyntheticAudioSourceTests|CloudFallbackPolicyTests"
Executed 19 tests, with 0 failures (0 unexpected) in 12.8s
```

Pre-existing non-network AthenaeumCore tests (`LocalWorkspaceStoreTests`, `PageDocumentStoreTests`)
re-run and still pass — no regression from adding the Meetings module.

## 2. Cloud transcription fallback + realtime voice architecture

Both designed as backend-side Effect `Context.Tag` services mirroring `ModelClient`
(`packages/domain/src/model-client.ts`) / `GoogleCalendarClient`
(`packages/gatekeeper-google-calendar/src/google-calendar-client.ts`) **exactly**: interface in
`packages/domain`, two real `Layer` implementations in `packages/backend` (a `*Scripted`
deterministic test double, and a real HTTP/WebSocket client that fails cleanly with an
"unavailable" error when unconfigured rather than attempting network I/O), proven via
transport-mocked tests — never a live network call in this environment.

### 2.1 `CloudTranscriptionClient`

Interface: `packages/domain/src/cloud-transcription.ts`. One method:
`transcribe(input: TranscribeAudioInput): Effect<TranscribeAudioOutput, TranscriptionError>`.
`TranscriptionError` is the same 3-variant closed shape as `ModelError`
(`TranscriptionUnavailable` / `TranscriptionRequestFailed` / `TranscriptionResponseInvalid`).

**Real provider: OpenAI's `POST /v1/audio/transcriptions`**, verified this stage via WebFetch
against OpenAI's own current API reference. Real endpoint, real multipart request shape
(`file`/`model`/`response_format`/`language` fields), real response shape.
**Model choice: `whisper-1`, not `gpt-4o-transcribe`** — both are valid current models, but only
`whisper-1`'s `response_format: "verbose_json"` has a long-stable, fully field-verified
`segments[]` shape (`{text, start, end, ...}`), exactly what `TranscriptSegment`'s
`startSeconds`/`endSeconds` needs for meeting timestamps. `gpt-4o-transcribe`'s newer
`diarized_json` format was confirmed to exist but its exact segment shape was not independently
verified field-by-field this stage — `model` is a config override, so switching later is a
one-line change once that shape is confirmed against a live key.

Implementation: `packages/backend/src/cloud-transcription-client-openai.ts` (real client, reuses
the SAME `HttpFetch` `Context.Tag` `model-client-anthropic.ts` already established — one
fetch-shaped seam for this package, not a duplicate per client) and
`cloud-transcription-client-scripted.ts` (test double, identical FIFO-queue-per-call-log shape as
`model-client-scripted.ts`). **No real OpenAI API key exists in this environment** —
`makeCloudTranscriptionClientOpenAILive({apiKey: undefined})` fails every call with
`TranscriptionUnavailable` before any network I/O, exactly like `ModelClientAnthropic`'s own
unconfigured-key path.

Tested (`test/cloud-transcription-client-openai.test.ts`, 10 tests, all passing) by mocking only
`HttpFetch` — asserting the real multipart body (file bytes, filename, mimeType, model,
response_format, language), the Authorization header, and real response parsing (segments,
languageDetected, error mapping for non-2xx/malformed-JSON/wrong-shape responses) — same
"mock only the HTTP layer" discipline as `model-client-anthropic.test.ts`.

**What David would need to make this real**: an OpenAI API key with Audio API access, set as
`OPENAI_TRANSCRIPTION_API_KEY` (deliberately separate from any other provider secret, for
independent rotation/scope) via `wrangler secret put OPENAI_TRANSCRIPTION_API_KEY`.

### 2.2 `RealtimeVoiceClient`

Interface: `packages/domain/src/realtime-voice.ts`. `openSession(config)` returns a scoped
`RealtimeVoiceSession` handle (`Effect<RealtimeVoiceSession, RealtimeVoiceError, Scope.Scope>` —
the underlying connection is released automatically when the scope closes, mirroring this
project's own stated resource-lifecycle discipline for live subscriptions) with:
- `sendAudioChunk(pcm16)` / `commitAudioAndRespond()` / `submitToolResult(callId, output)` —
  imperative, request/response-shaped actions.
- `events: Stream<RealtimeVoiceEvent, RealtimeVoiceError>` — the duplex protocol's server→client
  half, a real `effect/Stream` (not a single `Effect`) because "streaming audio in,
  transcription+tool-calling events out" is structurally a stream.

`RealtimeVoiceEvent` is a 6-variant discriminated union: user-transcript delta/completed,
assistant text delta, assistant audio delta, a tool-call request, and turn-completed.
`RealtimeVoiceError` is the same 3-variant closed shape as `ModelError`/`TranscriptionError`.

**Real provider: OpenAI's Realtime API**, verified this stage via WebFetch against OpenAI's own
current documentation (`developers.openai.com/api/docs/guides/realtime{,-websocket,-conversations}`
— the GA `gpt-realtime` naming, confirmed distinct from the older 2024 beta event names):
- Endpoint: `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1`, `Authorization: Bearer`.
- Client events confirmed: `session.update` (`session.type: "realtime"`, `instructions`, `tools`),
  `input_audio_buffer.append`/`.commit`, `response.create`,
  `conversation.item.create` (for `function_call_output`).
- Server events confirmed: `conversation.item.input_audio_transcription.{delta,completed}`,
  `response.output_audio.delta`, `response.output_audio_transcript.delta`,
  `response.output_text.delta`, `response.function_call_arguments.{delta,done}`,
  `response.output_item.added` (carries a function call's `name`+`call_id` together — the ONLY
  event that does; `.done` carries `call_id`+`arguments` but not `name`), `response.done`.

**Transport, verified this stage: `workerd`'s real outbound-WebSocket mechanism is
`fetch()`-with-`Upgrade`-header, then `response.webSocket.accept()`** (WebFetch against
Cloudflare's own current Workers docs) — NOT a browser-style `new WebSocket(url)` constructor,
which `workerd` does not support for outbound connections. `websocket-transport.ts`'s
`WebSocketTransportLive` implements exactly this real mechanism; the client's own connect URL
uses `https://` (not `wss://`) for the `fetch()` call itself, for this reason — documented
explicitly in the implementation so a future reader doesn't "fix" it back to `wss://` and break
it.

**Real client**: `packages/backend/src/realtime-voice-client-openai.ts`. Implements the full
client-event construction and, notably, the **stateful two-event join** needed to assemble one
complete tool call: `response.output_item.added` (captures `name`+`call_id`) is buffered in a
per-session `Map`, consumed by the later `response.function_call_arguments.done` (which carries
`call_id`+finished `arguments` but not `name`) to emit one `VoiceToolCallRequested`. This is real,
load-bearing logic, not a simplification — a tool call cannot be represented as a single domain
event without it, because the two pieces of information genuinely arrive on two different wire
events per OpenAI's real protocol.

**Known, documented simplification**: `session.update`'s body sends only `type`/`instructions`/
`tools`. The GA docs confirmed a restructuring of audio-format configuration under a new
`session.audio.{input,output}` namespace, but this stage did not independently verify that
sub-shape field-by-field — sending no explicit `session.audio` block relies on the provider's
documented defaults rather than asserting a possibly-wrong shape. Flagged as exactly the kind of
gap that needs a live key to close, same spirit as `model-client-anthropic.ts`'s own
"untestable without a live key" callouts.

**No real realtime-voice API key exists in this environment** —
`makeRealtimeVoiceClientOpenAILive({apiKey: undefined})` fails `openSession` with
`RealtimeVoiceUnavailable` before attempting any connection.

Tested (`test/realtime-voice-client-openai.test.ts`, 14 tests, all passing) by mocking only
`WebSocketTransport` with a fully test-controlled `FakeSocket` (records every client frame sent;
the test drives `emitMessage`/`emitRawMessage` to simulate server frames) — proving: connect
URL/headers, the `session.update` body, `sendAudioChunk`'s base64 encoding, `commitAudioAndRespond`
and `submitToolResult`'s exact frame sequences, resource cleanup (socket closes when the scope
closes), every server-event-type decode including the two-event tool-call join, tolerance of
unrecognized event types, and stream failure on a malformed frame or an
`function_call_arguments.done` referencing an unknown `call_id`.

**What David would need to make this real**: an OpenAI API key with Realtime API access, set as
`OPENAI_REALTIME_API_KEY` (separate secret from `OPENAI_TRANSCRIPTION_API_KEY`), via
`wrangler secret put OPENAI_REALTIME_API_KEY`.

## 3. Voice-driven agent turns reuse `AgentEditService`/`ModelClient` — unchanged, no parallel mechanism

**Decision: a realtime-voice session's completed user-transcript text becomes
`AgentEditService.sendChatMessage(chatId, text)`'s `text` argument, byte-for-byte.** No new
`ChatMessage` variant, no new `AgentEditService` method, no parallel tool-calling loop.
`sendChatMessage` itself (Phase 3, unchanged by this stage) turns that text into a `ChatMessage`,
calls the real `ModelClient` (Anthropic), and runs its existing tool-calling loop against
`createNodeTool`/`addFactTool`/etc. — exactly as it already does for a typed chat message.

Implementation: `packages/backend/src/voice-chat-bridge.ts`'s `runVoiceChatTurns(chatId,
sessionConfig)` — opens one realtime-voice session scoped to the caller's lifetime, and for every
`VoiceUserTranscriptCompleted` event the session's `events` stream produces, calls
`AgentEditService.sendChatMessage` and collects the `AgentTurnResult`s. Every other event kind
(deltas, audio, the realtime protocol's own native tool-calling) is ignored by this bridge.

**Deliberately does NOT use `RealtimeVoiceSession`'s own `VoiceToolCallRequested`/
`submitToolResult` protocol for tool execution**, even though `realtime-voice-client-openai.ts`
implements that protocol faithfully (proven correct by its own two-event-join test). Routing tool
execution through OpenAI's realtime model instead of the existing Anthropic-backed
`AgentEditService`/`ModelClient` loop would be exactly the "parallel agent mechanism" this task's
hard constraint forbids. `VoiceToolCallRequested`/`submitToolResult` stay in the domain interface
anyway because they are real, verified parts of OpenAI's actual wire protocol — a future stage MAY
have a real reason to use them (e.g. a low-latency in-band acknowledgment while the real Anthropic
turn is still running) — this bridge simply never calls them.

**What this decision does NOT cover (deliberately out of scope this stage)**: speaking the
resulting `AgentTurnResult` back out loud. OpenAI's Realtime conversation graph is not a verified
fit for "speak this exact string verbatim" (injecting a message and calling `response.create`
would let the model rephrase, not read a script) — a separate TTS endpoint
(`/v1/audio/speech`) is the more likely real answer, and closing that loop needs its own
live-key-verified spike. The task's own wording ("voice transcription becomes a ChatMessage's
content, tool-calling proceeds identically") only asked for the input-side/tool-calling-reuse
claim, which is what's proven here.

Tested (`test/voice-chat-bridge.test.ts`, 4 tests, all passing): a scripted `RealtimeVoiceClient`
plus a minimal hand-built `AgentEditService` double (implementing only `sendChatMessage` — the
real interface is large and internal to the workspace DO, not designed for partial substitution the
way `ModelClient`'s single-method interface is) proves transcript text reaches `sendChatMessage`
unchanged, non-transcript events are ignored, multiple utterances produce results in arrival
order, and the session opens with the exact config passed in.

## 4. Native voice-assistant UI — the live-audio-session RPC surface + verification

Everything in §§1-3 above stopped at the backend boundary: `startVoiceSession`/`endVoiceSession`
only bracket a `VoiceSession`'s persisted lifecycle row, and `debugRunVoiceChatTurns` proves the
voice→agent wiring only via a `ctx.exports`-only debug hook fed a pre-scripted transcript — no
public RPC method existed yet for a real client to actually stream live microphone audio in and
receive transcription/tool-call events back. This stage (the native-voice-UI task) built that
missing surface and the SwiftUI app around it.

### 4.1 Transport: polling, not a `subscribeToNodes`-style push `RpcTarget`

`RealtimeVoiceSession` (realtime-voice.ts) is a live duplex handle — structurally the same kind of
thing `nodes-subscription.ts` already solved once via `subscribeToNodes`, which returns a Cap'n Web
`RpcTarget` the client holds across further calls. That shape needs a persistent Cap'n Web session
(WebSocket) — and `native/docs/decisions.md` (Phase 2) explicitly named that as future work:
"If a later phase (e.g. native voice, Phase 6) needs native push, extend this client with
`newWebSocketRpcSession`'s wire shape... don't re-derive the protocol from scratch." Building a
full WebSocket-mode Cap'n Web client in Swift from scratch was judged out of proportion to this
task's own scope (a minimal voice UI, not a native transport rewrite), so `voice-audio-rpc.ts`
instead threads the same live session through five plain HTTP-batch-compatible request/response
methods (`openVoiceAudioSession`/`sendVoiceAudioChunk`/`commitVoiceAudioAndRespond`/
`pollVoiceAudioEvents`/`closeVoiceAudioSession`), keyed by a server-issued `audioSessionId`, with
`pollVoiceAudioEvents` as an explicit non-blocking drain-and-return-buffered call
(`Queue.takeAll`) the native client repeats on a 200ms interval. This is a deliberate, documented
simplification versus true server push — a real production build would likely want the WebSocket
path for lower latency, exactly as `native/docs/decisions.md` anticipated.

The live session's own state (`RealtimeVoiceSession` handle, its poll queue, and the background
dispatch fiber that both buffers events and feeds completed transcripts into the REAL
`AgentEditService.sendChatMessage`, reusing §3's wiring unchanged) lives in a `Map` on the
`WorkspaceDurableObject` INSTANCE, not on `WorkspaceRpcApi` — `WorkspaceRpcApi` is reconstructed fresh on every
single HTTP-batch request (`fetch()`'s `new WorkspaceRpcApi(...)` call sites), so a live session held
there would be lost between the "open" call and the next "send"/"poll" call. The DO instance itself
persists across separate requests for as long as it isn't evicted, the same lifetime
`#collections`/`#runtime` already rely on. **Accepted limitation, not silently glossed over**: a DO
eviction mid-session loses that in-memory state — same accepted tradeoff an in-progress Automerge
sync session's own in-memory state already carries.

### 4.2 Native mic capture → PCM16 → RPC pipeline

`native/AthenaeumCore/Sources/AthenaeumCore/Voice/` — `pcm16Data(from:)` (Float→Int16 LE encode,
no resampling: encodes at whatever rate the capture source actually reports, a documented
simplification mirroring `realtime-voice-client-openai.ts`'s own "session.audio sub-shape not
independently verified" flag), `VoiceAudioBatcher` (re-batches irregular capture-source blocks into
fixed ~200ms PCM16 chunks — deliberately not `AudioChunker`, whose 5-30s silence-cut chunks are
tuned for ASR, not low-latency realtime streaming), `VoiceAudioStreamer` (batch-oriented, testable,
mirrors `MeetingTranscriptionPipeline`'s exact `streamAndSend(blocks:...)` shape), and
`LiveVoiceAudioCapture` (the live glue — wires a real `AudioCaptureSource.start(onBlock:)` callback
into an actor-isolated buffer a caller drains on a timer). `WorkspaceRPCClient` conforms to
`VoiceAudioSink` for free, same "protocol for testability, real client for production" split as
`TranscriptSegmentSink`.

**A real concurrency bug was found and fixed while building `LiveVoiceAudioCapture`**: an initial
version hopped onto its actor via one unstructured `Task` per captured block, which
`LiveVoiceAudioCaptureTests` caught reordering blocks under concurrent scheduling (two `Task`s
created in quick succession are not guaranteed to reach the actor in creation order). Fixed by
routing blocks through a single-consumer `AsyncStream` instead — ordering is then guaranteed by
construction, not by scheduling luck. A second bug (`enqueue`'s `isRunning` guard silently dropping
every block still in-flight through the stream at the moment `stop()` began, losing 8 of 15 real
blocks in one reproduction) was found the same way and fixed by having `stop()` finish the stream
and await the consumer's completion before returning, rather than gating `enqueue` on a flag that
can flip mid-flight.

### 4.3 The SwiftUI surface

`VoiceAssistantViewModel`/`VoiceAssistantView` (`native/AthenaeumApp`) — start/stop controls, a
live transcript view folding `RPCVoiceEvent`s (`WorkspaceRPCClient+Voice.swift`) into speaker-labeled
lines, and — reusing Phase 3's `PendingChangesView`/`AgentEditViewModel` directly, per this
stage's own instruction, rather than rebuilding a parallel pending-changes surface — the session's
own real `Chat`, refreshed on a 1s timer so pending changes/messages a voice turn produces (via
§4.1's background dispatch loop feeding `AgentEditService.sendChatMessage`) show up in the same
accept/revert UI a text chat already uses. Wired into `AthenaeumRootView`'s workspace view,
alongside Calendar/Bookmarks/Share.

### 4.4 What was and wasn't verified live, for this stage specifically

**Genuinely verified live**, against a real local `wrangler dev` backend, via
`VoiceAudioSessionLiveTests.swift` (real HTTP-batch round trips, no mocked transport):
`createChat` → `startVoiceSession` → `openVoiceAudioSession` fails CLEANLY (a real thrown
`AthenaeumDomainError`, promptly, not a hang) with the real `RealtimeVoiceUnavailable` failure —
this environment's honest "no `OPENAI_REALTIME_API_KEY`" story, now proven end-to-end through the
real native client, not only asserted server-side; and `sendVoiceAudioChunk`/
`pollVoiceAudioEvents`/`closeVoiceAudioSession` against an unknown `audioSessionId` fail/no-op
exactly as documented. Separately, `VoiceAudioStreamerTests`/`LiveVoiceAudioCaptureTests` prove the
entire mic-capture-to-PCM16-chunk pipeline against REAL `say`-synthesized speech (the same
fixtures §1.4 uses), with no live backend and no TCC involved.

**What remains genuinely untestable here, unchanged from §1's own finding**: `AVAudioEngineMicrophoneSource` actually receiving live hardware audio needs a human present for the
one-time Microphone TCC prompt, and a real OpenAI Realtime session actually transcribing real
speech needs a live `OPENAI_REALTIME_API_KEY`. On a real Mac with both, the identical code path
already proven for everything else in this pipeline completes instead of failing at
`openVoiceAudioSession`.

## Concrete interfaces the next stage builds against

- `packages/domain/src/cloud-transcription.ts` — `CloudTranscriptionClient`,
  `TranscribeAudioInput`/`Output`, `TranscriptSegment`, `TranscriptionError` union.
- `packages/domain/src/realtime-voice.ts` — `RealtimeVoiceClient`, `RealtimeVoiceSessionConfig`,
  `RealtimeVoiceSession`, `RealtimeVoiceEvent` union, `RealtimeVoiceError` union.
- `packages/backend/src/cloud-transcription-client-{scripted,openai}.ts`,
  `realtime-voice-client-{scripted,openai}.ts`, `websocket-transport.ts`, `voice-chat-bridge.ts`.
- `native/AthenaeumCore/Sources/AthenaeumCore/Meetings/` — `AudioCaptureSource` protocol +
  `ScreenCaptureKitAudioSource`/`AVAudioEngineMicrophoneSource`/`SyntheticAudioSource`;
  `AudioChunker`; `SpeakerClusterer`; `OnDeviceTranscriber` protocol +
  `SFSpeechRecognizerTranscriber`; `CloudFallbackPolicy`.
- `native/AthenaeumCore/Tests/AthenaeumCoreTests/Fixtures/` — five real `say`-generated `.aiff`
  fixtures, committed for reproducible speaker-clustering/chunking tests.
- `packages/domain/src/voice-audio-rpc.ts` — the five live-audio-session RPC schemas (§4.1).
- `packages/backend/src/voice-audio-session.ts` — the live-session handle + dispatch loop (§4.1).
- `native/AthenaeumRPC/Sources/AthenaeumRPC/WorkspaceRPCClient+Voice.swift` — the native client for
  both `voice-session-rpc.ts` and `voice-audio-rpc.ts`.
- `native/AthenaeumCore/Sources/AthenaeumCore/Voice/` — `pcm16Data`, `VoiceAudioBatcher`,
  `VoiceAudioStreamer`, `VoiceAudioSink` protocol, `LiveVoiceAudioCapture` (§4.2).
- `native/AthenaeumApp/Sources/AthenaeumAppUI/VoiceAssistantViewModel.swift` /
  `VoiceAssistantView.swift` — the SwiftUI surface (§4.3).

## What was and wasn't verified live — summary

| Component | Verified how | Live-tested here? |
|---|---|---|
| ScreenCaptureKit system-audio capture | Real API usage, compiles against real SDK | No — Screen Recording TCC needs a human |
| AVAudioEngine microphone capture | Real API usage, compiles against real SDK | No — Microphone TCC needs a human |
| `SFSpeechRecognizer` on-device ASR | Real API usage, compiles against real SDK; **live authorization attempted for real** | No — confirmed `AUTHREQ_PROMPTING` then unanswered timeout (§1.2) |
| Audio chunking + silence detection | Real algorithm | **Yes** — 6/6 tests pass, incl. a real speech fixture |
| Speaker clustering | Real algorithm (autocorrelation F0 + k-means) | **Yes** — 5/5 tests pass against real 2-voice `say` audio, correctly discriminates |
| `CloudTranscriptionClient` (OpenAI Whisper) | Real request/response shapes, verified via WebFetch | No real key — 10/10 tests pass against a mocked HTTP layer |
| `RealtimeVoiceClient` (OpenAI Realtime) | Real event shapes + real Cloudflare outbound-WebSocket mechanism, verified via WebFetch | No real key — 14/14 tests pass against a mocked WebSocket transport |
| Voice → `AgentEditService` reuse | Real composition, exercises the real `AgentEditService.sendChatMessage` type | 4/4 tests pass against a scripted realtime session |
| Live-audio-session RPC round trip (§4.1) | Real Cap'n Web HTTP-batch round trips | **Yes** — 6 backend tests (real RPC, real polling, real agent-turn wiring) + 2 native `VoiceAudioSessionLiveTests` against a real local `wrangler dev` |
| Mic-capture → PCM16 → RPC pipeline (§4.2) | Real algorithm, real `say`-synthesized speech | **Yes** — 6 (`PCM16Tests`) + 6 (`VoiceAudioBatcherTests`) + 4 (`VoiceAudioStreamerTests`) + 3 (`LiveVoiceAudioCaptureTests`) = 19/19 pass |
| `AVAudioEngineMicrophoneSource` live hardware capture | Real API usage, compiles against real SDK | No — Microphone TCC needs a human (unchanged from §1's own finding) |
| SwiftUI voice-assistant surface (§4.3) | Real composition; full macOS `.app` builds, links, codesigns, validates | Not independently unit-tested (no XCTest coverage exists at this view-model layer anywhere in this codebase — same as `AgentEditViewModel`'s own precedent); its dependencies are each tested independently as above |

**Total new automated test coverage added this stage (native voice-UI task, §4)**: 6 new backend
tests (`voice-audio-session.test.ts`) + 19 new Swift tests across `AthenaeumCore`
(`PCM16Tests`/`VoiceAudioBatcherTests`/`VoiceAudioStreamerTests`/`LiveVoiceAudioCaptureTests`) + 2
new live-backend Swift tests (`VoiceAudioSessionLiveTests`, run for real against `wrangler dev`)
= **27 new tests, all passing**, alongside the full pre-existing backend (178/178 → 184/184),
domain (484/484), `AthenaeumCore` (56/56, 3 live-only skips), and `AthenaeumRPC` (20/20, 11
live-only skips) suites re-run clean after these additions, plus a full macOS `.app` build/link/
codesign/validate pass.

**Total new automated test coverage added across §§1-3 (prior stage)**: 16 domain schema tests
(`cloud-transcription.test.ts` + `realtime-voice.test.ts`) + 28 backend client/integration tests
(`cloud-transcription-client-openai.test.ts` 10 + `realtime-voice-client-openai.test.ts` 14 +
`voice-chat-bridge.test.ts` 4) = 44 new TypeScript tests, plus 19 new Swift tests (native
Meetings module) = **63 new tests, all passing**, alongside the full pre-existing backend
(167/167) and domain (430/430) suites re-run clean after these additions.
