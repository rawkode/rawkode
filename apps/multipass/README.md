# Multipass

A macOS menu bar app that lets an EVO80 keyboard lead an MX Master 4 between Macs. Change the keyboard's Bluetooth slot; the Mac receiving the keyboard asks its paired peer to send the mouse to the corresponding slot.

## Run

Requires macOS 14 or later and the Swift toolchain supplied by Xcode or its command line tools. No third-party dependencies.

```sh
cd apps/multipass
./script/build_and_run.sh
```

The script builds and signs `dist/Multipass.app`, then opens it. The project-local Codex Run action calls the same script. `--build` packages without launching; `--verify` also runs tests and checks launch; `--debug`, `--logs`, and `--telemetry` support local debugging. The menu bar app deliberately has no Dock icon. Its setup window opens on launch and can be reopened from its menu.

The default signature is ad hoc for local development. Set `MULTIPASS_SIGNING_IDENTITY` to a configured signing identity if available. The app is not notarized or App Store sandboxed. Moving/rebuilding an ad-hoc app can require granting Input Monitoring again. Distributing beyond your own Macs needs a normal signed/notarized release.

## Pair two Macs

1. Run the app on both Macs, on the same local network. Build it on each Mac, or copy the app bundle to a Mac with a compatible CPU architecture. Allow Local Network access if macOS asks.
2. Set **Mouse slot** to **1** on the desktop and **2** on the laptop, matching the mouse's existing Bluetooth pairings. Multipass never creates or changes Bluetooth pairings.
3. On one Mac, select **Create pairing code** and copy the code. On the other, paste it and select **Join**. Create the code only on the first Mac; both must use the same code. The code authorizes mouse switching, so keep it private. Keys are stored in each Mac's Keychain.
4. Enable **Automatic switching** on both Macs. Wait for a nearby Multipass service to appear and allow three seconds for device state to settle.
5. Switch the EVO80 to the laptop. Once it connects there, the laptop requests mouse slot 2. Switch back to test slot 1.

If macOS denies the mouse interface, open **Input Monitoring settings**, enable Multipass, and restart the app. No keyboard reports or keystrokes are read; the app only enumerates the keyboard and opens the Logitech mouse's control interface.

**Launch at login** uses macOS's login-item service. Put the app in a stable location before enabling it. **Pause switching** immediately stops networking and invalidates pending requests. Replacing the pairing key pauses switching; enter the replacement on the other Mac before re-enabling.

## Behavior and boundaries

- The keyboard is detected by Bluetooth HID vendor/product `36B0:3004`; the mouse by `046D:B042`. These match the tested desktop devices. Slot-2 enumeration on the laptop still needs live qualification. Other hardware models are not yet configurable.
- A keyboard disconnection alone never sends a request. A fresh absent-to-present transition must remain connected for 800 ms. Launch, enable, configuration changes, and wake establish a baseline and suppress claims for three seconds.
- The source checks that its own keyboard is absent, its mouse is present, and the requested slot differs from its own slot. Immediately before writing the mouse command, it checks keyboard absence again and verifies the request is still valid.
- Bonjour (`_multipass._tcp`) discovers endpoints; it does not establish trust. Each request answers a fresh random challenge with HMAC-SHA256 using the shared 256-bit key. Slots and protocol versions are validated, and a challenge is consumed once.
- An authenticated request has a one-second monotonic lease. The destination keeps its TCP connection open and revokes the request if its keyboard leaves, switching is paused, or its state changes. The source cancels on connection loss or expiry. There is necessarily a small observation/network delay; this is not an atomic cross-computer hardware transaction.
- Sessions are bounded to three seconds and 4 KiB frames, with connection/fan-out caps. Authentication keys and keystrokes are never sent. Device UUID/slot metadata is authenticated but **not encrypted**; this is a local-network tool.
- Events are not queued while peers are unavailable. If discovery has not completed or the peer is offline, the mouse stays put; switch the keyboard away and back once both apps are ready. Sleep does not queue deferred switches.
- HID++ ChangeHost is discovered dynamically. Exactly one switch report is sent per accepted request; uncertain writes are not retried. Status reports source acknowledgment or observed departure, not verified destination connectivity. A successful write can immediately disconnect the mouse before a reply arrives.
- IOKit response waits are bounded. The underlying synchronous OS report call itself has no app-level cancellation deadline.
- The only persistent settings are this Mac's identity, slot, and enabled state in UserDefaults, plus the pairing secret in Keychain. Recent activity is in memory only.

## Layout

- `Multipass`: SwiftUI menu/setup window, Keychain settings, sleep and handoff coordination.
- `MultipassCore`: connection-edge and source eligibility policy.
- `MultipassNetwork`: Bonjour and authenticated, revocable TCP requests.
- `MultipassHardware`: read-only device enumeration and serialized HID++ writes.

These boundaries allow a future Raycast extension to control the native app without trying to host a persistent daemon inside Raycast's command lifecycle. No Raycast extension is included yet.

## Verification

```sh
swift test
```

Tests cover connection edges, invalid source state, stale generations, malformed/tampered/replayed authentication, request expiry/revocation, real loopback TCP exchanges, and HID++ response matching. Tests do not switch physical devices or change pairing secrets.

The development session separately verified keyboard departure/return and a one-time C HID++ mouse switch from desktop slot 1 to laptop slot 2, confirmed by the user. The app's setup UI and local device enumeration are verified. The actual Swift HID discovery and host-info path completed in 245 ms, with the final switch explicitly cancelled for this read-only check. Full two-Mac automatic following, laptop device identity, permissions, wake behavior, and login launch still require the paired hardware test. Passing unit/loopback tests is not that test.
