# Enchiridion delivery board

Updated 13 September 2026. Product owner: this Codex thread. This board records
verified capability, current ownership, and the next release gates. It is not a
claim that planned features are available.

## Product outcome

One personal workspace for commitments, knowledge, and action. Open the app to
understand the day; speak to retrieve or act on connected information; turn a
meeting into a reliable note and explicit follow-ups. The phone, Mac, Watch, and
car must earn their own interface rather than share an oversized screen.

The approved phone direction is Floating Dock (06): week navigation, separate
all-day events, calendar-colored timeline, subtle integration markers, and a
single note-preview dock. Preserve Rosé Pine Dawn and Dark and native glass.

## Release status

### Latest verified status — 13 September, 17:48 BST

- TestFlight Build 15 passed cloud archive, publishing and automatic internal
  distribution. Apple reports `VALID` and `IN_BETA_TESTING`. The actual
  rejection of Build 13 was ITMS-90683 (missing camera usage description from
  the bundled WebRTC references), fixed in `47708b11`.
- Native voice account recovery is pushed in `791189d7`; iPhone/Mac builds and
  the sign-in/cancel UI test pass. This does not qualify a live conversation.
- The user-supplied Cloudflare token is active. Production deployment can retain
  the six Google/GitHub credentials from validated Alchemy state, keeping the
  secret resources declared and unchanged. Plain GitHub app ID and slug were
  checked against the deployed Worker. The original CI vault references remain a
  separate configuration issue; the local authorized deployment bypasses them.
- A real synthetic WebRTC session request to OpenAI failed with HTTP 400
  `model_not_found` for `gpt-live-1`, including a fresh retry after the user
  said the token was fixed. No session or received audio was recorded. The
  supplied key versus a replacement key still needs clarification. No automatic
  model substitution was made.
- Production deployment completed: live Cloudflare metadata confirms the website
  VOICE service points to apsides-integrations-agent and OPENAI_API_KEY is a
  secrets_store_secret binding to the existing active secret. Runtime secret
  retrieval and authenticated spoken conversation remain unverified.
- Deployment verification caught the previous custom OpenAI binding being
  serialized as JSON. It now uses Alchemy's explicit Worker binding API to bind
  the existing Secrets Store secret without reading or changing its value.

The entries below retain earlier investigation evidence and are superseded by
this latest status where they describe TestFlight or credential availability.

- Voice is the current release priority, followed strictly by tasks, meeting
  capture, and offline editing. The local iPhone WebRTC conversation screen and
  captions now compile; the signed-in server path, private Worker, session
  ledger, sideband delegation, and bounded Cloudflare code-mode day reads are
  wired. These changes are not yet deployed or verified with a real spoken call.
- The user supplied the OpenAI key directly after 1Password authorization timed
  out. It is now verified active in Cloudflare Secrets Store as
  `e2-production-agent-openai-api-key`, scoped to Workers. The production voice
  deployment references it without requiring its value during deployment.
- The supplied project key authenticates successfully to OpenAI model discovery.
  `gpt-live-1` returned 404 and was absent from its available voice-model list;
  a real SDP session request is still needed to qualify Live access. Do not
  silently substitute Realtime or claim a spoken conversation works.
- Current verification: 51 Apple Core tests, the native voice opening journey,
  48 voice/proxy contract tests, repository regression tests and all seven
  Worker bundles pass. Real local workerd confirms fixture reads, denied network
  access, absent host secrets and asynchronous cancellation. Its CPU budget is
  not enforced locally; deployed CPU-limit qualification remains open.
- The synthetic real-provider audio test is prepared on loopback without
  microphone access. Automatic approval review requires explicit approval for
  its capped paid session; no Live session has been started.
- The configured Xcode Cloud branch trigger started an archive automatically for
  `b9d18dc6`. It completed on 13 September at 14:30 UTC with
  `Preparing build for App Store Connect failed` (one error and four existing
  meeting-audio concurrency warnings). The underlying distribution error is only
  available in App Store Connect, whose browser session is signed out. This
  build is not verified as TestFlight-available. Internal tester-group
  automation is deferred at the user's direction.
- The following automatic archive for `db917c91` also stopped at preparation for
  App Store Connect with the same generic error. The downloaded WebRTC 153
  XCFramework and device framework are unsigned, although its privacy manifest
  is present. This is a distribution risk, not a confirmed explanation of the
  cloud error; obtain the actual distribution/ITMS diagnostic before replacing
  the dependency or changing signing.
- Release regression comparison: the `bb24547f` Apple check succeeded; the next
  commit, `b9d18dc6`, introduced the WebRTC binary dependency and began the
  preparation failures. Its pinned Swift package omits the separately published
  WebRTC dSYMs. Matching symbols must be included before archive export. Local
  browser sign-out does not establish a cloud authentication failure, and the
  generic cloud check alone does not establish a compilation failure.
- WebRTC symbol packaging is now repaired locally: an archive-only build phase
  downloads the original M153 dSYM asset with a pinned SHA256, verifies embedded
  architecture UUIDs, and copies it before export. A real unsigned iOS archive
  succeeded, with framework and archived dSYM both reporting UUID
  `4C4C4496-5555-3144-A149-A7E882FEE780`. Symbol upload remains enabled. The
  next cloud distribution result must establish whether this resolves
  publishing; local archive success does not establish TestFlight availability.
- Build 13 logs now confirm successful cloud archiving, WebRTC symbol packaging,
  and all exports. Its exported App Store IPA passes distribution signature
  verification, but records the original WebRTC SDK as unsigned. The user
  requested signing it: P4X now publishes an explicitly identified,
  timestamp-signed redistribution of the unchanged M153 XCFramework. Its
  immutable ZIP checksum is pinned by `apple/Vendor/WebRTC`. This addresses SDK
  signing provenance; Apple's final processing result remains the release gate.
- Fresh resolution downloaded and cryptographically verified the P4X artifact.
  The resulting iOS archive succeeded and records WebRTC SDK `signed: true`,
  `signatureType: AppleDeveloperProgram`, and team `6KXCJGJ45W`, with the
  original matching dSYM retained. Cloud publishing and TestFlight availability
  remain unverified for this change.
- Mac voice now builds with the shared authenticated transport, explicit
  microphone consent, a dedicated captions window, and keyboard controls. The
  iPhone regression build also passes. An actual hidden-window test verifies
  synchronous owning-window close callbacks, unrelated-window isolation, and
  observer removal. Physical media teardown and provider interaction still
  require qualification.
- Phone and Mac now receive a single coordinator from `WorkspaceStore`. Account
  revocation clears captions and disconnects media centrally; explicit
  presentation ownership prevents duplicate starts and cross-surface stops. The
  iPhone voice-screen journey and Mac build pass. This is a prerequisite for the
  design in `apple/docs/CARPLAY-VOICE.md`, not a CarPlay scene or a verified
  spoken conversation.

- `36bf4cc0`: floating dock implementation pushed to PR 35. Three targeted
  Simulator UI tests and 29 Core tests passed in the preceding delivery turn.
  Cloud Build 8 was started; tester availability has not been confirmed. On 13
  September Xcode reports Unable to Access Xcode Cloud and requires a fresh team
  Apple Account sign-in; release verification is blocked.
- Saved day context survives offline restart. The remote rich-text editor is not
  yet qualified for full offline editing. Partial integration cache retention is
  now implemented and tested locally; the GitHub completeness field still needs
  backend deployment.
- CarPlay entitlement exists; no verified conversational CarPlay scene or
  installed car launcher experience. Do not equate a widget with a CarPlay app.
- Internal-group automatic distribution is not configured. App Store Connect
  authentication was the last known blocker and must be freshly checked.

## Work in progress

| ID       | Priority | Work                             | Owner                           | Acceptance gate                                                                                                                                                         |
| -------- | -------- | -------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REL-01   | P0       | Reliable TestFlight delivery     | Product owner                   | Signed build processed, attached to existing internal group, tester availability observed; no claim based only on archive success                                       |
| DATA-01  | P0       | Independent offline projections  | Implemented; deployment pending | Cold offline launch reads local state; service failure retains its last known data and reports freshness; account changes cannot reveal another account's cache         |
| VOICE-01 | P0       | GPT Live conversation foundation | Voice agent                     | Verified public transport/auth contract; server-owned credentials; authenticated, bounded sessions; tested ownership and failure behavior                               |
| VOICE-02 | P0       | Talk to the day on iPhone        | After VOICE-01                  | Real microphone input and spoken response grounded in calendar/notes; visible recording/mute/end; interruption and reconnect tested on device                           |
| VOICE-03 | P0       | Code-mode tools                  | After VOICE-01                  | Discoverable typed integration API; bounded isolated execution; owner-scoped read access; no ambient secrets; writes are explicit and idempotent                        |
| MEET-01  | P0       | Durable meeting transcript       | Meeting agent                   | Stable segment IDs, provisional/final revisions, timestamps, interrupted-session recovery; persisted transcript is not silently replaced by a summary                   |
| MEET-02  | P0       | Live meeting notes               | After MEET-01 and transport     | Start/pause/stop is visible; real audio produces retained text; user can correct it; summary and proposed tasks link to transcript evidence                             |
| CAR-01   | P1       | CarPlay conversation             | After VOICE-02                  | Approved scene appears in car; voice-only useful interaction, short responses, audio interruption/locked-phone behavior verified in Simulator and real vehicle          |
| MAC-01   | P1       | Desktop voice and meetings       | After VOICE-02 / MEET-02        | Native Mac capture controls, explicit audio source, permission handling, meeting capture and agent coexist without feedback loops                                       |
| GRAPH-01 | P1       | Tana/Fibery capability matrix    | Capability agent                | Official source-linked families mapped to actual repo behavior, missing capabilities and testable release slices                                                        |
| TASK-01  | P1       | Reliable commitments             | After GRAPH-01                  | Typed tasks with status, due/scheduled dates, ownership, views, recurrence/reminders and durable completion semantics                                                   |
| BOOK-01  | P2       | Public booking links             | After calendar write contract   | Availability, timezone/buffer/conflict correctness; idempotent booking and cancel/reschedule; Google write consent; anonymous pages isolated from private graph and PDS |

P0 voice and meeting work are distinct streams: a conversational assistant is
not automatically a meeting recorder, and an audio stream is not automatically a
durable transcript. Phone-call capture is not assumed available. Platform
limitations belong in the acceptance evidence.

## First delegated handoff — 13 September

- Voice: `integrations/agent/` contains an isolated authenticated GPT Live SDP
  broker and owner-bound day-briefing capability. Eight isolated tests, lint and
  formatting pass. It is unmounted: durable permits, real service adapters,
  executor qualification and live native transport are still required.
- Independent voice review found output-field leakage and session receipt
  downgrade paths. Both were fixed with regression tests before integration.
- Meetings: `MeetingTranscript.swift` retains provisional/final revisions,
  reconnect-scoped identities, interruptions and source-linked suggestions. All
  34 Core tests pass, including five transcript tests. No microphone, live
  transport, recording UI or Vault integration is present yet.
- Capability audit: `apple/docs/PRODUCT-CAPABILITY-MATRIX.md` maps ten families
  with official sources and actual repository evidence. Voice and live meeting
  notes are P0 alongside reliability; task/booking and broad parity follow.
- Next bounded implementations: durable voice-session permits and a real
  owner-scoped day adapter; a local SpeechAnalyzer microphone spike with
  persisted transcript segments. Neither may be presented as shipped until the
  corresponding real transport and recovery checks pass.

## Second implementation batch — 13 September

- iPhone meeting capture is implemented under Search → Browse. A real local
  SpeechAnalyzer microphone adapter handles permission, model installation,
  provisional/final text, pause/resume and bounded finalization. Device audio
  quality and interruption qualification remain open; no real-audio claim.
- Independent atomic meeting storage retains account ownership and survives
  interrupted app restart. Failed saves preserve the editor; corrupted archives
  remain read-only. Forty Core tests pass. The focused Simulator meeting journey
  passes save/close/relaunch/reopen, awareness gating and no automatic mic
  start. Both Rosé Pine screenshots were visually checked.
- Durable voice permits now use a Cloudflare storage transaction adapter, with
  owner binding, quotas, idempotency, persisted revocation and uncertain-session
  recovery. Seventeen tests pass. Worker deployment, provider lifecycle closure,
  typed integration adapters and live voice transport remain unmounted.
- Independent meeting review found no blocking issue in the single-editor flow.
  Full archive writes per revision still need long-meeting performance checks.
- `b64a7167` is pushed to PR 35. This batch is not yet available in TestFlight.

## Partial-refresh integration — 13 September

- Native calendar, people and GitHub sections retain missing cached items on
  incomplete responses; explicit successful empty results still clear data.
  Owner/day mismatches cannot reuse a cache. Each section exposes its own last
  successful refresh and cached/partial status.
- GitHub now reports `Today.githubActivityPartial` from the same memoized fetch
  as its rows. Timeouts, account errors and pagination truncation are
  incomplete; successfully disconnected or empty accounts are complete. This API
  change is not deployed yet.
- The native client retries only the exact unknown-field validation error from
  an older Today schema, then waits five minutes before probing again. Legacy
  GitHub results remain conservative rather than proving cached rows deleted.
- Watch and widget publication require a complete calendar, including restored
  startup context. Independent review found and fixed the startup bypass.
- Forty-nine Core tests pass, six focused GitHub deadline/schema tests pass,
  backend typecheck/lint pass, and the integrated Simulator build passes. The
  legacy offline cache relaunch/navigation UI journey passes. Freshness errors
  are separated from capture/widget warnings so those warnings do not imply a
  context refresh failure.
- Fresh Xcode check still reports team-account sign-in required. Latest branch
  changes are not verified as cloud-built, delivered to the internal group, or
  available in TestFlight.

## Voice data and release follow-up — 13 September

- The voice day-reader now uses the existing authenticated GraphQL service
  contract, binds verified Access identity, checks returned ownership and civil
  date bounds, and preserves source provenance and all-day meaning. Calendar and
  GitHub use independent two-second source deadlines inside a five-second
  overall budget. Twenty-seven voice tests pass; a hung GitHub source cannot
  erase a usable calendar briefing. Both queries validate against the schema.
  The root check/test commands now include this integration. Full formatting,
  lint, backend/editor typechecks and the JavaScript/TypeScript test stage pass;
  the test stage requires localhost access for its OAuth mock server. All six
  existing Worker bundles build. No paid session or live voice transport has
  been exercised.
- The offline editor proposal is saved in `apple/docs/OFFLINE-EDITOR.md`. It
  reuses the shared editor through an injected transport and one native
  cache/outbox record. Local durability and server revisions must remain
  distinct; bundled pages need a versioned bridge handshake instead of the
  current remote-origin save guard. This proposal is not implemented.
- CI run 34758504979 confirms the service-account cannot access the `apsides`
  vault. Cloudflare's reference is corrected to the personal website's existing
  service-account vault; eight integration references remain inaccessible.
  Existing workflow applies no changes: it runs a production dry-run.
- Installed Alchemy requires values for owned Secrets Store resources on update.
  Replacing them with references would remove owned declarations and schedule
  deletion. Do not bypass the credential issue with references, retain, adoption
  or guessed secrets. Existing credential access remains necessary.
- Automatic approval review rejected adding production apply on branch pushes. A
  manual-only deployment action was subsequently approved and generated. It
  requires validation and a production plan before apply; the push workflow
  remains dry-run only. Cuenv sync and dependency-graph checks pass. No apply
  was run; inaccessible integration credentials still block execution.

## Next bounded work

1. Integrate the tested owner-scoped day reader with the voice coordinator; keep
   authenticated API access and generated-code execution separate.
2. Mount the real voice coordinator and qualify provider close/reconciliation,
   explicit session enablement, and server-held credentials before paid calls.
3. Qualify meeting microphone, language assets, interruptions and long
   recordings on supported hardware. Optimize transcript persistence if
   profiling warrants.
4. Deploy the GitHub completeness API through the existing Alchemy production
   workflow, and resume cloud release/internal-group verification when Apple
   authentication is available.

## Next release slices

1. Stabilize daily use and distribution while landing tested voice/transcript
   foundations. A foundation may ship as dormant code; describe it that way.
2. A usable iPhone voice vertical slice: ask about the day, retrieve a note, and
   propose one explicit follow-up through the typed tool boundary.
3. Live meeting capture with editable transcript, linked summary and proposed
   action items. Proposals become tasks only through a clear user action.
4. CarPlay and Mac delivery against the same authenticated agent and graph, with
   device-specific audio and interaction qualification.
5. Expand typed graph, query/view, automation and collaboration capabilities
   according to the capability matrix, not superficial feature checkmarks.

## Delivery cadence and evidence

The product-owner follow-up runs every fifteen minutes in this thread to inspect
delegated work, integrate bounded changes and advance the next priority. Report
material progress or a concrete blocker; do not repeat unchanged claims. Update
this board when ownership, dependency or verified shipping status changes.

Each handoff includes changed files, exact checks, sources for external API
claims, and unresolved risks. Keep implementation owners separate when scopes
can run independently. Review cross-account access, save/sync transitions and
external side effects before integrating those boundaries.

Required release evidence: appropriate automated checks; actual screen and
interaction checks for UI; offline/restart checks for local data; real transport
checks for voice/transcription; device checks for permissions, background audio,
Watch and CarPlay. Label planned, local, pushed, cloud-built and
tester-available states separately. No unverified "Apple Design Award" or
feature-parity claims.
