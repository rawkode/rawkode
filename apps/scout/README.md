# Scout

Scout is a keyboard-first, sandboxed file manager for macOS 27. It combines persistent Miller columns, native list and icon views, a Quick Look inspector, Spotlight search, and a centered command palette.

## Requirements

- macOS 27
- Xcode 27 at `/Applications/Xcode.app`
- XcodeGen 2.46 or newer
- An Apple Development identity for the `P4X-639 Ltd` team when verifying App Sandbox behavior

## Build and run

```sh
./script/build_and_run.sh
```

The script regenerates `Scout.xcodeproj`, builds into `.build/DerivedData`, and launches the fresh app. It also supports `--debug`, `--logs`, `--telemetry`, and `--verify`.

For compile-only diagnosis when signing is unavailable:

```sh
SCOUT_UNSIGNED=1 ./script/build_and_run.sh
```

Unsigned execution cannot verify App Sandbox or security-scoped bookmark behavior.

## Access model

Scout starts with no filesystem access. The first-run screen recommends granting the Home folder through the system folder picker. Every additional folder or mounted volume is granted separately and restored through an app-scoped security bookmark.

Scout never requests Full Disk Access, runs terminal commands, connects to servers, uploads file content, or builds a private content index.

## Tests

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project Scout.xcodeproj -scheme Scout \
  -destination 'platform=macOS' test
```
