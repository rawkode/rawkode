import { describe, expect, test } from "bun:test";
import { protocolVersion, syncFrameSigningPayloadVersion } from "@enchiridion/protocol";
import { CapabilityAudience, CapabilityAuthority, CapabilityMethod } from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import {
  acceptHello,
  decodeOwnerVaultClientFrame,
  decodeOwnerVaultFrameSource,
  decodeOwnerVaultSocketAttachment,
  handleSyncChange,
  issueServerHelloChallenge,
  ownerVaultUpgradeBinding,
  verifyOwnerVaultCapability,
} from "./service";
import {
  OwnerVaultDurableSyncRepository,
  type OwnerVaultDurableSyncRepository as OwnerVaultDurableSyncRepositoryService,
  type OwnerVaultSession,
  type OwnerVaultSocketAttachment,
  OwnerVaultSyncDependencies,
  type OwnerVaultSyncDependencies as OwnerVaultSyncDependenciesService,
  OwnerVaultSyncError,
} from "./types";

const signature =
  "MEQCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiAdJE0zr1rutsPCcv5D87CdiwnjOi3YRwWIyupgxSiyew==";
const frameID = "AAAAAAAAAAAAAAAAAAAAAA";
const resumeToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const identity = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 3 };
const nowMilliseconds = 1_760_000_000_000;
const nowSeconds = Math.floor(nowMilliseconds / 1000);
const claims = {
  audience: CapabilityAudience.OwnerVault,
  authority: CapabilityAuthority.OwnerVault,
  keyID: "capability-1",
  jti: "AAAAAAAAAAAAAAAA",
  issuedAt: nowSeconds - 1,
  expiresAt: nowSeconds + 60,
  credentialEpoch: 2,
  generationEpoch: identity.generationEpoch,
  method: CapabilityMethod.GET,
  path: "/v2/sync",
  canonicalQuery: "",
  bodySHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ownerID: identity.ownerID,
  vaultID: identity.vaultID,
};

const hello = {
  type: "hello" as const,
  protocolVersion,
  connectionNonce: frameID,
  deviceID: "device-1",
  authEpoch: 4,
  deviceSignature: signature,
};

const syncChange = {
  type: "syncChange" as const,
  protocolVersion,
  vaultID: identity.vaultID,
  deviceID: "device-1",
  authEpoch: 4,
  credentialEpoch: 2,
  generationEpoch: identity.generationEpoch,
  sessionNonce: frameID,
  assertionExpiresAt: nowMilliseconds + 30_000,
  changeID: "change-1",
  causalVersion: 1,
  frameID: "AQEBAQEBAQEBAQEBAQEBAQ",
  signingPayloadVersion: syncFrameSigningPayloadVersion,
  payloadBase64: "AA==",
  deviceSignature: signature,
};

const failed = <A>(reason: OwnerVaultSyncError["reason"]): Effect.Effect<A, OwnerVaultSyncError> =>
  Effect.fail(new OwnerVaultSyncError({ reason }));

const durable: OwnerVaultDurableSyncRepositoryService = {
  establish: (candidate, presented, next) => {
    if (presented !== undefined && presented !== resumeToken) return failed("session_invalid");
    if (next.length !== 43) return failed("session_invalid");
    return Effect.succeed(candidate);
  },
  transactFrame: (session, frame, requestHash, _nowMilliseconds, _maximumFramesPerMinute, apply) =>
    apply.pipe(Effect.map((response) => ({ session, response }))),
};

const dependencies: OwnerVaultSyncDependenciesService = {
  capabilities: { verify: () => Effect.succeed(claims) },
  jti: { claim: () => Effect.succeed("claimed"), releaseTransient: () => Effect.void },
  devices: {
    issueHelloChallenge: () => Effect.succeed({ authEpoch: 4, credentialEpoch: 2 }),
    acceptHello: () =>
      Effect.succeed({
        deviceID: "device-1",
        authEpoch: 4,
        credentialEpoch: 2,
        assertionExpiresAt: nowMilliseconds + 30_000,
      }),
    authorizeChange: () => Effect.void,
  },
  mutations: {
    apply: (_session, frame) =>
      Effect.succeed({
        type: "syncAcknowledged",
        protocolVersion,
        vaultID: identity.vaultID,
        changeID: frame.changeID,
        causalVersion: frame.causalVersion,
      }),
  },
  atomicChanges: {
    authorizeClaimAndApply: (session, frame, _payload, requestNow) =>
      dependencies.mutations.apply(session, frame, requestNow),
  },
  sessionNonce: { next: () => Effect.succeed(frameID) },
  resumeTokens: { next: () => Effect.succeed(resumeToken) },
  limits: {
    maximumFrameBytes: 4096,
    maximumAttachmentBytes: 4096,
    maximumSessions: 2,
    maximumFramesPerMinute: 2,
  },
};

const provideWith = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    OwnerVaultSyncDependenciesService | OwnerVaultDurableSyncRepositoryService
  >,
  providedDependencies: OwnerVaultSyncDependenciesService,
  providedDurable: OwnerVaultDurableSyncRepositoryService,
) =>
  Effect.provideService(
    Effect.provideService(effect, OwnerVaultDurableSyncRepository, providedDurable),
    OwnerVaultSyncDependencies,
    providedDependencies,
  );
const provide = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    OwnerVaultSyncDependenciesService | OwnerVaultDurableSyncRepositoryService
  >,
) => provideWith(effect, dependencies, durable);
const run = <A>(
  effect: Effect.Effect<
    A,
    OwnerVaultSyncError,
    OwnerVaultSyncDependenciesService | OwnerVaultDurableSyncRepositoryService
  >,
) => Effect.runPromise(provide(effect));

const challenge = {
  type: "serverHelloChallenge" as const,
  protocolVersion,
  connectionNonce: frameID,
  issuedAt: nowMilliseconds,
  expiresAt: nowMilliseconds + 60_000,
  ownerID: identity.ownerID,
  vaultID: identity.vaultID,
  authEpoch: 4,
  credentialEpoch: 2,
  generationEpoch: identity.generationEpoch,
};
const waitingAttachment: OwnerVaultSocketAttachment = {
  version: 1,
  state: "awaitingHello",
  identity,
  capabilityJTI: claims.jti,
  capabilityExpiresAt: claims.expiresAt,
  challenge,
};

describe("OwnerVault v2 sync state machine", () => {
  test("uses the schema-derived duplicate rejecting wrapper before a frame reaches the state machine", async () => {
    const duplicate = await Effect.runPromiseExit(
      decodeOwnerVaultClientFrame(
        `{"type":"hello","protocolVersion":2,"protocolVersion":2,"connectionNonce":"${frameID}","deviceID":"device-1","authEpoch":4,"deviceSignature":"${signature}"}`,
        4096,
      ),
    );
    expect(Exit.isFailure(duplicate)).toBe(true);
    expect(
      await Effect.runPromise(decodeOwnerVaultClientFrame(JSON.stringify(hello), 4096)),
    ).toEqual(hello);
  });

  test("rejects oversized transport input before binary decoding and before JSON parsing", () => {
    let decoded = false;
    expect(() =>
      decodeOwnerVaultFrameSource(new ArrayBuffer(4_097), 4_096, () => {
        decoded = true;
        return "{}";
      }),
    ).toThrow("frame too large");
    expect(decoded).toBe(false);
    expect(() => decodeOwnerVaultFrameSource("x".repeat(4_097), 4_096, () => "{}")).toThrow(
      "frame too large",
    );
    // UTF-16 character count may fit while UTF-8 byte count exceeds the cap.
    expect(() => decodeOwnerVaultFrameSource("é".repeat(2_049), 4_096, () => "{}")).toThrow(
      "frame too large",
    );
  });

  test("issues a bounded server-first challenge and rejects forged attachment identity or JTI", async () => {
    expect(await run(issueServerHelloChallenge(identity, 2, nowMilliseconds))).toEqual(challenge);
    expect(decodeOwnerVaultSocketAttachment(waitingAttachment, 4096)).toEqual(waitingAttachment);
    expect(
      decodeOwnerVaultSocketAttachment(
        { ...waitingAttachment, challenge: { ...challenge, vaultID: "vault-2" } },
        4096,
      ),
    ).toBeUndefined();
    expect(
      decodeOwnerVaultSocketAttachment({ ...waitingAttachment, untrusted: "not persisted" }, 4096),
    ).toBeUndefined();
  });

  test("requires the exact server challenge and creates a rotated-token active session", async () => {
    const verified = await run(
      verifyOwnerVaultCapability({ value: "capability" }, ownerVaultUpgradeBinding(), nowSeconds),
    );
    const accepted = await run(acceptHello(waitingAttachment, hello, nowMilliseconds));
    expect(accepted.response).toMatchObject({
      type: "helloAccepted",
      resumeToken,
      sessionNonce: frameID,
    });
    expect(decodeOwnerVaultSocketAttachment(accepted.attachment, 4096)).toEqual(
      accepted.attachment,
    );
    expect(verified.identity).toEqual(identity);
    const badNonce = await Effect.runPromiseExit(
      provide(
        acceptHello(
          waitingAttachment,
          { ...hello, connectionNonce: "AQEBAQEBAQEBAQEBAQEBAQ" },
          nowMilliseconds,
        ),
      ),
    );
    expect(Exit.isFailure(badNonce)).toBe(true);
  });

  test("brackets every post-claim hello failure with one transient JTI release and retry", async () => {
    const scenarios: ReadonlyArray<{
      readonly name: string;
      readonly dependencies: () => OwnerVaultSyncDependenciesService;
      readonly durable: () => OwnerVaultDurableSyncRepositoryService;
    }> = [
      {
        name: "nonce issuer failure",
        dependencies: () => {
          let first = true;
          return {
            ...dependencies,
            sessionNonce: {
              next: () => {
                if (first) {
                  first = false;
                  return failed("authorization_denied");
                }
                return Effect.succeed(frameID);
              },
            },
          };
        },
        durable: () => durable,
      },
      {
        name: "invalid generated session nonce",
        dependencies: () => {
          let first = true;
          return {
            ...dependencies,
            sessionNonce: {
              next: () => {
                if (first) {
                  first = false;
                  return Effect.succeed("not-a-session-nonce");
                }
                return Effect.succeed(frameID);
              },
            },
          };
        },
        durable: () => durable,
      },
      {
        name: "resume-token rotation failure",
        dependencies: () => {
          let first = true;
          return {
            ...dependencies,
            resumeTokens: {
              next: () => {
                if (first) {
                  first = false;
                  return failed("session_invalid");
                }
                return Effect.succeed(resumeToken);
              },
            },
          };
        },
        durable: () => durable,
      },
      {
        name: "invalid generated resume token",
        dependencies: () => {
          let first = true;
          return {
            ...dependencies,
            resumeTokens: {
              next: () => {
                if (first) {
                  first = false;
                  return Effect.succeed("not-a-resume-token");
                }
                return Effect.succeed(resumeToken);
              },
            },
          };
        },
        durable: () => durable,
      },
      {
        name: "invalid durable session candidate",
        dependencies: () => {
          let first = true;
          return {
            ...dependencies,
            devices: {
              ...dependencies.devices,
              acceptHello: () => {
                if (first) {
                  first = false;
                  return Effect.succeed({
                    deviceID: "device-1",
                    authEpoch: 4,
                    credentialEpoch: 2,
                    assertionExpiresAt: 4_102_444_800_001,
                  });
                }
                return Effect.succeed({
                  deviceID: "device-1",
                  authEpoch: 4,
                  credentialEpoch: 2,
                  assertionExpiresAt: nowMilliseconds + 30_000,
                });
              },
            },
          };
        },
        durable: () => durable,
      },
      {
        name: "durable repository/token rotation failure",
        dependencies: () => dependencies,
        durable: () => {
          let first = true;
          return {
            ...durable,
            establish: (candidate, presented, next, now) => {
              if (first) {
                first = false;
                return failed("session_invalid");
              }
              return durable.establish(candidate, presented, next, now);
            },
          };
        },
      },
    ];

    for (const scenario of scenarios) {
      let claimedOperation: string | undefined;
      let released = 0;
      const retryableLedger: OwnerVaultSyncDependenciesService["jti"] = {
        claim: (_jti, operation) => {
          if (claimedOperation === undefined) {
            claimedOperation = operation;
            return Effect.succeed("claimed");
          }
          return Effect.succeed("duplicate");
        },
        releaseTransient: (_jti, operation) => {
          if (claimedOperation === operation) {
            claimedOperation = undefined;
            released += 1;
          }
          return Effect.void;
        },
      };
      const scenarioDependencies: OwnerVaultSyncDependenciesService = {
        ...scenario.dependencies(),
        jti: retryableLedger,
      };
      const scenarioDurable = scenario.durable();
      const failure = await Effect.runPromiseExit(
        provideWith(
          acceptHello(waitingAttachment, hello, nowMilliseconds),
          scenarioDependencies,
          scenarioDurable,
        ),
      );
      expect(Exit.isFailure(failure), scenario.name).toBe(true);
      expect(released, scenario.name).toBe(1);

      const retry = await Effect.runPromise(
        provideWith(
          acceptHello(waitingAttachment, hello, nowMilliseconds),
          scenarioDependencies,
          scenarioDurable,
        ),
      );
      expect(retry.response.type, scenario.name).toBe("helloAccepted");
      expect(released, scenario.name).toBe(1);
      expect(
        await Effect.runPromise(
          retryableLedger.claim(claims.jti, "hello:3:other-device", claims.expiresAt),
        ),
        scenario.name,
      ).toBe("duplicate");
    }
  });

  test("preserves the primary post-claim failure when durable JTI cleanup records pending work", async () => {
    let cleanupPending = false;
    const cleanupFailingDependencies: OwnerVaultSyncDependenciesService = {
      ...dependencies,
      sessionNonce: { next: () => Effect.succeed("not-a-session-nonce") },
      jti: {
        claim: () => Effect.succeed("claimed"),
        releaseTransient: () => {
          // A durable ledger records this for its idempotent retry worker before
          // reporting the transient storage fault to the caller.
          cleanupPending = true;
          return failed("quota_exceeded");
        },
      },
    };
    const result = await Effect.runPromiseExit(
      provideWith(
        acceptHello(waitingAttachment, hello, nowMilliseconds),
        cleanupFailingDependencies,
        durable,
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(cleanupPending).toBe(true);
    expect(JSON.stringify(result)).toContain("authorization_denied");
    expect(JSON.stringify(result)).not.toContain("quota_exceeded");
  });

  test("binds each change to durable session floors and an atomic replay receipt", async () => {
    const accepted = await run(acceptHello(waitingAttachment, hello, nowMilliseconds));
    const acknowledged = await run(
      handleSyncChange(accepted.attachment, syncChange, nowMilliseconds + 1),
    );
    expect(acknowledged.response).toEqual({
      type: "syncAcknowledged",
      protocolVersion,
      vaultID: identity.vaultID,
      changeID: syncChange.changeID,
      causalVersion: syncChange.causalVersion,
    });
    const stale = await Effect.runPromiseExit(
      provide(
        handleSyncChange(accepted.attachment, { ...syncChange, authEpoch: 5 }, nowMilliseconds + 1),
      ),
    );
    expect(Exit.isFailure(stale)).toBe(true);
  });

  test("treats attachment rate fields as informational after forged or stale serialization", async () => {
    const accepted = await run(acceptHello(waitingAttachment, hello, nowMilliseconds));
    if (accepted.attachment.session === undefined) throw new Error("expected active attachment");
    const activeSession: OwnerVaultSession = accepted.attachment.session;
    const forgedAttachment: OwnerVaultSocketAttachment = {
      ...accepted.attachment,
      session: {
        ...activeSession,
        // A forged hibernation attachment must not reset durable quota.
        rateCount: 0,
        rateWindowStartedAtMilliseconds: nowMilliseconds,
      },
    };
    const makeAuthoritativeRepository = (
      initialCount: number,
    ): OwnerVaultDurableSyncRepositoryService => {
      let persisted: OwnerVaultSession = {
        ...activeSession,
        rateCount: initialCount,
        rateWindowStartedAtMilliseconds: nowMilliseconds,
      };
      return {
        ...durable,
        transactFrame: (untrusted, _frame, _hash, _now, maximumFramesPerMinute, apply) => {
          // This is the repository contract the real DO implementation uses:
          // attachment rate state is ignored in favor of the persisted record.
          expect(untrusted.rateCount).toBe(0);
          if (persisted.rateCount >= maximumFramesPerMinute) return failed("quota_exceeded");
          persisted = { ...persisted, rateCount: persisted.rateCount + 1 };
          return apply.pipe(Effect.map((response) => ({ session: persisted, response })));
        },
      };
    };

    const atDurableLimit = await Effect.runPromiseExit(
      provideWith(
        handleSyncChange(forgedAttachment, syncChange, nowMilliseconds + 1),
        dependencies,
        makeAuthoritativeRepository(2),
      ),
    );
    expect(Exit.isFailure(atDurableLimit)).toBe(true);
    expect(JSON.stringify(atDurableLimit)).toContain("quota_exceeded");

    const repository = makeAuthoritativeRepository(1);
    // Simulate a successful durable commit followed by serializeAttachment
    // failing: deliberately discard the returned, rate=2 attachment.
    const committed = await Effect.runPromise(
      provideWith(
        handleSyncChange(forgedAttachment, syncChange, nowMilliseconds + 1),
        dependencies,
        repository,
      ),
    );
    expect(committed.attachment.session?.rateCount).toBe(2);
    const staleRetry = await Effect.runPromiseExit(
      provideWith(
        handleSyncChange(forgedAttachment, syncChange, nowMilliseconds + 1),
        dependencies,
        repository,
      ),
    );
    expect(Exit.isFailure(staleRetry)).toBe(true);
    expect(JSON.stringify(staleRetry)).toContain("quota_exceeded");
  });

  test("treats signed assertion expiry as epoch milliseconds", async () => {
    const accepted = await run(acceptHello(waitingAttachment, hello, nowMilliseconds));
    const expired = await Effect.runPromiseExit(
      provide(handleSyncChange(accepted.attachment, syncChange, nowMilliseconds + 30_000)),
    );
    expect(Exit.isFailure(expired)).toBe(true);
    expect(JSON.stringify(expired)).toContain("session_expired");
  });
});
