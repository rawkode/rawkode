import { describe, expect, test } from "bun:test";
import {
  canonicalOwnerVaultBackupBytes,
  canonicalSignedManifestBytes,
  canonicalSnapshotRecordBytes,
  decodeCanonicalSignedManifest,
  decodeSnapshotRecordBytes,
  ownerVaultBackupDigest,
} from "./backup-canonical";
import type { OwnerVaultBackupManifest, OwnerVaultSignedBackupManifest } from "./backup-types";

const digest = (text: string): string => ownerVaultBackupDigest(new TextEncoder().encode(text));
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("test setup");
  return value;
};

const manifest: OwnerVaultBackupManifest = {
  version: 1,
  backupID: "backup-0000000001",
  source: { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 3 },
  highWaterMark: digest("high-water"),
  appendLogSequence: 0,
  appendLogDigest: "a".repeat(64),
  catalogDigest: digest("catalog"),
  pinProof: "p".repeat(16),
  totalBytes: 3,
  objectCount: 1,
  pages: [{ ordinal: 0, key: "pages/00000000.json", digest: digest("page"), count: 1, size: 3 }],
};
const signed: OwnerVaultSignedBackupManifest = {
  manifest,
  signature: { keyID: "backup-key", signatureDERBase64: digest("signature") },
};
const signedBytes = required(canonicalSignedManifestBytes(signed));

describe("canonical signed manifest decoding", () => {
  test("round-trips an exact canonical signed manifest", () => {
    expect(decodeCanonicalSignedManifest(signedBytes)).toEqual(signed);
  });

  test("rejects noncanonical encodings and duplicate members", () => {
    const text = decode(signedBytes);
    expect(decodeCanonicalSignedManifest(encode(` ${text}`))).toBeUndefined();
    expect(
      decodeCanonicalSignedManifest(encode(text.replace('{"manifest"', '{ "manifest"'))),
    ).toBeUndefined();
    const signatureMember = /,("signature":\{.*\})\}$/u.exec(text)?.[1];
    if (signatureMember === undefined) throw new Error("test setup");
    expect(
      decodeCanonicalSignedManifest(encode(`${text.slice(0, -1)},${signatureMember}}`)),
    ).toBeUndefined();
  });

  test("rejects unknown, missing, and mistyped members at every level", () => {
    const reject = (value: unknown): void => {
      expect(
        decodeCanonicalSignedManifest(required(canonicalOwnerVaultBackupBytes(value))),
      ).toBeUndefined();
    };
    // Unknown top-level member.
    reject({ ...signed, extra: 1 });
    // Missing signature.
    reject({ manifest });
    // Unknown member smuggled into the signed manifest body.
    reject({ ...signed, manifest: { ...manifest, extra: true } });
    // Missing manifest member.
    const { pinProof: _dropped, ...withoutPinProof } = manifest;
    reject({ ...signed, manifest: withoutPinProof });
    // Mistyped members.
    reject({ ...signed, manifest: { ...manifest, version: 2 } });
    reject({ ...signed, manifest: { ...manifest, appendLogSequence: -1 } });
    reject({ ...signed, manifest: { ...manifest, totalBytes: "3" } });
    reject({ ...signed, manifest: { ...manifest, source: { ...manifest.source, extra: 1 } } });
    reject({ ...signed, manifest: { ...manifest, pages: [{ ordinal: 0 }] } });
    reject({
      ...signed,
      manifest: {
        ...manifest,
        pages: [{ ...manifest.pages[0], extra: true }],
      },
    });
    // Unknown member inside the signature envelope must never reach verification.
    reject({ ...signed, signature: { ...signed.signature, nonce: "x" } });
    reject({ ...signed, signature: { keyID: "backup-key" } });
    reject({ ...signed, signature: { keyID: 1, signatureDERBase64: "sig" } });
  });
});

describe("canonical snapshot record decoding", () => {
  const address = { category: "device", identifier: "device-1" } as const;
  const record = { category: "device", version: 1, payload: { publicKey: "key" } } as const;
  const bytes = required(canonicalSnapshotRecordBytes(address, record));

  test("round-trips an exact canonical snapshot record", () => {
    expect(decodeSnapshotRecordBytes(bytes)).toEqual({ address, record });
  });

  test("rejects a category outside the closed storage domain", () => {
    const foreign = required(
      canonicalOwnerVaultBackupBytes({
        address: { category: "not-a-category", identifier: "device-1" },
        record: { category: "not-a-category", version: 1, payload: { publicKey: "key" } },
      }),
    );
    expect(decodeSnapshotRecordBytes(foreign)).toBeUndefined();
  });

  test("rejects mismatched, extra, noncanonical, and duplicate-member records", () => {
    const reject = (value: unknown): void => {
      expect(
        decodeSnapshotRecordBytes(required(canonicalOwnerVaultBackupBytes(value))),
      ).toBeUndefined();
    };
    reject({ address, record: { ...record, category: "session" } });
    reject({ address, record, extra: 1 });
    reject({ address: { ...address, extra: 1 }, record });
    reject({ address, record: { ...record, version: 2 } });
    const text = decode(bytes);
    expect(decodeSnapshotRecordBytes(encode(`${text} `))).toBeUndefined();
    const recordMember = /,("record":\{.*\})\}$/u.exec(text)?.[1];
    if (recordMember === undefined) throw new Error("test setup");
    expect(
      decodeSnapshotRecordBytes(encode(`${text.slice(0, -1)},${recordMember}}`)),
    ).toBeUndefined();
  });
});
