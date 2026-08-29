import { describe, expect, it } from "vitest"
import { digestCanonicalV2 } from "@athenaeum/domain"
import { createAuthorityLocalCommandRegistryForTests, executeAuthorityForTests } from "./authority-kernel-test-support.js"
import type { AuthorityLocalCommandRegistry } from "../src/authority-local-command-registry.js"
import { decodeTrustedDataToken } from "../src/authority-trusted-data-token.js"
import type { LocalMutationCapability } from "../src/workspace-local-mutation-capability.js"
import {
  deliveryIdempotencyKey,
  stableReplayAudienceId,
  syncDigest,
  type ActionFence,
  type AuthorityAdmissionPort,
  type AuthorityEpoch,
  type AuthorityFailpoint,
  type AuthorityReceipt,
  type AuthorityStore,
  type AuthorityTransaction,
  type CommittedRequestRecord,
  type Digest,
  type EventId,
  type ImmutableCommandProvenance,
  type ImmutableEvent,
  type ImmutableOutboxIntent,
  type KernelIdentityPort,
  type LedgerSequence,
  type OutboxId,
  type ReplayAdmission,
  type ReplayAudience,
  type ReplayAudienceId,
  type RequestId,
  type ResolvedActorContext,
  type WorkspaceId
} from "../src/workspace-mutation-authority.js"

const workspace = "workspace-1" as WorkspaceId
const requestId = (value: string) => value as RequestId
const audienceId = stableReplayAudienceId({ kind: "human", tenantId: "tenant-1", subjectId: "human-1" } satisfies ReplayAudience)
const actionFence = (): ActionFence => ({ membershipVersion: "member-1", policyVersion: "policy-1", grantVersion: "grant-1", revocationVersion: "revocation-1", expiresAt: 2_000_000 })
const actor = (): ResolvedActorContext => ({ authority: "verified-human", workspaceId: workspace, principalId: "human-1", effectiveCapability: "write", policy: "policy-1", custodyMaterial: { human: "human-1", capability: "write" } })
const token = (value: unknown) => {
  const json = JSON.stringify(value)
  if (typeof json !== "string") throw new Error("test token must encode as JSON")
  return decodeTrustedDataToken(json)
}

type State = {
  records: Map<string, CommittedRequestRecord<AuthorityReceipt<unknown>>>
  local: Map<string, unknown>
  commands: ImmutableCommandProvenance[]
  events: ImmutableEvent[]
  outboxes: ImmutableOutboxIntent[]
  deliveries: { outboxId: OutboxId; consumerId: string; idempotencyKey: Digest; state: "pending"; attempts: 0 }[]
  receipts: unknown[]
  epoch: number
  sequence: number
  admission: ReplayAdmission
  actionFence: ActionFence
  failpoint?: AuthorityFailpoint
}

const cloneState = (state: State): State => ({
  records: new Map(state.records), local: new Map(state.local), commands: [...state.commands], events: [...state.events], outboxes: [...state.outboxes], deliveries: [...state.deliveries], receipts: [...state.receipts],
  epoch: state.epoch, sequence: state.sequence, admission: { ...state.admission, admissionFence: { ...state.admission.admissionFence } }, actionFence: { ...state.actionFence }, failpoint: state.failpoint
})

class FakeStore implements AuthorityStore<AuthorityReceipt<unknown>> {
  state: State = {
    records: new Map(), local: new Map(), commands: [], events: [], outboxes: [], deliveries: [], receipts: [], epoch: 1, sequence: 0,
    admission: { workspaceId: workspace, admitted: true, audienceId, admissionFence: { membershipVersion: "member-1" } }, actionFence: actionFence()
  }

  transactionSync<T>(run: (transaction: AuthorityTransaction<AuthorityReceipt<unknown>>) => T): T {
    const before = cloneState(this.state)
    const transaction: AuthorityTransaction<AuthorityReceipt<unknown>> = {
      recheckReplayAdmission: (snapshot) => this.state.admission.admitted && this.state.admission.workspaceId === snapshot.workspaceId && this.state.admission.audienceId === snapshot.audienceId && this.state.admission.admissionFence.membershipVersion === snapshot.admissionFence.membershipVersion ? "admitted" : "denied",
      getCommittedRequest: (workspaceId, id) => this.state.records.get(`${workspaceId}:${id}`),
      recheckActionFence: ({ workspaceId, actor: resolved, fence, expectedEpoch, nowEpochMs }) => workspaceId === workspace && resolved.workspaceId === workspace && expectedEpoch === this.state.epoch && nowEpochMs < fence.expiresAt && fence.policyVersion === this.state.actionFence.policyVersion ? "current" : "retry",
      currentEpoch: () => this.state.epoch as AuthorityEpoch,
      allocateNextSequence: () => (++this.state.sequence) as LedgerSequence,
      // The kernel receives raw synchronous same-storage operations; handlers never do.
      localMutation: () => ({
        readLocal: (key) => this.state.local.get(key),
        writeLocal: (key, value) => this.state.local.set(key, value),
        deleteLocal: (key) => this.state.local.delete(key),
        stageIntent: () => {}
      }),
      insertCommandProvenance: (record) => this.state.commands.push(record),
      insertCommittedRequest: (record) => {
        const key = `${record.workspaceId}:${record.requestId}`
        if (this.state.records.has(key)) throw new Error("duplicate request")
        this.state.records.set(key, record)
      },
      insertEvent: (event) => this.state.events.push(event),
      insertOutboxIntent: (intent) => this.state.outboxes.push(intent),
      insertDeliverySeed: (delivery) => this.state.deliveries.push(delivery),
      insertReceipt: (receipt) => this.state.receipts.push(receipt),
      hitFailpoint: (point) => { if (this.state.failpoint === point) throw new Error(`failpoint:${point}`) }
    }
    try {
      return run(transaction)
    } catch (error) {
      this.state = before
      throw error
    }
  }

  readEpochSnapshot = (_workspaceId: WorkspaceId) => this.state.epoch as AuthorityEpoch
}

let ids = 0
const identity = (): KernelIdentityPort => ({
  nextEventId: () => `event-${++ids}` as EventId,
  nextOutboxId: () => `outbox-${++ids}` as OutboxId,
  nowIso: () => "2026-08-29T00:00:00.000Z",
  nowEpochMs: () => 1_000_000
})
const input = (overrides: Partial<{ requestId: string; kind: string; payload: unknown; evidence: unknown }> = {}) => ({
  workspaceId: workspace, requestId: requestId(overrides.requestId ?? "request-1"), kind: overrides.kind ?? "stage1a-test", commitMessage: "Record the requested second-brain change.",
  request: { node: "daily" }, evidence: overrides.evidence ?? { kind: "web", sourceId: "ui-1" }, payload: overrides.payload ?? { nested: { value: 1 } }
})
type Input = ReturnType<typeof input>
const admission = (store: FakeStore, resolve: AuthorityAdmissionPort["resolveFreshAction"] = async () => ({ actor: actor(), actionFence: { ...store.state.actionFence }, expectedEpoch: store.state.epoch as AuthorityEpoch })): AuthorityAdmissionPort => ({
  admitReplay: async ({ workspaceId }) => ({ ...store.state.admission, workspaceId }),
  resolveFreshAction: resolve
})
const registry = (entries: Parameters<typeof createAuthorityLocalCommandRegistryForTests>[0]): AuthorityLocalCommandRegistry => createAuthorityLocalCommandRegistryForTests(entries)
const execute = <Output = unknown>(store: AuthorityStore<AuthorityReceipt<Output>>, port: AuthorityAdmissionPort, command: Input, commands: AuthorityLocalCommandRegistry) => executeAuthorityForTests(store, port, command, identity(), commands)

const tokenizedCommand = registry([{
  kind: "stage1a-test",
  handler: (capability, payload) => {
    capability.writeLocal("projection", payload)
    capability.stageIntent("daily-standup", payload)
    return capability.issueResult(token({ ok: true }))
  }
}])

describe("unwired workspace mutation authority", () => {
  it("commits tokenized handler data once and replays the same receipt", async () => {
    const store = new FakeStore()
    let calls = 0
    const commands = registry([{
      kind: "stage1a-test",
      handler: (capability, payload) => {
        calls += 1
        capability.writeLocal("projection", payload)
        capability.stageIntent("daily-standup", payload)
        return capability.issueResult(token({ ok: true }))
      }
    }])
    const first = await execute(store, admission(store), input(), commands)
    const replay = await execute(store, admission(store), input(), commands)
    expect(first).toMatchObject({ kind: "committed", replay: false })
    expect(replay).toEqual({ kind: "committed", receipt: (first as { receipt: unknown }).receipt, replay: true })
    expect(calls).toBe(1)
    expect(store.state.local.get("projection")).toEqual({ nested: { value: 1 } })
    expect(store.state.sequence).toBe(1)
    expect(store.state.events).toHaveLength(1)
    expect(store.state.outboxes).toHaveLength(1)
  })

  it("conflicts changed material for the same audience and denies a foreign audience", async () => {
    const store = new FakeStore()
    let calls = 0
    const commands = registry([
      { kind: "stage1a-test", handler: (capability, payload) => { calls += 1; capability.writeLocal("projection", payload); return capability.issueResult(token("one")) } },
      { kind: "other", handler: (capability) => capability.issueResult(token("two")) }
    ])
    await expect(execute(store, admission(store), input(), commands)).resolves.toMatchObject({ kind: "committed" })
    await expect(execute(store, admission(store), input({ payload: { nested: { value: 2 } } }), commands)).resolves.toMatchObject({ kind: "conflict" })
    await expect(execute(store, admission(store), input({ kind: "other" }), commands)).resolves.toMatchObject({ kind: "conflict" })
    store.state.admission = { ...store.state.admission, audienceId: stableReplayAudienceId({ kind: "human", tenantId: "tenant-1", subjectId: "other" }) }
    await expect(execute(store, admission(store), input(), commands)).resolves.toEqual({ kind: "denied" })
    expect(calls).toBe(1)
  })

  it("permits exactly one tokenized handler when deferred resolutions race", async () => {
    const store = new FakeStore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const commands = registry([{
      kind: "stage1a-test",
      handler: (capability, payload) => { calls += 1; capability.writeLocal("projection", payload); capability.stageIntent("brief", payload); return capability.issueResult(token("done")) }
    }])
    const port = admission(store, async () => { await gate; return { actor: actor(), actionFence: { ...store.state.actionFence }, expectedEpoch: store.state.epoch as AuthorityEpoch } })
    const left = execute(store, port, input(), commands)
    const right = execute(store, port, input(), commands)
    await Promise.resolve()
    release()
    const [a, b] = await Promise.all([left, right])
    expect(a.kind).toBe("committed")
    expect(b.kind).toBe("committed")
    expect(calls).toBe(1)
    expect(store.state.sequence).toBe(1)
  })

  it("rechecks admission and retries a changed action fence without duplicate writes", async () => {
    const deniedStore = new FakeStore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const denied = execute(deniedStore, admission(deniedStore, async () => { await gate; return { actor: actor(), actionFence: { ...deniedStore.state.actionFence }, expectedEpoch: deniedStore.state.epoch as AuthorityEpoch } }), input(), tokenizedCommand)
    await Promise.resolve()
    deniedStore.state.admission = { ...deniedStore.state.admission, admitted: false }
    release()
    await expect(denied).resolves.toEqual({ kind: "denied" })
    expect(deniedStore.state.records.size).toBe(0)

    const retryStore = new FakeStore()
    let resolutions = 0
    const retry = admission(retryStore, async () => {
      resolutions += 1
      const fence = { ...retryStore.state.actionFence }
      if (resolutions === 1) retryStore.state.actionFence = { ...retryStore.state.actionFence, policyVersion: "policy-2" }
      return { actor: actor(), actionFence: fence, expectedEpoch: retryStore.state.epoch as AuthorityEpoch }
    })
    await expect(execute(retryStore, retry, input(), tokenizedCommand)).resolves.toMatchObject({ kind: "committed" })
    expect(resolutions).toBe(2)
    expect(retryStore.state.sequence).toBe(1)
  })

  it("rolls back failpoints and revokes a retained capability after a throw", async () => {
    for (const failpoint of ["after-sequence", "after-local-write", "after-request", "after-event", "after-outbox", "after-delivery", "after-receipt"] as const) {
      const store = new FakeStore()
      store.state.failpoint = failpoint
      await expect(execute(store, admission(store), input(), tokenizedCommand)).rejects.toThrow(`failpoint:${failpoint}`)
      expect(store.state.records.size).toBe(0)
      expect(store.state.local.size).toBe(0)
      expect(store.state.events).toHaveLength(0)
      expect(store.state.outboxes).toHaveLength(0)
      expect(store.state.sequence).toBe(0)
    }
    const store = new FakeStore()
    let retained: LocalMutationCapability | undefined
    const commands = registry([{
      kind: "throws",
      handler: (capability) => { retained = capability; capability.writeLocal("x", token(1)); throw new Error("handler failure") }
    }])
    await expect(execute(store, admission(store), input({ kind: "throws" }), commands)).rejects.toThrow("handler failure")
    expect(store.state.local.size).toBe(0)
    expect(() => retained?.writeLocal("late", token(1))).toThrow(/no longer active/)
  })

  it("rejects malformed and unissued output without inspecting thenables, accessors, proxies, or generators", async () => {
    const malformedStore = new FakeStore()
    const malformed = registry([{
      kind: "malformed",
      handler: (capability) => { capability.writeLocal("x", {} as never); return capability.issueResult(token("unused")) }
    }])
    await expect(execute(malformedStore, admission(malformedStore), input({ kind: "malformed" }), malformed)).rejects.toThrow(/unissued/)
    expect(malformedStore.state.local.size).toBe(0)

    const outputs: [string, () => unknown][] = [
      ["promise", () => Promise.resolve("bad")],
      ["thenable", () => ({ then: () => {} })],
      ["accessor", () => ({ get then() { throw new Error("getter must not run") } })]
    ]
    for (const [kind, output] of outputs) {
      const store = new FakeStore()
      const commands = registry([{
        kind,
        handler: (capability) => { capability.writeLocal("x", token(kind)); return output() as never }
      }])
      await expect(execute(store, admission(store), input({ kind, requestId: kind }), commands)).rejects.toThrow(/capability-issued/)
      expect(store.state.local.size).toBe(0)
    }

    let proxyTraps = 0
    let generatorRuns = 0
    const proxy = new Proxy({}, { get: () => { proxyTraps += 1; throw new Error("proxy trap must not run") } })
    const generator = (function* () { generatorRuns += 1 })()
    for (const [kind, output] of [["proxy", proxy], ["generator", generator]] as const) {
      const store = new FakeStore()
      const commands = registry([{
        kind,
        handler: (capability) => { capability.writeLocal("x", token(kind)); return output as never }
      }])
      await expect(execute(store, admission(store), input({ kind, requestId: kind }), commands)).rejects.toThrow(/capability-issued/)
      expect(store.state.local.size).toBe(0)
    }
    expect(proxyTraps).toBe(0)
    expect(generatorRuns).toBe(0)
  })

  it("fails closed for missing and expired tool custody", async () => {
    const store = new FakeStore()
    await expect(execute(store, admission(store), input({ evidence: { kind: "tool", sourceId: "tool-1" } }), tokenizedCommand)).resolves.toEqual({ kind: "denied" })
    const expired = admission(store, async () => ({
      actor: { ...actor(), toolExecution: { registrationId: "tool", immutableToolVersion: "1", invocationId: "i", grantId: "g", workspaceId: workspace, expiresAt: "1970-01-01T00:00:00.000Z", revocationId: "r", effectiveCapability: "write", policy: "p" } },
      actionFence: { ...store.state.actionFence }, expectedEpoch: store.state.epoch as AuthorityEpoch
    }))
    await expect(execute(store, expired, input({ requestId: "expired", evidence: { kind: "tool", sourceId: "tool-1" } }), tokenizedCommand)).resolves.toEqual({ kind: "denied" })
  })

  it("preserves public digest re-exports through the pure kernel contract", async () => {
    const vectors = [
      { z: { b: "é", a: "😀" }, a: [true, false, null, 0, -1.5], empty: {} },
      ["x", { b: 2, a: 1 }],
      { "😀": 1, "e\u0301": "NFD", "é": "NFC", "𐀀": "astral" }
    ]
    for (const value of vectors) expect(await digestCanonicalV2(value)).toBe(syncDigest(value))
    expect(deliveryIdempotencyKey("outbox-vector" as OutboxId, "consumer-1")).toBe("3e90d7d0bf3779c425e5d99b9583c33593e104ec130f03616e8881a743ee0d0c")
  })
})
