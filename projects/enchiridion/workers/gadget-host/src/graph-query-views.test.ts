// @enchiridion/worker-gadget-host — graph-query-views.ts's PRIVACY GATE:
// `nodeWithFacts`/`nodesWithFacts`/`nodesByTag` must pass
// `excludePersonVisibility: ["other"]` through to the VaultDO accessor
// call, and every OTHER registered view must not (they don't return
// Person-shaped nodes at all, so there's nothing to filter). See
// `graph-query-views.ts`'s header ("PRIVACY GATE") and `workers/vault/src/
// supertag-accessors.ts`'s "PRIVACY-GATE FILTERING BOUNDARY" header for the
// full rationale these tests prove out at the gadget capability boundary
// (the actual exclusion logic itself is unit-tested against real SQL in
// `workers/vault/src/supertag-accessors.test.ts`; this file only proves
// gadget-host's views ask for it).

import { describe, expect, test } from "bun:test";
import { GRAPH_QUERY_VIEWS } from "./graph-query-views";
import type { GadgetVaultAccessorStub } from "./vault-accessor-client";

/** Records the `options` argument each spied method was called with, so
 *  tests can assert on exactly what a view asked the vault stub for. */
function spyVault(): { vault: GadgetVaultAccessorStub; calls: { method: string; options: unknown }[] } {
  const calls: { method: string; options: unknown }[] = [];
  const vault: GadgetVaultAccessorStub = {
    getPage: async () => ({ id: "page-1", kind: "note", title: "t", createdAt: 0, modifiedAt: 0, deletedAt: null }),
    getPages: async () => [],
    listPages: async () => ({ items: [], nextCursor: null }),
    getNodeWithFacts: async (id, options) => {
      calls.push({ method: "getNodeWithFacts", options });
      return { id, tagIDs: [], createdAt: 0, modifiedAt: 0, deletedAt: null, facts: {} };
    },
    getNodesWithFacts: async (ids, options) => {
      calls.push({ method: "getNodesWithFacts", options });
      return ids.map((id) => ({ id, tagIDs: [], createdAt: 0, modifiedAt: 0, deletedAt: null, facts: {} }));
    },
    listNodesByTag: async (tagID, options) => {
      calls.push({ method: "listNodesByTag", options });
      return { items: [], nextCursor: null };
    },
    getRelationTargets: async () => ({}),
    getRelationSources: async () => ({}),
    createOrUpdatePage: async () => ({ applied: true }),
    tombstonePage: async () => ({ tombstoned: true }),
  };
  return { vault, calls };
}

describe("GRAPH_QUERY_VIEWS — privacy-gate exclusion wiring", () => {
  test("nodeWithFacts passes excludePersonVisibility: [\"other\"] to getNodeWithFacts", async () => {
    const { vault, calls } = spyVault();
    await GRAPH_QUERY_VIEWS.nodeWithFacts!.execute({ vault }, { id: "person_1" });
    expect(calls).toEqual([{ method: "getNodeWithFacts", options: { excludePersonVisibility: ["other"] } }]);
  });

  test("nodesWithFacts passes excludePersonVisibility: [\"other\"] to getNodesWithFacts", async () => {
    const { vault, calls } = spyVault();
    await GRAPH_QUERY_VIEWS.nodesWithFacts!.execute({ vault }, { ids: ["person_1", "person_2"] });
    expect(calls).toEqual([{ method: "getNodesWithFacts", options: { excludePersonVisibility: ["other"] } }]);
  });

  test("nodesByTag passes excludePersonVisibility: [\"other\"] to listNodesByTag, alongside limit/cursor", async () => {
    const { vault, calls } = spyVault();
    await GRAPH_QUERY_VIEWS.nodesByTag!.execute({ vault }, { tagID: "person", limit: 10, cursor: "c1" });
    expect(calls).toEqual([
      { method: "listNodesByTag", options: { limit: 10, cursor: "c1", excludePersonVisibility: ["other"] } },
    ]);
  });

  test("nodesByTag still passes the exclusion even with no limit/cursor given", async () => {
    const { vault, calls } = spyVault();
    await GRAPH_QUERY_VIEWS.nodesByTag!.execute({ vault }, { tagID: "person" });
    expect(calls).toEqual([
      { method: "listNodesByTag", options: { limit: undefined, cursor: undefined, excludePersonVisibility: ["other"] } },
    ]);
  });

  test("views that don't return Person-shaped nodes (page/pages/listPages/relationTargets/relationSources) are untouched by this change", async () => {
    const { vault } = spyVault();
    await expect(GRAPH_QUERY_VIEWS.page!.execute({ vault }, { id: "page-1" })).resolves.toMatchObject({ id: "page-1" });
    await expect(GRAPH_QUERY_VIEWS.pages!.execute({ vault }, { ids: [] })).resolves.toEqual([]);
    await expect(GRAPH_QUERY_VIEWS.listPages!.execute({ vault }, {})).resolves.toEqual({ items: [], nextCursor: null });
  });
});
