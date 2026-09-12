# CarPlay voice conversations: API research

Research checked 12 September 2026. No Live API integration is enabled yet.

OpenAI's [changelog](https://developers.openai.com/api/docs/changelog) dates
GPT-Live 1 general availability to 10 September 2026. The model is `gpt-live-1`
and the endpoint is `POST /v1/live/sessions`. It supports simultaneous listening
and speaking, interruptions, and delegation to a separate reasoning/tool backend.
[Voice pricing](https://developers.openai.com/api/docs/models/gpt-live-1) is
$0.05/minute, billed per second, plus backend model and tool usage.

Use native CarPlay controls and audio handling with WebRTC media. An authenticated
Enchiridion backend should create Live sessions and retain the OpenAI project key.
The client sends its SDP offer through that backend, applies the returned SDP
answer, and waits for `session.started`. The old Realtime client-secret examples
are not the documented Live authentication flow.
[WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live).

Keep authorization and durable document state in existing app services. Client
delegation can route and validate actions, but needs application-owned context.
Interrupting speech does not automatically cancel a delegated action. Provide
explicit action cancellation and confirmation semantics before enabling writes.
[Delegation guide](https://developers.openai.com/api/docs/guides/live-delegation).

Sessions default to `store: false`. Voice, model, and delegation-mode changes need
a new session. Handle `session.closed` and connection loss explicitly.
[Session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations).

Apple's [CarPlay guide](https://developer.apple.com/download/files/CarPlay-Developer-Guide.pdf)
requires voice-first launch, recording in conjunction with the voice-control
template, and audio sessions only while voice features are active. Do not render
query responses as text or imagery in the driving UI. Gate the future interface
to iOS 26.4 or later. The current app only reserves the entitlement; it declares no
CarPlay scene or microphone access.

Still unverified: this OpenAI project's Live access, native Swift transport
integration, session-duration ceiling, car audio interruptions, locked-phone
operation, and real vehicle behavior. No claim of a ready CarPlay conversation
experience follows from API availability or entitlement approval.
