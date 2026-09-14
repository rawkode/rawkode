# Fieldnotes — SwiftUI with the shared web editor

A macOS spike hosting the existing Vue/Tiptap editor in `WKWebView`. This imports
`web-rich-editor/src/components/Fieldnotes.vue` and its styles directly: there is
no second component renderer or document conversion. The TextKit spike remains
separate.

## Run

```sh
./script/build_and_run.sh
```

Requires macOS 14+, Xcode, and Node/npm at build time. The script builds the web
assets with the companion's locked dependencies, compiles Swift, bundles assets
into `dist/FieldnotesWeb.app`, and ad-hoc signs it. `--build` skips launch;
`--verify` also checks the process. Quit the app before rebuilding to run new code.
No Node process or development server is needed at runtime.

The app runs a small Swift HTTP server bound to `127.0.0.1` on an ephemeral port.
It serves only public bundled assets, enabling normal module/worker/WASM loading.
Documents never pass through HTTP. External page navigation cannot replace the
editor; user-clicked external links open in the default browser. Embedded players
can load remote content, but their frames cannot call the native bridge.

## Persistence and files

The shared Zod schema validates drafts before sending versioned bridge messages.
Swift accepts messages only from the main editor frame at its exact origin and
writes the draft atomically before acknowledging a save. Tiptap owns selection,
editing state, and undo. Saves are serialized on the main thread; this is intended
for small spike documents, not high-throughput production editing.

The independent draft lives at:

`~/Library/Application Support/Rawkode Fieldnotes Web/draft.json`

Set `FIELDNOTES_WEB_DATA_DIR` via `open --env` to use an isolated directory. The
file is `{ "filename": "Example.native-note", "note": <Tiptap document> }`.
Invalid drafts block autosave and remain untouched; back up the file before
explicitly replacing it. Open note uses the native file picker, then the shared
validation/replacement flow. Export note uses `NSSavePanel` to write portable
document JSON. Browser and native drafts remain independent, with no live sync.

## Limits

- D2 currently fails during Go/WASM startup in this machine's WKWebView with
  `Maximum call stack size exceeded`. Mermaid renders successfully. A shared
  build transform exposes startup failures instead of reporting false readiness;
  it does not fix the underlying WebKit compatibility issue.
- New link-metadata discovery returns an explicit unavailable error: Astro's
  server endpoint is not bundled. Existing imported metadata/previews are usable;
  remote images and playback still require network access.
- One window and one draft. No file coordination, multi-document support,
  release signing, App Sandbox configuration, or crash recovery journal.
- Closing before a save acknowledgement can lose the most recent edit. Native
  validation checks the envelope and size; full schema validation stays in the
  shared JavaScript code. This is not a production trust boundary.
- iOS packaging, touch/IME behavior, comprehensive accessibility, and long-document
  performance are not established by this macOS spike.

See the companion README for supported editing and portable-format features.

## Observed verification

On this Mac, the signed bundle launched without the Astro server, restored the
seeded draft, rendered Mermaid and the shared link card, acknowledged a native
autosave, restored a removed component through Cmd-Z, and loaded that saved state
after quitting and reopening. Both the shared web build and Swift bundle build
passed; the shared TypeScript checks and 54 tests passed.

D2 failed with the startup error described above. Open/export dialogs appeared,
but the automated session could not complete selection/save (the confirmation
buttons remained disabled); file round-trip completion is not verified. Playback,
IME, and accessibility beyond the observed editor accessibility tree were not
tested. These gaps remain before adopting this as the replacement editor.
