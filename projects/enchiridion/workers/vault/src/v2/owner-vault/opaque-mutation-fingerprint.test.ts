import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@enchiridion/protocol";
import { ownerVaultOpaqueMutationFingerprint } from "./opaque-mutation-fingerprint";

const payload = new Uint8Array([1, 2, 3]);
const input = {
  ownerID: "owner-0001",
  vaultID: "vault-0001",
  generationEpoch: 2,
  operationID: "operation-0001",
  payloadSHA256: sha256Hex(payload),
  payloadBase64: "AQID",
  observedHighWater: 7,
} as const;

describe("ownerVaultOpaqueMutationFingerprint", () => {
  test("is transport-independent but binds logical scope, bytes, and lower bound", () => {
    const http = ownerVaultOpaqueMutationFingerprint(input);
    const websocket = ownerVaultOpaqueMutationFingerprint({ ...input });
    expect(http).toBe(websocket);
    expect(ownerVaultOpaqueMutationFingerprint({ ...input, observedHighWater: 8 })).not.toBe(http);
    expect(ownerVaultOpaqueMutationFingerprint({ ...input, operationID: "operation-0002" })).not.toBe(http);
  });

  test("rejects non-canonical payload encodings and hash substitutions", () => {
    expect(ownerVaultOpaqueMutationFingerprint({ ...input, payloadBase64: "AQID=" })).toBeUndefined();
    expect(
      ownerVaultOpaqueMutationFingerprint({
        ...input,
        payloadSHA256: sha256Hex(new Uint8Array([4, 5, 6])),
      }),
    ).toBeUndefined();
  });
});
