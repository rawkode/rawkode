// @enchiridion/worker-gadget-host — the `graph.query` capability's
// enforcement + dispatch.
//
// Two-layer denial, both must pass:
//   1. `capability-enforcement.ts`'s `requireCapability` — the gadget must
//      hold an active, non-revoked `graph.query` grant at all (default
//      deny).
//   2. THIS file's own allowlist check — the requested `viewName` must be
//      inside THAT GRANT'S OWN `scope.views` list (plan/task-brief
//      requirement: "a granted graph.query capability only works within
//      its declared view allowlist"). A view existing in
//      `graph-query-views.ts`'s registry is necessary but not sufficient —
//      a gadget granted `{views: ["page"]}` still gets denied calling
//      `nodesByTag`, even though `nodesByTag` is a perfectly real,
//      registered view some OTHER gadget might be granted.
//
// Mirrors `sql-validator.ts`'s "fail closed, allowlist-or-deny" posture
// (see that file's header) at the CAPABILITY layer instead of the SQL-text
// layer — this is the "mirroring sql-validator.ts's allowlist-denial
// tests" surface the task brief asks for.
//
// RE-CHECKED AGAIN AFTER THE CROSS-WORKER AWAIT (adversarial review
// finding): the grant+allowlist check above only proves the grant was
// active at the MOMENT the call started. `GRAPH_QUERY_VIEWS[...].execute`
// dispatches to `GadgetVaultAccessorStub`, a cross-worker DO binding to
// VaultDO, and can take an arbitrary amount of wall-clock time to resolve —
// `capability-enforcement.ts`'s header promises revocation takes effect
// "on the very next call, not eventually", which is only true if every
// call site re-reads the grant AFTER any await that could have let a
// revocation land, not just before. Without this, a grant revoked while
// the query is in flight has no effect: the in-flight call still completes
// and its result still reaches the gadget. So `authorizeView` below runs
// twice — once before dispatching (fail fast, same as before) and once
// after the await resolves, discarding the already-fetched result (never
// returning it) if the grant or its view allowlist changed in between.

import { requireCapability } from "./capability-enforcement";
import { CapabilityDeniedError } from "./capability-types";
import { GRAPH_QUERY_VIEWS, isKnownGraphQueryView } from "./graph-query-views";
import type { SqlExecutor } from "./schema";
import type { GadgetVaultAccessorStub } from "./vault-accessor-client";

/** The grant-existence + view-allowlist check, factored out so it can be
 *  run identically both before AND after the cross-worker dispatch (see
 *  this file's header). Throws `CapabilityDeniedError` on any failure —
 *  never returns a partial/ambiguous result. */
function authorizeView(sql: SqlExecutor, gadgetId: string, viewName: string): void {
  const grant = requireCapability(sql, gadgetId, "graph.query");
  if (grant.scope.capabilityType !== "graph.query") {
    // Defensive — cannot happen if `capability-store.ts`'s scope/type
    // pairing invariant holds, but fail closed rather than assume.
    throw new CapabilityDeniedError(gadgetId, "graph.query", "grant scope is malformed (type mismatch)");
  }
  if (!grant.scope.views.includes(viewName)) {
    throw new CapabilityDeniedError(
      gadgetId,
      "graph.query",
      `view "${viewName}" is not in this grant's allowlist (${grant.scope.views.join(", ") || "<empty>"})`,
    );
  }
}

export async function executeGraphQuery(
  sql: SqlExecutor,
  vault: GadgetVaultAccessorStub,
  gadgetId: string,
  viewName: string,
  params: unknown,
): Promise<unknown> {
  authorizeView(sql, gadgetId, viewName);
  if (!isKnownGraphQueryView(viewName)) {
    // A view named in the grant's allowlist but removed/renamed since —
    // denied, not silently ignored (fail closed, same as sql-validator.ts's
    // "unable to verify a query source; rejecting").
    throw new CapabilityDeniedError(gadgetId, "graph.query", `view "${viewName}" does not exist`);
  }

  const result = await GRAPH_QUERY_VIEWS[viewName]!.execute({ vault }, params);
  // Re-check: the await above crossed into VaultDO and could have taken
  // long enough for the grant (or its view allowlist) to change mid-flight.
  // A grant that authorized this view before the call is not proof it
  // still does now — deny (discard `result`, never return it) if not.
  authorizeView(sql, gadgetId, viewName);
  return result;
}
