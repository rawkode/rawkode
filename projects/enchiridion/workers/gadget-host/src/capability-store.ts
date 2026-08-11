// @enchiridion/worker-gadget-host — SQLite read/write for `capability_grants`.
//
// Plain functions over a `SqlExecutor`, no DO/Workers-runtime dependency —
// same testable pattern as `workers/gatekeeper-google/src/token-store.ts`.
// This module is pure bookkeeping (create/list/revoke/lookup); the actual
// default-deny DECISION lives in `capability-enforcement.ts`, which calls
// `getActiveGrant` below and nothing else — keeping "what grants exist" and
// "is this call allowed right now" as two separate, separately-testable
// concerns.

import type { CapabilityGrant, CapabilityScope, CapabilityType } from "./capability-types";
import type { SqlExecutor } from "./schema";

interface GrantRow {
  id: string;
  gadget_id: string;
  capability_type: string;
  scope: string;
  granted_at: number;
  granted_by: string;
  revoked_at: number | null;
  [key: string]: unknown;
}

function decodeRow(row: GrantRow): CapabilityGrant {
  return {
    id: row.id,
    gadgetId: row.gadget_id,
    capabilityType: row.capability_type as CapabilityType,
    scope: JSON.parse(row.scope) as CapabilityScope,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
    revokedAt: row.revoked_at,
  };
}

const GRANT_COLUMNS = "id, gadget_id, capability_type, scope, granted_at, granted_by, revoked_at";

/** Creates a new, immediately-active grant. Callers are `grant-request-
 *  store.ts`'s `decideGrantRequest` (the normal, in-app-approved path) and
 *  tests — there is deliberately no "propose a grant directly" RPC on
 *  `GadgetSupervisorDO` bypassing the grant-request flow (plan: "Grant
 *  requests ... requiring in-app approval"). */
export function createGrant(
  sql: SqlExecutor,
  input: { gadgetId: string; capabilityType: CapabilityType; scope: CapabilityScope; grantedBy: string },
  now: number,
): CapabilityGrant {
  const grant: CapabilityGrant = {
    id: `grant_${crypto.randomUUID()}`,
    gadgetId: input.gadgetId,
    capabilityType: input.capabilityType,
    scope: input.scope,
    grantedAt: now,
    grantedBy: input.grantedBy,
    revokedAt: null,
  };
  sql.exec(
    `INSERT INTO capability_grants (id, gadget_id, capability_type, scope, granted_at, granted_by, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    grant.id,
    grant.gadgetId,
    grant.capabilityType,
    JSON.stringify(grant.scope),
    grant.grantedAt,
    grant.grantedBy,
  );
  return grant;
}

/** The one lookup `capability-enforcement.ts` needs: the currently-active
 *  (not revoked) grant for this exact `(gadgetId, capabilityType)` pair, if
 *  any. A gadget may hold at most one active grant per capability type at
 *  a time in this v1 design (creating a new one for an already-granted
 *  pair is a caller error, not guarded against at the SQL level — kept
 *  simple since the only caller, `decideGrantRequest`, only ever grants
 *  from a request that itself required approval). Returns the
 *  MOST-RECENTLY-GRANTED active row if somehow more than one exists,
 *  rather than throwing — fail-safe-shaped, matching this codebase's
 *  general "denial is the loud failure mode, ambiguity is not" posture. */
export function getActiveGrant(sql: SqlExecutor, gadgetId: string, capabilityType: CapabilityType): CapabilityGrant | undefined {
  const row = sql
    .exec<GrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM capability_grants
       WHERE gadget_id = ? AND capability_type = ? AND revoked_at IS NULL
       ORDER BY granted_at DESC LIMIT 1`,
      gadgetId,
      capabilityType,
    )
    .toArray()[0];
  return row ? decodeRow(row) : undefined;
}

export function listGrants(sql: SqlExecutor, gadgetId?: string): CapabilityGrant[] {
  const rows = gadgetId
    ? sql.exec<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM capability_grants WHERE gadget_id = ? ORDER BY granted_at DESC`, gadgetId).toArray()
    : sql.exec<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM capability_grants ORDER BY granted_at DESC`).toArray();
  return rows.map(decodeRow);
}

/** Revocable (plan: "granted-at, revocable"). Idempotent — revoking an
 *  already-revoked or unknown grant id is a silent no-op, not an error
 *  (matches `deleteStoredTokens`'s "clearing something that may already
 *  be clear is not exceptional" convention elsewhere in this codebase). */
export function revokeGrant(sql: SqlExecutor, grantId: string, now: number): void {
  sql.exec(`UPDATE capability_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now, grantId);
}
