/** @enchiridion/effect-module */
/**
 * Durable, copy-on-write backup pins for the OwnerVault catalog.
 *
 * A pin is not a best-effort view of current storage.  It names one immutable
 * catalog root and holds a reference to that revision.  Repository writes
 * retain a preimage before replacing a row named by a retained root; reads
 * therefore resolve only the pinned root plus its COW preimages.
 */
import { Effect } from "effect";
import {
  canonicalSnapshotRecordBytes,
  ownerVaultBackupDigest,
} from "./backup-canonical";
import {
  ownerVaultBackupFailure,
  ownerVaultBackupMaximumObjectBytes,
  ownerVaultBackupMaximumPageBytes,
  type OwnerVaultBackupError,
  type OwnerVaultBackupScope,
  type OwnerVaultBackupSnapshotSource,
  type OwnerVaultSnapshotObject,
  type OwnerVaultSnapshotPage,
  type OwnerVaultSnapshotPin,
} from "./backup-types";
import {
  isOwnerVaultCatalogCurrentPayload,
  isOwnerVaultCatalogPagePayload,
  isOwnerVaultCatalogRootPayload,
  ownerVaultCatalogDigest,
  ownerVaultCatalogEntryDigest,
  ownerVaultCatalogRevisionIdentifier,
  type OwnerVaultCatalogEntry,
  type OwnerVaultCatalogRootPayload,
} from "./catalog";
import type {
  OwnerVaultStorageAddress,
  OwnerVaultStorageRepository,
  OwnerVaultStorageTransactionFailure,
  OwnerVaultTx,
} from "./repository";
import type { OwnerVaultStorageRecord } from "./storage-registry";

const backupIDPattern = /^[A-Za-z0-9_-]{16,120}$/u;
const digestPattern = /^[A-Za-z0-9+/]{43}=$/u;
const appendDigestPattern = /^[a-f0-9]{64}$/u;
const cursorPattern = /^[0-9]{20}$/u;
const maxPins = 1_024;
const gcChunk = 128;

export const OwnerVaultSnapshotPinState = {
  Open: "OPEN",
  Completed: "COMPLETED",
  Aborted: "ABORTED",
  Expired: "EXPIRED",
} as const;
export type OwnerVaultSnapshotPinState =
  (typeof OwnerVaultSnapshotPinState)[keyof typeof OwnerVaultSnapshotPinState];

interface StoredPin extends OwnerVaultSnapshotPin {
  readonly catalogRevision: number;
  readonly rootDigest: string;
  readonly state: OwnerVaultSnapshotPinState;
  readonly retained: boolean;
  readonly manifestDigest?: string;
}

interface StoredGCJournal {
  readonly backupID: string;
  readonly catalogRevision: number;
  readonly nextOrdinal: number;
}

export interface OwnerVaultSnapshotPinController extends OwnerVaultBackupSnapshotSource {
  readonly completeSnapshot: (
    pin: OwnerVaultSnapshotPin,
    manifestDigest: string,
  ) => Effect.Effect<void, OwnerVaultBackupError>;
  readonly abortSnapshot: (pin: OwnerVaultSnapshotPin) => Effect.Effect<void, OwnerVaultBackupError>;
  readonly expireSnapshot: (pin: OwnerVaultSnapshotPin) => Effect.Effect<void, OwnerVaultBackupError>;
  /** Deletes at most `limit` retained preimages in one DO transaction. */
  readonly collectGarbage: (
    backupID: string,
    limit?: number,
  ) => Effect.Effect<boolean, OwnerVaultBackupError>;
}

export interface OwnerVaultSnapshotPinOptions {
  /** Generated before entering the DO transaction. Must be unguessable in production. */
  readonly makePinProof?: () => string;
}

const address = (category: OwnerVaultStorageAddress["category"], identifier?: string): OwnerVaultStorageAddress =>
  identifier === undefined ? { category } : { category, identifier };
const plain = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const sameScope = (left: OwnerVaultBackupScope, right: OwnerVaultBackupScope): boolean =>
  left.ownerID === right.ownerID && left.vaultID === right.vaultID && left.generationEpoch === right.generationEpoch;
const validScope = (scope: OwnerVaultBackupScope): boolean =>
  /^[A-Za-z0-9_-]{1,128}$/u.test(scope.ownerID) &&
  /^[A-Za-z0-9_-]{1,128}$/u.test(scope.vaultID) && nonNegative(scope.generationEpoch) && scope.generationEpoch >= 1;
const validState = (value: unknown): value is OwnerVaultSnapshotPinState =>
  value === OwnerVaultSnapshotPinState.Open || value === OwnerVaultSnapshotPinState.Completed ||
  value === OwnerVaultSnapshotPinState.Aborted || value === OwnerVaultSnapshotPinState.Expired;
const pinProof = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};
const preimageIdentifier = (revision: number, ordinal: number): string | undefined => {
  const root = ownerVaultCatalogRevisionIdentifier(revision);
  return root !== undefined && nonNegative(ordinal) && ordinal <= 9_999
    ? `${root}-${String(ordinal).padStart(4, "0")}`
    : undefined;
};
const cursorFor = (ordinal: number): string => String(ordinal).padStart(20, "0");
const cursorOrdinal = (cursor: string | undefined): number | undefined =>
  cursor === undefined ? 0 : cursorPattern.test(cursor) ? Number(cursor) : undefined;
const backupObjectKey = (scope: OwnerVaultBackupScope, backupID: string, ordinal: number): string =>
  `v2/owner-vault/backups/${scope.ownerID}/${scope.vaultID}/${scope.generationEpoch}/${backupID}/objects/${String(ordinal).padStart(8, "0")}.json`;

const decodePin = (value: unknown): StoredPin | undefined => {
  const source = plain(value);
  if (source === undefined || !exact(source, [
    "appendLogDigest", "appendLogSequence", "backupID", "catalogDigest", "catalogRevision", "highWaterMark", "pinProof", "retained", "rootDigest", "scope", "state",
    ...(source.manifestDigest === undefined ? [] : ["manifestDigest"]),
  ])) return undefined;
  const scope = plain(source.scope);
  if (
    scope === undefined || !exact(scope, ["ownerID", "vaultID", "generationEpoch"]) ||
    typeof scope.ownerID !== "string" || typeof scope.vaultID !== "string" || !nonNegative(scope.generationEpoch) ||
    typeof source.backupID !== "string" || !backupIDPattern.test(source.backupID) || !nonNegative(source.catalogRevision) ||
    typeof source.rootDigest !== "string" || !digestPattern.test(source.rootDigest) ||
    typeof source.catalogDigest !== "string" || !digestPattern.test(source.catalogDigest) ||
    typeof source.highWaterMark !== "string" || !digestPattern.test(source.highWaterMark) ||
    !nonNegative(source.appendLogSequence) || typeof source.appendLogDigest !== "string" || !appendDigestPattern.test(source.appendLogDigest) || typeof source.pinProof !== "string" || !/^[A-Za-z0-9_-]{16,512}$/u.test(source.pinProof) ||
    typeof source.retained !== "boolean" || !validState(source.state) ||
    (source.manifestDigest !== undefined && (typeof source.manifestDigest !== "string" || !digestPattern.test(source.manifestDigest)))
  ) return undefined;
  const result: StoredPin = {
    backupID: source.backupID,
    scope: { ownerID: scope.ownerID, vaultID: scope.vaultID, generationEpoch: scope.generationEpoch },
    catalogRevision: source.catalogRevision,
    rootDigest: source.rootDigest,
    catalogDigest: source.catalogDigest,
    highWaterMark: source.highWaterMark,
    appendLogSequence: source.appendLogSequence,
    appendLogDigest: source.appendLogDigest,
    pinProof: source.pinProof,
    state: source.state,
    retained: source.retained,
  };
  return source.manifestDigest === undefined ? result : { ...result, manifestDigest: source.manifestDigest };
};

const encodePin = (value: StoredPin): Readonly<Record<string, unknown>> => ({
  backupID: value.backupID,
  scope: value.scope,
  catalogRevision: value.catalogRevision,
  rootDigest: value.rootDigest,
  catalogDigest: value.catalogDigest,
  highWaterMark: value.highWaterMark,
  appendLogSequence: value.appendLogSequence,
  appendLogDigest: value.appendLogDigest,
  pinProof: value.pinProof,
  state: value.state,
  retained: value.retained,
  ...(value.manifestDigest === undefined ? {} : { manifestDigest: value.manifestDigest }),
});

const publicPin = (pin: StoredPin): OwnerVaultSnapshotPin => ({
  backupID: pin.backupID,
  scope: pin.scope,
  highWaterMark: pin.highWaterMark,
  appendLogSequence: pin.appendLogSequence,
  appendLogDigest: pin.appendLogDigest,
  catalogDigest: pin.catalogDigest,
  pinProof: pin.pinProof,
});

const pinMatches = (candidate: StoredPin, pin: OwnerVaultSnapshotPin): boolean =>
  candidate.backupID === pin.backupID && sameScope(candidate.scope, pin.scope) &&
  candidate.highWaterMark === pin.highWaterMark && candidate.appendLogSequence === pin.appendLogSequence && candidate.appendLogDigest === pin.appendLogDigest &&
  candidate.catalogDigest === pin.catalogDigest && candidate.pinProof === pin.pinProof;

const catalogEntries = (
  tx: OwnerVaultTx,
  root: OwnerVaultCatalogRootPayload,
): Effect.Effect<readonly OwnerVaultCatalogEntry[], OwnerVaultStorageTransactionFailure> =>
  Effect.forEach(root.pages, (descriptor) =>
    tx.get(address("catalog.page", descriptor.identifier)).pipe(
      Effect.flatMap((stored) => {
        const payload = stored?.payload;
        if (stored === undefined || !isOwnerVaultCatalogPagePayload(payload) || payload.digest !== descriptor.digest ||
          payload.entries.length !== descriptor.count)
          return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
        return Effect.succeed(payload.entries);
      }),
    ),
  ).pipe(
    Effect.flatMap((pages) => {
      const entries = pages.flat();
      const ordered = entries.every((entry, index) => entry.ordinal === index &&
        (index === 0 || entries[index - 1]!.key < entry.key));
      return ordered && ownerVaultCatalogDigest(entries) === root.catalogDigest && root.highWaterMark === root.catalogDigest
        ? Effect.succeed(entries)
        : Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
    }),
  );

const pinnedRoot = (
  tx: OwnerVaultTx,
  pin: StoredPin,
): Effect.Effect<{ readonly root: OwnerVaultCatalogRootPayload; readonly entries: readonly OwnerVaultCatalogEntry[] }, OwnerVaultStorageTransactionFailure> => {
  const identifier = ownerVaultCatalogRevisionIdentifier(pin.catalogRevision);
  if (identifier === undefined) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
  return tx.get(address("catalog.root", identifier)).pipe(
    Effect.flatMap((stored) => {
      const root = stored?.payload;
      if (stored === undefined || !isOwnerVaultCatalogRootPayload(root) || root.catalogRevision !== pin.catalogRevision ||
        ownerVaultCatalogDigest(root) !== pin.rootDigest || root.catalogDigest !== pin.catalogDigest ||
        root.highWaterMark !== pin.highWaterMark || root.appendLogSequence !== pin.appendLogSequence || root.appendLogDigest !== pin.appendLogDigest || !sameScope(root.scope, pin.scope))
        return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
      return catalogEntries(tx, root).pipe(Effect.map((entries) => ({ root, entries })));
    }),
  );
};

const recordBytes = (record: OwnerVaultStorageRecord): number | undefined => {
  try { return new TextEncoder().encode(JSON.stringify({ category: record.category, version: record.version, payload: record.payload })).byteLength; }
  catch { return undefined; }
};

const matchesEntry = (entry: OwnerVaultCatalogEntry, record: OwnerVaultStorageRecord): boolean =>
  record.category === entry.category && record.version === 1 && recordBytes(record) === entry.bytes &&
  ownerVaultCatalogEntryDigest({ category: record.category, version: record.version, payload: record.payload }) === entry.digest;

const preimageRecord = (value: OwnerVaultStorageRecord | undefined, entry: OwnerVaultCatalogEntry): OwnerVaultStorageRecord | undefined => {
  const source = value === undefined ? undefined : plain(value.payload);
  const payload = source === undefined ? undefined : plain(source.payload);
  return source !== undefined && source.key === entry.key && source.category === entry.category && source.bytes === entry.bytes &&
    source.digest === entry.digest && payload !== undefined
    ? { category: entry.category as OwnerVaultStorageRecord["category"], version: 1, payload }
    : undefined;
};

const mapError = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, OwnerVaultBackupError> =>
  effect.pipe(Effect.mapError(() => new (class extends Error {})()), Effect.catchAll(() => ownerVaultBackupFailure("source_unavailable")));

/**
 * Binds C1's immutable catalog to a retained, restart-safe backup source.
 * It has no storage-list fallback: every read follows a durable pin, root,
 * page descriptor, and (if needed) COW preimage by exact key.
 */
export const makeOwnerVaultSnapshotPinController = (
  repository: OwnerVaultStorageRepository,
  options: OwnerVaultSnapshotPinOptions = {},
): OwnerVaultSnapshotPinController => {
  const beginSnapshot = (scope: OwnerVaultBackupScope, backupID: string): Effect.Effect<OwnerVaultSnapshotPin, OwnerVaultBackupError> => {
    if (!validScope(scope) || !backupIDPattern.test(backupID)) return ownerVaultBackupFailure("invalid_backup");
    const proof = options.makePinProof?.() ?? pinProof();
    if (!/^[A-Za-z0-9_-]{16,512}$/u.test(proof)) return ownerVaultBackupFailure("invalid_backup");
    return mapError(repository.transact((tx) =>
      tx.get(address("backup.pin", backupID)).pipe(
        Effect.flatMap((existing) => {
          if (existing !== undefined) {
            const prior = decodePin(existing.payload);
            if (prior === undefined) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
            if (!sameScope(prior.scope, scope)) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "identity_conflict" } as const);
            return prior.state === OwnerVaultSnapshotPinState.Aborted || prior.state === OwnerVaultSnapshotPinState.Expired
              ? Effect.fail({ _tag: "OwnerVaultStorageError", reason: "identity_conflict" } as const)
              : Effect.succeed(publicPin(prior));
          }
          return tx.get(address("catalog.current")).pipe(
            Effect.flatMap((current) => {
              if (current === undefined || !isOwnerVaultCatalogCurrentPayload(current.payload))
                return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
              const identifier = ownerVaultCatalogRevisionIdentifier(current.payload.catalogRevision);
              if (identifier === undefined) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
              return tx.get(address("catalog.root", identifier)).pipe(
                Effect.flatMap((rootRecord) => {
                  const root = rootRecord?.payload;
                  const rootDigest = current.payload.rootDigest;
                  if (rootRecord === undefined || !isOwnerVaultCatalogRootPayload(root) || typeof rootDigest !== "string" ||
                    ownerVaultCatalogDigest(root) !== rootDigest || !sameScope(root.scope, scope))
                    return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
                  return catalogEntries(tx, root).pipe(
                    Effect.flatMap(() => tx.get(address("catalog.retention", identifier)).pipe(
                      Effect.flatMap((retention) => {
                        const count = retention === undefined ? 0 : plain(retention.payload)?.pinCount;
                        if (!nonNegative(count) || count >= maxPins) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "quota_exceeded" } as const);
                        const pin: StoredPin = {
                          backupID, scope, catalogRevision: root.catalogRevision, rootDigest,
                          catalogDigest: root.catalogDigest, highWaterMark: root.highWaterMark,
                          appendLogSequence: root.appendLogSequence, appendLogDigest: root.appendLogDigest,
                          pinProof: proof, state: OwnerVaultSnapshotPinState.Open, retained: true,
                        };
                        return tx.put(address("backup.pin", backupID), encodePin(pin)).pipe(
                          Effect.zipRight(tx.put(address("catalog.retention", identifier), { pinCount: count + 1 })),
                          Effect.as(publicPin(pin)),
                        );
                      }),
                    )),
                  );
                }),
              );
            }),
          );
        }),
      ),
    ));
  };

  const readSnapshotPage = (pin: OwnerVaultSnapshotPin, cursor: string | undefined): Effect.Effect<OwnerVaultSnapshotPage, OwnerVaultBackupError> => {
    const start = cursorOrdinal(cursor);
    if (start === undefined) return ownerVaultBackupFailure("catalog_invalid");
    return mapError(repository.transact((tx) => tx.get(address("backup.pin", pin.backupID)).pipe(
      Effect.flatMap((stored) => {
        const durable = stored === undefined ? undefined : decodePin(stored.payload);
        if (durable === undefined || !pinMatches(durable, pin) || !durable.retained ||
          (durable.state !== OwnerVaultSnapshotPinState.Open && durable.state !== OwnerVaultSnapshotPinState.Completed))
          return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "identity_conflict" } as const);
        return pinnedRoot(tx, durable).pipe(
          Effect.flatMap(({ entries }) => {
            if (start >= entries.length) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "invalid_address" } as const);
            // Entry sizes are catalog-authenticated before this point. Select
            // by that metadata *before* loading a value: a page with 128
            // legal 8 MiB rows must never be materialized in one isolate.
            const selected: OwnerVaultCatalogEntry[] = [];
            let projectedBytes = 0;
            for (const entry of entries.slice(start, Math.min(entries.length, start + 128))) {
              if (selected.length > 0 && projectedBytes + entry.bytes > ownerVaultBackupMaximumPageBytes) break;
              selected.push(entry);
              projectedBytes += entry.bytes;
            }
            return Effect.forEach(selected, (entry) => {
              const preimageID = preimageIdentifier(durable.catalogRevision, entry.ordinal);
              if (preimageID === undefined) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
              return tx.get({ category: entry.category as OwnerVaultStorageAddress["category"], identifier: entry.key.split("/").at(-1) }).pipe(
                Effect.flatMap((live) => {
                  const record = live !== undefined && matchesEntry(entry, live) ? live : undefined;
                  return record === undefined
                    ? tx.get(address("backup.preimage", preimageID)).pipe(
                        Effect.flatMap((copy) => {
                          const restored = preimageRecord(copy, entry);
                          return restored === undefined || !matchesEntry(entry, restored)
                            ? Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const)
                            : Effect.succeed(restored);
                        }),
                      )
                    : Effect.succeed(record);
                }),
              ).pipe(
                Effect.flatMap((record) => {
                  const bytes = canonicalSnapshotRecordBytes(
                    { category: entry.category as OwnerVaultStorageAddress["category"], identifier: entry.key.split("/").at(-1) },
                    record,
                  );
                  return bytes === undefined || bytes.byteLength > ownerVaultBackupMaximumObjectBytes
                    ? Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const)
                    : Effect.succeed({ ordinal: entry.ordinal, address: { category: entry.category as OwnerVaultStorageAddress["category"], identifier: entry.key.split("/").at(-1) }, record, sha256Base64: ownerVaultBackupDigest(bytes), size: bytes.byteLength } as OwnerVaultSnapshotObject);
                }),
              );
            }).pipe(
              Effect.flatMap((objects) => {
                // Never return a materialized page that can approach isolate memory.
                const bounded: OwnerVaultSnapshotObject[] = [];
                let total = 0;
                for (const object of objects) {
                  if (bounded.length > 0 && total + object.size > ownerVaultBackupMaximumPageBytes) break;
                  total += object.size;
                  bounded.push(object);
                }
                if (bounded.length === 0) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
                const digest = ownerVaultBackupDigest(new TextEncoder().encode(JSON.stringify(bounded.map((object) => ({ ordinal: object.ordinal, key: backupObjectKey(durable.scope, durable.backupID, object.ordinal), sha256Base64: object.sha256Base64, size: object.size, category: object.address.category, ...(object.address.identifier === undefined ? {} : { identifier: object.address.identifier }) })))));
                const next = start + bounded.length;
                return Effect.succeed({ entries: bounded, digest, ...(next < entries.length ? { nextCursor: cursorFor(next) } : {}) });
              }),
            );
          }),
        );
      }),
    )));
  };

  const transition = (
    pin: OwnerVaultSnapshotPin,
    target: OwnerVaultSnapshotPinState,
    manifestDigest?: string,
  ): Effect.Effect<void, OwnerVaultBackupError> => mapError(repository.transact((tx) => tx.get(address("backup.pin", pin.backupID)).pipe(
    Effect.flatMap((stored) => {
      const prior = stored === undefined ? undefined : decodePin(stored.payload);
      if (prior === undefined || !pinMatches(prior, pin)) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "identity_conflict" } as const);
      if (target === OwnerVaultSnapshotPinState.Completed) {
        if (manifestDigest === undefined || !digestPattern.test(manifestDigest)) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "invalid_record" } as const);
        if (prior.state === OwnerVaultSnapshotPinState.Completed && prior.manifestDigest === manifestDigest) return Effect.void;
        if (prior.state !== OwnerVaultSnapshotPinState.Open) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "identity_conflict" } as const);
        return tx.put(address("backup.pin", pin.backupID), encodePin({ ...prior, state: target, manifestDigest }));
      }
      if (prior.state === target) return Effect.void;
      if (prior.state !== OwnerVaultSnapshotPinState.Open || !prior.retained) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "identity_conflict" } as const);
      const revision = ownerVaultCatalogRevisionIdentifier(prior.catalogRevision);
      if (revision === undefined) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
      return tx.get(address("catalog.retention", revision)).pipe(
        Effect.flatMap((retention) => {
          const count = retention === undefined ? undefined : plain(retention.payload)?.pinCount;
          if (!nonNegative(count) || count < 1) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
          const next = count - 1;
          return tx.put(address("backup.pin", pin.backupID), encodePin({ ...prior, state: target, retained: false })).pipe(
            Effect.zipRight(tx.put(address("catalog.retention", revision), { pinCount: next })),
            Effect.zipRight(next === 0 ? tx.put(address("backup.gc-journal", pin.backupID), { backupID: pin.backupID, catalogRevision: prior.catalogRevision, nextOrdinal: 0 }) : Effect.void),
          );
        }),
      );
    }),
  )));

  /** Completion closes the archive; release only drops the COW retention. */
  const releaseSnapshot = (pin: OwnerVaultSnapshotPin): Effect.Effect<void, OwnerVaultBackupError> =>
    mapError(repository.transact((tx) => tx.get(address("backup.pin", pin.backupID)).pipe(
      Effect.flatMap((stored) => {
        const prior = stored === undefined ? undefined : decodePin(stored.payload);
        if (prior === undefined || !pinMatches(prior, pin) || prior.state !== OwnerVaultSnapshotPinState.Completed)
          return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "identity_conflict" } as const);
        if (!prior.retained) return Effect.void;
        const revision = ownerVaultCatalogRevisionIdentifier(prior.catalogRevision);
        if (revision === undefined) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
        return tx.get(address("catalog.retention", revision)).pipe(
          Effect.flatMap((retention) => {
            const count = retention === undefined ? undefined : plain(retention.payload)?.pinCount;
            if (!nonNegative(count) || count < 1) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
            const next = count - 1;
            return tx.put(address("backup.pin", pin.backupID), encodePin({ ...prior, retained: false })).pipe(
              Effect.zipRight(tx.put(address("catalog.retention", revision), { pinCount: next })),
              Effect.zipRight(next === 0 ? tx.put(address("backup.gc-journal", pin.backupID), { backupID: pin.backupID, catalogRevision: prior.catalogRevision, nextOrdinal: 0 }) : Effect.void),
            );
          }),
        );
      }),
    )));

  const collectGarbage = (backupID: string, limit = gcChunk): Effect.Effect<boolean, OwnerVaultBackupError> => {
    if (!backupIDPattern.test(backupID) || !Number.isSafeInteger(limit) || limit < 1 || limit > gcChunk)
      return ownerVaultBackupFailure("invalid_backup");
    return mapError(repository.transact((tx) => tx.get(address("backup.gc-journal", backupID)).pipe(
      Effect.flatMap((stored) => {
        const source = stored === undefined ? undefined : plain(stored.payload);
        if (source === undefined || !exact(source, ["backupID", "catalogRevision", "nextOrdinal"]) || source.backupID !== backupID || !nonNegative(source.catalogRevision) || !nonNegative(source.nextOrdinal))
          return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
        const journal: StoredGCJournal = { backupID, catalogRevision: source.catalogRevision, nextOrdinal: source.nextOrdinal };
        const identifier = ownerVaultCatalogRevisionIdentifier(journal.catalogRevision);
        if (identifier === undefined) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
        return tx.get(address("catalog.retention", identifier)).pipe(
          Effect.flatMap((retention) => {
            if (retention === undefined || plain(retention.payload)?.pinCount !== 0) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
            return tx.get(address("catalog.root", identifier)).pipe(
              Effect.flatMap((rootRecord) => {
                const root = rootRecord?.payload;
                if (rootRecord === undefined || !isOwnerVaultCatalogRootPayload(root)) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
                return catalogEntries(tx, root).pipe(
                  Effect.flatMap((entries) => {
                    const chunk = entries.slice(journal.nextOrdinal, journal.nextOrdinal + limit);
                    return Effect.forEach(chunk, (entry) => {
                      const preimage = preimageIdentifier(journal.catalogRevision, entry.ordinal);
                      return preimage === undefined ? Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const) : tx.delete(address("backup.preimage", preimage));
                    }).pipe(
                      Effect.flatMap(() => {
                        const nextOrdinal = journal.nextOrdinal + chunk.length;
                        if (nextOrdinal < entries.length) return tx.put(address("backup.gc-journal", backupID), { ...journal, nextOrdinal }).pipe(Effect.as(false));
                        return tx.get(address("catalog.current")).pipe(
                          Effect.flatMap((current) => {
                            if (current === undefined || !isOwnerVaultCatalogCurrentPayload(current.payload)) return Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const);
                            const removeHistorical = current.payload.catalogRevision !== journal.catalogRevision;
                            return (removeHistorical
                              ? Effect.forEach(root.pages, (page) => tx.delete(address("catalog.page", page.identifier))).pipe(
                                  Effect.zipRight(tx.delete(address("catalog.root", identifier))),
                                )
                              : Effect.void).pipe(
                              Effect.zipRight(tx.delete(address("catalog.retention", identifier))),
                              Effect.zipRight(tx.delete(address("backup.gc-journal", backupID))),
                              Effect.as(true),
                            );
                          }),
                        );
                      }),
                    );
                  }),
                );
              }),
            );
          }),
        );
      }),
    )));
  };

  const controller: OwnerVaultSnapshotPinController = {
    beginSnapshot,
    readSnapshotPage,
    releaseSnapshot,
    completeSnapshot: (pin: OwnerVaultSnapshotPin, manifestDigest: string) => transition(pin, OwnerVaultSnapshotPinState.Completed, manifestDigest),
    abortSnapshot: (pin: OwnerVaultSnapshotPin) => transition(pin, OwnerVaultSnapshotPinState.Aborted),
    expireSnapshot: (pin: OwnerVaultSnapshotPin) => transition(pin, OwnerVaultSnapshotPinState.Expired),
    collectGarbage,
  };
  return Object.freeze(controller);
};
