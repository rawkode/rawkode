/** Test-only real Workerd entry for the OwnerVault v2 hibernation state machine. */
import { CapabilityAudience, CapabilityAuthority, CapabilityMethod } from "@enchiridion/runtime";
import { Effect } from "effect";
import { makeOwnerVaultDO } from "./owner-vault-do";
import { type OwnerVaultSyncDependencies, OwnerVaultSyncError } from "./v2/sync/types";

const capabilityValues = new Map<string, { readonly jti: string; readonly ownerID: string }>([
  ["test-owner-vault-capability", { jti: "AAAAAAAAAAAAAAAA", ownerID: "owner-1" }],
  ["test-owner-vault-capability-2", { jti: "BBBBBBBBBBBBBBBB", ownerID: "owner-1" }],
  ["test-owner-vault-capability-3", { jti: "CCCCCCCCCCCCCCCC", ownerID: "owner-1" }],
  ["test-owner-vault-capability-4", { jti: "DDDDDDDDDDDDDDDD", ownerID: "owner-2" }],
  ["test-owner-vault-capability-5", { jti: "EEEEEEEEEEEEEEEE", ownerID: "owner-1" }],
  ["test-owner-vault-capability-6", { jti: "FFFFFFFFFFFFFFFF", ownerID: "owner-1" }],
  ["test-owner-vault-capability-7", { jti: "GGGGGGGGGGGGGGGG", ownerID: "owner-1" }],
  ["test-owner-vault-capability-8", { jti: "HHHHHHHHHHHHHHHH", ownerID: "owner-1" }],
  ["test-owner-vault-capability-9", { jti: "IIIIIIIIIIIIIIII", ownerID: "owner-1" }],
  ["test-owner-vault-capability-10", { jti: "JJJJJJJJJJJJJJJJ", ownerID: "owner-1" }],
  ["test-owner-vault-capability-11", { jti: "KKKKKKKKKKKKKKKK", ownerID: "owner-1" }],
  ["test-owner-vault-capability-12", { jti: "LLLLLLLLLLLLLLLL", ownerID: "owner-1" }],
  ["test-owner-vault-capability-13", { jti: "MMMMMMMMMMMMMMMM", ownerID: "owner-1" }],
  ["test-owner-vault-capability-14", { jti: "NNNNNNNNNNNNNNNN", ownerID: "owner-1" }],
  ["test-owner-vault-capability-15", { jti: "OOOOOOOOOOOOOOOO", ownerID: "owner-1" }],
  ["test-owner-vault-capability-16", { jti: "PPPPPPPPPPPPPPPP", ownerID: "owner-1" }],
  ["test-owner-vault-capability-17", { jti: "QQQQQQQQQQQQQQQQ", ownerID: "owner-1" }],
  ["test-owner-vault-capability-18", { jti: "RRRRRRRRRRRRRRRR", ownerID: "owner-1" }],
  ["test-owner-vault-capability-19", { jti: "SSSSSSSSSSSSSSSS", ownerID: "owner-1" }],
]);
const sessionNonce = "AAAAAAAAAAAAAAAAAAAAAA";
const claimedOperations = new Set<string>();
const acknowledgedFrames = new Map<
  string,
  {
    readonly type: "syncAcknowledged";
    readonly protocolVersion: 2;
    readonly vaultID: string;
    readonly changeID: string;
    readonly causalVersion: number;
  }
>();

const rejected = (reason: OwnerVaultSyncError["reason"]) =>
  Effect.fail(new OwnerVaultSyncError({ reason }));

const randomResumeToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
};

const dependencies: OwnerVaultSyncDependencies = {
  capabilities: {
    verify: (signed, binding, expected, nowSeconds) => {
      const capability = capabilityValues.get(signed.value);
      if (
        capability === undefined ||
        binding.method !== CapabilityMethod.GET ||
        binding.path !== "/v2/sync" ||
        expected.audience !== CapabilityAudience.OwnerVault ||
        expected.authority !== CapabilityAuthority.OwnerVault
      )
        return rejected("capability_denied");
      return Effect.succeed({
        audience: CapabilityAudience.OwnerVault,
        authority: CapabilityAuthority.OwnerVault,
        keyID: "test-capability-key",
        jti: capability.jti,
        issuedAt: nowSeconds - 1,
        expiresAt: nowSeconds + 60,
        credentialEpoch: 2,
        generationEpoch: 3,
        method: CapabilityMethod.GET,
        path: "/v2/sync",
        canonicalQuery: "",
        bodySHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ownerID: capability.ownerID,
        vaultID: "vault-1",
      });
    },
  },
  jti: {
    claim: (jti, operation) => {
      const key = `${jti}:${operation}`;
      if (claimedOperations.has(key)) return Effect.succeed("duplicate");
      claimedOperations.add(key);
      return Effect.succeed("claimed");
    },
    releaseTransient: (jti, operation) => {
      claimedOperations.delete(`${jti}:${operation}`);
      return Effect.void;
    },
  },
  devices: {
    issueHelloChallenge: (identity, credentialEpoch) =>
      identity.ownerID === "owner-1" &&
      identity.vaultID === "vault-1" &&
      identity.generationEpoch === 3 &&
      credentialEpoch === 2
        ? Effect.succeed({ authEpoch: 4, credentialEpoch: 2 })
        : rejected("authorization_denied"),
    acceptHello: (identity, frame, _payload, nowMilliseconds) => {
      if (
        identity.ownerID !== "owner-1" ||
        identity.vaultID !== "vault-1" ||
        frame.deviceID !== "device-1"
      )
        return rejected("authorization_denied");
      return Effect.succeed({
        deviceID: "device-1",
        authEpoch: 4,
        credentialEpoch: 2,
        assertionExpiresAt: nowMilliseconds + 1_000,
      });
    },
    authorizeChange: (session, frame) =>
      session.deviceID === frame.deviceID ? Effect.void : rejected("authorization_denied"),
  },
  mutations: {
    apply: (session, frame) => {
      const key = `${session.identity.generationEpoch}:${frame.frameID}`;
      const previous = acknowledgedFrames.get(key);
      // The DO receipt repository must return an exact replay before reaching
      // this provider. Treat any second invocation as a test failure.
      if (previous !== undefined) return rejected("replay_conflict");
      const response = {
        type: "syncAcknowledged" as const,
        protocolVersion: 2 as const,
        vaultID: session.identity.vaultID,
        changeID: frame.changeID,
        causalVersion: frame.causalVersion,
      };
      acknowledgedFrames.set(key, response);
      return Effect.succeed(response);
    },
  },
  atomicChanges: {
    authorizeClaimAndApply: (session, frame, _payload, _nowSeconds) => {
      if (session.deviceID !== frame.deviceID) return rejected("authorization_denied");
      const jtiKey = `${session.capabilityJTI}:sync:${frame.frameID}`;
      const previous = acknowledgedFrames.get(
        `${session.identity.generationEpoch}:${frame.frameID}`,
      );
      if (claimedOperations.has(jtiKey) && previous === undefined)
        return rejected("capability_replayed");
      claimedOperations.add(jtiKey);
      return dependencies.mutations.apply(session, frame, _nowSeconds);
    },
  },
  sessionNonce: { next: () => Effect.succeed(sessionNonce) },
  resumeTokens: { next: () => Effect.sync(randomResumeToken) },
  limits: {
    maximumFrameBytes: 4096,
    maximumAttachmentBytes: 4096,
    maximumSessions: 8,
    maximumFramesPerMinute: 2,
  },
};

export const OwnerVaultDO = makeOwnerVaultDO(dependencies);

interface Env {
  readonly OWNER_VAULT_DO: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, environment: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/__owner_vault_sync_ready__")
      return new Response("ready");
    const id = environment.OWNER_VAULT_DO.idFromName("owner-1:vault-1:3");
    return environment.OWNER_VAULT_DO.get(id).fetch(request);
  },
};
