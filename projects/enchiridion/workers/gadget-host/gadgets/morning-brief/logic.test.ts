import { describe, expect, test } from "bun:test";
import { buildMorningBriefText, dailyPageId, runMorningBrief, type DailyPageAccessorRow, type MorningBriefCapabilities } from "./logic";

/** Mocks `env.CAPABILITIES` the same way `../../src/graph-propose-
 *  capability.test.ts`'s `fakeVault` mocks `GadgetVaultAccessorStub` —
 *  a plain object matching the REAL capability method signatures
 *  (`../../src/gadget-env.ts`'s `GadgetCapabilitiesStub`, via `logic.ts`'s
 *  type-only import), recording calls so tests can assert on exactly what
 *  this gadget asked for. */
function fakeCapabilities(overrides: {
  page?: DailyPageAccessorRow | undefined;
  proposeResult?: unknown;
} = {}): MorningBriefCapabilities & { queries: { viewName: string; params: unknown }[]; proposals: unknown[] } {
  const queries: { viewName: string; params: unknown }[] = [];
  const proposals: unknown[] = [];
  return {
    queries,
    proposals,
    async graphQuery(viewName, params) {
      queries.push({ viewName, params });
      return overrides.page;
    },
    async graphPropose(payload) {
      proposals.push(payload);
      return overrides.proposeResult ?? { id: "gapproval_fake", status: "pending" };
    },
  };
}

describe("dailyPageId", () => {
  test("formats a deterministic daily:YYYY-MM-DD id, UTC", () => {
    expect(dailyPageId(new Date(Date.UTC(2026, 7, 7)))).toBe("daily:2026-08-07");
    expect(dailyPageId(new Date(Date.UTC(2026, 0, 1)))).toBe("daily:2026-01-01");
    expect(dailyPageId(new Date(Date.UTC(2026, 11, 31)))).toBe("daily:2026-12-31");
  });

  test("pads single-digit months and days", () => {
    expect(dailyPageId(new Date(Date.UTC(2026, 2, 5)))).toBe("daily:2026-03-05");
  });
});

describe("buildMorningBriefText", () => {
  const date = new Date(Date.UTC(2026, 7, 7));

  test("mentions creating the page when it did not exist yet", () => {
    const text = buildMorningBriefText(undefined, date);
    expect(text).toContain("Morning Brief");
    expect(text).toContain("didn't exist yet");
    expect(text).toContain("Friday, August 7, 2026");
  });

  test("does not claim to have created the page when it already existed", () => {
    const existing: DailyPageAccessorRow = { id: "daily:2026-08-07", kind: "daily", title: "August 7, 2026", createdAt: 1, modifiedAt: 1, deletedAt: null };
    const text = buildMorningBriefText(existing, date);
    expect(text).toContain("Morning Brief");
    expect(text).not.toContain("didn't exist yet");
    expect(text).toContain("Friday, August 7, 2026");
  });
});

describe("runMorningBrief", () => {
  test("queries the 'page' view for today's daily page id before proposing", async () => {
    const capabilities = fakeCapabilities({ page: undefined });
    const now = new Date(Date.UTC(2026, 7, 7));

    await runMorningBrief(capabilities, now);

    expect(capabilities.queries).toHaveLength(1);
    expect(capabilities.queries[0]).toEqual({ viewName: "page", params: { id: "daily:2026-08-07" } });
  });

  test("when the daily page does not exist, proposes appendBodyText with the 'new page' brief and reports existed: false", async () => {
    const capabilities = fakeCapabilities({ page: undefined });
    const now = new Date(Date.UTC(2026, 7, 7));

    const result = await runMorningBrief(capabilities, now);

    expect(result.pageID).toBe("daily:2026-08-07");
    expect(result.existed).toBe(false);
    expect(capabilities.proposals).toHaveLength(1);
    const proposal = capabilities.proposals[0] as { pageID: string; docType: string; mutation: { kind: string; text: string } };
    expect(proposal.pageID).toBe("daily:2026-08-07");
    expect(proposal.docType).toBe("daily");
    expect(proposal.mutation.kind).toBe("appendBodyText");
    expect(proposal.mutation.text).toContain("didn't exist yet");
  });

  test("when the daily page already exists, proposes the 'already exists' brief and reports existed: true", async () => {
    const existing: DailyPageAccessorRow = { id: "daily:2026-08-07", kind: "daily", title: "August 7, 2026", createdAt: 1, modifiedAt: 1, deletedAt: null };
    const capabilities = fakeCapabilities({ page: existing });
    const now = new Date(Date.UTC(2026, 7, 7));

    const result = await runMorningBrief(capabilities, now);

    expect(result.existed).toBe(true);
    const proposal = capabilities.proposals[0] as { mutation: { text: string } };
    expect(proposal.mutation.text).not.toContain("didn't exist yet");
  });

  test("returns the capability's real proposal result verbatim (the pending approval record)", async () => {
    const approval = { id: "gapproval_123", gadgetId: "morning-brief", status: "pending" as const };
    const capabilities = fakeCapabilities({ page: undefined, proposeResult: approval });
    const result = await runMorningBrief(capabilities, new Date(Date.UTC(2026, 7, 7)));
    expect(result.approval).toEqual(approval);
  });

  test("propagates a capability denial instead of swallowing it (proposeGraphWrite throwing CapabilityDeniedError, e.g. out-of-scope page or no grant)", async () => {
    const capabilities: MorningBriefCapabilities = {
      async graphQuery() {
        return undefined;
      },
      async graphPropose() {
        throw new Error('capability denied for gadget "morning-brief" (graph.propose): no active grant');
      },
    };
    await expect(runMorningBrief(capabilities, new Date(Date.UTC(2026, 7, 7)))).rejects.toThrow(/capability denied/);
  });
});
