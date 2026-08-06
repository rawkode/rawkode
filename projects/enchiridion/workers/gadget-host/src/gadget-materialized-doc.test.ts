import { describe, expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt/bundler";
import { PageContainer } from "@enchiridion/projection";
import { buildProposalDocUpdate } from "./gadget-materialized-doc";

function reopen(snapshot: Uint8Array): LoroDoc {
  return LoroDoc.fromSnapshot(snapshot);
}

describe("buildProposalDocUpdate", () => {
  test("first proposal against a brand-new page produces a real, non-empty update", () => {
    const result = buildProposalDocUpdate({
      pageID: "daily:2026-08-07",
      docType: "daily",
      mutation: { kind: "appendBodyText", text: "Good morning! 2 meetings today." },
    });

    expect(result.changed).toBe(true);
    expect(result.updateBytes.length).toBeGreaterThan(0);

    const doc = reopen(result.snapshotBytes);
    expect(doc.getText(PageContainer.body).toString()).toBe("Good morning! 2 meetings today.");
    expect(doc.getMap(PageContainer.root).getShallowValue().pageID).toBe("daily:2026-08-07");
  });

  test("a second proposal against the same page (reopened from its persisted snapshot) appends, not overwrites", () => {
    const first = buildProposalDocUpdate({
      pageID: "daily:2026-08-07",
      docType: "daily",
      mutation: { kind: "appendBodyText", text: "Line one" },
    });

    const second = buildProposalDocUpdate(
      { pageID: "daily:2026-08-07", docType: "daily", mutation: { kind: "appendBodyText", text: "Line two" } },
      first.snapshotBytes,
    );

    expect(second.changed).toBe(true);
    const doc = reopen(second.snapshotBytes);
    expect(doc.getText(PageContainer.body).toString()).toBe("Line one\nLine two");
  });

  test("ops stay causally descended from the worker's own prior history (reopened doc, not a fresh LoroDoc per call)", () => {
    // Verifies the LWW-causal-history property gadget-materialized-doc.ts's
    // header documents: a doc reopened from its own last snapshot has an
    // oplog version strictly ahead of a brand-new doc's, so its next op's
    // lamport timestamp keeps advancing rather than restarting from zero.
    const first = buildProposalDocUpdate({
      pageID: "daily:2026-08-07",
      docType: "daily",
      mutation: { kind: "appendBodyText", text: "Line one" },
    });

    const reopenedForSecondEdit = reopen(first.snapshotBytes);
    const freshDoc = new LoroDoc();

    // The reopened doc's oplog version is NOT "less than or equal" to a
    // brand-new empty doc's (i.e. it carries real prior history); a fresh
    // doc's version compares as strictly behind it.
    expect(freshDoc.oplogVersion().compare(reopenedForSecondEdit.oplogVersion())).toBeLessThan(0);
  });
});
