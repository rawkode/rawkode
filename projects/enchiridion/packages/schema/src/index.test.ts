import { describe, expect, test } from "bun:test";
import { defineSupertagModule, f, sql } from "./index";

describe("f — field builder helpers", () => {
  test("each builder stamps the right discriminant type and passes options through", () => {
    expect(f.text({ isMultiline: true })).toEqual({ type: "text", isMultiline: true });
    expect(f.number({ isRequired: true })).toEqual({ type: "number", isRequired: true });
    expect(f.boolean()).toEqual({ type: "boolean" });
    expect(f.date()).toEqual({ type: "date" });
    expect(f.dateTime()).toEqual({ type: "dateTime" });
    expect(f.url()).toEqual({ type: "url" });
    expect(f.email({ allowsMultiple: true })).toEqual({ type: "email", allowsMultiple: true });
    expect(f.phone()).toEqual({ type: "phone" });
  });

  test("f.select() turns a plain string list into id/name options, slugifying ids like Swift's BuiltInSupertags.selectField", () => {
    expect(f.select(["Push", "Pull", "Legs"])).toEqual({
      type: "select",
      options: [
        { id: "push", name: "Push" },
        { id: "pull", name: "Pull" },
        { id: "legs", name: "Legs" },
      ],
    });
  });

  test("f.select() lowercases and hyphenates multi-word names, matching Swift's lowercased().replacingOccurrences(of: \" \", with: \"-\")", () => {
    expect(f.select(["On Hold"])).toEqual({
      type: "select",
      options: [{ id: "on-hold", name: "On Hold" }],
    });
  });

  test("f.entityReference() carries the allowed supertag ids", () => {
    expect(f.entityReference(["person", "organization"], { allowsMultiple: true })).toEqual({
      type: "entityReference",
      allowedSupertagIDs: ["person", "organization"],
      allowsMultiple: true,
    });
  });
});

describe("sql — tagged template helper", () => {
  test("interpolates values into a plain string", () => {
    const table = "graph_nodes";
    expect(sql`SELECT * FROM ${table} WHERE kind = 'workout'`).toBe(
      "SELECT * FROM graph_nodes WHERE kind = 'workout'",
    );
  });
});

describe("defineSupertagModule — the plan's module contract example", () => {
  test("accepts a module shaped like the plan's §Supertag module contract example", () => {
    const module = defineSupertagModule({
      id: "dev.rawkode.workouts",
      version: 3,
      supertags: {
        workout: {
          name: "Workout",
          symbol: "figure.run",
          parents: ["dev.rawkode.enchiridion.core.event"],
          fields: { duration: f.number(), split: f.select(["Push", "Pull", "Legs"]) },
        },
      },
      projections: {
        graph_workouts_v1: { version: 2, sql: sql`SELECT * FROM graph_nodes WHERE kind = 'workout'` },
      },
    });
    expect(module.id).toBe("dev.rawkode.workouts");
  });
});
