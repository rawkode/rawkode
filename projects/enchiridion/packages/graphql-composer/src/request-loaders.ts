// @enchiridion/graphql-composer — per-GraphQL-request batching.
//
// Plan Risk #11 ("DO-RPC-per-field N+1"): "Build the typed accessor
// methods batched (one RPC per top-level GraphQL operation) from the
// start ... retrofitting batching after resolvers ship naively is the
// expensive order to do this in." `accessors.ts`'s `SupertagAccessors`
// methods already accept arrays of keys, but a naive generated resolver
// that calls `ctx.vault.getRelationTargets(relationID, [parent.id])` once
// per node in a list still fires N RPCs for N nodes — the array-shaped
// method signature alone doesn't buy batching, something has to COLLECT
// the concurrent per-node calls before dispatching one combined call.
//
// This file is that something: a minimal, dependency-free
// microtask-coalescing loader (the same core technique the `dataloader`
// package uses — no dependency added here, this is ~30 lines). graphql-js
// resolves sibling fields (e.g. every `Person.organization` across a
// `people { ... }` list) by kicking off all their resolver calls
// synchronously within the same tick before awaiting any of them, so N
// keys pushed by N resolver calls all land in `pendingKeys` before the
// microtask that dispatches them ever runs — one batched
// `SupertagAccessors` call services every sibling, without the context
// constructor (`workers/vault/src/graphql/yoga.ts`'s future update) needing
// to pre-wire anything. Loaders are cached per (request context object,
// relation id) via `WeakMap` so they scope correctly to one GraphQL
// operation and don't leak or share state across requests.

import type { GraphQLComposerContext, SupertagNodeRecord } from "./accessors";

/** Collects keys pushed synchronously within one microtask tick, then
 *  fires exactly one `batchLoadFn` call with all of them and fans the
 *  result back out per-key. A key not present in `batchLoadFn`'s result
 *  map resolves to `undefined` (not an error) — callers treat that as
 *  "no value", matching every "absence means empty" convention in
 *  `accessors.ts`. */
export function createBatchLoader<K, V>(
  batchLoadFn: (keys: readonly K[]) => Promise<ReadonlyMap<K, V>>,
): (key: K) => Promise<V | undefined> {
  let pendingKeys: K[] = [];
  let pendingDispatch: Promise<ReadonlyMap<K, V>> | null = null;

  function dispatch(): Promise<ReadonlyMap<K, V>> {
    const keys = pendingKeys;
    pendingKeys = [];
    pendingDispatch = null;
    return batchLoadFn(keys);
  }

  return (key: K): Promise<V | undefined> => {
    pendingKeys.push(key);
    pendingDispatch ??= Promise.resolve().then(dispatch);
    return pendingDispatch.then((result) => result.get(key));
  };
}

type NodeLoader = (id: string) => Promise<SupertagNodeRecord | undefined>;
type RelationLoader = (nodeID: string) => Promise<readonly string[] | undefined>;

const nodeLoaders = new WeakMap<GraphQLComposerContext, NodeLoader>();
const relationTargetLoaders = new WeakMap<GraphQLComposerContext, Map<string, RelationLoader>>();
const relationSourceLoaders = new WeakMap<GraphQLComposerContext, Map<string, RelationLoader>>();

/** The shared per-request node-hydration loader: every `entityReference`
 *  and backlink field resolver funnels its target/source ids through this
 *  ONE loader (regardless of which relation or field produced those ids),
 *  so a query touching several different relations across the same
 *  request still makes a single batched `getNodesWithFacts` call to
 *  hydrate all of them, not one per relation. */
export function nodeLoaderFor(ctx: GraphQLComposerContext): NodeLoader {
  let loader = nodeLoaders.get(ctx);
  if (!loader) {
    loader = createBatchLoader<string, SupertagNodeRecord>(async (ids) => {
      const nodes = await ctx.vault.getNodesWithFacts(ids);
      return new Map(nodes.map((node) => [node.id, node] as const));
    });
    nodeLoaders.set(ctx, loader);
  }
  return loader;
}

function relationLoaderFor(
  cache: WeakMap<GraphQLComposerContext, Map<string, RelationLoader>>,
  ctx: GraphQLComposerContext,
  relationID: string,
  fetch: (ids: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>,
): RelationLoader {
  let byRelation = cache.get(ctx);
  if (!byRelation) {
    byRelation = new Map();
    cache.set(ctx, byRelation);
  }
  let loader = byRelation.get(relationID);
  if (!loader) {
    loader = createBatchLoader<string, readonly string[]>(fetch);
    byRelation.set(relationID, loader);
  }
  return loader;
}

/** Forward-direction loader for one relation, scoped to one request —
 *  backs every `entityReference` field's generated resolver. */
export function relationTargetLoaderFor(ctx: GraphQLComposerContext, relationID: string): RelationLoader {
  return relationLoaderFor(relationTargetLoaders, ctx, relationID, (ids) =>
    ctx.vault.getRelationTargets(relationID, ids),
  );
}

/** Inverse-direction loader for one relation, scoped to one request —
 *  backs every generated backlink field's resolver. */
export function relationSourceLoaderFor(ctx: GraphQLComposerContext, relationID: string): RelationLoader {
  return relationLoaderFor(relationSourceLoaders, ctx, relationID, (ids) =>
    ctx.vault.getRelationSources(relationID, ids),
  );
}

/** Hydrates a list of node ids through the shared per-request node
 *  loader, dropping ids the accessor didn't return a record for (a
 *  dangling edge target — projection drift, not a GraphQL-layer error).
 *  Order follows `ids`' order (not the batched call's return order),
 *  since a relation field's item order is part of its contract. */
export async function hydrateNodes(ctx: GraphQLComposerContext, ids: readonly string[]): Promise<SupertagNodeRecord[]> {
  const loader = nodeLoaderFor(ctx);
  const records = await Promise.all(ids.map((id) => loader(id)));
  return records.filter((record): record is SupertagNodeRecord => record !== undefined);
}
