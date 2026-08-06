// @enchiridion/supertags-canvas — the CanvasPage supertag module.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan §Core
// Product UI (P7), track 5: "Native drawing canvas embedded in pages ...
// a new supertag for canvas pages, canvas content stored as a
// content-addressed blob via the existing `EnchiridionBlobs`/R2 path (same
// scheme as images), and an embed/attachment mechanism so a canvas can be
// referenced from within a page's body text."
//
// NEW MODULE, NOT `supertags/core` — justification (task brief: "your
// call, justify whichever"): `supertags/core`'s own header scopes itself
// to an exact 1:1 port of the old app's 8 built-in supertags (person/
// organization/company/event/area/project/task/place) plus their relations
// — "canvas page" isn't one of those 8 and isn't a port of anything the
// old app had. `supertags/workouts` and `supertags/email` already
// established the precedent this follows: a genuinely new, self-contained
// feature area gets its own module (own namespace, own package, own
// `index.test.ts`) rather than growing `core`'s fixed 8-tag list. A canvas
// page also has zero relations to any `core` supertag (no
// entityReference field references `person`/`project`/etc.), so unlike
// `supertags/email` (which depends on `supertags-core` for `PERSON`),
// this module has no cross-module dependency at all.
//
// FIELD SHAPE — deliberately minimal (task brief: "minimal fields: title,
// maybe a thumbnail/dimensions hint — NOT the stroke data itself"):
//   - A canvas page's `title` is the page's own title (every page already
//     has one — `PageDocument`'s `title` text container), not a redundant
//     supertag field.
//   - `width`/`height` are a *layout hint* only — the size to lay out an
//     empty/loading canvas view at before its content blob has downloaded
//     (avoids a layout jump). They are NOT authoritative: the real,
//     current canvas size lives inside the serialized `CanvasDocument`
//     blob itself (`EnchiridionCanvas/CanvasDocument.swift`,
//     `CanvasDocument.canvasSize`) and callers should prefer that once the
//     blob has loaded. Kept as plain `number` fields (pixels), not a
//     compound type — this module's field vocabulary
//     (`packages/schema/src/index.ts`'s `f.*` helpers) has no
//     struct/compound field type, and two scalar numbers is simpler than
//     inventing one for a hint that's allowed to be stale.
//   - No `thumbnail` field in this pass: the only field type available
//     that could hold a blob reference is `f.text()` (a plain string), and
//     a thumbnail is itself blob-shaped content (a second content-addressed
//     image blob, same as the canvas content blob) — adding it now would
//     mean designing thumbnail generation (rasterizing the canvas to a
//     PNG/JPEG and uploading a SECOND blob per save) with no consumer yet
//     to justify that work. Deliberately deferred, not silently dropped —
//     see this module's `index.test.ts` header and the task's final report
//     for the explicit "what's deferred" note. Adding it later is a pure
//     additive-upgrade (`validateAdditiveUpgrade`,
//     `packages/schema/src/registry.ts`): a new optional field, no
//     existing field changes shape.
//   - No field on this supertag stores the canvas's stroke/shape content
//     itself, or even the current content `BlobID` — see this module's
//     `index.test.ts` for why (and `EnchiridionCanvas/CanvasPageAttachment
//     .swift`'s header for where that reference actually lives): a canvas
//     page's content blob is referenced via the SAME attachment-mark
//     mechanism a canvas embedded inline in another page's body uses
//     (`LoroEngine.MarkStyle.attachment`) — applied over the canvas page's
//     own (otherwise-empty) body text. One mechanism for both "this page
//     IS a canvas" and "this page HAS a canvas embedded partway through
//     it", not two.

import { defineSupertagModule, f, type SupertagModule } from "@enchiridion/schema";

const MODULE_ID = "dev.rawkode.enchiridion.canvas";

/** Fully-qualified supertag id for a key declared in this module's
 *  `supertags` — same derivation convention as `supertags/core`'s `tag()`
 *  helper. */
function tag(key: string): string {
  return `${MODULE_ID}.${key}`;
}

const CANVAS_PAGE = tag("canvasPage");

const supertags: SupertagModule["supertags"] = {
  canvasPage: {
    name: "Canvas",
    // SF Symbol — a real symbol name (verified against Apple's SF Symbols
    // 6 catalog, available at this package's iOS/macOS 26 deployment
    // target), matching the drawing/scribble affordance a canvas page
    // represents; distinct from `core.event`'s "calendar" or
    // `workouts.workout`'s "figure.run" so it reads unambiguously in a
    // page-kind picker.
    symbol: "scribble.variable",
    fields: {
      // Layout hint only — see this file's header for why these are not
      // authoritative and why there's no `thumbnail`/content-blob field.
      width: f.number({ name: "Width" }),
      height: f.number({ name: "Height" }),
    },
  },
};

export default defineSupertagModule({
  id: MODULE_ID,
  version: 1,
  supertags,
});

// Re-exported for tests and downstream consumers (the codegen script,
// `EnchiridionCanvas`'s Swift call sites) that want the qualified tag id
// without re-deriving it — same convention as `supertags/core`'s
// `CoreSupertagIDs` / `supertags/workouts`' `WorkoutsSupertagIDs`.
export const CanvasSupertagIDs = {
  canvasPage: CANVAS_PAGE,
} as const;
