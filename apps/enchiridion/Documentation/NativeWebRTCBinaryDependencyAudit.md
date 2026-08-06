# Native WebRTC binary dependency audit

## Scope and lock

Enchiridion consumes only the low-level `LiveKitWebRTC` binary product from `livekit/webrtc-xcframework`, not LiveKit's room SDK, protocol, server, or UI. `project.yml` pins the source package with `exactVersion: 144.7559.11`; the product is linked only by `EnchiridionMobile` and `EnchiridionMac`.

The upstream annotated tag object for `144.7559.11` is `2a4963eca975dc66fdc93cd17e52bcdccfa496a7`. SwiftPM records the tag's dereferenced source commit, `46f2af86f06b9a8a9158d37cadda5cb5a214e4c4`, in `Package.resolved`; this is expected for an annotated tag. The release's `Package.swift` declares binary-target checksum `07c5caf718058af3c528dcabd257298c40e5a8527e4fb9f47c48336ba5899853` and no package dependencies.

## Binary audit

The downloaded XCFramework contains iOS device arm64, iOS Simulator arm64 and x86_64, macOS arm64 and x86_64, and additional Catalyst/tvOS/visionOS slices. It includes `PrivacyInfo.xcprivacy` in iOS and macOS frameworks. Its manifest declares no collected data or tracking, and required-reason access for System Boot Time (`35F9.1`, `8FFB.1`) and File Timestamp (`C617.1`). The package repository `LICENSE` is MIT; its copyright and permission notice must be included in Enchiridion's third-party distribution notices before shipping.

No `.dSYM` bundle was present in the downloaded XCFramework. Release crash diagnostics therefore depend on symbols supplied separately by the vendor or on an explicitly accepted unsymbolicated boundary; this package does not establish that diagnostic path.

## Compile-only compatibility evidence

`NativeWebRTCCompatibilityProbe.swift` is never invoked and has no network, credential, microphone, or playback behavior. It type-checks against both arm64 iOS and macOS slices with Xcode Swift 6.

- iOS imports `LKRTCAudioSession`; its public `useManualAudio` and `isAudioEnabled` controls compile.
- macOS imports no `LKRTCAudioSession`; it uses `LKRTCPeerConnectionFactory.audioDeviceModule` as `LKRTCAudioDeviceModule`.
- Unified Plan accepts one `.audio` `.sendRecv` transceiver and one ordered `LKRTCDataChannel` labelled `oai-events`; no video API is configured.
- The kind-created transceiver exposes `sender.track` as optional, permitting a future offer to retain a nil local sender track until explicit input enable.
- `offer(for:)`, `setLocalDescription(_:completionHandler:)`, and optional `LKRTCPeerConnectionDelegate` callbacks `peerConnection(_:didStartReceivingOn:)` and `peerConnection(_:didAdd:streams:)` compile.
- Remote track `isEnabled` supplies immediate track enable/disable control. `LKRTCAudioTrack.addRenderer(_:)` supplies decoded PCM renderer callbacks (`LKRTCAudioRenderer.render(pcmBuffer:)`) for metering only. The inspected public headers expose no per-response playback-drained callback and no authoritative per-response queue flush; a later runtime must not invent one with timers, silence, or `response.done` and must not add a PCM player here.

This is compile/interface evidence only. It does not prove physical iPhone or Mac microphone permissions, routes, audio ownership, remote playout, barge-in latency, or OpenAI `/v1/realtime/calls` interoperability. Those require an explicit later physical test with no saved key or SDP logged.
