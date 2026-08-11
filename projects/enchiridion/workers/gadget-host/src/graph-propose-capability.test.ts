import { describe, expect, test } from "bun:test";
import { createGrant, revokeGrant } from "./capability-store";
import { CapabilityDeniedError } from "./capability-types";
import { confirmGraphProposal, listPendingApprovals, proposeGraphWrite } from "./graph-propose-capability";
import { initializeSchema } from "./schema";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";
import type { GadgetVaultAccessorStub } from "./vault-accessor-client";

function freshDb(): SqliteStorageAdapter {
  const db = new SqliteStorageAdapter();
  initializeSchema(db);
  return db;
}

function fakeVault(overrides: Partial<GadgetVaultAccessorStub> = {}): GadgetVaultAccessorStub & { pushed: { pageID: string; docType: string; bytes: string }[] } {
  const pushed: { pageID: string; docType: string; bytes: string }[] = [];
  return {
    pushed,
    getPage: async () => undefined,
    getPages: async () => [],
    listPages: async () => ({ items: [], nextCursor: null }),
    getNodeWithFacts: async () => undefined,
    getNodesWithFacts: async () => [],
    listNodesByTag: async () => ({ items: [], nextCursor: null }),
    getRelationTargets: async () => ({}),
    getRelationSources: async () => ({}),
    async createOrUpdatePage(pageID, docType, bytes) {
      pushed.push({ pageID, docType, bytes });
      return { applied: true };
    },
    tombstonePage: async () => ({ tombstoned: true }),
    ...overrides,
  };
}

/** Unscoped-by-prefix daily-page grant — the shape the plan's v1 use case
 *  ("morning brief written to the daily page") actually needs: a fixed
 *  prefix, not a per-day exact-match re-grant. Most tests use this. */
function grantPropose(db: SqliteStorageAdapter, gadgetId: string, scope: { pageIDs?: readonly string[]; pagePrefixes?: readonly string[] } = {}): void {
  createGrant(
    db,
    {
      gadgetId,
      capabilityType: "graph.propose",
      scope: { capabilityType: "graph.propose", pageIDs: scope.pageIDs ?? [], pagePrefixes: scope.pagePrefixes ?? ["daily:", "p"] },
      grantedBy: "system",
    },
    1000,
  );
}

describe("proposeGraphWrite", () => {
  test("a gadget with no graph.propose grant is denied", () => {
    const db = freshDb();
    expect(() =>
      proposeGraphWrite(db, "gadget-1", { pageID: "daily:2026-08-07", docType: "daily", mutation: { kind: "appendBodyText", text: "hi" } }, 1000),
    ).toThrow(CapabilityDeniedError);
  });

  test("a granted gadget's proposal creates a real, pending approval — same shape as gatekeeper-google's approvals", () => {
    const db = freshDb();
    grantPropose(db, "gadget-1");
    const approval = proposeGraphWrite(
      db,
      "gadget-1",
      { pageID: "daily:2026-08-07", docType: "daily", mutation: { kind: "appendBodyText", text: "Good morning!" } },
      1000,
    );

    // Same field set as workers/gatekeeper-google/src/approvals-store.ts's
    // PendingApproval (id, actionType, payload, versionToken, status,
    // result, createdAt, updatedAt) plus gadgetId.
    expect(approval.id).toMatch(/^gapproval_/);
    expect(approval.gadgetId).toBe("gadget-1");
    expect(approval.actionType).toBe("graphProposal");
    expect(approval.status).toBe("pending");
    expect(typeof approval.versionToken).toBe("string");
    expect(approval.versionToken.length).toBeGreaterThan(0);
    expect(approval.result).toBeUndefined();
    expect(approval.createdAt).toBe(1000);
    expect(approval.updatedAt).toBe(1000);

    expect(listPendingApprovals(db, "gadget-1")).toHaveLength(1);
  });

  test("PROPOSE never touches VaultDO — no vault client is even needed to propose", () => {
    const db = freshDb();
    grantPropose(db, "gadget-1");
    // No vault stub passed to proposeGraphWrite at all (its signature has
    // none) — this test documents that invariant by construction: if
    // proposeGraphWrite ever gained a vault-touching side effect, this
    // file would need updating to pass one.
    expect(
      proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000).status,
    ).toBe("pending");
  });

  test("malformed payloads are rejected before an approval row is created", () => {
    const db = freshDb();
    grantPropose(db, "gadget-1");
    expect(() => proposeGraphWrite(db, "gadget-1", { pageID: "", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000)).toThrow(TypeError);
    expect(listPendingApprovals(db, "gadget-1")).toHaveLength(0);
  });

  // --- Fix 2: page-scope restriction --------------------------------------
  describe("page scope", () => {
    test("a proposal for a page outside the grant's allowlist is denied with a clear reason", () => {
      const db = freshDb();
      grantPropose(db, "gadget-1", { pageIDs: ["person_abc"], pagePrefixes: ["daily:"] });
      expect(() =>
        proposeGraphWrite(db, "gadget-1", { pageID: "project_secret", docType: "project", mutation: { kind: "appendBodyText", text: "x" } }, 1000),
      ).toThrow(CapabilityDeniedError);
      try {
        proposeGraphWrite(db, "gadget-1", { pageID: "project_secret", docType: "project", mutation: { kind: "appendBodyText", text: "x" } }, 1000);
        throw new Error("expected proposeGraphWrite to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilityDeniedError);
        expect((error as CapabilityDeniedError).message).toContain("project_secret");
        expect((error as CapabilityDeniedError).message).toContain("not in this grant's page allowlist");
      }
      expect(listPendingApprovals(db, "gadget-1")).toHaveLength(0);
    });

    test("an exact pageIDs match is allowed even outside any prefix", () => {
      const db = freshDb();
      grantPropose(db, "gadget-1", { pageIDs: ["person_abc"], pagePrefixes: [] });
      const approval = proposeGraphWrite(db, "gadget-1", { pageID: "person_abc", docType: "person", mutation: { kind: "appendBodyText", text: "x" } }, 1000);
      expect(approval.status).toBe("pending");
    });

    test("a pagePrefixes match is allowed — the daily-page automation use case (new page every day, no per-day re-grant)", () => {
      const db = freshDb();
      grantPropose(db, "gadget-1", { pageIDs: [], pagePrefixes: ["daily:"] });
      const today = proposeGraphWrite(db, "gadget-1", { pageID: "daily:2026-08-07", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000);
      expect(today.status).toBe("pending");
      const tomorrow = proposeGraphWrite(db, "gadget-1", { pageID: "daily:2026-08-08", docType: "daily", mutation: { kind: "appendBodyText", text: "y" } }, 1000);
      expect(tomorrow.status).toBe("pending");
    });

    test("a grant with empty pageIDs and empty pagePrefixes allows nothing — no implicit wildcard", () => {
      const db = freshDb();
      grantPropose(db, "gadget-1", { pageIDs: [], pagePrefixes: [] });
      expect(() =>
        proposeGraphWrite(db, "gadget-1", { pageID: "daily:2026-08-07", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000),
      ).toThrow(CapabilityDeniedError);
    });
  });

  // --- Fix 3: resource caps ------------------------------------------------
  describe("resource caps", () => {
    test("mutation.text over the maximum length is rejected before any approval row exists", () => {
      const db = freshDb();
      grantPropose(db, "gadget-1");
      const oversizedText = "x".repeat(4001);
      expect(() =>
        proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: oversizedText } }, 1000),
      ).toThrow(TypeError);
      expect(listPendingApprovals(db, "gadget-1")).toHaveLength(0);
    });

    test("mutation.text right at the maximum length is accepted", () => {
      const db = freshDb();
      grantPropose(db, "gadget-1");
      const exactText = "x".repeat(4000);
      const approval = proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: exactText } }, 1000);
      expect(approval.status).toBe("pending");
    });

    test("exceeding the per-gadget pending-approval cap is rejected with a clear error", () => {
      const db = freshDb();
      grantPropose(db, "gadget-1");
      for (let i = 0; i < 20; i++) {
        proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: `line ${i}` } }, 1000);
      }
      expect(listPendingApprovals(db, "gadget-1")).toHaveLength(20);

      let thrown: unknown;
      try {
        proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "one too many" } }, 1000);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CapabilityDeniedError);
      expect((thrown as CapabilityDeniedError).message).toContain("too many pending approvals");
      // Still exactly 20 — the 21st proposal was never written.
      expect(listPendingApprovals(db, "gadget-1")).toHaveLength(20);
    });

    test("the pending-approval cap is per-gadget, not global", () => {
      const db = freshDb();
      grantPropose(db, "gadget-1");
      grantPropose(db, "gadget-2");
      for (let i = 0; i < 20; i++) {
        proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: `line ${i}` } }, 1000);
      }
      // gadget-2 has zero pending approvals of its own — unaffected by
      // gadget-1 being at its cap.
      const approval = proposeGraphWrite(db, "gadget-2", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "hi" } }, 1000);
      expect(approval.status).toBe("pending");
    });

    test("confirming a proposal frees up a slot under the cap", async () => {
      const db = freshDb();
      grantPropose(db, "gadget-1");
      const approvals = [];
      for (let i = 0; i < 20; i++) {
        approvals.push(proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: `line ${i}` } }, 1000));
      }
      expect(() =>
        proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "blocked" } }, 1000),
      ).toThrow(CapabilityDeniedError);

      // Confirming one approval takes it out of "pending" status, freeing a
      // slot under the cap for a new proposal.
      const vault = fakeVault();
      const firstApproval = approvals[0]!;
      const confirmResult = await confirmGraphProposal(db, vault, firstApproval.id, firstApproval.versionToken, "app", 1500);
      expect(confirmResult.status).toBe("executed");

      const freed = proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "now allowed" } }, 1600);
      expect(freed.status).toBe("pending");
    });
  });
});

describe("confirmGraphProposal", () => {
  test("confirming with the correct version token executes and pushes a real Loro update to VaultDO", async () => {
    const db = freshDb();
    grantPropose(db, "gadget-1");
    const approval = proposeGraphWrite(
      db,
      "gadget-1",
      { pageID: "daily:2026-08-07", docType: "daily", mutation: { kind: "appendBodyText", text: "Good morning!" } },
      1000,
    );

    const vault = fakeVault();
    const result = await confirmGraphProposal(db, vault, approval.id, approval.versionToken, "app", 2000);
    expect(result.status).toBe("executed");
    expect(vault.pushed).toHaveLength(1);
    expect(vault.pushed[0]?.pageID).toBe("daily:2026-08-07");
    expect(vault.pushed[0]?.docType).toBe("daily");
    expect(vault.pushed[0]?.bytes.length).toBeGreaterThan(0);
  });

  test("a stale/wrong version token is a conflict, not an execution", async () => {
    const db = freshDb();
    grantPropose(db, "gadget-1");
    const approval = proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000);

    const vault = fakeVault();
    const result = await confirmGraphProposal(db, vault, approval.id, "wrong-token", "app", 2000);
    expect(result.status).toBe("conflict");
    expect(vault.pushed).toHaveLength(0);
  });

  test("a second confirm attempt after the first succeeded is a conflict (first-writer-wins)", async () => {
    const db = freshDb();
    grantPropose(db, "gadget-1");
    const approval = proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000);

    const vault = fakeVault();
    const first = await confirmGraphProposal(db, vault, approval.id, approval.versionToken, "app", 2000);
    expect(first.status).toBe("executed");
    const second = await confirmGraphProposal(db, vault, approval.id, approval.versionToken, "app", 3000);
    expect(second.status).toBe("conflict");
    expect(vault.pushed).toHaveLength(1); // not pushed twice
  });

  test("revoking graph.propose between propose and confirm blocks execution", async () => {
    const db = freshDb();
    const grant = createGrant(
      db,
      { gadgetId: "gadget-1", capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: ["p"] }, grantedBy: "system" },
      1000,
    );
    const approval = proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000);

    revokeGrant(db, grant.id, 1500);

    const vault = fakeVault();
    const result = await confirmGraphProposal(db, vault, approval.id, approval.versionToken, "app", 2000);
    expect(result.status).toBe("failed");
    expect(vault.pushed).toHaveLength(0);
  });

  test("confirming an unknown approval id is a conflict", async () => {
    const db = freshDb();
    const vault = fakeVault();
    const result = await confirmGraphProposal(db, vault, "gapproval_missing", "token", "app", 2000);
    expect(result.status).toBe("conflict");
  });

  // --- Fix 1: gadget self-confirm is impossible, defense in depth ---------
  describe("caller identity (Fix 1 defense in depth)", () => {
    test("an empty/missing confirmedBy is rejected outright", async () => {
      const db = freshDb();
      grantPropose(db, "gadget-1");
      const approval = proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000);
      const vault = fakeVault();
      await expect(confirmGraphProposal(db, vault, approval.id, approval.versionToken, "", 2000)).rejects.toThrow(TypeError);
      expect(vault.pushed).toHaveLength(0);
    });

    test("a caller identity equal to the proposing gadget's own id is refused — a gadget can never confirm its own proposal", async () => {
      const db = freshDb();
      grantPropose(db, "gadget-1");
      const approval = proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000);
      const vault = fakeVault();
      const result = await confirmGraphProposal(db, vault, approval.id, approval.versionToken, "gadget-1", 2000);
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.reason).toContain("may not confirm a proposal it created itself");
      }
      expect(vault.pushed).toHaveLength(0);
    });

    test("a distinct caller identity (not the proposing gadget's id) is allowed to confirm", async () => {
      const db = freshDb();
      grantPropose(db, "gadget-1");
      const approval = proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000);
      const vault = fakeVault();
      const result = await confirmGraphProposal(db, vault, approval.id, approval.versionToken, "app:device-abc", 2000);
      expect(result.status).toBe("executed");
      expect(vault.pushed).toHaveLength(1);
    });
  });

  // --- Fix 4: re-check after the cross-worker await -----------------------
  describe("re-check while the cross-worker vault write is in flight (Fix 4)", () => {
    test("a grant revoked while vault.createOrUpdatePage is still in flight results in failed, not executed", async () => {
      const db = freshDb();
      const grant = createGrant(
        db,
        { gadgetId: "gadget-1", capabilityType: "graph.propose", scope: { capabilityType: "graph.propose", pageIDs: [], pagePrefixes: ["p"] }, grantedBy: "system" },
        1000,
      );
      const approval = proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000);

      // A vault stub whose promise resolution we control — proves the
      // PRE-await check passed (the call started) before we revoke, then
      // resolves only after the revoke has landed, simulating "revoked
      // while the cross-worker write is in flight".
      let resolveInFlight!: (result: { applied: boolean }) => void;
      const inFlight = new Promise<{ applied: boolean }>((resolve) => {
        resolveInFlight = resolve;
      });
      let calls = 0;
      const vault: GadgetVaultAccessorStub = {
        getPage: async () => undefined,
        getPages: async () => [],
        listPages: async () => ({ items: [], nextCursor: null }),
        getNodeWithFacts: async () => undefined,
        getNodesWithFacts: async () => [],
        listNodesByTag: async () => ({ items: [], nextCursor: null }),
        getRelationTargets: async () => ({}),
        getRelationSources: async () => ({}),
        async createOrUpdatePage() {
          calls++;
          return inFlight;
        },
        tombstonePage: async () => ({ tombstoned: true }),
      };

      const resultPromise = confirmGraphProposal(db, vault, approval.id, approval.versionToken, "app", 2000);
      // JS runs synchronously up to the first unresolved await — by now
      // confirmGraphProposal has passed its pre-write check and actually
      // called into vault.createOrUpdatePage (the cross-worker RPC is
      // genuinely "in flight").
      expect(calls).toBe(1);

      revokeGrant(db, grant.id, 2500);
      resolveInFlight({ applied: true });

      const result = await resultPromise;
      expect(result.status).toBe("failed");
    });

    test("without any revocation, the write still executes normally through both checks", async () => {
      const db = freshDb();
      grantPropose(db, "gadget-1");
      const approval = proposeGraphWrite(db, "gadget-1", { pageID: "p", docType: "daily", mutation: { kind: "appendBodyText", text: "x" } }, 1000);
      const vault = fakeVault();
      const result = await confirmGraphProposal(db, vault, approval.id, approval.versionToken, "app", 2000);
      expect(result.status).toBe("executed");
      expect(vault.pushed).toHaveLength(1);
    });
  });
});
