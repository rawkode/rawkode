import { describe, expect, test } from "bun:test";
import { effectiveFields, effectiveTagIDs, propertyKeyToString, type QualifiedSupertagDefinition } from "./inheritance";

function tag(
  id: string,
  fields: QualifiedSupertagDefinition["fields"],
  parents: string[] = [],
): QualifiedSupertagDefinition {
  return { id, name: id, symbol: "circle", fields, parents };
}

describe("effectiveFields — port of SupertagInheritance.effectiveFields", () => {
  test("resolves parents before the child, retaining each field's owning schema", () => {
    const person = tag("person", {
      email: { type: "email" },
      role: { type: "text" },
    });
    const employee = tag(
      "employee",
      { email: { type: "email" }, employeeID: { type: "text" } },
      ["person"],
    );

    const fields = effectiveFields("employee", [person, employee]);

    expect(fields.map((f) => f.propertyKey)).toEqual([
      { supertagID: "person", fieldID: "email" },
      { supertagID: "person", fieldID: "role" },
      { supertagID: "employee", fieldID: "email" },
      { supertagID: "employee", fieldID: "employeeID" },
    ]);
    // person.email and employee.email coexist as distinct property keys —
    // field identity is the full (tagID, fieldID) pair (plan §Supertag
    // module contract; GraphOntology.swift:3-6).
    expect(fields[0]).not.toEqual(fields[2]);
  });

  test("diamond inheritance visits each ancestor schema once", () => {
    // event
    //  / \
    // a   b
    //  \ /
    // workout
    const event = tag("event", { start: { type: "dateTime" } });
    const a = tag("a", { aOnly: { type: "text" } }, ["event"]);
    const b = tag("b", { bOnly: { type: "text" } }, ["event"]);
    const workout = tag("workout", { duration: { type: "number" } }, ["a", "b"]);

    const fields = effectiveFields("workout", [event, a, b, workout]);

    // "event" (and its "start" field) must appear exactly once, even though
    // it's reachable through both "a" and "b".
    const eventFieldOccurrences = fields.filter((f) => f.propertyKey.supertagID === "event");
    expect(eventFieldOccurrences).toHaveLength(1);
    expect(fields.map((f) => propertyKeyToString(f.propertyKey))).toEqual([
      "event:start",
      "a:aOnly",
      "b:bOnly",
      "workout:duration",
    ]);
  });

  test("terminates on a cycle without duplicating fields, resolution stays cycle-tolerant", () => {
    const first = tag("first", { a: { type: "text" } }, ["second"]);
    const second = tag("second", { b: { type: "text" } }, ["first"]);

    const fields = effectiveFields("first", [first, second]);

    expect(fields.map((f) => propertyKeyToString(f.propertyKey))).toEqual(["second:b", "first:a"]);
  });

  test("skips references to unknown/unloaded parent tags", () => {
    const child = tag("child", { c: { type: "text" } }, ["ghost"]);
    const fields = effectiveFields("child", [child]);
    expect(fields.map((f) => propertyKeyToString(f.propertyKey))).toEqual(["child:c"]);
  });

  test("cross-module inheritance: a tag's parent can be owned by a different module's namespace", () => {
    const coreEvent = tag("dev.rawkode.enchiridion.core.event", { start: { type: "dateTime" } });
    const workout = tag(
      "dev.rawkode.workouts.workout",
      { duration: { type: "number" } },
      ["dev.rawkode.enchiridion.core.event"],
    );

    const fields = effectiveFields("dev.rawkode.workouts.workout", [coreEvent, workout]);
    expect(fields.map((f) => propertyKeyToString(f.propertyKey))).toEqual([
      "dev.rawkode.enchiridion.core.event:start",
      "dev.rawkode.workouts.workout:duration",
    ]);
  });
});

describe("effectiveTagIDs — port of SupertagInheritance.effectiveTagIDs", () => {
  test("includes the full ancestor closure", () => {
    const grandparent = tag("grandparent", {});
    const parent = tag("parent", {}, ["grandparent"]);
    const child = tag("child", {}, ["parent"]);

    const ids = effectiveTagIDs(["child"], [grandparent, parent, child]);
    expect(ids).toEqual(new Set(["child", "parent", "grandparent"]));
  });

  test("terminates and includes every tag in a mutual-parent cycle (matches Swift's tolerant behavior)", () => {
    const first = tag("first", {}, ["second"]);
    const second = tag("second", {}, ["first"]);

    const ids = effectiveTagIDs(["first"], [first, second]);
    expect(ids).toEqual(new Set(["first", "second"]));
  });

  test("accepts multiple direct tag ids and unions their closures", () => {
    const area = tag("area", {});
    const project = tag("project", {}, ["area"]);
    const task = tag("task", {});

    const ids = effectiveTagIDs(["project", "task"], [area, project, task]);
    expect(ids).toEqual(new Set(["project", "task", "area"]));
  });
});
