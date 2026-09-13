# Enchiridion delivery board

Updated 13 September 2026. Product owner: this Codex thread. This board records
verified capability, current ownership, and the next release gates. It is not a
claim that planned features are available.

## Product outcome

One personal workspace for commitments, knowledge, and action. Open the app to
understand the day; speak to retrieve or act on connected information; turn a
meeting into a reliable note and explicit follow-ups. The phone, Mac, Watch,
and car must earn their own interface rather than share an oversized screen.

The approved phone direction is Floating Dock (06): week navigation, separate
all-day events, calendar-colored timeline, subtle integration markers, and a
single note-preview dock. Preserve Rosé Pine Dawn and Dark and native glass.

## Release status

- `36bf4cc0`: floating dock implementation pushed to PR 35. Three targeted
  Simulator UI tests and 29 Core tests passed in the preceding delivery turn.
  Cloud Build 8 was started; tester availability has not been confirmed.
  On 13 September Xcode reports Unable to Access Xcode Cloud and requires
  a fresh team Apple Account sign-in; release verification is blocked.
- Saved day context survives offline restart. The remote rich-text editor is
  not yet qualified for full offline editing. Partial integration failures can
  still replace a section with empty data; this needs separate cache handling.
- CarPlay entitlement exists; no verified conversational CarPlay scene or
  installed car launcher experience. Do not equate a widget with a CarPlay app.
- Internal-group automatic distribution is not configured. App Store Connect
  authentication was the last known blocker and must be freshly checked.

## Work in progress

| ID | Priority | Work | Owner | Acceptance gate |
| --- | --- | --- | --- | --- |
| REL-01 | P0 | Reliable TestFlight delivery | Product owner | Signed build processed, attached to existing internal group, tester availability observed; no claim based only on archive success |
| DATA-01 | P0 | Independent offline projections | Next implementation | Cold offline launch reads local state; service failure retains its last known data and reports freshness; account changes cannot reveal another account's cache |
| VOICE-01 | P0 | GPT Live conversation foundation | Voice agent | Verified public transport/auth contract; server-owned credentials; authenticated, bounded sessions; tested ownership and failure behavior |
| VOICE-02 | P0 | Talk to the day on iPhone | After VOICE-01 | Real microphone input and spoken response grounded in calendar/notes; visible recording/mute/end; interruption and reconnect tested on device |
| VOICE-03 | P0 | Code-mode tools | After VOICE-01 | Discoverable typed integration API; bounded isolated execution; owner-scoped read access; no ambient secrets; writes are explicit and idempotent |
| MEET-01 | P0 | Durable meeting transcript | Meeting agent | Stable segment IDs, provisional/final revisions, timestamps, interrupted-session recovery; persisted transcript is not silently replaced by a summary |
| MEET-02 | P0 | Live meeting notes | After MEET-01 and transport | Start/pause/stop is visible; real audio produces retained text; user can correct it; summary and proposed tasks link to transcript evidence |
| CAR-01 | P1 | CarPlay conversation | After VOICE-02 | Approved scene appears in car; voice-only useful interaction, short responses, audio interruption/locked-phone behavior verified in Simulator and real vehicle |
| MAC-01 | P1 | Desktop voice and meetings | After VOICE-02 / MEET-02 | Native Mac capture controls, explicit audio source, permission handling, meeting capture and agent coexist without feedback loops |
| GRAPH-01 | P1 | Tana/Fibery capability matrix | Capability agent | Official source-linked families mapped to actual repo behavior, missing capabilities and testable release slices |
| TASK-01 | P1 | Reliable commitments | After GRAPH-01 | Typed tasks with status, due/scheduled dates, ownership, views, recurrence/reminders and durable completion semantics |
| BOOK-01 | P2 | Public booking links | After calendar write contract | Availability, timezone/buffer/conflict correctness; idempotent booking and cancel/reschedule; Google write consent; anonymous pages isolated from private graph and PDS |

P0 voice and meeting work are distinct streams: a conversational assistant is
not automatically a meeting recorder, and an audio stream is not automatically
a durable transcript. Phone-call capture is not assumed available. Platform
limitations belong in the acceptance evidence.

## First delegated handoff — 13 September

- Voice: `integrations/agent/` contains an isolated authenticated GPT Live SDP
  broker and owner-bound day-briefing capability. Eight isolated tests, lint and
  formatting pass. It is unmounted: durable permits, real service adapters,
  executor qualification and live native transport are still required.
- Independent voice review found output-field leakage and session receipt
  downgrade paths. Both were fixed with regression tests before integration.
- Meetings: `MeetingTranscript.swift` retains provisional/final revisions,
  reconnect-scoped identities, interruptions and source-linked suggestions.
  All 34 Core tests pass, including five transcript tests. No microphone, live
  transport, recording UI or Vault integration is present yet.
- Capability audit: `apple/docs/PRODUCT-CAPABILITY-MATRIX.md` maps ten families
  with official sources and actual repository evidence. Voice and live meeting
  notes are P0 alongside reliability; task/booking and broad parity follow.
- Next bounded implementations: durable voice-session permits and a real
  owner-scoped day adapter; a local SpeechAnalyzer microphone spike with
  persisted transcript segments. Neither may be presented as shipped until
  the corresponding real transport and recovery checks pass.

## Next release slices

1. Stabilize daily use and distribution while landing tested voice/transcript
   foundations. A foundation may ship as dormant code; describe it that way.
2. A usable iPhone voice vertical slice: ask about the day, retrieve a note,
   and propose one explicit follow-up through the typed tool boundary.
3. Live meeting capture with editable transcript, linked summary and proposed
   action items. Proposals become tasks only through a clear user action.
4. CarPlay and Mac delivery against the same authenticated agent and graph,
   with device-specific audio and interaction qualification.
5. Expand typed graph, query/view, automation and collaboration capabilities
   according to the capability matrix, not superficial feature checkmarks.

## Delivery cadence and evidence

The product-owner follow-up runs hourly in this thread to inspect delegated
work, integrate bounded changes and advance the next priority. Report material
progress or a concrete blocker; do not repeat unchanged claims. Update this
board when ownership, dependency or verified shipping status changes.

Each handoff includes changed files, exact checks, sources for external API
claims, and unresolved risks. Keep implementation owners separate when scopes
can run independently. Review cross-account access, save/sync transitions and
external side effects before integrating those boundaries.

Required release evidence: appropriate automated checks; actual screen and
interaction checks for UI; offline/restart checks for local data; real transport
checks for voice/transcription; device checks for permissions, background audio,
Watch and CarPlay. Label planned, local, pushed, cloud-built and tester-available
states separately. No unverified "Apple Design Award" or feature-parity claims.
