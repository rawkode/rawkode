import { describe, expect, test } from "bun:test";
import { SupertagRegistry } from "@enchiridion/schema";
import workoutsModule, { WorkoutsSupertagIDs } from "./index";

describe("dev.rawkode.enchiridion.workouts — registry validation", () => {
  test("SupertagRegistry.build([workoutsModule]) succeeds with no validation errors", () => {
    expect(() => SupertagRegistry.build([workoutsModule])).not.toThrow();
  });

  test("declares exactly the workout supertag", () => {
    const registry = SupertagRegistry.build([workoutsModule]);
    const workoutsIds = registry
      .allSupertags()
      .map((s) => s.id)
      .filter((id) => id.startsWith(workoutsModule.id));
    expect(workoutsIds).toEqual([WorkoutsSupertagIDs.workout]);
  });

  test("declares no relations (v1 has no entityReference fields)", () => {
    const registry = SupertagRegistry.build([workoutsModule]);
    const workoutsRelations = registry.allRelations().filter((r) => r.id.startsWith(workoutsModule.id));
    expect(workoutsRelations).toHaveLength(0);
  });
});

describe("Workout field shape", () => {
  test("declares activity (select), duration-minutes, started-at, calories — no more, no less", () => {
    const registry = SupertagRegistry.build([workoutsModule]);
    const workout = registry.getSupertag(WorkoutsSupertagIDs.workout);
    expect(workout).toBeDefined();

    const fields = workout!.fields;
    expect(Object.keys(fields).sort()).toEqual(["activity", "calories", "duration-minutes", "started-at"].sort());

    expect(fields.activity?.type).toBe("select");
    expect(fields["duration-minutes"]?.type).toBe("number");
    expect(fields["started-at"]?.type).toBe("dateTime");
    expect(fields.calories?.type).toBe("number");
  });

  test("no field allows multiple values (a workout has exactly one of each)", () => {
    const registry = SupertagRegistry.build([workoutsModule]);
    const workout = registry.getSupertag(WorkoutsSupertagIDs.workout)!;
    for (const [key, definition] of Object.entries(workout.fields)) {
      expect(definition.allowsMultiple, `${key}.allowsMultiple`).toBeFalsy();
    }
  });

  test("no entityReference field exists on this module (v1 has no cross-page relations)", () => {
    const registry = SupertagRegistry.build([workoutsModule]);
    const workout = registry.getSupertag(WorkoutsSupertagIDs.workout)!;
    for (const [key, definition] of Object.entries(workout.fields)) {
      expect(definition.type, key).not.toBe("entityReference");
    }
  });
});

describe("activity — select field option ids (f.select()'s lowercase-hyphen slugification)", () => {
  test("declares exactly run/walk/cycle/swim/strength/other, in that order", () => {
    const registry = SupertagRegistry.build([workoutsModule]);
    const workout = registry.getSupertag(WorkoutsSupertagIDs.workout)!;
    const optionIds = workout.fields.activity?.options?.map((option) => option.id);
    expect(optionIds).toEqual(["run", "walk", "cycle", "swim", "strength", "other"]);
  });

  test("each option's display name matches its HealthKit-style label (Title Case)", () => {
    const registry = SupertagRegistry.build([workoutsModule]);
    const workout = registry.getSupertag(WorkoutsSupertagIDs.workout)!;
    const options = workout.fields.activity?.options ?? [];
    expect(options.map((option) => option.name)).toEqual(["Run", "Walk", "Cycle", "Swim", "Strength", "Other"]);
  });

  test("includes an 'other' fallback option (for HealthKit activity types outside the v1 subset)", () => {
    const registry = SupertagRegistry.build([workoutsModule]);
    const workout = registry.getSupertag(WorkoutsSupertagIDs.workout)!;
    const optionIds = workout.fields.activity?.options?.map((option) => option.id) ?? [];
    expect(optionIds).toContain("other");
  });
});
