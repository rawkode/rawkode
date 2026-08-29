import { describe, expect, it } from "vitest"
import {
  STANDUP_RUN_GRANT_ATTESTATION_VERSION,
  STANDUP_RUN_GRANT_ISSUER_VERSION,
  STANDUP_RUN_GRANT_MAX_TTL_MS,
  type StandupRunGrantIssuerDependencies,
  type TrustedStandupRunAttestation
} from "../src/standup-run-grant-issuer-private-contract.js"
import { StandupRunGrantDraftPreparer } from "../src/standup-run-grant-issuer-private-service.js"

const token = (): TrustedStandupRunAttestation => Object.freeze(Object.create(null)) as TrustedStandupRunAttestation

const material = (overrides: Record<string, unknown> = {}) => ({
  version: STANDUP_RUN_GRANT_ATTESTATION_VERSION,
  workspaceId: "workspace-1",
  civilDate: "2026-08-29",
  runIdentityVersion: "workforce-run-v1",
  microEmployee: { kind: "microEmployee", id: "executive", version: "v1" },
  job: { kind: "job", id: "daily-standup", version: "v1" },
  workflow: { kind: "workflow", id: "morning-review", version: "v1" },
  schedule: { kind: "schedule", id: "weekdays", version: "v1" },
  councilRefs: [{ kind: "council", id: "operations", version: "v1" }],
  runId: "run-1",
  occurrenceId: "occurrence-1",
  microEmployeeLabel: "Executive",
  jobLabel: "Daily standup",
  workflowLabel: "Morning review",
  scheduleLabel: "Weekdays",
  ...overrides
})

const issuerIdentity = (overrides: Record<string, unknown> = {}) => ({
  issuerId: "deployment-workforce-v1",
  grantRecordVersion: "grant-record-v1",
  subject: "system:workforce-scheduler",
  replayAudience: "system:workforce-scheduler:workspace-1",
  authorityGeneration: "authority-generation-7",
  revocationId: "revocation-set-3",
  revocationGeneration: "13",
  policyVersion: "workforce-policy-v1",
  ...overrides
})

const preparerFor = (options: {
  readonly attestation?: unknown
  readonly identity?: unknown
  readonly issuedAt?: unknown
  readonly grantId?: unknown
  readonly ttlMs?: number
  readonly state?: { attester?: number; identity?: number; clock?: number; grantId?: number }
} = {}) => {
  const state = options.state ?? {}
  const dependencies: StandupRunGrantIssuerDependencies = {
    attester: {
      resolve: () => {
        state.attester = (state.attester ?? 0) + 1
        return options.attestation ?? material()
      }
    },
    identity: {
      identity: () => {
        state.identity = (state.identity ?? 0) + 1
        return options.identity ?? issuerIdentity()
      },
      nextGrantId: () => {
        state.grantId = (state.grantId ?? 0) + 1
        return options.grantId ?? "grant-1"
      }
    },
    clock: {
      now: () => {
        state.clock = (state.clock ?? 0) + 1
        return options.issuedAt ?? "2026-08-29T08:00:00.000Z"
      }
    },
    ttlMs: options.ttlMs ?? 60_000
  }
  return { preparer: new StandupRunGrantDraftPreparer(dependencies), state }
}

describe("dormant private standup run-grant draft preparer", () => {
  it("builds an immutable draft from attested run material and server-owned custody", () => {
    const raw = material()
    const { preparer } = preparerFor({ attestation: raw })
    const draft = preparer.prepare(token())

    expect(draft.version).toBe(STANDUP_RUN_GRANT_ISSUER_VERSION)
    expect(draft.grant.dailyNoteId).toBe("00000000-0000-4000-8000-000020260829")
    expect(draft.grant.issuedAt).toBe("2026-08-29T08:00:00.000Z")
    expect(draft.grant.expiresAt).toBe("2026-08-29T08:01:00.000Z")
    expect(Object.isFrozen(draft)).toBe(true)
    expect(Object.isFrozen(draft.grant)).toBe(true)
    expect(Object.keys(draft).sort()).toEqual(["grant", "grantRecordDigest", "version"])
    expect(JSON.stringify(draft)).not.toMatch(/token|handle|receipt|event|outbox|publication/i)

    raw.jobLabel = "Mutated after preparation"
    raw.job.id = "other-job"
    expect(draft.grant.jobLabel).toBe("Daily standup")
    expect(draft.grant.job.id).toBe("daily-standup")
  })

  it("passes the opaque attestation handle to the attester without reflecting or stringifying it", () => {
    let reflected = false
    const poison = new Proxy(Object.create(null), {
      get: () => {
        reflected = true
        throw new Error("opaque attestation was reflected")
      },
      getPrototypeOf: () => {
        reflected = true
        throw new Error("opaque attestation was reflected")
      },
      ownKeys: () => {
        reflected = true
        throw new Error("opaque attestation was reflected")
      }
    }) as TrustedStandupRunAttestation
    let received = false
    const dependencies: StandupRunGrantIssuerDependencies = {
      attester: {
        resolve: (candidate) => {
          received = candidate === poison
          return material()
        }
      },
      identity: { identity: () => issuerIdentity(), nextGrantId: () => "grant-1" },
      clock: { now: () => "2026-08-29T08:00:00.000Z" },
      ttlMs: 60_000
    }
    const draft = new StandupRunGrantDraftPreparer(dependencies).prepare(poison)
    expect(received).toBe(true)
    expect(reflected).toBe(false)
    expect(draft.grantRecordDigest).toEqual(expect.any(String))
  })

  it("rejects malformed or accessor-backed attestation data before server identity, clock, or any deferred lifecycle could run", () => {
    const malformedState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const malformed = preparerFor({ attestation: { ...material(), issuerId: "forged" }, state: malformedState })
    expect(() => malformed.preparer.prepare(token())).toThrow(/attestation has unknown/)
    expect(malformedState).toEqual({ attester: 1 })

    const accessor = material()
    let accessorRead = false
    Object.defineProperty(accessor, "workspaceId", {
      enumerable: true,
      configurable: true,
      get: () => {
        accessorRead = true
        throw new Error("must not execute accessor")
      }
    })
    const accessorState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const accessorPreparer = preparerFor({ attestation: accessor, state: accessorState })
    expect(() => accessorPreparer.preparer.prepare(token())).toThrow(/attestation has unknown/)
    expect(accessorRead).toBe(false)
    expect(accessorState).toEqual({ attester: 1 })
  })

  it("rejects an attester then accessor without invoking it or advancing server-owned ports", () => {
    const poisoned = material()
    let thenRead = false
    Object.defineProperty(poisoned, "then", {
      enumerable: true,
      configurable: true,
      get: () => {
        thenRead = true
        throw new Error("attester then accessor must not execute")
      }
    })
    const state: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const { preparer } = preparerFor({ attestation: poisoned, state })

    expect(() => preparer.prepare(token())).toThrow(/thenable|synchronous/)
    expect(thenRead).toBe(false)
    expect(state).toEqual({ attester: 1 })
  })

  it("decodes council refs through own data descriptors without invoking map or index accessors", () => {
    const mapPoison = [{ kind: "council", id: "operations", version: "v1" }]
    let mapRead = false
    Object.defineProperty(mapPoison, "map", {
      configurable: true,
      get: () => {
        mapRead = true
        throw new Error("council map accessor must not execute")
      }
    })
    const mapState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const mapPreparer = preparerFor({ attestation: material({ councilRefs: mapPoison }), state: mapState })
    expect(() => mapPreparer.preparer.prepare(token())).toThrow(/councilRefs/)
    expect(mapRead).toBe(false)
    expect(mapState).toEqual({ attester: 1 })

    const mapFunctionPoison = [{ kind: "council", id: "operations", version: "v1" }]
    let mapCalled = false
    Object.defineProperty(mapFunctionPoison, "map", {
      configurable: true,
      value: () => {
        mapCalled = true
        throw new Error("council map function must not execute")
      }
    })
    const mapFunctionState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const mapFunctionPreparer = preparerFor({ attestation: material({ councilRefs: mapFunctionPoison }), state: mapFunctionState })
    expect(() => mapFunctionPreparer.preparer.prepare(token())).toThrow(/councilRefs/)
    expect(mapCalled).toBe(false)
    expect(mapFunctionState).toEqual({ attester: 1 })

    const indexPoison = [{ kind: "council", id: "operations", version: "v1" }]
    let indexRead = false
    Object.defineProperty(indexPoison, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        indexRead = true
        throw new Error("council index accessor must not execute")
      }
    })
    const indexState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const indexPreparer = preparerFor({ attestation: material({ councilRefs: indexPoison }), state: indexState })
    expect(() => indexPreparer.preparer.prepare(token())).toThrow(/councilRefs/)
    expect(indexRead).toBe(false)
    expect(indexState).toEqual({ attester: 1 })
  })

  it("bounds exact dense council arrays before advancing server-owned ports", () => {
    const councilRefs = new Array(33)
    for (let index = 0; index < councilRefs.length; index += 1) {
      councilRefs[index] = { kind: "council", id: `council-${index}`, version: "v1" }
    }
    const state: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const { preparer } = preparerFor({ attestation: material({ councilRefs }), state })
    expect(() => preparer.prepare(token())).toThrow(/no more than 32 entries/)
    expect(state).toEqual({ attester: 1 })
  })

  it("rejects asynchronous attester output and invalid port values without progressing to later ports", () => {
    const attesterState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const thenableAttestation = preparerFor({ attestation: Promise.resolve(material()), state: attesterState })
    expect(() => thenableAttestation.preparer.prepare(token())).toThrow(/thenable|synchronous/)
    expect(attesterState).toEqual({ attester: 1 })

    const identityState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const thenableIdentity = preparerFor({ identity: { then: () => undefined }, state: identityState })
    expect(() => thenableIdentity.preparer.prepare(token())).toThrow(/issuer identity/)
    expect(identityState).toEqual({ attester: 1, identity: 1 })

    const clockState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const thenableClock = preparerFor({ issuedAt: { then: () => undefined }, state: clockState })
    expect(() => thenableClock.preparer.prepare(token())).toThrow(/canonical UTC ISO/)
    expect(clockState).toEqual({ attester: 1, identity: 1, clock: 1 })

    const grantIdState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const thenableGrantId = preparerFor({ grantId: { then: () => undefined }, state: grantIdState })
    expect(() => thenableGrantId.preparer.prepare(token())).toThrow(/grantId must be a nonblank string/)
    expect(grantIdState).toEqual({ attester: 1, identity: 1, clock: 1, grantId: 1 })
  })

  it("never reads a then accessor from identity, clock, or grant-id port data", () => {
    const poisonedThen = () => {
      let read = false
      const value = Object.create(null) as { readonly then?: unknown }
      Object.defineProperty(value, "then", {
        enumerable: true,
        get: () => {
          read = true
          throw new Error("then accessor must not execute")
        }
      })
      return { value, wasRead: () => read }
    }

    const identityPoison = poisonedThen()
    const identityState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const identity = preparerFor({ identity: identityPoison.value, state: identityState })
    expect(() => identity.preparer.prepare(token())).toThrow(/issuer identity/)
    expect(identityPoison.wasRead()).toBe(false)
    expect(identityState).toEqual({ attester: 1, identity: 1 })

    const clockPoison = poisonedThen()
    const clockState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const clock = preparerFor({ issuedAt: clockPoison.value, state: clockState })
    expect(() => clock.preparer.prepare(token())).toThrow(/canonical UTC ISO/)
    expect(clockPoison.wasRead()).toBe(false)
    expect(clockState).toEqual({ attester: 1, identity: 1, clock: 1 })

    const grantIdPoison = poisonedThen()
    const grantIdState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const grantId = preparerFor({ grantId: grantIdPoison.value, state: grantIdState })
    expect(() => grantId.preparer.prepare(token())).toThrow(/grantId must be a nonblank string/)
    expect(grantIdPoison.wasRead()).toBe(false)
    expect(grantIdState).toEqual({ attester: 1, identity: 1, clock: 1, grantId: 1 })
  })

  it("uses canonical issuance time with a bounded, strictly-positive TTL", () => {
    const { preparer } = preparerFor({ ttlMs: 1 })
    const draft = preparer.prepare(token())
    expect(draft.grant.issuedAt < draft.grant.expiresAt).toBe(true)
    expect(draft.grant.expiresAt).toBe("2026-08-29T08:00:00.001Z")

    expect(() => preparerFor({ issuedAt: "2026-08-29T08:00:00Z" }).preparer.prepare(token())).toThrow(/canonical UTC ISO/)
    expect(() => preparerFor({ ttlMs: 0 }).preparer.prepare(token())).toThrow(/ttlMs/)
    expect(() => preparerFor({ ttlMs: STANDUP_RUN_GRANT_MAX_TTL_MS + 1 }).preparer.prepare(token())).toThrow(/ttlMs/)
  })

  it("does not allocate a grant ID until strict daily-note and council validation has passed", () => {
    const impossibleDateState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const impossibleDate = preparerFor({
      attestation: material({ civilDate: "2026-02-30" }),
      state: impossibleDateState
    })
    expect(() => impossibleDate.preparer.prepare(token())).toThrow(/Gregorian calendar/)
    expect(impossibleDateState.grantId ?? 0).toBe(0)
    expect(impossibleDateState).toEqual({ attester: 1, identity: 1, clock: 1 })

    const duplicateCouncilState: { attester?: number; identity?: number; clock?: number; grantId?: number } = {}
    const duplicateCouncil = { kind: "council", id: "operations", version: "v1" }
    const duplicateCouncils = preparerFor({
      attestation: material({ councilRefs: [duplicateCouncil, { ...duplicateCouncil }] }),
      state: duplicateCouncilState
    })
    expect(() => duplicateCouncils.preparer.prepare(token())).toThrow(/duplicate/i)
    expect(duplicateCouncilState.grantId ?? 0).toBe(0)
    expect(duplicateCouncilState).toEqual({ attester: 1, identity: 1, clock: 1 })
  })

  it("changes the immutable grant digest for every attested or issuer-owned custody mutation", () => {
    const baseline = preparerFor().preparer.prepare(token())
    const digestFor = (options: Parameters<typeof preparerFor>[0]) => preparerFor(options).preparer.prepare(token()).grantRecordDigest
    const changed = [
      digestFor({ attestation: material({ workspaceId: "workspace-2" }) }),
      digestFor({ attestation: material({ civilDate: "2026-08-30" }) }),
      digestFor({ attestation: material({ runIdentityVersion: "workforce-run-v2" }) }),
      digestFor({ attestation: material({ microEmployee: { kind: "microEmployee", id: "other", version: "v2" } }) }),
      digestFor({ attestation: material({ job: { kind: "job", id: "other", version: "v2" } }) }),
      digestFor({ attestation: material({ workflow: { kind: "workflow", id: "other", version: "v2" } }) }),
      digestFor({ attestation: material({ schedule: { kind: "schedule", id: "other", version: "v2" } }) }),
      digestFor({ attestation: material({ councilRefs: [{ kind: "council", id: "other", version: "v2" }] }) }),
      digestFor({ attestation: material({ runId: "run-2" }) }),
      digestFor({ attestation: material({ occurrenceId: "occurrence-2" }) }),
      digestFor({ attestation: material({ microEmployeeLabel: "Other employee" }) }),
      digestFor({ attestation: material({ jobLabel: "Other job" }) }),
      digestFor({ attestation: material({ workflowLabel: "Other workflow" }) }),
      digestFor({ attestation: material({ scheduleLabel: "Other schedule" }) }),
      digestFor({ identity: issuerIdentity({ issuerId: "issuer-2" }) }),
      digestFor({ identity: issuerIdentity({ grantRecordVersion: "grant-record-v2" }) }),
      digestFor({ identity: issuerIdentity({ subject: "system:other" }) }),
      digestFor({ identity: issuerIdentity({ replayAudience: "system:other:workspace-1" }) }),
      digestFor({ identity: issuerIdentity({ authorityGeneration: "authority-generation-8" }) }),
      digestFor({ identity: issuerIdentity({ revocationId: "revocation-set-4" }) }),
      digestFor({ identity: issuerIdentity({ revocationGeneration: "14" }) }),
      digestFor({ identity: issuerIdentity({ policyVersion: "workforce-policy-v2" }) }),
      digestFor({ grantId: "grant-2" }),
      digestFor({ issuedAt: "2026-08-29T08:00:01.000Z" }),
      digestFor({ ttlMs: 120_000 })
    ]
    for (const digest of changed) expect(digest).not.toBe(baseline.grantRecordDigest)
  })
})
