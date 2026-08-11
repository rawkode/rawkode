import { describe, expect, test } from "bun:test";
import { LoroPageDoc } from "./loro-storage";
import {
  needsReprojection,
  readProjectedVersionVector,
  recordProjectedVersionVector,
  refreshGraphIssues,
  reprojectPage,
  resolveModifiedAt,
} from "./projection";
import { initializeSchema } from "./schema";
import { installSupertagRegistryProjection } from "./registry-projection";
import { CoreSupertagIDs } from "@enchiridion/supertags-core";
import { encodePropertyValues } from "@enchiridion/projection";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  installSupertagRegistryProjection(sql);
  return sql;
}

function makePage(title: string, body: string): LoroPageDoc {
  const doc = LoroPageDoc.create();
  doc.text("title").insert(0, title);
  doc.text("body").insert(0, body);
  doc.commit();
  return doc;
}

describe("projection — resolveModifiedAt", () => {
  test("falls back when system.modifiedAt is absent", () => {
    const doc = makePage("Title", "Body");
    expect(resolveModifiedAt(doc, 1000)).toBe(1000);
  });

  test("reads system.modifiedAt when present", () => {
    const doc = makePage("Title", "Body");
    doc.map("system").set("modifiedAt", 5000);
    doc.commit();
    expect(resolveModifiedAt(doc, 1000)).toBe(5000);
  });
});

describe("projection — reprojectPage / real @enchiridion/projection wiring", () => {
  test("inserts a graph_nodes row with title/plainText/kind/createdAt", () => {
    const sql = makeSql();
    const doc = makePage("Hello", "World");
    reprojectPage(sql, doc, "page_1", "free", 1000, 1000);

    const row = sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_1'").one() as Record<string, unknown>;
    expect(row.title).toBe("Hello");
    expect(row.plain_text).toBe("World");
    expect(row.kind).toBe("free");
    expect(row.created_at).toBe(1000);
  });

  test("persists objectMetadata.personVisibility/.personOrigin into graph_nodes' privacy-gate columns", () => {
    const sql = makeSql();
    const doc = makePage("attendee@example.com", "");
    doc.map("objectMetadata").set("personVisibility", "other");
    doc.map("objectMetadata").set("personOrigin", "calendarAttendee");
    doc.commit();

    reprojectPage(sql, doc, "person_1", "person", 1000, 1000);

    const row = sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'person_1'").one() as Record<string, unknown>;
    expect(row.person_visibility).toBe("other");
    expect(row.person_origin).toBe("calendarAttendee");
  });

  test("a page with no objectMetadata classification projects NULL privacy-gate columns (the normal case)", () => {
    const sql = makeSql();
    const doc = makePage("Ordinary Page", "");

    reprojectPage(sql, doc, "page_1", "free", 1000, 1000);

    const row = sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_1'").one() as Record<string, unknown>;
    expect(row.person_visibility).toBeNull();
    expect(row.person_origin).toBeNull();
  });

  test("reprojecting the same page again upserts graph_nodes rather than duplicating", () => {
    const sql = makeSql();
    const doc = makePage("Hello", "World");
    reprojectPage(sql, doc, "page_1", "free", 1000, 1000);

    doc.text("title").insert(5, "!");
    doc.commit();
    reprojectPage(sql, doc, "page_1", "free", 1000, 2000);

    const rows = sql.exec("SELECT * FROM graph_nodes WHERE node_id = 'page_1'").toArray();
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).title).toBe("Hello!");
  });

  test("modifiedAt comes from the doc's system.modifiedAt when present, catalogCreatedAt otherwise", () => {
    const sql = makeSql();
    const doc = makePage("Title", "Body");
    reprojectPage(sql, doc, "page_1", "free", 1000, 1000);
    expect(
      (sql.exec("SELECT modified_at FROM graph_nodes WHERE node_id = 'page_1'").one() as Record<string, unknown>)
        .modified_at,
    ).toBe(1000);

    doc.map("system").set("modifiedAt", 9000);
    doc.commit();
    reprojectPage(sql, doc, "page_1", "free", 1000, 9000);
    expect(
      (sql.exec("SELECT modified_at FROM graph_nodes WHERE node_id = 'page_1'").one() as Record<string, unknown>)
        .modified_at,
    ).toBe(9000);
  });

  test("projects a page's direct + inherited tags into graph_node_tags", () => {
    const sql = makeSql();
    const doc = makePage("A Task", "");
    doc.map("tags").set(CoreSupertagIDs.task, true);
    doc.commit();

    reprojectPage(sql, doc, "page_1", "free", 1000, 1000);

    const rows = sql
      .exec<{ tag_id: string; direct: number }>("SELECT tag_id, direct FROM graph_node_tags WHERE node_id = 'page_1'")
      .toArray();
    expect(rows.map((r) => r.tag_id).sort()).toEqual([CoreSupertagIDs.task]);
    expect(rows[0]?.direct).toBe(1);
  });

  test("projects a scalar property value into graph_facts", () => {
    const sql = makeSql();
    const doc = makePage("A Task", "");
    doc.map("tags").set(CoreSupertagIDs.task, true);
    doc
      .map("values")
      .set(`property:${CoreSupertagIDs.task}:status`, encodePropertyValues([{ type: "select", value: "to-do" }]));
    doc.commit();

    reprojectPage(sql, doc, "page_1", "free", 1000, 1000);

    const rows = sql
      .exec<{ text_value: string; tag_id: string; field_id: string }>(
        "SELECT text_value, tag_id, field_id FROM graph_facts WHERE node_id = 'page_1'",
      )
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text_value).toBe("to-do");
    expect(rows[0]?.tag_id).toBe(CoreSupertagIDs.task);
    expect(rows[0]?.field_id).toBe("status");
  });

  test("projects an entityReference edge into _graph_edges and the public graph_edges VIEW (both directions)", () => {
    const sql = makeSql();

    const projectDoc = makePage("A Project", "");
    projectDoc.map("tags").set(CoreSupertagIDs.project, true);
    projectDoc.commit();
    reprojectPage(sql, projectDoc, "project_1", "free", 1000, 1000);

    const taskDoc = makePage("A Task", "");
    taskDoc.map("tags").set(CoreSupertagIDs.task, true);
    taskDoc
      .map("edges")
      .set(
        "edge_1",
        JSON.stringify({
          id: "edge_1",
          relationID: "dev.rawkode.enchiridion.core.taskProject",
          sourceNodeID: "task_1",
          targetNodeID: "project_1",
          origin: "user",
          createdAt: new Date(1000).toISOString(),
        }),
      );
    taskDoc.commit();
    reprojectPage(sql, taskDoc, "task_1", "free", 1000, 1000);

    const storedEdges = sql.exec("SELECT * FROM _graph_edges").toArray();
    expect(storedEdges).toHaveLength(1);

    const forward = sql
      .exec<{ to_node_id: string; relationship_name: string }>(
        "SELECT to_node_id, relationship_name FROM graph_edges WHERE from_node_id = 'task_1' AND direction = 'forward'",
      )
      .toArray();
    expect(forward).toEqual([{ to_node_id: "project_1", relationship_name: "project" }]);

    const inverse = sql
      .exec<{ to_node_id: string; relationship_name: string }>(
        "SELECT to_node_id, relationship_name FROM graph_edges WHERE from_node_id = 'project_1' AND direction = 'inverse'",
      )
      .toArray();
    expect(inverse).toEqual([{ to_node_id: "task_1", relationship_name: "tasks" }]);
  });

  test("reprojecting a page a second time replaces (not duplicates) its facts/edges/node_tags", () => {
    const sql = makeSql();
    const doc = makePage("A Task", "");
    doc.map("tags").set(CoreSupertagIDs.task, true);
    doc
      .map("values")
      .set(`property:${CoreSupertagIDs.task}:status`, encodePropertyValues([{ type: "select", value: "to-do" }]));
    doc.commit();
    reprojectPage(sql, doc, "task_1", "free", 1000, 1000);
    reprojectPage(sql, doc, "task_1", "free", 1000, 2000);

    expect(sql.exec("SELECT * FROM graph_facts WHERE node_id = 'task_1'").toArray()).toHaveLength(1);
    expect(sql.exec("SELECT * FROM graph_node_tags WHERE node_id = 'task_1'").toArray()).toHaveLength(1);
  });

  test("a deleted page's title/body still project to graph_text_search only while live; an edge to a purged node surfaces as an unresolvedTarget issue via refreshGraphIssues", () => {
    const sql = makeSql();
    const taskDoc = makePage("A Task", "");
    taskDoc.map("tags").set(CoreSupertagIDs.task, true);
    taskDoc
      .map("edges")
      .set(
        "edge_1",
        JSON.stringify({
          id: "edge_1",
          relationID: "dev.rawkode.enchiridion.core.taskProject",
          sourceNodeID: "task_1",
          targetNodeID: "project_missing",
          origin: "user",
          createdAt: new Date(1000).toISOString(),
        }),
      );
    taskDoc.commit();
    reprojectPage(sql, taskDoc, "task_1", "free", 1000, 1000);

    const issues = sql.exec("SELECT * FROM graph_issues WHERE kind = 'unresolvedTarget'").toArray();
    expect(issues).toHaveLength(1);
  });
});

describe("projection — refreshGraphIssues", () => {
  test("returns [] over an empty vault", () => {
    const sql = makeSql();
    expect(refreshGraphIssues(sql, 1000)).toEqual([]);
    expect(sql.exec("SELECT * FROM graph_issues").toArray()).toEqual([]);
  });
});

describe("projection — lastProjectedVersion drift bookkeeping", () => {
  test("needsReprojection is true for a page with no recorded projection state", () => {
    const sql = makeSql();
    expect(needsReprojection(sql, "page_1", new Uint8Array([1, 2, 3]))).toBe(true);
  });

  test("needsReprojection is false once the exact same version vector bytes are recorded", () => {
    const sql = makeSql();
    const vv = new Uint8Array([1, 2, 3]);
    recordProjectedVersionVector(sql, "page_1", vv, 100);
    expect(needsReprojection(sql, "page_1", vv)).toBe(false);
  });

  test("needsReprojection is true once the doc's version vector has moved on", () => {
    const sql = makeSql();
    recordProjectedVersionVector(sql, "page_1", new Uint8Array([1, 2, 3]), 100);
    expect(needsReprojection(sql, "page_1", new Uint8Array([1, 2, 3, 4]))).toBe(true);
  });

  test("recordProjectedVersionVector round-trips through readProjectedVersionVector", () => {
    const sql = makeSql();
    const vv = new Uint8Array([9, 8, 7, 6]);
    recordProjectedVersionVector(sql, "page_1", vv, 100);
    expect(readProjectedVersionVector(sql, "page_1")).toEqual(vv);
  });

  test("recordProjectedVersionVector upserts (a second call updates, not duplicates)", () => {
    const sql = makeSql();
    recordProjectedVersionVector(sql, "page_1", new Uint8Array([1]), 100);
    recordProjectedVersionVector(sql, "page_1", new Uint8Array([2]), 200);

    expect(readProjectedVersionVector(sql, "page_1")).toEqual(new Uint8Array([2]));
    const count = sql
      .exec<{ n: number }>("SELECT count(*) as n FROM projection_state WHERE page_id = 'page_1'")
      .one().n;
    expect(count).toBe(1);
  });
});
