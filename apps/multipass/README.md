# Multipass

Move a Bluetooth keyboard between paired macOS, Windows, or Linux computers and let the MX Master 4 follow it automatically.

The shared Rust engine owns device detection, Bonjour discovery, in-band pairing, authenticated switch requests, credentials, connection policy, and HID++ switching. Native UIs display its state and send commands through private stdin/stdout pipes:

| Platform | Native frontend | Credential storage |
| --- | --- | --- |
| macOS 14+ | SwiftUI menu bar and setup window | Keychain |
| Windows 10/11 | .NET 8 WinForms window and system tray | Windows Credential Manager |
| Linux desktop | GTK4 through distro PyGObject, with a StatusNotifier tray | Secret Service (GNOME Keyring or compatible provider) |

No webviews or browser runtime are used. The engine is a child of its frontend. Quitting the frontend stops it. On Linux and Windows, closing the window hides it to the tray, and **Quit** stops it. On Linux keep the window open or minimized. Only one engine may run per user/configuration directory. Setting `MULTIPASS_CONFIG_DIR` runs a separate instance with its own settings and its own pairing key in the credential store, so test or side-by-side engines never prompt for the real installation's key.

## Build and run

Install a current stable Rust toolchain. Dependencies are locked in `Cargo.lock`.

### macOS

Install Xcode or its command line tools, then:

```sh
cd apps/multipass
./script/build_and_run.sh
```

The script builds the engine and SwiftUI frontend and bundles both in `dist/Multipass.app`. On rawkOS, normal runs install and launch the signed copy in `~/Applications/Multipass.app`; `--build` only signs the development bundle. The Codex Run action calls this script. `--build` packages without launching; `--verify` runs Rust tests and checks launch; `--debug` and `--logs` support diagnostics.

The rawkOS `rawkos-sign-app` and `rawkos-install-app` tools use the same `rawkOS.darwin.codeSigning.identity` for activation, development, and Nix launches. On a Mac without these tools, set `MULTIPASS_SIGNING_IDENTITY` to a configured certificate; launch modes stop if no stable signer is available. Packaging-only CI can explicitly use `MULTIPASS_SIGNING_IDENTITY=- ./script/build_and_run.sh --build` to produce an ad-hoc artifact. An Apple-issued identity is recommended for reliable Local Network permission tracking. Changing the signing identity requires granting permissions once for the new identity; ordinary rebuilds retain it. The app requests Input Monitoring when switching is enabled and reports blocked mouse access in the activity log. Distribution beyond development needs normal signing/notarization. Do not run the app as root.

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

On macOS, the store result contains `Applications/Multipass.app` with its bundled engine and an ad-hoc bundle signature. `nix run` uses the activated rawkOS installer to sign a copy with the host identity and launch it from `~/Applications/Multipass.app`. Activate rawkOS before using this launch command; signing failure leaves the existing installation untouched. Nix supplies Swift, SwiftPM, and the Apple SDK, so a separate Xcode installation is not needed to build the package. On Linux, it starts the native GTK4 frontend with its packaged Python, GI dependencies, and engine; a desktop launcher is included.

For a standalone engine build, use `nix build ./apps/multipass#engine`. The flake exposes `default`, `multipass`, and `engine` packages for `aarch64-darwin`, `aarch64-linux`, and `x86_64-linux`. Intel macOS is excluded because the pinned Nixpkgs release no longer supports it. `flake.lock` pins Nixpkgs, and Rust dependencies are vendored from the checksums in `Cargo.lock`; build outputs and Python caches are excluded from the source.

Installing the package does not enable automatic switching or create pairing credentials. Grant the normal platform permissions and pair your computers from the nearby list. Linux still requires a desktop session, an unlocked Secret Service provider, and appropriate HID permissions; installing the package on a headless machine does not start a background service. Nix builds do not run the hardware or multicast-network qualification tests.

## Pair your computers

1. Run the same version on both computers on the same local network; discovery and connections work over IPv4 or IPv6, including link-local IPv6 when a VPN or filter blocks IPv4 multicast. Allow local-network/firewall access for mDNS discovery and the engine's TCP listener if the OS asks. A VPN, client-isolated Wi-Fi, or firewall may block discovery or connections.
2. Pair with the other computer from **Nearby computers**. Both screens show the same six-digit code. Confirm the matching code on both computers.
3. Confirm this computer’s **Mouse Bluetooth slot** on each computer. Connect the mouse to check or detect the slot. Use different slots for each computer.
4. Enable automatic switching on both computers. Wait for discovery and three seconds of device-state settling.
5. Switch a connected Bluetooth keyboard from the computer that has the mouse to the other computer. Confirm the mouse works on the destination.

Discovery is only how the computers find each other; it proves nothing about who they are. Pairing runs an X25519 key agreement over the LAN connection, and the code you compare is a short authentication string derived from both sides' keys. The initiator commits to its key before the responder reveals its own, so an attacker in the middle cannot search for a key that makes both screens agree. The resulting 32-byte secret is stored in the platform credential store and authorizes every later mouse-switch request; it never crosses the network. Only one pairing prompt is shown at a time, and nothing is stored until both people confirm. **Forget pairing** removes the key.

The Mac UI can open Input Monitoring settings and register itself as a login item. Linux and Windows offer a tray menu. On Linux, close the window to keep switching in the background. Open it again from the tray or application launcher, or use **Quit Multipass** to stop the engine.

The Rust protocol is **version 5**. Upgrade both computers together. Existing pairing keys and mouse slots are retained.

## Switching safeguards

- Multipass uses Bluetooth device metadata to match the keyboard across computers. A keyboard must expose the same Bluetooth identity on both hosts to be matched. Keyboards that use a different address per slot cannot be matched. Missing keyboard metadata can pause handoff until the OS reports a complete device state. The mouse must be an MX Master 4 (`046D:B042`). Keyboard input reports are never captured.
- A keyboard must leave the computer that has the mouse and settle on a paired computer before the mouse moves. Startup, settings changes, enabling switching, and resume establish a fresh baseline. Unknown device state or conflicting observations cancel pending handoffs.
- The source requires a recent departure of the matching keyboard, the mouse still connected, and a different valid target slot. Before sending ChangeHost once, it verifies the keyboard is still absent and the claim is still authorized.
- Each session uses a fresh random challenge and HMAC-SHA256 to authenticate the sender, receiver, slot, protocol version, and keyboard identifier. Claims expire after eight seconds. When a source matches a departure to an arrival, it sends an authenticated confirmation so both computers can display the keyboard move. Connection loss, keyboard departure from the destination, pause, or process shutdown revokes the claim. Frames, sessions, peer fan-out, and connection counts are bounded.
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
