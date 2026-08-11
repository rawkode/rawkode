// @enchiridion/projection — tests against real Loro docs and the real
// `supertags/core` module (per this task's brief: "Write comprehensive
// tests using supertags/core's real module as fixtures").

import { describe, expect, test } from "bun:test";
import { SupertagRegistry } from "@enchiridion/schema";
import coreModule, { CoreSupertagIDs } from "@enchiridion/supertags-core";
import { detectGraphIssues, type GraphIssueNodeInfo } from "./issues";
import { projectNodeTags, projectTagCatalog } from "./tags";
import { projectRelationDefinitions } from "./edges";
import { projectPage } from "./index";
import {
  addEdge,
  addTag,
  createFixtureDoc,
  exportSnapshot,
  markBody,
  markPageReference,
  reopenFixtureDoc,
  setBody,
  setDeletedAt,
  setPersonClassification,
  setPinned,
  setPropertyValues,
  setTitle,
} from "./test-support";

const registry = SupertagRegistry.single(coreModule);

function projectFixture(
  pageID: string,
  doc: ReturnType<typeof createFixtureDoc>,
  overrides: Partial<Parameters<typeof projectPage>[0]> = {},
) {
  return projectPage({
    pageID,
    docBytes: exportSnapshot(doc),
    registry,
    kind: "page",
    catalogCreatedAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_001_000,
    ...overrides,
  });
}

describe("projectPage — graph_nodes", () => {
  test("extracts title, plain text, isPinned; kind/createdAt/modifiedAt come from the caller, not the doc", () => {
    const doc = createFixtureDoc("page_1");
    setTitle(doc, "My Page");
    setBody(doc, "Hello world");
    setPinned(doc, true);

    const projected = projectFixture("page_1", doc, { kind: "daily", catalogCreatedAt: 42, modifiedAt: 99 });

    expect(projected.node).toEqual({
      nodeID: "page_1",
      title: "My Page",
      plainText: "Hello world",
      kind: "daily",
      createdAt: 42,
      modifiedAt: 99,
      deletedAt: undefined,
      isPinned: true,
    });
  });

  test("deletedAt is parsed from the root container's ISO-8601 string, and suppresses the text-search row", () => {
    const doc = createFixtureDoc("page_2");
    setTitle(doc, "Gone");
    const deletedAt = new Date("2026-01-02T03:04:05.000Z");
    setDeletedAt(doc, deletedAt);

    const projected = projectFixture("page_2", doc);

    expect(projected.node.deletedAt).toBe(deletedAt.getTime());
    expect(projected.textSearch).toBeUndefined();
  });

  test("a live (non-deleted) page produces a graph_text_search row", () => {
    const doc = createFixtureDoc("page_3");
    setTitle(doc, "Alive");
    setBody(doc, "still here");

    const projected = projectFixture("page_3", doc);

    expect(projected.textSearch).toEqual({ nodeID: "page_3", title: "Alive", body: "still here" });
  });
});

describe("projectPage — privacy gate: objectMetadata.personVisibility/personOrigin", () => {
  test("a page with no objectMetadata classification set projects personVisibility/personOrigin as undefined", () => {
    const doc = createFixtureDoc("page_normal");
    setTitle(doc, "An Ordinary Page");

    const projected = projectFixture("page_normal", doc);

    expect(projected.node.personVisibility).toBeUndefined();
    expect(projected.node.personOrigin).toBeUndefined();
  });

  test("a calendar-attendee-derived Person page's objectMetadata classification is extracted verbatim", () => {
    const doc = createFixtureDoc("person_attendee");
    setTitle(doc, "attendee@example.com");
    setPersonClassification(doc, "other", "calendarAttendee");

    const projected = projectFixture("person_attendee", doc);

    expect(projected.node.personVisibility).toBe("other");
    expect(projected.node.personOrigin).toBe("calendarAttendee");
  });

  test("a promoted Person page's classification is extracted too — extraction doesn't hardcode the 'other' value", () => {
    const doc = createFixtureDoc("person_promoted");
    setTitle(doc, "A Promoted Contact");
    setPersonClassification(doc, "promoted", "calendarAttendee");

    const projected = projectFixture("person_promoted", doc);

    expect(projected.node.personVisibility).toBe("promoted");
  });
});

describe("projectPage — body text delta: formatting marks + page references", () => {
  test("extracts formatting-mark runs and page-reference marks from the body delta", () => {
    const doc = createFixtureDoc("page_4");
    setBody(doc, "Hello brave world");
    // "brave" = offsets 6..11
    markBody(doc, 6, 11, "bold");
    // "world" = offsets 12..17, referencing another page
    markPageReference(doc, 12, 17, "page_target", "World Page");

    const projected = projectFixture("page_4", doc);

    expect(projected.node.plainText).toBe("Hello brave world");
    expect(projected.formattingMarks).toEqual([{ style: "bold", range: { start: 6, end: 11 } }]);
    expect(projected.references).toEqual([
      { sourcePageID: "page_4", targetPageID: "page_target", fallbackLabel: "World Page" },
    ]);
  });
});

describe("projectPage — graph_edges: task -> project relation", () => {
  test("a task's project edge projects as the canonical forward edge with the right relation id", () => {
    const doc = createFixtureDoc("task_1");
    addTag(doc, CoreSupertagIDs.task);
    addEdge(doc, registry, {
      edgeID: "edge_task1_project",
      key: { supertagID: CoreSupertagIDs.task, fieldID: "project" },
      sourceNodeID: "task_1",
      targetNodeID: "project_1",
    });

    const projected = projectFixture("task_1", doc);

    expect(projected.edges).toHaveLength(1);
    const edge = projected.edges[0]!;
    expect(edge.sourceNodeID).toBe("task_1");
    expect(edge.targetNodeID).toBe("project_1");
    expect(edge.origin).toBe("user");
    // Resolved via registry.relationIDForProperty at write time (buildEdgeEntry) —
    // supertags/core declares this pairing explicitly (taskProject), so it must
    // NOT fall back to the synthetic `property-relation:...` id.
    const expectedRelationID = registry.relationIDForProperty({
      supertagID: CoreSupertagIDs.task,
      fieldID: "project",
    });
    expect(edge.relationID).toBe(expectedRelationID);
    expect(edge.relationID).not.toContain("property-relation:");
    expect(edge.relationID).toBe("dev.rawkode.enchiridion.core.taskProject");
  });
});

describe("projectPage — graph_facts: inherited fields (Company page)", () => {
  test("includes Company's own fields AND Organization's inherited fields via effectiveFields", () => {
    const doc = createFixtureDoc("company_1");
    addTag(doc, CoreSupertagIDs.company);
    // Company's own field.
    setPropertyValues(
      doc,
      { supertagID: CoreSupertagIDs.company, fieldID: "registration-number" },
      [{ type: "text", value: "12345678" }],
    );
    // Organization's inherited field, stored under Organization's own key —
    // matches effectiveFields' "field ownership stays the schema that
    // declared it" rule (packages/schema/src/inheritance.ts).
    setPropertyValues(
      doc,
      { supertagID: CoreSupertagIDs.organization, fieldID: "website" },
      [{ type: "url", value: "https://example.com" }],
    );

    const projected = projectFixture("company_1", doc);

    const byField = new Map(projected.facts.map((fact) => [`${fact.tagID}:${fact.fieldID}`, fact]));
    const ownField = byField.get(`${CoreSupertagIDs.company}:registration-number`);
    expect(ownField).toBeDefined();
    expect(ownField?.valueType).toBe("text");
    expect(ownField?.textValue).toBe("12345678");

    const inheritedField = byField.get(`${CoreSupertagIDs.organization}:website`);
    expect(inheritedField).toBeDefined();
    expect(inheritedField?.valueType).toBe("url");
    expect(inheritedField?.textValue).toBe("https://example.com");

    expect(projected.facts).toHaveLength(2);
  });

  test("drops a values-container key that isn't in the page's effective field set", () => {
    const doc = createFixtureDoc("company_2");
    addTag(doc, CoreSupertagIDs.company);
    // Not a Company/Organization field at all — e.g. left over from a
    // removed tag, or a foreign write. Must be dropped, not crash.
    setPropertyValues(doc, { supertagID: CoreSupertagIDs.person, fieldID: "role" }, [
      { type: "text", value: "should not appear" },
    ]);

    const projected = projectFixture("company_2", doc);
    expect(projected.facts).toHaveLength(0);
  });
});

describe("projectTagCatalog + projectNodeTags — inheritance closure", () => {
  test("company's closure includes itself (depth 0) and organization (depth 1); company is a direct tag on the node", () => {
    const catalog = projectTagCatalog(registry);

    const companyClosure = catalog.tagClosure.filter((row) => row.descendantTagID === CoreSupertagIDs.company);
    expect(companyClosure).toContainEqual({
      descendantTagID: CoreSupertagIDs.company,
      ancestorTagID: CoreSupertagIDs.company,
      depth: 0,
    });
    expect(companyClosure).toContainEqual({
      descendantTagID: CoreSupertagIDs.company,
      ancestorTagID: CoreSupertagIDs.organization,
      depth: 1,
    });

    expect(catalog.tagParents).toContainEqual({
      tagID: CoreSupertagIDs.company,
      parentTagID: CoreSupertagIDs.organization,
    });

    const nodeTags = projectNodeTags("company_1", [CoreSupertagIDs.company], catalog.tagClosure);
    expect(nodeTags).toEqual([
      { nodeID: "company_1", tagID: CoreSupertagIDs.company, depth: 0, direct: true },
      { nodeID: "company_1", tagID: CoreSupertagIDs.organization, depth: 1, direct: false },
    ]);
  });

  test("a project page's node tags carry only its own direct closure (project has no parents)", () => {
    const catalog = projectTagCatalog(registry);
    const nodeTags = projectNodeTags("project_1", [CoreSupertagIDs.project], catalog.tagClosure);
    expect(nodeTags).toEqual([{ nodeID: "project_1", tagID: CoreSupertagIDs.project, depth: 0, direct: true }]);
  });

  test("projectPage's own nodeTags output matches projectNodeTags computed separately", () => {
    const doc = createFixtureDoc("company_3");
    addTag(doc, CoreSupertagIDs.company);
    const projected = projectFixture("company_3", doc);
    const catalog = projectTagCatalog(registry);
    expect(projected.nodeTags).toEqual(projectNodeTags("company_3", [CoreSupertagIDs.company], catalog.tagClosure));
  });
});

describe("projectRelationDefinitions", () => {
  test("projects every relation declared by the loaded registry", () => {
    const rows = projectRelationDefinitions(registry);
    const taskProject = rows.find((row) => row.relationID === "dev.rawkode.enchiridion.core.taskProject");
    expect(taskProject).toEqual({
      relationID: "dev.rawkode.enchiridion.core.taskProject",
      forwardName: "project",
      inverseName: "tasks",
      targetsPerSource: "one",
      sourcesPerTarget: "many",
      isSystem: false,
    });
  });
});

describe("edge-level conflict: two replicas concurrently write a max-one-relation edge, merged via real Loro CRDT merge", () => {
  test("both concurrent task->project edges survive the merge as distinct rows, and detectGraphIssues flags a cardinalityViolation for each — never a silent overwrite", () => {
    // Shared base state both replicas start from.
    const base = createFixtureDoc("task_conflict");
    addTag(base, CoreSupertagIDs.task);
    const baseBytes = exportSnapshot(base);

    // Replica A: assigns task_conflict -> project_a.
    const replicaA = reopenFixtureDoc(baseBytes);
    addEdge(replicaA, registry, {
      edgeID: "edge_a",
      key: { supertagID: CoreSupertagIDs.task, fieldID: "project" },
      sourceNodeID: "task_conflict",
      targetNodeID: "project_a",
    });

    // Replica B: independently, concurrently assigns task_conflict -> project_b.
    const replicaB = reopenFixtureDoc(baseBytes);
    addEdge(replicaB, registry, {
      edgeID: "edge_b",
      key: { supertagID: CoreSupertagIDs.task, fieldID: "project" },
      sourceNodeID: "task_conflict",
      targetNodeID: "project_b",
    });

    // Real Loro CRDT merge: import replica B's bytes into replica A.
    replicaA.import(exportSnapshot(replicaB));
    replicaA.commit();
    const mergedBytes = exportSnapshot(replicaA);

    const projected = projectFixture("task_conflict", reopenFixtureDoc(mergedBytes));

    // Both edges survive — keyed by distinct EdgeIDs in the `edges` LoroMap,
    // so this is not a same-key LWW race at all (GraphDataModel.md
    // evolution rule #4: "Preserve conflicting graph assertions through
    // merge").
    expect(projected.edges).toHaveLength(2);
    const targets = projected.edges.map((edge) => edge.targetNodeID).sort();
    expect(targets).toEqual(["project_a", "project_b"]);

    const relationID = registry.relationIDForProperty({ supertagID: CoreSupertagIDs.task, fieldID: "project" });
    const nodeInfo = new Map<string, GraphIssueNodeInfo>([
      ["task_conflict", { exists: true, effectiveTagIDs: new Set([CoreSupertagIDs.task]) }],
      ["project_a", { exists: true, effectiveTagIDs: new Set([CoreSupertagIDs.project]) }],
      ["project_b", { exists: true, effectiveTagIDs: new Set([CoreSupertagIDs.project]) }],
    ]);

    const issues = detectGraphIssues(projected.edges, nodeInfo, registry, 1_700_000_000_000);

    const cardinalityIssues = issues.filter((issue) => issue.kind === "cardinalityViolation");
    expect(cardinalityIssues).toHaveLength(2);
    expect(cardinalityIssues.every((issue) => issue.relationID === relationID)).toBe(true);
    expect(new Set(cardinalityIssues.map((issue) => issue.edgeID))).toEqual(new Set(["edge_a", "edge_b"]));
    // Resolution is explicit, not a merge-order silent winner: both edges'
    // issues are surfaced, matching GraphDataModel.md's "Resolution is
    // explicit; merge order must not silently choose a winner."
  });
});

describe("detectGraphIssues — unresolved target and invalid endpoint type", () => {
  test("an edge to a nonexistent node is flagged unresolvedTarget", () => {
    const doc = createFixtureDoc("task_2");
    addTag(doc, CoreSupertagIDs.task);
    addEdge(doc, registry, {
      edgeID: "edge_missing",
      key: { supertagID: CoreSupertagIDs.task, fieldID: "project" },
      sourceNodeID: "task_2",
      targetNodeID: "project_missing",
    });
    const projected = projectFixture("task_2", doc);

    const nodeInfo = new Map<string, GraphIssueNodeInfo>([
      ["task_2", { exists: true, effectiveTagIDs: new Set([CoreSupertagIDs.task]) }],
      // project_missing intentionally absent from nodeInfo.
    ]);
    const issues = detectGraphIssues(projected.edges, nodeInfo, registry, 0);
    expect(issues).toEqual([
      {
        issueID: "issue_unresolvedTarget:edge_missing",
        kind: "unresolvedTarget",
        nodeID: "task_2",
        edgeID: "edge_missing",
        relationID: registry.relationIDForProperty({ supertagID: CoreSupertagIDs.task, fieldID: "project" }),
        message: "The relationship target is unavailable.",
        createdAt: 0,
      },
    ]);
  });

  test("an edge whose target lacks the relation's allowed target tag is flagged invalidTargetType", () => {
    const doc = createFixtureDoc("task_3");
    addTag(doc, CoreSupertagIDs.task);
    addEdge(doc, registry, {
      edgeID: "edge_wrong_type",
      key: { supertagID: CoreSupertagIDs.task, fieldID: "project" },
      sourceNodeID: "task_3",
      targetNodeID: "not_a_project",
    });
    const projected = projectFixture("task_3", doc);

    const nodeInfo = new Map<string, GraphIssueNodeInfo>([
      ["task_3", { exists: true, effectiveTagIDs: new Set([CoreSupertagIDs.task]) }],
      // Wrong type: an Area, not a Project — taskProject's `to` is [PROJECT].
      ["not_a_project", { exists: true, effectiveTagIDs: new Set([CoreSupertagIDs.area]) }],
    ]);
    const issues = detectGraphIssues(projected.edges, nodeInfo, registry, 0);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("invalidTargetType");
    expect(issues[0]?.edgeID).toBe("edge_wrong_type");
  });
});
