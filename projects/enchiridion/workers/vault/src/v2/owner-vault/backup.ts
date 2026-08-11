import { sha256Hex } from "@enchiridion/protocol";
/** @enchiridion/effect-module */
import { Effect } from "effect";
import { blobObjectKey } from "../blobs/blobs";
import { decodeOwnerVaultBlobStoredMetadata } from "../blobs/owner-vault-blob-repository";
import {
  canonicalManifestBytes,
  canonicalPageBytes,
  canonicalSignedManifestBytes,
  canonicalSnapshotRecordBytes,
  decodeCanonicalSignedManifest,
  decodeSnapshotRecordBytes,
  ownerVaultBackupControlDigest,
  ownerVaultBackupDigest,
  validOwnerVaultBackupDigest,
} from "./backup-canonical";
import {
  OwnerVaultBackupError,
  type OwnerVaultBackupManifest,
  type OwnerVaultBackupPage,
  type OwnerVaultBackupPageEntry,
  type OwnerVaultBackupRuntime,
  type OwnerVaultBackupScope,
  type OwnerVaultBackupSnapshotSource,
  type OwnerVaultPrivateRestoreTarget,
  type OwnerVaultSignedBackupManifest,
  type OwnerVaultSnapshotObject,
  type OwnerVaultSnapshotPin,
  type OwnerVaultStorageRestoreAdapterOptions,
  ownerVaultBackupFailure,
  ownerVaultBackupMaximumManifestBytes,
  ownerVaultBackupMaximumObjectBytes,
  ownerVaultBackupMaximumObjects,
  ownerVaultBackupMaximumPageBytes,
  ownerVaultBackupMaximumPageEntries,
  ownerVaultBackupMaximumRestoreJournalBytes,
  ownerVaultBackupMaximumTotalBytes,
} from "./backup-types";
import type { OwnerVaultStorageAddress } from "./repository";
import { makeOwnerVaultRestoreImport, ownerVaultRestoreImportHashChain } from "./restore-import";
import {
  isRestorableOwnerVaultStorageCategory,
  ownerVaultStorageCategories,
  ownerVaultStorageRegistry,
} from "./storage-registry";
import type { OwnerVaultStorageCategory, OwnerVaultStorageRecord } from "./storage-registry";

const encoder = new TextEncoder();
const scopeKey = (scope: OwnerVaultBackupScope): string =>
  `${scope.ownerID}/${scope.vaultID}/${scope.generationEpoch}`;
const archivePrefix = (scope: OwnerVaultBackupScope, backupID: string): string =>
  `v2/owner-vault/backups/${scopeKey(scope)}/${backupID}`;
const manifestKey = (scope: OwnerVaultBackupScope, backupID: string): string =>
  `${archivePrefix(scope, backupID)}/manifest.json`;
const pageKey = (scope: OwnerVaultBackupScope, backupID: string, ordinal: number): string =>
  `${archivePrefix(scope, backupID)}/pages/${ordinal.toString().padStart(8, "0")}.json`;
const objectKey = (scope: OwnerVaultBackupScope, backupID: string, ordinal: number): string =>
  `${archivePrefix(scope, backupID)}/objects/${ordinal.toString().padStart(8, "0")}.json`;
const safeNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const sameScope = (left: OwnerVaultBackupScope, right: OwnerVaultBackupScope): boolean =>
  left.ownerID === right.ownerID &&
  left.vaultID === right.vaultID &&
  left.generationEpoch === right.generationEpoch;
const safePathPart = /^[A-Za-z0-9_-]{1,128}$/u;
const safeBackupID = /^[A-Za-z0-9_-]{16,120}$/u;
const validScope = (scope: OwnerVaultBackupScope): boolean =>
  safePathPart.test(scope.ownerID) &&
  safePathPart.test(scope.vaultID) &&
  safeNonNegative(scope.generationEpoch) &&
  scope.generationEpoch > 0;
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const integrity = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, OwnerVaultBackupError> =>
  effect.pipe(Effect.mapError(() => new OwnerVaultBackupError({ reason: "integrity_failed" })));

const writeImmutable = (
  runtime: OwnerVaultBackupRuntime,
  key: string,
  bytes: Uint8Array,
): Effect.Effect<void, OwnerVaultBackupError> =>
  Effect.gen(function* () {
    const prior = yield* integrity(runtime.r2.head(key));
    if (prior !== undefined) {
      const read = yield* integrity(runtime.r2.read(key));
      if (
        read.size !== bytes.byteLength ||
        ownerVaultBackupDigest(read.bytes) !== ownerVaultBackupDigest(bytes)
      )
        return yield* ownerVaultBackupFailure("archive_conflict");
      return;
    }
    yield* integrity(runtime.r2.putIfAbsent(key, bytes));
  });

const checkedObject = (
  entry: OwnerVaultSnapshotObject,
): { readonly bytes: Uint8Array; readonly archive: OwnerVaultBackupPageEntry } | undefined => {
  const bytes = canonicalSnapshotRecordBytes(entry.address, entry.record);
  const category = ownerVaultStorageRegistry.get(entry.address.category);
  if (
    bytes === undefined ||
    category === undefined ||
    category.snapshot !== "include" ||
    entry.record.category !== entry.address.category ||
    !safeNonNegative(entry.ordinal) ||
    entry.size !== bytes.byteLength ||
    entry.size > ownerVaultBackupMaximumObjectBytes ||
    entry.sha256Base64 !== ownerVaultBackupDigest(bytes)
  )
    return undefined;
  if (
    entry.r2 !== undefined &&
    (entry.r2.size !== entry.size ||
      entry.r2.sha256Base64 !== entry.sha256Base64 ||
      entry.r2.key.length === 0)
  )
    return undefined;
  return {
    bytes,
    archive: {
      ordinal: entry.ordinal,
      key: "",
      sha256Base64: entry.sha256Base64,
      size: entry.size,
      category: entry.address.category,
      ...(entry.address.identifier === undefined ? {} : { identifier: entry.address.identifier }),
      ...(entry.r2 === undefined ? {} : { r2: entry.r2 }),
    },
  };
};

const validPin = (
  pin: OwnerVaultSnapshotPin,
  scope: OwnerVaultBackupScope,
  backupID: string,
): boolean =>
  validScope(scope) &&
  safeBackupID.test(backupID) &&
  pin.backupID === backupID &&
  sameScope(pin.scope, scope) &&
  validOwnerVaultBackupDigest(pin.highWaterMark) &&
  validOwnerVaultBackupDigest(pin.catalogDigest) &&
  typeof pin.pinProof === "string" &&
  /^[A-Za-z0-9_-]{16,512}$/u.test(pin.pinProof) &&
  safeNonNegative(pin.appendLogSequence) &&
  /^[a-f0-9]{64}$/u.test(pin.appendLogDigest);

/** Archives an already-pinned catalog one bounded page at a time, then signs its exact inventory. */
export const createOwnerVaultBackup = (
  source: OwnerVaultBackupSnapshotSource,
  runtime: OwnerVaultBackupRuntime,
  scope: OwnerVaultBackupScope,
  backupID: string,
): Effect.Effect<OwnerVaultSignedBackupManifest, OwnerVaultBackupError> =>
  Effect.gen(function* () {
    const pin = yield* source.beginSnapshot(scope, backupID);
    if (!validPin(pin, scope, backupID)) return yield* ownerVaultBackupFailure("catalog_invalid");
    const release = source.releaseSnapshot(pin);
    const archive = Effect.gen(function* () {
      let cursor: string | undefined;
      let pageOrdinal = 0;
      let totalBytes = 0;
      let nextOrdinal = 0;
      const pages: { ordinal: number; key: string; digest: string; count: number; size: number }[] =
        [];
      const catalogEntries: OwnerVaultBackupPageEntry[] = [];
      for (;;) {
        const sourcePage = yield* source.readSnapshotPage(pin, cursor);
        if (
          sourcePage.entries.length === 0 ||
          sourcePage.entries.length > ownerVaultBackupMaximumPageEntries ||
          sourcePage.entries.some((entry, index) => entry.ordinal !== nextOrdinal + index)
        )
          return yield* ownerVaultBackupFailure("catalog_invalid");
        const entries: OwnerVaultBackupPageEntry[] = [];
        for (const sourceEntry of sourcePage.entries) {
          const checked = checkedObject(sourceEntry);
          if (checked === undefined) return yield* ownerVaultBackupFailure("catalog_invalid");
          totalBytes += checked.bytes.byteLength;
          if (
            totalBytes > ownerVaultBackupMaximumTotalBytes ||
            nextOrdinal >= ownerVaultBackupMaximumObjects
          )
            return yield* ownerVaultBackupFailure("catalog_invalid");
          const entry = { ...checked.archive, key: objectKey(scope, backupID, nextOrdinal) };
          if (entry.ordinal !== nextOrdinal)
            return yield* ownerVaultBackupFailure("catalog_invalid");
          yield* writeImmutable(runtime, entry.key, checked.bytes);
          entries.push(entry);
          catalogEntries.push(entry);
          nextOrdinal += 1;
        }
        const page: OwnerVaultBackupPage = { ordinal: pageOrdinal, entries, digest: "" };
        const unsigned = canonicalPageBytes({ ...page, digest: "" });
        if (
          unsigned === undefined ||
          unsigned.byteLength > ownerVaultBackupMaximumPageBytes ||
          ownerVaultBackupDigest(unsigned) !== sourcePage.digest
        )
          return yield* ownerVaultBackupFailure("catalog_invalid");
        const completed: OwnerVaultBackupPage = {
          ...page,
          digest: ownerVaultBackupDigest(unsigned),
        };
        const pageBytes = canonicalPageBytes(completed);
        if (pageBytes === undefined || pageBytes.byteLength > ownerVaultBackupMaximumPageBytes)
          return yield* ownerVaultBackupFailure("catalog_invalid");
        const key = pageKey(scope, backupID, pageOrdinal);
        yield* writeImmutable(runtime, key, pageBytes);
        pages.push({
          ordinal: pageOrdinal,
          key,
          digest: completed.digest,
          count: entries.length,
          size: pageBytes.byteLength,
        });
        pageOrdinal += 1;
        if (sourcePage.nextCursor === undefined) break;
        if (sourcePage.nextCursor === cursor || sourcePage.nextCursor.length > 512)
          return yield* ownerVaultBackupFailure("catalog_invalid");
        cursor = sourcePage.nextCursor;
      }
      if (
        nextOrdinal === 0 ||
        ownerVaultBackupDigest(
          encoder.encode(JSON.stringify(catalogEntries.map(({ key, ...entry }) => entry))),
        ) !== pin.catalogDigest
      )
        return yield* ownerVaultBackupFailure("catalog_invalid");
      const manifest: OwnerVaultBackupManifest = {
        version: 1,
        backupID,
        source: scope,
        highWaterMark: pin.highWaterMark,
        appendLogSequence: pin.appendLogSequence,
        appendLogDigest: pin.appendLogDigest,
        catalogDigest: pin.catalogDigest,
        pinProof: pin.pinProof,
        totalBytes,
        objectCount: nextOrdinal,
        pages,
      };
      const canonical = canonicalManifestBytes(manifest);
      if (canonical === undefined || canonical.byteLength > ownerVaultBackupMaximumManifestBytes)
        return yield* ownerVaultBackupFailure("manifest_invalid");
      const signature = yield* runtime.signer
        .signCanonical(canonical)
        .pipe(Effect.mapError(() => new OwnerVaultBackupError({ reason: "manifest_untrusted" })));
      const signed: OwnerVaultSignedBackupManifest = { manifest, signature };
      const signedBytes = canonicalSignedManifestBytes(signed);
      if (
        signedBytes === undefined ||
        signedBytes.byteLength > ownerVaultBackupMaximumManifestBytes
      )
        return yield* ownerVaultBackupFailure("manifest_invalid");
      yield* writeImmutable(runtime, manifestKey(scope, backupID), signedBytes);
      return { signed, manifestDigest: ownerVaultBackupDigest(signedBytes) };
    });
    // Failures before completion deliberately leave the durable pin OPEN: a
    // retry reuses its exact archive namespace and immutable objects. Only an
    // explicit abort may close that namespace without a manifest.
    const completed = yield* archive;
    yield* source.completeSnapshot(pin, completed.manifestDigest);
    yield* source.releaseSnapshot(pin);
    return completed.signed;
  });

const validJournal = (
  journal: import("./backup-types").OwnerVaultRestoreJournal,
  backupID: string,
  manifestDigest: string,
): boolean =>
  journal.backupID === backupID &&
  journal.manifestDigest === manifestDigest &&
  safeNonNegative(journal.lastAppliedOrdinal) &&
  safeNonNegative(journal.appendLogSequence) &&
  /^[a-f0-9]{64}$/u.test(journal.appendLogDigest) &&
  (journal.state === "APPLYING" || journal.state === "COMPLETED") &&
  (canonicalManifestBytes({
    version: 1,
    backupID: journal.backupID,
    source: { ownerID: "journal", vaultID: "journal", generationEpoch: 1 },
    highWaterMark: manifestDigest,
    appendLogSequence: journal.appendLogSequence,
    appendLogDigest: journal.appendLogDigest,
    catalogDigest: manifestDigest,
    pinProof: journal.state,
    totalBytes: 0,
    objectCount: 0,
    pages: [],
  })?.byteLength ?? Number.POSITIVE_INFINITY) <= ownerVaultBackupMaximumRestoreJournalBytes;

const validateManifest = (
  manifest: OwnerVaultBackupManifest,
  scope: OwnerVaultBackupScope,
  backupID: string,
): boolean =>
  record(manifest) &&
  validScope(scope) &&
  safeBackupID.test(backupID) &&
  exactKeys(manifest, [
    "appendLogDigest",
    "appendLogSequence",
    "backupID",
    "catalogDigest",
    "highWaterMark",
    "objectCount",
    "pages",
    "pinProof",
    "source",
    "totalBytes",
    "version",
  ]) &&
  manifest.version === 1 &&
  manifest.backupID === backupID &&
  record(manifest.source) &&
  sameScope(manifest.source, scope) &&
  validOwnerVaultBackupDigest(manifest.highWaterMark) &&
  validOwnerVaultBackupDigest(manifest.catalogDigest) &&
  typeof manifest.pinProof === "string" &&
  /^[A-Za-z0-9_-]{16,512}$/u.test(manifest.pinProof) &&
  safeNonNegative(manifest.appendLogSequence) &&
  /^[a-f0-9]{64}$/u.test(manifest.appendLogDigest) &&
  safeNonNegative(manifest.totalBytes) &&
  safeNonNegative(manifest.objectCount) &&
  manifest.objectCount > 0 &&
  manifest.objectCount <= ownerVaultBackupMaximumObjects &&
  manifest.totalBytes <= ownerVaultBackupMaximumTotalBytes &&
  Array.isArray(manifest.pages) &&
  manifest.pages.length > 0 &&
  manifest.pages.every(
    (page, index) =>
      record(page) &&
      page.ordinal === index &&
      page.key === pageKey(scope, backupID, index) &&
      validOwnerVaultBackupDigest(page.digest) &&
      typeof page.count === "number" &&
      page.count > 0 &&
      page.count <= ownerVaultBackupMaximumPageEntries &&
      typeof page.size === "number" &&
      page.size <= ownerVaultBackupMaximumPageBytes,
  );

/** The only path from an archive-supplied category string into the closed category union. */
const storageCategory = (value: unknown): OwnerVaultStorageCategory | undefined =>
  ownerVaultStorageCategories.find((category) => category === value);

const decodePageEntry = (value: unknown): OwnerVaultBackupPageEntry | undefined => {
  if (!record(value)) return undefined;
  const category = storageCategory(value.category);
  if (
    !exactKeys(value, [
      "ordinal",
      "key",
      "sha256Base64",
      "size",
      "category",
      ...(value.identifier === undefined ? [] : ["identifier"]),
      ...(value.r2 === undefined ? [] : ["r2"]),
    ]) ||
    !safeNonNegative(value.ordinal) ||
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    typeof value.sha256Base64 !== "string" ||
    !validOwnerVaultBackupDigest(value.sha256Base64) ||
    !safeNonNegative(value.size) ||
    value.size > ownerVaultBackupMaximumObjectBytes ||
    category === undefined ||
    ownerVaultStorageRegistry.get(category) === undefined
  )
    return undefined;
  if (
    value.identifier !== undefined &&
    (typeof value.identifier !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.identifier))
  )
    return undefined;
  const base = {
    ordinal: value.ordinal,
    key: value.key,
    sha256Base64: value.sha256Base64,
    size: value.size,
    category,
    ...(value.identifier === undefined ? {} : { identifier: value.identifier }),
  };
  if (value.r2 === undefined) return base;
  if (
    !record(value.r2) ||
    !exactKeys(value.r2, ["key", "size", "sha256Base64"]) ||
    typeof value.r2.key !== "string" ||
    value.r2.key.length === 0 ||
    !safeNonNegative(value.r2.size) ||
    typeof value.r2.sha256Base64 !== "string" ||
    !validOwnerVaultBackupDigest(value.r2.sha256Base64)
  )
    return undefined;
  return {
    ...base,
    r2: { key: value.r2.key, size: value.r2.size, sha256Base64: value.r2.sha256Base64 },
  };
};

/** Restores only a pre-initialized later private target; public activation is intentionally absent. */
export const restoreOwnerVaultBackup = (
  runtime: OwnerVaultBackupRuntime,
  target: OwnerVaultPrivateRestoreTarget,
  source: OwnerVaultBackupScope,
  backupID: string,
  /** Directory control binds the signed-manifest bytes before any archive object is read. */
  expectedManifestDigest?: string,
): Effect.Effect<void, OwnerVaultBackupError> =>
  Effect.gen(function* () {
    if (
      target.root.namespaceState !== "PRIVATE" ||
      target.root.generationEpoch <= source.generationEpoch
    )
      return yield* ownerVaultBackupFailure("private_target_required");
    yield* target.assertFreshPrivateTarget();
    const bytes = yield* integrity(runtime.r2.read(manifestKey(source, backupID))).pipe(
      Effect.map((item) => item.bytes),
    );
    if (bytes.byteLength > ownerVaultBackupMaximumManifestBytes)
      return yield* ownerVaultBackupFailure("manifest_invalid");
    if (
      expectedManifestDigest !== undefined &&
      (!/^[A-Za-z0-9_-]{43}$/u.test(expectedManifestDigest) ||
        ownerVaultBackupControlDigest(bytes) !== expectedManifestDigest)
    )
      return yield* ownerVaultBackupFailure("manifest_invalid");
    const signed = decodeCanonicalSignedManifest(bytes);
    if (signed === undefined || !validateManifest(signed.manifest, source, backupID))
      return yield* ownerVaultBackupFailure("manifest_invalid");
    const canonical = canonicalManifestBytes(signed.manifest);
    if (canonical === undefined) return yield* ownerVaultBackupFailure("manifest_invalid");
    yield* runtime.verifier
      .verifyCanonical(canonical, signed.signature)
      .pipe(Effect.mapError(() => new OwnerVaultBackupError({ reason: "manifest_untrusted" })));
    const manifestDigest = ownerVaultBackupDigest(bytes);
    const staged: {
      readonly expected: import("./backup-types").OwnerVaultRestoreImportRecord;
      readonly record: OwnerVaultStorageRecord;
    }[] = [];
    const blobCopies: {
      readonly sourceKey: string;
      readonly targetKey: string;
      readonly metadata: import("../blobs/restore-reconstruction").OwnerVaultRestoredBlobMetadata;
    }[] = [];
    const evidence: import("../blobs/restore-reconstruction").OwnerVaultRestoredBlobMetadata[] = [];
    let expectedLogSequence = 1;
    for (const expected of signed.manifest.pages) {
      const pageBytes = yield* integrity(runtime.r2.read(expected.key)).pipe(
        Effect.map((item) => item.bytes),
      );
      if (
        pageBytes.byteLength !== expected.size ||
        pageBytes.byteLength > ownerVaultBackupMaximumPageBytes
      )
        return yield* ownerVaultBackupFailure("integrity_failed");
      let parsedPage: unknown;
      try {
        parsedPage = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pageBytes));
      } catch {
        return yield* ownerVaultBackupFailure("integrity_failed");
      }
      if (
        !record(parsedPage) ||
        !exactKeys(parsedPage, ["digest", "entries", "ordinal"]) ||
        !Array.isArray(parsedPage.entries) ||
        !safeNonNegative(parsedPage.ordinal) ||
        typeof parsedPage.digest !== "string"
      )
        return yield* ownerVaultBackupFailure("integrity_failed");
      const pageEntries: OwnerVaultBackupPageEntry[] = [];
      for (const candidate of parsedPage.entries) {
        const decodedEntry = decodePageEntry(candidate);
        if (decodedEntry === undefined) return yield* ownerVaultBackupFailure("integrity_failed");
        pageEntries.push(decodedEntry);
      }
      const page: OwnerVaultBackupPage = {
        ordinal: parsedPage.ordinal,
        entries: pageEntries,
        digest: parsedPage.digest,
      };
      const unsigned = canonicalPageBytes({
        ordinal: page.ordinal,
        entries: page.entries,
        digest: "",
      });
      const canonicalPage = canonicalPageBytes(page);
      if (
        unsigned === undefined ||
        canonicalPage === undefined ||
        new TextDecoder("utf-8", { fatal: true }).decode(canonicalPage) !==
          new TextDecoder("utf-8", { fatal: true }).decode(pageBytes) ||
        page.ordinal !== expected.ordinal ||
        page.entries.length !== expected.count ||
        ownerVaultBackupDigest(unsigned) !== expected.digest ||
        page.digest !== expected.digest
      )
        return yield* ownerVaultBackupFailure("integrity_failed");
      for (const entry of page.entries) {
        if (entry.category === "append-log.entry") {
          if (entry.identifier !== expectedLogSequence.toString().padStart(20, "0"))
            return yield* ownerVaultBackupFailure("integrity_failed");
          expectedLogSequence += 1;
        }
        if (
          entry.ordinal !== staged.length ||
          entry.key !== objectKey(source, backupID, entry.ordinal) ||
          entry.size > ownerVaultBackupMaximumObjectBytes ||
          !validOwnerVaultBackupDigest(entry.sha256Base64)
        )
          return yield* ownerVaultBackupFailure("integrity_failed");
        const definition = ownerVaultStorageRegistry.get(entry.category);
        if (definition === undefined || !isRestorableOwnerVaultStorageCategory(definition))
          return yield* ownerVaultBackupFailure("integrity_failed");
        const objectBytes = yield* integrity(runtime.r2.read(entry.key)).pipe(
          Effect.map((item) => item.bytes),
        );
        if (
          objectBytes.byteLength !== entry.size ||
          ownerVaultBackupDigest(objectBytes) !== entry.sha256Base64
        )
          return yield* ownerVaultBackupFailure("integrity_failed");
        if (
          entry.r2 !== undefined &&
          (entry.r2.size !== entry.size || entry.r2.sha256Base64 !== entry.sha256Base64)
        )
          return yield* ownerVaultBackupFailure("integrity_failed");
        const decoded = decodeSnapshotRecordBytes(objectBytes);
        if (
          decoded === undefined ||
          decoded.address.category !== entry.category ||
          decoded.address.identifier !== entry.identifier ||
          decoded.record.category !== entry.category
        )
          return yield* ownerVaultBackupFailure("integrity_failed");
        let restored = decoded.record;
        if (entry.category === "blob.metadata") {
          const metadata = decodeOwnerVaultBlobStoredMetadata(decoded.record);
          const targetKey =
            metadata === undefined ? undefined : blobObjectKey(target.blobScope, metadata.sha256);
          if (
            metadata === undefined ||
            targetKey === undefined ||
            metadata.size < 0 ||
            metadata.size > target.blobLimits.maximumBlobBytes
          )
            return yield* ownerVaultBackupFailure("integrity_failed");
          restored = {
            ...decoded.record,
            payload: { ...decoded.record.payload, objectKey: targetKey },
          };
          blobCopies.push({
            sourceKey: metadata.objectKey,
            targetKey,
            metadata: { ...metadata, objectKey: targetKey },
          });
        }
        const restoredBytes = canonicalSnapshotRecordBytes(decoded.address, restored);
        if (restoredBytes === undefined) return yield* ownerVaultBackupFailure("integrity_failed");
        staged.push({
          expected: {
            ordinal: entry.ordinal,
            address: decoded.address,
            version: 1,
            category: entry.category,
            codec: "owner-vault-storage-record-v1",
            sha256Base64: ownerVaultBackupDigest(restoredBytes),
            size: restoredBytes.byteLength,
          },
          record: restored,
        });
      }
    }
    if (
      staged.length !== signed.manifest.objectCount ||
      expectedLogSequence - 1 !== signed.manifest.appendLogSequence
    )
      return yield* ownerVaultBackupFailure("integrity_failed");
    const hashChain = ownerVaultRestoreImportHashChain(
      manifestDigest,
      staged.map((item) => item.expected),
    );
    if (hashChain === undefined) return yield* ownerVaultBackupFailure("integrity_failed");
    const plan: import("./backup-types").OwnerVaultRestoreImportPlan = {
      backupID,
      manifestDigest,
      source: signed.manifest.source,
      highWaterMark: signed.manifest.highWaterMark,
      appendLogSequence: signed.manifest.appendLogSequence,
      appendLogDigest: signed.manifest.appendLogDigest,
      totalBytes: staged.reduce((sum, item) => sum + item.expected.size, 0),
      objectCount: staged.length,
      hashChain,
      records: staged.map((item) => item.expected),
    };
    const completed = yield* target.restoreImport.beginRestoreImport(backupID, plan);
    if (completed !== undefined) return;
    for (const copy of blobCopies) {
      const blob = yield* integrity(runtime.r2.read(copy.sourceKey));
      if (
        blob.size !== copy.metadata.size ||
        blob.bytes.byteLength !== copy.metadata.size ||
        sha256Hex(blob.bytes) !== copy.metadata.sha256
      )
        return yield* ownerVaultBackupFailure("integrity_failed");
      const prior = yield* integrity(runtime.r2.head(copy.targetKey));
      if (prior === undefined) yield* integrity(runtime.r2.putIfAbsent(copy.targetKey, blob.bytes));
      const verified = yield* integrity(runtime.r2.read(copy.targetKey));
      if (
        verified.size !== copy.metadata.size ||
        verified.bytes.byteLength !== copy.metadata.size ||
        sha256Hex(verified.bytes) !== copy.metadata.sha256
      )
        return yield* ownerVaultBackupFailure("integrity_failed");
      evidence.push(copy.metadata);
    }
    for (const item of staged)
      yield* target.restoreImport.applyRestoreRecord({
        restoreID: backupID,
        manifestDigest,
        ...item,
      });
    yield* target.restoreImport.finalizeRestoreImport(backupID, manifestDigest, {
      blobScope: target.blobScope,
      blobLimits: target.blobLimits,
      targetBlobEvidence: evidence,
    });
  });

/** Storage adapter for a fresh initialized PRIVATE DO. It cannot enumerate or promote a target. */
export const makeOwnerVaultPrivateStorageRestoreTarget = (
  options: OwnerVaultStorageRestoreAdapterOptions,
): OwnerVaultPrivateRestoreTarget => {
  const address = (
    category: OwnerVaultStorageAddress["category"],
    identifier?: string,
  ): OwnerVaultStorageAddress =>
    identifier === undefined ? { category } : { category, identifier };
  const mapStorage = <A>(effect: Effect.Effect<A, unknown>) =>
    effect.pipe(Effect.mapError(() => new OwnerVaultBackupError({ reason: "source_unavailable" })));
  return {
    root: options.root,
    assertFreshPrivateTarget: () =>
      mapStorage(options.repository.transact((tx) => tx.get(address("root.identity")))).pipe(
        Effect.flatMap((root) =>
          root?.payload.ownerID === options.root.ownerID &&
          root.payload.vaultID === options.root.vaultID &&
          root.payload.generationEpoch === options.root.generationEpoch &&
          root.payload.namespaceState === "PRIVATE"
            ? options.assertFreshPrivateTarget()
            : ownerVaultBackupFailure("private_target_required"),
        ),
      ),
    restoreImport: makeOwnerVaultRestoreImport({
      repository: options.repository,
      reconstruct: options.reconstruct,
      validateAppendLog: options.validateAppendLog,
    }),
    blobScope: options.blobScope,
    blobLimits: options.blobLimits,
  };
};
