// Direct unit tests for `gadget-approvals-store.ts` — previously only
// exercised indirectly through `graph-propose-capability.test.ts`. Added
// alongside Fix 3 (resource caps) to give `countPendingApprovals` — the new
// per-gadget pending-approval count query — its own direct coverage, plus
// baseline coverage of the propose/confirm/execute/fail state machine this
// module owns.

import { describe, expect, test } from "bun:test";
import {
  countPendingApprovals,
  getApproval,
  listPendingApprovals,
  markExecuted,
  markFailed,
  proposeApproval,
  tryConfirmApproval,
} from "./gadget-approvals-store";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

describe("proposeApproval", () => {
  test("creates a pending approval with a fresh id and version token", () => {
    const db = freshDb();
    const approval = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: { pageID: "p", docType: "daily" } }, 1000);
    expect(approval.id).toMatch(/^gapproval_/);
    expect(approval.gadgetId).toBe("gadget-1");
    expect(approval.actionType).toBe("graphProposal");
    expect(approval.status).toBe("pending");
    expect(approval.result).toBeUndefined();
    expect(approval.createdAt).toBe(1000);
    expect(approval.updatedAt).toBe(1000);
    expect(approval.versionToken.length).toBeGreaterThan(0);
  });

  test("each proposal gets its own unique id and version token", () => {
    const db = freshDb();
    const a = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    const b = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    expect(a.id).not.toBe(b.id);
    expect(a.versionToken).not.toBe(b.versionToken);
  });
});

describe("getApproval / listPendingApprovals", () => {
  test("getApproval returns undefined for an unknown id", () => {
    const db = freshDb();
    expect(getApproval(db, "gapproval_missing")).toBeUndefined();
  });

  test("getApproval round-trips the payload exactly", () => {
    const db = freshDb();
    const payload = { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "hi" } };
    const approval = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload }, 1000);
    expect(getApproval(db, approval.id)?.payload).toEqual(payload);
  });

  test("listPendingApprovals(gadgetId) only returns that gadget's pending rows, oldest first", () => {
    const db = freshDb();
    const a1 = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    proposeApproval(db, { gadgetId: "gadget-2", actionType: "graphProposal", payload: {} }, 1000);
    const a2 = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 2000);

    const pending = listPendingApprovals(db, "gadget-1");
    expect(pending.map((a) => a.id)).toEqual([a1.id, a2.id]);
  });

  test("listPendingApprovals() with no gadgetId returns pending rows across all gadgets", () => {
    const db = freshDb();
    proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    proposeApproval(db, { gadgetId: "gadget-2", actionType: "graphProposal", payload: {} }, 1000);
    expect(listPendingApprovals(db)).toHaveLength(2);
  });

  test("a confirmed/executed/failed approval no longer shows up in listPendingApprovals", () => {
    const db = freshDb();
    const approval = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    tryConfirmApproval(db, approval.id, approval.versionToken, 1500);
    expect(listPendingApprovals(db, "gadget-1")).toHaveLength(0);
  });
});

describe("countPendingApprovals (Fix 3 — per-gadget resource cap support)", () => {
  test("zero for a gadget with no approvals at all", () => {
    const db = freshDb();
    expect(countPendingApprovals(db, "gadget-1")).toBe(0);
  });

  test("counts only this gadget's pending rows", () => {
    const db = freshDb();
    proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    proposeApproval(db, { gadgetId: "gadget-2", actionType: "graphProposal", payload: {} }, 1000);
    expect(countPendingApprovals(db, "gadget-1")).toBe(2);
    expect(countPendingApprovals(db, "gadget-2")).toBe(1);
  });

  test("drops once an approval transitions out of pending (confirmed/executed/failed)", () => {
    const db = freshDb();
    const a = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    const b = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    expect(countPendingApprovals(db, "gadget-1")).toBe(2);

    tryConfirmApproval(db, a.id, a.versionToken, 1500);
    markExecuted(db, a.id, { applied: true }, 1500);
    expect(countPendingApprovals(db, "gadget-1")).toBe(1);

    tryConfirmApproval(db, b.id, b.versionToken, 1600);
    markFailed(db, b.id, "boom", 1600);
    expect(countPendingApprovals(db, "gadget-1")).toBe(0);
  });
});

describe("tryConfirmApproval", () => {
  test("an unknown approval id is a conflict", () => {
    const db = freshDb();
    const outcome = tryConfirmApproval(db, "gapproval_missing", "token", 1000);
    expect(outcome.status).toBe("conflict");
  });

  test("a matching version token transitions pending -> confirmed", () => {
    const db = freshDb();
    const approval = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    const outcome = tryConfirmApproval(db, approval.id, approval.versionToken, 1500);
    expect(outcome.status).toBe("confirmed");
    if (outcome.status === "confirmed") {
      expect(outcome.approval.status).toBe("confirmed");
      expect(outcome.approval.updatedAt).toBe(1500);
    }
    expect(getApproval(db, approval.id)?.status).toBe("confirmed");
  });

  test("a wrong version token is a conflict and does not transition the row", () => {
    const db = freshDb();
    const approval = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    const outcome = tryConfirmApproval(db, approval.id, "wrong-token", 1500);
    expect(outcome.status).toBe("conflict");
    expect(getApproval(db, approval.id)?.status).toBe("pending");
  });

  test("confirming an already-confirmed approval again is a conflict (first-writer-wins)", () => {
    const db = freshDb();
    const approval = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    tryConfirmApproval(db, approval.id, approval.versionToken, 1500);
    const second = tryConfirmApproval(db, approval.id, approval.versionToken, 1600);
    expect(second.status).toBe("conflict");
  });
});

describe("markExecuted / markFailed", () => {
  test("markExecuted sets status executed and stores the result", () => {
    const db = freshDb();
    const approval = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    markExecuted(db, approval.id, { applied: true }, 1500);
    const updated = getApproval(db, approval.id);
    expect(updated?.status).toBe("executed");
    expect(updated?.result).toEqual({ applied: true });
    expect(updated?.updatedAt).toBe(1500);
  });

  test("markFailed sets status failed and stores the error", () => {
    const db = freshDb();
    const approval = proposeApproval(db, { gadgetId: "gadget-1", actionType: "graphProposal", payload: {} }, 1000);
    markFailed(db, approval.id, "vault unreachable", 1500);
    const updated = getApproval(db, approval.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.result).toEqual({ error: "vault unreachable" });
  });
});
