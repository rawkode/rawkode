# Enchiridion

A local-first daily notebook built with **Tauri v2, Tiptap, and Loro**.

## Run

Requires Node.js, Rust, and the platform's Tauri prerequisites (Xcode command-line
tools on macOS).

```sh
npm ci
npm run tauri -- dev
```

Build the desktop application:

```sh
npm run tauri -- build --bundles app
```

The iOS Xcode scaffold is in `src-tauri/gen/apple`. Install the Rust iOS
targets and Tauri mobile prerequisites, then use `npm run tauri -- ios dev`.
Device builds require your Apple development team. Tauri does not support watchOS.

## Writing

One continuous editor supports rich text, bulleted/numbered lists, checklists,
headings, quotes, code blocks, tables, links, and inline diagram components.
Return continues a list; Return on an empty list item exits it. Standard selection,
copy/paste, and Loro-backed undo work across paragraphs and lists.

Open commands with **⌘K** (Ctrl+K elsewhere). Search for an action or enter a date
as `YYYY-MM-DD`. Formatting controls appear beside selected text.

| Action | macOS shortcut |
| --- | --- |
| Commands | ⌘K |
| Today | ⇧⌘T |
| Previous / next day | ⌥⌘← / ⌥⌘→ |
| Bold / italic / underline | ⌘B / ⌘I / ⌘U |
| Strikethrough | ⇧⌘X |
| Undo / redo | ⌘Z / ⇧⌘Z |
| Settings | ⌘, |

Excalidraw drawings and D2/TALA diagrams open in a dedicated editing dialog.
Their editable source is part of the document; PNG previews are disposable local
cache files. Both runtimes and fonts are bundled; no CDN is required. D2's WebKit
adapter runs rendering in the document because of a worker stack limitation;
large diagrams can pause the editor while rendering.

The desktop menu bar item provides Open, Settings, and Quit. Settings persist the
user's display name and menu-bar visibility. Apple Calendar access is not
implemented; it remains possible through native Tauri commands.

## Data

Each local Gregorian day gets a Loro snapshot on its first content edit.
Browsing an empty day creates no note. Rust writes snapshots atomically and
acknowledges them before day navigation or quitting. Failed saves keep the latest
draft in memory and expose Retry; they cannot survive force termination.

New notes live in the Tauri app-data directory for `com.rawkode.enchiridion`,
under `DailyNotes/YYYY-MM-DD.loro`. On macOS, the app can read the previous Swift
app's sandboxed notes. It leaves those original files untouched and writes a
`.legacy.loro` backup in the new data directory before the first migrated save.
Unsupported data is rejected instead of silently flattened.

This is single-window local editing. Cross-device sync, attachments outside
Excalidraw, and full Apple Notes feature parity are not implemented.

## Verification

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

The macOS release build has been exercised for list editing, diagram editing,
day switching, and save/reopen across process restarts. iOS Rust compilation and
Xcode project discovery pass; signing and device execution remain unverified.
The original 60 MB memory target is not met: after using both diagram editors,
the main process and its web content process measured approximately 430 MB
combined physical footprint, excluding other WebKit helpers.

See [architecture](docs/architecture.md) for ownership and persistence details.
Generated web assets and Rust build outputs are not committed. `npm ci` prepares
local diagram fonts and notices; source licenses live in `public/licenses`.
