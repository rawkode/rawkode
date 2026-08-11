/** @enchiridion/effect-module */
import { protocolVersion } from "@enchiridion/protocol";
import { Effect } from "effect";
import {
  backupArchivePrefix,
  backupManifestKey,
  backupObjectKey,
  canonicalManifestBytes,
  canonicalSHA256Base64,
  canonicalSignedManifestBytes,
  catalogDigest,
  compareUTF16,
  decodeSignedBackupManifest,
  isCanonicalSHA256Base64,
  validBackupScope,
} from "./canonical";
import {
  BackupError,
  type BackupLimits,
  type BackupManifest,
  type BackupManifestObject,
  type BackupObjectKind,
  BackupRecoveryRepository,
  BackupRuntime,
  type BackupScope,
  type BackupSnapshot,
  BackupSnapshotSource,
  type SignedBackupManifest,
  backupFailure,
  defaultBackupLimits,
} from "./types";

const safeInteger = (value: number, minimum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum;

const validLimits = (limits: BackupLimits): boolean =>
  safeInteger(limits.maximumObjects, 1) &&
  safeInteger(limits.maximumObjectBytes, 1) &&
  safeInteger(limits.maximumTotalObjectBytes, 1) &&
  safeInteger(limits.maximumManifestBytes, 1) &&
  safeInteger(limits.maximumObjectKeyBytes, 1) &&
  safeInteger(limits.maximumManifestLifetimeMilliseconds, 1);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const backupObjectKind = (value: unknown): BackupObjectKind | undefined => {
  switch (value) {
    case "blob":
    case "device":
    case "document":
    case "receipt":
    case "session":
    case "tombstone":
      return value;
    default:
      return undefined;
  }
};

const ownedScope = (scope: BackupScope): BackupScope | undefined => {
  if (!validBackupScope(scope)) return undefined;
  return Object.freeze({
    ownerID: scope.ownerID,
    vaultID: scope.vaultID,
    generationEpoch: scope.generationEpoch,
  });
};

const ownedLimits = (limits: BackupLimits): BackupLimits =>
  Object.freeze({
    maximumObjects: limits.maximumObjects,
    maximumObjectBytes: limits.maximumObjectBytes,
    maximumTotalObjectBytes: limits.maximumTotalObjectBytes,
    maximumManifestBytes: limits.maximumManifestBytes,
    maximumObjectKeyBytes: limits.maximumObjectKeyBytes,
    maximumManifestLifetimeMilliseconds: limits.maximumManifestLifetimeMilliseconds,
  });

interface BackupArchivePlan {
  readonly catalogDigest: string;
  readonly controlEpoch: number;
  readonly credentialEpoch: number;
  readonly generationEpoch: number;
  readonly highWaterMark: string;
  readonly objects: readonly {
    readonly bytes: Uint8Array;
    readonly record: BackupManifestObject;
  }[];
  readonly records: readonly BackupManifestObject[];
  readonly routingEpoch: number;
}

/**
 * Captures and validates the complete source boundary synchronously. Every byte
 * hashed or sent to R2 is private to this plan; no caller-owned array, record,
 * list, scope, or limits object remains reachable once an Effect can suspend.
 */
const prepareArchivePlan = (
  snapshot: BackupSnapshot,
  scope: BackupScope,
  backupID: string,
  limits: BackupLimits,
): BackupArchivePlan | undefined => {
  if (!record(snapshot) || !Array.isArray(snapshot.objects)) return undefined;
  const {
    catalogDigest: capturedCatalogDigest,
    controlEpoch,
    credentialEpoch,
    generationEpoch,
    highWaterMark,
    routingEpoch,
  } = snapshot;
  const sourceObjects = [...snapshot.objects];
  if (
    generationEpoch !== scope.generationEpoch ||
    typeof highWaterMark !== "string" ||
    !isCanonicalSHA256Base64(highWaterMark) ||
    !safeInteger(routingEpoch, 0) ||
    !safeInteger(controlEpoch, 0) ||
    !safeInteger(credentialEpoch, 0) ||
    typeof capturedCatalogDigest !== "string" ||
    !isCanonicalSHA256Base64(capturedCatalogDigest) ||
    sourceObjects.length === 0 ||
    sourceObjects.length > limits.maximumObjects
  )
    return undefined;
  const objects: {
    readonly bytes: Uint8Array;
    readonly record: BackupManifestObject;
  }[] = [];
  const seenKeys = new Set<string>();
  let totalObjectBytes = 0;
  for (const sourceObject of sourceObjects) {
    if (!record(sourceObject)) return undefined;
    const { bytes: sourceBytes, kind, sourceID } = sourceObject;
    const parsedKind = backupObjectKind(kind);
    if (
      parsedKind === undefined ||
      typeof sourceID !== "string" ||
      !(sourceBytes instanceof Uint8Array)
    )
      return undefined;
    const bytes = new Uint8Array(sourceBytes);
    const key = backupObjectKey(scope, backupID, parsedKind, sourceID);
    if (
      key === undefined ||
      new TextEncoder().encode(key).byteLength > limits.maximumObjectKeyBytes ||
      bytes.byteLength > limits.maximumObjectBytes ||
      seenKeys.has(key)
    )
      return undefined;
    totalObjectBytes += bytes.byteLength;
    if (totalObjectBytes > limits.maximumTotalObjectBytes) return undefined;
    seenKeys.add(key);
    const item: BackupManifestObject = Object.freeze({
      kind: parsedKind,
      key,
      size: bytes.byteLength,
      sha256Base64: canonicalSHA256Base64(bytes),
    });
    objects.push(Object.freeze({ bytes, record: item }));
  }
  const records = Object.freeze(
    objects.map((object) => object.record).sort((left, right) => compareUTF16(left.key, right.key)),
  );
  if (capturedCatalogDigest !== catalogDigest(records)) return undefined;
  return Object.freeze({
    catalogDigest: capturedCatalogDigest,
    controlEpoch,
    credentialEpoch,
    generationEpoch,
    highWaterMark,
    objects: Object.freeze(objects),
    records,
    routingEpoch,
  });
};

const sameScope = (left: BackupScope, right: BackupScope): boolean =>
  left.ownerID.value === right.ownerID.value &&
  left.vaultID.value === right.vaultID.value &&
  left.generationEpoch === right.generationEpoch;

const objectMatches = (object: BackupManifestObject, bytes: Uint8Array): boolean =>
  object.size === bytes.byteLength && object.sha256Base64 === canonicalSHA256Base64(bytes);

const r2Integrity = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, BackupError> =>
  effect.pipe(Effect.mapError(() => new BackupError({ reason: "integrity_failed" })));

const matchesBytes = (bytes: Uint8Array, read: Uint8Array): boolean =>
  bytes.byteLength === read.byteLength &&
  canonicalSHA256Base64(bytes) === canonicalSHA256Base64(read);

const writeImmutable = (
  key: string,
  bytes: Uint8Array,
): Effect.Effect<void, BackupError, BackupRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* BackupRuntime;
    const existing = yield* r2Integrity(runtime.r2.head(key));
    if (existing !== undefined) {
      const read = yield* r2Integrity(runtime.r2.read(key));
      if (read.size !== bytes.byteLength || !matchesBytes(bytes, read.bytes))
        return yield* backupFailure<never>("archive_conflict");
      return;
    }
    yield* runtime.r2.putIfAbsent(key, bytes).pipe(
      Effect.catchAll((error) =>
        error.reason === "already_exists"
          ? runtime.r2.read(key).pipe(
              Effect.matchEffect({
                onFailure: () => backupFailure<void>("integrity_failed"),
                onSuccess: (read) =>
                  read.size === bytes.byteLength && matchesBytes(bytes, read.bytes)
                    ? Effect.void
                    : backupFailure<void>("archive_conflict"),
              }),
            )
          : backupFailure<void>("integrity_failed"),
      ),
    );
  });

/**
 * A manifest is an exact archive inventory, not merely a list of objects to
 * fetch. Refusing an omitted or additional key prevents a restored target
 * from silently inheriting an unreviewed archive member.
 */
const verifyExactArchiveInventory = (
  scope: BackupScope,
  signed: SignedBackupManifest,
): Effect.Effect<void, BackupError, BackupRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* BackupRuntime;
    const prefix = backupArchivePrefix(scope, signed.manifest.backupID);
    const manifestKey = backupManifestKey(scope, signed.manifest.backupID);
    if (prefix === undefined || manifestKey === undefined)
      return yield* backupFailure<never>("manifest_invalid");
    const expected = new Set([...signed.manifest.objects.map((object) => object.key), manifestKey]);
    if (expected.size !== signed.manifest.objects.length + 1)
      return yield* backupFailure<never>("manifest_invalid");
    const received = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let truncated = true;
    while (truncated) {
      const page = yield* r2Integrity(runtime.r2.listExactPrefix(prefix, { cursor, limit: 1_000 }));
      pages += 1;
      if (pages > expected.size + 1) return yield* backupFailure<never>("integrity_failed");
      for (const object of page.objects) {
        if (!expected.has(object.key) || received.has(object.key))
          return yield* backupFailure<never>("integrity_failed");
        received.add(object.key);
      }
      if (page.truncated && (page.cursor === undefined || page.cursor === cursor))
        return yield* backupFailure<never>("integrity_failed");
      cursor = page.cursor;
      truncated = page.truncated;
    }
    if (received.size !== expected.size) return yield* backupFailure<never>("integrity_failed");
  });

/** Creates immutable object records first, then writes the signed manifest last. */
export const createBackup = (
  scope: BackupScope,
  backupID: string,
  nowMilliseconds: number,
  lifetimeMilliseconds: number,
  limits: BackupLimits = defaultBackupLimits,
) =>
  Effect.gen(function* () {
    const runtime = yield* BackupRuntime;
    const source = yield* BackupSnapshotSource;
    const archivedScope = ownedScope(scope);
    const archivedLimits = ownedLimits(limits);
    if (
      archivedScope === undefined ||
      backupArchivePrefix(archivedScope, backupID) === undefined ||
      !safeInteger(nowMilliseconds, 1) ||
      !safeInteger(lifetimeMilliseconds, 1) ||
      !validLimits(archivedLimits) ||
      lifetimeMilliseconds > archivedLimits.maximumManifestLifetimeMilliseconds
    )
      return yield* backupFailure<never>("invalid_backup");
    const snapshot = yield* source.snapshot(archivedScope, backupID);
    const plan = prepareArchivePlan(snapshot, archivedScope, backupID, archivedLimits);
    if (plan === undefined) return yield* backupFailure<never>("source_invalid");
    for (const object of plan.objects) yield* writeImmutable(object.record.key, object.bytes);
    const manifest: BackupManifest = {
      version: 1,
      backupID,
      catalogDigest: plan.catalogDigest,
      controlEpoch: plan.controlEpoch,
      credentialEpoch: plan.credentialEpoch,
      generationEpoch: plan.generationEpoch,
      highWaterMark: plan.highWaterMark,
      scope: archivedScope,
      createdAtMilliseconds: nowMilliseconds,
      expiresAtMilliseconds: nowMilliseconds + lifetimeMilliseconds,
      protocolVersion,
      routingEpoch: plan.routingEpoch,
      schemaVersion: 1,
      objects: plan.records,
    };
    const signingBytes = canonicalManifestBytes(manifest, archivedLimits);
    if (signingBytes === undefined) return yield* backupFailure<never>("manifest_invalid");
    const signature = yield* runtime.signer
      .signCanonical(signingBytes)
      .pipe(Effect.mapError(() => new BackupError({ reason: "manifest_untrusted" })));
    const signed: SignedBackupManifest = { manifest, signature };
    const encoded = canonicalSignedManifestBytes(signed, archivedLimits);
    const manifestKey = backupManifestKey(archivedScope, backupID);
    if (
      encoded === undefined ||
      encoded.byteLength > archivedLimits.maximumManifestBytes ||
      manifestKey === undefined
    )
      return yield* backupFailure<never>("manifest_invalid");
    yield* writeImmutable(manifestKey, encoded);
    return signed;
  });

/** Loads and verifies a single immutable manifest; prefix listing is never authority. */
export const loadVerifiedBackup = (
  scope: BackupScope,
  backupID: string,
  nowMilliseconds: number,
  limits: BackupLimits = defaultBackupLimits,
) =>
  Effect.gen(function* () {
    const runtime = yield* BackupRuntime;
    const key = backupManifestKey(scope, backupID);
    if (key === undefined || !safeInteger(nowMilliseconds, 1) || !validLimits(limits))
      return yield* backupFailure<never>("invalid_backup");
    const stored = yield* r2Integrity(runtime.r2.read(key));
    if (stored.size > limits.maximumManifestBytes)
      return yield* backupFailure<never>("manifest_invalid");
    const signed = decodeSignedBackupManifest(
      new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes),
      limits,
    );
    if (signed === undefined || !sameScope(signed.manifest.scope, scope))
      return yield* backupFailure<never>("manifest_invalid");
    if (signed.manifest.expiresAtMilliseconds <= nowMilliseconds)
      return yield* backupFailure<never>("manifest_expired");
    const signingBytes = canonicalManifestBytes(signed.manifest, limits);
    if (signingBytes === undefined) return yield* backupFailure<never>("manifest_invalid");
    yield* runtime.verifier
      .verifyCanonical(signingBytes, signed.signature)
      .pipe(Effect.mapError(() => new BackupError({ reason: "manifest_untrusted" })));
    return signed;
  });

/** Restores only into a freshly allocated inactive generation and verifies every byte.
 * Promotion is a separate restartable state machine in `promotion.ts`. */
export const restoreVerifiedBackup = (
  scope: BackupScope,
  backupID: string,
  nowMilliseconds: number,
  limits: BackupLimits = defaultBackupLimits,
) =>
  Effect.gen(function* () {
    const runtime = yield* BackupRuntime;
    const recovery = yield* BackupRecoveryRepository;
    if (!validLimits(limits)) return yield* backupFailure<never>("invalid_backup");
    const signed = yield* loadVerifiedBackup(scope, backupID, nowMilliseconds, limits);
    yield* verifyExactArchiveInventory(scope, signed);
    const controlFloor = yield* recovery.controlEpochFloor(scope);
    if (!safeInteger(controlFloor, 0) || signed.manifest.controlEpoch < controlFloor)
      return yield* backupFailure<never>("recovery_conflict");
    const target = yield* recovery.allocateInactiveGeneration(scope, backupID);
    if (
      target.inactivePrivate !== true ||
      !validBackupScope(target.scope) ||
      target.scope.ownerID.value !== scope.ownerID.value ||
      target.scope.vaultID.value !== scope.vaultID.value ||
      target.scope.generationEpoch <= scope.generationEpoch
    )
      return yield* backupFailure<never>("recovery_conflict");
    for (const object of signed.manifest.objects) {
      const read = yield* r2Integrity(runtime.r2.read(object.key));
      if (!objectMatches(object, read.bytes))
        return yield* backupFailure<never>("integrity_failed");
      yield* recovery.restoreObject(target, object, read.bytes);
    }
    yield* recovery.validateInactiveGeneration(target, signed.manifest);
    return target;
  });
