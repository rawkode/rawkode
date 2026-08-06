# EnchiridionCanvas

P7 "Core Product UI" task, track 5 (plan §Core Product UI (P7)): a native
SwiftUI drawing canvas — freehand strokes + basic shapes (rectangle,
ellipse, line, arrow) + text labels + pan/zoom + undo/redo — embeddable in
a page. **User explicitly chose native SwiftUI over a WKWebView-embedded
Excalidraw** — this is real, from-scratch drawing-engine work, not a
wrapper.

Cross-platform by construction: PencilKit is iOS-only and this app targets
macOS too, so the renderer is built on SwiftUI's `Canvas`/`Path` + gesture
recognizers (`DragGesture`/`MagnificationGesture`/`SpatialTapGesture`), not
PencilKit. See `CanvasEditorViewModel.swift`'s and `CanvasEditorView
.swift`'s headers for the specific cross-platform input-model reasoning
(touch+Pencil on iOS, mouse+trackpad on macOS).

Built as a **self-contained, independently-testable module** — not wired
into `RootView.swift`/app navigation. A separate integration task does
that once several parallel P7 tracks land (this task's own brief, and the
plan's "Sequencing" note for P7).

## What's here

- `CanvasDocument.swift` — the stroke/shape serialization format
  (`CanvasDocument`/`CanvasElement`/...). Read this file's header for the
  full documented wire format. JSON, versioned (`format`/`schemaVersion`),
  `.sortedKeys`-encoded for deterministic bytes.
- `CanvasHistory.swift` — snapshot-based undo/redo over a
  `[CanvasElement]`. See its header for why whole-array snapshots, not
  per-op commands.
- `CanvasEditorViewModel.swift` — gesture-driven capture logic
  (begin/update/end stroke, tool switching, text commit), deliberately
  SwiftUI-free so it's directly unit-testable.
- `CanvasEditorView.swift` — the actual `Canvas`/`Path`-based drawing
  surface + toolbar + pan/zoom, wiring real gestures to the view model
  above.
- `CanvasBlobStore.swift` — uploads/downloads a `CanvasDocument` as a
  content-addressed blob through `EnchiridionBlobs.BlobCache` — the exact
  same mechanism images use (per `EnchiridionBlobs/README.md`), not a
  second one. Canvas content NEVER lives in supertag properties (see
  `supertags/canvas/src/index.ts`'s header: "wrong shape, potentially
  large").
- `CanvasPageAttachment.swift` — the embed/attachment mechanism
  connecting a canvas to a page's body text. Builds on a NEW general
  mechanism added to `EnchiridionSync`/`EnchiridionCore` as part of this
  task (`LoroEngine.MarkStyle.attachment` / `PageDocument
  .addAttachmentMark` / `PageAttachment`) — see this file's header for why
  "reuse the images mechanism" meant building the general one: no
  image-attachment mechanism exists anywhere in this package yet
  (confirmed by direct search; independently corroborated by
  `EnchiridionShareKit/README.md`'s "Image/attachment sharing is
  deliberately out of scope for v1, not half-implemented").

## Supertag

`supertags/canvas` (new module, `dev.rawkode.enchiridion.canvas`) declares
one supertag, `canvasPage` — `width`/`height` layout-hint fields only, no
content/blob field. See that module's `index.ts` header for the full
justification (new module vs. `supertags/core`) and why no thumbnail field
yet.

## What's deferred, not silently dropped

- **Thumbnail generation** — `supertags/canvas` has no thumbnail field and
  this module generates none. Would need rasterizing the canvas to a
  second image blob per save; no consumer needs it yet. Pure additive
  follow-up (new optional field + a render-to-image step here).
- **Select/move/resize an already-committed element** — `CanvasTool
  .select` exists as a placeholder case with no wired behavior. The
  task's v1 feature list (freehand + basic shapes + text + pan/zoom +
  undo/redo) never asked for post-hoc element manipulation, only creation
  + undo; flagged explicitly here rather than silently missing.
- **Inline rendering of a canvas embed inside `PageEditorView`'s running
  rich-text editor** — this task builds the data-model/CRDT half of the
  embed mechanism (`PageAttachment`, real round-trip tests against
  `PageDocument`), proven independent of any UI. Rendering a live
  thumbnail/tap-to-open affordance at an attachment's position inside
  `EnchiridionUI`'s actual editor view is real UI-integration work
  spanning `PageEditorBody.swift`/`PageEditorAttributes.swift` — left to
  the plan's stated later integration wave, consistent with "do NOT wire
  into RootView/app navigation" for this task.
- **Server-side GraphQL/registry wiring for `supertags/canvas`**
  (`workers/vault/src/supertag-registry.ts`/`graphql/composed-schema
  .ts`) — deliberately NOT touched, following the exact precedent
  `supertags/workouts` already established (a module can have real Swift
  codegen without server-side registry wiring yet; see
  `packages/codegen/scripts/generate.ts`'s comment on this module).

## Tests

`Tests/EnchiridionCanvasTests/`:
- `CanvasDocumentSerializationTests.swift` — golden encode/decode
  round-trips for every element kind, plus format/schema-version
  validation.
- `CanvasHistoryTests.swift` — undo/redo correctness: a sequence of
  operations, undo N times, redo M times, exact expected state asserted
  at every step.
- `CanvasEditorViewModelTests.swift` — the gesture-driven capture logic
  (drag sequences -> committed elements, degenerate-drag rejection, tool
  switching) exercised directly, without SwiftUI.
- `CanvasBlobStoreTests.swift` — real `EnchiridionBlobs.BlobCache`
  upload/download round-trip. "Real", per this codebase's established
  convention (`EnchiridionAPITests`): a `URLProtocol` stub intercepting
  the actual `URLSession` call (proving the real request/response wire
  format and the real `BlobCache` actor/LRU/checksum logic), not a mocked
  `BlobCache`.
- `CanvasPageAttachmentTests.swift` — embed-in-page attachment resolution:
  create a page with a canvas attachment via real `PageDocument` calls,
  round-trip its document bytes (simulating a reload), confirm the
  attachment still resolves to the right blob id/kind/range.
