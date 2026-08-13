import { describe, expect, test } from "bun:test";
import { type CanonicalJSON, canonicalJSONStringify, sha256Hex } from "@enchiridion/protocol";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import {
  type OwnerVaultAppendInput,
  type OwnerVaultCapabilityReceiptInput,
  type OwnerVaultChallenge,
  type OwnerVaultDevice,
  type OwnerVaultSessionRecord,
  makeOwnerVaultDomainProvider,
} from "./domains";
import {
  type OwnerVaultStorageTransactionFailure,
  type OwnerVaultTx,
  makeDurableObjectOwnerVaultStorageRepository,
} from "./repository";
import { makeOwnerVaultSnapshotPinController } from "./snapshot-pin";

const root = {
  ownerID: "owner-1",
  vaultID: "vault-1",
  generationEpoch: 1,
  namespaceState: "PRIVATE",
} as const;
const device: OwnerVaultDevice = {
  deviceID: "device-1",
  publicKeySPKI: "spki",
  authEpoch: 1,
  credentialEpoch: 1,
  revoked: false,
  securityFloor: 0,
};
/** Full verifier-claims shape whose path and expiry the receipt input binds. */
const claimsFor = (jti: string, overrides: Readonly<Record<string, CanonicalJSON>> = {}): string =>
  canonicalJSONStringify({
    audience: "OwnerVault",
    authority: "OwnerVault",
    bodySHA256: "0".repeat(64),
    canonicalQuery: "",
    credentialEpoch: 1,
    expiresAt: 1_200,
    generationEpoch: 1,
    issuedAt: 1_000,
    jti,
    keyID: "capability-key-1",
    method: "POST",
    ownerID: "owner-1",
    path: "/v2/sync",
    vaultID: "vault-1",
    ...overrides,
  });
const capabilityWithClaims = (jti: string, claims: string, expiresAtSeconds = 1_200) => ({
  jti,
  expiresAtSeconds,
  resource: "/v2/sync",
  claims,
  claimsFingerprint: sha256Hex(new TextEncoder().encode(claims)),
  tokenFingerprint: "e".repeat(64),
});
const capabilityFor = (jti: string, overrides: Readonly<Record<string, CanonicalJSON>> = {}) =>
  capabilityWithClaims(jti, claimsFor(jti, overrides));
const capability = capabilityFor("jti-123456789012");

const durable = (): {
  readonly entries: Map<string, unknown>;
  readonly state: DurableObjectStateNative;
  readonly storage: DurableObjectStorageNative;
  /** Attempted native writes (put/delete), counted even when rolled back. */
  readonly writes: { count: number };
  /** Native transactions opened, successful or rolled back. */
  readonly transactions: { count: number };
  readonly alarm: { value: number | null };
} => {
  const entries = new Map<string, unknown>();
  const writes = { count: 0 };
  const transactions = { count: 0 };
  const alarm = { value: null as number | null };
  let pending = Promise.resolve();
  const transaction: DurableObjectTransactionNative = {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, value) => {
      writes.count += 1;
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      writes.count += 1;
      return Promise.resolve(entries.delete(key));
    },
    getAlarm: () => Promise.resolve(alarm.value),
    setAlarm: (value) => {
      alarm.value = value;
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarm.value = null;
      return Promise.resolve();
    },
  };
  const storage: DurableObjectStorageNative = {
    ...transaction,
    getAlarm: () => Promise.resolve(alarm.value),
    setAlarm: (value) => {
      alarm.value = value;
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarm.value = null;
      return Promise.resolve();
    },
    transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
      transactions.count += 1;
      const run = pending.then(async () => {
        const before = new Map(entries);
        const beforeAlarm = alarm.value;
        try {
          return await work(transaction);
        } catch (error: unknown) {
          entries.clear();
          for (const [key, value] of before) entries.set(key, value);
          alarm.value = beforeAlarm;
          throw error;
        }
      });
      pending = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return {
    entries,
    storage,
    writes,
    transactions,
    alarm,
    state: { storage, blockConcurrencyWhile: (work) => work() },
  };
};

const append = (overrides: Partial<OwnerVaultAppendInput> = {}): OwnerVaultAppendInput => ({
  operationID: "operation-1",
  fingerprint: "a".repeat(64),
  payloadHash: "b".repeat(64),
  payloadBase64: "opaque-payload",
  source: "http",
  observedHighWater: 0,
  nowSeconds: 1_000,
  receiptExpiresAtSeconds: 2_000,
  actor: { deviceID: device.deviceID, authEpoch: 1, credentialEpoch: 1, securityFloor: 0 },
  nonce: { value: "nonce-123456789012", expiresAtSeconds: 1_200, fingerprint: "c".repeat(64) },
  capability,
  ...overrides,
});

const session: OwnerVaultSessionRecord = {
  sessionID: "session-1234567890",
  deviceID: device.deviceID,
  authEpoch: 1,
  credentialEpoch: 1,
  securityFloor: 0,
  assertionExpiresAtMilliseconds: 10_000,
  resumeTokenHash: "d".repeat(64),
};

const providerFor = () => {
  const native = durable();
  const repository = makeDurableObjectOwnerVaultStorageRepository(
    makeDurableObjectBoundary(native.state).storage,
  );
  return { native, repository, provider: makeOwnerVaultDomainProvider(repository, root) };
};

const enrolledProvider = async () => {
  const fixture = providerFor();
  await Effect.runPromise(fixture.provider.initialize());
  await Effect.runPromise(
    fixture.provider.issueChallenge(
      {
        challengeID: "challenge-12345678",
        challengeBase64: "challenge",
        challengeAudience: "enroll",
        devicePublicKey: device.publicKeySPKI,
        expiresAtMilliseconds: 5_000,
        consumed: false,
      },
      1_000,
    ),
  );
  await Effect.runPromise(
    fixture.provider.registerDevice({
      registrationID: "register-12345678",
      proofFingerprint: "e".repeat(64),
      challengeID: "challenge-12345678",
      device,
      nowMilliseconds: 1_000,
    }),
  );
  return fixture;
};

describe("v2 OwnerVault durable domain provider", () => {
  test("rejects an invalid append-proof scope before initialization writes any rows", async () => {
    const native = durable();
    const repository = makeDurableObjectOwnerVaultStorageRepository(
      makeDurableObjectBoundary(native.state).storage,
    );
    const provider = makeOwnerVaultDomainProvider(repository, {
      ...root,
      generationEpoch: Number.NaN,
    });
    const exit = await Effect.runPromiseExit(provider.initialize());
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("invalid_input");
    expect(native.entries).toHaveLength(0);
  });

  test("registers domain snapshot rows transparently and retains an OPEN pinned preimage", async () => {
    const fixture = await enrolledProvider();
    const controller = makeOwnerVaultSnapshotPinController(fixture.repository, {
      makePinProof: () => "domain-catalog-pin-proof-which-is-long-enough",
    });
    const pin = await Effect.runPromise(
      controller.beginSnapshot(
        { ownerID: root.ownerID, vaultID: root.vaultID, generationEpoch: root.generationEpoch },
        "domain-catalog-snapshot-0001",
      ),
    );
    const opened = await Effect.runPromise(controller.readSnapshotPage(pin, undefined));
    const categories = opened.entries.map((entry) => entry.address.category);
    expect(categories).toContain("device");
    expect(categories).toContain("operation-receipt");
    expect(categories).not.toContain("device-challenge");
    expect(categories).not.toContain("root.admission");

    await Effect.runPromise(
      fixture.provider.revokeDevice({
        requestID: "domain-revoke-catalog-0001",
        fingerprint: "f".repeat(64),
        actor: { deviceID: device.deviceID, authEpoch: 1, credentialEpoch: 1, securityFloor: 0 },
        targetDeviceID: device.deviceID,
        nowSeconds: 1_000,
        receiptExpiresAtSeconds: 1_200,
      }),
    );
    const retained = await Effect.runPromise(controller.readSnapshotPage(pin, undefined));
    expect(
      retained.entries.find((entry) => entry.address.category === "device")?.record.payload,
    ).toMatchObject({
      revoked: false,
      authEpoch: 1,
    });
    expect(
      [...fixture.native.entries.keys()].some((key) => key.startsWith("v2.ov/backup/preimage/")),
    ).toBe(true);

    await Effect.runPromise(controller.abortSnapshot(pin));
    expect(await Effect.runPromise(controller.collectGarbage(pin.backupID))).toBe(true);
    expect(
      [...fixture.native.entries.keys()].some((key) => key.startsWith("v2.ov/backup/preimage/")),
    ).toBe(false);
  });

  test("shares one opaque append namespace across HTTP, WebSocket retry, and restart", async () => {
    const fixture = await enrolledProvider();
    const first = await Effect.runPromise(fixture.provider.append(append()));
    const afterReconnect = makeOwnerVaultDomainProvider(fixture.repository, root);
    const retried = await Effect.runPromise(
      afterReconnect.append(
        append({
          source: "websocket",
          nonce: {
            value: "different-nonce-123",
            expiresAtSeconds: 1_200,
            fingerprint: "f".repeat(64),
          },
          capability: capabilityFor("different-jti-12345"),
        }),
      ),
    );

    expect(first).toEqual({
      operationID: "operation-1",
      payloadHash: "b".repeat(64),
      logSequence: 1,
      replayed: false,
    });
    expect(retried).toEqual({ ...first, replayed: true });
    expect(fixture.native.entries.get("v2.ov/capability-receipt/jti-123456789012")).toMatchObject({
      payload: {
        state: "COMPLETED",
        jti: "jti-123456789012",
        resource: "/v2/sync",
        operationID: "operation-1",
        claims: capability.claims,
        claimsFingerprint: capability.claimsFingerprint,
        tokenFingerprint: "e".repeat(64),
      },
    });
    expect(fixture.native.entries.get("v2.ov/append-log/entry/00000000000000000001")).toMatchObject(
      {
        payload: { source: "http", logSequence: 1 },
      },
    );

    expect(await Effect.runPromise(afterReconnect.expireCapabilities(1_100))).toBe(1_200);
    expect(await Effect.runPromise(afterReconnect.expireCapabilities(1_200))).toBeUndefined();
    expect(fixture.native.entries.has("v2.ov/capability-receipt/jti-123456789012")).toBe(false);

    const conflict = await Effect.runPromiseExit(
      afterReconnect.append(append({ fingerprint: "9".repeat(64) })),
    );
    expect(Exit.isFailure(conflict)).toBe(true);
    expect(JSON.stringify(conflict)).toContain("replay_conflict");
  });

  test("atomically rejects a nonce replay without advancing the append head", async () => {
    const fixture = await enrolledProvider();
    await Effect.runPromise(fixture.provider.append(append()));
    const rejected = await Effect.runPromiseExit(
      fixture.provider.append(
        append({
          operationID: "operation-2",
          fingerprint: "1".repeat(64),
          payloadHash: "2".repeat(64),
          observedHighWater: 1,
          capability: capabilityFor("jti-222222222222"),
        }),
      ),
    );
    expect(Exit.isFailure(rejected)).toBe(true);
    expect(JSON.stringify(rejected)).toContain("nonce_replayed");
    expect(fixture.native.entries.has("v2.ov/append-log/entry/00000000000000000002")).toBe(false);
    expect(fixture.native.entries.get("v2.ov/root/log-head")).toMatchObject({
      payload: { appendLogSequence: 1 },
    });
  });

  test("retains canonical verified claims beside the JTI rather than trusting a digest alone", async () => {
    const fixture = await enrolledProvider();
    // Semantically identical JSON members in every variant, but not the exact
    // canonical bytes the verified capability receipt binds and fingerprints.
    // Each variant carries the true digest of its own bytes so only the
    // canonical-encoding check can reject it.
    const canonical = capability.claims;
    const noncanonical = [
      // Reordered keys.
      canonical.replace(
        '{"audience":"OwnerVault","authority":"OwnerVault"',
        '{"authority":"OwnerVault","audience":"OwnerVault"',
      ),
      // Added whitespace.
      `${canonical.slice(0, 1)} ${canonical.slice(1)}`,
      // Duplicate key; JSON.parse keeps the last one, so members still match.
      canonical.replace('"method":"POST"', '"method":"POST","method":"POST"'),
      // Alternate escape for the same code points ("POST" is "POST").
      canonical.replace('"method":"POST"', '"method":"P\\u004fST"'),
    ];
    for (const claims of noncanonical) {
      expect(claims).not.toBe(canonical);
      const exit = await Effect.runPromiseExit(
        fixture.provider.append(
          append({ capability: capabilityWithClaims(capability.jti, claims) }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid_input");
    }
    expect(fixture.native.entries.has("v2.ov/capability-receipt/jti-123456789012")).toBe(false);
  });

  test("claims, completes, replays, and expires one bounded universal capability receipt", async () => {
    const fixture = await enrolledProvider();
    const receiptCapability = capabilityFor("universal-capability-jti-0001");
    const receipt = {
      ...receiptCapability,
      operationID: "universal-operation-0001",
      nowSeconds: 1_000,
    };
    const prepared = await Effect.runPromise(fixture.provider.claimCapabilityReceipt(receipt));
    expect(prepared).toMatchObject({ state: "PREPARED", jti: receipt.jti, result: undefined });
    expect(await Effect.runPromise(fixture.provider.claimCapabilityReceipt(receipt))).toEqual(
      prepared,
    );

    const completed = await Effect.runPromise(
      fixture.provider.completeCapabilityReceipt(receipt, {
        durableReceipt: "universal-durable-receipt-0001",
        protocolVersion: 2,
      }),
    );
    expect(completed).toMatchObject({
      state: "COMPLETED",
      result: { durableReceipt: "universal-durable-receipt-0001", protocolVersion: 2 },
    });
    fixture.native.writes.count = 0;
    fixture.native.transactions.count = 0;
    expect(await Effect.runPromise(fixture.provider.readCapabilityReceipt(receipt))).toEqual(
      completed,
    );
    expect(fixture.native.transactions.count).toBe(1);
    expect(fixture.native.writes.count).toBe(0);
    expect(await Effect.runPromise(fixture.provider.claimCapabilityReceipt(receipt))).toEqual(
      completed,
    );

    const conflict = await Effect.runPromiseExit(
      fixture.provider.claimCapabilityReceipt({ ...receipt, tokenFingerprint: "f".repeat(64) }),
    );
    expect(Exit.isFailure(conflict)).toBe(true);
    expect(JSON.stringify(conflict)).toContain("replay_conflict");

    expect(await Effect.runPromise(fixture.provider.expireCapabilities(1_200))).toBeUndefined();
    expect(fixture.native.entries.has(`v2.ov/capability-receipt/${receipt.jti}`)).toBe(false);
  });

  test("replays an exact capability receipt from a legacy admission root without materializing indexes", async () => {
    const fixture = await enrolledProvider();
    const receipt = {
      ...capabilityFor("legacy-readonly-capability-jti-01"),
      operationID: "legacy-readonly-operation-0001",
      nowSeconds: 1_000,
    };
    await Effect.runPromise(fixture.provider.claimCapabilityReceipt(receipt));
    const completed = await Effect.runPromise(
      fixture.provider.completeCapabilityReceipt(receipt, {
        durableReceipt: "legacy-readonly-durable-receipt-0001",
      }),
    );
    const admission = fixture.native.entries.get("v2.ov/root/admission") as {
      payload: Record<string, unknown>;
    };
    admission.payload = {
      // A historical unmarked reservation has no exact expiry row. It must
      // remain reserved through read-only receipt replay and alarm expiry.
      activeChallenges: 1,
      activeDevices: admission.payload.activeDevices,
      activeSessions: admission.payload.activeSessions,
      capabilityReceipts: admission.payload.capabilityReceipts,
      stopped: admission.payload.stopped,
      pendingSocketAdmissions: admission.payload.pendingSocketAdmissions,
      activeSocketAdmissions: admission.payload.activeSocketAdmissions,
      preparedSocketOperationIDs: [],
      socketReplayJTIs: [],
      outstandingChallenges: [],
    };
    fixture.native.entries.delete("v2.ov/challenge-expiry-index");
    fixture.native.entries.delete("v2.ov/socket-prepared-index");
    fixture.native.entries.delete("v2.ov/socket-replay-index");
    fixture.native.entries.delete("v2.ov/control-receipt-lease-index");
    const before = JSON.stringify([...fixture.native.entries.entries()]);
    fixture.native.writes.count = 0;
    fixture.native.transactions.count = 0;

    expect(await Effect.runPromise(fixture.provider.readCapabilityReceipt(receipt))).toEqual(
      completed,
    );
    expect(fixture.native.transactions.count).toBe(1);
    expect(fixture.native.writes.count).toBe(0);
    expect(JSON.stringify([...fixture.native.entries.entries()])).toBe(before);
    expect(fixture.native.entries.has("v2.ov/challenge-expiry-index")).toBe(false);
    expect(fixture.native.entries.has("v2.ov/socket-prepared-index")).toBe(false);
    expect(fixture.native.entries.has("v2.ov/socket-replay-index")).toBe(false);
    expect(await Effect.runPromise(fixture.provider.expireChallenges(99_000))).toBeUndefined();
    expect(fixture.native.writes.count).toBe(0);
    expect(
      (
        fixture.native.entries.get("v2.ov/root/admission") as {
          payload: { activeChallenges: number };
        }
      ).payload.activeChallenges,
    ).toBe(1);
  });

  test("receipt preflight fails closed for prepared and reciprocal corruption", async () => {
    const fixture = await enrolledProvider();
    const receipt = {
      ...capabilityFor("preflight-capability-jti-0001"),
      operationID: "preflight-operation-0001",
      nowSeconds: 1_000,
    };
    const prepared = await Effect.runPromise(fixture.provider.claimCapabilityReceipt(receipt));
    expect(await Effect.runPromise(fixture.provider.readCapabilityReceipt(receipt))).toEqual(
      prepared,
    );

    const jti = fixture.native.entries.get(`v2.ov/jti/${receipt.jti}`) as {
      payload: Record<string, unknown>;
    };
    jti.payload = { ...jti.payload, operationID: "substituted-operation-0001" };
    const corrupt = await Effect.runPromiseExit(fixture.provider.readCapabilityReceipt(receipt));
    expect(Exit.isFailure(corrupt)).toBe(true);
    expect(JSON.stringify(corrupt)).toContain("state_corrupt");
  });

  test("receipt preflight returns undefined only for an entirely absent durable identity", async () => {
    const fixture = await enrolledProvider();
    const receipt = {
      ...capabilityFor("preflight-absent-capability-jti-0001"),
      operationID: "preflight-absent-operation-0001",
      nowSeconds: 1_000,
    };
    fixture.native.writes.count = 0;
    fixture.native.transactions.count = 0;
    expect(
      await Effect.runPromise(fixture.provider.readCapabilityReceipt(receipt)),
    ).toBeUndefined();
    expect(fixture.native.transactions.count).toBe(1);
    expect(fixture.native.writes.count).toBe(0);
  });

  test("receipt preflight fails closed for every partial identity and a divergent index", async () => {
    const input = () => ({
      ...capabilityFor("preflight-partial-capability-jti-0001"),
      operationID: "preflight-partial-operation-0001",
      nowSeconds: 1_000,
    });
    for (const missing of ["jti", "receipt", "index"] as const) {
      const fixture = await enrolledProvider();
      const receipt = input();
      await Effect.runPromise(fixture.provider.claimCapabilityReceipt(receipt));
      fixture.native.entries.delete(
        missing === "jti"
          ? `v2.ov/jti/${receipt.jti}`
          : missing === "receipt"
            ? `v2.ov/capability-receipt/${receipt.jti}`
            : "v2.ov/capability-receipts/index",
      );
      const exit = await Effect.runPromiseExit(fixture.provider.readCapabilityReceipt(receipt));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("state_corrupt");
    }

    const fixture = await enrolledProvider();
    const receipt = input();
    await Effect.runPromise(fixture.provider.claimCapabilityReceipt(receipt));
    const index = fixture.native.entries.get("v2.ov/capability-receipts/index") as {
      payload: { readonly cursor: number; readonly entries: readonly unknown[] };
    };
    index.payload = {
      ...index.payload,
      entries: [
        ...index.payload.entries,
        { jti: receipt.jti, expiresAtSeconds: receipt.expiresAtSeconds + 1 },
      ],
    };
    const divergent = await Effect.runPromiseExit(fixture.provider.readCapabilityReceipt(receipt));
    expect(Exit.isFailure(divergent)).toBe(true);
    expect(JSON.stringify(divergent)).toContain("state_corrupt");
  });

  test("tightens the shared transactional alarm for claims and never postpones it", async () => {
    const fixture = await enrolledProvider();
    fixture.native.alarm.value = null;
    const later = {
      ...capabilityFor("alarm-later-jti-0001"),
      operationID: "alarm-later-op-0001",
      nowSeconds: 1_000,
    };
    await Effect.runPromise(fixture.provider.claimCapabilityReceipt(later));
    expect(fixture.native.alarm.value as number | null).toBe(1_200_000);
    fixture.native.alarm.value = 1_100_000;
    await Effect.runPromise(fixture.provider.claimCapabilityReceipt(later));
    expect(fixture.native.alarm.value as number | null).toBe(1_100_000);
  });

  test("fails closed for legacy positive challenge counts and reciprocal cleanup corruption", async () => {
    const fixture = await enrolledProvider();
    const admission = fixture.native.entries.get("v2.ov/root/admission") as {
      payload: Record<string, unknown>;
    };
    admission.payload = { ...admission.payload, activeChallenges: 1 };
    const legacy = await Effect.runPromiseExit(fixture.provider.expireChallenges(1_000));
    expect(Exit.isFailure(legacy)).toBe(true);
    expect(JSON.stringify(legacy)).toContain("state_corrupt");

    const healthy = await enrolledProvider();
    await Effect.runPromise(
      healthy.provider.issueChallenge(
        {
          challengeID: "cleanup-challenge-0001",
          challengeBase64: "challenge-material",
          challengeAudience: "audience",
          devicePublicKey: "device-key",
          expiresAtMilliseconds: 1_001,
          consumed: false,
        },
        1_000,
      ),
    );
    const challenge = healthy.native.entries.get(
      "v2.ov/device-challenge/cleanup-challenge-0001",
    ) as {
      payload: Record<string, unknown>;
    };
    challenge.payload = { ...challenge.payload, expiresAtMilliseconds: 2_000 };
    const corrupt = await Effect.runPromiseExit(healthy.provider.expireChallenges(2_000));
    expect(Exit.isFailure(corrupt)).toBe(true);
    expect(healthy.native.entries.has("v2.ov/device-challenge/cleanup-challenge-0001")).toBe(true);
  });

  test("atomically issues a challenge with its canonical completed receipt and replays no quota", async () => {
    const fixture = await enrolledProvider();
    fixture.native.alarm.value = null;
    const receipt = {
      ...capabilityFor("atomic-device-jti-0001"),
      operationID: "atomic-device-op-0001",
      nowSeconds: 1_000,
    };
    const challenge: OwnerVaultChallenge = {
      challengeID: "atomic-device-challenge-0001",
      challengeBase64: "challenge-material",
      challengeAudience: "audience",
      devicePublicKey: "device-key",
      expiresAtMilliseconds: 1_100_000,
      consumed: false,
    };
    const result = {
      protocolVersion: 2,
      challengeID: challenge.challengeID,
      challengeBase64: challenge.challengeBase64,
      expiresAt: challenge.expiresAtMilliseconds,
    };
    const issue = (
      candidateChallenge: OwnerVaultChallenge = challenge,
      candidateResult: Readonly<Record<string, unknown>> = result,
    ) =>
      fixture.repository.transact((tx) =>
        fixture.provider.issueChallengeWithCapabilityReceiptInTx(
          tx,
          receipt,
          candidateChallenge,
          candidateResult,
          1_000,
        ),
      );
    expect((await Effect.runPromise(issue())).result).toEqual(result);
    expect(fixture.native.alarm.value as number | null).toBe(1_100_000);
    const writesBeforeRace = fixture.native.writes.count;
    expect(
      (
        await Effect.runPromise(
          issue(
            { ...challenge, challengeID: "atomic-device-challenge-race-0001" },
            { ...result, challengeID: "atomic-device-challenge-race-0001" },
          ),
        )
      ).result,
    ).toEqual(result);
    expect(fixture.native.writes.count).toBe(writesBeforeRace);
    const admission = fixture.native.entries.get("v2.ov/root/admission") as {
      payload: { activeChallenges: number };
    };
    expect(admission.payload.activeChallenges).toBe(1);
  });

  test("rolls back the complete atomic challenge/receipt row set and alarm on a later boundary fault", async () => {
    const fixture = await enrolledProvider();
    fixture.native.alarm.value = null;
    const receipt = {
      ...capabilityFor("atomic-rollback-jti-0001"),
      operationID: "atomic-rollback-op-0001",
      nowSeconds: 1_000,
    };
    const challenge = {
      challengeID: "atomic-rollback-challenge-0001",
      challengeBase64: "challenge-material",
      challengeAudience: "audience",
      devicePublicKey: "device-key",
      expiresAtMilliseconds: 1_100_000,
      consumed: false,
    } as const;
    const rolledBack = await Effect.runPromiseExit(
      fixture.repository.transact((tx) =>
        fixture.provider
          .issueChallengeWithCapabilityReceiptInTx(
            tx,
            receipt,
            challenge,
            {
              protocolVersion: 2,
              challengeID: challenge.challengeID,
              challengeBase64: challenge.challengeBase64,
              expiresAt: challenge.expiresAtMilliseconds,
            },
            1_000,
          )
          .pipe(Effect.zipRight(Effect.fail(injectedCrash))),
      ),
    );
    expect(Exit.isFailure(rolledBack)).toBe(true);
    expect(fixture.native.alarm.value).toBeNull();
    expect(fixture.native.entries.has(`v2.ov/jti/${receipt.jti}`)).toBe(false);
    expect(fixture.native.entries.has(`v2.ov/capability-receipt/${receipt.jti}`)).toBe(false);
    expect(fixture.native.entries.has(`v2.ov/device-challenge/${challenge.challengeID}`)).toBe(
      false,
    );
  });

  test("atomically completes device registration, replays the stored race result, and rolls back partial state", async () => {
    const fixture = providerFor();
    await Effect.runPromise(fixture.provider.initialize());
    const receipt = {
      ...capabilityFor("atomic-device-complete-jti-0001"),
      operationID: "atomic-device-complete-op-0001",
      nowSeconds: 1_000,
    };
    const challenge = {
      challengeID: "atomic-device-complete-challenge-0001",
      challengeBase64: "challenge-material",
      challengeAudience: "audience",
      devicePublicKey: "device-complete-key",
      expiresAtMilliseconds: 10_000,
      consumed: false,
    } as const;
    const input = {
      registrationID: "atomic-device-complete-registration-0001",
      proofFingerprint: "a".repeat(64),
      challengeID: challenge.challengeID,
      device: {
        ...device,
        deviceID: "atomic-device-complete-device-0001",
        publicKeySPKI: "device-complete-key",
      },
      nowMilliseconds: 1_000,
    };
    const result = {
      protocolVersion: 2,
      ownerID: root.ownerID,
      deviceID: input.device.deviceID,
      authEpoch: 1,
    };
    await Effect.runPromise(fixture.provider.issueChallenge(challenge, 1_000));
    const invalidBinding = await Effect.runPromiseExit(
      fixture.repository.transact((tx) =>
        fixture.provider.registerDeviceWithCapabilityReceiptInTx(tx, receipt, input, {
          ...result,
          deviceID: "wrong-device-result-binding",
        }),
      ),
    );
    expect(Exit.isFailure(invalidBinding)).toBe(true);
    expect(fixture.native.entries.has(`v2.ov/jti/${receipt.jti}`)).toBe(false);
    const rolledBack = await Effect.runPromiseExit(
      fixture.repository.transact((tx) =>
        fixture.provider
          .registerDeviceWithCapabilityReceiptInTx(tx, receipt, input, result)
          .pipe(Effect.zipRight(Effect.fail(injectedCrash))),
      ),
    );
    expect(Exit.isFailure(rolledBack)).toBe(true);
    expect(fixture.native.entries.has(`v2.ov/jti/${receipt.jti}`)).toBe(false);
    expect(fixture.native.entries.has(`v2.ov/capability-receipt/${receipt.jti}`)).toBe(false);
    expect(fixture.native.entries.has(`v2.ov/device/${input.device.deviceID}`)).toBe(false);
    expect(fixture.native.entries.has(`v2.ov/operation-receipt/${input.registrationID}`)).toBe(
      false,
    );
    expect(
      (
        fixture.native.entries.get(`v2.ov/device-challenge/${challenge.challengeID}`) as {
          payload: { consumed: boolean };
        }
      ).payload.consumed,
    ).toBe(false);

    const completed = await Effect.runPromise(
      fixture.repository.transact((tx) =>
        fixture.provider.registerDeviceWithCapabilityReceiptInTx(tx, receipt, input, result),
      ),
    );
    expect(completed.result).toEqual(result);
    expect(completed.state).toBe("COMPLETED");
    const writesBeforeReplay = fixture.native.writes.count;
    const raced = await Effect.runPromise(
      fixture.repository.transact((tx) =>
        fixture.provider.registerDeviceWithCapabilityReceiptInTx(
          tx,
          receipt,
          { ...input, device: { ...input.device, deviceID: "new-random-device-id" } },
          { ...result, deviceID: "new-random-device-id" },
        ),
      ),
    );
    expect(raced.result).toEqual(result);
    expect(fixture.native.writes.count).toBe(writesBeforeReplay);

    const partial = {
      ...capabilityFor("atomic-device-complete-partial-jti"),
      operationID: "atomic-device-complete-partial-op",
      nowSeconds: 1_000,
    };
    await Effect.runPromise(fixture.provider.claimCapabilityReceipt(partial));
    const partialExit = await Effect.runPromiseExit(
      fixture.repository.transact((tx) =>
        fixture.provider.registerDeviceWithCapabilityReceiptInTx(
          tx,
          partial,
          { ...input, registrationID: "atomic-device-complete-partial-registration" },
          result,
        ),
      ),
    );
    expect(Exit.isFailure(partialExit)).toBe(true);
    expect(
      (
        fixture.native.entries.get(`v2.ov/device-challenge/${challenge.challengeID}`) as {
          payload: { consumed: boolean };
        }
      ).payload.consumed,
    ).toBe(true);
  });

  test("keeps expired legacy challenges reserved until their one allowed completion", async () => {
    const fixture = providerFor();
    await Effect.runPromise(fixture.provider.initialize());
    const challenge = {
      challengeID: "legacy-device-complete-challenge-0001",
      challengeBase64: "challenge-material",
      challengeAudience: "audience",
      devicePublicKey: "legacy-device-complete-key",
      expiresAtMilliseconds: 2_000,
      consumed: false,
    } as const;
    await Effect.runPromise(fixture.provider.issueChallenge(challenge, 1_000));
    const storedChallenge = fixture.native.entries.get(
      `v2.ov/device-challenge/${challenge.challengeID}`,
    ) as {
      payload: Record<string, unknown>;
    };
    const { provenance: _provenance, ...legacyChallenge } = storedChallenge.payload;
    storedChallenge.payload = legacyChallenge;
    const storedAdmission = fixture.native.entries.get("v2.ov/root/admission") as {
      payload: Record<string, unknown>;
    };
    storedAdmission.payload = {
      activeChallenges: 1,
      activeDevices: storedAdmission.payload.activeDevices,
      activeSessions: storedAdmission.payload.activeSessions,
      capabilityReceipts: storedAdmission.payload.capabilityReceipts,
      stopped: storedAdmission.payload.stopped,
      pendingSocketAdmissions: storedAdmission.payload.pendingSocketAdmissions,
      activeSocketAdmissions: storedAdmission.payload.activeSocketAdmissions,
      preparedSocketOperationIDs: [],
      socketReplayJTIs: [],
      outstandingChallenges: [],
    };
    fixture.native.entries.delete("v2.ov/challenge-expiry-index");
    fixture.native.entries.delete("v2.ov/socket-prepared-index");
    fixture.native.entries.delete("v2.ov/socket-replay-index");
    fixture.native.entries.delete("v2.ov/control-receipt-lease-index");
    await Effect.runPromise(fixture.provider.expireChallenges(2_000));
    expect(fixture.native.entries.has(`v2.ov/device-challenge/${challenge.challengeID}`)).toBe(
      true,
    );
    const receipt = {
      ...capabilityFor("legacy-device-complete-jti-0001"),
      operationID: "legacy-device-complete-op-0001",
      nowSeconds: 1_000,
    };
    const input = {
      registrationID: "legacy-device-complete-registration-0001",
      proofFingerprint: "b".repeat(64),
      challengeID: challenge.challengeID,
      device: {
        ...device,
        deviceID: "legacy-device-complete-device-0001",
        publicKeySPKI: challenge.devicePublicKey,
      },
      nowMilliseconds: 1_500,
    };
    await Effect.runPromise(
      fixture.repository.transact((tx) =>
        fixture.provider.registerDeviceWithCapabilityReceiptInTx(tx, receipt, input, {
          protocolVersion: 2,
          ownerID: root.ownerID,
          deviceID: input.device.deviceID,
          authEpoch: 1,
        }),
      ),
    );
    expect(
      (
        fixture.native.entries.get("v2.ov/root/admission") as {
          payload: { activeChallenges: number; legacyOutstandingChallenges: number };
        }
      ).payload,
    ).toMatchObject({ activeChallenges: 0, legacyOutstandingChallenges: 0 });
  });

  test("expires every eligible challenge row in one transaction and retains the exact survivor", async () => {
    const fixture = await enrolledProvider();
    for (const [challengeID, expiresAtMilliseconds] of [
      ["cleanup-one-challenge-0001", 1_001],
      ["cleanup-two-challenge-0001", 1_002],
      ["cleanup-survivor-challenge", 2_000],
    ] as const)
      await Effect.runPromise(
        fixture.provider.issueChallenge(
          {
            challengeID,
            challengeBase64: "challenge-material",
            challengeAudience: "audience",
            devicePublicKey: "device-key",
            expiresAtMilliseconds,
            consumed: false,
          },
          1_000,
        ),
      );
    expect(await Effect.runPromise(fixture.provider.expireChallenges(1_002))).toBe(2_000);
    expect(fixture.native.entries.has("v2.ov/device-challenge/cleanup-one-challenge-0001")).toBe(
      false,
    );
    expect(fixture.native.entries.has("v2.ov/device-challenge/cleanup-two-challenge-0001")).toBe(
      false,
    );
    expect(fixture.native.entries.has("v2.ov/device-challenge/cleanup-survivor-challenge")).toBe(
      true,
    );
    expect(
      (
        fixture.native.entries.get("v2.ov/root/admission") as {
          payload: { activeChallenges: number };
        }
      ).payload.activeChallenges,
    ).toBe(1);
  });

  test("admits equal-expiry challenges whose IDs collate divergently from code-unit order", async () => {
    const fixture = await enrolledProvider();
    // Both IDs are legal identifiers; locale collation orders "a1…" before
    // "B1…" while the registry validator's code-unit key order requires the
    // reverse, so a locale-sorted expiry index rejects the second issuance.
    for (const challengeID of [
      "a1-collation-challenge-0001",
      "B1-collation-challenge-0001",
    ] as const)
      await Effect.runPromise(
        fixture.provider.issueChallenge(
          {
            challengeID,
            challengeBase64: "challenge-material",
            challengeAudience: "audience",
            devicePublicKey: "device-key",
            expiresAtMilliseconds: 5_000,
            consumed: false,
          },
          1_000,
        ),
      );
    expect(fixture.native.entries.has("v2.ov/device-challenge/a1-collation-challenge-0001")).toBe(
      true,
    );
    expect(fixture.native.entries.has("v2.ov/device-challenge/B1-collation-challenge-0001")).toBe(
      true,
    );
    const index = fixture.native.entries.get("v2.ov/challenge-expiry-index") as {
      payload: { entries: readonly { challengeID: string }[] };
    };
    expect(index.payload.entries.map((entry) => entry.challengeID)).toEqual([
      "B1-collation-challenge-0001",
      "a1-collation-challenge-0001",
    ]);
  });

  test("binds resource, expiry, JTI, and both fingerprints to the claims before any durable write", async () => {
    const fixture = await enrolledProvider();
    const base = {
      ...capabilityFor("identity-bound-jti-0001"),
      operationID: "identity-bound-op-0001",
      nowSeconds: 1_000,
    };
    const substituted = [
      // Resource not named by the fingerprinted claims path.
      { ...base, resource: "/v2/other" },
      // Expiry inside the TTL window but not the signed claims expiry.
      { ...base, expiresAtSeconds: 1_100 },
      // Foreign JTI over another identity's claims bytes.
      { ...base, jti: "identity-bound-jti-0002" },
      // Fingerprint of different bytes than the presented claims.
      { ...base, claimsFingerprint: sha256Hex(new TextEncoder().encode("other-bytes")) },
      // Malformed token fingerprint.
      { ...base, tokenFingerprint: "not-a-digest" },
    ];
    for (const input of substituted) {
      const exit = await Effect.runPromiseExit(fixture.provider.claimCapabilityReceipt(input));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid_input");
    }
    expect(fixture.native.entries.has("v2.ov/capability-receipt/identity-bound-jti-0001")).toBe(
      false,
    );
    expect(fixture.native.entries.has("v2.ov/capability-receipt/identity-bound-jti-0002")).toBe(
      false,
    );
  });

  test("rejects every single substituted identity field against a durable receipt", async () => {
    const fixture = await enrolledProvider();
    const jti = "durable-identity-jti-0001";
    // DO-synthesized socket claims carry no request path, so the resource
    // field itself is replayable material the durable receipt must pin.
    const socketClaims = canonicalJSONStringify({
      deviceID: device.deviceID,
      expiresAt: 1_200,
      frameID: "frame-000000000001",
      jti,
      operationID: "durable-operation-0001",
      sessionID: session.sessionID,
    });
    const base = {
      ...capabilityWithClaims(jti, socketClaims),
      operationID: "durable-operation-0001",
      nowSeconds: 1_000,
    };
    await Effect.runPromise(fixture.provider.claimCapabilityReceipt(base));
    const shiftedClaims = canonicalJSONStringify({
      deviceID: device.deviceID,
      expiresAt: 1_100,
      frameID: "frame-000000000001",
      jti,
      operationID: "durable-operation-0001",
      sessionID: session.sessionID,
    });
    const substituted = [
      // Operation substitution under the same durable JTI.
      { ...base, operationID: "durable-operation-0002" },
      // Resource substitution (unbound by these pathless claims).
      { ...base, resource: "/v2/other" },
      // Expiry substitution carrying internally consistent shifted claims.
      {
        ...capabilityWithClaims(jti, shiftedClaims, 1_100),
        operationID: "durable-operation-0001",
        nowSeconds: 1_000,
      },
      // Token substitution behind the same claims.
      { ...base, tokenFingerprint: "f".repeat(64) },
    ];
    for (const input of substituted) {
      const exit = await Effect.runPromiseExit(fixture.provider.claimCapabilityReceipt(input));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("replay_conflict");
    }

    // Result identity: canonical equality replays, any other result conflicts.
    await Effect.runPromise(
      fixture.provider.completeCapabilityReceipt(base, { first: 1, second: "two" }),
    );
    expect(
      await Effect.runPromise(
        fixture.provider.completeCapabilityReceipt(base, { second: "two", first: 1 }),
      ),
    ).toMatchObject({ state: "COMPLETED", result: { first: 1, second: "two" } });
    const resultConflict = await Effect.runPromiseExit(
      fixture.provider.completeCapabilityReceipt(base, { first: 1, second: "swapped" }),
    );
    expect(Exit.isFailure(resultConflict)).toBe(true);
    expect(JSON.stringify(resultConflict)).toContain("replay_conflict");

    // State substitution inside storage is rejected by the exact per-state
    // key sets: a COMPLETED record demoted to PREPARED keeps its result key.
    const key = `v2.ov/capability-receipt/${jti}`;
    const stored = fixture.native.entries.get(key) as {
      readonly payload: Readonly<Record<string, unknown>>;
    };
    fixture.native.entries.set(key, {
      ...stored,
      payload: { ...stored.payload, state: "PREPARED" },
    });
    const demoted = await Effect.runPromiseExit(fixture.provider.claimCapabilityReceipt(base));
    expect(Exit.isFailure(demoted)).toBe(true);
    expect(JSON.stringify(demoted)).toContain("state_corrupt");
  });

  test("accepts pathless socket claims while still binding their JTI and signed expiry", async () => {
    const fixture = await enrolledProvider();
    const jti = "socket-receipt-jti-00001";
    const socketClaims = canonicalJSONStringify({
      deviceID: device.deviceID,
      expiresAt: 1_200,
      frameID: "frame-000000000002",
      jti,
      operationID: "socket-operation-0001",
      sessionID: session.sessionID,
    });
    const input = {
      ...capabilityWithClaims(jti, socketClaims),
      operationID: "socket-operation-0001",
      nowSeconds: 1_000,
    };
    expect(await Effect.runPromise(fixture.provider.claimCapabilityReceipt(input))).toMatchObject({
      state: "PREPARED",
      jti,
    });
    const expirySwap = await Effect.runPromiseExit(
      fixture.provider.claimCapabilityReceipt({
        ...capabilityWithClaims("socket-receipt-jti-00002", socketClaims, 1_100),
        operationID: "socket-operation-0001",
        nowSeconds: 1_000,
      }),
    );
    expect(Exit.isFailure(expirySwap)).toBe(true);
    expect(JSON.stringify(expirySwap)).toContain("invalid_input");
  });

  test("persists only non-bearer capability material in durable receipts", async () => {
    const fixture = await enrolledProvider();
    const bearer = "v1.signed-capability-payload-bytes.signed-capability-mac-bytes";
    const jti = "non-bearer-receipt-0001";
    const claims = claimsFor(jti);
    const input = {
      jti,
      expiresAtSeconds: 1_200,
      resource: "/v2/sync",
      claims,
      claimsFingerprint: sha256Hex(new TextEncoder().encode(claims)),
      tokenFingerprint: sha256Hex(new TextEncoder().encode(bearer)),
      operationID: "non-bearer-operation-1",
      nowSeconds: 1_000,
    };
    await Effect.runPromise(fixture.provider.claimCapabilityReceipt(input));
    await Effect.runPromise(
      fixture.provider.completeCapabilityReceipt(input, { acknowledged: true }),
    );
    const stored = fixture.native.entries.get(`v2.ov/capability-receipt/${jti}`) as {
      readonly payload: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(stored.payload).sort()).toEqual([
      "claims",
      "claimsFingerprint",
      "expiresAtSeconds",
      "jti",
      "operationID",
      "resource",
      "result",
      "state",
      "tokenFingerprint",
    ]);
    expect(stored.payload.claims).toBe(claims);
    expect(stored.payload.tokenFingerprint).toBe(input.tokenFingerprint);
    // No persisted row anywhere may contain the signed bearer token itself.
    for (const [, value] of fixture.native.entries) {
      expect(JSON.stringify(value)).not.toContain(bearer);
      expect(JSON.stringify(value)).not.toContain("signed-capability-mac-bytes");
    }
  });

  test("serializes concurrent operations while retaining their independent retry identities", async () => {
    const fixture = await enrolledProvider();
    const [first, second] = await Promise.all([
      Effect.runPromise(fixture.provider.append(append())),
      Effect.runPromise(
        fixture.provider.append(
          append({
            operationID: "operation-2",
            fingerprint: "1".repeat(64),
            payloadHash: "2".repeat(64),
            nonce: {
              value: "nonce-222222222222",
              expiresAtSeconds: 1_200,
              fingerprint: "3".repeat(64),
            },
            capability: capabilityFor("jti-222222222222"),
          }),
        ),
      ),
    ]);
    expect([first.logSequence, second.logSequence].sort()).toEqual([1, 2]);
    expect(fixture.native.entries.get("v2.ov/root/log-head")).toMatchObject({
      payload: { appendLogSequence: 2 },
    });
  });

  test("pins every catalogued opaque append after the log advances", async () => {
    const fixture = await enrolledProvider();
    await Effect.runPromise(fixture.provider.append(append()));
    const secondAppend = append({
      operationID: "operation-2",
      fingerprint: "1".repeat(64),
      payloadHash: "2".repeat(64),
      observedHighWater: 1,
      nonce: { value: "nonce-222222222222", expiresAtSeconds: 1_200, fingerprint: "3".repeat(64) },
      capability: capabilityFor("jti-222222222222"),
    });
    await Effect.runPromise(fixture.provider.append(secondAppend));
    const controller = makeOwnerVaultSnapshotPinController(fixture.repository, {
      makePinProof: () => "two-append-catalog-pin-proof-which-is-long-enough",
    });
    const pin = await Effect.runPromise(
      controller.beginSnapshot(
        { ownerID: root.ownerID, vaultID: root.vaultID, generationEpoch: root.generationEpoch },
        "domain-catalog-snapshot-0002",
      ),
    );
    const page = await Effect.runPromise(controller.readSnapshotPage(pin, undefined));
    expect(
      page.entries.filter((entry) => entry.address.category === "append-log.entry"),
    ).toHaveLength(2);
  });

  test("owns session close cleanup and durable rate state", async () => {
    const fixture = await enrolledProvider();
    await Effect.runPromise(fixture.provider.establishSession(session));
    await Effect.runPromise(
      fixture.provider.consumeRate({
        sessionID: session.sessionID,
        nowMilliseconds: 2_000,
        maximumFramesPerMinute: 1,
      }),
    );
    const rateLimited = await Effect.runPromiseExit(
      fixture.provider.consumeRate({
        sessionID: session.sessionID,
        nowMilliseconds: 2_001,
        maximumFramesPerMinute: 1,
      }),
    );
    expect(Exit.isFailure(rateLimited)).toBe(true);
    expect(JSON.stringify(rateLimited)).toContain("rate_limited");

    await Effect.runPromise(
      fixture.provider.deactivateSession({
        sessionID: session.sessionID,
        deviceID: session.deviceID,
        authEpoch: session.authEpoch,
        credentialEpoch: session.credentialEpoch,
      }),
    );
    expect(fixture.native.entries.has(`v2.ov/session/${session.sessionID}`)).toBe(false);
    expect(fixture.native.entries.has(`v2.ov/resume/${session.resumeTokenHash}`)).toBe(false);
    expect(fixture.native.entries.has(`v2.ov/rate-window/${session.sessionID}`)).toBe(false);
  });
});

/**
 * P05-A: target initialization is one native DO transaction. These tests
 * drive the exact transaction composition owner-vault-do.ts uses for
 * `initialize` and `privateInitialize` against the production repository and
 * domain provider, injecting faults at every former independent commit point
 * (the old TX1 root bootstrap, TX2 capability claim, and TX3 acknowledgement
 * boundaries) and proving the durable row set is always empty XOR complete.
 */
const initializationAck = {
  initDigest: "d".repeat(64),
  credentialEpoch: 1,
  routingEpoch: 1,
  controlEpoch: 1,
  durableReceipt: "atomic-init-durable-receipt-0001",
} as const;
const privateAcknowledgement = {
  kind: "private-initialize",
  privateRestoreLink: "1".repeat(64),
  controlDigest: "2".repeat(64),
  durableReceipt: "atomic-private-init-receipt-0001",
} as const;
const privateAuthority = {
  kind: "authority",
  credentialEpoch: 1,
  routingEpoch: 1,
  controlEpoch: 1,
  securityFloor: 4,
} as const;
const sameStoredPayload = (
  value: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean =>
  Object.keys(value).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, item]) => value[key] === item);
/** Models the isolate dying between former commits, inside the one transaction. */
const injectedCrash: OwnerVaultStorageTransactionFailure = {
  _tag: "OwnerVaultStorageError",
  reason: "state_corrupt",
};
const ackConflict: OwnerVaultStorageTransactionFailure = {
  _tag: "OwnerVaultDomainTransactionError",
  reason: "replay_conflict",
};
type FormerBoundary = "root-bootstrap" | "capability-claim" | "acknowledgement";
const formerBoundaries: readonly FormerBoundary[] = [
  "root-bootstrap",
  "capability-claim",
  "acknowledgement",
];
type Repository = ReturnType<typeof makeDurableObjectOwnerVaultStorageRepository>;
type Provider = ReturnType<typeof makeOwnerVaultDomainProvider>;
const crashPoint = (
  crashAfter: FormerBoundary | undefined,
): ((point: FormerBoundary) => Effect.Effect<void, OwnerVaultStorageTransactionFailure>) => {
  return (point) => (crashAfter === point ? Effect.fail(injectedCrash) : Effect.void);
};
/** The exact composed ordinary-initialization transaction from owner-vault-do.ts. */
const atomicInitialize = (
  repository: Repository,
  provider: Provider,
  receipt: OwnerVaultCapabilityReceiptInput,
  crashAfter?: FormerBoundary,
  ack: typeof initializationAck = initializationAck,
) => {
  const crash = crashPoint(crashAfter);
  return repository.transact((tx: OwnerVaultTx) =>
    tx.get({ category: "control.initialization-ack", identifier: receipt.operationID }).pipe(
      Effect.flatMap((existing) => {
        if (existing !== undefined)
          return sameStoredPayload(existing.payload, ack)
            ? Effect.succeed(ack.durableReceipt)
            : Effect.fail(ackConflict);
        return provider.initializeInTx(tx).pipe(
          Effect.zipRight(crash("root-bootstrap")),
          Effect.zipRight(provider.claimCapabilityReceiptInTx(tx, receipt)),
          Effect.zipRight(crash("capability-claim")),
          Effect.zipRight(
            tx.put(
              { category: "control.initialization-ack", identifier: receipt.operationID },
              ack,
            ),
          ),
          Effect.zipRight(crash("acknowledgement")),
          Effect.zipRight(
            provider.completeCapabilityReceiptInTx(tx, receipt, {
              durableReceipt: ack.durableReceipt,
            }),
          ),
          Effect.as(ack.durableReceipt),
        );
      }),
    ),
  );
};
/** The exact composed private-initialization transaction from owner-vault-do.ts. */
const atomicPrivateInitialize = (
  repository: Repository,
  provider: Provider,
  receipt: OwnerVaultCapabilityReceiptInput,
  initID: string,
  crashAfter?: FormerBoundary,
) => {
  const crash = crashPoint(crashAfter);
  return repository.transact((tx: OwnerVaultTx) =>
    tx.get({ category: "control.initialization-ack", identifier: initID }).pipe(
      Effect.flatMap((existing) => {
        if (existing !== undefined)
          return sameStoredPayload(existing.payload, privateAcknowledgement)
            ? Effect.succeed(privateAcknowledgement.durableReceipt)
            : Effect.fail(ackConflict);
        return tx.get({ category: "control.floor-sync", identifier: "authority" }).pipe(
          Effect.flatMap((prior) => {
            if (prior !== undefined && !sameStoredPayload(prior.payload, privateAuthority))
              return Effect.fail(ackConflict);
            return provider.initializeInTx(tx).pipe(
              Effect.zipRight(crash("root-bootstrap")),
              Effect.zipRight(provider.claimCapabilityReceiptInTx(tx, receipt)),
              Effect.zipRight(crash("capability-claim")),
              Effect.zipRight(
                tx.put(
                  { category: "root.floors" },
                  { securityFloor: privateAuthority.securityFloor },
                ),
              ),
              Effect.zipRight(
                tx.put(
                  { category: "control.initialization-ack", identifier: initID },
                  privateAcknowledgement,
                ),
              ),
              Effect.zipRight(
                tx.put(
                  { category: "control.floor-sync", identifier: "authority" },
                  privateAuthority,
                ),
              ),
              Effect.zipRight(crash("acknowledgement")),
              Effect.zipRight(
                provider.completeCapabilityReceiptInTx(tx, receipt, {
                  durableReceipt: privateAcknowledgement.durableReceipt,
                }),
              ),
              Effect.as(privateAcknowledgement.durableReceipt),
            );
          }),
        );
      }),
    ),
  );
};
const ordinaryRowSet = (jti: string, operationID: string): string[] =>
  [
    "v2.ov/root/identity",
    "v2.ov/root/runtime",
    "v2.ov/root/accounting",
    "v2.ov/root/admission",
    "v2.ov/challenge-expiry-index",
    "v2.ov/socket-prepared-index",
    "v2.ov/socket-replay-index",
    "v2.ov/control-receipt-lease-index",
    "v2.ov/root/floors",
    "v2.ov/root/log-head",
    "v2.ov/append-log/head",
    "v2.ov/blob/accounting",
    "v2.ov/catalog/current",
    "v2.ov/catalog/root/00000000000000000000",
    "v2.ov/capability-receipts/index",
    `v2.ov/jti/${jti}`,
    `v2.ov/capability-receipt/${jti}`,
    `v2.ov/control/initialization-ack/${operationID}`,
  ].sort();
const serializedEntries = (entries: Map<string, unknown>): string =>
  JSON.stringify(
    [...entries.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
const restartedFixture = (fixture: ReturnType<typeof providerFor>) => {
  const repository = makeDurableObjectOwnerVaultStorageRepository(
    makeDurableObjectBoundary(fixture.native.state).storage,
  );
  return { repository, provider: makeOwnerVaultDomainProvider(repository, root) };
};

describe("P05-A atomic target initialization", () => {
  test("commits the complete ordinary initialization row set all-or-nothing across every former boundary", async () => {
    const jti = "atomic-init-operation-000001";
    const receipt = { ...capabilityFor(jti), operationID: jti, nowSeconds: 1_000 };
    for (const crashAfter of formerBoundaries) {
      const fixture = providerFor();
      const exit = await Effect.runPromiseExit(
        atomicInitialize(fixture.repository, fixture.provider, receipt, crashAfter),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      // The former commit points are interior fault points now: a crash after
      // any of them must leave no root, floor, receipt, index, accounting,
      // log head, acknowledgement, or catalog row at all.
      expect(fixture.native.entries.size).toBe(0);
    }
    const fixture = providerFor();
    const ack = await Effect.runPromise(
      atomicInitialize(fixture.repository, fixture.provider, receipt),
    );
    expect(ack).toBe(initializationAck.durableReceipt);
    expect([...fixture.native.entries.keys()].sort()).toEqual(ordinaryRowSet(jti, jti));
    // The capability receipt is committed terminal: no PREPARED intermediate
    // is ever durable for initialization.
    expect(fixture.native.entries.get(`v2.ov/capability-receipt/${jti}`)).toMatchObject({
      payload: { state: "COMPLETED", result: { durableReceipt: initializationAck.durableReceipt } },
    });
    expect(fixture.native.entries.get("v2.ov/root/floors")).toMatchObject({
      payload: { securityFloor: 0 },
    });
  });

  test("replays the stored acknowledgement across a restart in one read-only transaction", async () => {
    const jti = "atomic-init-operation-000002";
    const receipt = { ...capabilityFor(jti), operationID: jti, nowSeconds: 1_000 };
    const fixture = providerFor();
    const first = await Effect.runPromise(
      atomicInitialize(fixture.repository, fixture.provider, receipt),
    );
    const before = serializedEntries(fixture.native.entries);
    fixture.native.writes.count = 0;
    fixture.native.transactions.count = 0;
    const restarted = restartedFixture(fixture);
    const replay = await Effect.runPromise(
      atomicInitialize(restarted.repository, restarted.provider, receipt),
    );
    expect(replay).toBe(first);
    // Exactly one transaction, zero attempted writes: the stored ACK is
    // returned without re-running initialization, claim, or completion.
    expect(fixture.native.transactions.count).toBe(1);
    expect(fixture.native.writes.count).toBe(0);
    expect(serializedEntries(fixture.native.entries)).toBe(before);
  });

  test("leaves a fresh target completely unwritten when the capability receipt input fails", async () => {
    // Under the former four-transaction sequence this scenario committed the
    // full root bootstrap before the claim was rejected.
    const jti = "atomic-init-operation-000003";
    const receipt = {
      ...capabilityFor(jti),
      operationID: jti,
      nowSeconds: 1_000,
      tokenFingerprint: "not-a-digest",
    };
    const fixture = providerFor();
    const exit = await Effect.runPromiseExit(
      atomicInitialize(fixture.repository, fixture.provider, receipt),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fixture.native.entries.size).toBe(0);
  });

  test("rejects a substituted JTI and a conflicting acknowledgement with byte-identical storage", async () => {
    const jti = "atomic-init-operation-000004";
    const receipt = { ...capabilityFor(jti), operationID: jti, nowSeconds: 1_000 };
    const fixture = providerFor();
    await Effect.runPromise(atomicInitialize(fixture.repository, fixture.provider, receipt));
    const before = serializedEntries(fixture.native.entries);

    // A different durable operation presenting the already-claimed JTI must
    // roll back to byte-identical rows: no acknowledgement, receipt, index,
    // admission, or accounting change survives.
    const substituted = {
      ...capabilityFor(jti),
      operationID: "atomic-init-operation-000005",
      nowSeconds: 1_000,
    };
    const substitutedExit = await Effect.runPromiseExit(
      atomicInitialize(fixture.repository, fixture.provider, substituted),
    );
    expect(Exit.isFailure(substitutedExit)).toBe(true);
    expect(JSON.stringify(substitutedExit)).toContain("replay_conflict");
    expect(serializedEntries(fixture.native.entries)).toBe(before);
    expect(
      fixture.native.entries.has("v2.ov/control/initialization-ack/atomic-init-operation-000005"),
    ).toBe(false);

    // The same operation replayed with divergent acknowledgement bytes is a
    // conflict, never a second initialization.
    const conflictingAck = { ...initializationAck, initDigest: "e".repeat(64) };
    const conflictExit = await Effect.runPromiseExit(
      atomicInitialize(fixture.repository, fixture.provider, receipt, undefined, conflictingAck),
    );
    expect(Exit.isFailure(conflictExit)).toBe(true);
    expect(JSON.stringify(conflictExit)).toContain("replay_conflict");
    expect(serializedEntries(fixture.native.entries)).toBe(before);
  });

  test("commits private initialization atomically and only ever the signed security floor", async () => {
    const jti = "atomic-private-init-jti-000001";
    const operationID = "atomic-private-init-op-000001";
    const initID = "atomic-private-init-id-000001";
    const receipt = { ...capabilityFor(jti), operationID, nowSeconds: 1_000 };
    for (const crashAfter of formerBoundaries) {
      const fixture = providerFor();
      const exit = await Effect.runPromiseExit(
        atomicPrivateInitialize(fixture.repository, fixture.provider, receipt, initID, crashAfter),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(fixture.native.entries.size).toBe(0);
      // In particular the default-zero floors intermediate never survives.
      expect(fixture.native.entries.has("v2.ov/root/floors")).toBe(false);
    }
    const fixture = providerFor();
    const ack = await Effect.runPromise(
      atomicPrivateInitialize(fixture.repository, fixture.provider, receipt, initID),
    );
    expect(ack).toBe(privateAcknowledgement.durableReceipt);
    expect([...fixture.native.entries.keys()].sort()).toEqual(
      [...ordinaryRowSet(jti, initID), "v2.ov/control/floor-sync/authority"].sort(),
    );
    // The committed floor is the signed value in one write, never 0 first.
    expect(fixture.native.entries.get("v2.ov/root/floors")).toMatchObject({
      payload: { securityFloor: privateAuthority.securityFloor },
    });
    expect(fixture.native.entries.get("v2.ov/control/floor-sync/authority")).toMatchObject({
      payload: privateAuthority,
    });

    // Substituted JTI under a fresh initID: nothing changes, no authority,
    // acknowledgement, floor, log-head, accounting, or catalog row moves.
    const before = serializedEntries(fixture.native.entries);
    const substituted = {
      ...capabilityFor(jti),
      operationID: "atomic-private-init-op-000002",
      nowSeconds: 1_000,
    };
    const substitutedExit = await Effect.runPromiseExit(
      atomicPrivateInitialize(
        fixture.repository,
        fixture.provider,
        substituted,
        "atomic-private-init-id-000002",
      ),
    );
    expect(Exit.isFailure(substitutedExit)).toBe(true);
    expect(JSON.stringify(substitutedExit)).toContain("replay_conflict");
    expect(serializedEntries(fixture.native.entries)).toBe(before);

    // Exact replay across a restart is one read-only transaction.
    fixture.native.writes.count = 0;
    fixture.native.transactions.count = 0;
    const restarted = restartedFixture(fixture);
    const replay = await Effect.runPromise(
      atomicPrivateInitialize(restarted.repository, restarted.provider, receipt, initID),
    );
    expect(replay).toBe(ack);
    expect(fixture.native.transactions.count).toBe(1);
    expect(fixture.native.writes.count).toBe(0);
    expect(serializedEntries(fixture.native.entries)).toBe(before);
  });
});

/**
 * P06-R: the universal receipt lifecycle proofs. Interior write faults model
 * the isolate dying inside the one composed device-challenge transaction at
 * every formerly independent commit point; reclamation proofs enumerate the
 * exact durable key set an alarm fire removes and the exact counts and next
 * alarm instant it restores.
 */
describe("P06-R universal receipt reclamation", () => {
  const faultable = () => {
    const entries = new Map<string, unknown>();
    const fault = { key: undefined as string | undefined };
    const alarm = { value: null as number | null };
    let pending = Promise.resolve();
    const transaction: DurableObjectTransactionNative = {
      get: (key) => Promise.resolve(entries.get(key)),
      put: (key, value) => {
        if (fault.key !== undefined && key === fault.key)
          return Promise.reject(new Error(`injected native fault at ${key}`));
        entries.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => Promise.resolve(entries.delete(key)),
      getAlarm: () => Promise.resolve(alarm.value),
      setAlarm: (value) => {
        alarm.value = value;
        return Promise.resolve();
      },
      deleteAlarm: () => {
        alarm.value = null;
        return Promise.resolve();
      },
    };
    const storage: DurableObjectStorageNative = {
      ...transaction,
      transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
        const run = pending.then(async () => {
          const before = new Map(entries);
          const beforeAlarm = alarm.value;
          try {
            return await work(transaction);
          } catch (error: unknown) {
            entries.clear();
            for (const [key, value] of before) entries.set(key, value);
            alarm.value = beforeAlarm;
            throw error;
          }
        });
        pending = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    };
    const state: DurableObjectStateNative = { storage, blockConcurrencyWhile: (work) => work() };
    const repository = makeDurableObjectOwnerVaultStorageRepository(
      makeDurableObjectBoundary(state).storage,
    );
    return {
      entries,
      alarm,
      fault,
      repository,
      provider: makeOwnerVaultDomainProvider(repository, root),
    };
  };

  test("commits the composed device-challenge row set empty-XOR-complete when any interior write faults", async () => {
    const receipt = {
      ...capabilityFor("p06r-challenge-fault-jti-0001"),
      operationID: "p06r-challenge-fault-op-0001",
      nowSeconds: 1_000,
    };
    const challenge: OwnerVaultChallenge = {
      challengeID: "p06r-challenge-fault-chal-0001",
      challengeBase64: "challenge-material",
      challengeAudience: "audience",
      devicePublicKey: "device-key",
      expiresAtMilliseconds: 1_100_000,
      consumed: false,
    };
    const result = {
      protocolVersion: 2,
      challengeID: challenge.challengeID,
      challengeBase64: challenge.challengeBase64,
      expiresAt: challenge.expiresAtMilliseconds,
    };
    // The formerly separate commit points, now interior rows of one native
    // transaction: quota/challenge admission, JTI claim, receipt completion.
    const interiorRows = [
      `v2.ov/device-challenge/${challenge.challengeID}`,
      `v2.ov/jti/${receipt.jti}`,
      `v2.ov/capability-receipt/${receipt.jti}`,
      "v2.ov/capability-receipts/index",
      "v2.ov/root/admission",
      "v2.ov/challenge-expiry-index",
    ];
    const fixture = faultable();
    await Effect.runPromise(fixture.provider.initialize());
    const before = serializedEntries(fixture.entries);
    const beforeAlarm = fixture.alarm.value;
    for (const faultKey of interiorRows) {
      fixture.fault.key = faultKey;
      const exit = await Effect.runPromiseExit(
        fixture.repository.transact((tx) =>
          fixture.provider.issueChallengeWithCapabilityReceiptInTx(
            tx,
            receipt,
            challenge,
            result,
            1_000,
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      // Empty XOR complete: a fault at any interior row leaves storage and
      // the shared alarm byte-identical, with no second challenge and no
      // consumed quota unit.
      expect(serializedEntries(fixture.entries)).toBe(before);
      expect(fixture.alarm.value).toBe(beforeAlarm);
    }
    fixture.fault.key = undefined;
    const completed = await Effect.runPromise(
      fixture.repository.transact((tx) =>
        fixture.provider.issueChallengeWithCapabilityReceiptInTx(
          tx,
          receipt,
          challenge,
          result,
          1_000,
        ),
      ),
    );
    expect(completed.state).toBe("COMPLETED");
    expect(completed.result).toEqual(result);
    for (const key of interiorRows) expect(fixture.entries.has(key)).toBe(true);
    // The one committed transaction armed the earliest expiry: the challenge
    // deadline precedes the signed receipt expiry here.
    expect(fixture.alarm.value).toBe(1_100_000);
  });

  test("recomputes the earliest reclamation alarm across varied claim expiries and reaps by exact keys", async () => {
    const fixture = await enrolledProvider();
    fixture.native.alarm.value = null;
    const claim = (jti: string, expiresAtSeconds: number) => {
      const claims = claimsFor(jti, { expiresAt: expiresAtSeconds });
      return Effect.runPromise(
        fixture.provider.claimCapabilityReceipt({
          ...capabilityWithClaims(jti, claims, expiresAtSeconds),
          operationID: `${jti}-op`,
          nowSeconds: 1_000,
        }),
      );
    };
    await claim("p06r-varied-mid-jti-000001", 1_150);
    expect(fixture.native.alarm.value as number | null).toBe(1_150_000);
    await claim("p06r-varied-early-jti-00001", 1_100);
    expect(fixture.native.alarm.value as number | null).toBe(1_100_000);
    // A later expiry never postpones the earliest scheduled reclamation.
    await claim("p06r-varied-late-jti-000001", 1_250);
    expect(fixture.native.alarm.value as number | null).toBe(1_100_000);

    const before = new Set(fixture.native.entries.keys());
    // The fired alarm was consumed; reclamation re-arms in its transaction.
    fixture.native.alarm.value = null;
    expect(await Effect.runPromise(fixture.provider.expireCapabilities(1_150))).toBe(1_250);
    const after = new Set(fixture.native.entries.keys());
    // Exact keys, no scan: only the two expired receipts and their JTIs left.
    expect([...before].filter((key) => !after.has(key)).sort()).toEqual([
      "v2.ov/capability-receipt/p06r-varied-early-jti-00001",
      "v2.ov/capability-receipt/p06r-varied-mid-jti-000001",
      "v2.ov/jti/p06r-varied-early-jti-00001",
      "v2.ov/jti/p06r-varied-mid-jti-000001",
    ]);
    expect([...after].filter((key) => !before.has(key))).toEqual([]);
    expect(
      (
        fixture.native.entries.get("v2.ov/root/admission") as {
          payload: { capabilityReceipts: number };
        }
      ).payload.capabilityReceipts,
    ).toBe(1);
    expect(
      (
        fixture.native.entries.get("v2.ov/capability-receipts/index") as {
          payload: { entries: readonly unknown[] };
        }
      ).payload.entries,
    ).toHaveLength(1);
    expect(fixture.native.alarm.value as number | null).toBe(1_250_000);
  });

  test("frees exhausted receipt quota through alarm reclamation and admits the next claim", async () => {
    const fixture = await enrolledProvider();
    for (let index = 0; index < 64; index += 1) {
      const jti = `p06r-quota-jti-${String(index).padStart(4, "0")}`;
      const claims = claimsFor(jti, { expiresAt: 1_050 });
      await Effect.runPromise(
        fixture.provider.claimCapabilityReceipt({
          ...capabilityWithClaims(jti, claims, 1_050),
          operationID: `${jti}-op`,
          nowSeconds: 1_000,
        }),
      );
    }
    const overCapacity = await Effect.runPromiseExit(
      fixture.provider.claimCapabilityReceipt({
        ...capabilityFor("p06r-quota-overflow-jti-0001"),
        operationID: "p06r-quota-overflow-op-0001",
        nowSeconds: 1_000,
      }),
    );
    expect(Exit.isFailure(overCapacity)).toBe(true);
    expect(JSON.stringify(overCapacity)).toContain("quota_exceeded");
    // The alarm reclaims every expired slot in one bounded transaction; the
    // exact freed capacity admits the previously rejected claim.
    expect(await Effect.runPromise(fixture.provider.expireCapabilities(1_050))).toBeUndefined();
    const admitted = await Effect.runPromise(
      fixture.provider.claimCapabilityReceipt({
        ...capabilityFor("p06r-quota-overflow-jti-0001"),
        operationID: "p06r-quota-overflow-op-0001",
        nowSeconds: 1_000,
      }),
    );
    expect(admitted.state).toBe("PREPARED");
    expect(
      (
        fixture.native.entries.get("v2.ov/root/admission") as {
          payload: { capabilityReceipts: number };
        }
      ).payload.capabilityReceipts,
    ).toBe(1);
  });
});
