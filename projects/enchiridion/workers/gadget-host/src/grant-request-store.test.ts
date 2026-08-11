import { describe, expect, test } from "bun:test";
import { getActiveGrant } from "./capability-store";
import { requireCapability } from "./capability-enforcement";
import { CapabilityDeniedError } from "./capability-types";
import { decideGrantRequest, getGrantRequest, listGrantRequests, requestCapabilityGrant } from "./grant-request-store";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

describe("grant-request-store", () => {
  test("requesting a grant creates a pending record and grants nothing", () => {
    const db = freshDb();
    const request = requestCapabilityGrant(
      db,
      { gadgetId: "gadget-1", capabilityType: "graph.query", scope: { capabilityType: "graph.query", views: ["page"] }, reason: "read the daily page" },
      1000,
    );
    expect(request.status).toBe("pending");
    expect(request.resultingGrantId).toBeNull();

    // The task brief's explicit requirement: "a pending grant request does
    // nothing until approved" — the capability must still be denied.
    expect(getActiveGrant(db, "gadget-1", "graph.query")).toBeUndefined();
    expect(() => requireCapability(db, "gadget-1", "graph.query")).toThrow(CapabilityDeniedError);
  });

  test("approving a pending request creates a usable grant and updates the request", () => {
    const db = freshDb();
    const request = requestCapabilityGrant(
      db,
      { gadgetId: "gadget-1", capabilityType: "schedule.cron", scope: { capabilityType: "schedule.cron", minIntervalMinutes: 60 } },
      1000,
    );

    const outcome = decideGrantRequest(db, request.id, "approved", "device:abc", 2000);
    expect(outcome.status).toBe("approved");
    if (outcome.status !== "approved") throw new Error("expected approved");
    expect(outcome.grant.gadgetId).toBe("gadget-1");
    expect(outcome.grant.capabilityType).toBe("schedule.cron");

    const stored = getGrantRequest(db, request.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.resultingGrantId).toBe(outcome.grant.id);

    // Now usable.
    expect(() => requireCapability(db, "gadget-1", "schedule.cron")).not.toThrow();
  });

  test("denying a pending request leaves the capability unusable", () => {
    const db = freshDb();
    const request = requestCapabilityGrant(db, { gadgetId: "gadget-1", capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: [] } }, 1000);
    const outcome = decideGrantRequest(db, request.id, "denied", "device:abc", 2000);
    expect(outcome.status).toBe("denied");
    expect(getGrantRequest(db, request.id)?.status).toBe("denied");
    expect(() => requireCapability(db, "gadget-1", "graph.propose")).toThrow(CapabilityDeniedError);
  });

  test("deciding an already-decided request returns a conflict, not a second grant", () => {
    const db = freshDb();
    const request = requestCapabilityGrant(db, { gadgetId: "gadget-1", capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: [] } }, 1000);
    decideGrantRequest(db, request.id, "approved", "device:abc", 2000);
    const second = decideGrantRequest(db, request.id, "approved", "device:xyz", 3000);
    expect(second.status).toBe("conflict");
  });

  test("deciding an unknown request id is a conflict", () => {
    const db = freshDb();
    const outcome = decideGrantRequest(db, "grantreq_missing", "approved", "device:abc", 1000);
    expect(outcome.status).toBe("conflict");
  });

  test("listGrantRequests filters by status", () => {
    const db = freshDb();
    const r1 = requestCapabilityGrant(db, { gadgetId: "a", capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: [] } }, 1000);
    requestCapabilityGrant(db, { gadgetId: "b", capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: [] } }, 1000);
    decideGrantRequest(db, r1.id, "approved", "device:abc", 2000);

    expect(listGrantRequests(db, "pending")).toHaveLength(1);
    expect(listGrantRequests(db, "approved")).toHaveLength(1);
    expect(listGrantRequests(db)).toHaveLength(2);
  });
});
