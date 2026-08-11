// @enchiridion/worker-gadget-host — the `graph.propose()` capability:
// enforcement + the full propose -> confirm -> execute lifecycle.
//
// Plan §Gadgets: "graph.propose() (writes are always proposals) ... reuse
// the approval-gate pattern (pending_approvals-shaped table, CAS confirm,
// action log) already proven twice in gatekeeper-google, adapted for
// gadget-originated proposals." `gadget-approvals-store.ts` is that adapted
// table; this file is the orchestration layer around it, mirroring
// `workers/gatekeeper-google/src/write-model.ts`'s
// propose/confirmApproval/executeApprovedAction split:
//
//   - `proposeGraphWrite` — capability-gated (default deny), creates a
//     `pending` approval. NEVER touches VaultDO — matches write-model.ts's
//     "PROPOSE never touches Google's API" invariant exactly, just for
//     VaultDO instead of Google's Calendar/Gmail API.
//   - `confirmGraphProposal` — the ONLY path that reaches VaultDO's
//     `createOrUpdatePage`, gated by `gadget-approvals-store.ts`'s
//     first-writer-wins CAS. Sequencing matters the same way
//     `write-model.ts`'s `confirmApproval` documents: the CAS transition
//     happens FIRST and fully synchronously, so a racing second confirm
//     call already sees `status !== "pending"` and gets `conflict` — only
//     THEN does this function build/push the real doc update.
//
// NOTE ON THE CONFIRM CALLER: plan §Gadgets says grants require in-app
// approval, but says nothing about graph.propose() CONFIRMATIONS
// specifically requiring a human tap (unlike gatekeeper-google's
// Calendar/Gmail approvals, which explicitly do, since those cause
// irreversible real-world side effects like sending an email). A
// graph.propose() write only ever touches this vault's own graph — no
// external party is emailed/invited. `confirmGraphProposal` is exposed as
// its own `GadgetSupervisorDO` RPC method regardless (not auto-confirmed
// inside `proposeGraphWrite`) so a future policy decision (always-manual,
// auto-confirm on a per-grant "canAutoConfirm" flag, etc.) has a real seam
// to attach to — v1 does not decide that policy, it just keeps propose and
// confirm as two distinct, separately-callable steps, matching the shape
// the task brief asks for ("graph.propose() creates a real approval
// record").
//
// BLOCKER FIX (two independent adversarial reviews): `confirmGraphProposal`
// used to be reachable from `GadgetCapabilityEnv` (`gadget-env.ts`)
// alongside `graphPropose` — a gadget could propose then immediately
// confirm its own write in one continuous execution, with zero human
// involvement, defeating "writes are always proposals". Fixed by removing
// `graphConfirmProposal` from `gadget-env.ts`'s `GadgetCapabilityEnv`/
// `buildGadgetEnv` ENTIRELY (see that file) — this function below is now
// ONLY reachable via `GadgetSupervisorDO`'s own top-level RPC surface
// (`gadget-supervisor-do.ts`'s `confirmGraphProposal` method), which
// gadget code has no path to call (facet code only ever sees the narrow
// `GadgetCapabilityEnv` object `gadget-env.ts` builds, never the
// supervisor DO's own RPC surface). DEFENSE IN DEPTH ON TOP OF THAT
// structural fix: this function now also requires an explicit
// `confirmedBy` caller-identity parameter that is NOT gadget-suppliable
// (no gadget-facing code path constructs one) and rejects outright if it
// ever equals the proposing gadget's own id — so even a future regression
// that re-exposed this function to gadget code some other way would still
// need to defeat this check, not just rely on "gadgets can't reach it" being
// the only line of defense.

import { requireCapability } from "./capability-enforcement";
import { CapabilityDeniedError, type CapabilityScope } from "./capability-types";
import {
  countPendingApprovals,
  getApproval as readApproval,
  listPendingApprovals as readPendingApprovals,
  markExecuted,
  markFailed,
  proposeApproval,
  tryConfirmApproval,
  type GadgetPendingApproval,
} from "./gadget-approvals-store";
import { getDocState, setDocState } from "./gadget-doc-state-store";
import { buildProposalDocUpdate, type GraphProposalPayload } from "./gadget-materialized-doc";
import type { SqlExecutor } from "./schema";
import type { GadgetVaultAccessorStub } from "./vault-accessor-client";

export type { GadgetPendingApproval } from "./gadget-approvals-store";

/** Fix 3 (adversarial review: "unbounded gadget-registered ... proposal
 *  payload size/count ... confirmed absent"). Characters, not bytes — this
 *  is `LoroText.insert`'s unit. Generous enough for a "morning brief"-style
 *  body append (the plan's v1 use case; several paragraphs of prose), small
 *  enough to keep a single gadget-authored write reviewable at a glance in
 *  a future in-app approval UI and to bound the worst-case Loro op/doc
 *  growth one proposal can cause.
 *
 *  NOTE ON THE VAULT-WIDE CAP: the plan's Risk #3 has promised a 20 MiB
 *  doc-size / 1 MiB per-change cap since P0; a second adversarial review
 *  confirmed neither is actually implemented anywhere in
 *  `workers/vault/src` (checked `vault-do.ts`, `doc-store.ts`,
 *  `loro-storage.ts` read-only for this task — genuinely absent, not just
 *  unfound). Fixing that is explicitly out of scope here (a dedicated
 *  vault-wide task, not a gadget-host one) — this constant is a REAL,
 *  ENFORCED backstop for the gadget-originated path specifically, not a
 *  substitute for that missing vault-wide cap, which remains an open gap. */
const MAX_MUTATION_TEXT_LENGTH = 4_000;

/** Fix 3 — bounds how many `pending` approvals one gadget can have
 *  outstanding at once, so a runaway/malicious gadget can't flood
 *  `gadget_pending_approvals` with proposals no human will ever get through
 *  reviewing. Comfortably above any plausible single-gadget backlog under
 *  normal operation (a cron automation proposing once per scheduled tick,
 *  confirmed or rejected well before 20 accumulate) while still being a
 *  real, finite ceiling. */
const MAX_PENDING_APPROVALS_PER_GADGET = 20;

type GraphProposeScope = Extract<CapabilityScope, { capabilityType: "graph.propose" }>;

/** Fix 2 (page-scope restriction) — see `capability-types.ts`'s
 *  `CapabilityScope` doc comment for the full `pageIDs`/`pagePrefixes`
 *  design rationale. Exact match OR prefix match; empty arrays match
 *  nothing (no implicit wildcard). */
function isPageInScope(scope: GraphProposeScope, pageID: string): boolean {
  if (scope.pageIDs.includes(pageID)) return true;
  return scope.pagePrefixes.some((prefix) => pageID.startsWith(prefix));
}

type PayloadValidation = { valid: true } | { valid: false; reason: string };

/** Fix 3's oversized-text rejection lives HERE, inside the same structural
 *  payload validation as the pre-existing pageID/docType/mutation-shape
 *  checks — same "reject before `gadget_pending_approvals` is ever
 *  touched" fail-fast guarantee `proposeGraphWrite` already documented,
 *  just also covering size now. */
function validatePayload(payload: GraphProposalPayload): PayloadValidation {
  if (typeof payload?.pageID !== "string" || payload.pageID.length === 0) {
    return { valid: false, reason: "pageID must be a non-empty string" };
  }
  if (typeof payload?.docType !== "string" || payload.docType.length === 0) {
    return { valid: false, reason: "docType must be a non-empty string" };
  }
  if (payload?.mutation?.kind !== "appendBodyText") {
    return { valid: false, reason: "mutation.kind must be \"appendBodyText\" (the only supported mutation in this pass)" };
  }
  if (typeof payload.mutation.text !== "string" || payload.mutation.text.length === 0) {
    return { valid: false, reason: "mutation.text must be a non-empty string" };
  }
  if (payload.mutation.text.length > MAX_MUTATION_TEXT_LENGTH) {
    return {
      valid: false,
      reason: `mutation.text exceeds the maximum length of ${MAX_MUTATION_TEXT_LENGTH} characters (got ${payload.mutation.text.length})`,
    };
  }
  return { valid: true };
}

/** Capability-gated propose. Throws `CapabilityDeniedError` (no active
 *  `graph.propose` grant, out-of-scope page, or the per-gadget pending-
 *  approval cap exceeded) or `TypeError` (malformed/oversized payload)
 *  before ever touching `gadget_pending_approvals`. */
export function proposeGraphWrite(sql: SqlExecutor, gadgetId: string, payload: GraphProposalPayload, now: number): GadgetPendingApproval {
  const grant = requireCapability(sql, gadgetId, "graph.propose");

  const validation = validatePayload(payload);
  if (!validation.valid) {
    throw new TypeError(`graph.propose: malformed proposal payload — ${validation.reason}`);
  }

  if (grant.scope.capabilityType !== "graph.propose") {
    // Defensive — cannot happen if `capability-store.ts`'s scope/type
    // pairing invariant holds, but fail closed rather than assume (same
    // posture `graph-query-capability.ts` takes for its own scope).
    throw new CapabilityDeniedError(gadgetId, "graph.propose", "grant scope is malformed (type mismatch)");
  }
  if (!isPageInScope(grant.scope, payload.pageID)) {
    throw new CapabilityDeniedError(
      gadgetId,
      "graph.propose",
      `page "${payload.pageID}" is not in this grant's page allowlist (pageIDs: ${grant.scope.pageIDs.join(", ") || "<empty>"}; pagePrefixes: ${grant.scope.pagePrefixes.join(", ") || "<empty>"})`,
    );
  }

  const pendingCount = countPendingApprovals(sql, gadgetId);
  if (pendingCount >= MAX_PENDING_APPROVALS_PER_GADGET) {
    throw new CapabilityDeniedError(
      gadgetId,
      "graph.propose",
      `too many pending approvals (${pendingCount}/${MAX_PENDING_APPROVALS_PER_GADGET}) — confirm or let existing proposals resolve before proposing more`,
    );
  }

  return proposeApproval(sql, { gadgetId, actionType: "graphProposal", payload }, now);
}

export function getApproval(sql: SqlExecutor, id: string): GadgetPendingApproval | undefined {
  return readApproval(sql, id);
}

export function listPendingApprovals(sql: SqlExecutor, gadgetId?: string): GadgetPendingApproval[] {
  return readPendingApprovals(sql, gadgetId);
}

export type ConfirmGraphProposalResult =
  | { status: "executed"; result: { applied: boolean } }
  | { status: "failed"; reason: string }
  | { status: "conflict"; reason: string };

/** The one function that reaches VaultDO's `createOrUpdatePage` — see this
 *  file's header. Re-checks the `graph.propose` grant is STILL active at
 *  confirm time too (not just at propose time) — a grant revoked between
 *  propose and confirm must block execution, matching
 *  `capability-enforcement.ts`'s "re-checked on every call" design.
 *
 *  `confirmedBy` — REQUIRED caller-identity parameter, defense in depth on
 *  top of the structural fix in `gadget-env.ts` (gadget code has no path to
 *  this function AT ALL; see this file's header). Not gadget-suppliable by
 *  construction: nothing reachable from `GadgetCapabilityEnv`/
 *  `GadgetCapabilities` (`gadget-env.ts`, `gadget-capabilities-entrypoint.ts`)
 *  ever constructs or forwards one. Two things are checked, both fail closed:
 *  (1) it must be a non-empty string at all — an omitted/blank caller
 *  identity is refused outright, never silently defaulted; (2) it must not
 *  equal the proposing gadget's own `gadgetId` — a gadget can never confirm
 *  a proposal it created itself, under any future calling convention, even
 *  one this file's author didn't anticipate. Today's only real caller
 *  (`gadget-supervisor-do.ts`'s `confirmGraphProposal` RPC method) is a
 *  placeholder for the future human-driven in-app approval action the plan
 *  describes — it forwards whatever identity ITS caller supplies. */
export async function confirmGraphProposal(
  sql: SqlExecutor,
  vault: GadgetVaultAccessorStub,
  approvalId: string,
  versionToken: string,
  confirmedBy: string,
  now: number,
): Promise<ConfirmGraphProposalResult> {
  if (typeof confirmedBy !== "string" || confirmedBy.trim().length === 0) {
    throw new TypeError("confirmGraphProposal: confirmedBy (caller identity) is required and must be a non-empty string");
  }

  const existingBeforeCas = readApproval(sql, approvalId);
  if (existingBeforeCas) {
    if (confirmedBy === existingBeforeCas.gadgetId) {
      // Defense in depth (this file's header) — a proposal's own gadget
      // may never confirm it, full stop, independent of the structural
      // "gadgets can't reach this function" fix.
      return {
        status: "failed",
        reason: `confirmGraphProposal: caller "${confirmedBy}" may not confirm a proposal it created itself — gadgets cannot self-confirm`,
      };
    }
    try {
      requireCapability(sql, existingBeforeCas.gadgetId, "graph.propose");
    } catch (error) {
      if (error instanceof CapabilityDeniedError) {
        return { status: "failed", reason: error.message };
      }
      throw error;
    }
  }

  const outcome = tryConfirmApproval(sql, approvalId, versionToken, now);
  if (outcome.status === "conflict") {
    return outcome;
  }

  const approval = outcome.approval;
  const payload = approval.payload as GraphProposalPayload;

  try {
    const existingSnapshot = getDocState(sql, payload.pageID);
    const built = buildProposalDocUpdate(payload, existingSnapshot);
    setDocState(sql, payload.pageID, built.snapshotBytes, now);

    if (!built.changed) {
      const result = { applied: false };
      markExecuted(sql, approvalId, result, now);
      return { status: "executed", result };
    }

    // Fix 4 (adversarial review: "re-check after cross-worker await") —
    // re-check right here, immediately before initiating the cross-worker
    // write, not just once back at the top of this function. Everything
    // between that first check and here (the CAS transition, doc-state
    // read, Loro doc build) is real elapsed wall-clock time a revocation
    // could land in; this is the closest point to actually committing the
    // write this function can check from, so it's the point that decides
    // whether the write is even attempted.
    requireCapability(sql, approval.gadgetId, "graph.propose");

    const updateBase64 = bytesToBase64(built.updateBytes);
    const pushResult = await vault.createOrUpdatePage(payload.pageID, payload.docType, updateBase64);

    // Re-check AGAIN once the cross-worker await resolves — mirrors
    // `calendar-read-capability.ts`'s identical fix for the same class of
    // bug: the check above only proves the grant was active the MOMENT the
    // write was initiated, not that it stayed active for the write's whole
    // (unbounded) round-trip. A revocation landing while `createOrUpdatePage`
    // was in flight must not be treated as a successful, approved execution
    // just because the underlying call happened to complete first.
    requireCapability(sql, approval.gadgetId, "graph.propose");

    markExecuted(sql, approvalId, pushResult, now);
    return { status: "executed", result: pushResult };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    markFailed(sql, approvalId, reason, now);
    return { status: "failed", reason };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
