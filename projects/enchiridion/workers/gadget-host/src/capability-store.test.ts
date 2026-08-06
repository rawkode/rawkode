import { describe, expect, test } from "bun:test";
import { createGrant, getActiveGrant, listGrants, revokeGrant } from "./capability-store";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

describe("capability-store", () => {
  test("a gadget with no grant has no active grant", () => {
    const db = freshDb();
    expect(getActiveGrant(db, "gadget-1", "graph.query")).toBeUndefined();
  });

  test("createGrant makes an active grant visible via getActiveGrant", () => {
    const db = freshDb();
    const grant = createGrant(
      db,
      { gadgetId: "gadget-1", capabilityType: "graph.query", scope: { capabilityType: "graph.query", views: ["page"] }, grantedBy: "system" },
      1000,
    );
    const active = getActiveGrant(db, "gadget-1", "graph.query");
    expect(active?.id).toBe(grant.id);
    expect(active?.revokedAt).toBeNull();
  });

  test("revokeGrant makes the grant no longer active", () => {
    const db = freshDb();
    const grant = createGrant(
      db,
      { gadgetId: "gadget-1", capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: [] }, grantedBy: "system" },
      1000,
    );
    revokeGrant(db, grant.id, 2000);
    expect(getActiveGrant(db, "gadget-1", "graph.propose")).toBeUndefined();
    const all = listGrants(db, "gadget-1");
    expect(all).toHaveLength(1);
    expect(all[0]?.revokedAt).toBe(2000);
  });

  test("revoking an unknown or already-revoked grant is a silent no-op", () => {
    const db = freshDb();
    expect(() => revokeGrant(db, "grant_does_not_exist", 1000)).not.toThrow();
    const grant = createGrant(
      db,
      { gadgetId: "g", capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 5 }, grantedBy: "system" },
      1000,
    );
    revokeGrant(db, grant.id, 2000);
    revokeGrant(db, grant.id, 3000); // second revoke — no-op, doesn't throw
    expect(listGrants(db, "g")[0]?.revokedAt).toBe(2000);
  });

  test("listGrants without a gadgetId lists across all gadgets", () => {
    const db = freshDb();
    createGrant(db, { gadgetId: "a", capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: [] }, grantedBy: "system" }, 1000);
    createGrant(db, { gadgetId: "b", capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: [] }, grantedBy: "system" }, 1000);
    expect(listGrants(db)).toHaveLength(2);
  });
});
