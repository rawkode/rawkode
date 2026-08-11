// @enchiridion/worker-gadget-host — SQLite read/write for
// `capability_grant_requests`.
//
// Plan §Gadgets: "Grant requests: a gadget requesting a capability creates
// a grant-request record requiring in-app approval (design the data model;
// the actual native-app approval UI is explicitly a separate future task,
// not this one)." This module is that data model plus the
// request -> approve/deny state machine; the native-app UI that would call
// `decideGrantRequest` from a person's actual tap is out of scope here,
// same as gatekeeper-google's write-model approval UI (see
// `workers/gatekeeper-google/src/index.ts`'s "STILL NOT IMPLEMENTED" note
// for the precedent this follows).
//
// FIRST-WRITER-WINS CAS, same atomicity argument as
// `workers/gatekeeper-google/src/approvals-store.ts`'s `tryConfirmApproval`
// (that file's header has the full "SELECT then unconditionally act, no
// `await` in between" reasoning — not restated here): a DO processes one
// synchronous span of a single RPC call without interleaving another
// call's code, so a plain read-then-write with no intervening `await` is
// race-free.
//
// KEY DESIGN POINT — a PENDING request grants nothing (plan test
// requirement: "a pending grant request does nothing until approved").
// `requestCapabilityGrant` below never touches `capability_grants`; only
// `decideGrantRequest(..., "approved")` does, via
// `capability-store.ts`'s `createGrant`, and only once, inside the same
// CAS transition that also marks the request `approved` — there is no
// window where a request is simultaneously `pending` and its capability
// already usable.

import { createGrant } from "./capability-store";
import type { CapabilityGrant, CapabilityGrantRequest, CapabilityScope, CapabilityType, GrantRequestStatus } from "./capability-types";
import type { SqlExecutor } from "./schema";

interface RequestRow {
  id: string;
  gadget_id: string;
  capability_type: string;
  scope: string;
  reason: string | null;
  status: string;
  requested_at: number;
  decided_at: number | null;
  decided_by: string | null;
  resulting_grant_id: string | null;
  [key: string]: unknown;
}

const REQUEST_COLUMNS =
  "id, gadget_id, capability_type, scope, reason, status, requested_at, decided_at, decided_by, resulting_grant_id";

function decodeRow(row: RequestRow): CapabilityGrantRequest {
  return {
    id: row.id,
    gadgetId: row.gadget_id,
    capabilityType: row.capability_type as CapabilityType,
    scope: JSON.parse(row.scope) as CapabilityScope,
    reason: row.reason,
    status: row.status as GrantRequestStatus,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    resultingGrantId: row.resulting_grant_id,
  };
}

/** Creates a new `pending` grant request. Never touches
 *  `capability_grants` — see this file's header. */
export function requestCapabilityGrant(
  sql: SqlExecutor,
  input: { gadgetId: string; capabilityType: CapabilityType; scope: CapabilityScope; reason?: string },
  now: number,
): CapabilityGrantRequest {
  const request: CapabilityGrantRequest = {
    id: `grantreq_${crypto.randomUUID()}`,
    gadgetId: input.gadgetId,
    capabilityType: input.capabilityType,
    scope: input.scope,
    reason: input.reason ?? null,
    status: "pending",
    requestedAt: now,
    decidedAt: null,
    decidedBy: null,
    resultingGrantId: null,
  };
  sql.exec(
    `INSERT INTO capability_grant_requests
       (id, gadget_id, capability_type, scope, reason, status, requested_at, decided_at, decided_by, resulting_grant_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL)`,
    request.id,
    request.gadgetId,
    request.capabilityType,
    JSON.stringify(request.scope),
    request.reason,
    request.requestedAt,
  );
  return request;
}

export function getGrantRequest(sql: SqlExecutor, id: string): CapabilityGrantRequest | undefined {
  const row = sql.exec<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM capability_grant_requests WHERE id = ?`, id).toArray()[0];
  return row ? decodeRow(row) : undefined;
}

export function listGrantRequests(sql: SqlExecutor, status?: GrantRequestStatus): CapabilityGrantRequest[] {
  const rows = status
    ? sql
        .exec<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM capability_grant_requests WHERE status = ? ORDER BY requested_at ASC`, status)
        .toArray()
    : sql.exec<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM capability_grant_requests ORDER BY requested_at ASC`).toArray();
  return rows.map(decodeRow);
}

export type DecideGrantRequestOutcome =
  | { status: "approved"; request: CapabilityGrantRequest; grant: CapabilityGrant }
  | { status: "denied"; request: CapabilityGrantRequest }
  | { status: "conflict"; reason: string };

/** The in-app approval decision (plan: "requiring in-app approval") — CAS
 *  guarded on the request still being `pending`, same reasoning as
 *  `approvals-store.ts`'s `tryConfirmApproval`. `decidedBy` is a free-text
 *  identifier for whoever/whatever decided (a device id, "system", ...) —
 *  this module has no concept of user identity of its own, matching every
 *  other "granted_by"/"decided_by"-shaped free-text column in this
 *  codebase (e.g. `capability_grants.granted_by`). */
export function decideGrantRequest(
  sql: SqlExecutor,
  requestId: string,
  decision: "approved" | "denied",
  decidedBy: string,
  now: number,
): DecideGrantRequestOutcome {
  const existing = getGrantRequest(sql, requestId);
  if (!existing) {
    return { status: "conflict", reason: "unknown grant request id" };
  }
  if (existing.status !== "pending") {
    return { status: "conflict", reason: `grant request is already "${existing.status}"` };
  }

  if (decision === "denied") {
    sql.exec(
      `UPDATE capability_grant_requests SET status = 'denied', decided_at = ?, decided_by = ?
       WHERE id = ? AND status = 'pending'`,
      now,
      decidedBy,
      requestId,
    );
    return { status: "denied", request: { ...existing, status: "denied", decidedAt: now, decidedBy } };
  }

  // Approved: mint the real grant FIRST (so `resulting_grant_id` is never
  // written pointing at a grant that doesn't exist), then flip the request
  // to `approved` in the SAME synchronous span — no `await` between the two
  // writes, same race-free argument as `tryConfirmApproval`.
  const grant = createGrant(
    sql,
    { gadgetId: existing.gadgetId, capabilityType: existing.capabilityType, scope: existing.scope, grantedBy: decidedBy },
    now,
  );
  sql.exec(
    `UPDATE capability_grant_requests SET status = 'approved', decided_at = ?, decided_by = ?, resulting_grant_id = ?
     WHERE id = ? AND status = 'pending'`,
    now,
    decidedBy,
    grant.id,
    requestId,
  );
  return {
    status: "approved",
    request: { ...existing, status: "approved", decidedAt: now, decidedBy, resultingGrantId: grant.id },
    grant,
  };
}
