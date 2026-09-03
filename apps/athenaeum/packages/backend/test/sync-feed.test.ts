// Storage/Views stage verification: "syncFeed pages correctly and epoch rotation correctly
// invalidates a stale cursor" (task's own smoke-test checklist), exercising the real
// `(replicaEpoch, monotonicCounter)`-sequenced structured-record feed (task item 6).

import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  AddFactInput,
  AddFactOutput,
  CreateNodeInput,
  CreateNodeOutput,
  EntityId,
  HumanUiMutationAttribution,
  RotateEpochInput,
  RotateEpochOutput,
  SyncFeedInput,
  SyncFeedOutput
} from "@athenaeum/domain"
import { connectToWorkspace, connectToWorkspaceWithSocketAs, devSignIn, freshWorkspaceId } from "./support.js"

const webFieldAttribution = () => new HumanUiMutationAttribution({
  version: "athenaeum.mutation-attribution.v1",
  kind: "humanUi",
  surface: "web-supertag-field-editor"
})

describe("syncFeed: append-only structured-record feed, paged by cursor", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("records one feed entry per node mutation and pages through them in order", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const titles = ["First", "Second", "Third", "Fourth", "Fifth"]
    for (const title of titles) {
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title })))
    }

    const firstPage = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 2 })))
    )
    expect(firstPage.epochMismatch).toBe(false)
    expect(firstPage.entries).toHaveLength(2)
    expect(firstPage.entries.every((e) => e.entityKind === "node")).toBe(true)
    expect(firstPage.entries[0]!.monotonicCounter).toBeLessThan(firstPage.entries[1]!.monotonicCounter)
    expect(firstPage.nextAfterCounter).toBe(firstPage.entries[1]!.monotonicCounter)

    const secondPage = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(
          new SyncFeedInput({ workspaceId, knownEpoch: firstPage.epoch, afterCounter: firstPage.nextAfterCounter, limit: 2 })
        )
      )
    )
    expect(secondPage.entries).toHaveLength(2)
    expect(secondPage.entries[0]!.monotonicCounter).toBeGreaterThan(firstPage.entries[1]!.monotonicCounter)

    const thirdPage = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(
          new SyncFeedInput({ workspaceId, knownEpoch: secondPage.epoch, afterCounter: secondPage.nextAfterCounter, limit: 2 })
        )
      )
    )
    expect(thirdPage.entries).toHaveLength(1)

    // Full page-through recovers every mutation, in order, no gaps/dupes.
    const allTitles = [...firstPage.entries, ...secondPage.entries, ...thirdPage.entries].map(
      (e) => (e.payload as { title: string }).title
    )
    expect(allTitles).toEqual(titles)

    // Paging past the end yields an empty page, not an error.
    const pastEnd = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(
          new SyncFeedInput({ workspaceId, knownEpoch: thirdPage.epoch, afterCounter: thirdPage.nextAfterCounter, limit: 2 })
        )
      )
    )
    expect(pastEnd.entries).toHaveLength(0)
  })
})

describe("append: write-side idempotency (adversarial-review fix)", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("a retried addFact with the same caller-supplied id produces one Fact and one feed entry, not two", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`sync-add-fact-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "N" })))
    ).node

    const factId = Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())
    const input = Schema.encodeSync(AddFactInput)(
      new AddFactInput({ workspaceId, nodeId: node.id, predicateId: "status", value: "done", id: factId, requestId: "sync-fixed", commitMessage: "Update status.", attribution: webFieldAttribution() })
    )

    // Simulates a client retrying an addFact call whose response it never saw (e.g. a dropped
    // connection) by resending the identical RPC, including the same caller-supplied id — the
    // exact scenario the adversarial review's own ad-hoc repro exercised and found broken.
    const first = Schema.decodeUnknownSync(AddFactOutput)(await workspaceStub.addFact(input))
    const second = Schema.decodeUnknownSync(AddFactOutput)(await workspaceStub.addFact(input))

    // Real entity-level idempotency: both calls resolve to the exact same Fact, not two distinct
    // rows with two distinct (server-minted) ids.
    expect(second.fact.id).toBe(first.fact.id)
    expect(second.fact).toEqual(first.fact)

    // Real feed-level idempotency: the retried mutation collapsed to exactly one feed entry, not
    // two — this is the concrete, previously-false half of "idempotent by ID+hash".
    const page = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 50 })))
    )
    const factEntries = page.entries.filter((e) => e.entityKind === "fact" && e.entityId === factId)
    expect(factEntries).toHaveLength(1)
  })

  it("two distinct addFact request ids without caller-supplied ids remain two distinct Facts", async () => {
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(`sync-add-fact-${crypto.randomUUID()}@example.com`)
    workspaceStub = (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub

    const node = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "N" })))
    ).node

    const firstInput = Schema.encodeSync(AddFactInput)(
      new AddFactInput({ workspaceId, nodeId: node.id, predicateId: "status", value: "done", requestId: "sync-generated-1", commitMessage: "Update status.", attribution: webFieldAttribution() })
    )
    const secondInput = Schema.encodeSync(AddFactInput)(
      new AddFactInput({ workspaceId, nodeId: node.id, predicateId: "status", value: "done", requestId: "sync-generated-2", commitMessage: "Update status.", attribution: webFieldAttribution() })
    )
    const first = Schema.decodeUnknownSync(AddFactOutput)(await workspaceStub.addFact(firstInput))
    const second = Schema.decodeUnknownSync(AddFactOutput)(await workspaceStub.addFact(secondInput))

    // A caller-owned request id is the semantic operation identity. Distinct request ids therefore
    // remain distinct operations even when the server mints both fact ids.
    expect(second.fact.id).not.toBe(first.fact.id)

    const page = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 50 })))
    )
    const factEntries = page.entries.filter((e) => e.entityKind === "fact")
    expect(factEntries).toHaveLength(2)
  })
})

describe("rotateEpoch: invalidates a stale client cursor rather than trusting it", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("a syncFeed call with the pre-rotation epoch gets epochMismatch: true and no entries", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Before rotation" })))

    const beforeRotation = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 10 })))
    )
    expect(beforeRotation.entries).toHaveLength(1)
    const staleEpoch = beforeRotation.epoch

    const rotated = Schema.decodeUnknownSync(RotateEpochOutput)(
      await workspaceStub.rotateEpoch(Schema.encodeSync(RotateEpochInput)(new RotateEpochInput({ workspaceId })))
    )
    expect(rotated.epoch).not.toBe(staleEpoch)

    const staleAttempt = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(
        Schema.encodeSync(SyncFeedInput)(
          new SyncFeedInput({ workspaceId, knownEpoch: staleEpoch, afterCounter: beforeRotation.nextAfterCounter, limit: 10 })
        )
      )
    )
    expect(staleAttempt.epochMismatch).toBe(true)
    expect(staleAttempt.entries).toHaveLength(0)
    expect(staleAttempt.epoch).toBe(rotated.epoch)

    // A client that bootstraps fresh (drops its cursor, adopts the new epoch) sees a clean,
    // freshly-numbered feed from the new epoch's start — not the pre-rotation entries replayed
    // under the new epoch, and not an error.
    await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "After rotation" })))
    const freshBootstrap = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, knownEpoch: rotated.epoch, limit: 10 })))
    )
    expect(freshBootstrap.epochMismatch).toBe(false)
    expect(freshBootstrap.entries).toHaveLength(1)
    expect((freshBootstrap.entries[0]!.payload as { title: string }).title).toBe("After rotation")
    expect(freshBootstrap.entries[0]!.monotonicCounter).toBe(0)
  })
})
