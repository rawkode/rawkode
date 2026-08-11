import { describe, expect, test } from "bun:test";
import { ownerVaultAppendProofDn, ownerVaultAppendProofValidate } from "./append-proof";

const scope = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 1 };
const entry = (logSequence: number, operationID = `operation-${logSequence}`) => ({
  deviceID: "device-1",
  fingerprint: "a".repeat(64),
  logSequence,
  operationID,
  payloadBase64: "opaque",
  payloadHash: "b".repeat(64),
  source: "http" as const,
});

describe("OwnerVault append proof", () => {
  test("binds an exact zero-based chain independently from catalog identity", () => {
    const proof = ownerVaultAppendProofValidate(scope, [entry(1), entry(2)]);
    expect(proof?.appendLogSequence).toBe(2);
    expect(proof?.appendLogDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(ownerVaultAppendProofValidate(scope, [entry(2), entry(1)])).toBeUndefined();
    expect(ownerVaultAppendProofValidate(scope, [entry(1), entry(3)])).toBeUndefined();
    expect(
      ownerVaultAppendProofValidate({ ...scope, generationEpoch: 2 }, [entry(1), entry(2)])
        ?.appendLogDigest,
    ).not.toBe(proof?.appendLogDigest);
    expect(
      ownerVaultAppendProofValidate(scope, [entry(1, "substituted"), entry(2)])?.appendLogDigest,
    ).not.toBe(proof?.appendLogDigest);
    const reordered = {
      source: "http" as const,
      payloadHash: "b".repeat(64),
      operationID: "operation-1",
      logSequence: 1,
      deviceID: "device-1",
      fingerprint: "a".repeat(64),
      payloadBase64: "opaque",
    };
    expect(ownerVaultAppendProofDn("0".repeat(64), reordered)).toBe(
      ownerVaultAppendProofDn("0".repeat(64), entry(1)),
    );
    expect(ownerVaultAppendProofDn("0".repeat(64), { ...entry(1), logSequence: 2 })).not.toBe(
      ownerVaultAppendProofDn("0".repeat(64), entry(1)),
    );
    expect(ownerVaultAppendProofDn("0".repeat(64), entry(1))).not.toBe(proof?.appendLogDigest);
  });
});
