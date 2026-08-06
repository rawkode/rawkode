import {
  parseJSONWithoutDuplicateMembers,
  protocolVersion,
  sha256Hex,
} from "@enchiridion/protocol";
import type { OwnerID, VaultID } from "../foundation/schemas";
import { isOwnerID, isVaultID, ownerID, vaultID } from "../foundation/schemas";
import type {
  BackupLimits,
  BackupManifest,
  BackupManifestObject,
  BackupObjectKind,
  BackupScope,
  SignedBackupManifest,
} from "./types";
import { defaultBackupLimits } from "./types";

const sourceID = /^[A-Za-z0-9._~-]{1,128}$/u;
const backupID = /^[A-Za-z0-9_-]{16,128}$/u;
const sha256Base64 = /^[A-Za-z0-9+/]{43}=$/u;
const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((candidate) => Object.hasOwn(value, candidate));

export const backupObjectKinds: readonly BackupObjectKind[] = [
  "blob",
  "device",
  "document",
  "receipt",
  "session",
  "tombstone",
];

const isBackupObjectKind = (value: string): value is BackupObjectKind =>
  value === "blob" ||
  value === "device" ||
  value === "document" ||
  value === "receipt" ||
  value === "session" ||
  value === "tombstone";

/** Locale-independent UTF-16 code-unit order, shared by all signing input. */
export const compareUTF16 = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

const canonicalBase64 = (value: string, maximumLength = 8_192): boolean => {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  )
    return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
};

export const isCanonicalSHA256Base64 = (value: string): boolean =>
  value.length === 44 && sha256Base64.test(value) && canonicalBase64(value, 44);

const base64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

export const canonicalSHA256Base64 = (bytes: Uint8Array): string => {
  const digest = sha256Hex(bytes);
  const binary = new Uint8Array(32);
  for (let index = 0; index < binary.byteLength; index += 1)
    binary[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  return base64(binary);
};

export const validBackupScope = (scope: BackupScope): boolean =>
  isOwnerID(scope.ownerID) &&
  isVaultID(scope.vaultID) &&
  safeInteger(scope.generationEpoch) &&
  scope.generationEpoch > 0;

export const backupArchivePrefix = (scope: BackupScope, id: string): string | undefined =>
  validBackupScope(scope) && backupID.test(id)
    ? `v1/vaults/${scope.ownerID.value}/${scope.vaultID.value}/${scope.generationEpoch}/backups/${id}/`
    : undefined;

export const backupObjectKey = (
  scope: BackupScope,
  id: string,
  kind: BackupObjectKind,
  source: string,
): string | undefined => {
  const prefix = backupArchivePrefix(scope, id);
  return prefix === undefined || !isBackupObjectKind(kind) || !sourceID.test(source)
    ? undefined
    : `${prefix}objects/${kind}/${source}`;
};

export const backupManifestKey = (scope: BackupScope, id: string): string | undefined => {
  const prefix = backupArchivePrefix(scope, id);
  return prefix === undefined ? undefined : `${prefix}manifest.json`;
};

/** Rejects a key unless rebuilding it produces the exact wire path. */
export const parseBackupObjectKey = (
  scope: BackupScope,
  id: string,
  key: string,
): { readonly kind: BackupObjectKind; readonly sourceID: string } | undefined => {
  const prefix = backupArchivePrefix(scope, id);
  if (prefix === undefined || !key.startsWith(`${prefix}objects/`)) return undefined;
  const tail = key.slice(`${prefix}objects/`.length).split("/");
  if (tail.length !== 2) return undefined;
  const [kind, parsedSourceID] = tail;
  if (
    kind === undefined ||
    parsedSourceID === undefined ||
    !isBackupObjectKind(kind) ||
    !sourceID.test(parsedSourceID)
  )
    return undefined;
  const rebuilt = backupObjectKey(scope, id, kind, parsedSourceID);
  return rebuilt === key ? { kind, sourceID: parsedSourceID } : undefined;
};

const validObject = (scope: BackupScope, id: string, object: BackupManifestObject): boolean => {
  const parsed = parseBackupObjectKey(scope, id, object.key);
  return (
    parsed !== undefined &&
    parsed.kind === object.kind &&
    isCanonicalSHA256Base64(object.sha256Base64) &&
    safeInteger(object.size)
  );
};

const objectJSON = (object: BackupManifestObject) => ({
  key: object.key,
  kind: object.kind,
  sha256Base64: object.sha256Base64,
  size: object.size,
});

/** Digest of the exact, sorted category inventory captured at the high-water. */
export const catalogDigest = (objects: readonly BackupManifestObject[]): string => {
  const text = JSON.stringify(
    [...objects].sort((left, right) => compareUTF16(left.key, right.key)).map(objectJSON),
  );
  return canonicalSHA256Base64(new TextEncoder().encode(text));
};

const completeInventory = (objects: readonly BackupManifestObject[]): boolean => {
  const present = new Set(objects.map((object) => object.kind));
  return backupObjectKinds.every((kind) => present.has(kind));
};

const validManifest = (manifest: BackupManifest, limits: BackupLimits): boolean => {
  const totalBytes = manifest.objects.reduce((total, object) => total + object.size, 0);
  const sorted = [...manifest.objects].sort((left, right) => compareUTF16(left.key, right.key));
  return (
    manifest.version === 1 &&
    backupID.test(manifest.backupID) &&
    validBackupScope(manifest.scope) &&
    isCanonicalSHA256Base64(manifest.highWaterMark) &&
    validEpoch(manifest.routingEpoch) &&
    validEpoch(manifest.controlEpoch) &&
    validEpoch(manifest.credentialEpoch) &&
    manifest.generationEpoch === manifest.scope.generationEpoch &&
    safeInteger(manifest.createdAtMilliseconds) &&
    safeInteger(manifest.expiresAtMilliseconds) &&
    manifest.expiresAtMilliseconds > manifest.createdAtMilliseconds &&
    manifest.expiresAtMilliseconds - manifest.createdAtMilliseconds <=
      limits.maximumManifestLifetimeMilliseconds &&
    manifest.protocolVersion === protocolVersion &&
    manifest.schemaVersion === 1 &&
    manifest.objects.length >= backupObjectKinds.length &&
    manifest.objects.length <= limits.maximumObjects &&
    totalBytes <= limits.maximumTotalObjectBytes &&
    completeInventory(manifest.objects) &&
    manifest.objects.every(
      (object) =>
        object.size <= limits.maximumObjectBytes &&
        validObject(manifest.scope, manifest.backupID, object),
    ) &&
    sorted.every((object, index) => object === manifest.objects[index]) &&
    sorted.every((object, index) => index === 0 || sorted[index - 1]?.key !== object.key) &&
    manifest.catalogDigest === catalogDigest(manifest.objects)
  );
};

const validEpoch = (value: unknown): value is number => safeInteger(value);

/** UTF-8 canonical signing bytes: fixed order, ASCII keys, and UTF-16 ordering. */
export const canonicalManifestBytes = (
  manifest: BackupManifest,
  limits: BackupLimits = defaultBackupLimits,
): Uint8Array | undefined =>
  validManifest(manifest, limits)
    ? new TextEncoder().encode(
        JSON.stringify({
          backupID: manifest.backupID,
          catalogDigest: manifest.catalogDigest,
          controlEpoch: manifest.controlEpoch,
          createdAtMilliseconds: manifest.createdAtMilliseconds,
          credentialEpoch: manifest.credentialEpoch,
          expiresAtMilliseconds: manifest.expiresAtMilliseconds,
          generationEpoch: manifest.generationEpoch,
          highWaterMark: manifest.highWaterMark,
          objects: manifest.objects.map(objectJSON),
          protocolVersion: manifest.protocolVersion,
          routingEpoch: manifest.routingEpoch,
          schemaVersion: manifest.schemaVersion,
          scope: {
            generationEpoch: manifest.scope.generationEpoch,
            ownerID: manifest.scope.ownerID.value,
            vaultID: manifest.scope.vaultID.value,
          },
          version: manifest.version,
        }),
      )
    : undefined;

export const canonicalSignedManifestBytes = (
  signed: SignedBackupManifest,
  limits: BackupLimits = defaultBackupLimits,
): Uint8Array | undefined => {
  const bytes = canonicalManifestBytes(signed.manifest, limits);
  if (
    bytes === undefined ||
    !sourceID.test(signed.signature.keyID) ||
    !canonicalBase64(signed.signature.signatureDERBase64)
  )
    return undefined;
  return new TextEncoder().encode(
    JSON.stringify({
      manifest: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      signature: {
        keyID: signed.signature.keyID,
        signatureDERBase64: signed.signature.signatureDERBase64,
      },
    }),
  );
};

const decodeScope = (value: unknown): BackupScope | undefined => {
  if (!isRecord(value) || !exact(value, ["ownerID", "vaultID", "generationEpoch"]))
    return undefined;
  const parsedOwner = ownerID(value.ownerID);
  const parsedVault = vaultID(value.vaultID);
  if (parsedOwner === undefined || parsedVault === undefined || !safeInteger(value.generationEpoch))
    return undefined;
  const scope = {
    ownerID: parsedOwner,
    vaultID: parsedVault,
    generationEpoch: value.generationEpoch,
  };
  return validBackupScope(scope) ? scope : undefined;
};

const decodeObject = (value: unknown): BackupManifestObject | undefined => {
  if (!isRecord(value) || !exact(value, ["key", "kind", "sha256Base64", "size"])) return undefined;
  if (
    typeof value.key !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.sha256Base64 !== "string" ||
    !safeInteger(value.size) ||
    !isBackupObjectKind(value.kind)
  )
    return undefined;
  return { key: value.key, kind: value.kind, sha256Base64: value.sha256Base64, size: value.size };
};

/** Decodes only byte-for-byte canonical, duplicate-free signed-manifest input. */
export const decodeSignedBackupManifest = (
  source: string,
  limits: BackupLimits = defaultBackupLimits,
): SignedBackupManifest | undefined => {
  if (new TextEncoder().encode(source).byteLength > limits.maximumManifestBytes) return undefined;
  try {
    const root = parseJSONWithoutDuplicateMembers(source);
    if (
      !isRecord(root) ||
      !exact(root, ["manifest", "signature"]) ||
      !isRecord(root.manifest) ||
      !isRecord(root.signature)
    )
      return undefined;
    const raw = root.manifest;
    if (
      !exact(raw, [
        "backupID",
        "catalogDigest",
        "controlEpoch",
        "createdAtMilliseconds",
        "credentialEpoch",
        "expiresAtMilliseconds",
        "generationEpoch",
        "highWaterMark",
        "objects",
        "protocolVersion",
        "routingEpoch",
        "schemaVersion",
        "scope",
        "version",
      ]) ||
      typeof raw.backupID !== "string" ||
      typeof raw.catalogDigest !== "string" ||
      typeof raw.highWaterMark !== "string" ||
      !validEpoch(raw.controlEpoch) ||
      !safeInteger(raw.createdAtMilliseconds) ||
      !validEpoch(raw.credentialEpoch) ||
      !safeInteger(raw.expiresAtMilliseconds) ||
      !validEpoch(raw.generationEpoch) ||
      !validEpoch(raw.routingEpoch) ||
      !Array.isArray(raw.objects) ||
      raw.protocolVersion !== protocolVersion ||
      raw.schemaVersion !== 1 ||
      raw.version !== 1
    )
      return undefined;
    const scope = decodeScope(raw.scope);
    const objects = raw.objects.map(decodeObject);
    if (scope === undefined || objects.some((object) => object === undefined)) return undefined;
    const complete: BackupManifestObject[] = [];
    for (const object of objects) if (object !== undefined) complete.push(object);
    const signature = root.signature;
    if (
      !exact(signature, ["keyID", "signatureDERBase64"]) ||
      typeof signature.keyID !== "string" ||
      typeof signature.signatureDERBase64 !== "string"
    )
      return undefined;
    const signed: SignedBackupManifest = {
      manifest: {
        version: 1,
        backupID: raw.backupID,
        catalogDigest: raw.catalogDigest,
        controlEpoch: raw.controlEpoch,
        createdAtMilliseconds: raw.createdAtMilliseconds,
        credentialEpoch: raw.credentialEpoch,
        expiresAtMilliseconds: raw.expiresAtMilliseconds,
        generationEpoch: raw.generationEpoch,
        highWaterMark: raw.highWaterMark,
        objects: complete,
        protocolVersion,
        routingEpoch: raw.routingEpoch,
        schemaVersion: 1,
        scope,
      },
      signature: { keyID: signature.keyID, signatureDERBase64: signature.signatureDERBase64 },
    };
    const canonical = canonicalSignedManifestBytes(signed, limits);
    return canonical !== undefined &&
      new TextDecoder("utf-8", { fatal: true }).decode(canonical) === source
      ? signed
      : undefined;
  } catch {
    return undefined;
  }
};
