import { describe, expect, test } from "bun:test";
import { SupertagRegistry } from "@enchiridion/schema";
import coreModule, { CoreSupertagIDs } from "./index";

describe("dev.rawkode.enchiridion.core — registry validation", () => {
  test("SupertagRegistry.build([coreModule]) succeeds with no validation errors", () => {
    expect(() => SupertagRegistry.build([coreModule])).not.toThrow();
  });

  test("declares exactly the 8 core built-in supertags, no more, no less", () => {
    const registry = SupertagRegistry.build([coreModule]);
    const ids = registry.allSupertags().map((s) => s.id).sort();
    expect(ids).toEqual(
      [
        CoreSupertagIDs.person,
        CoreSupertagIDs.organization,
        CoreSupertagIDs.company,
        CoreSupertagIDs.event,
        CoreSupertagIDs.area,
        CoreSupertagIDs.project,
        CoreSupertagIDs.task,
        CoreSupertagIDs.place,
      ].sort(),
    );
    // Swift's 9th built-in, `bookmark`, is deliberately not ported into
    // this module — see index.ts's header comment.
    expect(ids.some((id) => id.endsWith(".bookmark"))).toBe(false);
  });

  test("declares exactly the 13 built-in relations from GraphOntology.swift's BuiltInRelations.all", () => {
    const registry = SupertagRegistry.build([coreModule]);
    expect(registry.allRelations()).toHaveLength(13);
  });
});

describe("company — diamond/inheritance correctness (parents: [organization])", () => {
  test("effectiveFields(company) includes both company's own fields and organization's inherited fields", () => {
    const registry = SupertagRegistry.build([coreModule]);
    const fields = registry.effectiveFields(CoreSupertagIDs.company);
    const keys = fields.map((f) => `${f.propertyKey.supertagID}:${f.propertyKey.fieldID}`);

    // Parents resolve before the child (matches SupertagInheritance.effectiveFields).
    expect(keys).toEqual([
      `${CoreSupertagIDs.organization}:website`,
      `${CoreSupertagIDs.organization}:domain`,
      `${CoreSupertagIDs.organization}:relationship`,
      `${CoreSupertagIDs.organization}:notes`,
      `${CoreSupertagIDs.company}:registration-number`,
      `${CoreSupertagIDs.company}:industry`,
    ]);
  });

  test("effectiveTagIDs(company) includes organization in the ancestor closure", () => {
    const registry = SupertagRegistry.build([coreModule]);
    const tagIDs = registry.effectiveTagIDs([CoreSupertagIDs.company]);
    expect(tagIDs).toEqual(new Set([CoreSupertagIDs.company, CoreSupertagIDs.organization]));
  });
});

describe("entityReference fields resolve to real declared relations, not the synthetic fallback", () => {
  // Every (supertagID, fieldID) pair below is every entityReference field
  // declared across the 8 core supertags, cross-checked against
  // GraphOntology.swift's BuiltInRelations.relationID(for:) switch: each of
  // its named cases (as opposed to its `default: property-relation:...`
  // fallback) corresponds to exactly one of these. None of them are left on
  // the synthetic fallback in this module.
  const referenceFields: Array<{ label: string; supertagID: string; fieldID: string }> = [
    { label: "person.organization", supertagID: CoreSupertagIDs.person, fieldID: "organization" },
    { label: "project.area", supertagID: CoreSupertagIDs.project, fieldID: "area" },
    { label: "project.owner", supertagID: CoreSupertagIDs.project, fieldID: "owner" },
    { label: "project.organization", supertagID: CoreSupertagIDs.project, fieldID: "organization" },
    { label: "project.place", supertagID: CoreSupertagIDs.project, fieldID: "place" },
    { label: "task.project", supertagID: CoreSupertagIDs.task, fieldID: "project" },
    { label: "task.area", supertagID: CoreSupertagIDs.task, fieldID: "area" },
    { label: "task.parent", supertagID: CoreSupertagIDs.task, fieldID: "parent" },
    { label: "task.assignee", supertagID: CoreSupertagIDs.task, fieldID: "assignee" },
    { label: "event.organizer", supertagID: CoreSupertagIDs.event, fieldID: "organizer" },
    { label: "event.attendees", supertagID: CoreSupertagIDs.event, fieldID: "attendees" },
    { label: "event.place", supertagID: CoreSupertagIDs.event, fieldID: "place" },
  ];

  for (const { label, supertagID, fieldID } of referenceFields) {
    test(`${label} resolves to a real declared relation`, () => {
      const registry = SupertagRegistry.build([coreModule]);
      const relationID = registry.relationIDForProperty({ supertagID, fieldID });
      expect(relationID.startsWith("property-relation:")).toBe(false);
      expect(relationID.startsWith(`${coreModule.id}.`)).toBe(true);
      // Round-trips back to the same property key.
      expect(registry.propertyKeyForRelation(relationID)).toEqual({ supertagID, fieldID });
    });
  }

  test("every entityReference field across all 8 supertags is accounted for above (none silently left on the fallback)", () => {
    const registry = SupertagRegistry.build([coreModule]);
    const entityReferenceFields = registry
      .allSupertags()
      .flatMap((s) =>
        Object.entries(s.fields)
          .filter(([, def]) => def.type === "entityReference")
          .map(([fieldID]) => ({ supertagID: s.id, fieldID })),
      );

    expect(entityReferenceFields).toHaveLength(referenceFields.length);
    for (const { supertagID, fieldID } of entityReferenceFields) {
      const relationID = registry.relationIDForProperty({ supertagID, fieldID });
      expect(relationID.startsWith("property-relation:")).toBe(false);
    }
  });

  test("the `mentions` relation deliberately has no backing entityReference field (open system relation, not a fallback case)", () => {
    const registry = SupertagRegistry.build([coreModule]);
    const mentions = registry.allRelations().find((r) => r.id === `${coreModule.id}.mentions`);
    expect(mentions).toBeDefined();
    expect(mentions?.property).toBeUndefined();
    expect(mentions?.from).toEqual([]);
    expect(mentions?.to).toEqual([]);
  });
});

describe("task.parent — self-referencing entityReference field", () => {
  test("allowedSupertagIDs on task.parent is task's own qualified id", () => {
    const registry = SupertagRegistry.build([coreModule]);
    const task = registry.getSupertag(CoreSupertagIDs.task);
    expect(task?.fields.parent?.allowedSupertagIDs).toEqual([CoreSupertagIDs.task]);
  });

  test("the taskParent relation has task as both its from and to endpoint", () => {
    const registry = SupertagRegistry.build([coreModule]);
    const taskParent = registry.allRelations().find((r) => r.id === `${coreModule.id}.taskParent`);
    expect(taskParent).toBeDefined();
    expect(taskParent?.from).toEqual([CoreSupertagIDs.task]);
    expect(taskParent?.to).toEqual([CoreSupertagIDs.task]);
    expect(taskParent?.cardinality).toBe("manyToOne");
  });

  test("task.parent resolves through relationIDForProperty/propertyKeyForRelation like any other entityReference field", () => {
    const registry = SupertagRegistry.build([coreModule]);
    const relationID = registry.relationIDForProperty({ supertagID: CoreSupertagIDs.task, fieldID: "parent" });
    expect(relationID).toBe(`${coreModule.id}.taskParent`);
    expect(registry.propertyKeyForRelation(relationID)).toEqual({
      supertagID: CoreSupertagIDs.task,
      fieldID: "parent",
    });
  });
});

describe("select field option ids — @enchiridion/schema's f.select() slugifies like Swift's lowercase-hyphen rule", () => {
  test("area.status options match Swift's BuiltInSupertags.selectField id derivation", () => {
    const registry = SupertagRegistry.build([coreModule]);
    const area = registry.getSupertag(CoreSupertagIDs.area);
    expect(area?.fields.status?.options).toEqual([
      { id: "active", name: "Active" },
      { id: "on-hold", name: "On Hold" },
      { id: "archived", name: "Archived" },
    ]);
  });

  test("task.status, task.placement, task.priority, task.schedule-granularity options are slugified", () => {
    const registry = SupertagRegistry.build([coreModule]);
    const task = registry.getSupertag(CoreSupertagIDs.task);
    expect(task?.fields.status?.options?.map((o) => o.id)).toEqual([
      "to-do",
      "in-progress",
      "blocked",
      "done",
      "cancelled",
    ]);
    expect(task?.fields.placement?.options?.map((o) => o.id)).toEqual(["inbox", "anytime", "someday"]);
    expect(task?.fields.priority?.options?.map((o) => o.id)).toEqual(["low", "medium", "high", "urgent"]);
    expect(task?.fields["schedule-granularity"]?.options?.map((o) => o.id)).toEqual(["date-only", "date-time"]);
  });
});
