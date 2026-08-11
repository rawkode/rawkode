// @enchiridion/supertags-workouts — the Workout supertag module.
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan §Platform
// parity (P6): "watchOS workout capture — new platform target + HealthKit
// workout session." This module exists to give the new watchOS app (and any
// future HealthKit ingest path) a real supertag to write completed workouts
// to — see `apps/swift/Sources/EnchiridionWatchKit/WorkoutCapture.swift`
// for the write-path consumer.
//
// TASK #79 UPDATE: this file used to be a P0 skeleton with `supertags: {}`
// and a TODO comment describing a 6-tag migration
// (workout/strength/cardio/exercise/set/split) ported wholesale from the old
// app's `apps/enchiridion/Sources/EnchiridionCore/WorkoutModule.swift`. That
// full port is deliberately NOT what this task does — task #79's brief is
// explicit: "minimal-but-real... don't over-scope." This module declares
// ONE supertag (`workout`) with the four fields a v1 HealthKit workout
// summary genuinely needs (activity type, duration, start time, calories),
// not the old app's full exercise/set/split hierarchy or its
// HealthKit-export-reconciliation bookkeeping fields
// (`healthkit-export-state`, `payload-hash`, `raw-activity`, ...) — those
// belong to a real ingest/sync task, not a first supertag declaration. The
// old app's full 6-tag field list (preserved below, in case a follow-up task
// ports the rest) remains the authoritative reference for that larger scope:
//
//   - workout   ("figure.run")   — started-at, completed-at,
//               duration-seconds, activity (select), raw-activity, status
//               (select), source, source-event-id, payload-hash,
//               healthkit-export-state (select), healthkit-export-error,
//               healthkit-workout-uuid, route-state (select),
//               energy-kilocalories, average-heart-rate, maximum-heart-rate
//   - strength  ("dumbbell", extends workout's common fields) —
//               exercise-count, set-count, total-volume-kilograms
//   - cardio    ("heart", extends common) — distance-meters,
//               elevation-meters, average-speed-meters-per-second,
//               average-pace-seconds-per-kilometre, split-count
//   - exercise  ("figure.strengthtraining.traditional") — ordinal,
//               set-count, volume-kilograms
//   - set       ("number") — ordinal, repetitions, load-kilograms,
//               volume-kilograms, rpe, completed-at
//   - split     ("timer") — ordinal, distance-meters, duration-seconds,
//               pace-seconds-per-kilometre, average-heart-rate,
//               energy-kilocalories
//
// ADDITIVE-UPGRADE NOTE: adding the rest of those tags/fields later is a
// pure additive upgrade under `validateAdditiveUpgrade`
// (packages/schema/src/registry.ts) — no existing field here needs to
// change type/removal for that follow-up to land.
//
// FIELD CHOICES for v1's `workout` supertag:
//   - `activity` (select) — a small, closed v1 subset of HealthKit's
//     `HKWorkoutActivityType` (which has 80+ cases): Run, Walk, Cycle, Swim,
//     Strength, Other. This covers the common cardio/strength cases a watch
//     workout-capture UI needs a picker for; anything HealthKit reports
//     outside this set maps to `.other` (see
//     `EnchiridionWatchKit/WorkoutCapture.swift`'s `HKWorkoutActivityType`
//     mapping) rather than adding an option per HealthKit case up front.
//   - `duration-minutes` (number) — minutes rather than the old app's
//     `duration-seconds`, since this is the field a v1 UI displays directly
//     (task #79 brief: "duration (number)"); precise seconds can be added
//     as a separate field in a future additive upgrade if a consumer needs
//     sub-minute precision.
//   - `started-at` (dateTime) — when the workout began.
//   - `calories` (number) — active energy in kilocalories, matching
//     HealthKit's `HKQuantityTypeIdentifier.activeEnergyBurned` unit;
//     optional in practice (a caller that doesn't have a calorie estimate
//     omits it via `PageDocument.setProperties` rather than writing 0).
//
// Field/relation shape follows the module contract established by
// `supertags/core` (see that package's `index.ts` header for conventions:
// `tag()`/qualified-id helper, select-field option ids derived by
// `f.select()`'s lowercase-hyphen slugification) and `supertags/email`
// (a similarly minimal, single-supertag module).

import { defineSupertagModule, f, type SupertagModule } from "@enchiridion/schema";

const MODULE_ID = "dev.rawkode.enchiridion.workouts";

/** Fully-qualified supertag id for a key declared in this module's
 *  `supertags` — same derivation convention as `supertags/core`'s `tag()`
 *  helper. */
function tag(key: string): string {
  return `${MODULE_ID}.${key}`;
}

const WORKOUT = tag("workout");

const supertags: SupertagModule["supertags"] = {
  workout: {
    name: "Workout",
    symbol: "figure.run",
    fields: {
      // v1 HKWorkoutActivityType subset — see this file's header for why
      // only these six, not HealthKit's full 80+-case enum.
      activity: f.select(["Run", "Walk", "Cycle", "Swim", "Strength", "Other"], { name: "Activity" }),
      "duration-minutes": f.number({ name: "Duration (minutes)" }),
      "started-at": f.dateTime({ name: "Started at" }),
      calories: f.number({ name: "Calories" }),
    },
  },
};

export default defineSupertagModule({
  id: MODULE_ID,
  version: 1,
  supertags,
});

// Re-exported for tests and downstream consumers (the watchOS workout
// capture write path, a future HealthKit ingest task) that want the
// qualified tag id without re-deriving it — same convention as
// `supertags/core`'s `CoreSupertagIDs` / `supertags/email`'s
// `EmailSupertagIDs`.
export const WorkoutsSupertagIDs = {
  workout: WORKOUT,
} as const;
