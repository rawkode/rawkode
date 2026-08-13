import { describe, expect, test } from "bun:test";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import {
  type OwnerVaultProductionAuthority,
  makeOwnerVaultProductionAuthority,
} from "../entry/owner-vault-production";
import { makeOwnerVaultProviderGraph } from "./provider-graph";
import { makeDurableObjectOwnerVaultStorageRepository } from "./repository";
import type { OwnerVaultTargetRoot } from "./storage-registry";

const manifestPrivate =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnqgn2CchsOl0SE25sbl1fSF4GeFyIyhcGXfmk+nORRihRANCAARgDj/LiRqx4+xQpW1yKXYVWEGHCg+4hJxT4PbHMBrFWthHzkiAYKYvic295OBVCfvBwjOQEZVKtWmC+t+IMFbF";
const manifestPublic =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYA4/y4kasePsUKVtcil2FVhBhwoPuIScU+D2xzAaxVrYR85IgGCmL4nNveTgVQn7wcIzkBGVSrVpgvrfiDBWxQ==";

const limitsJSON = JSON.stringify({
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

/** Records only method invocations: shape probes at construction stay legal. */
const r2Spy = (withList: boolean): { readonly target: unknown; readonly calls: string[] } => {
  const calls: string[] = [];
  const method =
    (name: string) =>
    (..._parameters: unknown[]) => {
      calls.push(name);
      return name === "list"
        ? Promise.resolve({ objects: [], truncated: false })
        : Promise.resolve(null);
    };
  const target: Record<string, unknown> = {
    head: method("head"),
    get: method("get"),
    put: method("put"),
    delete: method("delete"),
    ...(withList ? { list: method("list") } : {}),
  };
  return { target, calls };
};

const nativeState = (): {
  readonly state: DurableObjectStateNative;
  readonly entries: Map<string, unknown>;
  readonly transactions: () => number;
} => {
  const entries = new Map<string, unknown>();
  let transactions = 0;
  const transaction: DurableObjectTransactionNative = {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(entries.delete(key)),
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
  };
  const storage = {
    ...transaction,
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
    transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
      transactions += 1;
      const before = new Map(entries);
      return work(transaction).catch((error: unknown) => {
        entries.clear();
        for (const [key, value] of before) entries.set(key, value);
        return Promise.reject(error);
      });
    },
    list: (options: {
      readonly prefix: string;
      readonly startAfter?: string;
      readonly limit: number;
    }): Promise<ReadonlyMap<string, unknown>> => {
      const selected = [...entries.entries()]
        .filter(
          ([key]) =>
            key.startsWith(options.prefix) &&
            (options.startAfter === undefined || key > options.startAfter),
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, options.limit);
      return Promise.resolve(new Map(selected));
    },
  } satisfies DurableObjectStorageNative & {
    readonly list: (options: {
      readonly prefix: string;
      readonly startAfter?: string;
      readonly limit: number;
    }) => Promise<ReadonlyMap<string, unknown>>;
  };
  return {
    entries,
    transactions: () => transactions,
    state: { storage, blockConcurrencyWhile: (work) => work() },
  };
};

const harness = (
  overrides: Partial<Parameters<typeof makeOwnerVaultProductionAuthority>[0]> = {},
) => {
  const blob = r2Spy(false);
  const backup = r2Spy(true);
  const native = nativeState();
  const repository = makeDurableObjectOwnerVaultStorageRepository(
    makeDurableObjectBoundary(native.state).storage,
    native.state.storage,
  );
  const production = makeOwnerVaultProductionAuthority({
    limitsJSON,
    blobR2: blob.target,
    backupR2: backup.target,
    manifestCurrentKeyID: "manifest-current",
    manifestCurrentPKCS8: manifestPrivate,
    manifestCurrentSPKI: manifestPublic,
    manifestPriorKeysJSON: "[]",
    manifestRevokedKeyIDsJSON: "[]",
    ...overrides,
  });
  return { blob, backup, native, repository, production };
};

const root: OwnerVaultTargetRoot = {
  ownerID: "owner-1",
  vaultID: "vault-1",
  generationEpoch: 1,
  namespaceState: "PRIVATE",
};

describe("v2 OwnerVault provider graph", () => {
  test("constructs every provider from the single production authority without storage or R2 work", () => {
    const { blob, backup, native, repository, production } = harness();
    expect(production).toBeDefined();
    if (production === undefined) throw new Error("test setup invalid");
    const graph = makeOwnerVaultProviderGraph(repository, root, production);
    expect(graph).toBeDefined();
    expect(Object.isFrozen(graph)).toBe(true);
    expect(graph?.domains).toBeDefined();
    expect(graph?.blobs).toBeDefined();
    expect(graph?.snapshots).toBeDefined();
    /** Composition is pure wiring: no durable transaction and no R2 call. */
    expect(native.transactions()).toBe(0);
    expect(blob.calls).toEqual([]);
    expect(backup.calls).toEqual([]);
  });

  test("rejects a malformed target root before granting any provider", () => {
    const { repository, production, native, blob, backup } = harness();
    if (production === undefined) throw new Error("test setup invalid");
    expect(
      makeOwnerVaultProviderGraph(repository, { ...root, ownerID: "" }, production),
    ).toBeUndefined();
    expect(
      makeOwnerVaultProviderGraph(repository, { ...root, generationEpoch: 0 }, production),
    ).toBeUndefined();
    expect(
      makeOwnerVaultProviderGraph(repository, { ...root, generationEpoch: 1.5 }, production),
    ).toBeUndefined();
    expect(native.transactions()).toBe(0);
    expect(blob.calls).toEqual([]);
    expect(backup.calls).toEqual([]);
  });

  test("construction-checks a forged authority whose limits diverge from compiled enforcement", () => {
    const { repository, production, native, blob, backup } = harness();
    if (production === undefined) throw new Error("test setup invalid");
    const forgeries: readonly OwnerVaultProductionAuthority[] = [
      {
        ...production,
        limits: {
          ...production.limits,
          pins: { ...production.limits.pins, maximumPins: 64 },
        },
      },
      {
        ...production,
        limits: {
          ...production.limits,
          catalog: { ...production.limits.catalog, maximumObjects: 8192 },
        },
      },
      {
        ...production,
        limits: {
          ...production.limits,
          backup: { ...production.limits.backup, maximumManifestBytes: 2097152 },
        },
      },
    ];
    for (const forged of forgeries) {
      expect(makeOwnerVaultProviderGraph(repository, root, forged)).toBeUndefined();
    }
    /** The divergent authority performed no storage or R2 operation. */
    expect(native.transactions()).toBe(0);
    expect(blob.calls).toEqual([]);
    expect(backup.calls).toEqual([]);
  });

  test("backup runtime consumes the eagerly cached ring and signs/verifies canonical bytes", async () => {
    const { repository, production, blob, backup } = harness();
    if (production === undefined) throw new Error("test setup invalid");
    const graph = makeOwnerVaultProviderGraph(repository, root, production);
    if (graph === undefined) throw new Error("test setup invalid");
    const runtime = await Effect.runPromise(graph.backupRuntime());
    expect(runtime.signer).toBeDefined();
    expect(runtime.verifier).toBeDefined();
    const canonical = new TextEncoder().encode('{"manifest":"canonical"}');
    const signature = await Effect.runPromise(runtime.signer.signCanonical(canonical));
    expect(signature.keyID).toBe("manifest-current");
    await Effect.runPromise(runtime.verifier.verifyCanonical(canonical, signature));
    /** The archive boundary is the BACKUP_R2 capability, never BLOB_R2. */
    await Effect.runPromise(runtime.r2.head("v2/owner-vault/backups/owner-1/probe"));
    expect(backup.calls).toContain("head");
    expect(blob.calls).toEqual([]);
  });

  test("maps a cached manifest ring failure to a closed backup error without leaking the PKCS8 secret", async () => {
    const foreign = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", foreign.publicKey));
    let binary = "";
    for (const byte of spki) binary += String.fromCharCode(byte);
    const { repository, production, backup } = harness({
      manifestCurrentSPKI: btoa(binary),
    });
    if (production === undefined) throw new Error("test setup invalid");
    const graph = makeOwnerVaultProviderGraph(repository, root, production);
    if (graph === undefined) throw new Error("test setup invalid");
    const exit = await Effect.runPromiseExit(graph.backupRuntime());
    expect(Exit.isFailure(exit)).toBe(true);
    const serialized = JSON.stringify(exit);
    expect(serialized).toContain("source_unavailable");
    expect(serialized).not.toContain(manifestPrivate.slice(0, 24));
    /** A failed ring grants no archive boundary: BACKUP_R2 stays untouched. */
    expect(backup.calls).toEqual([]);
  });
});
