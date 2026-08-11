import { describe, expect, test } from "bun:test";
import { createGrant, revokeGrant } from "./capability-store";
import { CapabilityDeniedError } from "./capability-types";
import { executeGraphQuery } from "./graph-query-capability";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";
import type { GadgetVaultAccessorStub } from "./vault-accessor-client";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

function fakeVault(overrides: Partial<GadgetVaultAccessorStub> = {}): GadgetVaultAccessorStub {
  return {
    getPage: async () => ({ id: "page-1", kind: "note", title: "t", createdAt: 0, modifiedAt: 0, deletedAt: null }),
    getPages: async () => [],
    listPages: async () => ({ items: [], nextCursor: null }),
    getNodeWithFacts: async () => undefined,
    getNodesWithFacts: async () => [],
    listNodesByTag: async () => ({ items: [], nextCursor: null }),
    getRelationTargets: async () => ({}),
    getRelationSources: async () => ({}),
    createOrUpdatePage: async () => ({ applied: true }),
    tombstonePage: async () => ({ tombstoned: true }),
    ...overrides,
  };
}

describe("executeGraphQuery", () => {
  test("a gadget with no graph.query grant is denied", async () => {
    const db = freshDb();
    await expect(executeGraphQuery(db, fakeVault(), "gadget-1", "page", { id: "page-1" })).rejects.toThrow(CapabilityDeniedError);
  });

  test("a granted graph.query capability only works within its declared view allowlist", async () => {
    const db = freshDb();
    createGrant(db, { gadgetId: "gadget-1", capabilityType: "graph.query", scope: { capabilityType: "graph.query", views: ["page"] }, grantedBy: "system" }, 1000);

    // Allowlisted view — succeeds.
    const result = await executeGraphQuery(db, fakeVault(), "gadget-1", "page", { id: "page-1" });
    expect(result).toMatchObject({ id: "page-1" });

    // A DIFFERENT, real, registered view NOT in this grant's allowlist —
    // denied, mirroring sql-validator.ts's allowlist-denial tests.
    await expect(executeGraphQuery(db, fakeVault(), "gadget-1", "nodesByTag", { tagID: "person" })).rejects.toThrow(CapabilityDeniedError);
  });

  test("an unknown view name is denied even with a broad grant", async () => {
    const db = freshDb();
    createGrant(
      db,
      { gadgetId: "gadget-1", capabilityType: "graph.query", scope: { capabilityType: "graph.query", views: ["page", "totally-fake-view"] }, grantedBy: "system" },
      1000,
    );
    await expect(executeGraphQuery(db, fakeVault(), "gadget-1", "totally-fake-view", {})).rejects.toThrow(CapabilityDeniedError);
  });

  test("an empty views allowlist denies every view", async () => {
    const db = freshDb();
    createGrant(db, { gadgetId: "gadget-1", capabilityType: "graph.query", scope: { capabilityType: "graph.query", views: [] }, grantedBy: "system" }, 1000);
    await expect(executeGraphQuery(db, fakeVault(), "gadget-1", "page", { id: "page-1" })).rejects.toThrow(CapabilityDeniedError);
  });

  test("malformed params for an allowlisted view throw a TypeError, not a silent pass-through", async () => {
    const db = freshDb();
    createGrant(db, { gadgetId: "gadget-1", capabilityType: "graph.query", scope: { capabilityType: "graph.query", views: ["pages"] }, grantedBy: "system" }, 1000);
    await expect(executeGraphQuery(db, fakeVault(), "gadget-1", "pages", { ids: "not-an-array" })).rejects.toThrow(TypeError);
  });

  // Adversarial-review finding: `requireCapability` + the view-allowlist
  // check ran once, BEFORE the cross-worker `GRAPH_QUERY_VIEWS[...].execute`
  // await (a DO binding call to VaultDO), with no re-check after it
  // resolved. A grant revoked while that call was in flight had no effect —
  // the already-in-progress RPC still completed and its data still reached
  // the gadget. This proves the fix: the grant + allowlist are re-checked
  // after the await too, and the in-flight result is discarded (never
  // returned) if the grant is gone by the time the call resolves.
  test("a grant revoked while the cross-worker vault query is in flight is denied, not returned", async () => {
    const db = freshDb();
    const grant = createGrant(db, { gadgetId: "gadget-1", capabilityType: "graph.query", scope: { capabilityType: "graph.query", views: ["page"] }, grantedBy: "system" }, 1000);

    // A mock accessor whose promise resolution is delayed under our
    // control — `getPage` is invoked (proving the INITIAL authorize check
    // passed and the cross-worker call actually started), but does not
    // resolve until this test explicitly lets it.
    let resolveInFlight!: (page: Awaited<ReturnType<GadgetVaultAccessorStub["getPage"]>>) => void;
    const inFlight = new Promise<Awaited<ReturnType<GadgetVaultAccessorStub["getPage"]>>>((resolve) => {
      resolveInFlight = resolve;
    });
    let calls = 0;
    const vault = fakeVault({
      getPage: async () => {
        calls++;
        return inFlight;
      },
    });

    const resultPromise = executeGraphQuery(db, vault, "gadget-1", "page", { id: "page-1" });
    // At this point `executeGraphQuery` has already run its pre-check and
    // dispatched into the "page" view's `ctx.vault.getPage` call (JS runs
    // synchronously up to the first unresolved await) — the RPC is "in
    // flight" exactly as the task brief describes. Revoke the grant via a
    // direct DB write here, simulating a revocation landing while VaultDO
    // is still processing the request.
    expect(calls).toBe(1);
    revokeGrant(db, grant.id, 2000);

    // Now let the in-flight call complete with real-looking data.
    resolveInFlight({ id: "page-1", kind: "note", title: "t", createdAt: 0, modifiedAt: 0, deletedAt: null });

    await expect(resultPromise).rejects.toThrow(CapabilityDeniedError);
  });
});
