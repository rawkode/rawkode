import {
  type ClientWebSocketFrame,
  type ServerHelloChallengeFrame,
  type ServerWebSocketFrame,
  decodeClientWebSocketFrameJSON,
  decodeServerWebSocketFrame,
  helloSigningPayload,
  protocolVersion,
  sha256Hex,
  syncChangeSigningPayload,
} from "@enchiridion/protocol";
/** @enchiridion/effect-module */
import {
  CapabilityAudience,
  CapabilityAuthority,
  type CapabilityClaims,
  CapabilityMethod,
  type CapabilityRequestBinding,
  type SignedCapability,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import {
  OwnerVaultDurableSyncRepository,
  type OwnerVaultIdentity,
  type OwnerVaultSession,
  type OwnerVaultSocketAttachment,
  OwnerVaultSyncDependencies,
  OwnerVaultSyncError,
  ownerVaultSyncFailure,
} from "./types";

export const ownerVaultCapabilityHeader = "Enchiridion-Internal-Capability";
export const ownerVaultSyncPath = "/v2/sync";
export const ownerVaultCloseCodes = {
  authorization: 4401,
  invalidFrame: 4400,
  rateLimited: 4429,
  sessionExpired: 4408,
  unsupportedVersion: 4426,
};

type HelloFrame = Extract<ClientWebSocketFrame, { readonly type: "hello" }>;
type SyncChangeFrame = Extract<ClientWebSocketFrame, { readonly type: "syncChange" }>;
type HelloAcceptedFrame = Extract<ServerWebSocketFrame, { readonly type: "helloAccepted" }>;
type SyncAcknowledgedFrame = Extract<ServerWebSocketFrame, { readonly type: "syncAcknowledged" }>;

const identifier = /^[A-Za-z0-9._~-]{1,128}$/u;
const nonce = /^[A-Za-z0-9_-]{22,128}$/u;
const resumeToken = /^[A-Za-z0-9_-]{43}$/u;
const capabilityJTI = /^[A-Za-z0-9_-]{16,128}$/u;
const sha256Digest = /^[a-f0-9]{64}$/u;
const validEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validTimestamp = (value: unknown): value is number => validEpoch(value);
// Signed protocol timestamps are epoch milliseconds within the v2 wire range.
// Keeping this boundary here prevents a malformed authorizer response becoming
// durable session state after its capability JTI has been claimed.
const validMillisecondsTimestamp = (value: unknown): value is number =>
  validEpoch(value) && value >= 1_700_000_000_000 && value <= 4_102_444_800_000;
const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export const identityFromCapability = (
  claims: CapabilityClaims,
): OwnerVaultIdentity | undefined => {
  if (
    claims.audience !== CapabilityAudience.OwnerVault ||
    claims.authority !== CapabilityAuthority.OwnerVault ||
    claims.ownerID === undefined ||
    claims.vaultID === undefined ||
    !identifier.test(claims.ownerID) ||
    !identifier.test(claims.vaultID) ||
    !validEpoch(claims.generationEpoch)
  )
    return undefined;
  return {
    ownerID: claims.ownerID,
    vaultID: claims.vaultID,
    generationEpoch: claims.generationEpoch,
  };
};

export const verifyOwnerVaultCapability = (
  signed: SignedCapability,
  binding: CapabilityRequestBinding,
  nowSeconds: number,
) =>
  Effect.gen(function* () {
    const dependencies = yield* OwnerVaultSyncDependencies;
    const claims = yield* dependencies.capabilities.verify(
      signed,
      binding,
      { audience: CapabilityAudience.OwnerVault, authority: CapabilityAuthority.OwnerVault },
      nowSeconds,
    );
    const identity = identityFromCapability(claims);
    if (identity === undefined || !capabilityJTI.test(claims.jti))
      return yield* ownerVaultSyncFailure<never>("capability_denied");
    return { claims, identity };
  });

/**
 * Enforces admission before any binary decoder allocates or observes attacker
 * bytes. The injectable decoder keeps the ordering executable in focused
 * tests; production always uses the fatal UTF-8 decoder below.
 */
export const decodeOwnerVaultFrameSource = (
  raw: string | ArrayBuffer,
  maximumFrameBytes: number,
  decodeBinary: (input: ArrayBuffer) => string,
): string => {
  if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1)
    throw new TypeError("Invalid frame byte limit.");
  if (typeof raw === "string") {
    // Every UTF-16 code unit occupies at least one UTF-8 byte.
    if (raw.length > maximumFrameBytes) throw new Error("frame too large");
    if (new TextEncoder().encode(raw).byteLength > maximumFrameBytes)
      throw new Error("frame too large");
    return raw;
  }
  if (raw.byteLength > maximumFrameBytes) throw new Error("frame too large");
  return decodeBinary(raw);
};

export const decodeOwnerVaultClientFrame = (
  raw: string | ArrayBuffer,
  maximumFrameBytes: number,
): Effect.Effect<ClientWebSocketFrame, OwnerVaultSyncError> =>
  Effect.try({
    try: () => {
      const source = decodeOwnerVaultFrameSource(raw, maximumFrameBytes, (input) =>
        new TextDecoder("utf-8", { fatal: true }).decode(input),
      );
      return decodeClientWebSocketFrameJSON(source);
    },
    catch: () => new OwnerVaultSyncError({ reason: "invalid_frame" }),
  });

const validIdentity = (identity: OwnerVaultIdentity): boolean =>
  identifier.test(identity.ownerID) &&
  identifier.test(identity.vaultID) &&
  validEpoch(identity.generationEpoch);

const validSession = (session: OwnerVaultSession): boolean =>
  validIdentity(session.identity) &&
  identifier.test(session.deviceID) &&
  validEpoch(session.authEpoch) &&
  validEpoch(session.credentialEpoch) &&
  nonce.test(session.sessionNonce) &&
  validMillisecondsTimestamp(session.assertionExpiresAt) &&
  capabilityJTI.test(session.capabilityJTI) &&
  validMillisecondsTimestamp(session.rateWindowStartedAtMilliseconds) &&
  validEpoch(session.rateCount);

const validChallenge = (
  challenge: ServerHelloChallengeFrame,
  identity: OwnerVaultIdentity,
): boolean =>
  challenge.protocolVersion === protocolVersion &&
  nonce.test(challenge.connectionNonce) &&
  challenge.ownerID === identity.ownerID &&
  challenge.vaultID === identity.vaultID &&
  challenge.generationEpoch === identity.generationEpoch &&
  validEpoch(challenge.authEpoch) &&
  validEpoch(challenge.credentialEpoch) &&
  validMillisecondsTimestamp(challenge.issuedAt) &&
  validMillisecondsTimestamp(challenge.expiresAt);

export const decodeOwnerVaultSocketAttachment = (
  value: unknown,
  maximumBytes: number,
): OwnerVaultSocketAttachment | undefined => {
  try {
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).byteLength > maximumBytes) return undefined;
  } catch {
    return undefined;
  }
  if (!isUnknownRecord(value)) return undefined;
  const source = value;
  const identity = source.identity;
  if (
    !isUnknownRecord(identity) ||
    !hasExactKeys(identity, ["ownerID", "vaultID", "generationEpoch"])
  )
    return undefined;
  const ownerID = identity.ownerID;
  const vaultID = identity.vaultID;
  const generationEpoch = identity.generationEpoch;
  if (
    typeof ownerID !== "string" ||
    typeof vaultID !== "string" ||
    !validEpoch(generationEpoch) ||
    source.version !== 1 ||
    !validIdentity({ ownerID, vaultID, generationEpoch })
  )
    return undefined;
  const candidate: OwnerVaultIdentity = { ownerID, vaultID, generationEpoch };
  const attachmentCapabilityJTI = source.capabilityJTI;
  const capabilityExpiresAt = source.capabilityExpiresAt;
  if (
    typeof attachmentCapabilityJTI !== "string" ||
    !capabilityJTI.test(attachmentCapabilityJTI) ||
    !validTimestamp(capabilityExpiresAt)
  )
    return undefined;
  if (
    source.state === "awaitingHello" &&
    hasExactKeys(source, [
      "version",
      "state",
      "identity",
      "capabilityJTI",
      "capabilityExpiresAt",
      "challenge",
    ])
  ) {
    try {
      const decodedChallenge = decodeServerWebSocketFrame(source.challenge);
      if (
        decodedChallenge.type !== "serverHelloChallenge" ||
        !validChallenge(decodedChallenge, candidate)
      )
        return undefined;
      return {
        version: 1,
        state: "awaitingHello",
        identity: candidate,
        capabilityJTI: attachmentCapabilityJTI,
        capabilityExpiresAt,
        challenge: decodedChallenge,
      };
    } catch {
      return undefined;
    }
  }
  if (
    source.state !== "active" ||
    !hasExactKeys(source, [
      "version",
      "state",
      "identity",
      "capabilityJTI",
      "capabilityExpiresAt",
      "session",
    ]) ||
    !isUnknownRecord(source.session) ||
    !hasExactKeys(source.session, [
      "identity",
      "deviceID",
      "authEpoch",
      "credentialEpoch",
      "sessionNonce",
      "assertionExpiresAt",
      "capabilityJTI",
      "rateWindowStartedAtMilliseconds",
      "rateCount",
    ])
  )
    return undefined;
  const sessionSource = source.session;
  const sessionIdentity = sessionSource.identity;
  if (
    !isUnknownRecord(sessionIdentity) ||
    !hasExactKeys(sessionIdentity, ["ownerID", "vaultID", "generationEpoch"]) ||
    sessionIdentity.ownerID !== candidate.ownerID ||
    sessionIdentity.vaultID !== candidate.vaultID ||
    sessionIdentity.generationEpoch !== candidate.generationEpoch
  )
    return undefined;
  const deviceID = sessionSource.deviceID;
  const authEpoch = sessionSource.authEpoch;
  const credentialEpoch = sessionSource.credentialEpoch;
  const sessionNonce = sessionSource.sessionNonce;
  const assertionExpiresAt = sessionSource.assertionExpiresAt;
  const sessionCapabilityJTI = sessionSource.capabilityJTI;
  const rateWindowStartedAtMilliseconds = sessionSource.rateWindowStartedAtMilliseconds;
  const rateCount = sessionSource.rateCount;
  if (
    typeof deviceID !== "string" ||
    !validEpoch(authEpoch) ||
    !validEpoch(credentialEpoch) ||
    typeof sessionNonce !== "string" ||
    !validMillisecondsTimestamp(assertionExpiresAt) ||
    typeof sessionCapabilityJTI !== "string" ||
    sessionCapabilityJTI !== attachmentCapabilityJTI ||
    !validMillisecondsTimestamp(rateWindowStartedAtMilliseconds) ||
    !validEpoch(rateCount)
  )
    return undefined;
  const session: OwnerVaultSession = {
    identity: candidate,
    deviceID,
    authEpoch,
    credentialEpoch,
    sessionNonce,
    assertionExpiresAt,
    capabilityJTI: sessionCapabilityJTI,
    rateWindowStartedAtMilliseconds,
    rateCount,
  };
  if (!validSession(session)) return undefined;
  return {
    version: 1,
    state: "active",
    identity: candidate,
    capabilityJTI: attachmentCapabilityJTI,
    capabilityExpiresAt,
    session,
  };
};

const helloAccepted = (
  session: OwnerVaultSession,
  nextResumeToken: string,
): HelloAcceptedFrame => ({
  type: "helloAccepted",
  protocolVersion,
  ownerID: session.identity.ownerID,
  vaultID: session.identity.vaultID,
  deviceID: session.deviceID,
  authEpoch: session.authEpoch,
  credentialEpoch: session.credentialEpoch,
  generationEpoch: session.identity.generationEpoch,
  sessionNonce: session.sessionNonce,
  resumeToken: nextResumeToken,
  assertionExpiresAt: session.assertionExpiresAt,
});

/** Issues the mandatory server-first, bounded challenge before any client Hello is decoded. */
export const issueServerHelloChallenge = (
  identity: OwnerVaultIdentity,
  credentialEpoch: number,
  nowMilliseconds: number,
) =>
  Effect.gen(function* () {
    const dependencies = yield* OwnerVaultSyncDependencies;
    if (
      !validIdentity(identity) ||
      !validEpoch(credentialEpoch) ||
      !validMillisecondsTimestamp(nowMilliseconds)
    )
      return yield* ownerVaultSyncFailure<never>("authorization_denied");
    const issued = yield* dependencies.devices.issueHelloChallenge(
      identity,
      credentialEpoch,
      nowMilliseconds,
    );
    const connectionNonce = yield* dependencies.sessionNonce.next();
    const expiresAt = nowMilliseconds + 60_000;
    const challenge: ServerHelloChallengeFrame = {
      type: "serverHelloChallenge",
      protocolVersion,
      connectionNonce,
      issuedAt: nowMilliseconds,
      expiresAt,
      ownerID: identity.ownerID,
      vaultID: identity.vaultID,
      authEpoch: issued.authEpoch,
      credentialEpoch: issued.credentialEpoch,
      generationEpoch: identity.generationEpoch,
    };
    if (
      !nonce.test(connectionNonce) ||
      issued.credentialEpoch !== credentialEpoch ||
      !validChallenge(challenge, identity)
    )
      return yield* ownerVaultSyncFailure<never>("authorization_denied");
    return challenge;
  });

export const acceptHello = (
  attachment: OwnerVaultSocketAttachment,
  frame: ClientWebSocketFrame,
  nowMilliseconds: number,
) =>
  Effect.gen(function* () {
    const dependencies = yield* OwnerVaultSyncDependencies;
    const durableSessions = yield* OwnerVaultDurableSyncRepository;
    if (
      attachment.state !== "awaitingHello" ||
      attachment.challenge === undefined ||
      frame.type !== "hello"
    )
      return yield* ownerVaultSyncFailure<never>("session_invalid");
    const challenge = attachment.challenge;
    if (
      frame.protocolVersion !== protocolVersion ||
      frame.protocolVersion !== challenge.protocolVersion ||
      frame.connectionNonce !== challenge.connectionNonce ||
      frame.authEpoch !== challenge.authEpoch
    )
      return yield* ownerVaultSyncFailure<never>("version_unsupported");
    const device = yield* dependencies.devices.acceptHello(
      attachment.identity,
      frame,
      helloSigningPayload(frame, challenge, nowMilliseconds),
      nowMilliseconds,
    );
    if (
      device.deviceID !== frame.deviceID ||
      device.authEpoch !== frame.authEpoch ||
      device.authEpoch !== challenge.authEpoch ||
      device.credentialEpoch !== challenge.credentialEpoch ||
      device.assertionExpiresAt <= nowMilliseconds ||
      !validEpoch(device.authEpoch) ||
      !validEpoch(device.credentialEpoch)
    )
      return yield* ownerVaultSyncFailure<never>("authorization_denied");
    if (attachment.capabilityExpiresAt <= Math.floor(nowMilliseconds / 1000))
      return yield* ownerVaultSyncFailure<never>("session_expired");
    const jtiOperation = `hello:${attachment.identity.generationEpoch}:${frame.deviceID}`;
    const jti = yield* dependencies.jti.claim(
      attachment.capabilityJTI,
      jtiOperation,
      attachment.capabilityExpiresAt,
    );
    if (jti !== "claimed") return yield* ownerVaultSyncFailure<never>("capability_replayed");
    // From the point a JTI is claimed until establish commits, every branch is
    // one transaction-shaped attempt. The single rollback handler includes
    // nonce/token generation and validation as well as durable token rotation;
    // no pre-establishment failure may permanently burn a capability.
    const session = yield* Effect.gen(function* () {
      const sessionNonce = yield* dependencies.sessionNonce.next();
      const nextResumeToken = yield* dependencies.resumeTokens.next();
      if (!nonce.test(sessionNonce) || !resumeToken.test(nextResumeToken))
        return yield* ownerVaultSyncFailure<never>("authorization_denied");
      const candidate: OwnerVaultSession = {
        identity: attachment.identity,
        deviceID: device.deviceID,
        authEpoch: device.authEpoch,
        credentialEpoch: device.credentialEpoch,
        sessionNonce,
        assertionExpiresAt: device.assertionExpiresAt,
        capabilityJTI: attachment.capabilityJTI,
        rateWindowStartedAtMilliseconds: nowMilliseconds,
        rateCount: 0,
      };
      if (!validSession(candidate)) return yield* ownerVaultSyncFailure<never>("session_invalid");
      const established = yield* durableSessions.establish(
        candidate,
        frame.resumeToken,
        nextResumeToken,
        nowMilliseconds,
      );
      if (!validSession(established)) return yield* ownerVaultSyncFailure<never>("session_invalid");
      return { session: established, nextResumeToken };
    }).pipe(
      Effect.catchAll((primary) =>
        // The ledger owns durable cleanup-pending/idempotent retry semantics.
        // Preserve the original failure even when that cleanup itself fails.
        dependencies.jti
          .releaseTransient(attachment.capabilityJTI, jtiOperation)
          .pipe(
            Effect.catchAll(() => Effect.void),
            Effect.zipRight(Effect.fail(primary)),
          ),
      ),
    );
    const nextAttachment: OwnerVaultSocketAttachment = {
      version: 1,
      state: "active",
      identity: attachment.identity,
      capabilityJTI: attachment.capabilityJTI,
      capabilityExpiresAt: attachment.capabilityExpiresAt,
      session: session.session,
    };
    const response: ServerWebSocketFrame = helloAccepted(session.session, session.nextResumeToken);
    return { attachment: nextAttachment, response };
  });

export const handleSyncChange = (
  attachment: OwnerVaultSocketAttachment,
  frame: ClientWebSocketFrame,
  nowMilliseconds: number,
) =>
  Effect.gen(function* () {
    const dependencies = yield* OwnerVaultSyncDependencies;
    const durableSessions = yield* OwnerVaultDurableSyncRepository;
    if (
      attachment.state !== "active" ||
      attachment.session === undefined ||
      frame.type !== "syncChange"
    )
      return yield* ownerVaultSyncFailure<never>("session_invalid");
    const session = attachment.session;
    if (session.assertionExpiresAt <= nowMilliseconds)
      return yield* ownerVaultSyncFailure<never>("session_expired");
    if (
      frame.protocolVersion !== protocolVersion ||
      frame.vaultID !== session.identity.vaultID ||
      frame.deviceID !== session.deviceID ||
      frame.authEpoch !== session.authEpoch ||
      frame.credentialEpoch !== session.credentialEpoch ||
      frame.generationEpoch !== session.identity.generationEpoch ||
      frame.sessionNonce !== session.sessionNonce ||
      frame.assertionExpiresAt !== session.assertionExpiresAt
    )
      return yield* ownerVaultSyncFailure<never>("session_invalid");
    const signedPayload = syncChangeSigningPayload(frame);
    const durable = yield* durableSessions.transactFrame(
      // Attachment rate fields are only a serializable cache. The DO storage
      // transaction reloads the durable session and calculates quota/rollover
      // from its persisted values and transaction clock.
      session,
      frame,
      sha256Hex(signedPayload),
      nowMilliseconds,
      dependencies.limits.maximumFramesPerMinute,
      dependencies.atomicChanges.authorizeClaimAndApply(
        session,
        frame,
        signedPayload,
        nowMilliseconds,
      ),
    );
    return {
      attachment: {
        ...attachment,
        session: durable.session,
      },
      response: durable.response,
    };
  });

export const ownerVaultUpgradeBinding = (): CapabilityRequestBinding => ({
  method: CapabilityMethod.GET,
  path: ownerVaultSyncPath,
  canonicalQuery: "",
  bodySHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
});
