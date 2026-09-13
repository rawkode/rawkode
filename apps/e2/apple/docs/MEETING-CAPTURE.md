# Meeting capture: delivery boundary

Updated 13 September 2026. The iPhone now has a local SpeechAnalyzer microphone
adapter, meeting capture screen, and durable transcript storage. The integrated
Simulator build and notes persistence journey pass. Real microphone recognition,
installed language models, and interruption behavior still require device
qualification. Cloud transcription and automatic task creation are not implemented.

## First useful experience

Start from a calendar event or a standalone meeting. Before recording, show the
selected input, where audio will be processed, and an explicit reminder to inform
participants. Start requires the user's acknowledgement; this is not proof that
other people heard or agreed. Keep an unmistakable recording indicator, elapsed
time, Pause/Stop, and interruption/reconnect status visible. Never restart capture
silently after an interruption or process restart.

Show timestamped transcript segments as speech arrives, marking provisional text.
Keep the editable meeting note separate, so recognition changes cannot overwrite
what the user wrote. Summary and action suggestions must link to final transcript
segments and supporting quotations. They remain reviewable suggestions; accepting
a task is a separate action. A quote proves provenance, not that an inference is
correct. Do not invent speakers, deadlines, assignments, or commitments.

## Verified platform options

Apple's SpeechAnalyzer supports live and recorded speech analysis. Its modern
transcriber provides provisional and finalized results; model availability and
language assets must be checked before an offline promise. This is the preferred
first adapter to evaluate for private, on-device meeting transcription. Accuracy,
energy use, supported devices/languages, and long meeting behavior still require
our own measurements. [Apple WWDC25 SpeechAnalyzer session](https://developer.apple.com/videos/play/wwdc2025/277/),
[SpeechAnalyzer API](https://developer.apple.com/documentation/speech/speechanalyzer).

For iPhone, begin with explicitly selected microphone input. Handle permission
denial, audio-session interruptions, route changes, and background transitions.
Do not promise audio from another app's call or a cellular call: this investigation
has not established such a supported capture path. The system recording permission
and our participant-awareness UI are separate concerns. [AVAudioSession](https://developer.apple.com/documentation/avfaudio/avaudiosession),
[AVAudioApplication](https://developer.apple.com/documentation/avfaudio/avaudioapplication).

For Mac, evaluate a separate ScreenCaptureKit adapter for selected application
sound and microphone capture. Audio capture is opt-in via `capturesAudio`; microphone
capture has its own option. Validate permissions, excluded/current-process audio,
headphones, source switching, and echo on real hardware before claiming meeting-app
coverage. [capturesAudio](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio),
[captureMicrophone](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturemicrophone).

OpenAI currently documents `gpt-live-transcribe` with transcription-only sessions,
separate from a voice assistant that generates spoken responses. The guide supports
WebSocket/server pipelines and WebRTC/browser connections, incremental deltas and
completed item transcripts. It explicitly says the model does not provide word
timestamps, speaker labels, or confidence. Therefore the proposed live UI must label
its own audio-buffer segment offsets honestly; do not display invented word timing
or speaker identities. Reconcile by item ID, not completion arrival order. A
server-mediated transport, authenticated meeting ownership, retention controls and
an audio retry journal remain to be designed and verified. [OpenAI live transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription).

## Implemented, framework-independent core

`MeetingTranscript.swift` adds Codable meeting state, stream-scoped item IDs,
validated segment offsets, monotonic revisions, idempotent replay, immutable final
segments, user-owned note text, and source-checked summary/action suggestions.
Interrupting retains all segments and notes. Restoring through `restored()` converts
an interrupted app's saved recording state into an explicit interrupted state;
it does not restart a microphone. Late finalization after Stop remains allowed.

Adapters must map recognition revisions to stable segment IDs and meeting-relative
audio offsets. A reconnect uses a new stream ID while retaining original IDs when
replaying acknowledged input. The model cannot deduplicate the same audio sent as
new items: transport checkpointing must prevent that duplication. Transport gaps
must remain explicit rather than being silently stitched into continuous audio.

Existing `Capture` is an immutable short text capture; it should not be mutated
for each transcript delta. Existing shared documents are the destination for an
accepted meeting note. This work does not add meetings to Vault, change its schema,
or flatten existing rich documents into plain text.

## Implemented iPhone capture

Search → Browse → Meeting capture opens a local meeting library. Recording needs
an explicit Start and participant-awareness acknowledgement. The native adapter
uses AVAudioEngine, converts PCM into SpeechAnalyzer's supported format, and
retains provisional and final passages with application-scoped stream identities.
Overlapping provisional recognition ranges can be replaced without changing final
text. Initial Apple language assets may require a download; audio is processed on
device. Raw microphone audio is not retained or uploaded.

Pause, backgrounding, microphone interruption and input overflow stop capture.
Resuming always requires a user action. Stop has a 15-second finalization deadline;
late callbacks are fenced by the recording operation ID. This is foreground room
microphone capture, not system audio or phone-call recording.

`MeetingArchivePersistence` writes an independent atomic `meetings.json` file next
to the notebook. Entries retain their account owner; device-local entries have a
separate nil owner. Account switches hide another account's meetings while allowing
an already-open recorder to persist its final result to its original owner. Crash
restore marks active recordings interrupted. Failed saves keep the editor open
with retry; corrupt archives are preserved and not overwritten.

Forty Core tests pass, including eleven meeting model/archive tests. One Simulator
UI journey verifies participant-awareness gating, immediate note save and close,
relaunch/reopen, and no automatic microphone start. Both Rosé Pine palettes were
visually inspected. These checks do not establish real microphone transcription.
Every revision currently rewrites the archive on the main actor: long-meeting
latency and history growth remain qualification work.

## Remaining acceptance

1. Qualify the implemented SpeechAnalyzer adapter and transcript persistence.
   Audio buffers are bounded but are not a replayable audio journal. Test a
   60-minute recording, airplane mode after model installation, process restart,
   permission refusal, headset changes, phone interruptions and storage failure.
2. Add event linkage, source navigation and accepted shared-document publishing
   to the existing capture screen. Timestamp seeking requires retained audio and
   is not offered. Recognition remains separate from user corrections.
3. Add optional cloud transcription only after a real authenticated transport
   test. Upload only after the user's processing choice; define retention/deletion
   before storing audio. Verify out-of-order completions and reconnect replay.
4. Generate summaries against finalized segments, validate source references, show
   suggestions for review, and require explicit acceptance before creating tasks.

Validation: `swift test --package-path apple --scratch-path /tmp/enchiridion-meeting-tests`
passed all 34 core tests, including five meeting transcript tests on 13 September
2026. Log: `/tmp/enchiridion-meeting-tests.log`.

Current tests cover out-of-order revisions, replay, reconnect ID collisions,
immutable finals, invalid timestamps, interruption/restart preservation, editable
notes, and rejection of unsupported or provisional source references. They do not
establish actual recognition accuracy, capture availability, disk durability,
participant awareness, or end-to-end transport recovery.
