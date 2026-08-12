/** @enchiridion/effect-module */
import {
  type BlobR2NativeBinding,
  type BlobR2NativeBindingInput,
  type ImmutableR2NativeBinding,
  type ManifestKeyRingConfigurationError,
  type ManifestP256KeyRing,
  canonicalP256Spki,
  makeBlobR2NativeBinding,
  makeManifestP256KeyRing,
  maximumPriorManifestKeys,
} from "@enchiridion/runtime";
import { Effect, Fiber, Redacted } from "effect";
import type { BlobLimits } from "../blobs/blobs";
import {
  ownerVaultBackupMaximumManifestBytes,
  ownerVaultBackupMaximumObjectBytes,
  ownerVaultBackupMaximumObjects,
  ownerVaultBackupMaximumPageBytes,
  ownerVaultBackupMaximumPageEntries,
  ownerVaultBackupMaximumRestoreJournalBytes,
  ownerVaultBackupMaximumTotalBytes,
} from "../owner-vault/backup-types";
import {
  ownerVaultCatalogMaximumObjectBytes,
  ownerVaultCatalogMaximumObjects,
  ownerVaultCatalogMaximumPageBytes,
  ownerVaultCatalogMaximumPageEntries,
  ownerVaultCatalogMaximumTotalBytes,
  ownerVaultCatalogTargetPageBytes,
} from "../owner-vault/catalog";

/**
 * The single production authority for every bounded OwnerVault subsystem.
 * It is parsed exactly once at composition time: no provider receives a
 * partial limits object and no limit has a fallback value.
 */
export interface OwnerVaultProductionLimits {
  readonly blob: BlobLimits & { readonly tombstoneGraceSeconds: number };
  readonly catalog: {
    readonly maximumObjects: number;
    readonly maximumObjectBytes: number;
    readonly maximumTotalBytes: number;
    readonly maximumPageEntries: number;
    readonly targetPageBytes: number;
    readonly maximumPageBytes: number;
    readonly maximumRootBytes: number;
  };
  readonly backup: {
    readonly maximumPageBytes: number;
    readonly maximumPageEntries: number;
    readonly maximumObjectBytes: number;
    readonly maximumTotalBytes: number;
    readonly maximumManifestBytes: number;
    readonly maximumRestoreJournalBytes: number;
    readonly maximumObjects: number;
  };
  readonly pins: {
    readonly maximumPins: number;
    readonly gcChunk: number;
    readonly retentionSeconds: number;
  };
  readonly r2: {
    readonly maximumKeyBytes: number;
    readonly maximumObjectBytes: number;
    readonly maximumCursorBytes: number;
    readonly maximumListPageSize: number;
  };
}

export interface OwnerVaultProductionAuthority {
  readonly limits: OwnerVaultProductionLimits;
  /**
   * One ring per isolate, validated eagerly during construction. Every call
   * returns the exit cached at composition time: first use never triggers
   * Web Crypto validation, and neither success nor failure is re-computed.
   */
  readonly manifestKeys: () => Effect.Effect<
    ManifestP256KeyRing,
    ManifestKeyRingConfigurationError
  >;
  /** Separate structural capabilities: neither provider can accept the other. */
  readonly blobR2: OwnerVaultBlobR2Binding;
  readonly backupR2: OwnerVaultBackupR2Binding;
}

export interface OwnerVaultBlobR2Binding {
  readonly purpose: "owner-vault-blob-r2";
  readonly native: BlobR2NativeBinding;
}
export interface OwnerVaultBackupR2Binding {
  readonly purpose: "owner-vault-backup-r2";
  readonly native: ImmutableR2NativeBinding;
}

interface ManifestPrior {
  readonly keyID: string;
  readonly publicKeySPKIDERBase64: string;
}

/**
 * The exact caps compiled into the enforcing modules. Catalog and backup
 * enforcement reads `owner-vault/catalog.ts` and `owner-vault/backup-types.ts`
 * module constants, and `owner-vault/snapshot-pin.ts` enforces its private
 * pin ceiling (1024) and GC chunk (128). The root-payload cap is likewise
 * unexported: `owner-vault/catalog.ts` (isOwnerVaultCatalogRootPayload) and
 * `owner-vault/storage-registry.ts` (rootMaximumBytes) both compile 8 KiB in
 * place, so it is mirrored here exactly as the pin caps are. Until those
 * consumers accept the injected authority directly, the composed limits must
 * equal the enforced values exactly: a divergent deployment configuration is
 * a construction failure, never a silently unenforced cap.
 */
const enforcedPinLimits = { maximumPins: 1_024, gcChunk: 128 } as const;
const enforcedRootPayloadBytes = 8 * 1_024;
export const ownerVaultProductionLimitsMatchEnforcement = (
  limits: OwnerVaultProductionLimits,
): boolean =>
  limits.catalog.maximumObjects === ownerVaultCatalogMaximumObjects &&
  limits.catalog.maximumObjectBytes === ownerVaultCatalogMaximumObjectBytes &&
  limits.catalog.maximumTotalBytes === ownerVaultCatalogMaximumTotalBytes &&
  limits.catalog.maximumPageEntries === ownerVaultCatalogMaximumPageEntries &&
  limits.catalog.targetPageBytes === ownerVaultCatalogTargetPageBytes &&
  limits.catalog.maximumPageBytes === ownerVaultCatalogMaximumPageBytes &&
  limits.catalog.maximumRootBytes === enforcedRootPayloadBytes &&
  limits.backup.maximumPageBytes === ownerVaultBackupMaximumPageBytes &&
  limits.backup.maximumPageEntries === ownerVaultBackupMaximumPageEntries &&
  limits.backup.maximumObjectBytes === ownerVaultBackupMaximumObjectBytes &&
  limits.backup.maximumTotalBytes === ownerVaultBackupMaximumTotalBytes &&
  limits.backup.maximumManifestBytes === ownerVaultBackupMaximumManifestBytes &&
  limits.backup.maximumRestoreJournalBytes === ownerVaultBackupMaximumRestoreJournalBytes &&
  limits.backup.maximumObjects === ownerVaultBackupMaximumObjects &&
  limits.pins.maximumPins === enforcedPinLimits.maximumPins &&
  limits.pins.gcChunk === enforcedPinLimits.gcChunk;
const object = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const read = (
  source: Readonly<Record<string, unknown>>,
  key: string,
  minimum = 1,
): number | undefined => {
  /** Read the dynamic property once so the predicate's narrowing is kept. */
  const value = source[key];
  return integer(value, minimum) ? value : undefined;
};

const validImmutableR2Binding = (value: unknown): value is ImmutableR2NativeBinding => {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      ["head", "get", "put", "list", "delete"].every(
        (key) => typeof Reflect.get(value, key) === "function",
      )
    );
  } catch {
    return false;
  }
};
const validBlobR2Binding = (value: unknown): value is BlobR2NativeBindingInput => {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      ["head", "get", "put", "delete"].every((key) => typeof Reflect.get(value, key) === "function")
    );
  } catch {
    return false;
  }
};

const freezeLimits = (limits: OwnerVaultProductionLimits): OwnerVaultProductionLimits =>
  Object.freeze({
    ...limits,
    blob: Object.freeze({ ...limits.blob }),
    catalog: Object.freeze({ ...limits.catalog }),
    backup: Object.freeze({ ...limits.backup }),
    pins: Object.freeze({ ...limits.pins }),
    r2: Object.freeze({ ...limits.r2 }),
  });

/** Strict JSON decoder deliberately rejects undeclared or missing caps. */
export const parseOwnerVaultProductionLimits = (
  raw: string,
): OwnerVaultProductionLimits | undefined => {
  try {
    const root = object(JSON.parse(raw));
    if (root === undefined || !exact(root, ["backup", "blob", "catalog", "pins", "r2"]))
      return undefined;
    const blob = object(root.blob);
    const catalog = object(root.catalog);
    const backup = object(root.backup);
    const pins = object(root.pins);
    const r2 = object(root.r2);
    if (
      !blob ||
      !catalog ||
      !backup ||
      !pins ||
      !r2 ||
      !exact(blob, [
        "maximumActiveLeasesPerFinal",
        "maximumActiveLeasesPerVault",
        "maximumBlobBytes",
        "maximumOrphanBytes",
        "maximumOrphanCount",
        "maximumVaultBytes",
        "stageTTLSeconds",
        "tombstoneGraceSeconds",
      ]) ||
      !exact(catalog, [
        "maximumObjectBytes",
        "maximumObjects",
        "maximumPageBytes",
        "maximumPageEntries",
        "maximumRootBytes",
        "maximumTotalBytes",
        "targetPageBytes",
      ]) ||
      !exact(backup, [
        "maximumManifestBytes",
        "maximumObjectBytes",
        "maximumObjects",
        "maximumPageBytes",
        "maximumPageEntries",
        "maximumRestoreJournalBytes",
        "maximumTotalBytes",
      ]) ||
      !exact(pins, ["gcChunk", "maximumPins", "retentionSeconds"]) ||
      !exact(r2, [
        "maximumCursorBytes",
        "maximumKeyBytes",
        "maximumListPageSize",
        "maximumObjectBytes",
      ])
    )
      return undefined;
    const [
      maximumBlobBytes,
      maximumOrphanBytes,
      maximumOrphanCount,
      maximumVaultBytes,
      maximumActiveLeasesPerVault,
      maximumActiveLeasesPerFinal,
      stageTTLSeconds,
      tombstoneGraceSeconds,
    ] = [
      "maximumBlobBytes",
      "maximumOrphanBytes",
      "maximumOrphanCount",
      "maximumVaultBytes",
      "maximumActiveLeasesPerVault",
      "maximumActiveLeasesPerFinal",
      "stageTTLSeconds",
      "tombstoneGraceSeconds",
    ].map((key) =>
      read(blob, key, key === "maximumOrphanBytes" || key === "maximumOrphanCount" ? 0 : 1),
    );
    const [
      maximumObjects,
      maximumCatalogObjectBytes,
      maximumCatalogTotalBytes,
      maximumCatalogPageEntries,
      targetPageBytes,
      maximumCatalogPageBytes,
      maximumRootBytes,
    ] = [
      "maximumObjects",
      "maximumObjectBytes",
      "maximumTotalBytes",
      "maximumPageEntries",
      "targetPageBytes",
      "maximumPageBytes",
      "maximumRootBytes",
    ].map((key) => read(catalog, key));
    const [
      maximumBackupPageBytes,
      maximumBackupPageEntries,
      maximumBackupObjectBytes,
      maximumBackupTotalBytes,
      maximumManifestBytes,
      maximumRestoreJournalBytes,
      maximumBackupObjects,
    ] = [
      "maximumPageBytes",
      "maximumPageEntries",
      "maximumObjectBytes",
      "maximumTotalBytes",
      "maximumManifestBytes",
      "maximumRestoreJournalBytes",
      "maximumObjects",
    ].map((key) => read(backup, key));
    const [maximumPins, gcChunk, retentionSeconds] = [
      "maximumPins",
      "gcChunk",
      "retentionSeconds",
    ].map((key) => read(pins, key));
    const [maximumKeyBytes, maximumR2ObjectBytes, maximumCursorBytes, maximumListPageSize] = [
      "maximumKeyBytes",
      "maximumObjectBytes",
      "maximumCursorBytes",
      "maximumListPageSize",
    ].map((key) => read(r2, key));
    if (
      maximumBlobBytes === undefined ||
      maximumOrphanBytes === undefined ||
      maximumOrphanCount === undefined ||
      maximumVaultBytes === undefined ||
      maximumActiveLeasesPerVault === undefined ||
      maximumActiveLeasesPerFinal === undefined ||
      stageTTLSeconds === undefined ||
      tombstoneGraceSeconds === undefined ||
      maximumObjects === undefined ||
      maximumCatalogObjectBytes === undefined ||
      maximumCatalogTotalBytes === undefined ||
      maximumCatalogPageEntries === undefined ||
      targetPageBytes === undefined ||
      maximumCatalogPageBytes === undefined ||
      maximumRootBytes === undefined ||
      maximumBackupPageBytes === undefined ||
      maximumBackupPageEntries === undefined ||
      maximumBackupObjectBytes === undefined ||
      maximumBackupTotalBytes === undefined ||
      maximumManifestBytes === undefined ||
      maximumRestoreJournalBytes === undefined ||
      maximumBackupObjects === undefined ||
      maximumPins === undefined ||
      gcChunk === undefined ||
      retentionSeconds === undefined ||
      maximumKeyBytes === undefined ||
      maximumR2ObjectBytes === undefined ||
      maximumCursorBytes === undefined ||
      maximumListPageSize === undefined
    )
      return undefined;
    const result: OwnerVaultProductionLimits = {
      blob: {
        maximumBlobBytes,
        maximumOrphanBytes,
        maximumOrphanCount,
        maximumVaultBytes,
        maximumActiveLeasesPerVault,
        maximumActiveLeasesPerFinal,
        stageTTLSeconds,
        tombstoneGraceSeconds,
      },
      catalog: {
        maximumObjects,
        maximumObjectBytes: maximumCatalogObjectBytes,
        maximumTotalBytes: maximumCatalogTotalBytes,
        maximumPageEntries: maximumCatalogPageEntries,
        targetPageBytes,
        maximumPageBytes: maximumCatalogPageBytes,
        maximumRootBytes,
      },
      backup: {
        maximumPageBytes: maximumBackupPageBytes,
        maximumPageEntries: maximumBackupPageEntries,
        maximumObjectBytes: maximumBackupObjectBytes,
        maximumTotalBytes: maximumBackupTotalBytes,
        maximumManifestBytes,
        maximumRestoreJournalBytes,
        maximumObjects: maximumBackupObjects,
      },
      pins: { maximumPins, gcChunk, retentionSeconds },
      r2: {
        maximumKeyBytes,
        maximumObjectBytes: maximumR2ObjectBytes,
        maximumCursorBytes,
        maximumListPageSize,
      },
    };
    const { blob: b, catalog: c, backup: a, pins: p, r2: r } = result;
    return b.maximumBlobBytes <= b.maximumVaultBytes &&
      b.maximumOrphanBytes <= b.maximumVaultBytes &&
      b.maximumActiveLeasesPerVault <= 32 &&
      b.maximumActiveLeasesPerFinal <= b.maximumActiveLeasesPerVault &&
      c.maximumObjectBytes <= c.maximumTotalBytes &&
      c.maximumTotalBytes <= b.maximumVaultBytes &&
      c.maximumObjects === a.maximumObjects &&
      c.maximumObjectBytes === a.maximumObjectBytes &&
      c.maximumTotalBytes === a.maximumTotalBytes &&
      c.maximumPageEntries === a.maximumPageEntries &&
      c.targetPageBytes <= c.maximumPageBytes &&
      c.maximumRootBytes <= c.maximumPageBytes &&
      b.maximumBlobBytes <= r.maximumObjectBytes &&
      a.maximumPageBytes <= r.maximumObjectBytes &&
      a.maximumObjectBytes <= r.maximumObjectBytes &&
      a.maximumManifestBytes <= r.maximumObjectBytes &&
      a.maximumPageEntries <= r.maximumListPageSize &&
      p.gcChunk <= c.maximumPageEntries &&
      p.maximumPins >= 1 &&
      p.retentionSeconds >= b.stageTTLSeconds
      ? freezeLimits(result)
      : undefined;
  } catch {
    return undefined;
  }
};

const manifestKeyID = /^[A-Za-z0-9_-]{1,64}$/u;
const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** Exact canonical base64 decoder; a re-encode mismatch is a rejection. */
const canonicalBase64Bytes = (value: string): Uint8Array | undefined => {
  if (value.length === 0 || value.length > 8_192 || value.length % 4 !== 0) return undefined;
  if (!canonicalBase64.test(value)) return undefined;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
};

const canonicalManifestSPKI = (value: string): boolean => {
  const bytes = canonicalBase64Bytes(value);
  return bytes !== undefined && canonicalP256Spki(bytes) !== undefined;
};
/** Structural check only: byte-level canonical PKCS#8 within runtime bounds.
 * The value itself is never copied into any error, log, or persisted record. */
const structurallyValidPKCS8 = (value: string): boolean => {
  const bytes = canonicalBase64Bytes(value);
  return bytes !== undefined && bytes.byteLength >= 64 && bytes.byteLength <= 512;
};

const parsePrior = (raw: string): readonly ManifestPrior[] | undefined => {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > maximumPriorManifestKeys) return undefined;
    /** The tuple list is constructed only after every member validates. */
    const priors: ManifestPrior[] = [];
    for (const item of value) {
      const entry = object(item);
      if (
        entry === undefined ||
        !exact(entry, ["keyID", "publicKeySPKIDERBase64"]) ||
        typeof entry.keyID !== "string" ||
        !manifestKeyID.test(entry.keyID) ||
        typeof entry.publicKeySPKIDERBase64 !== "string" ||
        !canonicalManifestSPKI(entry.publicKeySPKIDERBase64)
      )
        return undefined;
      priors.push({ keyID: entry.keyID, publicKeySPKIDERBase64: entry.publicKeySPKIDERBase64 });
    }
    return priors;
  } catch {
    return undefined;
  }
};
const parseRevoked = (raw: string): readonly string[] | undefined => {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) &&
      value.every(
        (entry): entry is string => typeof entry === "string" && manifestKeyID.test(entry),
      ) &&
      new Set(value).size === value.length
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Every ring property checkable without Web Crypto fails construction here;
 * only the asynchronous import/pairing proof is left to the eager fiber.
 */
const structurallyValidManifestRing = (input: {
  readonly currentKeyID: string;
  readonly currentPKCS8: string;
  readonly currentSPKI: string;
  readonly prior: readonly ManifestPrior[];
  readonly revoked: readonly string[];
}): boolean => {
  const active = [input.currentKeyID, ...input.prior.map((key) => key.keyID)];
  return (
    manifestKeyID.test(input.currentKeyID) &&
    structurallyValidPKCS8(input.currentPKCS8) &&
    canonicalManifestSPKI(input.currentSPKI) &&
    new Set(active).size === active.length &&
    !active.some((keyID) => input.revoked.includes(keyID))
  );
};

export const makeOwnerVaultProductionAuthority = (input: {
  readonly limitsJSON: string;
  readonly blobR2: unknown;
  readonly backupR2: unknown;
  readonly manifestCurrentKeyID: string;
  readonly manifestCurrentPKCS8: string;
  readonly manifestCurrentSPKI: string;
  readonly manifestPriorKeysJSON: string;
  readonly manifestRevokedKeyIDsJSON: string;
}): OwnerVaultProductionAuthority | undefined => {
  const limits = parseOwnerVaultProductionLimits(input.limitsJSON);
  const prior = parsePrior(input.manifestPriorKeysJSON);
  const revoked = parseRevoked(input.manifestRevokedKeyIDsJSON);
  if (
    !limits ||
    !ownerVaultProductionLimitsMatchEnforcement(limits) ||
    !prior ||
    !revoked ||
    !structurallyValidManifestRing({
      currentKeyID: input.manifestCurrentKeyID,
      currentPKCS8: input.manifestCurrentPKCS8,
      currentSPKI: input.manifestCurrentSPKI,
      prior,
      revoked,
    }) ||
    !validBlobR2Binding(input.blobR2) ||
    !validImmutableR2Binding(input.backupR2) ||
    input.blobR2 === input.backupR2
  )
    return undefined;
  /**
   * The Web Crypto pairing proof starts here, during composition, and its
   * exit (success or failure) is the one cached ring authority for the
   * isolate. `manifestKeys` only ever replays that exit: first use cannot
   * trigger validation and a failed ring never silently revalidates.
   */
  const ringFiber = Effect.runFork(
    Effect.exit(
      makeManifestP256KeyRing({
        current: {
          keyID: input.manifestCurrentKeyID,
          privateKeyPKCS8Base64: Redacted.make(input.manifestCurrentPKCS8),
          publicKeySPKIDERBase64: input.manifestCurrentSPKI,
        },
        prior,
        revokedKeyIDs: revoked,
      }),
    ),
  );
  const manifestKeys = (): Effect.Effect<ManifestP256KeyRing, ManifestKeyRingConfigurationError> =>
    Effect.flatten(Fiber.join(ringFiber));
  const blobR2: OwnerVaultBlobR2Binding = Object.freeze({
    purpose: "owner-vault-blob-r2",
    native: makeBlobR2NativeBinding(input.blobR2),
  });
  const backupR2: OwnerVaultBackupR2Binding = Object.freeze({
    purpose: "owner-vault-backup-r2",
    native: input.backupR2,
  });
  return Object.freeze({ limits, manifestKeys, blobR2, backupR2 });
};
