// @enchiridion/gadget morning-brief — pure orchestration logic, no
// `cloudflare:workers` import (see `index.ts`'s header for why that split
// matters: this file stays fully unit-testable under `bun test`, exactly
// like every DO-adjacent "real logic lives in a plain module" split
// elsewhere in `workers/gadget-host/src/`).
//
// Plan §Gadgets, P4 v1 scope: "one headless cron automation (morning brief
// written to the daily page via proposals)". On its scheduled invocation
// (`schedule.cron`, `../../src/schedule-fanout.ts`'s tick -> `invokeGadget`
// -> this gadget's `/cron` route, `index.ts`), this gadget:
//   1. Computes today's date and its deterministic daily-page id
//      (`daily:YYYY-MM-DD`, matching `graph-core`'s PageID derivation —
//      the plan's "critical invariant").
//   2. Calls `env.CAPABILITIES.graphQuery("page", {id})` (the REAL,
//      working capability transport — see `../../src/gadget-capabilities-
//      entrypoint.ts`) to check whether today's daily page already
//      exists, so the brief's OPENING LINE can differ (a page that didn't
//      exist yet was just created BY this proposal; one that already
//      existed is getting an additional line appended to whatever's
//      already there) — this is genuinely decision-relevant, not just a
//      formality: `graph.propose`'s CONFIRM step (`../../src/graph-
//      propose-capability.ts`'s `buildProposalDocUpdate`/`openOrCreate`)
//      transparently handles "open existing snapshot or create a fresh
//      doc" either way, so the query's result doesn't change WHETHER the
//      write succeeds, only WHAT this gadget chooses to say.
//   3. Calls `env.CAPABILITIES.graphPropose(...)` with an `appendBodyText`
//      mutation — writes are always proposals (plan §Gadgets); this
//      gadget never sees or reaches the confirm step (structurally
//      impossible — see `gadget-capabilities-entrypoint.ts`'s header).
//
// CAPABILITY SHAPE MATCHES REALITY, ON PURPOSE: `MorningBriefCapabilities`
// below is a narrow `Pick` of the REAL `GadgetCapabilitiesStub` (`../../
// src/gadget-env.ts`) via a type-only import — erased entirely at build
// time (no runtime dependency on `../../src/`, so bundling this gadget for
// upload to R2 never pulls in gadget-host's own internals), but keeps this
// file's contract byte-for-byte identical to what a real facet's
// `env.CAPABILITIES` actually exposes, instead of a hand-rolled interface
// that could quietly drift from it.

import type { GadgetCapabilitiesStub } from "../../src/gadget-env";

export type MorningBriefCapabilities = Pick<GadgetCapabilitiesStub, "graphQuery" | "graphPropose">;

/** Mirrors `@enchiridion/gadget-vault-rpc-contract`'s `GadgetPageAccessorRow`
 *  — the real shape `graph-query-views.ts`'s `"page"` view
 *  (`ctx.vault.getPage(id)`) returns. Re-declared locally (not imported)
 *  for the same "gadget code stays self-contained, no gadget-host-internal
 *  runtime dependency" reason as the capabilities type above — this one
 *  isn't even a type-only import candidate, since the value flows through
 *  `unknown` at the real `graphQuery` RPC boundary (`gadget-capabilities-
 *  entrypoint.ts`'s header on why `Promise<unknown>` is deliberate there). */
export interface DailyPageAccessorRow {
  id: string;
  kind: string;
  title: string;
  createdAt: number;
  modifiedAt: number;
  deletedAt: number | null;
}

/** Deterministic daily-page id — `daily:YYYY-MM-DD`, UTC calendar date.
 *  Matches `graph-core`'s PageID derivation for daily pages (the plan's
 *  "critical invariant: deterministic PageIDs ... locked with
 *  cross-language golden tests"); this gadget doesn't re-derive it via
 *  `graph-core` itself (a cross-package runtime import this self-contained
 *  bundle deliberately avoids, same reasoning as the capabilities type
 *  above) — it re-implements the same fixed, simple `YYYY-MM-DD` format
 *  directly. UTC (not local time) so a fan-out tick anywhere lands on the
 *  same page id `graph-core`'s own UTC-based derivation would produce. */
export function dailyPageId(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `daily:${year}-${month}-${day}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function formatDisplayDate(date: Date): string {
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** Builds the brief's text — a short, self-contained block appended to the
 *  daily page's body (`graph-propose-capability.ts`'s `appendBodyText`
 *  mutation always adds a leading newline for a non-empty body, so this
 *  never needs to manage that separator itself). Deliberately branches on
 *  whether today's daily page already existed (see this file's header) —
 *  the ONLY behavioral difference `graphQuery`'s result drives. */
export function buildMorningBriefText(existingPage: DailyPageAccessorRow | undefined, date: Date): string {
  const heading = `Morning Brief — ${formatDisplayDate(date)}`;
  if (!existingPage) {
    return `${heading}\nGood morning! Today's daily page didn't exist yet, so this automated brief created it. Have a great day.`;
  }
  return `${heading}\nGood morning! Here's your automated morning brief for today.`;
}

export interface MorningBriefResult {
  pageID: string;
  existed: boolean;
  approval: unknown;
}

/** The whole gadget lifecycle for one scheduled invocation, as a plain,
 *  injectable function — `index.ts`'s `Gadget.fetch` is a thin wrapper
 *  calling this with `this.env.CAPABILITIES` and `new Date()`. Tests call
 *  this directly with a mocked `MorningBriefCapabilities` (see `logic.
 *  test.ts`), the same "mock the capability surface, not the DO" pattern
 *  `../../src/graph-propose-capability.test.ts`'s `fakeVault` establishes
 *  for `GadgetVaultAccessorStub`. */
export async function runMorningBrief(capabilities: MorningBriefCapabilities, now: Date): Promise<MorningBriefResult> {
  const pageID = dailyPageId(now);
  const existingPage = (await capabilities.graphQuery("page", { id: pageID })) as DailyPageAccessorRow | undefined;
  const text = buildMorningBriefText(existingPage, now);
  const approval = await capabilities.graphPropose({
    pageID,
    docType: "daily",
    mutation: { kind: "appendBodyText", text },
  });
  return { pageID, existed: existingPage !== undefined, approval };
}
