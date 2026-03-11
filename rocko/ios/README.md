# Rocko iOS

Native iOS + macOS client for Rocko chat, built around typed conversations with Mastra agents.

## Architecture

- **App** owns typed chat state, inbox/thread navigation, and the optional live voice plumbing.
- **Backend** exposes the standard Mastra HTTP API for typed chat and the live voice transport for streaming audio.
- **Typed chat** uses the built-in Mastra agent API at `/api/agents/:agentId/generate`.
- **Live voice** uses the WebSocket transport at `/carplay/live`.

## Project structure

```
RockoCarPlay/
├── Config/
│   ├── Info.plist
│   └── RockoCarPlay.entitlements
└── Sources/
    ├── App/
    │   ├── AppDelegate.swift
    │   ├── Configuration.swift       # WebSocket/API/auth config
    │   └── RockoCarPlayApp.swift
    ├── Audio/
    │   ├── AudioCaptureEngine.swift   # Mic → PCM16 mono @ 24kHz (resampled)
    │   └── AudioPlaybackEngine.swift  # PCM16 mono @ 24kHz → speaker
    ├── Networking/
    │   └── RockoSocketClient.swift    # WebSocket with URLSession delegate
    ├── Resources/
    │   └── Assets.xcassets/
    ├── State/
    │   └── LiveSessionStore.swift     # Per-agent text threads + live voice state
    └── UI/
        └── SessionDashboardView.swift # Messages-style inbox + thread UI
```

## Features

- PCM16 mono audio at 24kHz (capture resampled from hardware rate)
- Messages-style inbox with one conversation per Mastra agent
- Typed chat against the built-in Mastra API with separate memory threads per agent
- WebSocket with proper connection lifecycle (URLSessionWebSocketDelegate)
- Automatic reconnection with exponential backoff (up to 5 attempts)
- Audio session interruption handling (phone calls, Siri, route changes)
- Tool status display and agent catalog from backend
- Bearer token authentication support
- Runs on iPhone, iPad, and macOS (via Mac Catalyst)

## Setup

1. Open `RockoCarPlay.xcodeproj` in Xcode.
2. Set your Team and signing settings.
3. Set environment variables in the Xcode scheme for development:
   - `ROCKO_WS_URL` — override the live voice WebSocket endpoint
   - `ROCKO_API_URL` — override the Mastra HTTP API origin when it differs from the WebSocket origin
   - `ROCKO_AUTH_TOKEN` — bearer token for backend auth
4. Add an app icon (1024x1024 PNG) to `Assets.xcassets/AppIcon.appiconset/`.

## Testing

1. Start the backend: `bun run dev`
2. Run on iOS Simulator — the `Messages` inbox should list agents and open dedicated threads
3. For macOS: select "My Mac (Mac Catalyst)" as the run destination
4. Live voice transport remains in the app state layer, but the current UI focus is typed chat
