// @enchiridion/worker-gadget-host — SQLite read/write for
// `gadget_pending_approvals` + `gadget_action_log`.
//
// Deliberately shaped to MIRROR
// `workers/gatekeeper-google/src/approvals-store.ts` column-for-column
// (task brief: "graph.propose() creates a real approval record
// indistinguishable in shape from the existing calendar/Gmail approval
// infrastructure") — same `id`/`action_type`/`payload`/`version_token`/
// `status`/`result`/`created_at`/`updated_at` fields, same
// propose -> confirm (first-writer-wins CAS) -> executed/failed state
// machine, same immutable action log written on every transition attempt
// (including losing/conflicting ones). The one addition is `gadget_id`
// (gatekeeper-google manages one external account, so it never needed a
// per-caller column; this supervisor manages many gadgets, so every
// approval needs to record which one proposed it).
//
// `action_type` is `"graphProposal"` for every row this v1 pass creates —
// kept as a real column (not hardcoded away) so this table can grow new
// gadget-originated action kinds later exactly the way gatekeeper-google's
// `pending_approvals` grew from two kinds to three (`createEvent`/`rsvp` ->
// `+ sendEmail`) without a schema change, per that file's own header.
//
// See `graph-propose-capability.ts` for the capability-gated propose/
// confirm/execute orchestration that calls this module; this file itself
// has no capability-enforcement logic (same separation
// `capability-store.ts`/`capability-enforcement.ts` establish).

import type { SqlExecutor } from "./schema";

export type GadgetApprovalActionType = "graphProposal";
export type GadgetApprovalStatus = "pending" | "confirmed" | "executed" | "failed";

export interface GadgetPendingApproval {
  id: string;
  gadgetId: string;
  actionType: GadgetApprovalActionType;
  payload: unknown;
  versionToken: string;
  status: GadgetApprovalStatus;
  result: unknown;
  createdAt: number;
  updatedAt: number;
}

interface ApprovalRow {
  id: string;
  gadget_id: string;
  action_type: string;
  payload: string;
  version_token: string;
  status: string;
  result: string | null;
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
}

const APPROVAL_COLUMNS = "id, gadget_id, action_type, payload, version_token, status, result, created_at, updated_at";

function decodeRow(row: ApprovalRow): GadgetPendingApproval {
  return {
    id: row.id,
    gadgetId: row.gadget_id,
    actionType: row.action_type as GadgetApprovalActionType,
    payload: JSON.parse(row.payload),
    versionToken: row.version_token,
    status: row.status as GadgetApprovalStatus,
    result: row.result ? JSON.parse(row.result) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function appendActionLog(
  sql: SqlExecutor,
  entry: { approvalId: string | undefined; gadgetId: string; actionType: GadgetApprovalActionType; payload: unknown; outcome: string; createdAt: number },
): void {
  sql.exec(
    `INSERT INTO gadget_action_log (id, approval_id, gadget_id, action_type, payload, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `gaction_${crypto.randomUUID()}`,
    entry.approvalId ?? null,
    entry.gadgetId,
    entry.actionType,
    JSON.stringify(entry.payload),
    entry.outcome,
    entry.createdAt,
  );
}

export function proposeApproval(
  sql: SqlExecutor,
  input: { gadgetId: string; actionType: GadgetApprovalActionType; payload: unknown },
  now: number,
): GadgetPendingApproval {
  const approval: GadgetPendingApproval = {
    id: `gapproval_${crypto.randomUUID()}`,
    gadgetId: input.gadgetId,
    actionType: input.actionType,
    payload: input.payload,
    versionToken: crypto.randomUUID(),
    status: "pending",
    result: undefined,
    createdAt: now,
    updatedAt: now,
  };
  sql.exec(
    `INSERT INTO gadget_pending_approvals (id, gadget_id, action_type, payload, version_token, status, result, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    approval.id,
    approval.gadgetId,
    approval.actionType,
    JSON.stringify(approval.payload),
    approval.versionToken,
    approval.status,
    approval.createdAt,
    approval.updatedAt,
  );
  appendActionLog(sql, {
    approvalId: approval.id,
    gadgetId: approval.gadgetId,
    actionType: approval.actionType,
    payload: approval.payload,
    outcome: "proposed",
    createdAt: now,
  });
  return approval;
}

export function getApproval(sql: SqlExecutor, id: string): GadgetPendingApproval | undefined {
  const row = sql.exec<ApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM gadget_pending_approvals WHERE id = ?`, id).toArray()[0];
  return row ? decodeRow(row) : undefined;
}

export function listPendingApprovals(sql: SqlExecutor, gadgetId?: string): GadgetPendingApproval[] {
  const rows = gadgetId
    ? sql
        .exec<ApprovalRow>(
          `SELECT ${APPROVAL_COLUMNS} FROM gadget_pending_approvals WHERE status = 'pending' AND gadget_id = ? ORDER BY created_at ASC`,
          gadgetId,
        )
        .toArray()
    : sql.exec<ApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM gadget_pending_approvals WHERE status = 'pending' ORDER BY created_at ASC`).toArray();
  return rows.map(decodeRow);
}

/** Resource cap support (Fix 3, adversarial review: "unbounded gadget-
 *  registered ... proposal payload size/count ... confirmed absent") — a
 *  cheap `COUNT(*)` round trip so `graph-propose-capability.ts`'s
 *  `proposeGraphWrite` can reject a new proposal BEFORE writing it once a
 *  gadget already has too many `pending` approvals outstanding. Mirrors
 *  `schedule-store.ts`'s identical `SELECT COUNT(*) ... as count` +
 *  `.one().count` pattern for the same reason that file uses it: one
 *  narrow, purpose-built count query beats re-fetching + `.length`-ing the
 *  full `listPendingApprovals` result just to check a number. */
export function countPendingApprovals(sql: SqlExecutor, gadgetId: string): number {
  return sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM gadget_pending_approvals WHERE status = 'pending' AND gadget_id = ?`, gadgetId).one().count;
}

export type ConfirmOutcome = { status: "confirmed"; approval: GadgetPendingApproval } | { status: "conflict"; reason: string };

/** First-writer-wins CAS — identical atomicity argument to
 *  `workers/gatekeeper-google/src/approvals-store.ts`'s `tryConfirmApproval`
 *  (see this file's header). */
export function tryConfirmApproval(sql: SqlExecutor, approvalId: string, versionToken: string, now: number): ConfirmOutcome {
  const existing = getApproval(sql, approvalId);
  if (!existing) {
    return { status: "conflict", reason: "unknown approval id" };
  }
  if (existing.status !== "pending") {
    appendActionLog(sql, {
      approvalId,
      gadgetId: existing.gadgetId,
      actionType: existing.actionType,
      payload: existing.payload,
      outcome: `conflict:already-${existing.status}`,
      createdAt: now,
    });
    return { status: "conflict", reason: `approval is already "${existing.status}"` };
  }
  if (existing.versionToken !== versionToken) {
    appendActionLog(sql, {
      approvalId,
      gadgetId: existing.gadgetId,
      actionType: existing.actionType,
      payload: existing.payload,
      outcome: "conflict:stale-version-token",
      createdAt: now,
    });
    return { status: "conflict", reason: "version token does not match — this approval was already confirmed by another caller" };
  }

  sql.exec(
    `UPDATE gadget_pending_approvals SET status = 'confirmed', updated_at = ? WHERE id = ? AND version_token = ? AND status = 'pending'`,
    now,
    approvalId,
    versionToken,
  );
  const confirmed: GadgetPendingApproval = { ...existing, status: "confirmed", updatedAt: now };
  appendActionLog(sql, {
    approvalId,
    gadgetId: existing.gadgetId,
    actionType: existing.actionType,
    payload: existing.payload,
    outcome: "confirmed",
    createdAt: now,
  });
  return { status: "confirmed", approval: confirmed };
}

export function markExecuted(sql: SqlExecutor, approvalId: string, result: unknown, now: number): void {
  sql.exec(`UPDATE gadget_pending_approvals SET status = 'executed', result = ?, updated_at = ? WHERE id = ?`, JSON.stringify(result), now, approvalId);
  const approval = getApproval(sql, approvalId);
  appendActionLog(sql, {
    approvalId,
    gadgetId: approval?.gadgetId ?? "unknown",
    actionType: approval?.actionType ?? "graphProposal",
    payload: approval?.payload,
    outcome: "executed",
    createdAt: now,
  });
}

export function markFailed(sql: SqlExecutor, approvalId: string, errorMessage: string, now: number): void {
  sql.exec(
    `UPDATE gadget_pending_approvals SET status = 'failed', result = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify({ error: errorMessage }),
    now,
    approvalId,
  );
  const approval = getApproval(sql, approvalId);
  appendActionLog(sql, {
    approvalId,
    gadgetId: approval?.gadgetId ?? "unknown",
    actionType: approval?.actionType ?? "graphProposal",
    payload: approval?.payload,
    outcome: "failed",
    createdAt: now,
  });
}
