import { DurableObject } from "cloudflare:workers";
import { type SyncChangeFrame, protocolVersion, sha256Hex } from "@enchiridion/protocol";
import {
  type DurableObjectBoundary,
  type DurableObjectStorage,
  adoptDurableObjectValue,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import {
  acceptHello,
  decodeOwnerVaultClientFrame,
  decodeOwnerVaultSocketAttachment,
  handleSyncChange,
  issueServerHelloChallenge,
  ownerVaultCapabilityHeader,
  ownerVaultCloseCodes,
  ownerVaultSyncPath,
  ownerVaultUpgradeBinding,
  verifyOwnerVaultCapability,
} from "./v2/sync/service";
import type {
  OwnerVaultDurableSession,
  OwnerVaultDurableSyncRepository,
  OwnerVaultIdentity,
  OwnerVaultSession,
  OwnerVaultSocketAttachment,
  OwnerVaultSyncDependencies,
} from "./v2/sync/types";
import {
  OwnerVaultDurableSyncRepository as OwnerVaultDurableSyncRepositoryTag,
  OwnerVaultSyncDependencies as OwnerVaultSyncDependenciesTag,
  OwnerVaultSyncError,
} from "./v2/sync/types";

const identityStorageKey = "v2.owner-vault.identity";
const capabilityHeaderMaximumBytes = 8_192;

const validIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._~-]{1,128}$/u.test(value);
const validEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sameIdentity = (left: OwnerVaultIdentity, right: OwnerVaultIdentity): boolean =>
  left.ownerID === right.ownerID &&
  left.vaultID === right.vaultID &&
  left.generationEpoch === right.generationEpoch;

const decodeStoredIdentity = (value: unknown): OwnerVaultIdentity | undefined => {
  if (!isUnknownRecord(value) || Object.keys(value).length !== 3) return undefined;
  const ownerID = value.ownerID;
  const vaultID = value.vaultID;
  const generationEpoch = value.generationEpoch;
  if (!validIdentifier(ownerID) || !validIdentifier(vaultID) || !validEpoch(generationEpoch))
    return undefined;
  return { ownerID, vaultID, generationEpoch };
};

const attachmentExpiryMilliseconds = (
  attachment: OwnerVaultSocketAttachment,
): number | undefined => {
  if (attachment.state === "awaitingHello") return attachment.challenge?.expiresAt;
  if (attachment.session === undefined) return undefined;
  return Math.min(attachment.session.assertionExpiresAt, attachment.capabilityExpiresAt * 1_000);
};

const frameID = /^[A-Za-z0-9_-]{22}$/u;
const capabilityJTI = /^[A-Za-z0-9_-]{16,128}$/u;
const resumeTokenHash = /^[a-f0-9]{64}$/u;
const sessionStoragePrefix = "v2.owner-vault.sync.session.";
const resumeStoragePrefix = "v2.owner-vault.sync.resume.";
const receiptStoragePrefix = "v2.owner-vault.sync.receipt.";
const validTimestamp = (value: unknown): value is number =>
  validEpoch(value) && value >= 1_700_000_000_000;
const hasExactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const sameSessionSecurity = (left: OwnerVaultSession, right: OwnerVaultSession): boolean =>
  sameIdentity(left.identity, right.identity) &&
  left.deviceID === right.deviceID &&
  left.authEpoch === right.authEpoch &&
  left.credentialEpoch === right.credentialEpoch &&
  left.sessionNonce === right.sessionNonce &&
  left.assertionExpiresAt === right.assertionExpiresAt &&
  left.capabilityJTI === right.capabilityJTI;

const validSession = (session: OwnerVaultSession): boolean =>
  validIdentifier(session.identity.ownerID) &&
  validIdentifier(session.identity.vaultID) &&
  validEpoch(session.identity.generationEpoch) &&
  validIdentifier(session.deviceID) &&
  validEpoch(session.authEpoch) &&
  validEpoch(session.credentialEpoch) &&
  frameID.test(session.sessionNonce) &&
  validTimestamp(session.assertionExpiresAt) &&
  capabilityJTI.test(session.capabilityJTI) &&
  validTimestamp(session.rateWindowStartedAtMilliseconds) &&
  validEpoch(session.rateCount);

const decodeStoredSession = (value: unknown): OwnerVaultDurableSession | undefined => {
  if (!isUnknownRecord(value) || !hasExactKeys(value, ["version", "session", "resumeTokenHash"]))
    return undefined;
  if (
    value.version !== 1 ||
    typeof value.resumeTokenHash !== "string" ||
    !resumeTokenHash.test(value.resumeTokenHash)
  )
    return undefined;
  if (!isUnknownRecord(value.session)) return undefined;
  const source = value.session;
  if (
    !hasExactKeys(source, [
      "identity",
      "deviceID",
      "authEpoch",
      "credentialEpoch",
      "sessionNonce",
      "assertionExpiresAt",
      "capabilityJTI",
      "rateWindowStartedAtMilliseconds",
      "rateCount",
    ]) ||
    !isUnknownRecord(source.identity)
  )
    return undefined;
  const identity = decodeStoredIdentity(source.identity);
  if (
    identity === undefined ||
    typeof source.deviceID !== "string" ||
    !validEpoch(source.authEpoch) ||
    !validEpoch(source.credentialEpoch) ||
    typeof source.sessionNonce !== "string" ||
    !validTimestamp(source.assertionExpiresAt) ||
    typeof source.capabilityJTI !== "string" ||
    !validTimestamp(source.rateWindowStartedAtMilliseconds) ||
    !validEpoch(source.rateCount)
  )
    return undefined;
  const session: OwnerVaultSession = {
    identity,
    deviceID: source.deviceID,
    authEpoch: source.authEpoch,
    credentialEpoch: source.credentialEpoch,
    sessionNonce: source.sessionNonce,
    assertionExpiresAt: source.assertionExpiresAt,
    capabilityJTI: source.capabilityJTI,
    rateWindowStartedAtMilliseconds: source.rateWindowStartedAtMilliseconds,
    rateCount: source.rateCount,
  };
  return validSession(session)
    ? { version: 1, session, resumeTokenHash: value.resumeTokenHash }
    : undefined;
};

type SyncAcknowledgedFrame = Extract<
  import("@enchiridion/protocol").ServerWebSocketFrame,
  { readonly type: "syncAcknowledged" }
>;

interface DurableFrameReceipt {
  readonly version: 1;
  readonly frameID: string;
  readonly requestHash: string;
  readonly result: SyncAcknowledgedFrame;
}

const decodeFrameReceipt = (value: unknown): DurableFrameReceipt | undefined => {
  if (
    !isUnknownRecord(value) ||
    !hasExactKeys(value, ["version", "frameID", "requestHash", "result"])
  )
    return undefined;
  if (
    value.version !== 1 ||
    typeof value.frameID !== "string" ||
    !frameID.test(value.frameID) ||
    typeof value.requestHash !== "string" ||
    !resumeTokenHash.test(value.requestHash) ||
    !isUnknownRecord(value.result) ||
    !hasExactKeys(value.result, ["type", "protocolVersion", "vaultID", "operationID", "logSequence"])
  )
    return undefined;
  const result = value.result;
  if (
    result.type !== "syncAcknowledged" ||
    result.protocolVersion !== protocolVersion ||
    !validIdentifier(result.vaultID) ||
    !validIdentifier(result.operationID) ||
    !validEpoch(result.logSequence) ||
    result.logSequence < 1
  )
    return undefined;
  return {
    version: 1,
    frameID: value.frameID,
    requestHash: value.requestHash,
    result: {
      type: "syncAcknowledged",
      protocolVersion,
      vaultID: result.vaultID,
      operationID: result.operationID,
      logSequence: result.logSequence,
    },
  };
};

const sessionScope = (session: OwnerVaultSession): string =>
  sha256Hex(
    new TextEncoder().encode(
      `${session.identity.ownerID}\u0000${session.identity.vaultID}\u0000${session.identity.generationEpoch}\u0000${session.deviceID}`,
    ),
  );
const sessionStorageKey = (session: OwnerVaultSession): string =>
  `${sessionStoragePrefix}${sessionScope(session)}`;
const resumeStorageKey = (token: string): string =>
  `${resumeStoragePrefix}${sha256Hex(new TextEncoder().encode(token))}`;
const receiptStorageKey = (session: OwnerVaultSession, id: string): string =>
  `${receiptStoragePrefix}${sessionScope(session)}.${id}`;

const durableSyncFailure = <A>(
  reason: OwnerVaultSyncError["reason"],
): Effect.Effect<A, OwnerVaultSyncError> => Effect.fail(new OwnerVaultSyncError({ reason }));

type EstablishOutcome =
  | { readonly kind: "failure"; readonly reason: OwnerVaultSyncError["reason"] }
  | { readonly kind: "success"; readonly session: OwnerVaultSession };
type FrameOutcome =
  | { readonly kind: "failure"; readonly reason: OwnerVaultSyncError["reason"] }
  | {
      readonly kind: "success";
      readonly session: OwnerVaultSession;
      readonly response: SyncAcknowledgedFrame;
    };

const makeDurableSyncRepository = (
  storage: DurableObjectStorage,
): OwnerVaultDurableSyncRepository => ({
  establish: (candidate, presentedResumeToken, nextResumeToken, nowMilliseconds) => {
    if (!validSession(candidate) || !/^[A-Za-z0-9_-]{43}$/u.test(nextResumeToken))
      return durableSyncFailure("session_invalid");
    const key = sessionStorageKey(candidate);
    const nextHash = sha256Hex(new TextEncoder().encode(nextResumeToken));
    return storage
      .transaction((transaction) =>
        transaction.get(resumeStorageKey(nextResumeToken)).pipe(
          Effect.flatMap((nextPointer) => {
            if (nextPointer !== undefined)
              return Effect.succeed<EstablishOutcome>({
                kind: "failure",
                reason: "session_invalid",
              });
            if (presentedResumeToken === undefined)
              return transaction.get(key).pipe(
                Effect.flatMap((previous) => {
                  const decoded =
                    previous === undefined ? undefined : decodeStoredSession(previous);
                  if (previous !== undefined && decoded === undefined)
                    return Effect.succeed<EstablishOutcome>({
                      kind: "failure",
                      reason: "session_invalid",
                    });
                  const clearPrevious =
                    decoded === undefined
                      ? Effect.void
                      : transaction
                          .delete(`${resumeStoragePrefix}${decoded.resumeTokenHash}`)
                          .pipe(Effect.asVoid);
                  return clearPrevious.pipe(
                    Effect.flatMap(() =>
                      transaction
                        .put(key, { version: 1, session: candidate, resumeTokenHash: nextHash })
                        .pipe(
                          Effect.zipRight(
                            transaction.put(`${resumeStoragePrefix}${nextHash}`, key),
                          ),
                          Effect.as<EstablishOutcome>({ kind: "success", session: candidate }),
                        ),
                    ),
                  );
                }),
              );
            const presentedKey = resumeStorageKey(presentedResumeToken);
            const presentedHash = sha256Hex(new TextEncoder().encode(presentedResumeToken));
            return transaction.get(presentedKey).pipe(
              Effect.flatMap((pointer) => {
                if (pointer !== key || nextHash === presentedHash)
                  return Effect.succeed<EstablishOutcome>({
                    kind: "failure",
                    reason: "session_invalid",
                  });
                return transaction.get(key).pipe(
                  Effect.flatMap((previous) => {
                    const decoded =
                      previous === undefined ? undefined : decodeStoredSession(previous);
                    if (
                      decoded === undefined ||
                      decoded.resumeTokenHash !== presentedHash ||
                      !sameIdentity(decoded.session.identity, candidate.identity) ||
                      decoded.session.deviceID !== candidate.deviceID ||
                      decoded.session.authEpoch !== candidate.authEpoch ||
                      decoded.session.credentialEpoch !== candidate.credentialEpoch ||
                      decoded.session.assertionExpiresAt <= nowMilliseconds
                    )
                      return Effect.succeed<EstablishOutcome>({
                        kind: "failure",
                        reason: "session_invalid",
                      });
                    const resumed: OwnerVaultSession = {
                      ...decoded.session,
                      capabilityJTI: candidate.capabilityJTI,
                    };
                    return transaction
                      .put(key, { version: 1, session: resumed, resumeTokenHash: nextHash })
                      .pipe(
                        Effect.zipRight(transaction.delete(presentedKey)),
                        Effect.zipRight(transaction.put(`${resumeStoragePrefix}${nextHash}`, key)),
                        Effect.as<EstablishOutcome>({ kind: "success", session: resumed }),
                      );
                  }),
                );
              }),
            );
          }),
        ),
      )
      .pipe(
        Effect.mapError(() => new OwnerVaultSyncError({ reason: "session_invalid" })),
        Effect.flatMap((outcome: EstablishOutcome) =>
          outcome.kind === "success"
            ? Effect.succeed(outcome.session)
            : durableSyncFailure(outcome.reason),
        ),
      );
  },
  transactFrame: (session, frame, requestHash, nowMilliseconds, maximumFramesPerMinute, apply) => {
    if (
      !validSession(session) ||
      !frameID.test(frame.frameID) ||
      !resumeTokenHash.test(requestHash) ||
      !validTimestamp(nowMilliseconds) ||
      !Number.isSafeInteger(maximumFramesPerMinute) ||
      maximumFramesPerMinute < 1
    )
      return durableSyncFailure("session_invalid");
    const key = sessionStorageKey(session);
    const receiptKey = receiptStorageKey(session, frame.frameID);
    return storage
      .transaction((transaction) =>
        transaction.get(key).pipe(
          Effect.flatMap((persisted) => {
            const record = persisted === undefined ? undefined : decodeStoredSession(persisted);
            if (record === undefined || !sameSessionSecurity(record.session, session))
              return Effect.succeed<FrameOutcome>({ kind: "failure", reason: "session_invalid" });
            // Rate fields from a hibernating attachment are intentionally not
            // authoritative. Compute both rollover and quota from the exact
            // persisted record while this storage transaction is open.
            const persistedSession = record.session;
            const rateWindowStartedAtMilliseconds =
              nowMilliseconds - persistedSession.rateWindowStartedAtMilliseconds >= 60_000
                ? nowMilliseconds
                : persistedSession.rateWindowStartedAtMilliseconds;
            const rateCount =
              rateWindowStartedAtMilliseconds === nowMilliseconds ? 0 : persistedSession.rateCount;
            const rateQuotaExceeded = rateCount >= maximumFramesPerMinute;
            const nextSession: OwnerVaultSession = {
              ...persistedSession,
              rateWindowStartedAtMilliseconds,
              rateCount: rateCount + 1,
            };
            return transaction.get(receiptKey).pipe(
              Effect.flatMap((storedReceipt) => {
                if (storedReceipt !== undefined) {
                  const receipt = decodeFrameReceipt(storedReceipt);
                  if (
                    receipt === undefined ||
                    receipt.frameID !== frame.frameID ||
                    receipt.requestHash !== requestHash
                  )
                    return Effect.succeed<FrameOutcome>({
                      kind: "failure",
                      reason: "replay_conflict",
                    });
                  if (rateQuotaExceeded)
                    return Effect.succeed<FrameOutcome>({
                      kind: "failure",
                      reason: "quota_exceeded",
                    });
                  // Exact receipts are accepted work: charge and persist the
                  // current rate window, but never evaluate `apply` again.
                  return transaction
                    .put(key, {
                      version: 1,
                      session: nextSession,
                      resumeTokenHash: record.resumeTokenHash,
                    })
                    .pipe(
                      Effect.as<FrameOutcome>({
                        kind: "success",
                        session: nextSession,
                        response: receipt.result,
                      }),
                    );
                }
                if (rateQuotaExceeded)
                  return Effect.succeed<FrameOutcome>({
                    kind: "failure",
                    reason: "quota_exceeded",
                  });
                return apply.pipe(
                  Effect.match({
                    onFailure: (error) => ({ kind: "failure" as const, reason: error.reason }),
                    onSuccess: (response) => ({ kind: "apply" as const, response }),
                  }),
                  Effect.flatMap((outcome) => {
                    if (outcome.kind === "failure") return Effect.succeed(outcome);
                    const receipt: DurableFrameReceipt = {
                      version: 1,
                      frameID: frame.frameID,
                      requestHash,
                      result: outcome.response,
                    };
                    return transaction
                      .put(key, {
                        version: 1,
                        session: nextSession,
                        resumeTokenHash: record.resumeTokenHash,
                      })
                      .pipe(
                        Effect.zipRight(transaction.put(receiptKey, receipt)),
                        Effect.as<FrameOutcome>({
                          kind: "success",
                          session: nextSession,
                          response: outcome.response,
                        }),
                      );
                  }),
                );
              }),
            );
          }),
        ),
      )
      .pipe(
        Effect.mapError(() => new OwnerVaultSyncError({ reason: "session_invalid" })),
        Effect.flatMap((outcome: FrameOutcome) =>
          outcome.kind === "success"
            ? Effect.succeed({ session: outcome.session, response: outcome.response })
            : durableSyncFailure(outcome.reason),
        ),
      );
  },
});

const closeCodeFor = (reason: OwnerVaultSyncError["reason"]): number => {
  switch (reason) {
    case "authorization_denied":
    case "capability_denied":
    case "capability_replayed":
    case "identity_conflict":
    case "signature_invalid":
      return ownerVaultCloseCodes.authorization;
    case "quota_exceeded":
      return ownerVaultCloseCodes.rateLimited;
    case "session_expired":
      return ownerVaultCloseCodes.sessionExpired;
    case "version_unsupported":
      return ownerVaultCloseCodes.unsupportedVersion;
    default:
      return ownerVaultCloseCodes.invalidFrame;
  }
};

export type OwnerVaultDOEnv = Readonly<Record<never, never>>;
export type OwnerVaultDOConstructor = new (
  ctx: DurableObjectState,
  env: OwnerVaultDOEnv,
) => DurableObject<OwnerVaultDOEnv>;

/**
 * P03-06 must construct this with durable capability/JTI/device/mutation providers.
 * There is intentionally no environment fallback and no permissive test default.
 */
export const makeOwnerVaultDO = (
  dependencies: OwnerVaultSyncDependencies,
): OwnerVaultDOConstructor => {
  class OwnerVaultDO extends DurableObject<OwnerVaultDOEnv> {
    private readonly boundary: DurableObjectBoundary;
    private readonly durableSessions: OwnerVaultDurableSyncRepository;

    constructor(ctx: DurableObjectState, env: OwnerVaultDOEnv) {
      super(ctx, env);
      this.boundary = makeDurableObjectBoundary(this.ctx);
      this.durableSessions = makeDurableSyncRepository(this.boundary.storage);
    }

    private provideSync<A>(
      effect: Effect.Effect<
        A,
        OwnerVaultSyncError,
        OwnerVaultSyncDependencies | OwnerVaultDurableSyncRepository
      >,
    ) {
      return Effect.provideService(
        Effect.provideService(effect, OwnerVaultDurableSyncRepositoryTag, this.durableSessions),
        OwnerVaultSyncDependenciesTag,
        dependencies,
      );
    }

    private initialize() {
      return this.boundary.callbacks.blockConcurrencyWhile(
        this.boundary.storage
          .get(identityStorageKey)
          .pipe(
            Effect.flatMap((stored) =>
              stored === undefined || decodeStoredIdentity(stored) !== undefined
                ? Effect.void
                : Effect.die("OwnerVaultDO persisted identity is corrupt."),
            ),
          ),
      );
    }

    private close(ws: WebSocket, error: OwnerVaultSyncError): void {
      ws.close(closeCodeFor(error.reason), error.reason);
    }

    /**
     * Hibernating sockets are untrusted durable input. Decode every attachment
     * before counting it, close stale/malformed peers, then arm precisely the
     * earliest remaining expiry so an idle DO repeats this pruning work.
     */
    private pruneSockets(nowMilliseconds: number) {
      return Effect.gen(this, function* () {
        let live = 0;
        let nearestExpiry: number | undefined;
        for (const socket of this.ctx.getWebSockets()) {
          const attachment = decodeOwnerVaultSocketAttachment(
            socket.deserializeAttachment(),
            dependencies.limits.maximumAttachmentBytes,
          );
          const expiry =
            attachment === undefined ? undefined : attachmentExpiryMilliseconds(attachment);
          if (attachment === undefined) {
            socket.close(ownerVaultCloseCodes.invalidFrame, "attachment_invalid");
            continue;
          }
          if (expiry === undefined || expiry <= nowMilliseconds) {
            socket.close(ownerVaultCloseCodes.sessionExpired, "session_expired");
            continue;
          }
          live += 1;
          nearestExpiry = nearestExpiry === undefined ? expiry : Math.min(nearestExpiry, expiry);
        }
        if (nearestExpiry === undefined) yield* this.boundary.storage.deleteAlarm();
        else yield* this.boundary.storage.setAlarm(nearestExpiry);
        return live;
      });
    }

    private fetchEffect(request: Request) {
      return Effect.gen(this, function* () {
        yield* this.initialize();
        const url = new URL(request.url);
        if (
          request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
          url.pathname !== ownerVaultSyncPath ||
          url.search !== ""
        )
          return new Response("OwnerVault sync requires a WebSocket upgrade.", { status: 426 });
        const capability = request.headers.get(ownerVaultCapabilityHeader);
        if (
          capability === null ||
          capability.includes(",") ||
          new TextEncoder().encode(capability).byteLength > capabilityHeaderMaximumBytes
        )
          return new Response("Missing or invalid internal capability.", { status: 401 });
        const verified = yield* this.provideSync(
          verifyOwnerVaultCapability(
            { value: capability },
            ownerVaultUpgradeBinding(),
            Math.floor(Date.now() / 1000),
          ),
        );
        const adopted = yield* adoptDurableObjectValue(
          this.boundary.storage,
          identityStorageKey,
          verified.identity,
          decodeStoredIdentity,
          sameIdentity,
        );
        if (!adopted) return new Response("OwnerVault identity conflict.", { status: 409 });
        const liveSockets = yield* this.pruneSockets(Date.now());
        if (liveSockets >= dependencies.limits.maximumSessions)
          return new Response("OwnerVault session quota exceeded.", { status: 429 });
        const challenge = yield* this.provideSync(
          issueServerHelloChallenge(verified.identity, verified.claims.credentialEpoch, Date.now()),
        );
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const attachment: OwnerVaultSocketAttachment = {
          version: 1,
          state: "awaitingHello",
          identity: verified.identity,
          capabilityJTI: verified.claims.jti,
          capabilityExpiresAt: verified.claims.expiresAt,
          challenge,
        };
        server.serializeAttachment(attachment);
        this.ctx.acceptWebSocket(server);
        server.send(JSON.stringify(challenge));
        yield* this.pruneSockets(Date.now());
        return new Response(null, { status: 101, webSocket: client });
      });
    }

    override fetch(request: Request) {
      return this.boundary.callbacks.fetch(
        this.fetchEffect(request).pipe(
          Effect.catchAll(() =>
            Effect.succeed(new Response("OwnerVault capability rejected.", { status: 401 })),
          ),
        ),
      );
    }

    private messageEffect(ws: WebSocket, message: string | ArrayBuffer) {
      return Effect.gen(this, function* () {
        yield* this.initialize();
        const attachment = decodeOwnerVaultSocketAttachment(
          ws.deserializeAttachment(),
          dependencies.limits.maximumAttachmentBytes,
        );
        if (attachment === undefined) {
          ws.close(ownerVaultCloseCodes.invalidFrame, "attachment_invalid");
          return;
        }
        const frame = yield* this.provideSync(
          decodeOwnerVaultClientFrame(message, dependencies.limits.maximumFrameBytes),
        );
        const nowMilliseconds = Date.now();
        if (frame.type === "hello") {
          const result = yield* this.provideSync(acceptHello(attachment, frame, nowMilliseconds));
          ws.serializeAttachment(result.attachment);
          ws.send(JSON.stringify(result.response));
          yield* this.pruneSockets(nowMilliseconds);
          return;
        }
        const result = yield* this.provideSync(
          handleSyncChange(attachment, frame, nowMilliseconds),
        );
        ws.serializeAttachment(result.attachment);
        ws.send(JSON.stringify(result.response));
        yield* this.pruneSockets(nowMilliseconds);
      });
    }

    override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
      return this.boundary.callbacks.webSocketMessage(
        this.messageEffect(ws, message).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              if (error instanceof OwnerVaultSyncError) this.close(ws, error);
              else ws.close(ownerVaultCloseCodes.invalidFrame, "internal_failure");
            }),
          ),
        ),
      );
    }

    override webSocketClose(ws: WebSocket): void {
      ws.close(1000, "closed");
    }

    override alarm() {
      return this.boundary.callbacks.alarm(this.pruneSockets(Date.now()).pipe(Effect.asVoid));
    }
  }
  return OwnerVaultDO;
};
