// VaultDO — one per vault (plan §Backend architecture).
//
// This class is deliberately thin: every real decision (SQL validation,
// message parsing, catalog/tombstone logic, write-model steps, resumable
// rebuild batching) lives in a plain, DO-runtime-independent module this
// file imports and wires together — see each import's own file for its
// real logic and tests. That split exists
// specifically so the logic is unit-testable with `bun test` against
// `SqliteStorageAdapter` (a real `bun:sqlite` database) and real
// `loro-crdt` docs, without needing a live Workers runtime
// (`wrangler dev`) that this sandbox doesn't have network/account access
// to drive. This file itself — the `DurableObject` subclass, its
// `fetch`/`webSocketMessage`/`alarm` overrides, WebSocket Hibernation API
// usage — is NOT exercised by `bun test` for that reason; it should be
// smoke-tested with `wrangler dev` before this ships (see the task
// report).
//
// Sync protocol wire shape: see `sync-protocol.ts`'s file header for the
// full spec. Message handling below follows it message-for-message.

import { DurableObject } from "cloudflare:workers";
import {
  readBackupCheckpoint,
  restoreVaultFromBackup,
  runBackupBatch,
  startBackup,
  type RestoreResult,
} from "./backup";
import { handleBlobDownload, handleBlobUpload } from "./blob-routes";
import { type BlobGcResult, sweepBlobGarbage } from "./blob-store";
import { readCatalogFromSql, VAULT_META_PAGE_ID } from "./catalog";
import { listStoredPageIds } from "./doc-store";
import { BoundedQueryError, runBoundedQuery, type BoundedQueryResult } from "./query-rpc";
import {
  getPage as accessorGetPage,
  getPages as accessorGetPages,
  listPages as accessorListPages,
  type ListPagesOptions,
  type ListPagesResult,
  type PageAccessorRow,
} from "./query-accessors";
import type { R2BucketLike } from "./r2-types";
import { readCheckpoint, runRebuildBatch, startRebuild } from "./rebuild-projections";
import { installSupertagRegistryProjection } from "./registry-projection";
import { initializeSchema, PROJECTION_VIEW_NAMES, type SqlExecutor } from "./schema";
import type { SupertagListOptions, SupertagListResult, SupertagNodeRecord } from "@enchiridion/graphql-composer";
import {
  getNodeWithFacts as accessorGetNodeWithFacts,
  getNodesWithFacts as accessorGetNodesWithFacts,
  getRelationSources as accessorGetRelationSources,
  getRelationTargets as accessorGetRelationTargets,
  listNodesByTag as accessorListNodesByTag,
  type SupertagAccessorFilterOptions,
} from "./supertag-accessors";
import type { SqlQueryLimits } from "./sql-validator";
import type {
  CreateOrUpdatePageParams,
  CreateOrUpdatePageResult,
  TombstonePageParams,
  TombstonePageResult,
} from "@enchiridion/vault-rpc-contract";
import {
  base64ToBytes,
  bytesToBase64,
  decodeSyncMessage,
  encodeSyncMessage,
  SyncProtocolDecodeError,
  type SyncProtocolMessage,
} from "./sync-protocol";
import {
  applyInboundCatalogEntries,
  applyInboundDocBytes,
  catalogSnapshotForWire,
  computeDocSyncResponse,
  createOrUpdatePage as writeModelCreateOrUpdatePage,
  healPageDriftIfNeeded,
  tombstonePage as writeModelTombstonePage,
  undeletePage as writeModelUndeletePage,
} from "./vault-write-model";

interface Env {
  VAULT_DO: DurableObjectNamespace;
  BLOBS: R2Bucket;
}

// NOTE on reprojection timing — no debounce scheduler is wired in here.
// `vault-write-model.ts`'s `createOrUpdatePage`/`applyInboundDocBytes`
// (and the tombstone/undelete paths) already reproject SYNCHRONOUSLY,
// inside the SAME `ctx.storage.transactionSync(...)` call as the
// doc-storage write — stronger correctness than a debounced design (plan
// §Backend architecture: "the implementation ended up stronger than the
// original 'debounced' design ... closes the crash-between-write-and-
// projection window entirely, which a debounce timer can't"). Calling
// `ReprojectionScheduler.schedule()`/`.flush()` after one of those
// transactions already committed a fresh projection would be a redundant
// no-op on every real write path — this file used to do exactly that
// (removed as dead-code cleanup). `reprojection-scheduler.ts` itself is
// kept in the codebase, unmodified, as a documented P1+ optimization to
// reintroduce once more projection tables are populated and per-write
// cost grows enough to matter; its own tests
// (`reprojection-scheduler.test.ts`) still exercise the module in
// isolation. Do NOT re-add `.schedule()`/`.flush()` calls here without
// also removing the synchronous in-transaction reprojection this design
// currently relies on — having both would be the "two mechanisms, only
// one documented" gap an earlier review caught, not a valid dual-path
// design.
//
// NOTE on compaction timing — same shape, different trigger. Those same
// `vault-write-model.ts` write paths also call `doc-store.ts`'s
// `maybeCompact` right after persisting each write's delta, inside the same
// transaction — a pending-update-COUNT threshold check
// (`COMPACTION_PENDING_UPDATE_THRESHOLD`), not a timer, so it needs no
// alarm/debounce wiring here either. Previously `compactDoc` was only ever
// invoked from `backup.ts`'s restore path, which meant `doc_pending_updates`
// grew unbounded for a live vault's whole lifetime and a live doc could
// never satisfy `loro-storage.ts`'s `needsFullSnapshotFor` compaction-
// horizon check (`doc.isShallow()` stayed false forever outside restore) —
// see `doc-store.ts`'s `maybeCompact` doc comment for the full picture.

/** How many pages `rebuild-projections.ts` processes per alarm firing —
 *  small enough that a batch comfortably finishes well inside a Workers
 *  CPU-time slice even for large/complex docs. */
const REBUILD_BATCH_SIZE = 50;

/** Re-arm delay between rebuild alarm firings — short, since each firing
 *  does bounded work and yields back to the runtime immediately after
 *  (plan: "driven by a DO alarm loop", i.e. many small firings, not one
 *  long-running alarm handler). */
const REBUILD_ALARM_INTERVAL_MS = 100;

const DEFAULT_ALLOWED_QUERY_SOURCES = new Set<string>(PROJECTION_VIEW_NAMES);

export class VaultDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeSchema(this.sql);

    this.ctx.blockConcurrencyWhile(async () => {
      // Plan §Backend architecture: "VaultDO reconciles module projection
      // views on boot" — installs the loaded `SupertagRegistry`'s schema
      // DAG (`graph_tags`/`graph_tag_parents`/`graph_tag_closure`/
      // `graph_relation_definitions`) wholesale. Idempotent, and must run
      // BEFORE any page reprojection below (or any RPC call, since this is
      // inside `blockConcurrencyWhile`): the public `graph_edges` VIEW
      // INNER JOINs `_graph_edges` against `graph_relation_definitions`,
      // so an edge whose relation isn't installed yet would silently
      // vanish from every query against it.
      this.ctx.storage.transactionSync(() => {
        installSupertagRegistryProjection(this.sql);
      });

      // Plan: "On DO startup/first request, compare a stored
      // `lastProjectedVersion` against actual doc state and auto-heal
      // drift by reprojecting anything behind." Bounded pass over every
      // stored page id — acceptable synchronously at P0/single-vault
      // scale; if vault size ever makes this a real cost, it becomes a
      // candidate for the same alarm-batched treatment as
      // `rebuild-projections.ts`, but unlike a full rebuild this only does
      // real work for pages that are ACTUALLY behind (most boots do zero
      // reprojections).
      this.healAllDriftOnBoot();
    });
  }

  private get sql(): SqlExecutor {
    // `DurableObjectStorage.sql` (`@cloudflare/workers-types`) is
    // structurally identical to this worker's own `SqlExecutor` (see
    // `schema.ts`) — same `exec(query, ...bindings)` signature — so no
    // adapting is needed here, only a cast to the narrower interface the
    // rest of this worker's modules are written against (which is also
    // what lets those modules be tested against
    // `test-helpers/sqlite-storage-adapter.ts` instead).
    return this.ctx.storage.sql as unknown as SqlExecutor;
  }

  /** Same cast pattern as `sql` above, for the same reason — see
   *  `r2-types.ts`'s file header: a real `env.BLOBS: R2Bucket` value
   *  satisfies `R2BucketLike` structurally (it has strictly more
   *  fields/methods than the narrowed interface requires), so this is a
   *  type-level narrowing cast, not a behavioral adapter. */
  private get blobs(): R2BucketLike {
    return this.env.BLOBS as unknown as R2BucketLike;
  }

  private healAllDriftOnBoot(): void {
    let after: string | undefined;
    for (;;) {
      const batch = listStoredPageIds(this.sql, after, 200);
      if (batch.length === 0) break;
      this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        for (const pageID of batch) {
          healPageDriftIfNeeded(this.sql, pageID, now);
        }
      });
      after = batch[batch.length - 1];
      if (batch.length < 200) break;
    }
  }

  // ---------------------------------------------------------------------
  // WebSocket sync protocol (Hibernation API)
  // ---------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    // Access service-token auth (plan P0 "Access service-token auth incl.
    // WebSocket upgrade", Risk #7) happens at the edge (Cloudflare Access
    // itself) AND, as of this pass, again in `index.ts` (`verifyAccessRequest`,
    // `./access-auth.ts`) before a request is ever forwarded into this DO
    // — see `index.ts`'s `/sync` and `/blobs/*` route comments. This
    // method assumes it's already been authenticated; it does not itself
    // re-check (VaultDO has no request-level concept of Access — that's
    // deliberately kept in the plain worker's fetch handler, which is the
    // only place with a `Request` object before the WS upgrade or blob
    // dispatch happens).

    // R2 blob routes (plan §Backend architecture, "Blobs (R2)") — `index.ts`
    // forwards `/blobs/*` requests here the same way it forwards `/sync`
    // (`stub.fetch(request)`), because the pending-blob-references
    // bookkeeping these routes do (`blob-store.ts`) needs this DO's own SQL
    // storage; see `blob-routes.ts`'s file header for the full route
    // contract. Checked BEFORE the WebSocket-upgrade check below since a
    // blob PUT/GET is an ordinary HTTP request, never an Upgrade request.
    const url = new URL(request.url);
    if (url.pathname.startsWith("/blobs/")) {
      return this.handleBlobRequest(request, url);
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade request", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API — NOT `server.accept()` + a permanently-referenced
    // `addEventListener` handler (plan: "WebSocket Hibernation API from
    // day one ... resumable from durable state only (no in-memory
    // handshake progress), so the DO scales to zero between edits").
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let parsed: SyncProtocolMessage;
    try {
      parsed = decodeSyncMessage(message);
    } catch (error) {
      // "Malformed frame from the server: drop it rather than tearing
      // down the connection" — same stance the Swift client takes
      // (VaultSyncClient.swift:203-210), applied symmetrically here.
      if (error instanceof SyncProtocolDecodeError) return;
      throw error;
    }

    const now = Date.now();

    switch (parsed.type) {
      case "catalogRequest": {
        const entries = this.ctx.storage.transactionSync(() => catalogSnapshotForWire(this.sql));
        this.send(ws, { type: "catalogDiff", entries });
        return;
      }

      case "catalogDiff": {
        // Inbound: a peer pushing entries it believes this DO is missing
        // or has stale (see sync-protocol.ts's file header on this being
        // bidirectional). Applied entries whose projection rows need
        // purging (newly tombstoned) are handled inside
        // `applyInboundCatalogEntries` itself.
        const applied = this.ctx.storage.transactionSync(() =>
          applyInboundCatalogEntries(this.sql, parsed.entries, now),
        );
        // Relay to other online peers so they learn about a new/changed
        // page immediately, not just on their next `catalogRequest`.
        if (applied.length > 0) {
          this.broadcast(ws, { type: "catalogDiff", entries: applied });
        }
        return;
      }

      case "docVersionVector": {
        const peerVV = base64ToBytes(parsed.versionVector);
        const response = this.ctx.storage.transactionSync(() =>
          computeDocSyncResponse(this.sql, parsed.pageID, peerVV),
        );
        if (response.kind === "fullSnapshot") {
          this.send(ws, {
            type: "docFullSnapshot",
            pageID: parsed.pageID,
            bytes: bytesToBase64(response.bytes),
          });
        } else {
          this.send(ws, {
            type: "docUpdate",
            pageID: parsed.pageID,
            bytes: bytesToBase64(response.bytes),
          });
        }
        return;
      }

      case "docUpdate":
      case "docFullSnapshot": {
        // Identical handling — see `applyInboundDocBytes`'s doc comment
        // on why the wire message type doesn't matter once decoded to
        // bytes. Both doc-storage persistence AND the projection-table
        // refresh happen synchronously, inside this same transaction —
        // see this file's "NOTE on reprojection timing" header comment.
        const bytes = base64ToBytes(parsed.bytes);
        const result = this.ctx.storage.transactionSync(() =>
          applyInboundDocBytes(this.sql, parsed.pageID, bytes, now),
        );
        if (result.applied) {
          // Reprojection already happened synchronously inside
          // `applyInboundDocBytes`'s own transaction above — see this
          // file's "NOTE on reprojection timing" header comment. No
          // scheduler call needed here.
          this.broadcast(ws, parsed);
        }
        return;
      }

      case "tombstone": {
        const updated = this.ctx.storage.transactionSync(() =>
          parsed.undelete
            ? writeModelUndeletePage(this.sql, parsed.pageID, now)
            : writeModelTombstonePage(this.sql, parsed.pageID, now),
        );
        if (updated) {
          this.broadcast(ws, parsed);
        }
        return;
      }

      default: {
        const _exhaustive: never = parsed;
        return _exhaustive;
      }
    }
  }

  override async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Hibernation API: no in-memory per-connection state to tear down —
    // every message handler above reads/writes durable state fresh each
    // time, never anything keyed off the live `WebSocket` object beyond
    // "which socket to reply to right now".
  }

  override async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Same reasoning as webSocketClose — nothing to clean up.
  }

  private send(ws: WebSocket, message: SyncProtocolMessage): void {
    ws.send(encodeSyncMessage(message));
  }

  /** Relays a doc/tombstone change to every OTHER connected device for
   *  this vault — real-time propagation for peers who are online right
   *  now, distinct from a peer that was offline catching up via
   *  `catalogRequest`/`docVersionVector` on its next connect. */
  private broadcast(sender: WebSocket, message: SyncProtocolMessage): void {
    const encoded = encodeSyncMessage(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === sender) continue;
      try {
        socket.send(encoded);
      } catch {
        // A socket that can't accept a send right now (closing, etc.) —
        // its owner will catch up via the catalog/version-vector exchange
        // on its next connect; not this call's problem to retry.
      }
    }
  }

  // ---------------------------------------------------------------------
  // R2 blob routes — see blob-routes.ts's file header for the route
  // contract this dispatches into.
  // ---------------------------------------------------------------------

  private async handleBlobRequest(request: Request, url: URL): Promise<Response> {
    const blobID = url.pathname.slice("/blobs/".length);

    if (request.method === "PUT") {
      const result = await handleBlobUpload(request, blobID, this.sql, this.blobs, Date.now());
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "GET") {
      const result = await handleBlobDownload(blobID, this.blobs);
      if (result.status !== 200) {
        return new Response(JSON.stringify(result.errorBody), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(result.body, { status: 200, headers: result.headers });
    }

    return new Response("method not allowed", { status: 405 });
  }

  // ---------------------------------------------------------------------
  // Alarm: resumable rebuild-projections batches, then (once no rebuild is
  // running) resumable backup-export batches — see backup.ts's file header
  // on why runBackupBatch is async and therefore NOT wrapped in
  // ctx.storage.transactionSync the way runRebuildBatch is.
  // ---------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const rebuildCheckpoint = readCheckpoint(this.sql);
    if (rebuildCheckpoint && rebuildCheckpoint.status === "running") {
      const result = this.ctx.storage.transactionSync(() =>
        runRebuildBatch(
          this.sql,
          (after, limit) => listStoredPageIds(this.sql, after, limit),
          (pageID) => healPageDriftIfNeeded(this.sql, pageID, Date.now()),
          Date.now(),
          REBUILD_BATCH_SIZE,
        ),
      );
      if (result.hasMore) {
        await this.ctx.storage.setAlarm(Date.now() + REBUILD_ALARM_INTERVAL_MS);
      }
      return;
    }

    const backupCheckpoint = readBackupCheckpoint(this.sql);
    if (backupCheckpoint && backupCheckpoint.status === "running") {
      const result = await runBackupBatch(
        this.sql,
        this.blobs,
        (after, limit) => listStoredPageIds(this.sql, after, limit),
        Date.now(),
        REBUILD_BATCH_SIZE,
      );
      if (result.hasMore) {
        await this.ctx.storage.setAlarm(Date.now() + REBUILD_ALARM_INTERVAL_MS);
      }
      return;
    }
  }

  // ---------------------------------------------------------------------
  // RPC surface
  // ---------------------------------------------------------------------

  /** Bounded query surface (plan §Backend architecture, "Bounded query
   *  surface") — see `query-rpc.ts`/`sql-validator.ts` for the real
   *  validation/execution logic and their extensive header comments on
   *  what this is (and, importantly, is NOT) a security boundary against.
   *  Shared substrate for the future vault GraphQL subgraph's resolvers
   *  (task #9), the assistant (P5), and gadget `graph.query` capabilities
   *  (P4, each with a narrower view allowlist than the default here). */
  async query(
    sql: string,
    args: unknown[] = [],
    limits?: Partial<SqlQueryLimits>,
  ): Promise<BoundedQueryResult> {
    try {
      return this.ctx.storage.transactionSync(() =>
        runBoundedQuery(this.sql, sql, args, { allowedSources: DEFAULT_ALLOWED_QUERY_SOURCES, limits }),
      );
    } catch (error) {
      if (error instanceof BoundedQueryError) {
        throw error;
      }
      throw new BoundedQueryError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Typed, batched accessor RPC — plan §Backend architecture, "Query
   *  surfaces — two, not one" (#2): a separate, narrower surface from
   *  `query()` above, purpose-built for GraphQL resolver use. See
   *  `query-accessors.ts` for the real SQL and its own extensive header
   *  comment; `src/graphql/yoga.ts` is what actually calls this RPC method
   *  (adapting it to the `VaultAccessors` shape `src/graphql/schema.ts`'s
   *  resolvers are written against). */
  async getPage(id: string): Promise<PageAccessorRow | undefined> {
    return this.ctx.storage.transactionSync(() => accessorGetPage(this.sql, id));
  }

  /** Batched sibling of `getPage` — see `query-accessors.ts`'s `getPages`
   *  doc comment on why this exists ahead of any P0 resolver actually
   *  needing it (plan Risk #11, "DO-RPC-per-field N+1"). */
  async getPages(ids: string[]): Promise<PageAccessorRow[]> {
    return this.ctx.storage.transactionSync(() => accessorGetPages(this.sql, ids));
  }

  async listPages(options: ListPagesOptions = {}): Promise<ListPagesResult> {
    return this.ctx.storage.transactionSync(() => accessorListPages(this.sql, options));
  }

  /** Typed, batched SUPERTAG accessor RPC — plan §Backend architecture,
   *  "Query surfaces — two, not one" (#2), generalized from `Page`'s fixed
   *  columns to every supertag's effective field set. See
   *  `supertag-accessors.ts` for the real SQL; `graphql/composed-schema.ts`
   *  adapts these RPC methods to `@enchiridion/graphql-composer`'s
   *  `SupertagAccessors` contract, the same way `graphql/yoga.ts` already
   *  adapts `getPage`/`listPages` to `VaultAccessors` above.
   *
   *  `options` (new — P4 adversarial-review privacy-gate fix, plan
   *  §Gadgets) is OPTIONAL and additive: `graphql/yoga.ts`'s adapter (the
   *  trusted device/native-app GraphQL read path) calls these three
   *  methods with no second argument at all, so it is byte-for-byte
   *  unaffected by this change and keeps seeing every Person page
   *  (including `"other"`-visibility calendar attendees — the user's own
   *  app legitimately needs those for normal calendar display).
   *  `workers/gadget-host/src/vault-accessor-client.ts`'s cross-DO binding
   *  (backing `graph-query-views.ts`'s `nodeWithFacts`/`nodesWithFacts`/
   *  `nodesByTag` gadget capability views) is the one caller that passes
   *  `{ excludePersonVisibility: ["other"] }` explicitly. See
   *  `supertag-accessors.ts`'s "PRIVACY-GATE FILTERING BOUNDARY" header
   *  addendum for the full rationale on why the filter lives here (an
   *  opt-in accessor parameter) rather than as a blanket exclusion. */
  async getNodeWithFacts(
    id: string,
    options?: SupertagAccessorFilterOptions,
  ): Promise<SupertagNodeRecord | undefined> {
    return this.ctx.storage.transactionSync(() => accessorGetNodeWithFacts(this.sql, id, options));
  }

  /** Batched sibling of `getNodeWithFacts` — plan Risk #11. Same `options`
   *  contract as `getNodeWithFacts` above. */
  async getNodesWithFacts(ids: string[], options?: SupertagAccessorFilterOptions): Promise<SupertagNodeRecord[]> {
    return this.ctx.storage.transactionSync(() => accessorGetNodesWithFacts(this.sql, ids, options));
  }

  /** Same `options` contract as `getNodeWithFacts` above — merged into the
   *  existing `SupertagListOptions` (`limit`/`cursor`) rather than a
   *  separate parameter, since both are optional bag-of-fields inputs to
   *  the same call. */
  async listNodesByTag(
    tagID: string,
    options: SupertagListOptions & SupertagAccessorFilterOptions = {},
  ): Promise<SupertagListResult> {
    return this.ctx.storage.transactionSync(() => accessorListNodesByTag(this.sql, tagID, options));
  }

  /** Returns a plain `Record`, not a `Map` — Workers RPC serializes a
   *  method's return value over a structured-clone-like wire format;
   *  `@enchiridion/graphql-composer`'s `SupertagAccessors.getRelationTargets`
   *  contract wants a `ReadonlyMap`, so `graphql/composed-schema.ts`'s
   *  adapter converts this back to one at the boundary — keeping the RPC
   *  method's own wire shape a plain object avoids depending on Map's
   *  structured-clone support across that hop, matching every other RPC
   *  method on this class (all return plain arrays/objects, never Map/Set). */
  async getRelationTargets(relationID: string, sourceNodeIDs: string[]): Promise<Record<string, string[]>> {
    return this.ctx.storage.transactionSync(() =>
      Object.fromEntries(accessorGetRelationTargets(this.sql, relationID, sourceNodeIDs)),
    );
  }

  async getRelationSources(relationID: string, targetNodeIDs: string[]): Promise<Record<string, string[]>> {
    return this.ctx.storage.transactionSync(() =>
      Object.fromEntries(accessorGetRelationSources(this.sql, relationID, targetNodeIDs)),
    );
  }

  /** Write-model RPC — plan §"Writes are RPC, not GraphQL mutations":
   *  "VaultDO's own RPC methods ... ARE its write-model". See
   *  `vault-write-model.ts`'s `createOrUpdatePage` for the real logic;
   *  `updateBytes` is a Loro update or snapshot blob (base64-decoded
   *  bytes — matching the sync protocol's own `docUpdate`/
   *  `docFullSnapshot` payload encoding, so a client's outbox can reuse
   *  the exact same encoding for both the WebSocket path and this direct
   *  RPC path). */
  // Signature routed through `@enchiridion/vault-rpc-contract`'s
  // `CreateOrUpdatePageParams`/`CreateOrUpdatePageResult` (destructured rest
  // parameter, so this remains a real 3-arg method at the RPC layer, not an
  // options bag) — see that package's file header for why: VaultDO is the
  // enforced source of truth for this contract, so a future signature
  // change here that isn't mirrored in the shared package fails THIS
  // worker's own `tsc --build`, and `workers/gatekeeper-google`'s
  // `vault-client.ts` (which imports the same types) gets a compile-time
  // error instead of silently drifting.
  async createOrUpdatePage(
    ...[pageID, docType, updateBytesBase64]: CreateOrUpdatePageParams
  ): Promise<CreateOrUpdatePageResult> {
    const bytes = base64ToBytes(updateBytesBase64);
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() =>
      writeModelCreateOrUpdatePage(this.sql, pageID, docType, bytes, now),
    );
    if (result.applied) {
      // `writeModelCreateOrUpdatePage` already reprojected synchronously
      // inside the transaction above — an RPC caller already sees fresh
      // data with no further flush needed. See this file's "NOTE on
      // reprojection timing" header comment.
      this.broadcastToAll({ type: "docUpdate", pageID, bytes: updateBytesBase64 });
    }
    return { applied: result.applied };
  }

  // Same shared-contract routing as `createOrUpdatePage` above — see its
  // comment for the full rationale.
  async tombstonePage(...[pageID]: TombstonePageParams): Promise<TombstonePageResult> {
    const now = Date.now();
    const updated = this.ctx.storage.transactionSync(() => writeModelTombstonePage(this.sql, pageID, now));
    if (updated) {
      this.broadcastToAll({ type: "tombstone", pageID, undelete: false });
    }
    return { tombstoned: updated !== undefined };
  }

  async undeletePage(pageID: string): Promise<{ undeleted: boolean }> {
    const now = Date.now();
    const updated = this.ctx.storage.transactionSync(() => writeModelUndeletePage(this.sql, pageID, now));
    if (updated) {
      this.broadcastToAll({ type: "tombstone", pageID, undelete: true });
    }
    return { undeleted: updated !== undefined };
  }

  /** Starts (or restarts) a full projection rebuild — plan: "resumable —
   *  checkpointed by pageID, driven by a DO alarm loop (not one
   *  synchronous pass over every doc)". This method only arms the first
   *  alarm; `alarm()` above does the actual batched work, re-arming
   *  itself until `rebuild-projections.ts`'s checkpoint reports
   *  `hasMore: false`. */
  async rebuildProjections(): Promise<{ started: boolean }> {
    this.ctx.storage.transactionSync(() => {
      startRebuild(this.sql, Date.now());
    });
    await this.ctx.storage.setAlarm(Date.now());
    return { started: true };
  }

  async rebuildProjectionsStatus(): Promise<ReturnType<typeof readCheckpoint>> {
    return this.ctx.storage.transactionSync(() => readCheckpoint(this.sql));
  }

  /** Admin/telemetry RPC — plan Risk #4: "expose size telemetry (doc
   *  bytes / projection bytes / FTS bytes) via admin RPC from P0". Coarse
   *  (whole-database size, not broken out by table) because DO SQLite's
   *  `SqlStorage.databaseSize` (`@cloudflare/workers-types`) only exposes
   *  a total; a per-table breakdown would need summing `length(blob-ish
   *  columns)` per table, which is real work worth its own pass rather
   *  than guessing at here. */
  async storageTelemetry(): Promise<{ databaseSizeBytes: number; pageCount: number }> {
    return {
      databaseSizeBytes: this.ctx.storage.sql.databaseSize,
      pageCount: listStoredPageIds(this.sql, undefined, 1_000_000).length,
    };
  }

  /** On-demand admin RPC — plan §Backend architecture, "Blobs (R2)" GC
   *  rule. See `blob-store.ts`'s file header for why this P0 pass chooses
   *  on-demand-admin-RPC over a cron trigger, and why `dryRun` defaults to
   *  `true` (task brief: "do not delete anything in this P0 pass without
   *  an explicit dry-run mode"). */
  async blobGcSweep(options?: { dryRun?: boolean; graceWindowMs?: number }): Promise<BlobGcResult> {
    return sweepBlobGarbage(this.sql, this.blobs, {
      now: Date.now(),
      dryRun: options?.dryRun,
      graceWindowMs: options?.graceWindowMs,
    });
  }

  /** Starts (or restarts) a nightly backup export — plan §Backend
   *  architecture, "Backup / disaster recovery". Called from `index.ts`'s
   *  `scheduled()` cron handler (`triggers.crons` in `wrangler.jsonc`); can
   *  also be invoked directly for an on-demand backup or by the restore
   *  drill test. Mirrors `rebuildProjections()` above: only arms the first
   *  alarm, `alarm()` does the actual batched work. `timestamp` defaults to
   *  "now" (ISO-8601) if not given — pass one explicitly to make a run's
   *  identifier deterministic in tests. */
  async runBackupExport(timestamp?: string): Promise<{ started: boolean; timestamp: string }> {
    const ts = timestamp ?? new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      startBackup(this.sql, ts, Date.now());
    });
    await this.ctx.storage.setAlarm(Date.now());
    return { started: true, timestamp: ts };
  }

  async backupExportStatus(): Promise<ReturnType<typeof readBackupCheckpoint>> {
    return this.ctx.storage.transactionSync(() => readBackupCheckpoint(this.sql));
  }

  /** The restore side of the P0 "backup restore drill" (plan
   *  §Verification) — see `backup.ts`'s `restoreVaultFromBackup` for the
   *  real logic. Not alarm-batched (unlike export): a restore is a rare,
   *  operator-initiated disaster-recovery action, not routine background
   *  work, and `RESTORE_RUNBOOK.md` documents calling this directly. */
  async restoreFromBackup(timestamp: string): Promise<RestoreResult> {
    return restoreVaultFromBackup(this.sql, this.blobs, timestamp, Date.now());
  }

  private broadcastToAll(message: SyncProtocolMessage): void {
    const encoded = encodeSyncMessage(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(encoded);
      } catch {
        // Best-effort — see `broadcast`'s identical note.
      }
    }
  }
}
