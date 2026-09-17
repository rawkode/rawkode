# Architecture

Tauri owns a single native window, menus, tray, settings, and atomic file writes.
Tiptap owns one continuous ProseMirror editing surface. The official
`loro-prosemirror` binding maps its document tree into Loro maps, lists, and text
containers. A serialized JSON document is not the collaborative storage format.

## Format and migration

Schema3 Loro snapshots have two roots: `metadata` and `doc`. Metadata includes the
civil day, schema version, editor schema version, and pinned binding identifier.
The `doc` root uses the official binding's nested node/container representation.
Before mounting the binding, the frontend validates the complete schema and
marks because the upstream reader can omit unknown nodes. Rust independently
validates snapshot import, size, day, and format metadata before persistence.

Legacy Swift schemas1/2 are read only from the original app container. Supported
native font/style marks are translated explicitly; unknown styles fail closed.
The first actual edit saves a new-format document in Tauri's own data directory,
preceded by a byte-for-byte legacy backup. Browsing performs no migration writes.
The original Swift file is never replaced.

## Save ownership

One process-level file lock and one main window prevent independent writers.
`load_day` grants a token for a day. The frontend holds a serialized, coalescing
save queue with a monotonically increasing sequence and native base revision.
`save_day` rejects stale leases, versions, and sequence reuse. Acknowledgements
arrive only after atomic disk writes; failed snapshots stay owned by both the
frontend queue and native lease. Navigation and quit must flush before releasing
the current editor. The transition first flushes ProseMirror's pending native DOM
input, then freezes editing, drains Loro notifications, and awaits the save queue.
Active IME composition blocks the transition without redrawing the editor. Quit
and day navigation cannot run concurrently. No periodic timer or background autosave polling is used.

## Diagrams

A diagram is an atomic block with stable id, kind, and editable source. Custom
node views render cached PNGs and open a lazy editor. Excalidraw source includes
its embedded image files. D2 uses the pinned0.9.0 engine with TALA. Exports are
bounded, cancelable while preparing, and checked against the original block
source before replacement. Native PNG caches are keyed by source+renderer hash.

Excalidraw's scene is currently one source attribute, not semantically merged
shape operations. No remote collaboration or transport is configured. D2's
WebKit adapter needs local JavaScript evaluation; CSP prohibits remote scripts,
frames, and connections. The lazy D2 runtime is reused rather than allocated on
every dialog opening, so memory after using diagrams can exceed a fresh launch.

## Platform scope

Desktop app configuration is present and macOS is the runtime verification
platform. Tauri iOS uses the same editor and Rust storage with native build
configuration. There is no watchOS target. OS API integrations can be added as
Rust commands or platform-specific Swift bridges without changing the editor.
