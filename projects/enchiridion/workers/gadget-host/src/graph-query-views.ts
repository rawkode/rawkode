// @enchiridion/worker-gadget-host — the `graph.query` capability's
// PRE-DEFINED PARAMETERIZED VIEWS.
//
// Plan §Gadgets: "graph.query (pre-defined parameterized views only —
// untrusted gadget code never sends free-form SQL, unlike the
// Access-authenticated device path)." This is the deliberately NARROWER
// sibling of `workers/vault/src/query-rpc.ts`'s bounded free-form SQL RPC
// (`vault.query(sql, args, limits)`) — see that file's header for why it is
// explicitly NOT strong enough to hand to untrusted callers ("gadget code
// (P4) must never reach this function"). Every entry below is a NAMED view
// with a FIXED shape, backed by one of VaultDO's EXISTING typed accessor
// RPC methods (`@enchiridion/gadget-vault-rpc-contract`'s
// `GadgetVaultAccessorStub`) — a gadget can never construct a query VaultDO
// wasn't already exposing as a typed method, because there is no SQL text
// anywhere on this path at all.
//
// `graph-query-capability.ts` is the ONLY caller — it checks the calling
// gadget's `graph.query` grant's `views` allowlist (its OWN capability
// scope, `capability-types.ts`) against `Object.keys(GRAPH_QUERY_VIEWS)`
// BEFORE looking a view up here, so a view existing in this registry does
// not by itself make it callable — see that file.
//
// PRIVACY GATE (adversarial review finding, plan §Gadgets P4: "graph.query
// ... must itself be personVisibility-aware, since the P2 privacy
// classification for calendar-attendee Person pages lives only at the
// materialization layer and has no enforcement at the query layer this
// capability reads through"). `nodeWithFacts`/`nodesWithFacts`/
// `nodesByTag` — the three views backed by VaultDO's supertag-accessor
// methods that can return a Person-shaped node — now pass
// `excludePersonVisibility: GADGET_EXCLUDED_PERSON_VISIBILITY` on every
// call, so a calendar-attendee-derived Person page
// (`objectMetadata.personVisibility === "other"`, `workers/gatekeeper-
// google/src/materialized-doc.ts`'s default classification, never
// auto-promoted) is excluded from every gadget's view of the graph by
// default, exactly like `PeopleModels.swift`'s original `PersonVisibility
// .other` design intends. This is UNTRUSTED-GADGET-ONLY filtering — it is
// implemented as an opt-in parameter on the VaultDO accessor methods
// themselves (`workers/vault/src/supertag-accessors.ts`'s
// `SupertagAccessorFilterOptions`), not a blanket exclusion, precisely so
// it does NOT affect `workers/vault/src/graphql/yoga.ts`'s trusted
// device/native-app GraphQL read path, which legitimately needs to keep
// showing the owning user their own calendar attendees. `page`/`pages`/
// `listPages` (backed by `workers/vault/src/query-accessors.ts`, a
// separate Page-shaped accessor surface, not the supertag one) are NOT
// filtered by this pass — out of this task's file scope; flagged as a
// residual gap in its report, not silently assumed closed.
const GADGET_EXCLUDED_PERSON_VISIBILITY = ["other"] as const;

import type { GadgetVaultAccessorStub } from "./vault-accessor-client";

export interface GraphQueryViewContext {
  vault: GadgetVaultAccessorStub;
}

/** One named view: validates its own `params` (thrown `TypeError` on a
 *  malformed shape — caught and re-surfaced by `graph-query-capability.ts`)
 *  and executes against the vault accessor client. Kept intentionally
 *  dumb — no view here does any transformation beyond what its backing
 *  VaultDO method already returns, so there is no second place result
 *  shaping/security logic could drift from VaultDO's own contract. */
export interface GraphQueryView {
  description: string;
  execute(ctx: GraphQueryViewContext, params: unknown): Promise<unknown>;
}

function requireString(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`graph.query: "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(params: unknown, key: string): string[] | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new TypeError(`graph.query: "${key}" must be an array of strings`);
  }
  return value as string[];
}

function requireStringArray(params: unknown, key: string): string[] {
  const value = optionalStringArray(params, key);
  if (!value) throw new TypeError(`graph.query: "${key}" is required and must be an array of strings`);
  return value;
}

function optionalNumber(params: unknown, key: string): number | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`graph.query: "${key}" must be a finite number`);
  }
  return value;
}

function optionalString(params: unknown, key: string): string | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`graph.query: "${key}" must be a string`);
  return value;
}

/** The full v1 view registry. Every key here is a valid value inside a
 *  `graph.query` grant's `scope.views` allowlist
 *  (`capability-types.ts`'s `CapabilityScope`) — see this file's header. */
export const GRAPH_QUERY_VIEWS: Record<string, GraphQueryView> = {
  page: {
    description: "getPage(id) — one page's PageAccessorRow, or undefined.",
    async execute(ctx, params) {
      return ctx.vault.getPage(requireString(params, "id"));
    },
  },
  pages: {
    description: "getPages(ids) — batched PageAccessorRow lookup.",
    async execute(ctx, params) {
      return ctx.vault.getPages(requireStringArray(params, "ids"));
    },
  },
  listPages: {
    description: "listPages(limit?, cursor?, includeDeleted?) — paginated page listing.",
    async execute(ctx, params) {
      return ctx.vault.listPages({
        limit: optionalNumber(params, "limit"),
        cursor: optionalString(params, "cursor"),
        includeDeleted: (params as Record<string, unknown> | null | undefined)?.includeDeleted === true,
      });
    },
  },
  nodeWithFacts: {
    description:
      "getNodeWithFacts(id) — one node's tags + facts, or undefined. Excludes calendar-attendee-derived Person pages (personVisibility \"other\") — see this file's PRIVACY GATE header comment.",
    async execute(ctx, params) {
      return ctx.vault.getNodeWithFacts(requireString(params, "id"), {
        excludePersonVisibility: GADGET_EXCLUDED_PERSON_VISIBILITY,
      });
    },
  },
  nodesWithFacts: {
    description:
      "getNodesWithFacts(ids) — batched tags + facts lookup. Excludes calendar-attendee-derived Person pages (personVisibility \"other\") — see this file's PRIVACY GATE header comment.",
    async execute(ctx, params) {
      return ctx.vault.getNodesWithFacts(requireStringArray(params, "ids"), {
        excludePersonVisibility: GADGET_EXCLUDED_PERSON_VISIBILITY,
      });
    },
  },
  nodesByTag: {
    description:
      "listNodesByTag(tagID, limit?, cursor?) — nodes directly carrying a supertag. Excludes calendar-attendee-derived Person pages (personVisibility \"other\") — see this file's PRIVACY GATE header comment.",
    async execute(ctx, params) {
      return ctx.vault.listNodesByTag(requireString(params, "tagID"), {
        limit: optionalNumber(params, "limit"),
        cursor: optionalString(params, "cursor"),
        excludePersonVisibility: GADGET_EXCLUDED_PERSON_VISIBILITY,
      });
    },
  },
  relationTargets: {
    description: "getRelationTargets(relationID, sourceNodeIDs) — batched forward canonical-edge resolution.",
    async execute(ctx, params) {
      return ctx.vault.getRelationTargets(requireString(params, "relationID"), requireStringArray(params, "sourceNodeIDs"));
    },
  },
  relationSources: {
    description: "getRelationSources(relationID, targetNodeIDs) — batched inverse canonical-edge resolution.",
    async execute(ctx, params) {
      return ctx.vault.getRelationSources(requireString(params, "relationID"), requireStringArray(params, "targetNodeIDs"));
    },
  },
};

export function isKnownGraphQueryView(viewName: string): boolean {
  return Object.hasOwn(GRAPH_QUERY_VIEWS, viewName);
}
