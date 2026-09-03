// The Phase 0 exit criterion's live-subscription half (plan §"Verification": "a Layer.scoped
// service hands back a Collection.subscribe-backed RpcTarget stub to the client... confirm
// server-side Effect resources backing that subscription are actually released (not leaked)").
//
// Shape chosen (documented explicitly — this is a judgment call, not a literal transcription of
// any single precedent): `subscribeToNodes` returns a live `RpcTarget` with one method,
// `next(): Promise<NodesChangedEvent>`, that the client awaits in a loop. Each call resolves only
// once a change has actually happened (an `effect/Queue` fed by `typed-storage-effect`'s
// `Collection.subscribe`) — so from the caller's side this *is* server push, just expressed as a
// long-pending RPC call resolving rather than a server-initiated callback. This was chosen over
// cloudflare-os's own `subscribeToWorkpieces(subscriber: RpcStub<Subscriber>)` shape (server
// calls back into a client-supplied stub) because that pattern exists in cloudflare-os
// specifically to work around *native* Workers RPC lacking a session-abort disposal hook (see its
// inline TODO: "Implement onRpcBroken() in the built-in RPC system, matching Cap'n Web"). Cap'n
// Web — which this plan mandates as the transport — already has that hook built in (verified by
// reading its shipped source, `capnweb/dist/index-workers.js`): `RpcSession.abort()` runs
// `for (let i in this.exports) this.exports[i].hook.dispose()`, and `disposeRpcTarget()` calls
// `target[Symbol.dispose]()` when present. That fires both on a clean client-side
// `stub[Symbol.dispose]()` (refcounted export release) *and* on an abrupt disconnect (a WebSocket
// closing without a clean release aborts the whole session, which disposes every live export) —
// so implementing `[Symbol.dispose]()` on this class alone covers both halves of the exit
// criterion, with no extra liveness/heartbeat plumbing needed.

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { RpcTarget } from "capnweb"
import { NodesChangedEvent, type DomainError, type EntityId, type Node as NodeEntity } from "@athenaeum/domain"
import type { Subscriber } from "@athenaeum/typed-storage-effect"
import { reviveNode, toUnexpectedError, type WorkspaceCollections } from "./nodes-repository-live.js"

/**
 * Test-only instrumentation (plan's Verify stage: "assert... via an instrumentation hook you
 * add — e.g. a counter/flag the Effect resource's release logic increments, inspectable from the
 * test — that the server-side resource was actually released, not leaked"). `created` increments
 * once `NodesSubscription.create` has fully registered a live subscriber; `disposed` increments
 * only once the owned `Scope` this instance acquired its `Collection.subscribe` resource against
 * has actually *finished* closing (not merely been asked to close) — see `[Symbol.dispose]()`
 * below. Module-level and never reset: production code never reads this, only `backend`'s test
 * suite does, by diffing before/after counts around a scenario under test.
 */
export const subscriptionLifecycle = { created: 0, disposed: 0 }

/**
 * A live per-client subscription to one workspace's `nodes` collection. One instance is created per
 * `subscribeToNodes` call (see `workspace-durable-object.ts`) and returned across the Cap'n Web
 * boundary as a fresh `RpcTarget` export.
 *
 * Keeps its own in-memory `Map<id, Node>` for this workspace rather than re-querying
 * `Collection.byWorkspaceId` on every change notification. This isn't just an optimization: it fixes
 * a real correctness bug found while smoke-testing this file (documented in full at
 * `NodesSubscription.create` below) — `typed-storage-effect`'s raw `put()` notifies subscribers
 * *before* writing the primary record within the same transaction (by design, so index
 * maintenance stays transactionally consistent), so a subscriber that reacts by re-reading the
 * collection observes a torn state where the secondary index already points at the new record but
 * the primary key lookup for it doesn't resolve yet. The `add`/`update`/`remove` callbacks are
 * instead handed the actual mutated record directly — using that value, instead of re-querying,
 * is both correct and cheaper.
 */
export class NodesSubscription extends RpcTarget {
  readonly #queue: Queue.Queue<NodesChangedEvent>
  readonly #scope: Scope.CloseableScope
  #disposed = false

  private constructor(queue: Queue.Queue<NodesChangedEvent>, scope: Scope.CloseableScope) {
    super()
    this.#queue = queue
    this.#scope = scope
  }

  /**
   * Returns an Effect program (not a bare `Promise`) that builds a live subscription, so its
   * caller (`workspace-durable-object.ts`'s `subscribeToNodes`) can run it through the same
   * `rpc-boundary.ts` throw-boundary conversion (`runOrThrowRpcError`) every other RPC method
   * uses, instead of this class running `Effect.runPromise` on its own storage reads and letting a
   * real failure (e.g. a `TypedStorageError` from `byWorkspaceId.get`) cross the Cap'n Web boundary as
   * a raw/opaque rejection instead of a typed `{tag, message, data}` envelope. Fixed in response to
   * review: this used to be `static async create(...): Promise<NodesSubscription>` running several
   * `Effect.runPromise` calls internally.
   */
  static create(
    collections: WorkspaceCollections,
    workspaceId: EntityId
  ): Effect.Effect<NodesSubscription, DomainError> {
    return Effect.gen(function* () {
      const queue = yield* Queue.unbounded<NodesChangedEvent>()
      const scope = yield* Scope.make()

      // Seed the in-memory view from storage once, up front — the one place this subscription
      // reads the collection rather than tracking it incrementally. Safe here specifically because
      // there's no concurrent write in flight yet (the subscriber below isn't registered until
      // after this resolves), so there's no torn-transaction window to race.
      //
      // Pending-record filter (web-stage fix, found by real browser verification of the Phase 3
      // chat UI: a `createNode` agent-tool call showed up in this live list immediately, before
      // `mergeChanges` — contradicting `node.ts`'s own `PendingMarker` doc comment, "invisible to
      // mainline reads... until accepted", and `nodes-repository-live.ts`'s `.list()`, which
      // *does* filter `node.pending === undefined`). This subscription predates the pending
      // mechanism and reads/tracks the raw `nodes` collection directly rather than going through
      // `NodesRepository.list()`, so it never picked up that filter — same condition applied here,
      // at both the initial seed and every subsequent add/update/remove event, so a pending node
      // never enters `nodesById` until the record it's built from no longer carries `pending`
      // (i.e. `mergeChanges` promoted it via `nodesRepository.put`, observed here as an `update`
      // where `oldRecord.pending !== undefined && newRecord.pending === undefined`).
      const initial = yield* collections.nodes.byWorkspaceId.get(workspaceId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap((raw) => Effect.forEach(raw, reviveNode))
      )
      const nodesById = new Map<EntityId, NodeEntity>(
        initial.filter((node) => node.pending === undefined).map((node) => [node.id, node])
      )

      const pushSnapshot = () => {
        Effect.runSync(
          Queue.offer(queue, new NodesChangedEvent({ workspaceId, nodes: Array.from(nodesById.values()) }))
        )
      }

      /** "Visible" to this subscription = in this workspace and not (still) pending — see the
       *  pending-record filter comment above `initial`/`nodesById`. */
      const isVisible = (record: NodeEntity): boolean => record.workspaceId === workspaceId && record.pending === undefined

      const rawSubscriber: Subscriber<NodeEntity> = {
        add: (record) => {
          if (!isVisible(record)) return
          nodesById.set(record.id, Effect.runSync(reviveNode(record)))
          pushSnapshot()
        },
        update: (oldRecord, newRecord) => {
          const wasVisible = isVisible(oldRecord)
          const nowVisible = isVisible(newRecord)
          if (!wasVisible && !nowVisible) return
          if (wasVisible && !nowVisible) {
            nodesById.delete(oldRecord.id)
          } else {
            nodesById.set(newRecord.id, Effect.runSync(reviveNode(newRecord)))
          }
          pushSnapshot()
        },
        remove: (record) => {
          if (record.workspaceId !== workspaceId) return
          nodesById.delete(record.id)
          pushSnapshot()
        }
      }

      // Push the seeded snapshot first, then subscribe — both synchronous over the same DO tick
      // (no `yield*` between them), so there's no window for a write to land between "read
      // current state" and "start watching for future writes".
      pushSnapshot()
      yield* collections.nodes.subscribe(rawSubscriber).pipe(Scope.extend(scope))

      subscriptionLifecycle.created++
      return new NodesSubscription(queue, scope)
    })
  }

  /** Awaits the next change. Resolves only once a `NodesChangedEvent` is available — this is the
   *  "live push" half of the exit criterion, expressed as a pending RPC call. Rejects if the
   *  subscription is disposed while a call is pending, since `[Symbol.dispose]()` shuts the queue
   *  down (an infrastructure condition, not a `DomainError` — it doesn't go through the
   *  `RpcErrorEnvelope` convention). */
  async next(): Promise<unknown> {
    const event = await Effect.runPromise(Queue.take(this.#queue))
    return Schema.encodeSync(NodesChangedEvent)(event)
  }

  /**
   * The disposal hook Cap'n Web invokes automatically (see the module doc comment above) both on
   * a clean `stub[Symbol.dispose]()` from the client and on session abort from an abrupt
   * disconnect. Idempotent (a session abort could in principle race a client's own dispose).
   */
  [Symbol.dispose](): void {
    if (this.#disposed) return
    this.#disposed = true
    // `Effect.runPromise` here (not `runFork`, as `Queue.shutdown` below still uses) specifically
    // so `subscriptionLifecycle.disposed` only increments once the scope has actually *finished*
    // closing (running `Collection.subscribe`'s release, which calls the raw collection's
    // `unsubscribe`) — proof the resource was released, not just that release was requested. Still
    // fire-and-forget from `[Symbol.dispose]()`'s own (synchronous, per Cap'n Web's disposal
    // contract) point of view.
    void Effect.runPromise(Scope.close(this.#scope, Exit.void)).then(() => {
      subscriptionLifecycle.disposed++
    })
    Effect.runFork(Queue.shutdown(this.#queue))
  }
}
