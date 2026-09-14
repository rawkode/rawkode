# Real audio smoke test without microphone access

This development-only harness streams a prerecorded speech file through a real
browser WebRTC peer into GPT Live and saves actual returned audio and events. It
never calls `getUserMedia`. Nothing in this directory is part of the app,
website, worker build, or deployed routes. The server binds only `127.0.0.1`,
uses a per-run request token, and closes owned sessions after 90 seconds.

## Prepare synthetic input

On macOS, generate a WAV file using the built-in synthesizer (not a microphone):

```sh
say -o /tmp/ench-voice-input.aiff 'Hello. Tell me a short sentence about the moon.'
```

Convert to PCM WAV with:

```sh
afconvert -f WAVE -d LEI16 /tmp/ench-voice-input.aiff /tmp/ench-voice-input.wav
```

For the authenticated application test, use a question whose answer you can
verify against actual connected data, such as “What is next on my calendar?”. Do
not use a private transcript as the source audio.

## Run

Use one of these configurations in the local process environment. Do not put
secrets in source files, CLI arguments, screenshots, or output logs:

- **Application mode:** `VOICE_TEST_ORIGIN` is the deployed HTTPS website
  origin; `VOICE_TEST_COOKIE` is an authorized `CF_Authorization=...` cookie for
  that origin. This exercises real app session authorization, sideband tools and
  audio.
- **Transport-only mode:** `OPENAI_API_KEY` supplies a project key with GPT Live
  access. This bypasses the Enchiridion backend and cannot qualify its identity,
  tools or sideband implementation. It is useful only to isolate provider audio.

```sh
deno run --allow-read --allow-write=/tmp/ench-voice-evidence --allow-env=VOICE_TEST_ORIGIN,VOICE_TEST_COOKIE,OPENAI_API_KEY --allow-net \
  apple/Tools/voice-smoke/server.ts /tmp/ench-voice-input.wav /tmp/ench-voice-evidence
```

Open the printed loopback URL in Chrome or Firefox. Click **Run test** to create
one billable provider session and stream the supplied file. **Stop** requests
`session.close`, waits up to three seconds for its final event, then calls the
server-owned end endpoint. Automatic stop runs after 60 seconds. No automatic
creation retry is performed.

Evidence is saved to `/tmp/ench-voice-evidence/events.json` and
`remote-audio.webm`. Listen to the returned recording; check input/output
transcripts, received remote audio bytes, terminal session event, backend close,
and (in application mode) factual answer against the actual source. A green HTTP
response or an output transcript alone does not prove audible output. Do not
label transport-only results as native iPhone or authenticated app E2E.

## Keep input audio running after the fixture

The prerecorded speech ending must **not** stop audio delivery. Keep an active
continuous quiet source connected to the `MediaStreamDestination` until the
session ends. A finite `AudioBufferSourceNode` alone can stop producing frames
when its fixture ends, leaving commentary pending even though the backend lookup
completed. Merely retaining a live track object is insufficient evidence of
continued media delivery.

Run a quiet oscillator alongside the finite speech source, retaining it until
cleanup. Check that outbound media continues after the fixture, then require
both a `session.commentary.appended` acknowledgement and the factual spoken
response. Stopping a session with pending commentary may produce a late provider
error; that alone does not prove the commentary payload was invalid.

OpenAI's
[session guide](https://developers.openai.com/api/docs/guides/live-conversations#greet-before-the-caller-speaks)
requires continued input, including silence, and an active negotiated WebRTC
input track when requesting speech with appended context.

## Native qualification boundary

The pinned WebRTC153 framework includes `RTCAudioDevice` and
`RTCPeerConnectionFactory(...audioDevice:)`. A dedicated test target can inject
PCM through `RTCAudioDeviceDelegate.deliverRecordedData` and retain remote PCM
through `getPlayoutData`, avoiding the microphone entirely. That target still
needs custom audio-device threading/timing tests. This browser harness does not
validate native AVAudioSession, speaker routing, Bluetooth, interruptions, or
physical iPhone behavior; those remain separate release checks.
