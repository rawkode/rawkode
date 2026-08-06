// @enchiridion/worker-vault — end-to-end proof that the P1 wiring (schema
// DDL -> real reprojection -> SupertagAccessors -> composed GraphQL
// schema) works against REAL data, not test doubles for the write or
// projection halves.
//
// Per the task brief's fallback clause ("unit/integration tests against
// the real DO-SQLite-backed test harness ... exercising the full
// write -> reproject -> GraphQL-query path in-process are an acceptable,
// still-real fallback"): this exercises the FULL path —
//   1. Real `loro-crdt` doc bytes (a plain client-side `LoroDoc`, exactly
//      the shape a real device's outbox would produce — title/tags/edges
//      containers, matching `@enchiridion/projection/src/doc.ts`'s
//      `PageContainer` contract).
//   2. The real write-model RPC logic (`vault-write-model.ts`'s
//      `createOrUpdatePage`) against a real (bun:sqlite-backed)
//      `SqliteStorageAdapter` — same as every other `*.test.ts` in this
//      directory, real `ctx.storage.transactionSync`-equivalent
//      synchronous SQL, no mocked storage.
//   3. Real reprojection (`projection.ts`'s `reprojectPage`, wired in this
//      task) — the write-model call above triggers it exactly the way
//      `vault-do.ts`'s RPC method does.
//   4. Real `supertag-accessors.ts` SQL, real `@enchiridion/graphql-
//      composer`-generated resolvers, real `graphql` package `execute`
//      (via the top-level `graphql()` helper) against `composed-schema
//      .ts`'s actual merged schema.
//
// What this does NOT exercise (the `wrangler dev` half — see this file's
// task report for why): a live Workers/Miniflare runtime, the DO-RPC
// serialization boundary itself (Map<->Record conversion, `vault-do.ts`'s
// `transactionSync` wrapping), Cloudflare Access, or a real WebSocket sync
// connection. `p0-exit-drill.ts` remains the P0-era precedent for that
// style of test; re-running it requires a `wrangler dev` process this
// sandbox has no network/account access to drive (same constraint that
// file's own header documents).
//
// FIELD CHOICE NOTE: the task brief's example query was
// `task.project.name` — `@enchiridion/graphql-composer` does not generate
// a `name`/`title` field on supertag types at all (only `Page`, the
// hand-written generic type, has `title`; supertag types expose only
// their OWN declared fields + id/createdAt/modifiedAt/deletedAt — see
// `graphql-composer/src/index.ts`'s Pass 2). `supertags/core`'s `project`
// supertag has no `name`/`title` field among its declared fields either
// (status/outcome/area/owner/organization/start-date/due-date/
// last-reviewed-at/closed-at/place/notes) — so `task.project.name` is not
// a field this schema can ever expose, not a wiring bug. This test proves
// the identical relation-traversal mechanism using `task.project.status`
// (a real, typed `select`-enum field Project actually declares) instead,
// and separately proves `Page`/`graphql-composer` coexist in the SAME
// merged schema by also querying `page(id: <the project's id>).title`.

import { describe, expect, test } from "bun:test";
import { graphql } from "graphql";
import { LoroDoc } from "loro-crdt/bundler";
import { CoreSupertagIDs } from "@enchiridion/supertags-core";
import { getPage, listPages } from "../query-accessors";
import { initializeSchema } from "../schema";
import { installSupertagRegistryProjection } from "../registry-projection";
import { SqliteStorageAdapter } from "../test-helpers/sqlite-storage-adapter";
import { createOrUpdatePage } from "../vault-write-model";
import {
  getNodeWithFacts,
  getNodesWithFacts,
  getRelationSources,
  getRelationTargets,
  listNodesByTag,
} from "../supertag-accessors";
import { schema, type ComposedVaultContext } from "./composed-schema";

const TASK_PROJECT_RELATION = "dev.rawkode.enchiridion.core.taskProject";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  installSupertagRegistryProjection(sql);
  return sql;
}

/** Real client-side Loro update bytes — exactly what a device's sync
 *  outbox produces (see `packages/projection/src/doc.ts`'s
 *  `PageContainer` contract for the container names). */
function clientUpdateBytes(mutate: (doc: LoroDoc) => void): Uint8Array {
  const doc = new LoroDoc();
  mutate(doc);
  doc.commit();
  return doc.export({ mode: "update" });
}

/** Wires `ComposedVaultContext` directly to the real SQL-backed accessor
 *  functions — no DO/RPC hop, matching `../graphql/schema.test.ts`'s own
 *  documented "faithful-enough substitute" convention (see that file's
 *  header). `getRelationTargets`/`getRelationSources` go through the exact
 *  same Map<->Record round trip `yoga.ts` performs at the real RPC
 *  boundary, so this test also exercises that conversion, not just the
 *  SQL underneath it. */
function contextFor(sql: SqliteStorageAdapter): ComposedVaultContext {
  return {
    vault: {
      getPage: async (id) => getPage(sql, id),
      listPages: async (options) => listPages(sql, options),
      getNodeWithFacts: async (id) => getNodeWithFacts(sql, id),
      getNodesWithFacts: async (ids) => getNodesWithFacts(sql, ids),
      listNodesByTag: async (tagID, options) => listNodesByTag(sql, tagID, options),
      getRelationTargets: async (relationID, sourceNodeIDs) => {
        const record = Object.fromEntries(getRelationTargets(sql, relationID, sourceNodeIDs));
        return new Map(Object.entries(record));
      },
      getRelationSources: async (relationID, targetNodeIDs) => {
        const record = Object.fromEntries(getRelationSources(sql, relationID, targetNodeIDs));
        return new Map(Object.entries(record));
      },
    },
    // This test file's own concern is the core-supertag relation-traversal
    // path — no test here touches `EmailThread.messages`/`emailSearch`
    // (see `email-fields.test.ts` for those), so `gatekeeperGoogle` is a
    // stub that fails loudly if it's ever accidentally reached, rather than
    // a silent empty result masking a real wiring bug.
    gatekeeperGoogle: {
      getMessagesForThreads: async () => {
        throw new Error("composed-schema.test.ts: gatekeeperGoogle.getMessagesForThreads was not expected to be called");
      },
      searchEmail: async () => {
        throw new Error("composed-schema.test.ts: gatekeeperGoogle.searchEmail was not expected to be called");
      },
    },
  };
}

describe("composed schema — end-to-end: real write -> real reproject -> GraphQL relation traversal", () => {
  test("creating a task page with a project relation via the write-model RPC is queryable as task(id).project.status", async () => {
    const sql = makeSql();
    const now = Date.now();

    // 1. Create the `project` page over the real write-model RPC, with a
    //    real Loro doc: tagged `project`, a `status` property value.
    const projectBytes = clientUpdateBytes((doc) => {
      doc.getText("title").insert(0, "Q1 Launch");
      doc.getMap("tags").set(CoreSupertagIDs.project, true);
      doc.getMap("values").set(
        `property:${CoreSupertagIDs.project}:status`,
        JSON.stringify([{ type: "select", value: "active" }]),
      );
    });
    const projectResult = createOrUpdatePage(sql, "project_1", "free", projectBytes, now);
    expect(projectResult.applied).toBe(true);

    // 2. Create the `task` page, tagged `task`, with a canonical `edges`
    //    entry pointing at the project — exactly the shape
    //    `PageDocument.setProperty` (Swift) / a real device writes for an
    //    `entityReference` field (`@enchiridion/projection/src/edges.ts`'s
    //    `DecodedEdgeJson` shape).
    const taskBytes = clientUpdateBytes((doc) => {
      doc.getText("title").insert(0, "Ship the launch checklist");
      doc.getMap("tags").set(CoreSupertagIDs.task, true);
      doc.getMap("edges").set(
        "edge_task1_project1",
        JSON.stringify({
          id: "edge_task1_project1",
          relationID: TASK_PROJECT_RELATION,
          sourceNodeID: "task_1",
          targetNodeID: "project_1",
          origin: "user",
          createdAt: new Date(now).toISOString(),
        }),
      );
    });
    const taskResult = createOrUpdatePage(sql, "task_1", "free", taskBytes, now);
    expect(taskResult.applied).toBe(true);

    // 3. Confirm reprojection actually populated the private edge storage
    //    table and the public graph_edges VIEW's both directions — the
    //    Part 1/Part 2 wiring this test is ultimately proving.
    expect(sql.exec("SELECT * FROM _graph_edges").toArray()).toHaveLength(1);
    expect(
      sql.exec("SELECT to_node_id FROM graph_edges WHERE from_node_id = 'task_1' AND direction = 'forward'").toArray(),
    ).toEqual([{ to_node_id: "project_1" }]);

    // 4. The real ask: a GraphQL query asking for a relation traversal
    //    (task -> project) plus a typed field on the far side, executed
    //    against the REAL composed schema (graphql-composer's generated
    //    Task/Project types + resolvers, merged with the hand-written Page
    //    type — composed-schema.ts).
    const result = await graphql({
      schema,
      source: `
        query {
          task(id: "task_1") {
            id
            project {
              id
              status
            }
          }
        }
      `,
      contextValue: contextFor(sql),
    });

    expect(result.errors).toBeUndefined();
    // The GraphQL enum's WIRE value is its SCREAMING_SNAKE name ("ACTIVE"),
    // not the raw stored option id ("active") — graphql-js serializes an
    // enum field's resolved internal value (here, the raw stored string
    // `factJsValue` read straight off `graph_facts.text_value`) by
    // reverse-looking-up which declared enum VALUE NAME that internal
    // `value:` belongs to (`graphql-composer/src/index.ts`'s
    // `getOrCreateEnumType`: `values[valueName] = { value: option.id, ... }`).
    // Confirms both the relation traversal AND the select/enum field
    // mapping work end to end, not just the id lookup.
    expect(result.data).toEqual({
      task: {
        id: "task_1",
        project: {
          id: "project_1",
          status: "ACTIVE",
        },
      },
    });

    // 5. Prove the OTHER half of the merge decision too: the SAME merged
    //    schema still answers the generic, doc-type-agnostic `Page` query
    //    for the very same underlying node — `Page` and the supertag
    //    types are complementary views over one `graph_nodes` row, not two
    //    competing schemas.
    const pageResult = await graphql({
      schema,
      source: `query { page(id: "project_1") { id title kind } }`,
      contextValue: contextFor(sql),
    });
    expect(pageResult.errors).toBeUndefined();
    expect(pageResult.data).toEqual({ page: { id: "project_1", title: "Q1 Launch", kind: "free" } });

    // 6. And the inverse/backlink direction of the same relation —
    //    `project.tasks` (graphql-composer's generated backlink field,
    //    `getRelationSources` under the hood) — resolves the task back.
    const backlinkResult = await graphql({
      schema,
      source: `query { project(id: "project_1") { tasks { id } } }`,
      contextValue: contextFor(sql),
    });
    expect(backlinkResult.errors).toBeUndefined();
    expect(backlinkResult.data).toEqual({ project: { tasks: [{ id: "task_1" }] } });
  });

  test("a task with no project relation resolves task.project as null, not an error", async () => {
    const sql = makeSql();
    const bytes = clientUpdateBytes((doc) => {
      doc.getText("title").insert(0, "Unassigned task");
      doc.getMap("tags").set(CoreSupertagIDs.task, true);
    });
    createOrUpdatePage(sql, "task_lonely", "free", bytes, Date.now());

    const result = await graphql({
      schema,
      source: `query { task(id: "task_lonely") { id project { id } } }`,
      contextValue: contextFor(sql),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ task: { id: "task_lonely", project: null } });
  });
});
