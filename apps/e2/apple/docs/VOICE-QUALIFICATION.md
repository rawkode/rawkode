# Voice qualification

Updated 13 September 2026. Passing one surface does not qualify another.

## Verified

- Production browser WebRTC: authenticated Supertag lookup returned correct
  names, matching the graph UI, with captured nonzero output audio and confirmed
  session cleanup. The synthetic input must continue after its speech clip ends.
- Production greeting: new and resumed sessions returned model-chosen greetings
  with no caller speech, captured audio, and HTTP 200 cleanup.
- Graph writes: the actual migrated SQLite store was exercised through voice
  tools to create a tagged bookmark, read back its URL, update it, reject a stale
  revision, and reopen the store to verify persistence. This was local fixture
  data, not a production spoken mutation.
- Voice/backend regression suite: 94 tests passed after entity-write tools were
  added. Unknown write outcomes block further writes in that turn.
- Native iOS: Simulator build passed after fixing interruption-end teardown and
  empty UTF-16-clipped history entries.
- Mac Speak/Type companion: build passed. Keyboard behavior and live Mac audio
  still require interaction testing.

- CarPlay scene: production iOS Simulator build and built scene manifest passed.
  Source review found no blocking issues in ownership, teardown, availability
  guards, or template limits. This does not establish vehicle behavior.

## Required before native completion

1. Sign in normally in the native harness, verify the account, start a call,
   receive the greeting, send the synthetic Supertag question, and save nonzero
   remote PCM plus the matching answer. Confirm remote cleanup.
2. On the physical iPhone, verify speaker default, receiver selection, an
   available Bluetooth route, mute/unmute while awaiting a tool answer, and
   interruption by a call. Ending an interruption must not stop a later session.
3. Save a user-approved graph item by speech and inspect its persisted tag and
   field values. Confirm that an explicit approval is not requested twice and
   that an unknown outcome is not represented as success.
4. Switch Speak → Type → Speak. The microphone stops before typing, text uses
   the same history, returning to Speak requires Start, and account changes
   clear earlier-account content.
5. Verify Mac Return/Shift-Return behavior, window close, sleep, and native audio.
6. Verify CarPlay appearance, cold launch without a phone window, locked-phone
   authentication, explicit Start, Mute/End, Siri/call interruption, and
   disconnection during setup, active speech, and remote closure. No captions
   or model-answer text may appear on the car screen.

The native synthetic-audio target bypasses AVAudioSession route and interruption
handlers. Its success would qualify native transport and graph integration,
not microphone permission, speaker/Bluetooth behavior, or vehicle behavior.
The paired physical iPhone was unavailable and the Mac was locked at the latest
interactive verification attempt. Do not weaken credential protection or use
simulated account identity to pass those gates.

## Production write verification, 13 September

The authenticated typed endpoint reproduced HTTP 503 after creating a web-link
fixture. A direct GraphQL read proved its title and URL persisted at revision 1.
The SDK regression reproduced a four-tool-step chain ending without answer text.
The deployed policy now reserves a fifth, tool-free answer step while retaining
wall-clock and connector-call limits. Updating the same fixture through the live
agent returned HTTP 200 with a complete answer; an independent GraphQL read
confirmed the updated URL at revision 2. No failed creation was retried.

Fixture retained: `Enchiridion voice verification 2026-09-13`, URL
`https://example.com/enchiridion-voice-verified`. This establishes authenticated
production typed mutation and persistence, not native spoken mutation. The
agent regression directory passed 93 tests; the SDK policy regression includes
exactly-one-write and prior-result continuation assertions.
