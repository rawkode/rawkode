# Multipass

Let an EVO80 keyboard lead an MX Master 4 between macOS, Windows, and Linux computers. Change the keyboard's Bluetooth slot; the computer receiving the keyboard asks its paired peer to send the mouse to the corresponding slot.

The shared Rust engine owns device detection, Bonjour discovery, in-band pairing, authenticated switch requests, credentials, connection policy, and HID++ switching. Native UIs display its state and send commands through private stdin/stdout pipes:

| Platform | Native frontend | Credential storage |
| --- | --- | --- |
| macOS 14+ | SwiftUI menu bar and setup window | Keychain |
| Windows 10/11 | .NET 8 WinForms window and system tray | Windows Credential Manager |
| Linux desktop | GTK4 through distro PyGObject | Secret Service (GNOME Keyring or compatible provider) |

No webviews or browser runtime are used. The engine is a child of its frontend. Closing/quitting the frontend stops it; on Windows, closing the window hides it to the tray, and **Quit** stops it. On Linux keep the window open or minimized. Only one engine may run per user/configuration directory. Setting `MULTIPASS_CONFIG_DIR` runs a separate instance with its own settings and its own pairing key in the credential store, so test or side-by-side engines never prompt for the real installation's key.

## Build and run

Install a current stable Rust toolchain. Dependencies are locked in `Cargo.lock`.

### macOS

Install Xcode or its command line tools, then:

```sh
cd apps/multipass
./script/build_and_run.sh
```

The script builds the engine and SwiftUI frontend, bundles both in `dist/Multipass.app`, signs them for local development, and launches the app. The Codex Run action calls this script. `--build` packages without launching; `--verify` runs Rust tests and checks launch; `--debug` and `--logs` support diagnostics.

Set `MULTIPASS_SIGNING_IDENTITY` to a configured identity for a stable development signature. The default ad-hoc app is not notarized, and macOS keys Input Monitoring, Local Network and keychain access to the code signature: after every ad-hoc rebuild those grants silently stop matching while System Settings still shows them enabled. Turn Multipass off and on again under Input Monitoring after such a rebuild, or sign with a stable identity. Enabling switching now probes the mouse and reports in the activity log when the OS blocks access. Distribution beyond development needs normal signing/notarization. Do not run the app as root.

### Windows

Install Rust's MSVC toolchain, Visual Studio C++ build tools, and the .NET 8 SDK. See [Windows build and package instructions](platforms/windows/README.md). The native frontend and `multipass-engine.exe` must stay together in the same directory.

### Linux

Install the native runtime and build dependencies. For Debian/Ubuntu:

```sh
sudo apt install python3-gi gir1.2-gtk-4.0 libudev-dev pkg-config libdbus-1-dev
python3 platforms/linux/install.py
```

This installs the GTK app and engine under `~/.local`. Use an unlocked Secret Service provider for pairing. See [Linux setup](platforms/linux/README.md) and [scoped mouse permissions](crates/multipass-hardware/docs/linux-permissions.md). The app does not install system rules or fall back to storing secrets in plaintext.

### Nix

The app flake packages the Rust engine and native frontend together. From the repository root:

```sh
nix build ./apps/multipass
nix run ./apps/multipass
```

On macOS, the result contains `Applications/Multipass.app` with its bundled engine and an ad-hoc bundle signature. Nix supplies Swift, SwiftPM, and the Apple SDK; a separate Xcode installation is not needed to build this package. The `multipass` command opens the app. On Linux, it starts the native GTK4 frontend with its packaged Python, GI dependencies, and engine; a desktop launcher is included.

For a standalone engine build, use `nix build ./apps/multipass#engine`. The flake exposes `default`, `multipass`, and `engine` packages for `aarch64-darwin`, `aarch64-linux`, and `x86_64-linux`. Intel macOS is excluded because the pinned Nixpkgs release no longer supports it. `flake.lock` pins Nixpkgs, and Rust dependencies are vendored from the checksums in `Cargo.lock`; build outputs and Python caches are excluded from the source.

Installing the package does not enable automatic switching or create pairing credentials. Grant the normal platform permissions and pair your computers from the nearby list. Linux still requires a desktop session, an unlocked Secret Service provider, and appropriate HID permissions; installing the package on a headless machine does not start a background service. Nix builds do not run the hardware or multicast-network qualification tests.

## Pair your computers

1. Run the same version on both computers on the same local network; discovery and connections work over IPv4 or IPv6, including link-local IPv6 when a VPN or filter blocks IPv4 multicast. Allow local-network/firewall access for mDNS discovery and the engine's TCP listener if the OS asks. A VPN, client-isolated Wi-Fi, or firewall may block discovery or connections.
2. Set **Mouse slot** to the mouse's existing Bluetooth slot on each computer—for example, desktop **1**, laptop **2**. Multipass does not create Bluetooth pairings.
3. Each app lists the other computers running Multipass that it can see. Click **Pair…** next to the other computer on either one. Both screens show the same six-digit code; check they match, then **Accept** on the computer that was asked and **Confirm** on the one that asked. Either side can decline, and the prompt times out after two minutes.
4. Enable automatic switching on both computers. Wait for discovery and three seconds of device-state settling.
5. Switch the keyboard away and back. Each fresh connection should request the matching mouse slot. Confirm the mouse actually works on the destination.

Discovery is only how the computers find each other; it proves nothing about who they are. Pairing runs an X25519 key agreement over the LAN connection, and the code you compare is a short authentication string derived from both sides' keys. The initiator commits to its key before the responder reveals its own, so an attacker in the middle cannot search for a key that makes both screens agree. The resulting 32-byte secret is stored in the platform credential store and authorizes every later mouse-switch request; it never crosses the network. Only one pairing prompt is shown at a time, and nothing is stored until both people confirm. **Forget pairing** removes the key.

The Mac UI can open Input Monitoring settings and register itself as a login item. Windows offers a tray menu. Linux has an explicit close-to-quit window lifetime; no cross-desktop tray or autostart installation is included.

The Rust protocol is **version 3**, and intentionally rejects the earlier copied-code versions. Upgrade both computers together and pair again. Settings live in an OS application config directory: reselect this computer's slot and enable switching after upgrading.

## Switching safeguards

- Detection targets Bluetooth EVO80 `36B0:3004` and MX Master 4 `046D:B042`. Other models are not configurable yet. Read-only device metadata is inspected; keyboard input reports are never captured.
- Device presence is polled every 100 ms, and only a fresh absent-to-present keyboard edge that stays present for 300 ms produces a claim. Unknown device state invalidates pending work. Startup, settings changes, enable, and resume establish a baseline for three seconds.
- The source requires its keyboard absent, mouse present, and a different valid target slot. Immediately before one ChangeHost write, it repeats the keyboard-presence check and verifies the authorization lease.
- Each session uses a fresh random challenge and HMAC-SHA256 bound to sender, receiver, slot, and protocol version. A verified claim expires after three seconds; connection loss, keyboard departure, pause, or process shutdown revokes it. If the source still sees the keyboard when the claim arrives, it holds the claim and re-checks on every poll until the keyboard departs or the claim expires. Frames, sessions, peer fan-out, and connection counts are bounded.
- Observation and network propagation introduce a small unavoidable race; this is not an atomic transaction across hardware. Requests are never queued for offline peers, and uncertain switch writes are never retried.
- HID++ feature indices are discovered dynamically. Source acknowledgement and source departure are reported separately; neither proves destination connectivity. HID response waits are bounded, but the underlying OS write cannot be forcibly interrupted.
- Switch claims are authenticated; discovery metadata is untrusted. Neither is encrypted. Pairing secrets are derived on both computers and never sent over the network. Recent activity is held in memory; the app does not log keyboard input or credentials.

## Architecture and diagnostics

- `crates/multipass-core`: policy, persistence, process protocol, shared orchestration, `multipass-engine` binary.
- `crates/multipass-network`: mDNS/DNS-SD discovery, in-band pairing (X25519 with commitment and a six-digit comparison code), authenticated TCP, expiring/revocable leases.
- `crates/multipass-hardware`: native presence detection and HID++ control on all three operating systems.
- `Sources/Multipass`: native Mac UI and process adapter; no duplicated switching engine.
- `platforms/windows`, `platforms/linux`: native UIs, process adapters, and package scripts.

Run `cargo test --locked --workspace` and `cargo clippy --locked --workspace --all-targets -- -D warnings`. The repository workflow builds all three native packages. GUI transport tests are under the platform directories.

`multipass-engine --probe` performs read-only mouse capability queries. `--stdio` runs the frontend protocol (bounded JSON lines); it stops when stdin closes or a shutdown command arrives. Discovery runs for the life of the engine so unpaired computers can find each other; switching stays off until paired and enabled. `MULTIPASS_CONFIG_DIR` optionally selects a configuration directory for diagnostics/tests; it never redirects OS credentials. Pairing keys are never accepted from the frontend or the command line.

## Qualification

The development Mac has verified the actual keyboard departure/return, a manually requested mouse switch, and the Rust read-only mouse probe. The original Swift-only setup UI was visually verified; the updated Rust-backed Mac frontend has built and launched, with visual inspection pending. Unit and process tests cover authorization, malformed commands, connection edges, shutdown, and mocked HID behavior. Local TCP tests verify authenticated delivery and lease revocation. The native GTK smoke test rendered state from the real Rust engine and confirmed window closure stops its child under a headless Linux desktop. The Windows native frontend cross-build and self-contained x64 publish passed; its UI has not run on Windows hardware.

Full two-computer automatic following remains a hardware qualification step on each platform. Windows and Linux compile/package or headless UI checks do not prove Bluetooth access, credential-store integration, sleep/resume, or real device handoff. The explicit LAN discovery/handoff test is not part of default CI because it needs a multicast-enabled LAN; run it with `cargo test -p multipass-network mdns_discovery_and_authenticated_handoff -- --ignored --nocapture` in the qualification environment. The explicit Bonjour-to-TCP test passed in the Linux container. On the development Mac, discovery succeeded but LAN-address TCP loopback did not accept connections, a condition independently reproduced outside Multipass. Neither same-host test proves a physical two-computer handoff.
