import { describe, expect, test } from "bun:test";
import { CoreSupertagIDs } from "@enchiridion/supertags-core";
import { getNodeWithFacts, getNodesWithFacts, getRelationSources, getRelationTargets, listNodesByTag } from "./supertag-accessors";
import { initializeSchema } from "./schema";
import { installSupertagRegistryProjection } from "./registry-projection";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

const TASK_PROJECT_RELATION = "dev.rawkode.enchiridion.core.taskProject";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  installSupertagRegistryProjection(sql);
  return sql;
}

function insertNode(
  sql: SqliteStorageAdapter,
  id: string,
  fields: {
    title?: string;
    createdAt?: number;
    modifiedAt?: number;
    deletedAt?: number | null;
    personVisibility?: string | null;
    personOrigin?: string | null;
  } = {},
): void {
  sql.exec(
    `INSERT INTO graph_nodes (node_id, title, plain_text, kind, created_at, modified_at, deleted_at, person_visibility, person_origin)
     VALUES (?, ?, '', 'free', ?, ?, ?, ?, ?)`,
    id,
    fields.title ?? id,
    fields.createdAt ?? 1000,
    fields.modifiedAt ?? 1000,
    fields.deletedAt ?? null,
    fields.personVisibility ?? null,
    fields.personOrigin ?? null,
  );
}

function insertDirectTag(sql: SqliteStorageAdapter, nodeID: string, tagID: string): void {
  sql.exec(`INSERT INTO graph_node_tags (node_id, tag_id, depth, direct) VALUES (?, ?, 0, 1)`, nodeID, tagID);
}

function insertFact(
  sql: SqliteStorageAdapter,
  args: {
    nodeID: string;
    tagID: string;
    fieldID: string;
    valueIndex?: number;
    valueType: string;
    textValue?: string;
    numberValue?: number;
    booleanValue?: number;
  },
): void {
  sql.exec(
    `INSERT INTO graph_facts (fact_id, node_id, predicate_id, tag_id, field_id, value_index, value_type, text_value, number_value, boolean_value, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', 1000)`,
    `fact_${args.nodeID}:${args.tagID}:${args.fieldID}:${args.valueIndex ?? 0}`,
    args.nodeID,
    `property:${args.tagID}:${args.fieldID}`,
    args.tagID,
    args.fieldID,
    args.valueIndex ?? 0,
    args.valueType,
    args.textValue ?? null,
    args.numberValue ?? null,
    args.booleanValue ?? null,
  );
}

function insertEdge(sql: SqliteStorageAdapter, id: string, relationID: string, from: string, to: string): void {
  sql.exec(
    `INSERT INTO _graph_edges (edge_id, relation_id, source_node_id, target_node_id, origin, created_at)
     VALUES (?, ?, ?, ?, 'user', 1000)`,
    id,
    relationID,
    from,
    to,
  );
}

describe("getNodeWithFacts / getNodesWithFacts", () => {
  test("hydrates a node's direct tag ids and facts, keyed by propertyKeyToString", () => {
    const sql = makeSql();
    insertNode(sql, "task_1");
    insertDirectTag(sql, "task_1", CoreSupertagIDs.task);
    insertFact(sql, { nodeID: "task_1", tagID: CoreSupertagIDs.task, fieldID: "status", valueType: "select", textValue: "to-do" });

    const record = getNodeWithFacts(sql, "task_1");
    expect(record?.id).toBe("task_1");
    expect(record?.tagIDs).toEqual([CoreSupertagIDs.task]);
    expect(record?.facts[`${CoreSupertagIDs.task}:status`]).toBe("to-do");
  });

  test("returns undefined for an unknown or soft-deleted node", () => {
    const sql = makeSql();
    expect(getNodeWithFacts(sql, "does-not-exist")).toBeUndefined();

    insertNode(sql, "task_deleted", { deletedAt: 5000 });
    expect(getNodeWithFacts(sql, "task_deleted")).toBeUndefined();
  });

  test("a multi-valued field surfaces as an array, in valueIndex order", () => {
    const sql = makeSql();
    insertNode(sql, "person_1");
    insertDirectTag(sql, "person_1", CoreSupertagIDs.person);
    insertFact(sql, { nodeID: "person_1", tagID: CoreSupertagIDs.person, fieldID: "email", valueIndex: 1, valueType: "email", textValue: "second@example.com" });
    insertFact(sql, { nodeID: "person_1", tagID: CoreSupertagIDs.person, fieldID: "email", valueIndex: 0, valueType: "email", textValue: "first@example.com" });

    const record = getNodeWithFacts(sql, "person_1");
    expect(record?.facts[`${CoreSupertagIDs.person}:email`]).toEqual(["first@example.com", "second@example.com"]);
  });

  test("a single-valued field surfaces as a bare scalar, not a one-element array", () => {
    const sql = makeSql();
    insertNode(sql, "person_1");
    insertDirectTag(sql, "person_1", CoreSupertagIDs.person);
    insertFact(sql, { nodeID: "person_1", tagID: CoreSupertagIDs.person, fieldID: "role", valueType: "text", textValue: "Engineer" });

    const record = getNodeWithFacts(sql, "person_1");
    expect(record?.facts[`${CoreSupertagIDs.person}:role`]).toBe("Engineer");
  });

  test("getNodesWithFacts batches multiple ids in one call and omits unknown ids", () => {
    const sql = makeSql();
    insertNode(sql, "task_1");
    insertNode(sql, "task_2");
    const records = getNodesWithFacts(sql, ["task_1", "task_2", "does-not-exist"]);
    expect(records.map((r) => r.id).sort()).toEqual(["task_1", "task_2"]);
  });
});

describe("listNodesByTag", () => {
  test("lists only nodes carrying the tag DIRECTLY, not the effective/closure set", () => {
    const sql = makeSql();
    insertNode(sql, "company_1");
    insertDirectTag(sql, "company_1", CoreSupertagIDs.company);
    // company_1's effective tags include organization (inheritance), but it
    // was never DIRECTLY tagged organization — listNodesByTag(organization)
    // must not return it.
    const organizations = listNodesByTag(sql, CoreSupertagIDs.organization);
    expect(organizations.items).toEqual([]);

    const companies = listNodesByTag(sql, CoreSupertagIDs.company);
    expect(companies.items.map((i) => i.id)).toEqual(["company_1"]);
  });

  test("paginates via a node_id keyset cursor", () => {
    const sql = makeSql();
    for (const id of ["task_a", "task_b", "task_c"]) {
      insertNode(sql, id);
      insertDirectTag(sql, id, CoreSupertagIDs.task);
    }
    const page1 = listNodesByTag(sql, CoreSupertagIDs.task, { limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual(["task_a", "task_b"]);
    expect(page1.nextCursor).toBe("task_b");

    const page2 = listNodesByTag(sql, CoreSupertagIDs.task, { limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.items.map((i) => i.id)).toEqual(["task_c"]);
    expect(page2.nextCursor).toBeNull();
  });
});

// Privacy-gate filtering (P4 adversarial-review fix — plan §Gadgets:
// "graph.query ... must itself be personVisibility-aware"). See
// `supertag-accessors.ts`'s "PRIVACY-GATE FILTERING BOUNDARY" header
// addendum for the full trusted-path-vs-gadget-path rationale these tests
// prove out.
describe("privacy-gate filtering — excludePersonVisibility", () => {
  test("getNodeWithFacts: a person page with personVisibility \"other\" is excluded when the caller opts in", () => {
    const sql = makeSql();
    insertNode(sql, "person_attendee", { personVisibility: "other", personOrigin: "calendarAttendee" });
    insertDirectTag(sql, "person_attendee", CoreSupertagIDs.person);

    expect(getNodeWithFacts(sql, "person_attendee", { excludePersonVisibility: ["other"] })).toBeUndefined();
  });

  test("getNodeWithFacts: the SAME call WITHOUT the exclusion option still returns the page — proves the trusted device/GraphQL read path is unaffected", () => {
    const sql = makeSql();
    insertNode(sql, "person_attendee", { personVisibility: "other", personOrigin: "calendarAttendee" });
    insertDirectTag(sql, "person_attendee", CoreSupertagIDs.person);

    const record = getNodeWithFacts(sql, "person_attendee");
    expect(record?.id).toBe("person_attendee");
  });

  test("getNodeWithFacts: a person page with NO visibility metadata (the normal case) is unaffected either way", () => {
    const sql = makeSql();
    insertNode(sql, "person_manual"); // personVisibility/personOrigin both NULL — never set by materialization
    insertDirectTag(sql, "person_manual", CoreSupertagIDs.person);

    expect(getNodeWithFacts(sql, "person_manual")?.id).toBe("person_manual");
    expect(getNodeWithFacts(sql, "person_manual", { excludePersonVisibility: ["other"] })?.id).toBe("person_manual");
  });

  test("getNodeWithFacts: a promoted (\"promoted\") person page is NOT excluded by an [\"other\"]-only exclusion list", () => {
    const sql = makeSql();
    insertNode(sql, "person_promoted", { personVisibility: "promoted", personOrigin: "calendarAttendee" });
    insertDirectTag(sql, "person_promoted", CoreSupertagIDs.person);

    expect(getNodeWithFacts(sql, "person_promoted", { excludePersonVisibility: ["other"] })?.id).toBe("person_promoted");
  });

  test("getNodesWithFacts: excludes only the matching ids from a batched lookup, leaving the rest", () => {
    const sql = makeSql();
    insertNode(sql, "person_attendee", { personVisibility: "other", personOrigin: "calendarAttendee" });
    insertNode(sql, "person_manual");
    insertDirectTag(sql, "person_attendee", CoreSupertagIDs.person);
    insertDirectTag(sql, "person_manual", CoreSupertagIDs.person);

    const filtered = getNodesWithFacts(sql, ["person_attendee", "person_manual"], { excludePersonVisibility: ["other"] });
    expect(filtered.map((r) => r.id)).toEqual(["person_manual"]);

    const unfiltered = getNodesWithFacts(sql, ["person_attendee", "person_manual"]);
    expect(unfiltered.map((r) => r.id).sort()).toEqual(["person_attendee", "person_manual"]);
  });

  test("listNodesByTag: a gadget's nodesByTag(\"person\") call with excludePersonVisibility omits calendar-attendee-derived Person pages", () => {
    const sql = makeSql();
    insertNode(sql, "person_attendee", { personVisibility: "other", personOrigin: "calendarAttendee" });
    insertNode(sql, "person_manual");
    insertDirectTag(sql, "person_attendee", CoreSupertagIDs.person);
    insertDirectTag(sql, "person_manual", CoreSupertagIDs.person);

    const filtered = listNodesByTag(sql, CoreSupertagIDs.person, { excludePersonVisibility: ["other"] });
    expect(filtered.items.map((i) => i.id)).toEqual(["person_manual"]);
  });

  test("listNodesByTag: the SAME call WITHOUT the exclusion option still returns every person page — proves the trusted device/GraphQL read path is unaffected", () => {
    const sql = makeSql();
    insertNode(sql, "person_attendee", { personVisibility: "other", personOrigin: "calendarAttendee" });
    insertNode(sql, "person_manual");
    insertDirectTag(sql, "person_attendee", CoreSupertagIDs.person);
    insertDirectTag(sql, "person_manual", CoreSupertagIDs.person);

    const unfiltered = listNodesByTag(sql, CoreSupertagIDs.person);
    expect(unfiltered.items.map((i) => i.id).sort()).toEqual(["person_attendee", "person_manual"]);
  });

  test("listNodesByTag: exclusion is applied before LIMIT, so pagination (hasMore/nextCursor) stays correct across an excluded page's worth of nodes", () => {
    const sql = makeSql();
    // Two excluded "other"-visibility attendees sort before the two
    // visible ones — a naive post-filter (filter AFTER the SQL LIMIT)
    // would return an under-filled first page and falsely report no more
    // pages remain.
    insertNode(sql, "person_a_attendee", { personVisibility: "other", personOrigin: "calendarAttendee" });
    insertNode(sql, "person_b_attendee", { personVisibility: "other", personOrigin: "calendarAttendee" });
    insertNode(sql, "person_c_manual");
    insertNode(sql, "person_d_manual");
    for (const id of ["person_a_attendee", "person_b_attendee", "person_c_manual", "person_d_manual"]) {
      insertDirectTag(sql, id, CoreSupertagIDs.person);
    }

    const page1 = listNodesByTag(sql, CoreSupertagIDs.person, { limit: 2, excludePersonVisibility: ["other"] });
    expect(page1.items.map((i) => i.id)).toEqual(["person_c_manual", "person_d_manual"]);
    expect(page1.nextCursor).toBeNull();
  });

  test("listNodesByTag: a person page with NO visibility metadata (the normal case) is unaffected either way", () => {
    const sql = makeSql();
    insertNode(sql, "person_manual");
    insertDirectTag(sql, "person_manual", CoreSupertagIDs.person);

    expect(listNodesByTag(sql, CoreSupertagIDs.person).items.map((i) => i.id)).toEqual(["person_manual"]);
    expect(
      listNodesByTag(sql, CoreSupertagIDs.person, { excludePersonVisibility: ["other"] }).items.map((i) => i.id),
    ).toEqual(["person_manual"]);
  });
});

describe("getRelationTargets / getRelationSources", () => {
  test("getRelationTargets resolves the forward edge for each source id, batched", () => {
    const sql = makeSql();
    insertNode(sql, "task_1");
    insertNode(sql, "project_1");
    insertEdge(sql, "edge_1", TASK_PROJECT_RELATION, "task_1", "project_1");

    const targets = getRelationTargets(sql, TASK_PROJECT_RELATION, ["task_1", "task_no_edge"]);
    expect(targets.get("task_1")).toEqual(["project_1"]);
    expect(targets.has("task_no_edge")).toBe(false);
  });

  test("getRelationSources resolves the inverse projection — every source pointing at a target", () => {
    const sql = makeSql();
    insertNode(sql, "task_1");
    insertNode(sql, "task_2");
    insertNode(sql, "project_1");
    insertEdge(sql, "edge_1", TASK_PROJECT_RELATION, "task_1", "project_1");
    insertEdge(sql, "edge_2", TASK_PROJECT_RELATION, "task_2", "project_1");

    const sources = getRelationSources(sql, TASK_PROJECT_RELATION, ["project_1"]);
    expect(sources.get("project_1")?.sort()).toEqual(["task_1", "task_2"]);
  });

  test("both return an empty map for an empty id list, without querying", () => {
    const sql = makeSql();
    expect(getRelationTargets(sql, TASK_PROJECT_RELATION, [])).toEqual(new Map());
    expect(getRelationSources(sql, TASK_PROJECT_RELATION, [])).toEqual(new Map());
  });
});
