/** @enchiridion/effect-module */
import { Context, Data, Effect, Ref } from "effect";
import {
  type CredentialID,
  type OwnerID,
  type RequestID,
  type VaultID,
  isCredentialID,
  isOwnerID,
  isRequestID,
  isVaultID,
} from "../foundation/schemas";

export const MutationKind = {
  PutRecord: "PutRecord",
  DeleteRecord: "DeleteRecord",
} as const;
export type MutationKind = (typeof MutationKind)[keyof typeof MutationKind];

export interface CanonicalMutationObject {
  readonly [key: string]: CanonicalMutationValue;
}

export type CanonicalMutationValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalMutationValue[]
  | CanonicalMutationObject;

export interface MutationScope {
  readonly ownerID: OwnerID;
  readonly vaultID: VaultID;
  readonly generationEpoch: number;
}

export interface MutationAuthorization extends MutationScope {
  readonly credentialID: CredentialID;
  readonly credentialEpoch: number;
}

export interface MutationCommand {
  readonly authorization: MutationAuthorization;
  readonly requestID: RequestID;
  readonly kind: MutationKind;
  readonly body: Readonly<Record<string, CanonicalMutationValue>>;
  readonly nowSeconds: number;
  readonly receiptExpiresAtSeconds: number;
}

export interface MutationReceipt {
  readonly requestID: string;
  readonly canonicalHash: string;
  readonly kind: MutationKind;
  readonly resultVersion: number;
  readonly expiresAtSeconds: number;
}

export interface MutationAuditEvent {
  readonly event: "mutation.applied" | "mutation.replayed";
  readonly kind: MutationKind;
  readonly canonicalHash: string;
}

export interface MutationExecution {
  readonly receipt: MutationReceipt;
  readonly status: "APPLIED" | "DUPLICATE";
}

export class MutationOperationError extends Data.TaggedError("MutationOperationError")<{
  readonly reason:
    | "authorization_denied"
    | "expired_receipt"
    | "hash_failed"
    | "invalid_command"
    | "invalid_hash"
    | "replay_conflict";
}> {}

/**
 * Cryptographic hashing is deliberately injected. A production implementation
 * belongs at the audited runtime adapter boundary; no Worker source calls
 * platform Promise crypto directly.
 */
export interface CanonicalMutationHasher {
  readonly hash: (canonicalJSON: string) => Effect.Effect<string, MutationOperationError>;
}
export const CanonicalMutationHasher = Context.GenericTag<CanonicalMutationHasher>(
  "@enchiridion/worker-vault/v2/CanonicalMutationHasher",
);

export interface MutationReceiptTransaction {
  readonly snapshotAuthorization: (
    authorization: MutationAuthorization,
  ) => Effect.Effect<MutationAuthorization, MutationOperationError>;
  readonly readReceipt: (
    requestID: RequestID,
  ) => Effect.Effect<MutationReceipt | undefined, MutationOperationError>;
  readonly apply: (
    kind: MutationKind,
    canonicalHash: string,
  ) => Effect.Effect<number, MutationOperationError>;
  readonly writeReceipt: (
    requestID: RequestID,
    receipt: MutationReceipt,
  ) => Effect.Effect<void, MutationOperationError>;
  readonly audit: (event: MutationAuditEvent) => Effect.Effect<void, MutationOperationError>;
}

/** Abstract transactional store. All auth snapshot, replay lookup, mutation, receipt, and audit work shares one transaction. */
export interface MutationReceiptRepository {
  readonly transact: <A>(
    scope: MutationScope,
    operation: (
      transaction: MutationReceiptTransaction,
    ) => Effect.Effect<A, MutationOperationError>,
  ) => Effect.Effect<A, MutationOperationError>;
}
export const MutationReceiptRepository = Context.GenericTag<MutationReceiptRepository>(
  "@enchiridion/worker-vault/v2/MutationReceiptRepository",
);

export interface MutationService {
  readonly execute: (
    command: MutationCommand,
  ) => Effect.Effect<MutationExecution, MutationOperationError>;
}
export const MutationService = Context.GenericTag<MutationService>(
  "@enchiridion/worker-vault/v2/MutationService",
);

const hashPattern = /^[a-f0-9]{64}$/u;
export const maximumMutationReceiptTTLSeconds = 3_600;
const validEpoch = (value: number, minimum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum;
const validScope = (scope: MutationScope): boolean =>
  isOwnerID(scope.ownerID) && isVaultID(scope.vaultID) && validEpoch(scope.generationEpoch, 0);
const validAuthorization = (authorization: MutationAuthorization): boolean =>
  validScope(authorization) &&
  isCredentialID(authorization.credentialID) &&
  validEpoch(authorization.credentialEpoch, 1);
const validKind = (value: unknown): value is MutationKind =>
  value === MutationKind.PutRecord || value === MutationKind.DeleteRecord;
const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const canonicalValue = (value: unknown): string | undefined => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const item of value) {
      const encoded = canonicalValue(item);
      if (encoded === undefined) return undefined;
      values.push(encoded);
    }
    return `[${values.join(",")}]`;
  }
  if (value === null || typeof value !== "object") return undefined;
  const source = Object.entries(value);
  const values: string[] = [];
  // Relational string comparison is the protocol profile: deterministic UTF-16 code-unit order,
  // independent of the process locale and its ICU configuration.
  for (const [key, item] of source.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const encoded = canonicalValue(item);
    if (encoded === undefined) return undefined;
    values.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${values.join(",")}}`;
};

export const canonicalMutationJSON = (command: MutationCommand): string | undefined =>
  canonicalValue({ body: command.body, kind: command.kind });

const failure = <A>(
  reason: MutationOperationError["reason"],
): Effect.Effect<A, MutationOperationError> => Effect.fail(new MutationOperationError({ reason }));

export const makeMutationService = Effect.gen(function* () {
  const repository = yield* MutationReceiptRepository;
  const hasher = yield* CanonicalMutationHasher;
  const execute = (
    command: MutationCommand,
  ): Effect.Effect<MutationExecution, MutationOperationError> => {
    if (
      !validAuthorization(command.authorization) ||
      !isRequestID(command.requestID) ||
      !validKind(command.kind) ||
      !validTime(command.nowSeconds) ||
      !validTime(command.receiptExpiresAtSeconds) ||
      command.receiptExpiresAtSeconds <= command.nowSeconds ||
      command.receiptExpiresAtSeconds - command.nowSeconds > maximumMutationReceiptTTLSeconds
    )
      return failure("invalid_command");
    const canonical = canonicalMutationJSON(command);
    if (canonical === undefined) return failure("invalid_command");
    return repository.transact<MutationExecution>(
      command.authorization,
      (transaction): Effect.Effect<MutationExecution, MutationOperationError> =>
        Effect.gen(function* () {
          const snapshot = yield* transaction.snapshotAuthorization(command.authorization);
          if (
            snapshot.ownerID.value !== command.authorization.ownerID.value ||
            snapshot.vaultID.value !== command.authorization.vaultID.value ||
            snapshot.generationEpoch !== command.authorization.generationEpoch ||
            snapshot.credentialID.value !== command.authorization.credentialID.value ||
            snapshot.credentialEpoch !== command.authorization.credentialEpoch
          )
            return yield* failure<MutationExecution>("authorization_denied");
          const canonicalHash = yield* hasher
            .hash(canonical)
            .pipe(Effect.mapError(() => new MutationOperationError({ reason: "hash_failed" })));
          if (!hashPattern.test(canonicalHash))
            return yield* failure<MutationExecution>("invalid_hash");
          const existing = yield* transaction.readReceipt(command.requestID);
          if (existing !== undefined) {
            if (existing.canonicalHash !== canonicalHash)
              return yield* failure<MutationExecution>("replay_conflict");
            if (existing.expiresAtSeconds > command.nowSeconds) {
              yield* transaction.audit({
                event: "mutation.replayed",
                kind: existing.kind,
                canonicalHash,
              });
              return { receipt: existing, status: "DUPLICATE" } satisfies MutationExecution;
            }
            // Receipt expiry is only meaningful after the request has passed the authenticated boundary.
            return yield* failure<MutationExecution>("expired_receipt");
          }
          const resultVersion = yield* transaction.apply(command.kind, canonicalHash);
          const receipt: MutationReceipt = {
            requestID: command.requestID.value,
            canonicalHash,
            kind: command.kind,
            resultVersion,
            expiresAtSeconds: command.receiptExpiresAtSeconds,
          };
          yield* transaction.writeReceipt(command.requestID, receipt);
          yield* transaction.audit({
            event: "mutation.applied",
            kind: command.kind,
            canonicalHash,
          });
          return { receipt, status: "APPLIED" } satisfies MutationExecution;
        }),
    );
  };
  return { execute } satisfies MutationService;
});

interface InMemoryMutationState {
  readonly audits: readonly MutationAuditEvent[];
  readonly receipts: Readonly<Record<string, MutationReceipt>>;
  readonly version: number;
}

const scopeKey = (scope: MutationScope): string =>
  `${scope.ownerID.value}\u0000${scope.vaultID.value}\u0000${scope.generationEpoch}`;
const receiptKey = (scope: MutationScope, requestID: RequestID): string =>
  `${scopeKey(scope)}\u0000${requestID.value}`;

/** Deterministic test-only transaction implementation; production persistence must supply its own atomic repository. */
export const makeInMemoryMutationReceiptRepository = Effect.gen(function* () {
  const state = yield* Ref.make<InMemoryMutationState>({ audits: [], receipts: {}, version: 0 });
  const semaphore = yield* Effect.makeSemaphore(1);
  const repository: MutationReceiptRepository = {
    transact: <A>(
      scope: MutationScope,
      operation: (
        transaction: MutationReceiptTransaction,
      ) => Effect.Effect<A, MutationOperationError>,
    ): Effect.Effect<A, MutationOperationError> => {
      const transaction: MutationReceiptTransaction = {
        snapshotAuthorization: (authorization) =>
          validAuthorization(authorization) && scopeKey(authorization) === scopeKey(scope)
            ? Effect.succeed(authorization)
            : failure("authorization_denied"),
        readReceipt: (requestID) =>
          isRequestID(requestID)
            ? Effect.map(
                Ref.get(state),
                (current) => current.receipts[receiptKey(scope, requestID)],
              )
            : failure("invalid_command"),
        apply: (kind, canonicalHash) =>
          validKind(kind) && hashPattern.test(canonicalHash)
            ? Effect.flatMap(
                Ref.updateAndGet(state, (current) => ({
                  ...current,
                  version: current.version + 1,
                })),
                (current) => Effect.succeed(current.version),
              )
            : failure("invalid_command"),
        writeReceipt: (requestID, receipt) =>
          isRequestID(requestID) && receipt.requestID === requestID.value
            ? Ref.update(state, (current) => ({
                ...current,
                receipts: { ...current.receipts, [receiptKey(scope, requestID)]: receipt },
              }))
            : failure("invalid_command"),
        audit: (event) =>
          Ref.update(state, (current) => ({ ...current, audits: [...current.audits, event] })),
      };
      return semaphore.withPermits(1)(
        validScope(scope) ? operation(transaction) : failure<A>("authorization_denied"),
      );
    },
  };
  return { layer: Context.make(MutationReceiptRepository, repository), repository, state };
});
