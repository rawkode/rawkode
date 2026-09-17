# Documents and Today

## Ownership

- OAuth owns client registrations, connected accounts, encrypted tokens, and integration grants.
- Google owns its mirror and account sync coordinators. Today requests a bounded live expansion of events from discovered calendars, so recurrence and moved instances are not guessed from stored series.
- Documents is a separate Worker with its own D1. It stores owner/key-scoped Loro snapshot envelopes, revision numbers, idempotency keys, and extension descriptors. It neither renders extensions nor imports the website.
- The website owns presentation, the TipTap/Loro binding, trusted extension implementations, local recovery, and derived diagram previews.

`packages/documents` defines the service contract. `Documents.forOwner()` is a trusted service-binding entrypoint; it is not exposed on the public Worker. Website middleware authenticates the owner and enforces same-origin writes before proxying RPC. The default public Documents handler exposes only health.

## Persistence and concurrency

Daily documents use `day/YYYY-MM-DD`, scoped to the authenticated owner and the browser's local date. Opening an empty day does not create a server record. Edits save a local IndexedDB recovery branch before a serialized compare-and-swap server write. Each browser tab has a separate recovery branch, restored when that tab reloads. Export downloads a lossless Loro snapshot. Recovery branches are device-local; do not clear browser storage while changes remain unsynced.

The server validates the bounded envelope (1.5 MB binary snapshot maximum), format identifier, and extension descriptors. Snapshot bytes are opaque to this storage service; the editor preflights the Loro schema before attaching the permissive ProseMirror binding. This is not a server-side semantic validator or a real-time multi-user collaboration server. Stale revisions fail rather than overwrite another writer; the current UI retains the local branch and asks the user to export it. Automatic merging and a recovery-branch chooser are future work.

Day changes flush buffered ProseMirror input, freeze editing, and await saves. A failed server save blocks navigation and keeps the editor available. Browser-close warnings are best effort; no browser can guarantee a last-second asynchronous write after forced termination.

## Extension boundary

The original editor was adapted from [PR #33](https://github.com/rawkode/rawkode/pull/33), revision `aaca8f19ccbdf60aa63df12bf165acc9f1bc983a`. This web model uses schema version 4. Native v3 import/migration is not implemented.

Every extension block has an immutable block ID, stable extension ID, payload version, and source string. The existing `diagram` node name is retained as the generic atomic block envelope; it is not limited to diagrams. The envelope does not contain executable code or implementation URLs.

`website/src/editor/extensions/registry.ts` defines the adapter boundary:

1. `id` and `version` identify the payload contract, independent of the npm package version.
2. `validate(source)` validates the adapter's source before insertion/update.
3. `load()` lazily loads trusted code from the application build.
4. `mount(element, source)` returns a session with `read()` and `destroy()`.
5. `read()` returns source and an optional derived preview. Only source enters Loro; previews live in an owner-scoped browser cache and may be regenerated.

`defaults.ts` is the build-time composition root. Replace registrations there to swap implementations. Runtime registration/unregistration is supported for trusted bundled adapters. Missing adapter IDs or versions remain selectable opaque blocks, display an unavailable message, and round-trip without dropping content. They are not executed. Refresh node views after runtime changes by dispatching `document-extension-preview`. Arbitrary downloaded plugins are intentionally unsupported.

Changing the meaning of a payload requires a new extension version. Supply an explicit migration before rewriting existing source. New inline nodes/marks or core-schema changes require a new document codec/schema version; they are not safe runtime swaps. The service can retain unknown extension descriptors without installing their implementation.

D2 runs in the library's background Worker using locally bundled WASM. Excalidraw mounts only when opened; its fonts are copied from the installed package by `bun scripts/editor-assets.ts`. Embedded images/web content are disabled in this first adapter. Diagram-source and document-size limits are enforced. Large lazy diagram chunks still produce a Vite bundle warning.

## Presentation slots

`TodayLayout.astro` provides named `main` and `context` regions with real fallback content. Its typed configuration controls which default slots appear and their ordering. `today/slots.ts` validates uniqueness and requires a document surface. Default components are document, agenda, people, and weather. Customization UI is explicitly marked forthcoming; focus mode works now.

Today uses the browser timezone and a DST-safe local midnight-to-midnight window. The agenda is bounded to three connections, ten calendars each, and 100 occurrences per calendar; truncation/failures are shown as partial. People are presentation-level email matches, not canonical Person entities. Email context reads only From/To/Cc metadata from at most five messages in one authorized mailbox; no messages are mirrored. Weather has an honest unconfigured state until location preferences exist.

## Local verification

Run `bun run dev` for website, OAuth, Google, and Documents at ports 4321, 8787, 8788, and 8789, plus the mock provider at 8790. Migrations and local font assets prepare automatically. Connect the Google Workspace fixture and start Google sync in the admin to populate calendars.

- `bun test`: persistence isolation/idempotency/conflicts, unknown extension preservation, slots, and existing integration security tests.
- `bun run check`: TypeScript and Astro validation.
- `bun run build`: website build and Worker dry runs, no deployment.
- `bun run test:e2e`: integration browser acceptance.
- `bun scripts/today-e2e.ts`: real local Documents/website editor acceptance, desktop/mobile, diagrams, export, and concurrent-save conflict.

Stop the local stack before checks/builds to avoid invalidating the live Vite cache. Real Google consent, Pub/Sub delivery, production CSP/runtime behavior, production storage provisioning, and independent adversarial review require separate acceptance.
