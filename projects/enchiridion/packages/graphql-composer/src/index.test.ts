// @enchiridion/graphql-composer — composing the real `supertags/core`
// module end-to-end: SDL shape assertions (task brief's required
// assertions: Company inherits Organization's fields, Task.parent is
// correctly self-referencing, task.project/project.owner resolve to real
// typed relation fields, select fields produce real GraphQL enums with
// correctly-slugified option values) plus real query execution against a
// `FakeAccessors` in-memory graph, including a batching assertion for
// plan Risk #11.

import { describe, expect, test } from "bun:test";
import { graphql, printSchema } from "graphql";
import { propertyKeyToString, SupertagRegistry } from "@enchiridion/schema";
import coreModule, { CoreSupertagIDs } from "@enchiridion/supertags-core";
import { composePothosConfig } from "./index";
import { FakeAccessors, type FakeEdge, type FakeNode } from "./test-helpers/fake-accessors";

const registry = SupertagRegistry.build([coreModule]);
const config = composePothosConfig([coreModule]);
const sdl = printSchema(config.schema);

const { person: PERSON, organization: ORGANIZATION, company: COMPANY, project: PROJECT, task: TASK, area: AREA } =
  CoreSupertagIDs;

function fact(supertagID: string, fieldID: string): string {
  return propertyKeyToString({ supertagID, fieldID });
}

describe("composePothosConfig(supertags/core) — generated SDL shape", () => {
  test("Company's type includes both its own fields and Organization's inherited fields", () => {
    expect(sdl).toMatch(/type Company \{[^}]*registrationNumber: String[^}]*\}/s);
    expect(sdl).toMatch(/type Company \{[^}]*industry: String[^}]*\}/s);
    // Inherited from Organization:
    expect(sdl).toMatch(/type Company \{[^}]*website: String[^}]*\}/s);
    expect(sdl).toMatch(/type Company \{[^}]*domain: String[^}]*\}/s);
    expect(sdl).toMatch(/type Company \{[^}]*notes: String[^}]*\}/s);
  });

  test("Task's self-referencing parent field is correctly typed", () => {
    expect(sdl).toMatch(/type Task \{[^}]*parent: Task[^}]*\}/s);
    // The taskParent relation's inverse ("subtasks") is a list backlink.
    expect(sdl).toMatch(/type Task \{[^}]*subtasks: \[Task!\]!/s);
  });

  test("task.project and project.owner resolve to real typed relation fields, not scalars", () => {
    expect(sdl).toMatch(/type Task \{[^}]*project: Project[^}]*\}/s);
    // GraphQL field name follows the FIELD id ("owner"), not the relation's
    // display `forwardName` ("owners") — consistent with every other field
    // (scalar names also come from the field id, never a relation name).
    expect(sdl).toMatch(/type Project \{[^}]*owner: \[Person!\]!/s);
    // And their inverses:
    expect(sdl).toMatch(/type Project \{[^}]*tasks: \[Task!\]!/s);
    expect(sdl).toMatch(/type Person \{[^}]*ownedProjects: \[Project!\]!/s);
  });

  test("select fields produce real GraphQL enums, named per owning type + field, with slugified values", () => {
    expect(sdl).toMatch(/enum TaskStatus \{/);
    expect(sdl).toMatch(/enum TaskPriority \{/);
    expect(sdl).toMatch(/enum TaskPlacement \{/);
    expect(sdl).toMatch(/enum TaskScheduleGranularity \{/);
    expect(sdl).toMatch(/enum AreaStatus \{/);
    expect(sdl).toMatch(/enum ProjectStatus \{/);
    expect(sdl).toMatch(/enum OrganizationRelationship \{/);

    // TaskStatus's options: ["To do", "In progress", "Blocked", "Done", "Cancelled"]
    // -> f.select() slugifies to ids "to-do", "in-progress", ... -> enum
    // value names are the SCREAMING_SNAKE form of those slugs.
    expect(sdl).toMatch(/enum TaskStatus \{[^}]*TO_DO[^}]*\}/s);
    expect(sdl).toMatch(/enum TaskStatus \{[^}]*IN_PROGRESS[^}]*\}/s);
    expect(sdl).toMatch(/enum TaskStatus \{[^}]*CANCELLED[^}]*\}/s);
    expect(sdl).toMatch(/enum TaskScheduleGranularity \{[^}]*DATE_TIME[^}]*\}/s);
  });

  test("root Query has singular + pluralized (people, not persons) fields per supertag", () => {
    // Pothos's schema printer sorts both types and each field's arguments
    // lexicographically (`cursor` before `limit`), regardless of the
    // declaration order this package builds them in — assert on the
    // argument NAMES/types being present, not a specific order.
    expect(sdl).toMatch(/person\(id: String!\): Person/);
    expect(sdl).toMatch(/people\(cursor: String, limit: Int\): PersonConnection!/);
    expect(sdl).toMatch(/task\(id: String!\): Task/);
    expect(sdl).toMatch(/tasks\(cursor: String, limit: Int\): TaskConnection!/);
    expect(sdl).toMatch(/company\(id: String!\): Company/);
    expect(sdl).toMatch(/companies\(cursor: String, limit: Int\): CompanyConnection!/);
  });

  test("date/dateTime and number fields use Float, matching Page.createdAt's convention", () => {
    expect(sdl).toMatch(/type Event \{[^}]*start: Float[^}]*\}/s);
    expect(sdl).toMatch(/type Task \{[^}]*estimatedMinutes: Float[^}]*\}/s);
  });

  test("multi-valued scalar fields are non-null lists of non-null items", () => {
    expect(sdl).toMatch(/type Person \{[^}]*email: \[String!\]!/s);
    expect(sdl).toMatch(/type Event \{[^}]*attendees: \[Person!\]!/s);
  });
});

// ---------------------------------------------------------------------
// Real query execution against an in-memory `FakeAccessors` graph.
// ---------------------------------------------------------------------

const relationIDs = {
  personOrganization: registry.relationIDForProperty({ supertagID: PERSON, fieldID: "organization" }),
  projectOwners: registry.relationIDForProperty({ supertagID: PROJECT, fieldID: "owner" }),
  taskProject: registry.relationIDForProperty({ supertagID: TASK, fieldID: "project" }),
  taskParent: registry.relationIDForProperty({ supertagID: TASK, fieldID: "parent" }),
  taskAssignees: registry.relationIDForProperty({ supertagID: TASK, fieldID: "assignee" }),
  projectArea: registry.relationIDForProperty({ supertagID: PROJECT, fieldID: "area" }),
};

function seedGraph(): FakeAccessors {
  const nodes: FakeNode[] = [
    {
      id: "org_acme",
      tagIDs: [ORGANIZATION],
      createdAt: 1,
      modifiedAt: 1,
      facts: {
        [fact(ORGANIZATION, "website")]: "https://acme.example",
        [fact(ORGANIZATION, "relationship")]: "active",
      },
    },
    {
      id: "company_widgets",
      tagIDs: [COMPANY],
      createdAt: 1,
      modifiedAt: 1,
      facts: {
        [fact(ORGANIZATION, "website")]: "https://widgets.example",
        [fact(COMPANY, "registration-number")]: "12345",
        [fact(COMPANY, "industry")]: "Manufacturing",
      },
    },
    {
      id: "person_ada",
      tagIDs: [PERSON],
      createdAt: 1,
      modifiedAt: 1,
      facts: { [fact(PERSON, "email")]: ["ada@example.com"], [fact(PERSON, "role")]: "Engineer" },
    },
    {
      id: "person_grace",
      tagIDs: [PERSON],
      createdAt: 1,
      modifiedAt: 1,
      facts: { [fact(PERSON, "email")]: ["grace@example.com"] },
    },
    {
      id: "area_home",
      tagIDs: [AREA],
      createdAt: 1,
      modifiedAt: 1,
      facts: { [fact(AREA, "status")]: "active" },
    },
    {
      id: "project_launch",
      tagIDs: [PROJECT],
      createdAt: 1,
      modifiedAt: 1,
      facts: { [fact(PROJECT, "status")]: "active", [fact(PROJECT, "outcome")]: "Ship v1" },
    },
    {
      id: "task_root",
      tagIDs: [TASK],
      createdAt: 1,
      modifiedAt: 1,
      facts: { [fact(TASK, "status")]: "in-progress", [fact(TASK, "priority")]: "high" },
    },
    {
      id: "task_sub",
      tagIDs: [TASK],
      createdAt: 1,
      modifiedAt: 1,
      facts: { [fact(TASK, "status")]: "to-do" },
    },
  ];

  const edges: FakeEdge[] = [
    { relationID: relationIDs.personOrganization, sourceNodeID: "person_ada", targetNodeID: "org_acme" },
    { relationID: relationIDs.personOrganization, sourceNodeID: "person_grace", targetNodeID: "org_acme" },
    { relationID: relationIDs.projectArea, sourceNodeID: "project_launch", targetNodeID: "area_home" },
    { relationID: relationIDs.projectOwners, sourceNodeID: "project_launch", targetNodeID: "person_ada" },
    { relationID: relationIDs.projectOwners, sourceNodeID: "project_launch", targetNodeID: "person_grace" },
    { relationID: relationIDs.taskProject, sourceNodeID: "task_root", targetNodeID: "project_launch" },
    { relationID: relationIDs.taskProject, sourceNodeID: "task_sub", targetNodeID: "project_launch" },
    { relationID: relationIDs.taskParent, sourceNodeID: "task_sub", targetNodeID: "task_root" },
    { relationID: relationIDs.taskAssignees, sourceNodeID: "task_root", targetNodeID: "person_ada" },
  ];

  return new FakeAccessors(nodes, edges);
}

describe("composePothosConfig(supertags/core) — query execution", () => {
  test("Company resolves both its own and Organization's inherited fields", async () => {
    const accessors = seedGraph();
    const result = await graphql({
      schema: config.schema,
      source: `query { company(id: "company_widgets") { id website registrationNumber industry } }`,
      contextValue: { vault: accessors },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      company: {
        id: "company_widgets",
        website: "https://widgets.example",
        registrationNumber: "12345",
        industry: "Manufacturing",
      },
    });
  });

  test("Task.parent / Task.subtasks resolve the self-referencing relation correctly", async () => {
    const accessors = seedGraph();
    const result = await graphql({
      schema: config.schema,
      source: `
        query {
          parent: task(id: "task_sub") { id parent { id } }
          root: task(id: "task_root") { id subtasks { id } }
        }
      `,
      contextValue: { vault: accessors },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      parent: { id: "task_sub", parent: { id: "task_root" } },
      root: { id: "task_root", subtasks: [{ id: "task_sub" }] },
    });
  });

  test("task.project and project.owner traverse real canonical edges, both directions", async () => {
    const accessors = seedGraph();
    const result = await graphql({
      schema: config.schema,
      source: `
        query {
          task(id: "task_root") {
            project { id owner { id } }
          }
          person(id: "person_ada") {
            ownedProjects { id }
          }
          project(id: "project_launch") {
            tasks { id }
          }
        }
      `,
      contextValue: { vault: accessors },
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as Record<string, unknown>;
    expect(data.task).toEqual({
      project: {
        id: "project_launch",
        owner: expect.arrayContaining([{ id: "person_ada" }, { id: "person_grace" }]),
      },
    });
    expect(data.person).toEqual({ ownedProjects: [{ id: "project_launch" }] });
    expect(data.project).toEqual({
      tasks: expect.arrayContaining([{ id: "task_root" }, { id: "task_sub" }]),
    });
  });

  test("select fields serialize as their GraphQL enum member, round-tripping the stored slug", async () => {
    const accessors = seedGraph();
    const result = await graphql({
      schema: config.schema,
      source: `query { task(id: "task_root") { status priority } }`,
      contextValue: { vault: accessors },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ task: { status: "IN_PROGRESS", priority: "HIGH" } });
  });

  test("batches relation resolution across sibling nodes into one accessor call each (plan Risk #11)", async () => {
    const accessors = seedGraph();
    const result = await graphql({
      schema: config.schema,
      source: `
        query {
          people {
            items { id organization { id website } }
          }
        }
      `,
      contextValue: { vault: accessors },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      people: {
        items: expect.arrayContaining([
          { id: "person_ada", organization: { id: "org_acme", website: "https://acme.example" } },
          { id: "person_grace", organization: { id: "org_acme", website: "https://acme.example" } },
        ]),
      },
    });

    // Two people, each resolving `organization` — without batching this
    // would be 2 calls to getRelationTargets and 2 to getNodesWithFacts.
    expect(accessors.callCounts.listNodesByTag).toBe(1);
    expect(accessors.callCounts.getRelationTargets).toBe(1);
    expect(accessors.callCounts.getNodesWithFacts).toBe(1);
  });

  test("an id with no matching node resolves to null, not an error", async () => {
    const accessors = seedGraph();
    const result = await graphql({
      schema: config.schema,
      source: `query { task(id: "does-not-exist") { id } }`,
      contextValue: { vault: accessors },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ task: null });
  });
});
