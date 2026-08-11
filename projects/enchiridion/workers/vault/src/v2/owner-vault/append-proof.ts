/** @enchiridion/effect-module */
import { sha256Hex } from "@enchiridion/protocol";
import { canonicalOwnerVaultBackupBytes } from "./backup-canonical";

/**
 * Canonical, source-scoped append proof. D0 is deliberately independent of
 * catalog identity; Dn binds only the previous digest and the exact append
 * entry bytes. This lets a restored target rebuild its catalog under a new
 * private generation without changing the source append proof.
 */
export interface OwnerVaultAppendProofEntry {
  readonly operationID: string;
  readonly fingerprint: string;
  readonly payloadHash: string;
  readonly payloadBase64: string;
  readonly source: "http" | "websocket";
  readonly deviceID: string;
  readonly logSequence: number;
}

export interface OwnerVaultAppendProof {
  readonly appendLogSequence: number;
  readonly appendLogDigest: string;
}

const canonical = (value: unknown): Uint8Array | undefined => canonicalOwnerVaultBackupBytes(value);
const appendIdentifier = (logSequence: number): string | undefined =>
  Number.isSafeInteger(logSequence) && logSequence > 0 && logSequence <= 9_999_999_999_999_999_999
    ? String(logSequence).padStart(20, "0")
    : undefined;

export const ownerVaultAppendProofD0 = (scope: {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
}): string =>
  sha256Hex(
    canonical({
      domain: "enchiridion-owner-vault-append-v1",
      generationEpoch: scope.generationEpoch,
      ownerID: scope.ownerID,
      vaultID: scope.vaultID,
    })!,
  );

export const ownerVaultAppendProofDn = (
  previousDigest: string,
  entry: OwnerVaultAppendProofEntry,
): string | undefined => {
  const identifier = appendIdentifier(entry.logSequence);
  const bytes =
    identifier === undefined
      ? undefined
      : canonical({
          address: { category: "append-log.entry", identifier },
          entry,
          previousDigest,
        });
  return bytes === undefined ? undefined : sha256Hex(bytes);
};

export const ownerVaultAppendProofNext = (
  scope: { readonly ownerID: string; readonly vaultID: string; readonly generationEpoch: number },
  previous: OwnerVaultAppendProof,
  entry: OwnerVaultAppendProofEntry,
): OwnerVaultAppendProof | undefined => {
  if (
    !Number.isSafeInteger(previous.appendLogSequence) ||
    previous.appendLogSequence < 0 ||
    entry.logSequence !== previous.appendLogSequence + 1
  )
    return undefined;
  const seed =
    previous.appendLogSequence === 0 ? ownerVaultAppendProofD0(scope) : previous.appendLogDigest;
  const appendLogDigest = ownerVaultAppendProofDn(seed, entry);
  return appendLogDigest === undefined
    ? undefined
    : { appendLogSequence: entry.logSequence, appendLogDigest };
};

export const ownerVaultAppendProofValidate = (
  scope: { readonly ownerID: string; readonly vaultID: string; readonly generationEpoch: number },
  entries: readonly OwnerVaultAppendProofEntry[],
): OwnerVaultAppendProof | undefined => {
  let proof: OwnerVaultAppendProof = {
    appendLogSequence: 0,
    appendLogDigest: ownerVaultAppendProofD0(scope),
  };
  for (const entry of entries) {
    const next = ownerVaultAppendProofNext(scope, proof, entry);
    if (next === undefined) return undefined;
    proof = next;
  }
  return proof;
};
