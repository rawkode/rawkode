import { type CanonicalJSON, canonicalJSONStringify } from "@enchiridion/protocol";
/** @enchiridion/effect-module */
/**
 * A restore trusts this proof only through the production manifest ring that
 * is already injected into its target.  It never accepts a source SPKI or a
 * caller-selected verifier.
 */
import type { ManifestSigner, ManifestVerifier } from "@enchiridion/runtime";
import { Effect } from "effect";

export const sourceSnapshotPublicationPrefix =
  "enchiridion:owner-vault:source-snapshot-publication:v1\0";

export interface SourceSnapshotPublicationV1 {
  readonly schema: "source-snapshot-publication-v1";
  readonly authority: "owner-vault-production-manifest-ring-v1";
  readonly algorithm: "ES256-P256-canonical-low-s-der";
  readonly publication: {
    readonly category: "owner-vault.snapshot-pin";
    readonly schema: "snapshot-pin-v2";
    readonly state: "COMPLETED";
  };
  readonly sourceRoot: {
    readonly ownerID: string;
    readonly vaultID: string;
    readonly generationEpoch: number;
    readonly namespaceState: "PRIVATE";
  };
  readonly backupID: string;
  readonly manifestDigest: string;
  readonly snapshotOperationID: string;
  readonly snapshotJTI: string;
  readonly snapshotCommandSHA256: string;
  readonly signingKeyID: string;
}

export interface SignedSourceSnapshotPublicationV1 extends SourceSnapshotPublicationV1 {
  readonly signature: {
    readonly keyID: string;
    readonly signatureDERBase64: string;
  };
}

const identifier = /^[A-Za-z0-9_-]{16,128}$/u;
const digest = /^[a-f0-9]{64}$/u;
const manifestDigest = /^[A-Za-z0-9_-]{43}$/u;
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const canonicalDERBase64 = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9+/]+={0,2}$/u.test(value) &&
  (() => {
    try {
      return btoa(atob(value)) === value;
    } catch {
      return false;
    }
  })();

const body = (proof: SourceSnapshotPublicationV1): CanonicalJSON => ({
  schema: proof.schema,
  authority: proof.authority,
  algorithm: proof.algorithm,
  publication: proof.publication,
  sourceRoot: proof.sourceRoot,
  backupID: proof.backupID,
  manifestDigest: proof.manifestDigest,
  snapshotOperationID: proof.snapshotOperationID,
  snapshotJTI: proof.snapshotJTI,
  snapshotCommandSHA256: proof.snapshotCommandSHA256,
  signingKeyID: proof.signingKeyID,
});

export const sourceSnapshotPublicationCanonicalBytes = (
  proof: SourceSnapshotPublicationV1,
): Uint8Array | undefined =>
  validSourceSnapshotPublication(proof)
    ? new TextEncoder().encode(
        `${sourceSnapshotPublicationPrefix}${canonicalJSONStringify(body(proof))}`,
      )
    : undefined;

export const validSourceSnapshotPublication = (
  value: unknown,
): value is SourceSnapshotPublicationV1 => {
  const source = record(value);
  const publication = source === undefined ? undefined : record(source.publication);
  const sourceRoot = source === undefined ? undefined : record(source.sourceRoot);
  return (
    source !== undefined &&
    exact(source, [
      "schema",
      "authority",
      "algorithm",
      "publication",
      "sourceRoot",
      "backupID",
      "manifestDigest",
      "snapshotOperationID",
      "snapshotJTI",
      "snapshotCommandSHA256",
      "signingKeyID",
    ]) &&
    source.schema === "source-snapshot-publication-v1" &&
    source.authority === "owner-vault-production-manifest-ring-v1" &&
    source.algorithm === "ES256-P256-canonical-low-s-der" &&
    publication !== undefined &&
    exact(publication, ["category", "schema", "state"]) &&
    publication.category === "owner-vault.snapshot-pin" &&
    publication.schema === "snapshot-pin-v2" &&
    publication.state === "COMPLETED" &&
    sourceRoot !== undefined &&
    exact(sourceRoot, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) &&
    typeof sourceRoot.ownerID === "string" &&
    sourceRoot.ownerID.length > 0 &&
    typeof sourceRoot.vaultID === "string" &&
    sourceRoot.vaultID.length > 0 &&
    positive(sourceRoot.generationEpoch) &&
    sourceRoot.namespaceState === "PRIVATE" &&
    typeof source.backupID === "string" &&
    identifier.test(source.backupID) &&
    typeof source.manifestDigest === "string" &&
    manifestDigest.test(source.manifestDigest) &&
    typeof source.snapshotOperationID === "string" &&
    identifier.test(source.snapshotOperationID) &&
    typeof source.snapshotJTI === "string" &&
    identifier.test(source.snapshotJTI) &&
    typeof source.snapshotCommandSHA256 === "string" &&
    digest.test(source.snapshotCommandSHA256) &&
    typeof source.signingKeyID === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/u.test(source.signingKeyID)
  );
};

/** Structural gate used by the closed restore command decoder. Crypto is
 * deliberately performed later, after ovdc1 HMAC verification. */
export const validSignedSourceSnapshotPublication = (
  value: unknown,
): value is SignedSourceSnapshotPublicationV1 => {
  const source = record(value);
  const signature = source === undefined ? undefined : record(source.signature);
  const body =
    source === undefined
      ? undefined
      : Object.fromEntries(Object.entries(source).filter(([key]) => key !== "signature"));
  return (
    body !== undefined &&
    validSourceSnapshotPublication(body) &&
    signature !== undefined &&
    exact(signature, ["keyID", "signatureDERBase64"]) &&
    typeof signature.keyID === "string" &&
    signature.keyID === body.signingKeyID &&
    canonicalDERBase64(signature.signatureDERBase64)
  );
};

export const signSourceSnapshotPublication = (
  signer: ManifestSigner,
  input: Omit<SourceSnapshotPublicationV1, "signingKeyID">,
): Effect.Effect<SignedSourceSnapshotPublicationV1, unknown> =>
  Effect.suspend(() => {
    const proof = { ...input, signingKeyID: signer.keyID } as const;
    const bytes = sourceSnapshotPublicationCanonicalBytes(proof);
    return bytes === undefined
      ? Effect.fail(new Error("invalid source snapshot publication"))
      : signer
          .signCanonical(bytes)
          .pipe(
            Effect.flatMap((signature) =>
              signature.keyID === proof.signingKeyID
                ? Effect.succeed({ ...proof, signature })
                : Effect.fail(new Error("manifest signing key changed during publication")),
            ),
          );
  });

export const verifySourceSnapshotPublication = (
  verifier: ManifestVerifier,
  value: unknown,
): Effect.Effect<SourceSnapshotPublicationV1, unknown> => {
  if (!validSignedSourceSnapshotPublication(value))
    return Effect.fail(new Error("invalid source snapshot publication"));
  const { signature, ...bodyValue } = value;
  const bytes = sourceSnapshotPublicationCanonicalBytes(bodyValue);
  return bytes === undefined
    ? Effect.fail(new Error("invalid source snapshot publication"))
    : verifier.verifyCanonical(bytes, signature).pipe(Effect.as(bodyValue));
};
