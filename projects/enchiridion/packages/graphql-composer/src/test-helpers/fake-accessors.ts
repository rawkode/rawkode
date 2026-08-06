// @enchiridion/graphql-composer — test-only `SupertagAccessors`.
//
// A tiny in-memory implementation of `accessors.ts`'s `SupertagAccessors`
// contract, over plain JS arrays — no VaultDO, no SQL, matching how
// `workers/vault/src/graphql/schema.test.ts` wires `VaultAccessors`
// directly to real functions rather than a live DO for its own tests (see
// that file's header). This is what `index.test.ts` executes real GraphQL
// queries against with `graphql()`, and every call is counted so batching
// behavior (plan Risk #11 — "one RPC per top-level GraphQL operation", the
// reason `request-loaders.ts` exists) is assertable, not just assumed.

import type { SupertagAccessors, SupertagListOptions, SupertagListResult, SupertagNodeRecord } from "../accessors";

export interface FakeNode {
  id: string;
  tagIDs: string[];
  createdAt: number;
  modifiedAt: number;
  deletedAt?: number | null;
  facts?: Record<string, unknown>;
}

export interface FakeEdge {
  relationID: string;
  sourceNodeID: string;
  targetNodeID: string;
}

function toRecord(node: FakeNode): SupertagNodeRecord {
  return {
    id: node.id,
    tagIDs: node.tagIDs,
    createdAt: node.createdAt,
    modifiedAt: node.modifiedAt,
    deletedAt: node.deletedAt ?? null,
    facts: node.facts ?? {},
  };
}

export class FakeAccessors implements SupertagAccessors {
  readonly callCounts = {
    getNodeWithFacts: 0,
    getNodesWithFacts: 0,
    listNodesByTag: 0,
    getRelationTargets: 0,
    getRelationSources: 0,
  };

  constructor(
    private readonly nodes: readonly FakeNode[],
    private readonly edges: readonly FakeEdge[] = [],
  ) {}

  async getNodeWithFacts(id: string): Promise<SupertagNodeRecord | undefined> {
    this.callCounts.getNodeWithFacts += 1;
    const node = this.nodes.find((candidate) => candidate.id === id);
    return node ? toRecord(node) : undefined;
  }

  async getNodesWithFacts(ids: readonly string[]): Promise<SupertagNodeRecord[]> {
    this.callCounts.getNodesWithFacts += 1;
    return this.nodes.filter((node) => ids.includes(node.id)).map(toRecord);
  }

  async listNodesByTag(tagID: string, options: SupertagListOptions = {}): Promise<SupertagListResult> {
    this.callCounts.listNodesByTag += 1;
    const matches = this.nodes
      .filter((node) => node.tagIDs.includes(tagID))
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((node) => !options.cursor || node.id > options.cursor);
    const limit = options.limit ?? 50;
    const page = matches.slice(0, limit);
    const nextCursor = matches.length > limit ? (page[page.length - 1]?.id ?? null) : null;
    return { items: page.map(toRecord), nextCursor };
  }

  async getRelationTargets(
    relationID: string,
    sourceNodeIDs: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    this.callCounts.getRelationTargets += 1;
    return this.groupEdges(relationID, sourceNodeIDs, "sourceNodeID", "targetNodeID");
  }

  async getRelationSources(
    relationID: string,
    targetNodeIDs: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    this.callCounts.getRelationSources += 1;
    return this.groupEdges(relationID, targetNodeIDs, "targetNodeID", "sourceNodeID");
  }

  private groupEdges(
    relationID: string,
    keys: readonly string[],
    keyField: "sourceNodeID" | "targetNodeID",
    valueField: "sourceNodeID" | "targetNodeID",
  ): ReadonlyMap<string, readonly string[]> {
    const map = new Map<string, string[]>();
    for (const key of keys) map.set(key, []);
    for (const edge of this.edges) {
      if (edge.relationID !== relationID) continue;
      const key = edge[keyField];
      if (!map.has(key)) continue;
      map.get(key)?.push(edge[valueField]);
    }
    return map;
  }
}
