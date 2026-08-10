/** @enchiridion/effect-module */
import {
  type ImmutableR2NativeBinding,
  type ManifestP256KeyRing,
  makeManifestP256KeyRing,
} from "@enchiridion/runtime";
import { Effect, Redacted } from "effect";
import type { BlobLimits } from "../blobs/blobs";

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
  readonly pins: { readonly maximumPins: number; readonly gcChunk: number; readonly retentionSeconds: number };
  readonly r2: { readonly maximumKeyBytes: number; readonly maximumObjectBytes: number; readonly maximumCursorBytes: number; readonly maximumListPageSize: number };
}

export interface OwnerVaultProductionAuthority {
  readonly limits: OwnerVaultProductionLimits;
  readonly manifestKeys: ManifestP256KeyRing;
  /** Separate binding positions are intentional: blob stages never use archive R2. */
  readonly blobR2: ImmutableR2NativeBinding;
  readonly backupR2: ImmutableR2NativeBinding;
}

interface ManifestPrior { readonly keyID: string; readonly publicKeySPKIDERBase64: string }
const object = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : undefined;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const read = (source: Readonly<Record<string, unknown>>, key: string): number | undefined =>
  integer(source[key]) ? source[key] as number : undefined;

const validR2Binding = (value: unknown): value is ImmutableR2NativeBinding => {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      ["head", "get", "put", "list", "delete"].every((key) => typeof Reflect.get(value, key) === "function");
  } catch { return false; }
};

const freezeLimits = (limits: OwnerVaultProductionLimits): OwnerVaultProductionLimits => Object.freeze({
  ...limits,
  blob: Object.freeze({ ...limits.blob }),
  catalog: Object.freeze({ ...limits.catalog }),
  backup: Object.freeze({ ...limits.backup }),
  pins: Object.freeze({ ...limits.pins }),
  r2: Object.freeze({ ...limits.r2 }),
});
const freezeManifestKeys = (keys: ManifestP256KeyRing): ManifestP256KeyRing => Object.freeze({
  ...keys,
  current: Object.freeze({ ...keys.current }),
  prior: Object.freeze(keys.prior.map((key) => Object.freeze({ ...key }))),
  revokedKeyIDs: Object.freeze([...keys.revokedKeyIDs]),
});

/** Strict JSON decoder deliberately rejects undeclared or missing caps. */
export const parseOwnerVaultProductionLimits = (raw: string): OwnerVaultProductionLimits | undefined => {
  try {
    const root = object(JSON.parse(raw));
    if (root === undefined || !exact(root, ["backup", "blob", "catalog", "pins", "r2"])) return undefined;
    const blob = object(root.blob); const catalog = object(root.catalog); const backup = object(root.backup);
    const pins = object(root.pins); const r2 = object(root.r2);
    if (!blob || !catalog || !backup || !pins || !r2 ||
      !exact(blob, ["maximumActiveLeasesPerFinal", "maximumActiveLeasesPerVault", "maximumBlobBytes", "maximumOrphanBytes", "maximumOrphanCount", "maximumVaultBytes", "stageTTLSeconds", "tombstoneGraceSeconds"]) ||
      !exact(catalog, ["maximumObjectBytes", "maximumObjects", "maximumPageBytes", "maximumPageEntries", "maximumRootBytes", "maximumTotalBytes", "targetPageBytes"]) ||
      !exact(backup, ["maximumManifestBytes", "maximumObjectBytes", "maximumObjects", "maximumPageBytes", "maximumPageEntries", "maximumRestoreJournalBytes", "maximumTotalBytes"]) ||
      !exact(pins, ["gcChunk", "maximumPins", "retentionSeconds"]) ||
      !exact(r2, ["maximumCursorBytes", "maximumKeyBytes", "maximumListPageSize", "maximumObjectBytes"])) return undefined;
    const values = [
      "maximumBlobBytes", "maximumOrphanBytes", "maximumOrphanCount", "maximumVaultBytes", "maximumActiveLeasesPerVault", "maximumActiveLeasesPerFinal", "stageTTLSeconds", "tombstoneGraceSeconds",
    ].map((key) => read(blob, key));
    const catalogValues = ["maximumObjects", "maximumObjectBytes", "maximumTotalBytes", "maximumPageEntries", "targetPageBytes", "maximumPageBytes", "maximumRootBytes"].map((key) => read(catalog, key));
    const backupValues = ["maximumPageBytes", "maximumPageEntries", "maximumObjectBytes", "maximumTotalBytes", "maximumManifestBytes", "maximumRestoreJournalBytes", "maximumObjects"].map((key) => read(backup, key));
    const pinValues = ["maximumPins", "gcChunk", "retentionSeconds"].map((key) => read(pins, key));
    const r2Values = ["maximumKeyBytes", "maximumObjectBytes", "maximumCursorBytes", "maximumListPageSize"].map((key) => read(r2, key));
    if ([...values, ...catalogValues, ...backupValues, ...pinValues, ...r2Values].some((value) => value === undefined)) return undefined;
    const result: OwnerVaultProductionLimits = {
      blob: { maximumBlobBytes: values[0]!, maximumOrphanBytes: values[1]!, maximumOrphanCount: values[2]!, maximumVaultBytes: values[3]!, maximumActiveLeasesPerVault: values[4]!, maximumActiveLeasesPerFinal: values[5]!, stageTTLSeconds: values[6]!, tombstoneGraceSeconds: values[7]! },
      catalog: { maximumObjects: catalogValues[0]!, maximumObjectBytes: catalogValues[1]!, maximumTotalBytes: catalogValues[2]!, maximumPageEntries: catalogValues[3]!, targetPageBytes: catalogValues[4]!, maximumPageBytes: catalogValues[5]!, maximumRootBytes: catalogValues[6]! },
      backup: { maximumPageBytes: backupValues[0]!, maximumPageEntries: backupValues[1]!, maximumObjectBytes: backupValues[2]!, maximumTotalBytes: backupValues[3]!, maximumManifestBytes: backupValues[4]!, maximumRestoreJournalBytes: backupValues[5]!, maximumObjects: backupValues[6]! },
      pins: { maximumPins: pinValues[0]!, gcChunk: pinValues[1]!, retentionSeconds: pinValues[2]! },
      r2: { maximumKeyBytes: r2Values[0]!, maximumObjectBytes: r2Values[1]!, maximumCursorBytes: r2Values[2]!, maximumListPageSize: r2Values[3]! },
    };
    const { blob: b, catalog: c, backup: a, pins: p, r2: r } = result;
    return b.maximumBlobBytes <= b.maximumVaultBytes && b.maximumOrphanBytes <= b.maximumVaultBytes &&
      b.maximumActiveLeasesPerVault <= 32 && b.maximumActiveLeasesPerFinal <= b.maximumActiveLeasesPerVault &&
      c.maximumObjectBytes <= c.maximumTotalBytes && c.maximumTotalBytes <= b.maximumVaultBytes && c.maximumObjects === a.maximumObjects &&
      c.maximumObjectBytes === a.maximumObjectBytes && c.maximumTotalBytes === a.maximumTotalBytes &&
      c.maximumPageEntries === a.maximumPageEntries && c.targetPageBytes <= c.maximumPageBytes && c.maximumRootBytes <= c.maximumPageBytes &&
      a.maximumPageBytes <= r.maximumObjectBytes && a.maximumObjectBytes <= r.maximumObjectBytes && a.maximumPageEntries <= r.maximumListPageSize &&
      p.gcChunk <= c.maximumPageEntries && p.maximumPins >= 1 && p.retentionSeconds >= b.stageTTLSeconds
      ? freezeLimits(result) : undefined;
  } catch { return undefined; }
};

const parsePrior = (raw: string): readonly ManifestPrior[] | undefined => {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => {
      const entry = object(item);
      return entry !== undefined && exact(entry, ["keyID", "publicKeySPKIDERBase64"]) &&
        typeof entry.keyID === "string" && typeof entry.publicKeySPKIDERBase64 === "string";
    }) ? value as readonly ManifestPrior[] : undefined;
  } catch { return undefined; }
};
const parseRevoked = (raw: string): readonly string[] | undefined => {
  try { const value = JSON.parse(raw); return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined; } catch { return undefined; }
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
  if (!limits || !prior || !revoked || !validR2Binding(input.blobR2) || !validR2Binding(input.backupR2) || input.blobR2 === input.backupR2) return undefined;
  try {
    const manifestKeys = Effect.runSync(makeManifestP256KeyRing({
      current: { keyID: input.manifestCurrentKeyID, privateKeyPKCS8Base64: Redacted.make(input.manifestCurrentPKCS8), publicKeySPKIDERBase64: input.manifestCurrentSPKI },
      prior,
      revokedKeyIDs: revoked,
    }));
    return Object.freeze({ limits, manifestKeys: freezeManifestKeys(manifestKeys), blobR2: input.blobR2, backupR2: input.backupR2 });
  } catch { return undefined; }
};
