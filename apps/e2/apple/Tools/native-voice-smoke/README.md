# Native voice smoke test

This dedicated iOS Simulator app compiles the real `VoiceConversation` and
`NativeSession`. Its compile-only `ENCHIRIDION_VOICE_AUDIO_HARNESS` flag replaces
the physical audio device with synthetic PCM. The production app does not define
that flag. No microphone, speaker, provider API key, fake account, or mock server
is involved. A real session costs money: start only when authorized.

## Build and prepare

Run from `apps/e2`:

```sh
xcodegen generate --spec apple/Tools/native-voice-smoke/project.yml
xcodebuild -project apple/Tools/native-voice-smoke/NativeVoiceSmoke.xcodeproj \
  -scheme NativeVoiceSmoke -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/ench-native-voice-smoke build
xcrun simctl install booted /tmp/ench-native-voice-smoke/Build/Products/Debug-iphonesimulator/NativeVoiceSmoke.app
say -o /tmp/voice-input.aiff 'What is on my calendar today?'
ffmpeg -y -i /tmp/voice-input.aiff -ar 48000 -ac 1 -f s16le /tmp/voice-input.pcm
```

Locate the Simulator container using
`xcrun simctl get_app_container booted rawkode.academy.enchiridion.voicesmoke data`,
then copy `/tmp/voice-input.pcm` to its `Documents/input.pcm` (create Documents if
needed). Input must be nonempty, even-length, and at most 30 seconds. Launch with
`xcrun simctl launch booted rawkode.academy.enchiridion.voicesmoke`.

Enter the real website origin and tap Prepare. Sign in normally in the embedded
website, dismiss it, then Verify account. Credentials stay in this dedicated
app's WKWebsiteDataStore; no credentials are supplied by launch arguments or
written into logs. The harness deliberately cannot assert an owner itself.

Tap **Start real paid session** once. Once connected, tap **Send prerecorded
speech**. This feeds the file once with silence afterward. The custom device
calls WebRTC on one dedicated thread at approximately 10 ms intervals. It polls
remote PCM without playing it. Stop and save when the response finishes; the
60-second deadline also stops the session. Backgrounding stops it as well.
Relaunch the app for another run; each device instance is a single-run fixture.

## Evidence

Retrieve `Documents/remote.pcm` and `Documents/result.txt` from that container.
Listen later with `ffplay -f s16le -ar 48000 -ac 1 remote.pcm` if desired.
These files may contain private calendar information: keep them local and remove
them after review. Nothing uploads them automatically.

A passing build is only API compatibility. A passing live run needs all of:

- Real authenticated session reached connected.
- Input caption matches the synthetic question, output captions answer it.
- Remote PCM contains nonzero speech, not merely a nonempty silence buffer.
- The answer is checked against the actual calendar and server delegation evidence.
- Normal session cleanup completes without an unconfirmed-close error.

`result.txt` is a compact observation, not an automatic PASS verdict. A process
kill cannot guarantee graceful cleanup; the server's bounded lease remains the
backstop. This does not qualify physical microphone, speaker, Bluetooth, CarPlay,
interruptions, or real-device audio behavior.
