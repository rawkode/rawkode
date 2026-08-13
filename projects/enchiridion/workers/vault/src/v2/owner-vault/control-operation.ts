/** @enchiridion/effect-module */
/**
 * The snapshot and restore controls have a deliberately self-contained
 * receipt lifecycle.  Unlike ordinary one-shot capability receipts, these
 * operations span archive I/O and must be fenced across isolate restarts.
 */
import { Effect } from "effect";
import type { OwnerVaultRestoreImportReceipt } from "./backup-types";
import type {
  OwnerVaultStorageRepository,
  OwnerVaultStorageTransactionFailure,
  OwnerVaultTx,
} from "./repository";
import {
  type SignedSourceSnapshotPublicationV1,
  validSignedSourceSnapshotPublication,
} from "./source-snapshot-publication";

/**
 * A control bearer may live for up to 60 seconds. Keep the active owner
 * lease shorter so there is a real, bounded post-lease recovery interval
 * before that signed deadline; a lease equal to the bearer maximum would
 * make exact terminal recovery unreachable.
 */
export const ownerVaultControlOperationLeaseMilliseconds = 15_000;
/** Active leases and retained terminal receipts share this one bounded cohort. */
export const ownerVaultControlOperationCohortCapacity = 64;

export type OwnerVaultControlOperationKind = "snapshot" | "restore";
export type OwnerVaultControlOperationResult =
  | {
      readonly kind: "snapshot";
      readonly manifestDigest: string;
      readonly sourceSnapshotPublication: SignedSourceSnapshotPublicationV1;
    }
  | { readonly kind: "restore"; readonly terminalTranscript: OwnerVaultRestoreImportReceipt };

/** Closed evidence is a separate durable record. Expired recovery reads this
 * fixed row; it never infers completion by scanning pin or journal state. */
export interface OwnerVaultControlTerminalEvidence {
  readonly schema: "control-terminal-evidence-v1";
  readonly state: "CLOSED";
  readonly operationID: string;
  readonly receiptJTI: string;
  readonly root: OwnerVaultControlOperationDetails["root"];
  readonly kind: OwnerVaultControlOperationKind;
  readonly controlDigest: string;
  readonly result: OwnerVaultControlOperationResult;
}

export interface OwnerVaultControlOperationDetails {
  readonly kind: OwnerVaultControlOperationKind;
  readonly root: {
    readonly ownerID: string;
    readonly vaultID: string;
    readonly generationEpoch: number;
    readonly namespaceState: "PRIVATE";
  };
  readonly operationID: string;
  /** The verified capability identity, never its bearer value. */
  readonly receiptJTI: string;
  readonly lifecycle: "receipt-lease-v1";
  /** Verified signed expiry. This is also persisted in the durable `jti` row. */
  readonly expiresAtSeconds: number;
  readonly receiptFingerprint: string;
  /** Hash of the exact signed wire command. */
  readonly controlDigest: string;
  /** Canonical JSON for the closed command schema, not a rebuilt subset. */
  readonly canonicalCommand: string;
  /** Takeover is permitted only before this absolute operation deadline. */
  readonly hardDeadlineMilliseconds: number;
}

export interface OwnerVaultControlOperationLease {
  readonly leaseID: string;
  readonly leaseEpoch: number;
}

export interface OwnerVaultControlLeaseIndexEntry {
  readonly operationID: string;
  readonly receiptJTI: string;
  readonly kind: OwnerVaultControlOperationKind;
  readonly hardDeadlineMilliseconds: number;
  readonly leaseUntilMilliseconds: number;
}

export interface OwnerVaultControlCompletedRetentionEntry {
  readonly operationID: string;
  readonly receiptJTI: string;
  readonly expiresAtMilliseconds: number;
}

type StoredControlOperation = OwnerVaultControlOperationDetails & {
  readonly schema: "control-operation-v2";
  readonly state:
    | "CLAIMED"
    | "EXECUTING"
    | "SNAPSHOT_MANIFEST_READY"
    | "RESTORE_APPLYING"
    | "CLEANING"
    | "COMPLETED";
  readonly leaseID: string;
  readonly leaseEpoch: number;
  readonly leaseUntilMilliseconds: number;
  readonly result?: OwnerVaultControlOperationResult;
};

export type OwnerVaultControlOperationClaim = {
  readonly state: "FRESH";
  readonly lease: OwnerVaultControlOperationLease;
};

const identifier = /^[A-Za-z0-9_-]{1,128}$/u;
const digest = /^[a-f0-9]{64}$/u;
const manifestDigest = /^[A-Za-z0-9_-]{43}$/u;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
/** Strict UTF-16 code-unit comparator. The C2 index validators and the
 * reconcile cursor partition compare by code units, so every sort here must
 * use the same ordering — locale collation diverges for legal identifiers. */
const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const asPayload = (value: object): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(value));
const address = (operationID: string) => ({
  category: "control.operation" as const,
  identifier: operationID,
});
const terminalEvidenceAddress = (operationID: string) => ({
  category: "control-terminal-evidence" as const,
  identifier: operationID,
});
const failure = <A = never>(): Effect.Effect<A, OwnerVaultStorageTransactionFailure> =>
  Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" });

export const validOwnerVaultControlLeaseIndexEntry = (
  value: unknown,
): value is OwnerVaultControlLeaseIndexEntry => {
  const source = record(value);
  return (
    source !== undefined &&
    exact(source, [
      "operationID",
      "receiptJTI",
      "kind",
      "hardDeadlineMilliseconds",
      "leaseUntilMilliseconds",
    ]) &&
    typeof source.operationID === "string" &&
    identifier.test(source.operationID) &&
    typeof source.receiptJTI === "string" &&
    identifier.test(source.receiptJTI) &&
    (source.kind === "snapshot" || source.kind === "restore") &&
    positive(source.hardDeadlineMilliseconds) &&
    positive(source.leaseUntilMilliseconds) &&
    source.leaseUntilMilliseconds <= source.hardDeadlineMilliseconds
  );
};

const decodeControlRoot = (
  value: unknown,
): OwnerVaultControlOperationDetails["root"] | undefined => {
  const source = record(value);
  return source !== undefined &&
    exact(source, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) &&
    typeof source.ownerID === "string" &&
    typeof source.vaultID === "string" &&
    positive(source.generationEpoch) &&
    source.namespaceState === "PRIVATE"
    ? {
        ownerID: source.ownerID,
        vaultID: source.vaultID,
        generationEpoch: source.generationEpoch,
        namespaceState: "PRIVATE",
      }
    : undefined;
};

const validDetails = (value: OwnerVaultControlOperationDetails): boolean =>
  (value.kind === "snapshot" || value.kind === "restore") &&
  identifier.test(value.root.ownerID) &&
  identifier.test(value.root.vaultID) &&
  value.root.ownerID !== value.root.vaultID &&
  positive(value.root.generationEpoch) &&
  value.root.namespaceState === "PRIVATE" &&
  identifier.test(value.operationID) &&
  identifier.test(value.receiptJTI) &&
  positive(value.expiresAtSeconds) &&
  value.lifecycle === "receipt-lease-v1" &&
  digest.test(value.receiptFingerprint) &&
  digest.test(value.controlDigest) &&
  value.canonicalCommand.length > 1 &&
  new TextEncoder().encode(value.canonicalCommand).byteLength <= 16_384 &&
  positive(value.hardDeadlineMilliseconds) &&
  value.hardDeadlineMilliseconds === value.expiresAtSeconds * 1_000;

const sameDetails = (
  left: OwnerVaultControlOperationDetails,
  right: OwnerVaultControlOperationDetails,
): boolean =>
  left.kind === right.kind &&
  left.root.ownerID === right.root.ownerID &&
  left.root.vaultID === right.root.vaultID &&
  left.root.generationEpoch === right.root.generationEpoch &&
  left.root.namespaceState === right.root.namespaceState &&
  left.operationID === right.operationID &&
  left.receiptJTI === right.receiptJTI &&
  left.expiresAtSeconds === right.expiresAtSeconds &&
  left.lifecycle === right.lifecycle &&
  left.receiptFingerprint === right.receiptFingerprint &&
  left.controlDigest === right.controlDigest &&
  left.canonicalCommand === right.canonicalCommand &&
  left.hardDeadlineMilliseconds === right.hardDeadlineMilliseconds;

const validRestoreTranscript = (value: unknown): value is OwnerVaultRestoreImportReceipt => {
  const receipt = record(value);
  const root = receipt === undefined ? undefined : record(receipt.targetRoot);
  return (
    receipt !== undefined &&
    root !== undefined &&
    exact(receipt, [
      "accountingProof",
      "appendLogDigest",
      "appendLogSequence",
      "blobProof",
      "finalizationProof",
      "inventoryDigest",
      "manifestDigest",
      "outcome",
      "restoreID",
      "securityFloor",
      "targetCatalogProof",
      "targetRoot",
    ]) &&
    receipt.outcome === "COMPLETED" &&
    typeof receipt.restoreID === "string" &&
    identifier.test(receipt.restoreID) &&
    typeof receipt.manifestDigest === "string" &&
    manifestDigest.test(receipt.manifestDigest) &&
    typeof receipt.inventoryDigest === "string" &&
    manifestDigest.test(receipt.inventoryDigest) &&
    typeof receipt.targetCatalogProof === "string" &&
    manifestDigest.test(receipt.targetCatalogProof) &&
    typeof receipt.accountingProof === "string" &&
    manifestDigest.test(receipt.accountingProof) &&
    typeof receipt.blobProof === "string" &&
    manifestDigest.test(receipt.blobProof) &&
    typeof receipt.finalizationProof === "string" &&
    manifestDigest.test(receipt.finalizationProof) &&
    typeof receipt.appendLogSequence === "number" &&
    Number.isSafeInteger(receipt.appendLogSequence) &&
    receipt.appendLogSequence >= 0 &&
    typeof receipt.appendLogDigest === "string" &&
    digest.test(receipt.appendLogDigest) &&
    typeof receipt.securityFloor === "number" &&
    Number.isSafeInteger(receipt.securityFloor) &&
    receipt.securityFloor >= 0 &&
    decodeControlRoot(root) !== undefined
  );
};

const validResult = (
  kind: OwnerVaultControlOperationKind,
  value: unknown,
): value is OwnerVaultControlOperationResult => {
  const source = record(value);
  return kind === "snapshot"
    ? source !== undefined &&
        exact(source, ["kind", "manifestDigest", "sourceSnapshotPublication"]) &&
        validSignedSourceSnapshotPublication(source.sourceSnapshotPublication) &&
        source.kind === "snapshot" &&
        typeof source.manifestDigest === "string" &&
        manifestDigest.test(source.manifestDigest)
    : source !== undefined &&
        exact(source, ["kind", "terminalTranscript"]) &&
        source.kind === "restore" &&
        validRestoreTranscript(source.terminalTranscript);
};

const terminalEvidence = (
  details: OwnerVaultControlOperationDetails,
  result: OwnerVaultControlOperationResult,
): OwnerVaultControlTerminalEvidence => ({
  schema: "control-terminal-evidence-v1",
  state: "CLOSED",
  operationID: details.operationID,
  receiptJTI: details.receiptJTI,
  root: details.root,
  kind: details.kind,
  controlDigest: details.controlDigest,
  result,
});

const validTerminalEvidence = (
  value: unknown,
  details: OwnerVaultControlOperationDetails,
  result: OwnerVaultControlOperationResult,
): value is OwnerVaultControlTerminalEvidence => {
  const evidence = record(value);
  const sourcePublication =
    result.kind === "snapshot" ? result.sourceSnapshotPublication : undefined;
  const transcript = result.kind === "restore" ? result.terminalTranscript : undefined;
  const boundResult =
    result.kind === "snapshot" && sourcePublication !== undefined
      ? sourcePublication.manifestDigest === result.manifestDigest &&
        sourcePublication.snapshotOperationID === details.operationID &&
        sourcePublication.snapshotJTI === details.receiptJTI &&
        sourcePublication.snapshotCommandSHA256 === details.controlDigest &&
        JSON.stringify(sourcePublication.sourceRoot) === JSON.stringify(details.root)
      : transcript !== undefined &&
        JSON.stringify(transcript.targetRoot) === JSON.stringify(details.root);
  return (
    evidence !== undefined &&
    exact(evidence, [
      "schema",
      "state",
      "operationID",
      "receiptJTI",
      "root",
      "kind",
      "controlDigest",
      "result",
    ]) &&
    evidence.schema === "control-terminal-evidence-v1" &&
    evidence.state === "CLOSED" &&
    evidence.operationID === details.operationID &&
    evidence.receiptJTI === details.receiptJTI &&
    evidence.kind === details.kind &&
    evidence.controlDigest === details.controlDigest &&
    JSON.stringify(evidence.root) === JSON.stringify(details.root) &&
    validResult(details.kind, evidence.result) &&
    boundResult &&
    JSON.stringify(evidence.result) === JSON.stringify(result)
  );
};

const decode = (value: unknown): StoredControlOperation | undefined => {
  const source = record(value);
  if (source === undefined) return undefined;
  const complete = source.state === "COMPLETED";
  const keys = [
    "canonicalCommand",
    "controlDigest",
    "expiresAtSeconds",
    "hardDeadlineMilliseconds",
    "kind",
    "root",
    "leaseEpoch",
    "leaseID",
    "leaseUntilMilliseconds",
    "operationID",
    "lifecycle",
    "receiptFingerprint",
    "receiptJTI",
    "state",
    "schema",
    ...(complete ? ["result"] : []),
  ];
  const root = decodeControlRoot(source.root);
  if (
    !exact(source, keys) ||
    source.schema !== "control-operation-v2" ||
    (source.kind !== "snapshot" && source.kind !== "restore") ||
    root === undefined ||
    typeof source.operationID !== "string" ||
    typeof source.receiptJTI !== "string" ||
    !positive(source.expiresAtSeconds) ||
    source.lifecycle !== "receipt-lease-v1" ||
    !positive(source.hardDeadlineMilliseconds) ||
    typeof source.receiptFingerprint !== "string" ||
    typeof source.controlDigest !== "string" ||
    typeof source.canonicalCommand !== "string" ||
    typeof source.leaseID !== "string" ||
    !identifier.test(source.leaseID) ||
    !positive(source.leaseEpoch) ||
    !positive(source.leaseUntilMilliseconds)
  )
    return undefined;
  const details: OwnerVaultControlOperationDetails = {
    kind: source.kind,
    root,
    operationID: source.operationID,
    receiptJTI: source.receiptJTI,
    lifecycle: source.lifecycle,
    expiresAtSeconds: source.expiresAtSeconds,
    receiptFingerprint: source.receiptFingerprint,
    controlDigest: source.controlDigest,
    canonicalCommand: source.canonicalCommand,
    hardDeadlineMilliseconds: source.hardDeadlineMilliseconds,
  };
  if (!validDetails(details)) return undefined;
  const lease = {
    leaseID: source.leaseID,
    leaseEpoch: source.leaseEpoch,
    leaseUntilMilliseconds: source.leaseUntilMilliseconds,
  } as const;
  if (
    source.state === "CLAIMED" ||
    source.state === "EXECUTING" ||
    source.state === "SNAPSHOT_MANIFEST_READY" ||
    source.state === "RESTORE_APPLYING" ||
    source.state === "CLEANING"
  )
    return complete
      ? undefined
      : { ...details, schema: "control-operation-v2", state: source.state, ...lease };
  if (source.state !== "COMPLETED") return undefined;
  return complete && validResult(details.kind, source.result)
    ? {
        ...details,
        schema: "control-operation-v2",
        state: "COMPLETED",
        ...lease,
        result: source.result,
      }
    : undefined;
};

const active = (
  stored: StoredControlOperation,
  lease: OwnerVaultControlOperationLease,
  at: number,
): boolean =>
  stored.state !== "COMPLETED" &&
  stored.leaseID === lease.leaseID &&
  stored.leaseEpoch === lease.leaseEpoch &&
  stored.leaseUntilMilliseconds > at;

/** Root identity and the stopped fence are sampled inside every C2 durable
 * transaction; claims obtained before a credential stop cannot race in. */
const requireLiveRoot = (tx: OwnerVaultTx, details: OwnerVaultControlOperationDetails) =>
  Effect.all([tx.get({ category: "root.identity" }), tx.get({ category: "root.admission" })]).pipe(
    Effect.flatMap(([identity, admission]) => {
      const root = identity === undefined ? undefined : record(identity.payload);
      const state = admission === undefined ? undefined : record(admission.payload);
      return root !== undefined &&
        state !== undefined &&
        root.ownerID === details.root.ownerID &&
        root.vaultID === details.root.vaultID &&
        root.generationEpoch === details.root.generationEpoch &&
        root.namespaceState === "PRIVATE" &&
        state.stopped === false
        ? Effect.void
        : failure<void>();
    }),
  );

/** The durable JTI category is the sole capability-identity namespace. */
const jtiAddress = (jti: string) => ({ category: "jti" as const, identifier: jti });
const decodeJTI = (
  value: unknown,
):
  | (OwnerVaultControlOperationDetails & { readonly state: "RESERVED" | "COMPLETED" })
  | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    !exact(source, [
      "schema",
      "operationID",
      "receiptJTI",
      "kind",
      "lifecycle",
      "expiresAtSeconds",
      "controlDigest",
      "canonicalCommand",
      "hardDeadlineMilliseconds",
      "state",
    ]) ||
    source.schema !== "control-receipt-lease-jti-v1" ||
    (source.state !== "RESERVED" && source.state !== "COMPLETED") ||
    (source.kind !== "snapshot" && source.kind !== "restore") ||
    typeof source.operationID !== "string" ||
    typeof source.receiptJTI !== "string" ||
    source.lifecycle !== "receipt-lease-v1" ||
    typeof source.expiresAtSeconds !== "number" ||
    typeof source.controlDigest !== "string" ||
    typeof source.canonicalCommand !== "string" ||
    typeof source.hardDeadlineMilliseconds !== "number"
  )
    return undefined;
  const details: OwnerVaultControlOperationDetails = {
    kind: source.kind,
    root: {
      ownerID: "control-jti-owner",
      vaultID: "control-jti-vault",
      generationEpoch: 1,
      namespaceState: "PRIVATE",
    },
    operationID: source.operationID,
    receiptJTI: source.receiptJTI,
    lifecycle: source.lifecycle,
    expiresAtSeconds: source.expiresAtSeconds,
    controlDigest: source.controlDigest,
    canonicalCommand: source.canonicalCommand,
    hardDeadlineMilliseconds: source.hardDeadlineMilliseconds,
    // The JTI row deliberately has no bearer fingerprint; it must be
    // reciprocal with the control row, whose fingerprint is checked too.
    receiptFingerprint: "0".repeat(64),
  };
  return validDetails(details) ? { ...details, state: source.state } : undefined;
};

const sameJTI = (
  claim: ReturnType<typeof decodeJTI>,
  details: OwnerVaultControlOperationDetails,
): boolean =>
  claim !== undefined &&
  claim.operationID === details.operationID &&
  claim.receiptJTI === details.receiptJTI &&
  claim.kind === details.kind &&
  claim.lifecycle === details.lifecycle &&
  claim.expiresAtSeconds === details.expiresAtSeconds &&
  claim.controlDigest === details.controlDigest &&
  claim.canonicalCommand === details.canonicalCommand &&
  claim.hardDeadlineMilliseconds === details.hardDeadlineMilliseconds;

const jtiPayload = (
  details: OwnerVaultControlOperationDetails,
  state: "RESERVED" | "COMPLETED",
) => ({
  schema: "control-receipt-lease-jti-v1" as const,
  operationID: details.operationID,
  receiptJTI: details.receiptJTI,
  kind: details.kind,
  lifecycle: details.lifecycle,
  expiresAtSeconds: details.expiresAtSeconds,
  controlDigest: details.controlDigest,
  canonicalCommand: details.canonicalCommand,
  hardDeadlineMilliseconds: details.hardDeadlineMilliseconds,
  state,
});

/** Exact bounded rebuild of the lease index; order and uniqueness are proven. */
const decodeControlLeaseIndexEntries = (
  value: unknown,
): readonly OwnerVaultControlLeaseIndexEntry[] | undefined => {
  if (!Array.isArray(value) || value.length > ownerVaultControlOperationCohortCapacity)
    return undefined;
  const entries: OwnerVaultControlLeaseIndexEntry[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return undefined;
    const entry: unknown = value[index];
    if (!validOwnerVaultControlLeaseIndexEntry(entry)) return undefined;
    entries.push(entry);
  }
  return new Set(entries.map((entry) => entry.operationID)).size === entries.length &&
    new Set(entries.map((entry) => entry.receiptJTI)).size === entries.length
    ? entries
    : undefined;
};

/** C2 owns this fourth admission index. Generic receipt writers preserve it
 * through the central v3 materializer but never insert control operations. */
const updateControlLeaseIndex = (
  tx: OwnerVaultTx,
  nextEntry: OwnerVaultControlLeaseIndexEntry,
  mode: "reserve" | "release" | "renew",
): Effect.Effect<void, OwnerVaultStorageTransactionFailure> =>
  Effect.all([
    tx.get({ category: "root.admission" }),
    tx.get({ category: "control-receipt-lease-index" }),
  ]).pipe(
    Effect.flatMap(([admissionEntry, indexEntry]) => {
      const admission = admissionEntry === undefined ? undefined : record(admissionEntry.payload);
      const index = indexEntry === undefined ? undefined : record(indexEntry.payload);
      const entries =
        index === undefined ? undefined : decodeControlLeaseIndexEntries(index.entries);
      if (
        admission === undefined ||
        admission.schema !== "admission-v3" ||
        typeof admission.controlReceiptLeases !== "number" ||
        !Number.isSafeInteger(admission.controlReceiptLeases) ||
        entries === undefined ||
        entries.length !== admission.controlReceiptLeases
      )
        return failure<void>();
      const present = entries.some((entry) => entry.operationID === nextEntry.operationID);
      if ((mode === "reserve" && present) || ((mode === "release" || mode === "renew") && !present))
        return failure<void>();
      const next: readonly OwnerVaultControlLeaseIndexEntry[] =
        mode === "reserve"
          ? [...entries, nextEntry].sort((left, right) =>
              compareCodeUnits(left.operationID, right.operationID),
            )
          : mode === "release"
            ? entries.filter((entry) => entry.operationID !== nextEntry.operationID)
            : entries.map((entry) =>
                entry.operationID === nextEntry.operationID ? nextEntry : entry,
              );
      if (next.length > ownerVaultControlOperationCohortCapacity) return failure<void>();
      return tx.put({ category: "control-receipt-lease-index" }, { entries: next }).pipe(
        Effect.zipRight(
          tx.put(
            { category: "root.admission" },
            {
              ...admission,
              controlReceiptLeases: next.length,
            },
          ),
        ),
      );
    }),
  );

const activeIndexEntry = (stored: StoredControlOperation): OwnerVaultControlLeaseIndexEntry => ({
  operationID: stored.operationID,
  receiptJTI: stored.receiptJTI,
  kind: stored.kind,
  hardDeadlineMilliseconds: stored.hardDeadlineMilliseconds,
  leaseUntilMilliseconds: stored.leaseUntilMilliseconds,
});

const completedRetentionEntry = (
  details: OwnerVaultControlOperationDetails,
): OwnerVaultControlCompletedRetentionEntry => ({
  operationID: details.operationID,
  receiptJTI: details.receiptJTI,
  expiresAtMilliseconds: details.expiresAtSeconds * 1_000,
});

const validCompletedRetentionEntry = (
  value: unknown,
): value is OwnerVaultControlCompletedRetentionEntry => {
  const row = record(value);
  return (
    row !== undefined &&
    exact(row, ["operationID", "receiptJTI", "expiresAtMilliseconds"]) &&
    typeof row.operationID === "string" &&
    identifier.test(row.operationID) &&
    typeof row.receiptJTI === "string" &&
    identifier.test(row.receiptJTI) &&
    positive(row.expiresAtMilliseconds)
  );
};

/** Exact bounded rebuild of the completed-retention index. */
const decodeCompletedRetentionEntries = (
  value: unknown,
): readonly OwnerVaultControlCompletedRetentionEntry[] | undefined => {
  if (!Array.isArray(value) || value.length > ownerVaultControlOperationCohortCapacity)
    return undefined;
  const entries: OwnerVaultControlCompletedRetentionEntry[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return undefined;
    const entry: unknown = value[index];
    if (!validCompletedRetentionEntry(entry)) return undefined;
    entries.push(entry);
  }
  return new Set(entries.map((entry) => entry.operationID)).size === entries.length &&
    new Set(entries.map((entry) => entry.receiptJTI)).size === entries.length
    ? entries
    : undefined;
};

type ControlCohort = {
  readonly admission: Readonly<Record<string, unknown>>;
  readonly leases: readonly OwnerVaultControlLeaseIndexEntry[];
  readonly completed: readonly OwnerVaultControlCompletedRetentionEntry[];
};

/** Loads the sole C2 occupancy cohort. Cross-index overlap is corruption. */
const loadControlCohortInTx = (
  tx: OwnerVaultTx,
): Effect.Effect<ControlCohort, OwnerVaultStorageTransactionFailure> =>
  Effect.all([
    tx.get({ category: "root.admission" }),
    tx.get({ category: "control-receipt-lease-index" }),
    tx.get({ category: "control-receipt-completed-index" }),
  ]).pipe(
    Effect.flatMap(([admissionEntry, leaseEntry, completedEntry]) => {
      const admission = admissionEntry === undefined ? undefined : record(admissionEntry.payload);
      const leases = decodeControlLeaseIndexEntries(
        record(leaseEntry?.payload ?? { entries: [] })?.entries,
      );
      const completed = decodeCompletedRetentionEntries(
        record(completedEntry?.payload ?? { entries: [] })?.entries,
      );
      const leaseOperationIDs = new Set(leases?.map((entry) => entry.operationID));
      const leaseJTIs = new Set(leases?.map((entry) => entry.receiptJTI));
      return admission === undefined ||
        admission.schema !== "admission-v3" ||
        typeof admission.controlReceiptLeases !== "number" ||
        !Number.isSafeInteger(admission.controlReceiptLeases) ||
        leases === undefined ||
        completed === undefined ||
        admission.controlReceiptLeases !== leases.length ||
        leases.length + completed.length > ownerVaultControlOperationCohortCapacity ||
        completed.some(
          (entry) => leaseOperationIDs.has(entry.operationID) || leaseJTIs.has(entry.receiptJTI),
        )
        ? failure<ControlCohort>()
        : Effect.succeed({ admission, leases, completed });
    }),
  );

/** Completion replaces exactly one active slot with exactly one retained slot. */
const transferControlCohortSlotInTx = (
  tx: OwnerVaultTx,
  stored: StoredControlOperation,
  details: OwnerVaultControlOperationDetails,
): Effect.Effect<void, OwnerVaultStorageTransactionFailure> =>
  loadControlCohortInTx(tx).pipe(
    Effect.flatMap(({ admission, leases, completed }) => {
      const active = activeIndexEntry(stored);
      const present = leases.some(
        (entry) =>
          entry.operationID === active.operationID &&
          entry.receiptJTI === active.receiptJTI &&
          entry.kind === active.kind &&
          entry.hardDeadlineMilliseconds === active.hardDeadlineMilliseconds &&
          entry.leaseUntilMilliseconds === active.leaseUntilMilliseconds,
      );
      if (
        !present ||
        completed.some(
          (entry) =>
            entry.operationID === details.operationID || entry.receiptJTI === details.receiptJTI,
        )
      )
        return failure<void>();
      const nextLeases = leases.filter((entry) => entry.operationID !== details.operationID);
      const nextCompleted = [...completed, completedRetentionEntry(details)].sort((left, right) =>
        compareCodeUnits(left.operationID, right.operationID),
      );
      return nextLeases.length + nextCompleted.length !== leases.length + completed.length ||
        nextCompleted.length > ownerVaultControlOperationCohortCapacity
        ? failure<void>()
        : tx
            .put({ category: "control-receipt-lease-index" }, { entries: nextLeases })
            .pipe(
              Effect.zipRight(
                tx.put({ category: "control-receipt-completed-index" }, { entries: nextCompleted }),
              ),
              Effect.zipRight(
                tx.put(
                  { category: "root.admission" },
                  { ...admission, controlReceiptLeases: nextLeases.length },
                ),
              ),
            );
    }),
  );

/** A C2 writer can only tighten the shared DO alarm. */
const armControlAlarmInTx = (
  tx: OwnerVaultTx,
  deadlineMilliseconds: number,
): Effect.Effect<void, OwnerVaultStorageTransactionFailure> =>
  tx
    .getAlarm()
    .pipe(
      Effect.flatMap((current) =>
        current === null || current > deadlineMilliseconds
          ? tx.setAlarm(deadlineMilliseconds)
          : Effect.void,
      ),
    );

const leaseUntil = (nowMilliseconds: number, hardDeadlineMilliseconds: number): number =>
  Math.min(nowMilliseconds + ownerVaultControlOperationLeaseMilliseconds, hardDeadlineMilliseconds);

/** Must be composed inside the same transaction as the protected pin/journal write. */
export const fenceOwnerVaultControlOperationInTx = (
  tx: OwnerVaultTx,
  details: OwnerVaultControlOperationDetails,
  lease: OwnerVaultControlOperationLease,
): Effect.Effect<void, OwnerVaultStorageTransactionFailure> =>
  Effect.sync(Date.now).pipe(
    Effect.flatMap((atMilliseconds) =>
      requireLiveRoot(tx, details).pipe(
        Effect.zipRight(tx.get(address(details.operationID))),
        Effect.flatMap((entry) => {
          const stored = entry === undefined ? undefined : decode(entry.payload);
          return stored === undefined ||
            !sameDetails(stored, details) ||
            !active(stored, lease, atMilliseconds)
            ? failure<void>()
            : tx.get(jtiAddress(details.receiptJTI)).pipe(
                Effect.flatMap((jti) => {
                  const claim = jti === undefined ? undefined : decodeJTI(jti.payload);
                  return claim === undefined ||
                    !sameJTI(claim, details) ||
                    claim.state === "COMPLETED"
                    ? failure<void>()
                    : tx
                        .put(address(details.operationID), {
                          ...stored,
                          state: "EXECUTING",
                          leaseUntilMilliseconds: leaseUntil(
                            atMilliseconds,
                            stored.hardDeadlineMilliseconds,
                          ),
                        })
                        .pipe(
                          Effect.zipRight(
                            updateControlLeaseIndex(
                              tx,
                              activeIndexEntry({
                                ...stored,
                                leaseUntilMilliseconds: leaseUntil(
                                  atMilliseconds,
                                  stored.hardDeadlineMilliseconds,
                                ),
                              }),
                              "renew",
                            ),
                          ),
                          Effect.zipRight(
                            armControlAlarmInTx(
                              tx,
                              leaseUntil(atMilliseconds, stored.hardDeadlineMilliseconds),
                            ),
                          ),
                        );
                }),
              );
        }),
      ),
    ),
  );

/** A terminal replay is deliberately a raw-fingerprint lookup: no crypto or provider construction. */
export const readCompletedOwnerVaultControlOperation = (
  repository: OwnerVaultStorageRepository,
  expected: Omit<
    OwnerVaultControlOperationDetails,
    "receiptJTI" | "expiresAtSeconds" | "lifecycle" | "hardDeadlineMilliseconds" | "root"
  >,
): Effect.Effect<OwnerVaultControlOperationResult | undefined, unknown> =>
  transact(repository, (tx) =>
    Effect.sync(Date.now).pipe(
      Effect.flatMap((atMilliseconds) =>
        tx.get(address(expected.operationID)).pipe(
          Effect.flatMap((entry) => {
            const stored = entry === undefined ? undefined : decode(entry.payload);
            if (stored === undefined)
              return entry === undefined
                ? Effect.succeed(undefined)
                : failure<OwnerVaultControlOperationResult | undefined>();
            const same =
              stored.kind === expected.kind &&
              stored.operationID === expected.operationID &&
              stored.receiptFingerprint === expected.receiptFingerprint &&
              stored.controlDigest === expected.controlDigest &&
              stored.canonicalCommand === expected.canonicalCommand;
            if (!same) return failure<OwnerVaultControlOperationResult | undefined>();
            if (stored.state !== "COMPLETED") return Effect.succeed(undefined);
            const result = stored.result;
            if (result === undefined)
              return failure<OwnerVaultControlOperationResult | undefined>();
            return Effect.all([
              tx.get(jtiAddress(stored.receiptJTI)),
              tx.get({ category: "control-receipt-completed-index" }),
              tx.get(terminalEvidenceAddress(stored.operationID)),
            ]).pipe(
              Effect.flatMap(([jti, retention, evidence]) => {
                const claim = jti === undefined ? undefined : decodeJTI(jti.payload);
                const retentionEntries =
                  retention === undefined
                    ? undefined
                    : decodeCompletedRetentionEntries(record(retention.payload)?.entries);
                const retained = retentionEntries?.some(
                  (item) =>
                    item.operationID === stored.operationID &&
                    item.receiptJTI === stored.receiptJTI &&
                    item.expiresAtMilliseconds === stored.expiresAtSeconds * 1_000,
                );
                return !sameJTI(claim, stored) ||
                  !validTerminalEvidence(evidence?.payload, stored, result)
                  ? failure<OwnerVaultControlOperationResult | undefined>()
                  : stored.state === "COMPLETED" &&
                      retained &&
                      atMilliseconds < stored.leaseUntilMilliseconds &&
                      atMilliseconds < stored.expiresAtSeconds * 1_000
                    ? Effect.succeed(result)
                    : Effect.succeed(undefined);
              }),
            );
          }),
        ),
      ),
    ),
  );

const transact = <A>(
  repository: OwnerVaultStorageRepository,
  operation: (tx: OwnerVaultTx) => Effect.Effect<A, OwnerVaultStorageTransactionFailure>,
) => repository.transact(operation);

const decodeReconcileCursor = (value: unknown): string | null | undefined => {
  const source = record(value);
  return source !== undefined &&
    exact(source, ["nextOperationID"]) &&
    (source.nextOperationID === null ||
      (typeof source.nextOperationID === "string" && identifier.test(source.nextOperationID)))
    ? source.nextOperationID
    : undefined;
};

/** Bounded C2-only expiry cleanup. It deliberately touches only receipt rows:
 * never a snapshot pin/catalog, restore journal/page, audit, or target data. */
export const reconcileOwnerVaultControlOperations = (
  repository: OwnerVaultStorageRepository,
  atMilliseconds = Date.now(),
  limit = 8,
): Effect.Effect<number | undefined, unknown> =>
  !Number.isSafeInteger(atMilliseconds) ||
  atMilliseconds < 1 ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > ownerVaultControlOperationCohortCapacity
    ? Effect.fail(new Error("invalid control reconciliation"))
    : transact(repository, (tx) =>
        Effect.all([
          tx.get({ category: "root.admission" }),
          tx.get({ category: "control-receipt-lease-index" }),
          tx.get({ category: "control-receipt-completed-index" }),
          tx.get({ category: "control-receipt-reconcile-cursor" }),
        ]).pipe(
          Effect.flatMap(([admissionRow, leaseRow, completedRow, cursorRow]) => {
            const admission = admissionRow === undefined ? undefined : record(admissionRow.payload);
            const leases = decodeControlLeaseIndexEntries(
              record(leaseRow?.payload ?? { entries: [] })?.entries,
            );
            const completed = decodeCompletedRetentionEntries(
              record(completedRow?.payload ?? { entries: [] })?.entries,
            );
            const cursor = decodeReconcileCursor(cursorRow?.payload ?? { nextOperationID: null });
            // A vault whose root has not materialized admission-v3 can hold no
            // control operations. That is reconciled-clean, never a retry loop;
            // any stray C2 index row beside such a root is a corruption tripwire.
            if (admission !== undefined && admission.schema !== "admission-v3")
              return leaseRow === undefined && completedRow === undefined
                ? Effect.succeed<number | undefined>(undefined)
                : failure<number | undefined>();
            if (
              admission === undefined ||
              typeof admission.controlReceiptLeases !== "number" ||
              !Number.isSafeInteger(admission.controlReceiptLeases) ||
              leases === undefined ||
              completed === undefined ||
              cursor === undefined ||
              admission.controlReceiptLeases !== leases.length ||
              leases.length + completed.length > ownerVaultControlOperationCohortCapacity ||
              completed.some((entry) =>
                leases.some(
                  (lease) =>
                    lease.operationID === entry.operationID ||
                    lease.receiptJTI === entry.receiptJTI,
                ),
              )
            )
              return failure<number | undefined>();
            const candidates = [
              ...leases
                .filter((entry) => entry.hardDeadlineMilliseconds <= atMilliseconds)
                .map((entry) => ({
                  operationID: entry.operationID,
                  receiptJTI: entry.receiptJTI,
                  active: true,
                })),
              ...completed
                .filter((entry) => entry.expiresAtMilliseconds <= atMilliseconds)
                .map((entry) => ({
                  operationID: entry.operationID,
                  receiptJTI: entry.receiptJTI,
                  active: false,
                })),
            ].sort((left, right) => compareCodeUnits(left.operationID, right.operationID));
            const ordered =
              cursor === null
                ? candidates
                : [
                    ...candidates.filter((item) => item.operationID >= cursor),
                    ...candidates.filter((item) => item.operationID < cursor),
                  ];
            const selected = ordered.slice(0, limit);
            const selectedIDs = new Set(selected.map((item) => item.operationID));
            const nextLeases = leases.filter((entry) => !selectedIDs.has(entry.operationID));
            const nextCompleted = completed.filter((entry) => !selectedIDs.has(entry.operationID));
            const nextCursor =
              ordered.length > selected.length
                ? (ordered[selected.length]?.operationID ?? null)
                : null;
            const nearest = [
              ...nextLeases.map((entry) => entry.hardDeadlineMilliseconds),
              ...nextCompleted.map((entry) => entry.expiresAtMilliseconds),
            ].reduce<number | undefined>(
              (minimum, candidate) =>
                minimum === undefined ? candidate : Math.min(minimum, candidate),
              undefined,
            );
            return Effect.forEach(selected, (candidate) =>
              Effect.all([
                tx.get(address(candidate.operationID)),
                tx.get(jtiAddress(candidate.receiptJTI)),
              ]).pipe(
                Effect.flatMap(([operation, jti]) => {
                  const stored = operation === undefined ? undefined : decode(operation.payload);
                  const claim = jti === undefined ? undefined : decodeJTI(jti.payload);
                  const valid =
                    stored !== undefined &&
                    sameJTI(claim, stored) &&
                    (candidate.active
                      ? stored.state !== "COMPLETED" &&
                        stored.hardDeadlineMilliseconds <= atMilliseconds
                      : stored.state === "COMPLETED" &&
                        stored.hardDeadlineMilliseconds <= atMilliseconds);
                  return !valid
                    ? failure<void>()
                    : tx
                        .delete(address(candidate.operationID))
                        .pipe(
                          Effect.zipRight(tx.delete(jtiAddress(candidate.receiptJTI))),
                          Effect.zipRight(
                            tx.delete(terminalEvidenceAddress(candidate.operationID)),
                          ),
                        );
                }),
              ),
            ).pipe(
              Effect.zipRight(
                tx.put({ category: "control-receipt-lease-index" }, { entries: nextLeases }),
              ),
              Effect.zipRight(
                tx.put({ category: "control-receipt-completed-index" }, { entries: nextCompleted }),
              ),
              Effect.zipRight(
                tx.put(
                  { category: "control-receipt-reconcile-cursor" },
                  { nextOperationID: nextCursor },
                ),
              ),
              Effect.zipRight(
                tx.put(
                  { category: "root.admission" },
                  { ...admission, controlReceiptLeases: nextLeases.length },
                ),
              ),
              Effect.as(nearest),
            );
          }),
        ),
      );

/**
 * Post-lease recovery has no caller callback and no capability/provider
 * dependency. It accepts only the original bearer fingerprint plus exact
 * command fields, then validates operation, JTI, root, result and its closed
 * evidence in one transaction before returning the stored terminal result.
 */
export const recoverExpiredOwnerVaultControlOperation = (
  repository: OwnerVaultStorageRepository,
  expected: Omit<
    OwnerVaultControlOperationDetails,
    "receiptJTI" | "expiresAtSeconds" | "lifecycle" | "hardDeadlineMilliseconds" | "root"
  >,
): Effect.Effect<OwnerVaultControlOperationResult | undefined, unknown> =>
  transact(repository, (tx) =>
    Effect.sync(Date.now).pipe(
      Effect.flatMap((atMilliseconds) =>
        tx.get(address(expected.operationID)).pipe(
          Effect.flatMap((entry) => {
            const stored = entry === undefined ? undefined : decode(entry.payload);
            if (stored === undefined)
              return entry === undefined
                ? Effect.succeed(undefined)
                : failure<OwnerVaultControlOperationResult | undefined>();
            const same =
              stored.kind === expected.kind &&
              stored.operationID === expected.operationID &&
              stored.receiptFingerprint === expected.receiptFingerprint &&
              stored.controlDigest === expected.controlDigest &&
              stored.canonicalCommand === expected.canonicalCommand;
            if (
              !same ||
              atMilliseconds < stored.leaseUntilMilliseconds ||
              atMilliseconds >= stored.hardDeadlineMilliseconds ||
              stored.state !== "COMPLETED" ||
              stored.result === undefined
            )
              return Effect.succeed(undefined);
            const result = stored.result;
            return Effect.all([
              tx.get(jtiAddress(stored.receiptJTI)),
              tx.get({ category: "root.identity" }),
              tx.get(terminalEvidenceAddress(stored.operationID)),
              tx.get({ category: "control-receipt-completed-index" }),
            ]).pipe(
              Effect.flatMap(([jti, identity, evidence, retention]) => {
                const claim = jti === undefined ? undefined : decodeJTI(jti.payload);
                const root =
                  identity === undefined ? undefined : decodeControlRoot(identity.payload);
                const retained =
                  decodeCompletedRetentionEntries(record(retention?.payload)?.entries)?.some(
                    (item) =>
                      item.operationID === stored.operationID &&
                      item.receiptJTI === stored.receiptJTI &&
                      item.expiresAtMilliseconds === stored.expiresAtSeconds * 1_000,
                  ) === true;
                return sameJTI(claim, stored) &&
                  claim?.state === "COMPLETED" &&
                  root !== undefined &&
                  JSON.stringify(root) === JSON.stringify(stored.root) &&
                  retained &&
                  validTerminalEvidence(evidence?.payload, stored, result)
                  ? Effect.succeed(result)
                  : failure<OwnerVaultControlOperationResult | undefined>();
              }),
            );
          }),
        ),
      ),
    ),
  );

/** Claim is the only creation path: journal and PREPARED receipt commit together. */
export const claimOwnerVaultControlOperation = (
  repository: OwnerVaultStorageRepository,
  details: OwnerVaultControlOperationDetails,
  leaseID: string,
): Effect.Effect<OwnerVaultControlOperationClaim, unknown> => {
  if (!validDetails(details) || !identifier.test(leaseID))
    return Effect.fail(new Error("invalid control operation"));
  return transact(repository, (tx) =>
    Effect.sync(Date.now).pipe(
      Effect.flatMap((atMilliseconds) =>
        requireLiveRoot(tx, details).pipe(
          Effect.zipRight(
            Effect.all([
              tx.get(address(details.operationID)),
              tx.get(jtiAddress(details.receiptJTI)),
              loadControlCohortInTx(tx),
            ]),
          ),
          Effect.flatMap(([entry, jti, cohort]) => {
            const existingJTI = jti === undefined ? undefined : decodeJTI(jti.payload);
            if (entry === undefined) {
              if (details.hardDeadlineMilliseconds <= atMilliseconds)
                return failure<OwnerVaultControlOperationClaim>();
              // Any generic/expired/reclaimed JTI row without this exact control row is a collision.
              if (
                jti !== undefined ||
                existingJTI !== undefined ||
                cohort.leases.some(
                  (entry) =>
                    entry.operationID === details.operationID ||
                    entry.receiptJTI === details.receiptJTI,
                ) ||
                cohort.completed.some(
                  (entry) =>
                    entry.operationID === details.operationID ||
                    entry.receiptJTI === details.receiptJTI,
                ) ||
                cohort.leases.length + cohort.completed.length >=
                  ownerVaultControlOperationCohortCapacity
              )
                return failure<OwnerVaultControlOperationClaim>();
              const stored: StoredControlOperation = {
                ...details,
                schema: "control-operation-v2",
                state: "CLAIMED",
                leaseID,
                leaseEpoch: 1,
                leaseUntilMilliseconds: leaseUntil(
                  atMilliseconds,
                  details.hardDeadlineMilliseconds,
                ),
              };
              return tx
                .put(jtiAddress(details.receiptJTI), jtiPayload(details, "RESERVED"))
                .pipe(
                  Effect.zipRight(tx.put(address(details.operationID), asPayload(stored))),
                  Effect.zipRight(updateControlLeaseIndex(tx, activeIndexEntry(stored), "reserve")),
                  Effect.zipRight(armControlAlarmInTx(tx, stored.leaseUntilMilliseconds)),
                  Effect.as({ state: "FRESH" as const, lease: { leaseID, leaseEpoch: 1 } }),
                );
            }
            const stored = decode(entry.payload);
            if (
              stored === undefined ||
              !sameDetails(stored, details) ||
              !sameJTI(existingJTI, details)
            )
              return failure<OwnerVaultControlOperationClaim>();
            // An abandoned operation is never taken over: only a durable terminal
            // fragment may close it, and that path performs no archive/import I/O.
            if (
              stored.leaseUntilMilliseconds <= atMilliseconds ||
              stored.hardDeadlineMilliseconds <= atMilliseconds
            )
              return failure<OwnerVaultControlOperationClaim>();
            return failure<OwnerVaultControlOperationClaim>();
          }),
        ),
      ),
    ),
  );
};

/** Every durable progress write renews and verifies the exact active epoch. */
export const progressOwnerVaultControlOperation = (
  repository: OwnerVaultStorageRepository,
  details: OwnerVaultControlOperationDetails,
  lease: OwnerVaultControlOperationLease,
): Effect.Effect<void, unknown> =>
  transact(repository, (tx) => fenceOwnerVaultControlOperationInTx(tx, details, lease));

/**
 * Strict terminal fragment. The caller supplies every terminal pin/import
 * write as `fragment`; control.operation, raw jti, lease index, and the v3
 * admission count commit only if that fragment succeeds in this same native
 * transaction.
 */
export const completeOwnerVaultControlOperationInTx = (
  tx: OwnerVaultTx,
  details: OwnerVaultControlOperationDetails,
  lease: OwnerVaultControlOperationLease,
  result: OwnerVaultControlOperationResult,
  fragment: () => Effect.Effect<void, OwnerVaultStorageTransactionFailure>,
): Effect.Effect<void, OwnerVaultStorageTransactionFailure> =>
  !validResult(details.kind, result)
    ? failure<void>()
    : Effect.sync(Date.now).pipe(
        Effect.flatMap((atMilliseconds) =>
          requireLiveRoot(tx, details).pipe(
            Effect.zipRight(tx.get(address(details.operationID))),
            Effect.flatMap((entry) => {
              const stored = entry === undefined ? undefined : decode(entry.payload);
              // Completion may repair a stranded, already-terminal fragment after
              // a former split commit, but never changes ownership or resumes I/O.
              return stored === undefined ||
                !sameDetails(stored, details) ||
                stored.state === "COMPLETED" ||
                stored.leaseID !== lease.leaseID ||
                stored.leaseEpoch !== lease.leaseEpoch ||
                stored.leaseUntilMilliseconds <= atMilliseconds ||
                stored.hardDeadlineMilliseconds <= atMilliseconds
                ? failure<void>()
                : fragment().pipe(
                    Effect.zipRight(
                      tx.put(
                        terminalEvidenceAddress(details.operationID),
                        asPayload(terminalEvidence(details, result)),
                      ),
                    ),
                    Effect.zipRight(
                      tx.put(jtiAddress(details.receiptJTI), jtiPayload(details, "COMPLETED")),
                    ),
                    Effect.zipRight(
                      tx.put(address(details.operationID), {
                        ...stored,
                        state: "COMPLETED",
                        result,
                      }),
                    ),
                    Effect.zipRight(transferControlCohortSlotInTx(tx, stored, details)),
                    Effect.zipRight(armControlAlarmInTx(tx, details.expiresAtSeconds * 1_000)),
                  );
            }),
          ),
        ),
      );

/** Compatibility wrapper for non-C2 callers; terminal C2 code must use the
 * strict in-transaction primitive above with its pin/import fragment. */
export const completeOwnerVaultControlOperation = (
  repository: OwnerVaultStorageRepository,
  details: OwnerVaultControlOperationDetails,
  lease: OwnerVaultControlOperationLease,
  result: OwnerVaultControlOperationResult,
): Effect.Effect<void, unknown> =>
  transact(repository, (tx) =>
    completeOwnerVaultControlOperationInTx(tx, details, lease, result, () => Effect.void),
  );
