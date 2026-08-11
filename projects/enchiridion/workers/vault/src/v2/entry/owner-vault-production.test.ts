import { describe, expect, test } from "bun:test";
import {
  makeOwnerVaultProductionAuthority,
  parseOwnerVaultProductionLimits,
} from "./owner-vault-production";

const manifestPrivate =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnqgn2CchsOl0SE25sbl1fSF4GeFyIyhcGXfmk+nORRihRANCAARgDj/LiRqx4+xQpW1yKXYVWEGHCg+4hJxT4PbHMBrFWthHzkiAYKYvic295OBVCfvBwjOQEZVKtWmC+t+IMFbF";
const manifestPublic =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYA4/y4kasePsUKVtcil2FVhBhwoPuIScU+D2xzAaxVrYR85IgGCmL4nNveTgVQn7wcIzkBGVSrVpgvrfiDBWxQ==";

const limitsObject = () => ({
  blob: {
    maximumBlobBytes: 8388608,
    maximumVaultBytes: 100663296,
    maximumOrphanBytes: 8388608,
    maximumOrphanCount: 32,
    maximumActiveLeasesPerVault: 32,
    maximumActiveLeasesPerFinal: 32,
    stageTTLSeconds: 900,
    tombstoneGraceSeconds: 86400,
  },
  catalog: {
    maximumObjects: 4096,
    maximumObjectBytes: 8388608,
    maximumTotalBytes: 100663296,
    maximumPageEntries: 128,
    targetPageBytes: 24576,
    maximumPageBytes: 32768,
    maximumRootBytes: 8192,
  },
  backup: {
    maximumPageBytes: 524288,
    maximumPageEntries: 128,
    maximumObjectBytes: 8388608,
    maximumTotalBytes: 100663296,
    maximumManifestBytes: 1048576,
    maximumRestoreJournalBytes: 65536,
    maximumObjects: 4096,
  },
  pins: { maximumPins: 1024, gcChunk: 128, retentionSeconds: 86400 },
  r2: {
    maximumKeyBytes: 1024,
    maximumObjectBytes: 8388608,
    maximumCursorBytes: 1024,
    maximumListPageSize: 128,
  },
});

const withMember = (
  section: "blob" | "catalog" | "backup" | "pins" | "r2",
  key: string,
  value: unknown,
): string => {
  const limits = limitsObject();
  return JSON.stringify({ ...limits, [section]: { ...limits[section], [key]: value } });
};

const withoutMember = (
  section: "blob" | "catalog" | "backup" | "pins" | "r2",
  key: string,
): string => {
  const limits = limitsObject();
  const trimmed = Object.fromEntries(
    Object.entries(limits[section]).filter(([member]) => member !== key),
  );
  return JSON.stringify({ ...limits, [section]: trimmed });
};

const blobR2 = (): unknown => ({
  head: () => Promise.resolve(null),
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(null),
  delete: () => Promise.resolve(undefined),
});
const backupR2 = (): unknown => ({
  head: () => Promise.resolve(null),
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(null),
  list: () => Promise.resolve({ objects: [], truncated: false }),
  delete: () => Promise.resolve(undefined),
});

/** Records every property read so tests can prove R2 was never touched. */
const touchSpy = (): { readonly target: unknown; readonly touches: string[] } => {
  const touches: string[] = [];
  const target = new Proxy(
    {},
    {
      get: (_object, property) => {
        touches.push(String(property));
        return () => Promise.resolve(null);
      },
    },
  );
  return { target, touches };
};

const authorityInput = (
  overrides: Partial<Parameters<typeof makeOwnerVaultProductionAuthority>[0]> = {},
): Parameters<typeof makeOwnerVaultProductionAuthority>[0] => ({
  limitsJSON: JSON.stringify(limitsObject()),
  blobR2: blobR2(),
  backupR2: backupR2(),
  manifestCurrentKeyID: "manifest-current",
  manifestCurrentPKCS8: manifestPrivate,
  manifestCurrentSPKI: manifestPublic,
  manifestPriorKeysJSON: "[]",
  manifestRevokedKeyIDsJSON: "[]",
  ...overrides,
});

describe("OwnerVault production authority", () => {
  test("fails on missing or invalid environment before any storage or R2 access", () => {
    expect(parseOwnerVaultProductionLimits("{")).toBeUndefined();
    expect(parseOwnerVaultProductionLimits("[]")).toBeUndefined();
    expect(parseOwnerVaultProductionLimits("42")).toBeUndefined();
    expect(parseOwnerVaultProductionLimits("null")).toBeUndefined();
    expect(parseOwnerVaultProductionLimits("{}")).toBeUndefined();
    const { r2, ...withoutR2 } = limitsObject();
    expect(r2.maximumKeyBytes).toBe(1024);
    expect(parseOwnerVaultProductionLimits(JSON.stringify(withoutR2))).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(JSON.stringify({ ...limitsObject(), extra: {} })),
    ).toBeUndefined();
    const blobSpy = touchSpy();
    const backupSpy = touchSpy();
    expect(
      makeOwnerVaultProductionAuthority(
        authorityInput({ limitsJSON: "{", blobR2: blobSpy.target, backupR2: backupSpy.target }),
      ),
    ).toBeUndefined();
    expect(
      makeOwnerVaultProductionAuthority(
        authorityInput({
          manifestPriorKeysJSON: "not json",
          blobR2: blobSpy.target,
          backupR2: backupSpy.target,
        }),
      ),
    ).toBeUndefined();
    expect(blobSpy.touches).toEqual([]);
    expect(backupSpy.touches).toEqual([]);
  });

  test("accepts the exact production cap set and freezes every limit tuple", () => {
    const limits = parseOwnerVaultProductionLimits(JSON.stringify(limitsObject()));
    expect(limits).toBeDefined();
    expect(Object.isFrozen(limits)).toBe(true);
    expect(Object.isFrozen(limits?.blob)).toBe(true);
    expect(Object.isFrozen(limits?.r2)).toBe(true);
    expect(limits?.catalog.maximumObjects).toBe(4096);
    expect(limits?.blob.tombstoneGraceSeconds).toBe(86400);
  });

  test("enforces cross-field invariants across sub-objects", () => {
    expect(
      parseOwnerVaultProductionLimits(withMember("catalog", "maximumObjects", 4095)),
    ).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withMember("blob", "maximumActiveLeasesPerFinal", 33)),
    ).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withMember("pins", "retentionSeconds", 899)),
    ).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withMember("catalog", "targetPageBytes", 32769)),
    ).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withMember("blob", "maximumBlobBytes", 8388609)),
    ).toBeUndefined();
  });

  test("rejects malformed, missing, extra, and non-integer members in every sub-object", () => {
    expect(
      parseOwnerVaultProductionLimits(withoutMember("blob", "stageTTLSeconds")),
    ).toBeUndefined();
    expect(parseOwnerVaultProductionLimits(withMember("blob", "extra", 1))).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withMember("blob", "stageTTLSeconds", 0)),
    ).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withMember("blob", "maximumOrphanBytes", -1)),
    ).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withoutMember("catalog", "maximumRootBytes")),
    ).toBeUndefined();
    expect(parseOwnerVaultProductionLimits(withMember("catalog", "extra", 1))).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withMember("catalog", "maximumObjects", 1.5)),
    ).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withoutMember("backup", "maximumManifestBytes")),
    ).toBeUndefined();
    expect(parseOwnerVaultProductionLimits(withMember("backup", "extra", 1))).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withMember("backup", "maximumObjects", "4096")),
    ).toBeUndefined();
    expect(parseOwnerVaultProductionLimits(withoutMember("pins", "gcChunk"))).toBeUndefined();
    expect(parseOwnerVaultProductionLimits(withMember("pins", "extra", 1))).toBeUndefined();
    expect(parseOwnerVaultProductionLimits(withMember("pins", "gcChunk", 0))).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withoutMember("r2", "maximumListPageSize")),
    ).toBeUndefined();
    expect(parseOwnerVaultProductionLimits(withMember("r2", "extra", 1))).toBeUndefined();
    expect(
      parseOwnerVaultProductionLimits(withMember("r2", "maximumListPageSize", null)),
    ).toBeUndefined();
  });

  test("constructs the authority only from distinct structural R2 bindings", () => {
    const authority = makeOwnerVaultProductionAuthority(authorityInput());
    expect(authority).toBeDefined();
    expect(authority?.blobR2.purpose).toBe("owner-vault-blob-r2");
    expect(authority?.backupR2.purpose).toBe("owner-vault-backup-r2");
    expect(Object.isFrozen(authority?.limits)).toBe(true);
    const shared = backupR2();
    expect(
      makeOwnerVaultProductionAuthority(authorityInput({ blobR2: shared, backupR2: shared })),
    ).toBeUndefined();
    expect(makeOwnerVaultProductionAuthority(authorityInput({ blobR2: {} }))).toBeUndefined();
    expect(
      makeOwnerVaultProductionAuthority(authorityInput({ backupR2: blobR2() })),
    ).toBeUndefined();
  });

  test("validates manifest prior and revoked key JSON member by member", () => {
    expect(
      makeOwnerVaultProductionAuthority(
        authorityInput({ manifestPriorKeysJSON: '[{"keyID":"k1"}]' }),
      ),
    ).toBeUndefined();
    expect(
      makeOwnerVaultProductionAuthority(
        authorityInput({
          manifestPriorKeysJSON: '[{"keyID":"k1","publicKeySPKIDERBase64":"x","extra":1}]',
        }),
      ),
    ).toBeUndefined();
    expect(
      makeOwnerVaultProductionAuthority(
        authorityInput({ manifestPriorKeysJSON: '[{"keyID":1,"publicKeySPKIDERBase64":"x"}]' }),
      ),
    ).toBeUndefined();
    expect(
      makeOwnerVaultProductionAuthority(
        authorityInput({ manifestPriorKeysJSON: '{"keyID":"k1"}' }),
      ),
    ).toBeUndefined();
    expect(
      makeOwnerVaultProductionAuthority(authorityInput({ manifestRevokedKeyIDsJSON: "[1]" })),
    ).toBeUndefined();
    expect(
      makeOwnerVaultProductionAuthority(authorityInput({ manifestRevokedKeyIDsJSON: '"x"' })),
    ).toBeUndefined();
    expect(
      makeOwnerVaultProductionAuthority(
        authorityInput({
          manifestPriorKeysJSON: '[{"keyID":"k1","publicKeySPKIDERBase64":"x"}]',
          manifestRevokedKeyIDsJSON: '["k0"]',
        }),
      ),
    ).toBeDefined();
  });
});
