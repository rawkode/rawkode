import { describe, expect, test } from "bun:test";
import { requireCapability } from "./capability-enforcement";
import { createGrant } from "./capability-store";
import { CapabilityDeniedError } from "./capability-types";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

describe("requireCapability — default deny", () => {
  test("a gadget with NO granted capabilities is denied any capability call", () => {
    const db = freshDb();
    expect(() => requireCapability(db, "gadget-1", "graph.query")).toThrow(CapabilityDeniedError);
    expect(() => requireCapability(db, "gadget-1", "graph.propose")).toThrow(CapabilityDeniedError);
    expect(() => requireCapability(db, "gadget-1", "gatekeeper.google.calendar.read")).toThrow(CapabilityDeniedError);
    expect(() => requireCapability(db, "gadget-1", "schedule.cron")).toThrow(CapabilityDeniedError);
  });

  test("a grant for one capability type does not implicitly grant another", () => {
    const db = freshDb();
    createGrant(db, { gadgetId: "gadget-1", capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: [] }, grantedBy: "system" }, 1000);
    expect(() => requireCapability(db, "gadget-1", "graph.propose")).not.toThrow();
    expect(() => requireCapability(db, "gadget-1", "graph.query")).toThrow(CapabilityDeniedError);
  });

  test("a grant for another gadget does not grant this gadget", () => {
    const db = freshDb();
    createGrant(db, { gadgetId: "other-gadget", capabilityType: "graph.query", scope: { capabilityType: "graph.query", views: ["page"] }, grantedBy: "system" }, 1000);
    expect(() => requireCapability(db, "gadget-1", "graph.query")).toThrow(CapabilityDeniedError);
  });

  test("a revoked grant denies just like no grant at all", () => {
    const db = freshDb();
    const grant = createGrant(db, { gadgetId: "gadget-1", capabilityType: "graph.query", scope: { capabilityType: "graph.query", views: [] }, grantedBy: "system" }, 1000);
    // Simulate revocation directly against the store to keep this test
    // focused on requireCapability's own re-check behavior.
    db.exec("UPDATE capability_grants SET revoked_at = ? WHERE id = ?", 2000, grant.id);
    expect(() => requireCapability(db, "gadget-1", "graph.query")).toThrow(CapabilityDeniedError);
  });

  test("a granted, unrevoked capability returns the grant", () => {
    const db = freshDb();
    const grant = createGrant(
      db,
      { gadgetId: "gadget-1", capabilityType: "gatekeeper.google.calendar.read", scope: { capabilityType: "gatekeeper.google.calendar.read" }, grantedBy: "system" },
      1000,
    );
    const result = requireCapability(db, "gadget-1", "gatekeeper.google.calendar.read");
    expect(result.id).toBe(grant.id);
  });
});
