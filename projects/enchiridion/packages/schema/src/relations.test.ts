import { describe, expect, test } from "bun:test";
import { propertyKeyForRelation, relationIDForProperty, type QualifiedRelationDefinition } from "./relations";

const taskProject: QualifiedRelationDefinition = {
  id: "dev.rawkode.enchiridion.core.task-project",
  from: ["task"],
  to: ["project"],
  forwardName: "project",
  inverseName: "tasks",
  cardinality: "manyToOne",
  property: { supertagID: "task", fieldID: "project" },
};

const mentions: QualifiedRelationDefinition = {
  id: "dev.rawkode.enchiridion.core.mentions",
  from: [],
  to: [],
  forwardName: "mentions",
  inverseName: "mentioned by",
  cardinality: "manyToMany",
  // No `property` — a pure graph relation with no backing scalar field,
  // matching Swift's BuiltInRelations.mentions.
};

const relations = [taskProject, mentions];

describe("relationIDForProperty — port of BuiltInRelations.relationID(for:)", () => {
  test("resolves a declared property -> relation pairing", () => {
    expect(relationIDForProperty({ supertagID: "task", fieldID: "project" }, relations)).toBe(taskProject.id);
  });

  test("falls back to the synthetic property-relation id for an undeclared pairing", () => {
    expect(relationIDForProperty({ supertagID: "task", fieldID: "assignee" }, relations)).toBe(
      "property-relation:task:assignee",
    );
  });
});

describe("propertyKeyForRelation — port of BuiltInRelations.propertyKey(for:)", () => {
  test("resolves a declared relation id back to its property key", () => {
    expect(propertyKeyForRelation(taskProject.id, relations)).toEqual({ supertagID: "task", fieldID: "project" });
  });

  test("parses a synthetic property-relation id back into its property key", () => {
    expect(propertyKeyForRelation("property-relation:task:assignee", relations)).toEqual({
      supertagID: "task",
      fieldID: "assignee",
    });
  });

  test("returns undefined for a relation with neither an explicit property nor the synthetic shape", () => {
    expect(propertyKeyForRelation(mentions.id, relations)).toBeUndefined();
    expect(propertyKeyForRelation("dev.rawkode.enchiridion.core.unknown", relations)).toBeUndefined();
  });

  test("round-trips through relationIDForProperty for every declared property pairing", () => {
    const key = { supertagID: "task", fieldID: "project" };
    const relationID = relationIDForProperty(key, relations);
    expect(propertyKeyForRelation(relationID, relations)).toEqual(key);
  });
});
