import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  makeOwnerVaultProductionAuthority,
  ownerVaultProductionLimitsMatchEnforcement,
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
    ).toBeUndefined();
    expect(
      makeOwnerVaultProductionAuthority(
        authorityInput({
          manifestPriorKeysJSON: `[{"keyID":"k1","publicKeySPKIDERBase64":"${manifestPublic}"}]`,
          manifestRevokedKeyIDsJSON: '["k0"]',
        }),
      ),
    ).toBeDefined();
    expect(
      makeOwnerVaultProductionAuthority(
        authorityInput({ manifestRevokedKeyIDsJSON: '["k0","k0"]' }),
      ),
    ).toBeUndefined();
  });

  test("rejects a limits configuration that diverges from the compiled enforcement caps before any R2 access", () => {
    const parsedDivergent = parseOwnerVaultProductionLimits(
      withMember("catalog", "maximumPageBytes", 65536),
    );
    /** The JSON itself is well-formed and cross-field consistent... */
    expect(parsedDivergent).toBeDefined();
    /** ...but it does not match what catalog.ts actually enforces. */
    if (parsedDivergent !== undefined)
      expect(ownerVaultProductionLimitsMatchEnforcement(parsedDivergent)).toBe(false);
    /**
     * A doubled root-payload cap survives the cross-field check
     * (16384 <= maximumPageBytes 32768) yet diverges from the 8 KiB the
     * catalog root decoder and storage registry actually enforce; the gate
     * must treat it as a construction failure, never a silently ignored cap.
     */
    const parsedDivergentRoot = parseOwnerVaultProductionLimits(
      withMember("catalog", "maximumRootBytes", 16384),
    );
    expect(parsedDivergentRoot).toBeDefined();
    if (parsedDivergentRoot !== undefined)
      expect(ownerVaultProductionLimitsMatchEnforcement(parsedDivergentRoot)).toBe(false);
    const production = parseOwnerVaultProductionLimits(JSON.stringify(limitsObject()));
    if (production !== undefined)
      expect(ownerVaultProductionLimitsMatchEnforcement(production)).toBe(true);
    for (const limitsJSON of [
      withMember("catalog", "maximumPageBytes", 65536),
      withMember("catalog", "maximumRootBytes", 16384),
      withMember("backup", "maximumRestoreJournalBytes", 32768),
      withMember("pins", "maximumPins", 2048),
      withMember("pins", "gcChunk", 64),
    ]) {
      const blobSpy = touchSpy();
      const backupSpy = touchSpy();
      expect(
        makeOwnerVaultProductionAuthority(
          authorityInput({ limitsJSON, blobR2: blobSpy.target, backupR2: backupSpy.target }),
        ),
      ).toBeUndefined();
      expect(blobSpy.touches).toEqual([]);
      expect(backupSpy.touches).toEqual([]);
    }
  });

  test("rejects a structurally invalid manifest ring at construction without touching R2", () => {
    const cases: readonly Partial<Parameters<typeof makeOwnerVaultProductionAuthority>[0]>[] = [
      { manifestCurrentSPKI: "bad" },
      { manifestCurrentPKCS8: "####" },
      { manifestCurrentPKCS8: btoa("too-short") },
      { manifestCurrentKeyID: "bad key!" },
      { manifestRevokedKeyIDsJSON: '["manifest-current"]' },
      {
        manifestPriorKeysJSON: `[{"keyID":"manifest-current","publicKeySPKIDERBase64":"${manifestPublic}"}]`,
      },
      {
        manifestPriorKeysJSON: `[{"keyID":"k1","publicKeySPKIDERBase64":"${manifestPublic}"},{"keyID":"k1","publicKeySPKIDERBase64":"${manifestPublic}"}]`,
      },
      {
        manifestPriorKeysJSON: JSON.stringify(
          ["k1", "k2", "k3", "k4"].map((keyID) => ({
            keyID,
            publicKeySPKIDERBase64: manifestPublic,
          })),
        ),
      },
      {
        manifestPriorKeysJSON: `[{"keyID":"k1","publicKeySPKIDERBase64":"${manifestPublic}"}]`,
        manifestRevokedKeyIDsJSON: '["k1"]',
      },
    ];
    for (const overrides of cases) {
      const blobSpy = touchSpy();
      const backupSpy = touchSpy();
      expect(
        makeOwnerVaultProductionAuthority(
          authorityInput({ ...overrides, blobR2: blobSpy.target, backupR2: backupSpy.target }),
        ),
      ).toBeUndefined();
      expect(blobSpy.touches).toEqual([]);
      expect(backupSpy.touches).toEqual([]);
    }
  });

  test("eagerly validates and caches the manifest ring during construction; first use never validates", async () => {
    const subtle = crypto.subtle;
    const names = ["importKey", "exportKey", "sign", "verify"] as const;
    let blocked = false;
    const counts: Record<(typeof names)[number], number> = {
      importKey: 0,
      exportKey: 0,
      sign: 0,
      verify: 0,
    };
    for (const name of names) {
      const original = subtle[name].bind(subtle);
      Object.defineProperty(subtle, name, {
        configurable: true,
        writable: true,
        value: (...parameters: unknown[]) => {
          if (blocked) throw new Error(`web crypto ${name} blocked after composition`);
          counts[name] += 1;
          // @ts-expect-error test spy forwards the exact native call shape
          return original(...parameters);
        },
      });
    }
    try {
      const authority = makeOwnerVaultProductionAuthority(authorityInput());
      expect(authority).toBeDefined();
      if (authority === undefined) throw new Error("test setup invalid");
      /** The pairing proof runs during construction, before any use. */
      const deadline = Date.now() + 5_000;
      while (counts.verify < 1 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(counts.verify).toBeGreaterThanOrEqual(1);
      /** One extra macrotask lets the eager fiber consume the final result. */
      await new Promise((resolve) => setTimeout(resolve, 25));
      blocked = true;
      const ring = await Effect.runPromise(authority.manifestKeys());
      expect(ring.current.keyID).toBe("manifest-current");
      const retry = await Effect.runPromise(authority.manifestKeys());
      expect(retry).toBe(ring);
      expect(JSON.stringify(authority)).not.toContain(manifestPrivate.slice(0, 24));
    } finally {
      for (const name of names) Reflect.deleteProperty(subtle, name);
    }
  });

  test("caches an eager pairing failure and never embeds the PKCS8 secret in error payloads", async () => {
    const foreign = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", foreign.publicKey));
    let binary = "";
    for (const byte of spki) binary += String.fromCharCode(byte);
    const foreignSPKI = btoa(binary);
    const authority = makeOwnerVaultProductionAuthority(
      authorityInput({ manifestCurrentSPKI: foreignSPKI }),
    );
    /** Only the Web Crypto pairing proof can detect this mismatch. */
    expect(authority).toBeDefined();
    if (authority === undefined) throw new Error("test setup invalid");
    const exit = await Effect.runPromiseExit(authority.manifestKeys());
    expect(Exit.isFailure(exit)).toBe(true);
    const serialized = JSON.stringify(exit);
    expect(serialized).toContain("key_pair_mismatch");
    expect(serialized).not.toContain(manifestPrivate.slice(0, 24));
    /** The cached exit replays; a failed ring never silently revalidates. */
    const again = await Effect.runPromiseExit(authority.manifestKeys());
    expect(Exit.isFailure(again)).toBe(true);
    expect(JSON.stringify(again)).toContain("key_pair_mismatch");
  });
});
