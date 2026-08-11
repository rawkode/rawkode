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
  type OwnerVaultDevice,
  type OwnerVaultSessionRecord,
  makeOwnerVaultDomainProvider,
} from "./domains";
import { makeDurableObjectOwnerVaultStorageRepository } from "./repository";
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
} => {
  const entries = new Map<string, unknown>();
  let pending = Promise.resolve();
  const transaction: DurableObjectTransactionNative = {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(entries.delete(key)),
  };
  const storage: DurableObjectStorageNative = {
    ...transaction,
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
    transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
      const run = pending.then(async () => {
        const before = new Map(entries);
        try {
          return await work(transaction);
        } catch (error: unknown) {
          entries.clear();
          for (const [key, value] of before) entries.set(key, value);
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
  return { entries, storage, state: { storage, blockConcurrencyWhile: (work) => work() } };
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
