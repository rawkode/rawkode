/** @enchiridion/effect-module */
/**
 * C1's durable half of a restore import.  Archive verification, R2 copy/rekey
 * and decoding occur before this module; it accepts only typed records and
 * performs one bounded DO transaction per journal transition.
 */
import { Effect } from "effect";
import { reconstructOwnerVaultRestoredBlobInventory } from "../blobs/restore-reconstruction";
import {
  decodeOwnerVaultBlobReference,
  decodeOwnerVaultBlobStoredMetadata,
  decodeOwnerVaultBlobTombstone,
} from "../blobs/owner-vault-blob-repository";
import { canonicalOwnerVaultBackupBytes, canonicalSnapshotRecordBytes, ownerVaultBackupDigest, validOwnerVaultBackupDigest } from "./backup-canonical";
import { ownerVaultAppendProofValidate } from "./append-proof";
import {
  type OwnerVaultRestoreImportFinalization,
  type OwnerVaultRestoreImportPlan,
  type OwnerVaultRestoreImportReceipt,
  type OwnerVaultRestoreImportRecord,
  type OwnerVaultRestoreReconstruction,
  type OwnerVaultRestoreAppendLogValidator,
  ownerVaultBackupFailure,
  ownerVaultBackupMaximumObjectBytes,
  ownerVaultBackupMaximumObjects,
  ownerVaultBackupMaximumTotalBytes,
  OwnerVaultBackupError,
} from "./backup-types";
import { decodeOwnerVaultAppendLogEntry, type OwnerVaultAppendLogEntry } from "./domains";
import type { OwnerVaultStorageAddress, OwnerVaultStorageRepository, OwnerVaultStorageTransactionFailure, OwnerVaultTx } from "./repository";
import { isRestorableOwnerVaultStorageCategory, ownerVaultStorageRegistry, type OwnerVaultStorageRecord } from "./storage-registry";

const journalPageSize = 64;
const backupIDPattern = /^[A-Za-z0-9_-]{16,120}$/u;
const codec = "owner-vault-storage-record-v1" as const;
const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const plain = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const address = (category: OwnerVaultStorageAddress["category"], identifier?: string): OwnerVaultStorageAddress =>
  identifier === undefined ? { category } : { category, identifier };
const failure = <A = never>(reason: OwnerVaultBackupError["reason"]): Effect.Effect<A, OwnerVaultBackupError> =>
  ownerVaultBackupFailure(reason);
const txFailure = <A = never>(): Effect.Effect<A, OwnerVaultStorageTransactionFailure> =>
  Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" });
const restoreConflict = (): OwnerVaultBackupError => new OwnerVaultBackupError({ reason: "restore_conflict" });
const mapRepository = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, OwnerVaultBackupError> =>
  effect.pipe(Effect.mapError(() => restoreConflict()));

interface Header {
  readonly backupID: string;
  readonly hashChain: string;
  readonly highWaterMark: string;
  readonly kind: "header";
  readonly lastAppliedOrdinal: number;
  readonly appendLogSequence: number;
  readonly appendLogDigest: string;
  readonly manifestDigest: string;
  readonly objectCount: number;
  readonly pageCount: number;
  readonly state: "APPLYING" | "COMPLETED";
  readonly source: { readonly ownerID: string; readonly vaultID: string; readonly generationEpoch: number };
  readonly restoreID: string;
  readonly receipt?: OwnerVaultRestoreImportReceipt;
  readonly totalBytes: number;
}
interface Page {
  readonly appliedOrdinals: readonly number[];
  readonly kind: "page";
  readonly manifestDigest: string;
  readonly pageOrdinal: number;
  readonly records: readonly OwnerVaultRestoreImportRecord[];
}

const journalToken = (manifestDigest: string): string => manifestDigest.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const headerAddress = (manifestDigest: string): OwnerVaultStorageAddress => address("backup.restore-journal", `ri_${journalToken(manifestDigest)}`);
const pageAddress = (manifestDigest: string, ordinal: number): OwnerVaultStorageAddress =>
  address("backup.restore-journal", `ri_${journalToken(manifestDigest)}_${String(ordinal).padStart(4, "0")}`);

const sameAddress = (left: OwnerVaultStorageAddress, right: OwnerVaultStorageAddress): boolean =>
  left.category === right.category && left.identifier === right.identifier;
const sameRecord = (left: OwnerVaultRestoreImportRecord, right: OwnerVaultRestoreImportRecord): boolean =>
  left.ordinal === right.ordinal && sameAddress(left.address, right.address) && left.version === right.version &&
  left.category === right.category && left.codec === right.codec && left.sha256Base64 === right.sha256Base64 && left.size === right.size;

const validImportRecord = (value: OwnerVaultRestoreImportRecord): boolean => {
  const definition = ownerVaultStorageRegistry.get(value.category);
  if (!nonNegative(value.ordinal) || value.version !== 1 || value.codec !== codec ||
    !validOwnerVaultBackupDigest(value.sha256Base64) || !nonNegative(value.size) || value.size > ownerVaultBackupMaximumObjectBytes ||
    value.address.category !== value.category || definition === undefined || !isRestorableOwnerVaultStorageCategory(definition)) return false;
  try { return definition.key(value.address.identifier) !== ""; } catch { return false; }
};

const chainStep = (prior: string, item: OwnerVaultRestoreImportRecord): string | undefined => {
  const bytes = canonicalOwnerVaultBackupBytes({
    prior, ordinal: item.ordinal, category: item.category, identifier: item.address.identifier,
    version: item.version, codec: item.codec, sha256Base64: item.sha256Base64, size: item.size,
  });
  return bytes === undefined ? undefined : ownerVaultBackupDigest(bytes);
};

const strictAppendLogValidator: OwnerVaultRestoreAppendLogValidator = (input) =>
  ownerVaultAppendProofValidate(input.scope, input.entries)?.appendLogSequence === input.appendLogSequence &&
  ownerVaultAppendProofValidate(input.scope, input.entries)?.appendLogDigest === input.appendLogDigest;

export const ownerVaultRestoreImportHashChain = (
  manifestDigest: string,
  records: readonly OwnerVaultRestoreImportRecord[],
): string | undefined => {
  if (!validOwnerVaultBackupDigest(manifestDigest)) return undefined;
  let chain = manifestDigest;
  for (const item of records) {
    const next = chainStep(chain, item);
    if (next === undefined) return undefined;
    chain = next;
  }
  return chain;
};

const validPlan = (plan: OwnerVaultRestoreImportPlan): boolean => {
  if (!backupIDPattern.test(plan.backupID) || !validOwnerVaultBackupDigest(plan.manifestDigest) ||
    !validOwnerVaultBackupDigest(plan.highWaterMark) || !validOwnerVaultBackupDigest(plan.hashChain) ||
    !nonNegative(plan.appendLogSequence) || !/^[a-f0-9]{64}$/u.test(plan.appendLogDigest) ||
    plan.source.ownerID.length === 0 || plan.source.vaultID.length === 0 || !nonNegative(plan.source.generationEpoch) || plan.source.generationEpoch < 1 || !nonNegative(plan.totalBytes) || !nonNegative(plan.objectCount) ||
    plan.objectCount < 1 || plan.objectCount > ownerVaultBackupMaximumObjects || plan.records.length !== plan.objectCount ||
    plan.totalBytes > ownerVaultBackupMaximumTotalBytes || !plan.records.every((item, index) => item.ordinal === index && validImportRecord(item))) return false;
  const total = plan.records.reduce((sum, item) => sum + item.size, 0);
  return Number.isSafeInteger(total) && total === plan.totalBytes &&
    ownerVaultRestoreImportHashChain(plan.manifestDigest, plan.records) === plan.hashChain;
};

const headerFor = (restoreID: string, plan: OwnerVaultRestoreImportPlan): Header => ({
  kind: "header", restoreID, backupID: plan.backupID, manifestDigest: plan.manifestDigest, source: plan.source, highWaterMark: plan.highWaterMark,
  appendLogSequence: plan.appendLogSequence, appendLogDigest: plan.appendLogDigest, totalBytes: plan.totalBytes, objectCount: plan.objectCount,
  hashChain: plan.hashChain, pageCount: Math.ceil(plan.objectCount / journalPageSize), lastAppliedOrdinal: -1, state: "APPLYING",
});
const pagesFor = (plan: OwnerVaultRestoreImportPlan): readonly Page[] =>
  Array.from({ length: Math.ceil(plan.records.length / journalPageSize) }, (_, pageOrdinal) => ({
    kind: "page" as const, manifestDigest: plan.manifestDigest, pageOrdinal,
    records: plan.records.slice(pageOrdinal * journalPageSize, (pageOrdinal + 1) * journalPageSize), appliedOrdinals: [],
  }));
const sameHeaderPlan = (header: Header, restoreID: string, plan: OwnerVaultRestoreImportPlan): boolean =>
  header.restoreID === restoreID && header.backupID === plan.backupID && header.manifestDigest === plan.manifestDigest && header.highWaterMark === plan.highWaterMark &&
  header.appendLogSequence === plan.appendLogSequence && header.appendLogDigest === plan.appendLogDigest &&
  header.source.ownerID === plan.source.ownerID && header.source.vaultID === plan.source.vaultID && header.source.generationEpoch === plan.source.generationEpoch && header.totalBytes === plan.totalBytes && header.objectCount === plan.objectCount &&
  header.hashChain === plan.hashChain && header.pageCount === Math.ceil(plan.objectCount / journalPageSize);

const digestCanonical = (value: unknown): string | undefined => {
  const bytes = canonicalOwnerVaultBackupBytes(value);
  return bytes === undefined ? undefined : ownerVaultBackupDigest(bytes);
};
const validReceipt = (value: unknown): value is OwnerVaultRestoreImportReceipt => {
  const receipt = plain(value);
  const targetRoot = receipt === undefined ? undefined : plain(receipt.targetRoot);
  return receipt !== undefined && targetRoot !== undefined && exact(receipt, ["accountingProof", "appendLogDigest", "appendLogSequence", "blobProof", "finalizationProof", "inventoryDigest", "manifestDigest", "outcome", "restoreID", "securityFloor", "targetCatalogProof", "targetRoot"]) &&
    receipt.outcome === "COMPLETED" && typeof receipt.restoreID === "string" && backupIDPattern.test(receipt.restoreID) &&
    typeof receipt.manifestDigest === "string" && validOwnerVaultBackupDigest(receipt.manifestDigest) &&
    typeof receipt.inventoryDigest === "string" && validOwnerVaultBackupDigest(receipt.inventoryDigest) &&
    typeof receipt.targetCatalogProof === "string" && validOwnerVaultBackupDigest(receipt.targetCatalogProof) &&
    typeof receipt.accountingProof === "string" && validOwnerVaultBackupDigest(receipt.accountingProof) &&
    typeof receipt.blobProof === "string" && validOwnerVaultBackupDigest(receipt.blobProof) &&
    typeof receipt.finalizationProof === "string" && validOwnerVaultBackupDigest(receipt.finalizationProof) &&
    nonNegative(receipt.appendLogSequence) && typeof receipt.appendLogDigest === "string" && /^[a-f0-9]{64}$/u.test(receipt.appendLogDigest) &&
    nonNegative(receipt.securityFloor) && exact(targetRoot, ["generationEpoch", "namespaceState", "ownerID", "vaultID"]) &&
    typeof targetRoot.ownerID === "string" && typeof targetRoot.vaultID === "string" && nonNegative(targetRoot.generationEpoch) && targetRoot.generationEpoch >= 1 &&
    (targetRoot.namespaceState === "PRIVATE" || targetRoot.namespaceState === "ACTIVE");
};

const decodeImportRecord = (value: unknown): OwnerVaultRestoreImportRecord | undefined => {
  const item = plain(value); const itemAddress = item === undefined ? undefined : plain(item.address);
  if (item === undefined || itemAddress === undefined || !exact(item, ["address", "category", "codec", "ordinal", "sha256Base64", "size", "version"]) ||
    !exact(itemAddress, itemAddress.identifier === undefined ? ["category"] : ["category", "identifier"]) || typeof item.category !== "string" ||
    (itemAddress.identifier !== undefined && typeof itemAddress.identifier !== "string") || typeof item.ordinal !== "number" || typeof item.size !== "number" ||
    typeof item.sha256Base64 !== "string" || item.version !== 1 || item.codec !== codec) return undefined;
  const decoded: OwnerVaultRestoreImportRecord = {
    ordinal: item.ordinal, address: itemAddress.identifier === undefined ? address(itemAddress.category as OwnerVaultStorageAddress["category"]) : address(itemAddress.category as OwnerVaultStorageAddress["category"], itemAddress.identifier),
    version: 1, category: item.category as OwnerVaultStorageAddress["category"], codec, sha256Base64: item.sha256Base64, size: item.size,
  };
  return validImportRecord(decoded) ? decoded : undefined;
};
const decodeHeader = (value: unknown): Header | undefined => {
  const item = plain(value);
  if (item === undefined || !exact(item, ["appendLogDigest", "appendLogSequence", "backupID", "hashChain", "highWaterMark", "kind", "lastAppliedOrdinal", "manifestDigest", "objectCount", "pageCount", "restoreID", "source", "state", "totalBytes", ...(item.receipt === undefined ? [] : ["receipt"])]) ||
    item.kind !== "header" || typeof item.backupID !== "string" || typeof item.manifestDigest !== "string" || typeof item.highWaterMark !== "string" ||
    typeof item.restoreID !== "string" || !backupIDPattern.test(item.restoreID) || typeof item.hashChain !== "string" || !Number.isSafeInteger(item.lastAppliedOrdinal) || (item.lastAppliedOrdinal as number) < -1 || !nonNegative(item.appendLogSequence) || typeof item.appendLogDigest !== "string" || !/^[a-f0-9]{64}$/u.test(item.appendLogDigest) || !nonNegative(item.objectCount) ||
    !nonNegative(item.pageCount) || !nonNegative(item.totalBytes) || (item.state !== "APPLYING" && item.state !== "COMPLETED")) return undefined;
  const header = item as unknown as Header;
  return backupIDPattern.test(header.backupID) && validOwnerVaultBackupDigest(header.manifestDigest) && validOwnerVaultBackupDigest(header.highWaterMark) && plain(header.source) !== undefined &&
    typeof header.source.ownerID === "string" && typeof header.source.vaultID === "string" && nonNegative(header.source.generationEpoch) && header.source.generationEpoch >= 1 &&
    validOwnerVaultBackupDigest(header.hashChain) && header.objectCount >= 1 && header.objectCount <= ownerVaultBackupMaximumObjects &&
    header.pageCount === Math.ceil(header.objectCount / journalPageSize) && header.lastAppliedOrdinal < header.objectCount && header.totalBytes <= ownerVaultBackupMaximumTotalBytes &&
    (header.state === "APPLYING" ? header.receipt === undefined : validReceipt(header.receipt)) ? header : undefined;
};
const decodePage = (value: unknown, manifestDigest: string, pageOrdinal: number): Page | undefined => {
  const item = plain(value);
  if (item === undefined || !exact(item, ["appliedOrdinals", "kind", "manifestDigest", "pageOrdinal", "records"]) || item.kind !== "page" ||
    item.manifestDigest !== manifestDigest || item.pageOrdinal !== pageOrdinal || !Array.isArray(item.records) || !Array.isArray(item.appliedOrdinals)) return undefined;
  const records = item.records.map(decodeImportRecord);
  if (records.some((record) => record === undefined)) return undefined;
  const applied = item.appliedOrdinals;
  return applied.every(nonNegative) && new Set(applied).size === applied.length
    ? { kind: "page", manifestDigest, pageOrdinal, records: records as OwnerVaultRestoreImportRecord[], appliedOrdinals: applied }
    : undefined;
};

const readHeader = (tx: OwnerVaultTx, restoreID: string): Effect.Effect<Header, OwnerVaultStorageTransactionFailure> =>
  tx.get(headerAddress(restoreID)).pipe(Effect.flatMap((stored) => {
    const decoded = decodeHeader(stored?.payload);
    return decoded === undefined ? txFailure() : Effect.succeed(decoded);
  }));
const readPage = (tx: OwnerVaultTx, restoreID: string, manifestDigest: string, ordinal: number): Effect.Effect<Page, OwnerVaultStorageTransactionFailure> =>
  tx.get(pageAddress(restoreID, ordinal)).pipe(Effect.flatMap((stored) => {
    const decoded = decodePage(stored?.payload, manifestDigest, ordinal);
    return decoded === undefined ? txFailure() : Effect.succeed(decoded);
  }));
const write = (tx: OwnerVaultTx, destination: OwnerVaultStorageAddress, payload: Readonly<Record<string, unknown>>): Effect.Effect<void, OwnerVaultStorageTransactionFailure> =>
  tx.put(destination, payload);

const restoreAudit = (plan: OwnerVaultRestoreImportPlan): Readonly<Record<string, unknown>> => ({
  source: plan.source,
  audit: { backupID: plan.backupID, manifestDigest: plan.manifestDigest },
});
const matchesRestoreAudit = (value: unknown, plan: OwnerVaultRestoreImportPlan): boolean => {
  const payload = plain(value); const source = payload === undefined ? undefined : plain(payload.source); const audit = payload === undefined ? undefined : plain(payload.audit);
  return source?.ownerID === plan.source.ownerID && source.vaultID === plan.source.vaultID && source.generationEpoch === plan.source.generationEpoch &&
    audit?.backupID === plan.backupID && audit.manifestDigest === plan.manifestDigest;
};

const freshPrivate = (tx: OwnerVaultTx): Effect.Effect<void, OwnerVaultStorageTransactionFailure> =>
  Effect.all([tx.get(address("root.identity")), tx.get(address("catalog.current"))]).pipe(
    Effect.flatMap(([identity, current]) => {
      const root = plain(identity?.payload); const catalog = plain(current?.payload);
      return root?.namespaceState === "PRIVATE" && catalog?.catalogRevision === 0 ? Effect.void : txFailure();
    }),
  );

const targetScopeMatches = (root: unknown, finalization: OwnerVaultRestoreImportFinalization): boolean => {
  const identity = plain(root);
  return identity?.namespaceState === "PRIVATE" &&
    finalization.blobScope.ownerID.value === identity.ownerID &&
    finalization.blobScope.vaultID.value === identity.vaultID &&
    finalization.blobScope.generationEpoch === identity.generationEpoch;
};

const completedReceipt = (
  header: Header,
  root: unknown,
  floors: unknown,
  accounting: unknown,
  finalization: OwnerVaultRestoreImportFinalization,
): OwnerVaultRestoreImportReceipt | undefined => {
  const targetRoot = plain(root); const floor = plain(floors);
  if (targetRoot === undefined || !exact(targetRoot, ["generationEpoch", "namespaceState", "ownerID", "vaultID"]) ||
    typeof targetRoot.ownerID !== "string" || typeof targetRoot.vaultID !== "string" || !nonNegative(targetRoot.generationEpoch) ||
    (targetRoot.namespaceState !== "PRIVATE" && targetRoot.namespaceState !== "ACTIVE") || floor === undefined || !exact(floor, ["securityFloor"]) || !nonNegative(floor.securityFloor)) return undefined;
  const accountingProof = digestCanonical(accounting);
  const blobProof = digestCanonical(finalization.targetBlobEvidence);
  const finalizationProof = digestCanonical({ blobLimits: finalization.blobLimits, blobScope: finalization.blobScope, targetBlobEvidence: finalization.targetBlobEvidence });
  const targetCatalogProof = digestCanonical({ highWaterMark: header.highWaterMark, inventoryDigest: header.hashChain, objectCount: header.objectCount });
  return accountingProof === undefined || blobProof === undefined || finalizationProof === undefined || targetCatalogProof === undefined ? undefined : {
    restoreID: header.restoreID, outcome: "COMPLETED", targetRoot: targetRoot as unknown as OwnerVaultRestoreImportReceipt["targetRoot"], securityFloor: floor.securityFloor,
    manifestDigest: header.manifestDigest, inventoryDigest: header.hashChain, appendLogSequence: header.appendLogSequence, appendLogDigest: header.appendLogDigest,
    targetCatalogProof, accountingProof, blobProof, finalizationProof,
  };
};
const matchesCompletedTarget = (receipt: OwnerVaultRestoreImportReceipt, root: unknown, floors: unknown): boolean => {
  const identity = plain(root); const floor = plain(floors); const target = receipt.targetRoot;
  return identity !== undefined && floor !== undefined &&
    identity.ownerID === target.ownerID && identity.vaultID === target.vaultID && identity.generationEpoch === target.generationEpoch && identity.namespaceState === target.namespaceState &&
    floor.securityFloor === receipt.securityFloor;
};

const sameBlobEvidence = (
  left: { readonly sha256: string; readonly requestID: string; readonly path: string; readonly size: number; readonly objectKey: string },
  right: { readonly sha256: string; readonly requestID: string; readonly path: string; readonly size: number; readonly objectKey: string },
): boolean => left.sha256 === right.sha256 && left.requestID === right.requestID && left.path === right.path && left.size === right.size && left.objectKey === right.objectKey;

const deriveBlobInventory = (
  rows: readonly { readonly inventory: OwnerVaultRestoreImportRecord; readonly record: OwnerVaultStorageRecord }[],
  finalization: OwnerVaultRestoreImportFinalization,
) => {
  const metadata: { sha256: string; requestID: string; path: string; size: number; objectKey: string }[] = [];
  const references: { sha256: string; reference: NonNullable<ReturnType<typeof decodeOwnerVaultBlobReference>> }[] = [];
  const tombstones: { sha256: string; tombstone: NonNullable<ReturnType<typeof decodeOwnerVaultBlobTombstone>> }[] = [];
  for (const row of rows) {
    const sha256 = row.inventory.address.identifier;
    if (sha256 === undefined) return undefined;
    if (row.inventory.category === "blob.metadata") {
      const decoded = decodeOwnerVaultBlobStoredMetadata(row.record);
      if (decoded === undefined || decoded.sha256 !== sha256) return undefined;
      metadata.push(decoded);
    } else if (row.inventory.category === "blob.reference") {
      const decoded = decodeOwnerVaultBlobReference(row.record);
      if (decoded === undefined) return undefined;
      references.push({ sha256, reference: decoded });
    } else if (row.inventory.category === "blob.tombstone") {
      const decoded = decodeOwnerVaultBlobTombstone(row.record);
      if (decoded === undefined) return undefined;
      tombstones.push({ sha256, tombstone: decoded });
    }
  }
  const sortedMetadata = metadata.sort((left, right) => left.sha256.localeCompare(right.sha256));
  const evidence = [...finalization.targetBlobEvidence].sort((left, right) => left.sha256.localeCompare(right.sha256));
  return sortedMetadata.length === evidence.length && sortedMetadata.every((item, index) => sameBlobEvidence(item, evidence[index]!)) &&
    new Set(sortedMetadata.map((item) => item.sha256)).size === sortedMetadata.length &&
    new Set(evidence.map((item) => item.sha256)).size === evidence.length
    ? { metadata: sortedMetadata, references, tombstones }
    : undefined;
};

const deriveAppendLog = (
  rows: readonly { readonly inventory: OwnerVaultRestoreImportRecord; readonly record: OwnerVaultStorageRecord }[],
  appendLogSequence: number,
): readonly OwnerVaultAppendLogEntry[] | undefined => {
  const entries: OwnerVaultAppendLogEntry[] = [];
  for (const row of rows) {
    if (row.inventory.category !== "append-log.entry") continue;
    const entry = decodeOwnerVaultAppendLogEntry(row.record.payload);
    const identifier = row.inventory.address.identifier;
    if (entry === undefined || identifier !== String(entry.logSequence).padStart(20, "0")) return undefined;
    entries.push(entry);
  }
  const ordered = entries.sort((left, right) => left.logSequence - right.logSequence);
  return ordered.length === appendLogSequence && ordered.every((entry, index) => entry.logSequence === index + 1) ? ordered : undefined;
};

export interface OwnerVaultRestoreImport {
  readonly beginRestoreImport: (restoreID: string, plan: OwnerVaultRestoreImportPlan) => Effect.Effect<OwnerVaultRestoreImportReceipt | undefined, OwnerVaultBackupError>;
  readonly applyRestoreRecord: (input: {
    readonly restoreID: string;
    readonly manifestDigest: string;
    readonly expected: OwnerVaultRestoreImportRecord;
    readonly record: OwnerVaultStorageRecord;
  }) => Effect.Effect<OwnerVaultRestoreImportReceipt | undefined, OwnerVaultBackupError>;
  readonly finalizeRestoreImport: (
    restoreID: string,
    manifestDigest: string,
    finalization: OwnerVaultRestoreImportFinalization,
  ) => Effect.Effect<OwnerVaultRestoreImportReceipt, OwnerVaultBackupError>;
}

export const makeOwnerVaultRestoreImport = (options: {
  readonly repository: OwnerVaultStorageRepository;
  readonly reconstruct?: OwnerVaultRestoreReconstruction;
  readonly validateAppendLog?: OwnerVaultRestoreAppendLogValidator;
}): OwnerVaultRestoreImport => {
  const reconstruct = options.reconstruct ?? reconstructOwnerVaultRestoredBlobInventory;
  const validateAppendLog = options.validateAppendLog ?? strictAppendLogValidator;
  return Object.freeze({
    beginRestoreImport: (restoreID: string, plan: OwnerVaultRestoreImportPlan) => {
      if (!backupIDPattern.test(restoreID) || !validPlan(plan)) return failure("manifest_invalid");
      const header = headerFor(restoreID, plan); const pages = pagesFor(plan);
      return options.repository.transact((tx) =>
        tx.get(headerAddress(restoreID)).pipe(Effect.flatMap((existing) => {
          const prior = existing === undefined ? undefined : decodeHeader(existing.payload);
          if (prior !== undefined) {
            if (!sameHeaderPlan(prior, restoreID, plan)) return txFailure();
            return tx.get(address("audit.restore-source")).pipe(Effect.flatMap((audit) => {
              if (!matchesRestoreAudit(audit?.payload, plan)) return txFailure();
              if (prior.state !== "COMPLETED" || prior.receipt === undefined) return Effect.succeed(undefined);
              return Effect.all([tx.get(address("root.identity")), tx.get(address("root.floors"))]).pipe(
              Effect.flatMap(([identity, floors]) => matchesCompletedTarget(prior.receipt!, identity?.payload, floors?.payload) ? Effect.succeed(prior.receipt) : txFailure()),
              );
            }));
          }
          return freshPrivate(tx).pipe(Effect.zipRight(write(tx, headerAddress(restoreID), header as unknown as Readonly<Record<string, unknown>>)),
            Effect.zipRight(Effect.forEach(pages, (page) => write(tx, pageAddress(restoreID, page.pageOrdinal), page as unknown as Readonly<Record<string, unknown>>))),
            Effect.zipRight(write(tx, address("audit.restore-source"), restoreAudit(plan))),
            Effect.as(undefined),
          );
        })),
      ).pipe(mapRepository);
    },
    applyRestoreRecord: (input: { readonly restoreID: string; readonly manifestDigest: string; readonly expected: OwnerVaultRestoreImportRecord; readonly record: OwnerVaultStorageRecord }) => {
      if (!validOwnerVaultBackupDigest(input.manifestDigest) || !validImportRecord(input.expected) || input.record.category !== input.expected.category || input.record.version !== 1)
        return failure("integrity_failed");
      const restoreID = input.restoreID;
      return options.repository.transact((tx) => readHeader(tx, restoreID).pipe(Effect.flatMap((header) => {
        if (header.manifestDigest !== input.manifestDigest) return txFailure();
        const pageOrdinal = Math.floor(input.expected.ordinal / journalPageSize);
        return readPage(tx, restoreID, input.manifestDigest, pageOrdinal).pipe(Effect.flatMap((page) => {
          const planned = page.records.find((candidate) => candidate.ordinal === input.expected.ordinal);
          if (planned === undefined || !sameRecord(planned, input.expected)) return txFailure();
          const bytes = canonicalSnapshotRecordBytes(planned.address, input.record);
          if (bytes === undefined || bytes.byteLength !== planned.size || ownerVaultBackupDigest(bytes) !== planned.sha256Base64) return txFailure();
          if (header.state === "COMPLETED" || input.expected.ordinal <= header.lastAppliedOrdinal) {
            return tx.get(planned.address).pipe(Effect.flatMap((stored) => {
              const previous = stored === undefined ? undefined : canonicalSnapshotRecordBytes(planned.address, stored);
              return previous !== undefined && previous.byteLength === planned.size && ownerVaultBackupDigest(previous) === planned.sha256Base64 && page.appliedOrdinals.includes(planned.ordinal)
                ? Effect.succeed(header.receipt) : txFailure();
            }));
          }
          if (input.expected.ordinal !== header.lastAppliedOrdinal + 1) return txFailure();
          const nextPage: Page = { ...page, appliedOrdinals: [...page.appliedOrdinals, planned.ordinal] };
          const nextHeader: Header = { ...header, lastAppliedOrdinal: planned.ordinal };
          if (header.state !== "APPLYING") return txFailure();
          return tx.putRestoreImport(planned.address, input.record.payload).pipe(
            Effect.zipRight(write(tx, pageAddress(restoreID, pageOrdinal), nextPage as unknown as Readonly<Record<string, unknown>>)),
            Effect.zipRight(write(tx, headerAddress(restoreID), nextHeader as unknown as Readonly<Record<string, unknown>>)),
            Effect.as(undefined),
          );
        }));
      }))).pipe(mapRepository);
    },
    finalizeRestoreImport: (restoreID: string, manifestDigest: string, finalization: OwnerVaultRestoreImportFinalization) => {
      if (!backupIDPattern.test(restoreID) || !validOwnerVaultBackupDigest(manifestDigest)) return failure("manifest_invalid");
      return options.repository.transact((tx) => readHeader(tx, restoreID).pipe(Effect.flatMap((header) => {
        if (header.manifestDigest !== manifestDigest) return txFailure();
        if (header.state === "COMPLETED") {
          const proof = digestCanonical({ blobLimits: finalization.blobLimits, blobScope: finalization.blobScope, targetBlobEvidence: finalization.targetBlobEvidence });
          if (header.receipt === undefined || proof !== header.receipt.finalizationProof) return txFailure();
          return Effect.all([tx.get(address("root.identity")), tx.get(address("root.floors"))]).pipe(
            Effect.flatMap(([identity, floors]) => matchesCompletedTarget(header.receipt!, identity?.payload, floors?.payload) ? Effect.succeed(header.receipt!) : txFailure()),
          );
        }
        if (header.lastAppliedOrdinal !== header.objectCount - 1) return txFailure();
        return tx.get(address("root.identity")).pipe(Effect.flatMap((identity) => {
          if (!targetScopeMatches(identity?.payload, finalization)) return txFailure();
          return Effect.forEach(Array.from({ length: header.pageCount }, (_, ordinal) => ordinal), (ordinal) => readPage(tx, restoreID, manifestDigest, ordinal)).pipe(
          Effect.flatMap((pages) => {
            const records = pages.flatMap((page) => page.records);
            if (records.length !== header.objectCount || !records.every((item, index) => item.ordinal === index && validImportRecord(item)) ||
              pages.some((page) => page.appliedOrdinals.length !== page.records.length || !page.records.every((item) => page.appliedOrdinals.includes(item.ordinal))) ||
              records.reduce((sum, item) => sum + item.size, 0) !== header.totalBytes || ownerVaultRestoreImportHashChain(header.manifestDigest, records) !== header.hashChain)
              return txFailure();
            return Effect.forEach(records, (item) => tx.get(item.address).pipe(Effect.flatMap((stored) => {
              const bytes = stored === undefined ? undefined : canonicalSnapshotRecordBytes(item.address, stored);
              return bytes === undefined || stored === undefined || bytes.byteLength !== item.size || ownerVaultBackupDigest(bytes) !== item.sha256Base64
                ? txFailure()
                : Effect.succeed({ inventory: item, record: stored });
            }))).pipe(
              Effect.flatMap((storedRows) => {
                const log = deriveAppendLog(storedRows, header.appendLogSequence);
                const blobs = deriveBlobInventory(storedRows, finalization);
                return log === undefined || blobs === undefined || !validateAppendLog({ scope: header.source, entries: log, appendLogSequence: header.appendLogSequence, appendLogDigest: header.appendLogDigest })
                  ? txFailure()
                  : Effect.sync(() => reconstruct(finalization.blobScope, finalization.blobLimits, blobs));
              }),
              Effect.flatMap((reconstructed) => reconstructed._tag === "OwnerVaultBlobRestoreReconstructionSuccess" ? Effect.succeed(reconstructed.value) : txFailure()),
              Effect.flatMap((reconstructed) =>
                tx.get(address("root.floors")).pipe(
                  Effect.flatMap((floors) => {
                    const receipt = completedReceipt(header, identity?.payload, floors?.payload, reconstructed.accounting, finalization);
                    if (receipt === undefined) return txFailure();
                    return write(tx, address("blob.accounting"), reconstructed.accounting as unknown as Readonly<Record<string, unknown>>).pipe(
                      Effect.zipRight(write(tx, address("root.log-head"), { appendLogSequence: header.appendLogSequence, appendLogDigest: header.appendLogDigest })),
                      Effect.zipRight(write(tx, address("append-log.head"), { appendLogSequence: header.appendLogSequence, appendLogDigest: header.appendLogDigest })),
                      Effect.zipRight(tx.publishRestoreImport(records.map((item) => item.address))),
                      Effect.zipRight(write(tx, headerAddress(restoreID), { ...header, state: "COMPLETED", receipt } as unknown as Readonly<Record<string, unknown>>)),
                      Effect.as(receipt),
                    );
                  }),
                ),
              ),
            );
          }),
          );
        }));
      }))).pipe(mapRepository);
    },
  });
};
