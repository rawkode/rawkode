/** @enchiridion/effect-module */
import { sha256Hex } from "@enchiridion/protocol";

const identifier = /^[A-Za-z0-9_-]{1,128}$/u;
const digest = /^[a-f0-9]{64}$/u;

const canonicalBase64Bytes = (value: string): Uint8Array | undefined => {
  try {
    const binary = atob(value);
    if (btoa(binary) !== value) return undefined;
    return Uint8Array.from(binary, (entry) => entry.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/**
 * The durable append identity deliberately excludes every transport fence.
 * HTTP signatures, WebSocket frame IDs, capability JTIs, and session nonces
 * are independently verified before the append transaction; including them
 * here would make a reconnect create a second logical mutation.
 */
export const ownerVaultOpaqueMutationFingerprint = (input: {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly operationID: string;
  readonly payloadSHA256: string;
  readonly payloadBase64: string;
  /** A lower-bound assertion over the append log, never a transport counter. */
  readonly observedHighWater: number;
}): string | undefined => {
  if (
    !identifier.test(input.ownerID) ||
    !identifier.test(input.vaultID) ||
    !Number.isSafeInteger(input.generationEpoch) ||
    input.generationEpoch < 1 ||
    !identifier.test(input.operationID) ||
    !digest.test(input.payloadSHA256) ||
    !Number.isSafeInteger(input.observedHighWater) ||
    input.observedHighWater < 0
  )
    return undefined;
  const payload = canonicalBase64Bytes(input.payloadBase64);
  if (payload === undefined || sha256Hex(payload) !== input.payloadSHA256) return undefined;
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        ownerID: input.ownerID,
        vaultID: input.vaultID,
        generationEpoch: input.generationEpoch,
        operationID: input.operationID,
        payloadSHA256: input.payloadSHA256,
        payloadBytes: payload.byteLength,
        observedHighWater: input.observedHighWater,
      }),
    ),
  );
};
